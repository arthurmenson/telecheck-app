-- Billing's credentials are isolated from the ordinary application and binder.
-- Deployment grants LOGIN/password only to billing_service_role. Price policy is
-- immutable; mutable intent fields describe provider observations, never prices.
SET LOCAL search_path = pg_catalog, public, pg_temp;
CREATE ROLE billing_service_role NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE billing_context_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE billing_consult_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT USAGE ON SCHEMA public TO billing_service_role, billing_context_owner, billing_consult_owner;
GRANT EXECUTE ON FUNCTION public.set_tenant_context(TEXT), public.clear_tenant_context(), public.current_tenant_id()
  TO billing_service_role, billing_context_owner, billing_consult_owner;
GRANT SELECT (id, country_of_care, status) ON public.tenants TO billing_service_role;
GRANT SELECT ON public.country_profiles, public.ccr_configs TO billing_service_role;
GRANT SELECT, INSERT ON public.audit_records, public.domain_events_outbox TO billing_service_role;
GRANT SELECT (nonce, actor_account_id, actor_account_tenant_id, actor_role, session_id, expires_at)
  ON public._session_actor_context TO billing_context_owner;
GRANT SELECT (account_id, tenant_id, account_type, status, deleted_at) ON public.accounts TO billing_context_owner;
GRANT SELECT (session_id, account_id, tenant_id, expires_at, revoked_at) ON public.sessions TO billing_context_owner;
GRANT SELECT (id, country_of_care, status) ON public.tenants TO billing_context_owner;

CREATE FUNCTION public.billing_current_actor()
RETURNS TABLE (tenant_id TEXT, account_id TEXT, actor_role TEXT, country_of_care TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'billing_fresh_authorization_required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT n.actor_account_tenant_id::TEXT, n.actor_account_id::TEXT, n.actor_role::TEXT, t.country_of_care::TEXT
    FROM public._session_actor_context n
    JOIN public.accounts a ON (a.tenant_id, a.account_id) = (n.actor_account_tenant_id, n.actor_account_id)
    JOIN public.sessions s ON (s.tenant_id, s.account_id, s.session_id) = (n.actor_account_tenant_id, n.actor_account_id, n.session_id)
    JOIN public.tenants t ON t.id = n.actor_account_tenant_id
    WHERE n.nonce = NULLIF(current_setting('app.request_nonce', true), '')::UUID
      AND n.actor_account_tenant_id = public.current_tenant_id()
      AND n.expires_at > clock_timestamp() AND s.expires_at > clock_timestamp()
      AND s.revoked_at IS NULL AND a.status = 'active' AND a.deleted_at IS NULL
      AND t.status = 'active' AND n.actor_role = a.account_type
      AND n.actor_role IN ('patient', 'tenant_admin');
  IF NOT FOUND THEN RAISE EXCEPTION 'billing_actor_unavailable' USING ERRCODE = '42501'; END IF;
END $$;
ALTER FUNCTION public.billing_current_actor() OWNER TO billing_context_owner;
REVOKE ALL ON FUNCTION public.billing_current_actor() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_current_actor() TO billing_service_role, billing_consult_owner;

CREATE TABLE public.billing_consult_price (
  id VARCHAR(26) PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES public.tenants(id),
  country_of_care TEXT NOT NULL,
  consult_type TEXT NOT NULL CHECK (consult_type IN ('general', 'program_pathway')),
  program_id TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  amount_minor INTEGER NOT NULL CHECK (amount_minor BETWEEN 1 AND 99999999),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'paystack', 'mock_local_dev')),
  provider_account TEXT NOT NULL CHECK (length(provider_account) BETWEEN 1 AND 128),
  provider_mode TEXT NOT NULL CHECK (provider_mode IN ('sandbox', 'live', 'mock_local_dev')),
  turnaround_minutes INTEGER NOT NULL CHECK (turnaround_minutes BETWEEN 1 AND 10080),
  quote_ttl_seconds INTEGER NOT NULL CHECK (quote_ttl_seconds BETWEEN 60 AND 900),
  refund_policy TEXT NOT NULL CHECK (refund_policy = 'full_before_review_or_decline_v1'),
  published_by VARCHAR(26) NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((consult_type = 'general' AND program_id IS NULL) OR (consult_type = 'program_pathway' AND length(program_id) BETWEEN 1 AND 128)),
  CHECK ((provider = 'mock_local_dev') = (provider_mode = 'mock_local_dev')),
  FOREIGN KEY (tenant_id, published_by) REFERENCES public.accounts(tenant_id, account_id),
  UNIQUE (tenant_id, id),
  UNIQUE NULLS NOT DISTINCT (tenant_id, consult_type, program_id, version)
);
CREATE TABLE public.billing_consult_quote (
  id VARCHAR(26) PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES public.tenants(id),
  patient_id VARCHAR(26) NOT NULL,
  price_id VARCHAR(26) NOT NULL,
  operation_key TEXT NOT NULL CHECK (operation_key ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (tenant_id, patient_id) REFERENCES public.accounts(tenant_id, account_id),
  FOREIGN KEY (tenant_id, price_id) REFERENCES public.billing_consult_price(tenant_id, id),
  UNIQUE (tenant_id, id, patient_id),
  UNIQUE (tenant_id, patient_id, operation_key),
  UNIQUE (tenant_id, id, patient_id, price_id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes')
);
CREATE TABLE public.billing_payment_intent (
  id VARCHAR(26) PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES public.tenants(id),
  patient_id VARCHAR(26) NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose = 'async_consult'),
  quote_id VARCHAR(26) NOT NULL,
  price_id VARCHAR(26) NOT NULL,
  operation_key TEXT NOT NULL CHECK (operation_key ~ '^[a-f0-9]{64}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  initiation_source TEXT NOT NULL CHECK (initiation_source IN ('program_enrollment', 'care_tab', 'mode_1_handoff', 'medication_detail', 'rpm_ccm_dashboard')),
  provider_reference TEXT NOT NULL,
  provider_object_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('creating', 'creation_unknown', 'requires_payment', 'paid', 'failed', 'cancelled', 'refund_pending', 'refunded')),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  confirmation_ciphertext BYTEA,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  provider_created_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  last_failure_code TEXT CHECK (last_failure_code IN ('provider_unavailable', 'provider_rejected', 'creation_unknown', 'confirmation_unavailable')),
  FOREIGN KEY (tenant_id, quote_id, patient_id) REFERENCES public.billing_consult_quote(tenant_id, id, patient_id),
  FOREIGN KEY (tenant_id, quote_id, patient_id, price_id) REFERENCES public.billing_consult_quote(tenant_id, id, patient_id, price_id),
  FOREIGN KEY (tenant_id, price_id) REFERENCES public.billing_consult_price(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, patient_id, id, purpose),
  UNIQUE (tenant_id, patient_id, operation_key),
  UNIQUE (tenant_id, quote_id),
  UNIQUE (provider_reference),
  CHECK ((status NOT IN ('paid', 'refund_pending', 'refunded')) OR verified_at IS NOT NULL)
);
CREATE TABLE public.billing_provider_event (
  tenant_id TEXT NOT NULL REFERENCES public.tenants(id),
  provider_account TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'paystack', 'mock_local_dev')),
  event_id TEXT NOT NULL CHECK (length(event_id) BETWEEN 1 AND 256),
  intent_id VARCHAR(26) NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('paid', 'failed', 'cancelled', 'refunded')),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, intent_id) REFERENCES public.billing_payment_intent(tenant_id, id),
  PRIMARY KEY (tenant_id, provider, provider_account, event_id)
);
CREATE TABLE public.billing_refund_intent (
  id VARCHAR(26) PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES public.tenants(id),
  payment_intent_id VARCHAR(26) NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('pre_review_cancellation', 'clinician_declined', 'orphaned_payment')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'creation_unknown', 'submitted', 'confirmed', 'failed')),
  provider_refund_id TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  confirmed_at TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, payment_intent_id) REFERENCES public.billing_payment_intent(tenant_id, id),
  UNIQUE (tenant_id, payment_intent_id),
  CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL))
);
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['billing_consult_price', 'billing_consult_quote', 'billing_payment_intent', 'billing_provider_event', 'billing_refund_intent'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON public.%I USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, telecheck_app_role, bind_actor_context_role', t);
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO billing_service_role', t);
  END LOOP;
END $$;
GRANT UPDATE (provider_object_id, status, lease_token, lease_expires_at, confirmation_ciphertext, provider_created_at, verified_at, last_failure_code)
  ON public.billing_payment_intent TO billing_service_role;
GRANT UPDATE (status, provider_refund_id, confirmed_at) ON public.billing_refund_intent TO billing_service_role;
CREATE FUNCTION public.billing_immutable() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RAISE EXCEPTION 'billing_immutable_record' USING ERRCODE = '42501'; END $$;
CREATE TRIGGER billing_price_immutable BEFORE UPDATE OR DELETE ON public.billing_consult_price FOR EACH ROW EXECUTE FUNCTION public.billing_immutable();
CREATE TRIGGER billing_quote_immutable BEFORE UPDATE OR DELETE ON public.billing_consult_quote FOR EACH ROW EXECUTE FUNCTION public.billing_immutable();
CREATE TRIGGER billing_event_immutable BEFORE UPDATE OR DELETE ON public.billing_provider_event FOR EACH ROW EXECUTE FUNCTION public.billing_immutable();
CREATE TRIGGER billing_intent_no_delete BEFORE DELETE ON public.billing_payment_intent FOR EACH ROW EXECUTE FUNCTION public.billing_immutable();
CREATE TRIGGER billing_refund_no_delete BEFORE DELETE ON public.billing_refund_intent FOR EACH ROW EXECUTE FUNCTION public.billing_immutable();

CREATE FUNCTION public.billing_intent_identity_immutable() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN
  IF (to_jsonb(NEW) - ARRAY['provider_object_id','status','lease_token','lease_expires_at','confirmation_ciphertext','provider_created_at','verified_at','last_failure_code'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['provider_object_id','status','lease_token','lease_expires_at','confirmation_ciphertext','provider_created_at','verified_at','last_failure_code'])
     OR (OLD.verified_at IS NOT NULL AND NEW.verified_at IS DISTINCT FROM OLD.verified_at)
     OR (OLD.provider_object_id IS NOT NULL AND NEW.provider_object_id IS DISTINCT FROM OLD.provider_object_id)
     OR (OLD.provider_created_at IS NOT NULL AND NEW.provider_created_at IS DISTINCT FROM OLD.provider_created_at)
  THEN RAISE EXCEPTION 'billing_intent_identity_immutable' USING ERRCODE = '42501'; END IF;
  IF OLD.status IN ('paid', 'refund_pending', 'refunded') AND NEW.status NOT IN ('paid', 'refund_pending', 'refunded')
     OR OLD.status = 'refunded' AND NEW.status <> 'refunded'
  THEN RAISE EXCEPTION 'billing_payment_status_regression' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_intent_identity_immutable BEFORE UPDATE ON public.billing_payment_intent FOR EACH ROW EXECUTE FUNCTION public.billing_intent_identity_immutable();
