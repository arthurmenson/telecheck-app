-- Versioned care consent foundation. Patient and operator operations are added
-- below in this unreleased package before deployment; no ordinary raw DML.
SET LOCAL search_path = pg_catalog, public, pg_temp;

CREATE ROLE consent_care_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE consent_care_patient NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE consent_care_operator NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT USAGE ON SCHEMA public TO consent_care_owner, consent_care_patient, consent_care_operator;
GRANT consent_care_patient, consent_care_operator TO telecheck_app_role;
GRANT EXECUTE ON FUNCTION public.current_tenant_id(), public.kms_current_actor_context() TO consent_care_owner;
GRANT SELECT (account_id,tenant_id,country_of_care) ON public.accounts TO consent_care_owner;
GRANT SELECT, INSERT ON public.consent, public.consent_versions TO consent_care_owner;
GRANT SELECT (tenant_id,config_key,config_value) ON public.ccr_configs TO consent_care_owner;
GRANT UPDATE (config_value) ON public.ccr_configs TO consent_care_owner;
GRANT SELECT (country,default_locale) ON public.country_profiles TO consent_care_owner;

CREATE TABLE public.consent_care_membership (
  tenant_id TEXT NOT NULL REFERENCES public.tenants(id),
  account_id VARCHAR(26) NOT NULL,
  capability TEXT NOT NULL CHECK (capability IN ('policy_author','policy_reviewer')),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id,account_id,capability),
  FOREIGN KEY (tenant_id,account_id) REFERENCES public.accounts(tenant_id,account_id)
);

CREATE TABLE public.consent_care_policy (
  policy_id VARCHAR(26) PRIMARY KEY CHECK (policy_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  tenant_id TEXT NOT NULL REFERENCES public.tenants(id),
  country_of_care TEXT NOT NULL CHECK (country_of_care ~ '^[A-Z]{2}$'),
  locale TEXT NOT NULL,
  program_id VARCHAR(26) CHECK (program_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  content JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object' AND octet_length(content::TEXT) <= 70000),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  development_only BOOLEAN NOT NULL,
  author_id VARCHAR(26) NOT NULL,
  reviewer_id VARCHAR(26),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','superseded','withdrawn')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  published_at TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ,
  UNIQUE (tenant_id,policy_id),
  FOREIGN KEY (tenant_id,author_id) REFERENCES public.accounts(tenant_id,account_id),
  FOREIGN KEY (tenant_id,reviewer_id) REFERENCES public.accounts(tenant_id,account_id),
  CHECK (reviewer_id IS NULL OR reviewer_id <> author_id),
  CHECK ((status = 'draft') = (published_at IS NULL)),
  CHECK ((status = 'draft') = (reviewer_id IS NULL)),
  CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL))
);
CREATE UNIQUE INDEX consent_care_one_active_policy ON public.consent_care_policy
  (tenant_id,country_of_care,locale,COALESCE(program_id,'')) WHERE status = 'published';

-- Mapping retains the exact reviewed terms and canonical consent version. A
-- historical version without this mapping is not automatically approved.
CREATE TABLE public.consent_care_policy_term (
  tenant_id TEXT NOT NULL,
  policy_id VARCHAR(26) NOT NULL,
  term_key TEXT NOT NULL CHECK (term_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  consent_version_id VARCHAR(26) NOT NULL,
  consent_type TEXT NOT NULL CHECK (consent_type IN ('platform','care','jurisdictional','data_use')),
  scope_id VARCHAR(64),
  term_hash TEXT NOT NULL CHECK (term_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,policy_id,term_key),
  FOREIGN KEY (tenant_id,policy_id) REFERENCES public.consent_care_policy(tenant_id,policy_id),
  FOREIGN KEY (tenant_id,consent_version_id) REFERENCES public.consent_versions(tenant_id,consent_version_id)
);

-- A receipt records every deliberate choice, including an initial refusal for
-- which no prior grant exists to revoke. Canonical grants/revocations themselves
-- remain append-only rows in public.consent.
CREATE TABLE public.consent_care_decision (
  sequence_number BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  decision_id VARCHAR(26) NOT NULL UNIQUE CHECK (decision_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  tenant_id TEXT NOT NULL,
  account_id VARCHAR(26) NOT NULL,
  policy_id VARCHAR(26) NOT NULL,
  term_key TEXT NOT NULL,
  accepted BOOLEAN NOT NULL,
  consent_id VARCHAR(26),
  session_id VARCHAR(26) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,account_id) REFERENCES public.accounts(tenant_id,account_id),
  FOREIGN KEY (tenant_id,policy_id,term_key) REFERENCES public.consent_care_policy_term(tenant_id,policy_id,term_key),
  FOREIGN KEY (tenant_id,consent_id) REFERENCES public.consent(tenant_id,consent_id),
  CHECK (NOT accepted OR consent_id IS NOT NULL)
);
CREATE INDEX consent_care_decision_subject ON public.consent_care_decision(tenant_id,account_id,sequence_number DESC);

DO $$ DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['consent_care_membership','consent_care_policy','consent_care_policy_term','consent_care_decision'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON public.%I USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())',table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, telecheck_app_role, consent_care_patient, consent_care_operator',table_name);
  END LOOP;
END $$;
GRANT SELECT ON public.consent_care_membership TO consent_care_owner;
GRANT SELECT, INSERT, UPDATE ON public.consent_care_policy TO consent_care_owner;
GRANT SELECT, INSERT ON public.consent_care_policy_term, public.consent_care_decision TO consent_care_owner;
GRANT USAGE ON SEQUENCE public.consent_care_decision_sequence_number_seq TO consent_care_owner;

CREATE FUNCTION public.consent_care_live_actor(p_capability TEXT DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a RECORD;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'consent_authorization_unavailable' USING ERRCODE='PT503';
  END IF;
  BEGIN SELECT * INTO STRICT a FROM public.kms_current_actor_context();
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'consent_unauthenticated' USING ERRCODE='PT401'; END;
  IF NOT EXISTS (SELECT 1 FROM public.accounts p WHERE p.tenant_id=a.tenant_id AND p.account_id=a.account_id AND p.country_of_care=a.country_of_care) THEN
    RAISE EXCEPTION 'consent_unauthenticated' USING ERRCODE='PT401';
  END IF;
  IF p_capability IS NULL THEN
    IF a.actor_role <> 'patient' THEN RAISE EXCEPTION 'consent_scope_unavailable' USING ERRCODE='42501'; END IF;
  ELSE
    IF p_capability NOT IN ('policy_author','policy_reviewer') OR a.actor_role <> 'tenant_admin' OR NOT EXISTS (
      SELECT 1 FROM public.consent_care_membership m WHERE m.tenant_id=a.tenant_id AND m.account_id=a.account_id AND m.capability=p_capability AND m.revoked_at IS NULL
    ) THEN RAISE EXCEPTION 'consent_scope_unavailable' USING ERRCODE='42501'; END IF;
  END IF;
  RETURN jsonb_build_object('tenant_id',a.tenant_id,'account_id',a.account_id,'session_id',a.session_id,'country_of_care',a.country_of_care,'actor_role',a.actor_role);
END $$;
ALTER FUNCTION public.consent_care_live_actor(TEXT) OWNER TO consent_care_owner;
REVOKE ALL ON FUNCTION public.consent_care_live_actor(TEXT) FROM PUBLIC;

CREATE FUNCTION public.consent_care_policy_immutable() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['status','reviewer_id','published_at','withdrawn_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['status','reviewer_id','published_at','withdrawn_at'])
    OR NOT ((OLD.status='draft' AND NEW.status='published') OR
            (OLD.status='published' AND NEW.status IN ('superseded','withdrawn')) OR
            (OLD.status='superseded' AND NEW.status='withdrawn'))
    OR (OLD.status <> 'draft' AND (NEW.reviewer_id IS DISTINCT FROM OLD.reviewer_id OR NEW.published_at IS DISTINCT FROM OLD.published_at))
  THEN RAISE EXCEPTION 'consent_policy_immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.consent_care_policy_immutable() FROM PUBLIC;
CREATE TRIGGER consent_care_policy_immutable BEFORE UPDATE ON public.consent_care_policy
  FOR EACH ROW EXECUTE FUNCTION public.consent_care_policy_immutable();

CREATE FUNCTION public.consent_care_canonical_json(v JSONB) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE result TEXT;
BEGIN
  IF jsonb_typeof(v) = 'object' THEN
    SELECT '{' || COALESCE(string_agg(to_jsonb(e.key)::TEXT || ':' || public.consent_care_canonical_json(e.value),',' ORDER BY e.key COLLATE "C"),'') || '}'
      INTO result FROM jsonb_each(v) e;
    RETURN result;
  ELSIF jsonb_typeof(v) = 'array' THEN
    SELECT '[' || COALESCE(string_agg(public.consent_care_canonical_json(e.value),',' ORDER BY e.ordinality),'') || ']'
      INTO result FROM jsonb_array_elements(v) WITH ORDINALITY e;
    RETURN result;
  END IF;
  RETURN v::TEXT;
END $$;
ALTER FUNCTION public.consent_care_canonical_json(JSONB) OWNER TO consent_care_owner;
REVOKE ALL ON FUNCTION public.consent_care_canonical_json(JSONB) FROM PUBLIC;

CREATE FUNCTION public.consent_care_check_keys(v JSONB, keys TEXT[]) RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT (v ?& keys) OR EXISTS (
    SELECT 1 FROM jsonb_object_keys(v) k WHERE NOT (k = ANY(keys))
  ) THEN RAISE EXCEPTION 'consent_contract_invalid' USING ERRCODE='22023'; END IF;
END $$;
ALTER FUNCTION public.consent_care_check_keys(JSONB,TEXT[]) OWNER TO consent_care_owner;
REVOKE ALL ON FUNCTION public.consent_care_check_keys(JSONB,TEXT[]) FROM PUBLIC;

CREATE FUNCTION public.consent_care_safe_text(v JSONB, bound INTEGER) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT COALESCE(jsonb_typeof(v)='string' AND length(v#>>'{}')>=1
    AND (SELECT COALESCE(sum(CASE WHEN ascii(NULLIF(c,''))>65535 THEN 2 ELSE 1 END),0)
      FROM regexp_split_to_table(v#>>'{}','') c)<=bound
    AND regexp_replace(v#>>'{}','[[:space:]\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]','','g')<>''
    AND (v#>>'{}') !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]',FALSE)
$$;
ALTER FUNCTION public.consent_care_safe_text(JSONB,INTEGER) OWNER TO consent_care_owner;
REVOKE ALL ON FUNCTION public.consent_care_safe_text(JSONB,INTEGER) FROM PUBLIC;

CREATE FUNCTION public.consent_care_validate_policy(v JSONB) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE term JSONB; section JSONB; base_keys TEXT[]; term_keys TEXT[] := ARRAY[]::TEXT[];
  scopes TEXT[] := ARRAY[]::TEXT[]; scope TEXT; platform_count INTEGER := 0; care_count INTEGER := 0;
  jurisdictional_count INTEGER := 0; canonical TEXT;
BEGIN
  PERFORM public.consent_care_check_keys(v,ARRAY['contract_version','country_of_care','locale','program_id','development_only','jurisdictional_review','terms']);
  canonical := public.consent_care_canonical_json(v);
  IF octet_length(canonical)>65536 OR v->>'contract_version' IS DISTINCT FROM 'care_consent_v1'
    OR jsonb_typeof(v->'country_of_care') IS DISTINCT FROM 'string' OR v->>'country_of_care' !~ '^[A-Z]{2}$'
    OR jsonb_typeof(v->'locale') IS DISTINCT FROM 'string' OR v->>'locale' !~ '^[a-z]{2,3}(-[A-Z]{2})?$'
    OR NOT (v->'program_id'='null'::JSONB OR (jsonb_typeof(v->'program_id')='string' AND v->>'program_id' ~ '^[0-9A-HJKMNP-TV-Z]{26}$'))
    OR jsonb_typeof(v->'development_only') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(v->'terms') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'terms') NOT BETWEEN 2 AND 11
  THEN RAISE EXCEPTION 'consent_contract_invalid' USING ERRCODE='22023'; END IF;
  PERFORM public.consent_care_check_keys(v->'jurisdictional_review',ARRAY['artifact_reference','conclusion']);
  IF NOT public.consent_care_safe_text(v->'jurisdictional_review'->'artifact_reference',500)
    OR v->'jurisdictional_review'->>'conclusion' NOT IN ('no_additional_consent','requirements_listed')
    OR jsonb_typeof(v->'jurisdictional_review'->'conclusion') IS DISTINCT FROM 'string'
  THEN RAISE EXCEPTION 'consent_contract_invalid' USING ERRCODE='22023'; END IF;
  FOR term IN SELECT * FROM jsonb_array_elements(v->'terms') LOOP
    base_keys := ARRAY['key','version_label','title','summary','sections','withdrawal_effect','duration','consent_type','scope_id'];
    IF term->>'consent_type'='jurisdictional' THEN base_keys:=base_keys||'regulatory_reference'::TEXT;
    ELSIF term->>'consent_type'='data_use' THEN base_keys:=base_keys||'decline_effect'::TEXT;
    END IF;
    PERFORM public.consent_care_check_keys(term,base_keys);
    IF jsonb_typeof(term->'key') IS DISTINCT FROM 'string' OR term->>'key' !~ '^[a-z][a-z0-9_]{0,63}$' OR term->>'key'=ANY(term_keys)
      OR jsonb_typeof(term->'version_label') IS DISTINCT FROM 'string' OR term->>'version_label' !~ '^v[0-9]{1,4}\.[0-9]{1,4}(\.[0-9]{1,4})?$'
      OR NOT public.consent_care_safe_text(term->'title',160) OR NOT public.consent_care_safe_text(term->'summary',1000)
      OR NOT public.consent_care_safe_text(term->'withdrawal_effect',1500) OR term->>'duration' IS DISTINCT FROM 'until_withdrawn'
      OR jsonb_typeof(term->'sections') IS DISTINCT FROM 'array' OR jsonb_array_length(term->'sections') NOT BETWEEN 1 AND 8
    THEN RAISE EXCEPTION 'consent_contract_invalid' USING ERRCODE='22023'; END IF;
    term_keys:=array_append(term_keys,term->>'key');
    scope:=public.consent_care_canonical_json(jsonb_build_array(term->'consent_type',term->'scope_id'));
    IF scope=ANY(scopes) THEN RAISE EXCEPTION 'consent_contract_invalid' USING ERRCODE='22023'; END IF;
    scopes:=array_append(scopes,scope);
    IF term->>'consent_type'='platform' AND term->'scope_id'='null'::JSONB THEN platform_count:=platform_count+1;
    ELSIF term->>'consent_type'='care' AND term->'scope_id'=v->'program_id' THEN care_count:=care_count+1;
    ELSIF term->>'consent_type'='jurisdictional' AND jsonb_typeof(term->'scope_id')='string' AND term->>'scope_id' ~ '^[a-z][a-z0-9_]{0,63}$'
      AND public.consent_care_safe_text(term->'regulatory_reference',1000) THEN jurisdictional_count:=jurisdictional_count+1;
    ELSIF term->>'consent_type'='data_use' AND term->>'scope_id'='ai_interpretation' AND public.consent_care_safe_text(term->'decline_effect',1500) THEN NULL;
    ELSE RAISE EXCEPTION 'consent_contract_invalid' USING ERRCODE='22023'; END IF;
    FOR section IN SELECT * FROM jsonb_array_elements(term->'sections') LOOP
      PERFORM public.consent_care_check_keys(section,ARRAY['heading','body']);
      IF NOT public.consent_care_safe_text(section->'heading',120) OR NOT public.consent_care_safe_text(section->'body',6000)
      THEN RAISE EXCEPTION 'consent_contract_invalid' USING ERRCODE='22023'; END IF;
    END LOOP;
  END LOOP;
  IF platform_count<>1 OR care_count<>1 OR ((v->'jurisdictional_review'->>'conclusion'='no_additional_consent') <> (jurisdictional_count=0))
  THEN RAISE EXCEPTION 'consent_contract_invalid' USING ERRCODE='22023'; END IF;
  RETURN encode(public.digest(canonical,'sha256'),'hex');
END $$;
ALTER FUNCTION public.consent_care_validate_policy(JSONB) OWNER TO consent_care_owner;
REVOKE ALL ON FUNCTION public.consent_care_validate_policy(JSONB) FROM PUBLIC;

CREATE FUNCTION public.consent_care_create_policy(p_policy_id TEXT, p_content JSONB, p_content_hash TEXT) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a JSONB; h TEXT;
BEGIN
  a:=public.consent_care_live_actor('policy_author');
  h:=public.consent_care_validate_policy(p_content);
  IF p_policy_id IS NULL OR p_policy_id !~ '^[0-9A-HJKMNP-TV-Z]{26}$' OR p_content_hash IS DISTINCT FROM h
    OR p_content->>'country_of_care' IS DISTINCT FROM a->>'country_of_care'
  THEN RAISE EXCEPTION 'consent_contract_invalid' USING ERRCODE='22023'; END IF;
  INSERT INTO public.consent_care_policy(policy_id,tenant_id,country_of_care,locale,program_id,content,content_hash,development_only,author_id)
  VALUES(p_policy_id,a->>'tenant_id',a->>'country_of_care',p_content->>'locale',p_content->>'program_id',p_content,h,(p_content->>'development_only')::BOOLEAN,a->>'account_id');
  IF public.consent_care_live_actor('policy_author') IS DISTINCT FROM a THEN
    RAISE EXCEPTION 'consent_unauthenticated' USING ERRCODE='PT401';
  END IF;
  RETURN jsonb_build_object('policy_id',p_policy_id,'content_hash',h,'status','draft');
END $$;
ALTER FUNCTION public.consent_care_create_policy(TEXT,JSONB,TEXT) OWNER TO consent_care_owner;
REVOKE ALL ON FUNCTION public.consent_care_create_policy(TEXT,JSONB,TEXT) FROM PUBLIC;

CREATE FUNCTION public.consent_care_publish_policy(p_policy_id TEXT, p_content_hash TEXT, p_version_ids JSONB) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a JSONB; policy public.consent_care_policy; term JSONB; version public.consent_versions; superseded JSONB;
  term_text TEXT; term_index INTEGER:=0; version_id TEXT; term_hash TEXT;
BEGIN
  a:=public.consent_care_live_actor('policy_reviewer');
  SELECT * INTO policy FROM public.consent_care_policy p WHERE p.tenant_id=a->>'tenant_id' AND p.policy_id=p_policy_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'consent_policy_unavailable' USING ERRCODE='PT404'; END IF;
  -- All publication/supersession/withdrawal operations use the same family lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('consent-policy:' || policy.tenant_id || ':' || policy.country_of_care || ':' || policy.locale || ':' || COALESCE(policy.program_id,''),0));
  SELECT * INTO STRICT policy FROM public.consent_care_policy p WHERE p.tenant_id=a->>'tenant_id' AND p.policy_id=p_policy_id FOR UPDATE;
  IF public.consent_care_live_actor('policy_reviewer') IS DISTINCT FROM a THEN
    RAISE EXCEPTION 'consent_unauthenticated' USING ERRCODE='PT401';
  END IF;
  IF policy.author_id=a->>'account_id' THEN RAISE EXCEPTION 'consent_independent_review_required' USING ERRCODE='42501'; END IF;
  IF policy.status<>'draft' OR policy.content_hash IS DISTINCT FROM p_content_hash
    OR public.consent_care_validate_policy(policy.content) IS DISTINCT FROM policy.content_hash
  THEN RAISE EXCEPTION 'consent_policy_changed' USING ERRCODE='PT409'; END IF;
  IF jsonb_typeof(p_version_ids) IS DISTINCT FROM 'array' OR jsonb_array_length(p_version_ids)<>jsonb_array_length(policy.content->'terms')
  THEN RAISE EXCEPTION 'consent_contract_invalid' USING ERRCODE='22023'; END IF;
  -- Acquire shared version locks in one order across differently ordered policy
  -- presentations. Each policy family retains its independent lifecycle lock.
  FOR term IN SELECT value FROM jsonb_array_elements(policy.content->'terms') ORDER BY value->>'consent_type',value->>'version_label' LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('consent-version:' || policy.tenant_id || ':' || (term->>'consent_type') || ':' || (term->>'version_label') || ':' || policy.locale,0));
  END LOOP;
  FOR term IN SELECT * FROM jsonb_array_elements(policy.content->'terms') LOOP
    version_id:=p_version_ids->>term_index;
    IF jsonb_typeof(p_version_ids->term_index) IS DISTINCT FROM 'string' OR version_id !~ '^[0-9A-HJKMNP-TV-Z]{26}$'
    THEN RAISE EXCEPTION 'consent_contract_invalid' USING ERRCODE='22023'; END IF;
    term_index:=term_index+1;
    -- Versions represent exact displayed terms. Scope belongs to the grant and
    -- policy mapping, so identical copy may be reused across separate programs.
    term_text:=public.consent_care_canonical_json(term-ARRAY['key','scope_id']);
    term_hash:=encode(public.digest(public.consent_care_canonical_json(term),'sha256'),'hex');
    SELECT * INTO version FROM public.consent_versions v WHERE v.tenant_id=policy.tenant_id AND v.consent_type=term->>'consent_type'
      AND v.version_label=term->>'version_label' AND v.locale=policy.locale;
    IF FOUND THEN
      IF version.terms_text IS DISTINCT FROM term_text OR version.regulatory_reference IS DISTINCT FROM term->>'regulatory_reference'
        OR NOT EXISTS (SELECT 1 FROM public.consent_care_policy_term t WHERE t.tenant_id=policy.tenant_id AND t.consent_version_id=version.consent_version_id)
      THEN RAISE EXCEPTION 'consent_version_conflict' USING ERRCODE='PT409'; END IF;
      version_id:=version.consent_version_id;
    ELSE
      INSERT INTO public.consent_versions(consent_version_id,tenant_id,consent_type,version_label,locale,terms_text,regulatory_reference,published_at,created_at)
      VALUES(version_id,policy.tenant_id,term->>'consent_type',term->>'version_label',policy.locale,term_text,term->>'regulatory_reference',clock_timestamp(),clock_timestamp());
    END IF;
    INSERT INTO public.consent_care_policy_term(tenant_id,policy_id,term_key,consent_version_id,consent_type,scope_id,term_hash)
    VALUES(policy.tenant_id,policy.policy_id,term->>'key',version_id,term->>'consent_type',term->>'scope_id',term_hash);
  END LOOP;
  WITH changed AS (
    UPDATE public.consent_care_policy SET status='superseded' WHERE tenant_id=policy.tenant_id AND country_of_care=policy.country_of_care
      AND locale=policy.locale AND program_id IS NOT DISTINCT FROM policy.program_id AND status='published'
    RETURNING policy_id,content_hash
  ) SELECT COALESCE(jsonb_agg(jsonb_build_object('policy_id',policy_id,'content_hash',content_hash,'status','superseded')),'[]'::JSONB) INTO superseded FROM changed;
  UPDATE public.consent_care_policy SET status='published',reviewer_id=a->>'account_id',published_at=clock_timestamp()
    WHERE tenant_id=policy.tenant_id AND policy_id=policy.policy_id;
  IF public.consent_care_live_actor('policy_reviewer') IS DISTINCT FROM a THEN
    RAISE EXCEPTION 'consent_unauthenticated' USING ERRCODE='PT401';
  END IF;
  RETURN jsonb_build_object('policy_id',policy.policy_id,'content_hash',policy.content_hash,'status','published','superseded',superseded);
END $$;
ALTER FUNCTION public.consent_care_publish_policy(TEXT,TEXT,JSONB) OWNER TO consent_care_owner;
REVOKE ALL ON FUNCTION public.consent_care_publish_policy(TEXT,TEXT,JSONB) FROM PUBLIC;

CREATE FUNCTION public.consent_care_get_policy(p_policy_id TEXT) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a JSONB; result JSONB; capability TEXT:='policy_author';
BEGIN
  BEGIN a:=public.consent_care_live_actor(capability);
  EXCEPTION WHEN insufficient_privilege THEN capability:='policy_reviewer';a:=public.consent_care_live_actor(capability);END;
  SELECT jsonb_build_object('policy_id',p.policy_id,'content_hash',p.content_hash,'status',p.status,'content',p.content,
    'author_id',p.author_id,'reviewer_id',p.reviewer_id,'created_at',p.created_at,'published_at',p.published_at,'withdrawn_at',p.withdrawn_at)
  INTO result FROM public.consent_care_policy p WHERE p.tenant_id=a->>'tenant_id' AND p.policy_id=p_policy_id;
  IF public.consent_care_live_actor(capability) IS DISTINCT FROM a THEN RAISE EXCEPTION 'consent_unauthenticated' USING ERRCODE='PT401'; END IF;
  IF result IS NULL THEN RAISE EXCEPTION 'consent_policy_unavailable' USING ERRCODE='PT404'; END IF;
  RETURN result;
END $$;
ALTER FUNCTION public.consent_care_get_policy(TEXT) OWNER TO consent_care_owner;
REVOKE ALL ON FUNCTION public.consent_care_get_policy(TEXT) FROM PUBLIC;

GRANT SELECT ON public.audit_records,public.domain_events_outbox TO consent_care_owner;
CREATE FUNCTION public.consent_care_current_write(p_xmin XID) RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE root NUMERIC:=pg_current_xact_id()::TEXT::NUMERIC; candidate NUMERIC;
BEGIN
  candidate:=floor(root/4294967296)*4294967296+p_xmin::TEXT::NUMERIC;
  IF candidate<root THEN candidate:=candidate+4294967296; END IF;
  RETURN pg_xact_status(candidate::TEXT::XID8)='in progress';
EXCEPTION WHEN invalid_parameter_value THEN RETURN FALSE;
END $$;
ALTER FUNCTION public.consent_care_current_write(XID) OWNER TO consent_care_owner;
REVOKE ALL ON FUNCTION public.consent_care_current_write(XID) FROM PUBLIC;

CREATE FUNCTION public.consent_care_require_policy_evidence() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a JSONB; intent TEXT;
BEGIN
  a:=public.consent_care_live_actor(CASE WHEN NEW.status='draft' THEN 'policy_author' ELSE 'policy_reviewer' END);
  intent:='consent.policy.' || CASE WHEN NEW.status='draft' THEN 'drafted' ELSE NEW.status END;
  IF NOT EXISTS(SELECT 1 FROM public.audit_records r WHERE r.tenant_id=NEW.tenant_id AND r.resource_id=NEW.policy_id
    AND r.resource_type='consent_care_policy' AND r.actor_id=a->>'account_id' AND r.action='config_change_validated'
    AND r.payload->>'intent'=intent AND r.payload->>'content_hash'=NEW.content_hash AND public.consent_care_current_write(r.xmin))
    OR NOT EXISTS(SELECT 1 FROM public.domain_events_outbox e WHERE e.tenant_id=NEW.tenant_id AND e.aggregate_id=NEW.policy_id
    AND e.event_type=intent AND e.payload->>'content_hash'=NEW.content_hash AND public.consent_care_current_write(e.xmin)
    AND EXISTS(SELECT 1 FROM public.audit_records r WHERE r.tenant_id=NEW.tenant_id AND r.audit_id::TEXT=e.payload->>'audit_id'
      AND r.resource_id=NEW.policy_id AND r.resource_type='consent_care_policy' AND r.action='config_change_validated'
      AND r.actor_id=a->>'account_id' AND r.payload->>'intent'=intent AND r.payload->>'content_hash'=NEW.content_hash
      AND public.consent_care_current_write(r.xmin)))
  THEN RAISE EXCEPTION 'consent_policy_evidence_required' USING ERRCODE='23514'; END IF;
  IF public.consent_care_live_actor(CASE WHEN NEW.status='draft' THEN 'policy_author' ELSE 'policy_reviewer' END) IS DISTINCT FROM a THEN
    RAISE EXCEPTION 'consent_unauthenticated' USING ERRCODE='PT401';
  END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION public.consent_care_require_policy_evidence() OWNER TO consent_care_owner;
REVOKE ALL ON FUNCTION public.consent_care_require_policy_evidence() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER consent_care_policy_evidence AFTER INSERT OR UPDATE ON public.consent_care_policy
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.consent_care_require_policy_evidence();

GRANT EXECUTE ON FUNCTION public.consent_care_live_actor(TEXT) TO consent_care_patient,consent_care_operator;
GRANT EXECUTE ON FUNCTION public.consent_care_create_policy(TEXT,JSONB,TEXT),public.consent_care_publish_policy(TEXT,TEXT,JSONB),public.consent_care_get_policy(TEXT) TO consent_care_operator;

-- The application resolves the same registered CCR key through Tenant Config's
-- public API. This private database check independently binds its selection and
-- retains a share lock through patient writes; an arbitrary policy ID is not an
-- activation credential. Only the selected entry is disclosed.
CREATE FUNCTION public.consent_care_resolve_policy(p_program_id TEXT) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a JSONB; bindings JSONB; binding JSONB; policy public.consent_care_policy; locale TEXT;
BEGIN
  a:=public.consent_care_live_actor(NULL);
  IF p_program_id IS NOT NULL AND p_program_id !~ '^[0-9A-HJKMNP-TV-Z]{26}$' THEN
    RAISE EXCEPTION 'consent_contract_invalid' USING ERRCODE='22023';
  END IF;
  SELECT c.config_value INTO bindings FROM public.ccr_configs c WHERE c.tenant_id=a->>'tenant_id'
    AND c.config_key='consent.care_policy_publications' FOR SHARE;
  IF bindings IS NULL OR jsonb_typeof(bindings)<>'object' THEN
    RAISE EXCEPTION 'consent_policy_unavailable' USING ERRCODE='PT503';
  END IF;
  binding:=bindings->COALESCE(p_program_id,'general');
  BEGIN PERFORM public.consent_care_check_keys(binding,ARRAY['publication_id','policy_hash','development_only']);
  EXCEPTION WHEN invalid_parameter_value THEN RAISE EXCEPTION 'consent_policy_unavailable' USING ERRCODE='PT503'; END;
  IF jsonb_typeof(binding->'publication_id') IS DISTINCT FROM 'string'
    OR (binding->>'publication_id') !~ '^[0-9A-HJKMNP-TV-Z]{26}$'
    OR jsonb_typeof(binding->'policy_hash') IS DISTINCT FROM 'string'
    OR (binding->>'policy_hash') !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(binding->'development_only') IS DISTINCT FROM 'boolean'
  THEN RAISE EXCEPTION 'consent_policy_unavailable' USING ERRCODE='PT503'; END IF;
  SELECT c.default_locale INTO locale FROM public.country_profiles c WHERE c.country=a->>'country_of_care';
  SELECT * INTO policy FROM public.consent_care_policy p WHERE p.tenant_id=a->>'tenant_id'
    AND p.policy_id=binding->>'publication_id' FOR SHARE;
  IF NOT FOUND OR policy.status<>'published' OR policy.content_hash IS DISTINCT FROM binding->>'policy_hash'
    OR policy.development_only IS DISTINCT FROM (binding->>'development_only')::BOOLEAN
    OR policy.country_of_care IS DISTINCT FROM a->>'country_of_care' OR policy.locale IS DISTINCT FROM locale
    OR policy.program_id IS DISTINCT FROM p_program_id
    OR public.consent_care_validate_policy(policy.content) IS DISTINCT FROM policy.content_hash
  THEN RAISE EXCEPTION 'consent_policy_unavailable' USING ERRCODE='PT503'; END IF;
  IF public.consent_care_live_actor(NULL) IS DISTINCT FROM a THEN RAISE EXCEPTION 'consent_unauthenticated' USING ERRCODE='PT401'; END IF;
  RETURN jsonb_build_object('publication_id',policy.policy_id,'policy_hash',policy.content_hash,'content',policy.content);
END $$;
ALTER FUNCTION public.consent_care_resolve_policy(TEXT) OWNER TO consent_care_owner;
REVOKE ALL ON FUNCTION public.consent_care_resolve_policy(TEXT) FROM PUBLIC;

-- Sequence order is allocated only after the shared patient lock. It does not
-- assume that random ULID suffixes or transaction-start timestamps are ordered.
CREATE FUNCTION public.consent_care_latest_choice(p_account_id TEXT,p_type TEXT,p_scope TEXT) RETURNS public.consent_care_decision
LANGUAGE sql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT d.* FROM public.consent_care_decision d JOIN public.consent_care_policy_term t
    ON (t.tenant_id,t.policy_id,t.term_key)=(d.tenant_id,d.policy_id,d.term_key)
  WHERE d.tenant_id=public.current_tenant_id() AND d.account_id=p_account_id
    AND t.consent_type=p_type AND t.scope_id IS NOT DISTINCT FROM p_scope
  ORDER BY d.sequence_number DESC LIMIT 1
$$;
ALTER FUNCTION public.consent_care_latest_choice(TEXT,TEXT,TEXT) OWNER TO consent_care_owner;
REVOKE ALL ON FUNCTION public.consent_care_latest_choice(TEXT,TEXT,TEXT) FROM PUBLIC;

CREATE FUNCTION public.consent_care_record_choices(p_program_id TEXT,p_publication_id TEXT,p_hash TEXT,p_choices JSONB,p_ids JSONB) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a JSONB; resolved JSONB; term public.consent_care_policy_term; choice JSONB; previous public.consent_care_decision;
  decision_id TEXT; consent_id TEXT; accepted BOOLEAN; i INTEGER:=0; at_time TIMESTAMPTZ; result JSONB:='[]'; kind TEXT;
BEGIN
  a:=public.consent_care_live_actor(NULL);
  PERFORM pg_advisory_xact_lock(hashtextextended('consent-patient:' || (a->>'tenant_id') || ':' || (a->>'account_id'),0));
  resolved:=public.consent_care_resolve_policy(p_program_id);
  IF resolved->>'publication_id' IS DISTINCT FROM p_publication_id OR resolved->>'policy_hash' IS DISTINCT FROM p_hash THEN
    RAISE EXCEPTION 'consent_policy_changed' USING ERRCODE='PT409';
  END IF;
  IF jsonb_typeof(p_choices) IS DISTINCT FROM 'array' OR jsonb_typeof(p_ids) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_choices)<>jsonb_array_length(resolved->'content'->'terms')
    OR jsonb_array_length(p_ids)<>jsonb_array_length(p_choices)
  THEN RAISE EXCEPTION 'consent_contract_invalid' USING ERRCODE='22023'; END IF;
  FOR choice IN SELECT value FROM jsonb_array_elements(p_choices) LOOP
    PERFORM public.consent_care_check_keys(choice,ARRAY['term_key','accepted']);
    IF jsonb_typeof(choice->'term_key') IS DISTINCT FROM 'string'
      OR jsonb_typeof(choice->'accepted') IS DISTINCT FROM 'boolean'
      OR (SELECT count(*) FROM jsonb_array_elements(p_choices) c WHERE c->>'term_key'=choice->>'term_key')<>1
    THEN RAISE EXCEPTION 'consent_contract_invalid' USING ERRCODE='22023'; END IF;
    SELECT * INTO term FROM public.consent_care_policy_term t WHERE t.tenant_id=a->>'tenant_id'
      AND t.policy_id=p_publication_id AND t.term_key=choice->>'term_key';
    IF NOT FOUND THEN RAISE EXCEPTION 'consent_contract_invalid' USING ERRCODE='22023'; END IF;
    PERFORM public.consent_care_check_keys(p_ids->i,ARRAY['decision_id','consent_id']);
    decision_id:=p_ids->i->>'decision_id';consent_id:=p_ids->i->>'consent_id';
    IF decision_id IS NULL OR decision_id !~ '^[0-9A-HJKMNP-TV-Z]{26}$' OR consent_id IS NULL OR consent_id !~ '^[0-9A-HJKMNP-TV-Z]{26}$' THEN
      RAISE EXCEPTION 'consent_contract_invalid' USING ERRCODE='22023';
    END IF;
    i:=i+1;accepted:=(choice->>'accepted')::BOOLEAN;at_time:=clock_timestamp();
    previous:=public.consent_care_latest_choice(a->>'account_id',term.consent_type,term.scope_id);
    -- Withdrawing previously accepted platform terms requires the separate,
    -- explicit account-closure transaction, never an ordinary care toggle.
    IF term.consent_type='platform' AND NOT accepted AND previous.accepted THEN
      RAISE EXCEPTION 'consent_account_closure_required' USING ERRCODE='PT409';
    END IF;
    IF accepted OR previous.accepted THEN
      kind:=CASE WHEN accepted THEN 'granted' ELSE 'revoked' END;
      INSERT INTO public.consent(consent_id,tenant_id,account_id,consent_type,scope_id,consent_version_id,status,evidence,revocation_reason,expires_at,created_at)
      VALUES(consent_id,a->>'tenant_id',a->>'account_id',term.consent_type,term.scope_id,term.consent_version_id,kind,
        jsonb_build_object('type','in_app','timestamp',at_time,'session_id',a->>'session_id','publication_id',p_publication_id,
          'policy_hash',p_hash,'term_key',term.term_key,'accepted',accepted,'country_of_care',a->>'country_of_care'),
        CASE WHEN accepted THEN NULL ELSE 'patient_initiated' END,NULL,at_time);
    ELSE consent_id:=NULL;kind:='declined'; END IF;
    INSERT INTO public.consent_care_decision(decision_id,tenant_id,account_id,policy_id,term_key,accepted,consent_id,session_id,recorded_at)
    VALUES(decision_id,a->>'tenant_id',a->>'account_id',p_publication_id,term.term_key,accepted,consent_id,a->>'session_id',at_time);
    result:=result || jsonb_build_array(jsonb_build_object('decision_id',decision_id,'consent_id',consent_id,'term_key',term.term_key,
      'consent_type',term.consent_type,'scope_id',term.scope_id,'consent_version_id',term.consent_version_id,'accepted',accepted,'status',kind));
  END LOOP;
  IF public.consent_care_live_actor(NULL) IS DISTINCT FROM a THEN RAISE EXCEPTION 'consent_unauthenticated' USING ERRCODE='PT401'; END IF;
  RETURN jsonb_build_object('publication_id',p_publication_id,'policy_hash',p_hash,'decisions',result);
END $$;
ALTER FUNCTION public.consent_care_record_choices(TEXT,TEXT,TEXT,JSONB,JSONB) OWNER TO consent_care_owner;
REVOKE ALL ON FUNCTION public.consent_care_record_choices(TEXT,TEXT,TEXT,JSONB,JSONB) FROM PUBLIC;

CREATE FUNCTION public.consent_care_require_choice_evidence() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a JSONB; term public.consent_care_policy_term; canonical public.consent; evidence_action TEXT;
BEGIN
  a:=public.consent_care_live_actor(NULL);
  IF NEW.tenant_id IS DISTINCT FROM a->>'tenant_id' OR NEW.account_id IS DISTINCT FROM a->>'account_id'
    OR NEW.session_id IS DISTINCT FROM a->>'session_id' THEN
    RAISE EXCEPTION 'consent_scope_unavailable' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.audit_records r JOIN public.domain_events_outbox e
    ON e.tenant_id=r.tenant_id AND e.payload->>'audit_id'=r.audit_id::TEXT
    WHERE r.tenant_id=NEW.tenant_id AND r.resource_id=NEW.decision_id AND r.resource_type='consent_care_decision'
      AND r.actor_id=NEW.account_id AND r.target_patient_id=NEW.account_id AND r.action='consent_choice_recorded'
      AND r.payload->>'publication_id'=NEW.policy_id AND r.payload->>'term_key'=NEW.term_key
      AND r.payload->'accepted'=to_jsonb(NEW.accepted)
      AND e.aggregate_id=NEW.decision_id AND e.event_type='consent.choice_recorded'
      AND e.payload->>'publication_id'=NEW.policy_id AND e.payload->>'term_key'=NEW.term_key
      AND e.payload->'accepted'=to_jsonb(NEW.accepted)
      AND public.consent_care_current_write(r.xmin) AND public.consent_care_current_write(e.xmin))
  THEN RAISE EXCEPTION 'consent_choice_evidence_required' USING ERRCODE='23514'; END IF;
  IF NEW.consent_id IS NOT NULL THEN
    SELECT * INTO STRICT term FROM public.consent_care_policy_term t WHERE (t.tenant_id,t.policy_id,t.term_key)=(NEW.tenant_id,NEW.policy_id,NEW.term_key);
    SELECT * INTO STRICT canonical FROM public.consent c WHERE c.tenant_id=NEW.tenant_id AND c.consent_id=NEW.consent_id;
    evidence_action:=CASE WHEN NEW.accepted THEN 'consent_granted' ELSE 'consent_revoked' END;
    IF canonical.account_id<>NEW.account_id OR canonical.consent_type<>term.consent_type OR canonical.scope_id IS DISTINCT FROM term.scope_id
      OR canonical.consent_version_id<>term.consent_version_id OR (canonical.status='granted')<>NEW.accepted
      OR NOT EXISTS(SELECT 1 FROM public.audit_records r JOIN public.domain_events_outbox e
        ON e.tenant_id=r.tenant_id AND e.payload->>'audit_id'=r.audit_id::TEXT
        WHERE r.tenant_id=NEW.tenant_id AND r.resource_id=NEW.consent_id AND r.resource_type='consent'
          AND r.actor_id=NEW.account_id AND r.target_patient_id=NEW.account_id AND r.action=evidence_action
          AND e.aggregate_id=NEW.consent_id AND e.event_type=replace(evidence_action,'consent_','consent.')
          AND public.consent_care_current_write(r.xmin) AND public.consent_care_current_write(e.xmin))
    THEN RAISE EXCEPTION 'consent_choice_evidence_required' USING ERRCODE='23514'; END IF;
  END IF;
  IF public.consent_care_live_actor(NULL) IS DISTINCT FROM a THEN RAISE EXCEPTION 'consent_unauthenticated' USING ERRCODE='PT401'; END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION public.consent_care_require_choice_evidence() OWNER TO consent_care_owner;
REVOKE ALL ON FUNCTION public.consent_care_require_choice_evidence() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER consent_care_choice_evidence AFTER INSERT ON public.consent_care_decision
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.consent_care_require_choice_evidence();
GRANT EXECUTE ON FUNCTION public.consent_care_resolve_policy(TEXT),public.consent_care_record_choices(TEXT,TEXT,TEXT,JSONB,JSONB) TO consent_care_patient;

CREATE FUNCTION public.consent_care_history(p_offset INTEGER DEFAULT 0) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a JSONB; result JSONB;
BEGIN
  a:=public.consent_care_live_actor(NULL);
  IF p_offset IS NULL OR p_offset<0 OR p_offset>10000 THEN RAISE EXCEPTION 'consent_contract_invalid' USING ERRCODE='22023'; END IF;
  WITH page AS (
    SELECT d.sequence_number,jsonb_build_object('decision_id',d.decision_id,'publication_id',d.policy_id,'policy_hash',p.content_hash,
      'term_key',d.term_key,'consent_type',t.consent_type,'scope_id',t.scope_id,'consent_version_id',t.consent_version_id,
      'accepted',d.accepted,'status',CASE WHEN d.accepted THEN 'granted' WHEN d.consent_id IS NULL THEN 'declined' ELSE 'revoked' END,
      'recorded_at',d.recorded_at,'policy_status',p.status,
      'title',copy.value->>'title','version_label',copy.value->>'version_label',
      'country_of_care',p.country_of_care,'program_id',p.program_id,
      'current_choice',latest.decision_id=d.decision_id,
      'can_withdraw',d.accepted AND latest.decision_id=d.decision_id AND t.consent_type<>'platform',
      'requires_account_closure',d.accepted AND latest.decision_id=d.decision_id AND t.consent_type='platform') AS item
    FROM public.consent_care_decision d JOIN public.consent_care_policy p ON (p.tenant_id,p.policy_id)=(d.tenant_id,d.policy_id)
      JOIN public.consent_care_policy_term t ON (t.tenant_id,t.policy_id,t.term_key)=(d.tenant_id,d.policy_id,d.term_key)
      CROSS JOIN LATERAL public.consent_care_latest_choice(d.account_id,t.consent_type,t.scope_id) latest
      CROSS JOIN LATERAL jsonb_array_elements(p.content->'terms') copy
    WHERE copy.value->>'key'=d.term_key
      AND d.tenant_id=a->>'tenant_id' AND d.account_id=a->>'account_id' ORDER BY d.sequence_number DESC OFFSET p_offset LIMIT 26
  ) SELECT jsonb_build_object('offset',p_offset,'limit',25,'has_more',count(*)>25,
    'items',COALESCE((SELECT jsonb_agg(shown.item ORDER BY shown.sequence_number DESC) FROM (SELECT * FROM page ORDER BY sequence_number DESC LIMIT 25) shown),'[]'::JSONB))
    INTO result FROM page;
  IF public.consent_care_live_actor(NULL) IS DISTINCT FROM a THEN RAISE EXCEPTION 'consent_unauthenticated' USING ERRCODE='PT401'; END IF;
  RETURN result;
END $$;
ALTER FUNCTION public.consent_care_history(INTEGER) OWNER TO consent_care_owner;
REVOKE ALL ON FUNCTION public.consent_care_history(INTEGER) FROM PUBLIC;

-- Exact historical copy is returned only through the patient's own decision.
-- Publication IDs alone are never authorization to read another patient's receipt.
CREATE FUNCTION public.consent_care_decision_detail(p_decision_id TEXT) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a JSONB; result JSONB;
BEGIN
  a:=public.consent_care_live_actor(NULL);
  SELECT jsonb_build_object('decision_id',d.decision_id,'publication_id',d.policy_id,'policy_hash',p.content_hash,
    'term_key',d.term_key,'consent_type',t.consent_type,'scope_id',t.scope_id,'consent_version_id',t.consent_version_id,
    'accepted',d.accepted,'status',CASE WHEN d.accepted THEN 'granted' WHEN d.consent_id IS NULL THEN 'declined' ELSE 'revoked' END,
    'recorded_at',d.recorded_at,'policy_status',p.status,
    'title',copy.value->>'title','version_label',copy.value->>'version_label',
    'country_of_care',p.country_of_care,'program_id',p.program_id,
    'current_choice',latest.decision_id=d.decision_id,
    'can_withdraw',d.accepted AND latest.decision_id=d.decision_id AND t.consent_type<>'platform',
    'requires_account_closure',d.accepted AND latest.decision_id=d.decision_id AND t.consent_type='platform',
    'locale',p.locale,'development_only',p.development_only,'term',copy.value)
  INTO result FROM public.consent_care_decision d
    JOIN public.consent_care_policy p ON (p.tenant_id,p.policy_id)=(d.tenant_id,d.policy_id)
    JOIN public.consent_care_policy_term t ON (t.tenant_id,t.policy_id,t.term_key)=(d.tenant_id,d.policy_id,d.term_key)
    CROSS JOIN LATERAL public.consent_care_latest_choice(d.account_id,t.consent_type,t.scope_id) latest
    CROSS JOIN LATERAL jsonb_array_elements(p.content->'terms') copy
  WHERE d.tenant_id=a->>'tenant_id' AND d.account_id=a->>'account_id' AND d.decision_id=p_decision_id
    AND copy.value->>'key'=d.term_key;
  IF public.consent_care_live_actor(NULL) IS DISTINCT FROM a THEN RAISE EXCEPTION 'consent_unauthenticated' USING ERRCODE='PT401'; END IF;
  IF result IS NULL THEN RAISE EXCEPTION 'consent_unavailable' USING ERRCODE='PT404'; END IF;
  RETURN result;
END $$;
ALTER FUNCTION public.consent_care_decision_detail(TEXT) OWNER TO consent_care_owner;
REVOKE ALL ON FUNCTION public.consent_care_decision_detail(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consent_care_decision_detail(TEXT) TO consent_care_patient;

CREATE FUNCTION public.consent_care_withdraw(p_decision_id TEXT,p_new_decision_id TEXT,p_consent_id TEXT) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a JSONB; previous public.consent_care_decision; latest public.consent_care_decision;
  term public.consent_care_policy_term; policy public.consent_care_policy; at_time TIMESTAMPTZ;
BEGIN
  a:=public.consent_care_live_actor(NULL);
  IF p_new_decision_id IS NULL OR p_new_decision_id !~ '^[0-9A-HJKMNP-TV-Z]{26}$' OR p_consent_id IS NULL OR p_consent_id !~ '^[0-9A-HJKMNP-TV-Z]{26}$' THEN
    RAISE EXCEPTION 'consent_contract_invalid' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('consent-patient:' || (a->>'tenant_id') || ':' || (a->>'account_id'),0));
  SELECT * INTO previous FROM public.consent_care_decision d WHERE d.tenant_id=a->>'tenant_id'
    AND d.account_id=a->>'account_id' AND d.decision_id=p_decision_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'consent_unavailable' USING ERRCODE='PT404'; END IF;
  SELECT * INTO STRICT term FROM public.consent_care_policy_term t WHERE (t.tenant_id,t.policy_id,t.term_key)=(previous.tenant_id,previous.policy_id,previous.term_key);
  SELECT * INTO STRICT policy FROM public.consent_care_policy p WHERE (p.tenant_id,p.policy_id)=(previous.tenant_id,previous.policy_id);
  latest:=public.consent_care_latest_choice(a->>'account_id',term.consent_type,term.scope_id);
  IF NOT previous.accepted OR latest.decision_id IS DISTINCT FROM p_decision_id THEN
    RAISE EXCEPTION 'consent_choice_changed' USING ERRCODE='PT409';
  END IF;
  IF term.consent_type='platform' THEN RAISE EXCEPTION 'consent_account_closure_required' USING ERRCODE='PT409'; END IF;
  at_time:=clock_timestamp();
  INSERT INTO public.consent(consent_id,tenant_id,account_id,consent_type,scope_id,consent_version_id,status,evidence,revocation_reason,expires_at,created_at)
  VALUES(p_consent_id,a->>'tenant_id',a->>'account_id',term.consent_type,term.scope_id,term.consent_version_id,'revoked',
    jsonb_build_object('type','in_app','timestamp',at_time,'session_id',a->>'session_id','publication_id',policy.policy_id,
      'policy_hash',policy.content_hash,'term_key',term.term_key,'accepted',false,'country_of_care',a->>'country_of_care'),
    'patient_initiated',NULL,at_time);
  INSERT INTO public.consent_care_decision(decision_id,tenant_id,account_id,policy_id,term_key,accepted,consent_id,session_id,recorded_at)
  VALUES(p_new_decision_id,a->>'tenant_id',a->>'account_id',policy.policy_id,term.term_key,FALSE,p_consent_id,a->>'session_id',at_time);
  IF public.consent_care_live_actor(NULL) IS DISTINCT FROM a THEN RAISE EXCEPTION 'consent_unauthenticated' USING ERRCODE='PT401'; END IF;
  RETURN jsonb_build_object('publication_id',policy.policy_id,'policy_hash',policy.content_hash,'decisions',jsonb_build_array(
    jsonb_build_object('decision_id',p_new_decision_id,'consent_id',p_consent_id,'term_key',term.term_key,'consent_type',term.consent_type,
      'scope_id',term.scope_id,'consent_version_id',term.consent_version_id,'accepted',FALSE,'status','revoked')));
END $$;
ALTER FUNCTION public.consent_care_withdraw(TEXT,TEXT,TEXT) OWNER TO consent_care_owner;
REVOKE ALL ON FUNCTION public.consent_care_withdraw(TEXT,TEXT,TEXT) FROM PUBLIC;

CREATE FUNCTION public.consent_care_status(p_program_id TEXT) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a JSONB; resolved JSONB; term public.consent_care_policy_term; latest public.consent_care_decision; active BOOLEAN;
  required_active BOOLEAN:=TRUE; ai_active BOOLEAN:=FALSE; result JSONB:='[]';
BEGIN
  a:=public.consent_care_live_actor(NULL);
  resolved:=public.consent_care_resolve_policy(p_program_id);
  FOR term IN SELECT t.* FROM public.consent_care_policy_term t WHERE t.tenant_id=a->>'tenant_id'
    AND t.policy_id=resolved->>'publication_id' ORDER BY t.term_key LOOP
    latest:=public.consent_care_latest_choice(a->>'account_id',term.consent_type,term.scope_id);
    active:=COALESCE(latest.accepted,FALSE) AND EXISTS(
      SELECT 1 FROM public.consent c JOIN public.consent_care_policy p ON p.tenant_id=c.tenant_id AND p.policy_id=latest.policy_id
      WHERE c.tenant_id=a->>'tenant_id' AND c.account_id=a->>'account_id' AND c.consent_id=latest.consent_id
        AND c.consent_version_id=term.consent_version_id AND c.consent_type=term.consent_type AND c.scope_id IS NOT DISTINCT FROM term.scope_id
        AND c.status='granted' AND (c.expires_at IS NULL OR c.expires_at>clock_timestamp()) AND p.status<>'withdrawn');
    IF term.consent_type<>'data_use' THEN required_active:=required_active AND active;
    ELSE ai_active:=active; END IF;
    result:=result || jsonb_build_array(jsonb_build_object('term_key',term.term_key,'decision_id',latest.decision_id,'active',active));
  END LOOP;
  IF public.consent_care_live_actor(NULL) IS DISTINCT FROM a THEN RAISE EXCEPTION 'consent_unauthenticated' USING ERRCODE='PT401'; END IF;
  RETURN jsonb_build_object('publication_id',resolved->>'publication_id','policy_hash',resolved->>'policy_hash',
    'required_care_active',required_active,'ai_interpretation_active',ai_active,'terms',result);
END $$;
ALTER FUNCTION public.consent_care_status(TEXT) OWNER TO consent_care_owner;
REVOKE ALL ON FUNCTION public.consent_care_status(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consent_care_history(INTEGER),public.consent_care_withdraw(TEXT,TEXT,TEXT),public.consent_care_status(TEXT) TO consent_care_patient;

CREATE FUNCTION public.consent_care_withdraw_policy(p_policy_id TEXT,p_hash TEXT) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a JSONB; policy public.consent_care_policy;
BEGIN
  a:=public.consent_care_live_actor('policy_reviewer');
  SELECT * INTO policy FROM public.consent_care_policy p WHERE p.tenant_id=a->>'tenant_id' AND p.policy_id=p_policy_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'consent_policy_unavailable' USING ERRCODE='PT404'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('consent-policy:' || policy.tenant_id || ':' || policy.country_of_care || ':' || policy.locale || ':' || COALESCE(policy.program_id,''),0));
  SELECT * INTO STRICT policy FROM public.consent_care_policy p WHERE p.tenant_id=a->>'tenant_id' AND p.policy_id=p_policy_id FOR UPDATE;
  IF policy.status NOT IN ('published','superseded') OR policy.content_hash IS DISTINCT FROM p_hash THEN
    RAISE EXCEPTION 'consent_policy_changed' USING ERRCODE='PT409';
  END IF;
  IF public.consent_care_live_actor('policy_reviewer') IS DISTINCT FROM a THEN RAISE EXCEPTION 'consent_unauthenticated' USING ERRCODE='PT401'; END IF;
  UPDATE public.consent_care_policy SET status='withdrawn',withdrawn_at=clock_timestamp() WHERE tenant_id=policy.tenant_id AND policy_id=policy.policy_id;
  IF public.consent_care_live_actor('policy_reviewer') IS DISTINCT FROM a THEN RAISE EXCEPTION 'consent_unauthenticated' USING ERRCODE='PT401'; END IF;
  RETURN jsonb_build_object('policy_id',policy.policy_id,'content_hash',policy.content_hash,'status','withdrawn');
END $$;
ALTER FUNCTION public.consent_care_withdraw_policy(TEXT,TEXT) OWNER TO consent_care_owner;
REVOKE ALL ON FUNCTION public.consent_care_withdraw_policy(TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consent_care_withdraw_policy(TEXT,TEXT) TO consent_care_operator;
