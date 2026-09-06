SET LOCAL search_path = pg_catalog, public, pg_temp;
GRANT SELECT ON public.audit_records, public.domain_events_outbox TO forms_publication_owner;

-- Rows visible here with an in-progress insertion transaction are our own
-- writes, including idempotency SAVEPOINT subtransactions. xmin alone is not
-- equal to the top-level txid when a savepoint made the insertion.
CREATE FUNCTION public.forms_current_transaction_write(p_xmin XID) RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE root NUMERIC:=pg_current_xact_id()::TEXT::NUMERIC; candidate NUMERIC;
BEGIN
  candidate:=floor(root/4294967296)*4294967296+p_xmin::TEXT::NUMERIC;
  IF candidate<root THEN candidate:=candidate+4294967296; END IF;
  RETURN pg_xact_status(candidate::TEXT::XID8)='in progress';
EXCEPTION WHEN invalid_parameter_value THEN RETURN FALSE;
END $$;
REVOKE ALL ON FUNCTION public.forms_current_transaction_write(XID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forms_current_transaction_write(XID) TO forms_publication_owner;

CREATE FUNCTION public.forms_publication_receipt(p_id TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a JSONB; result JSONB;
BEGIN
  a:=public.forms_live_actor('reviewer');
  SELECT jsonb_build_object('template_id',template_id,'schema_hash',schema_hash,'template_version',template_version,'governance',governance)
  INTO result FROM public.forms_published_definition WHERE tenant_id=a->>'tenant_id' AND template_id=p_id;
  IF result IS NULL THEN RAISE EXCEPTION 'forms_definition_unavailable' USING ERRCODE='02000'; END IF;
  RETURN result;
END $$;
ALTER FUNCTION public.forms_publication_receipt(TEXT) OWNER TO forms_publication_owner;
REVOKE ALL ON FUNCTION public.forms_publication_receipt(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forms_publication_receipt(TEXT) TO telecheck_app_role;

CREATE FUNCTION public.forms_require_publication_evidence() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  -- A raw SQL status change still needs same-transaction durable evidence.
  IF NOT EXISTS(SELECT 1 FROM public.audit_records a WHERE a.tenant_id=NEW.tenant_id
      AND a.resource_id=NEW.template_id AND a.actor_id=NEW.published_by
      AND a.action='config_change_validated' AND a.payload->>'intent'='forms.publication.checked'
      AND a.payload->>'schema_hash'=NEW.schema_hash AND public.forms_current_transaction_write(a.xmin))
    OR NOT EXISTS(SELECT 1 FROM public.domain_events_outbox e WHERE e.tenant_id=NEW.tenant_id
      AND e.aggregate_id=NEW.template_id AND e.event_type='forms.publication.checked'
      AND e.payload->>'schema_hash'=NEW.schema_hash AND public.forms_current_transaction_write(e.xmin))
  THEN RAISE EXCEPTION 'forms_publication_evidence_required' USING ERRCODE='23514'; END IF;
  PERFORM public.forms_live_actor('reviewer');
  RETURN NULL;
END $$;
ALTER FUNCTION public.forms_require_publication_evidence() OWNER TO forms_publication_owner;
REVOKE ALL ON FUNCTION public.forms_require_publication_evidence() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER forms_publication_evidence AFTER INSERT ON public.forms_published_definition
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.forms_require_publication_evidence();

-- SI-023 publication must use the same family lock, supersession and gates.
-- Keep its existing audited lifecycle and idempotency sequence, replacing only
-- the publishing UPDATE and adding live explicit reviewer membership up front.
DO $$
DECLARE body TEXT;
BEGIN
  body:=pg_get_functiondef('public.record_forms_template_admin_decision(text,uuid,text,jsonb,text)'::regprocedure);
  body:=replace(body,'SET search_path TO ''pg_catalog'', ''public''','SET search_path TO ''pg_catalog'', ''public'', ''pg_temp''');
  body:=replace(body,'BEGIN'||chr(10),'BEGIN'||chr(10)||'    PERFORM public.forms_live_actor(''reviewer'');'||chr(10));
  body:=replace(body,'    PERFORM 1 FROM forms_template',
    '    PERFORM pg_advisory_xact_lock(hashtextextended(''forms-family:'' || tenant_id || '':'' || program_id,0)) FROM public.forms_template WHERE tenant_id=p_tenant_id AND template_id=v_review_forms_template_id;'||chr(10)||'    PERFORM 1 FROM forms_template');
  body:=replace(body,'UPDATE forms_template SET status = ''published'''||chr(10)||'         WHERE tenant_id = p_tenant_id AND template_id = v_review_forms_template_id;',
    'PERFORM public.forms_publish_template(v_review_forms_template_id);');
  IF position('PERFORM public.forms_publish_template(v_review_forms_template_id);' IN body)=0 THEN RAISE EXCEPTION 'forms_admin_wrapper_shape_changed'; END IF;
  EXECUTE body;
END $$;
GRANT EXECUTE ON FUNCTION public.forms_live_actor(TEXT),public.forms_publish_template(TEXT) TO forms_template_admin_review_decision_wrapper_owner;

-- The submit handler needs only its own transition discriminator, not a raw
-- SELECT grant over every administrator's review history.
GRANT SELECT (tenant_id,review_id,submitter_principal_id) ON public.forms_template_admin_review TO forms_publication_owner;
GRANT SELECT (tenant_id,review_id,transition_reason,transition_at,id) ON public.forms_template_admin_review_lifecycle_transition TO forms_publication_owner;
CREATE FUNCTION public.forms_admin_submission_receipt(p_review UUID) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a JSONB; reason TEXT;
BEGIN
  a:=public.forms_live_actor('operator');
  SELECT l.transition_reason INTO reason FROM public.forms_template_admin_review r
  JOIN public.forms_template_admin_review_lifecycle_transition l ON l.tenant_id=r.tenant_id AND l.review_id=r.review_id
  WHERE r.tenant_id=a->>'tenant_id' AND r.review_id=p_review AND r.submitter_principal_id=a->>'account_id'
  ORDER BY l.transition_at DESC,l.id DESC LIMIT 1;
  IF reason IS NULL THEN RAISE EXCEPTION 'forms_review_unavailable' USING ERRCODE='42501'; END IF;
  RETURN reason;
END $$;
ALTER FUNCTION public.forms_admin_submission_receipt(UUID) OWNER TO forms_publication_owner;
REVOKE ALL ON FUNCTION public.forms_admin_submission_receipt(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forms_admin_submission_receipt(UUID) TO telecheck_app_role;
GRANT EXECUTE ON FUNCTION public.forms_live_actor(TEXT) TO forms_template_admin_review_submit_wrapper_owner;
DO $$
DECLARE body TEXT;
BEGIN
  body:=pg_get_functiondef('public.submit_forms_template_for_admin_review(text,text)'::regprocedure);
  body:=replace(body,'SET search_path TO ''pg_catalog'', ''public''','SET search_path TO ''pg_catalog'', ''public'', ''pg_temp''');
  body:=replace(body,'BEGIN'||chr(10),'BEGIN'||chr(10)||'    PERFORM public.forms_live_actor(''operator'');'||chr(10));
  EXECUTE body;
END $$;
