SET LOCAL search_path = pg_catalog, public, pg_temp;

CREATE FUNCTION public.forms_authorize_operation(p_operation TEXT,p_resource TEXT,p_account TEXT,p_session TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a JSONB; r public.forms_governance_artifact;
BEGIN
  a:=public.forms_live_actor();
  IF a->>'account_id' IS DISTINCT FROM p_account OR a->>'session_id' IS DISTINCT FROM p_session THEN RAISE EXCEPTION 'forms_scope_unavailable' USING ERRCODE='42501'; END IF;
  IF p_operation IN ('forms.consult_template.created','forms.consult_template.deployed','forms.consult_template.retired','forms.governance.submitted') THEN PERFORM public.forms_live_actor('operator');
  ELSIF p_operation IN ('forms.publication.checked','forms.admin.decision') THEN PERFORM public.forms_live_actor('reviewer');
  ELSIF p_operation='forms.governance.reviewed' THEN
    SELECT * INTO r FROM public.forms_governance_artifact WHERE tenant_id=a->>'tenant_id' AND artifact_id=p_resource::UUID;
    IF NOT FOUND THEN RAISE EXCEPTION 'forms_scope_unavailable' USING ERRCODE='42501'; END IF;
    PERFORM public.forms_live_actor(CASE r.kind WHEN 'clinical_review' THEN 'clinical_reviewer' WHEN 'marketing_copy' THEN 'marketing_reviewer' ELSE 'mode2_reviewer' END);
    IF r.author_id=a->>'account_id' THEN RAISE EXCEPTION 'forms_scope_unavailable' USING ERRCODE='42501'; END IF;
  ELSE RAISE EXCEPTION 'forms_scope_unavailable' USING ERRCODE='42501'; END IF;
END $$;
ALTER FUNCTION public.forms_authorize_operation(TEXT,TEXT,TEXT,TEXT) OWNER TO forms_publication_owner;
REVOKE ALL ON FUNCTION public.forms_authorize_operation(TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forms_authorize_operation(TEXT,TEXT,TEXT,TEXT) TO telecheck_app_role;

CREATE FUNCTION public.forms_create_consult_template(p_id TEXT,p_program TEXT,p_name TEXT,p_presentation JSONB,p_branching JSONB,p_eligibility JSONB,p_governance JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a JSONB; version INTEGER; result public.forms_template;
BEGIN
  a := public.forms_live_actor('operator');
  IF p_id !~ '^[0-9A-HJKMNP-TV-Z]{26}$' OR p_program !~ '^[0-9A-HJKMNP-TV-Z]{26}$' OR length(p_name) NOT BETWEEN 1 AND 200
    OR octet_length(jsonb_build_array(p_presentation,p_branching,p_eligibility,p_governance)::TEXT)>65536
  THEN RAISE EXCEPTION 'forms_contract_invalid' USING ERRCODE='22023'; END IF;
  PERFORM public.forms_validate_presentation(p_presentation,a->>'country_of_care');
  PERFORM pg_advisory_xact_lock(hashtextextended('forms-family:' || (a->>'tenant_id') || ':' || p_program,0));
  SELECT COALESCE(max(template_version),0)+1 INTO version FROM public.forms_template WHERE tenant_id=a->>'tenant_id' AND program_id=p_program AND country_of_care=a->>'country_of_care';
  PERFORM public.forms_live_actor('operator');
  INSERT INTO public.forms_template(template_id,tenant_id,program_id,country_of_care,template_version,name,presentation_content,branching_logic,eligibility_logic,approval_governance,created_by)
  VALUES(p_id,a->>'tenant_id',p_program,a->>'country_of_care',version,p_name,p_presentation,p_branching,p_eligibility,p_governance,a->>'account_id') RETURNING * INTO result;
  RETURN jsonb_build_object('template_id',result.template_id,'template_version',result.template_version,'schema_hash',public.forms_template_hash(result),'status',result.status);
END $$;
ALTER FUNCTION public.forms_create_consult_template(TEXT,TEXT,TEXT,JSONB,JSONB,JSONB,JSONB) OWNER TO forms_publication_owner;
REVOKE ALL ON FUNCTION public.forms_create_consult_template(TEXT,TEXT,TEXT,JSONB,JSONB,JSONB,JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forms_create_consult_template(TEXT,TEXT,TEXT,JSONB,JSONB,JSONB,JSONB) TO telecheck_app_role;

CREATE FUNCTION public.forms_publish_template(p_id TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a JSONB; target public.forms_template; prior TEXT;
BEGIN
  a := public.forms_live_actor('reviewer');
  SELECT * INTO target FROM public.forms_template WHERE tenant_id=a->>'tenant_id' AND template_id=p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'forms_version_unavailable' USING ERRCODE='02000'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('forms-family:' || target.tenant_id || ':' || target.program_id,0));
  SELECT * INTO target FROM public.forms_template WHERE tenant_id=a->>'tenant_id' AND template_id=p_id FOR UPDATE;
  IF target.status <> 'draft' THEN RAISE EXCEPTION 'forms_version_not_draft' USING ERRCODE='22023'; END IF;
  SELECT template_id INTO prior FROM public.forms_template WHERE tenant_id=target.tenant_id AND program_id=target.program_id AND country_of_care=target.country_of_care AND status='published' ORDER BY template_version DESC LIMIT 1;
  UPDATE public.forms_template SET status='superseded',superseded_at=clock_timestamp() WHERE tenant_id=target.tenant_id AND program_id=target.program_id AND country_of_care=target.country_of_care AND status='published';
  UPDATE public.forms_template SET status='published' WHERE tenant_id=target.tenant_id AND template_id=target.template_id RETURNING * INTO target;
  RETURN jsonb_build_object('published',to_jsonb(target),'prior_template_id',prior);
END $$;
ALTER FUNCTION public.forms_publish_template(TEXT) OWNER TO forms_publication_owner;
REVOKE ALL ON FUNCTION public.forms_publish_template(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forms_publish_template(TEXT) TO telecheck_app_role;

CREATE FUNCTION public.forms_deploy_consult_template(p_id TEXT,p_deployment TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a JSONB; target public.forms_template;
BEGIN
  a := public.forms_live_actor('operator');
  IF p_deployment !~ '^[0-9A-HJKMNP-TV-Z]{26}$' THEN RAISE EXCEPTION 'forms_contract_invalid' USING ERRCODE='22023'; END IF;
  SELECT * INTO target FROM public.forms_template WHERE tenant_id=a->>'tenant_id' AND template_id=p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'forms_definition_unavailable' USING ERRCODE='02000'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('forms-family:' || target.tenant_id || ':' || target.program_id,0));
  SELECT * INTO target FROM public.forms_template WHERE tenant_id=a->>'tenant_id' AND template_id=p_id FOR SHARE;
  IF target.status <> 'published' OR target.deleted_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.forms_published_definition d WHERE d.tenant_id=target.tenant_id AND d.template_id=target.template_id)
  THEN RAISE EXCEPTION 'forms_definition_unavailable' USING ERRCODE='02000'; END IF;
  -- Supersession does not retire existing deployments: pinned in-progress forms
  -- remain readable until an explicit emergency retirement or archive.
  PERFORM public.forms_live_actor('operator');
  INSERT INTO public.forms_deployment(deployment_id,tenant_id,template_id,program_id,deployed_by)
  VALUES(p_deployment,target.tenant_id,target.template_id,target.program_id,a->>'account_id');
  RETURN jsonb_build_object('deployment_id',p_deployment,'template_id',p_id,'template_version',target.template_version);
END $$;
ALTER FUNCTION public.forms_deploy_consult_template(TEXT,TEXT) OWNER TO forms_publication_owner;
REVOKE ALL ON FUNCTION public.forms_deploy_consult_template(TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forms_deploy_consult_template(TEXT,TEXT) TO telecheck_app_role;

CREATE FUNCTION public.forms_retire_consult_deployment(p_id TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a JSONB; d public.forms_deployment;
BEGIN
  a:=public.forms_live_actor('operator');
  SELECT * INTO d FROM public.forms_deployment WHERE tenant_id=a->>'tenant_id' AND deployment_id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'forms_definition_unavailable' USING ERRCODE='02000'; END IF;
  PERFORM public.forms_live_actor('operator');
  UPDATE public.forms_deployment SET retired_at=COALESCE(retired_at,clock_timestamp()),updated_at=clock_timestamp() WHERE tenant_id=d.tenant_id AND deployment_id=d.deployment_id;
  RETURN jsonb_build_object('deployment_id',d.deployment_id,'template_id',d.template_id,'status','retired');
END $$;
ALTER FUNCTION public.forms_retire_consult_deployment(TEXT) OWNER TO forms_publication_owner;
REVOKE ALL ON FUNCTION public.forms_retire_consult_deployment(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forms_retire_consult_deployment(TEXT) TO telecheck_app_role;

CREATE FUNCTION public.forms_resolve_consult_definition(p_account TEXT,p_session TEXT,p_deployment TEXT,p_kind TEXT,p_program TEXT,p_existing BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a JSONB; result JSONB;
BEGIN
  a := public.forms_live_actor();
  IF a->>'account_id' IS DISTINCT FROM p_account OR a->>'session_id' IS DISTINCT FROM p_session OR a->>'actor_role' <> 'patient'
    OR p_kind NOT IN ('general_consult','program') OR (p_kind='program' AND p_program IS NULL) OR (p_existing AND p_deployment IS NULL)
  THEN RAISE EXCEPTION 'forms_scope_unavailable' USING ERRCODE='42501'; END IF;
  SELECT jsonb_build_object('template_id',t.template_id,'template_version',t.template_version,'deployment_id',d.deployment_id,'program_id',t.program_id,'country_of_care',t.country_of_care,'schema_hash',f.schema_hash,'presentation',f.presentation,'development_only',f.governance->'development_only')
  INTO result FROM public.forms_deployment d JOIN public.forms_template t ON t.tenant_id=d.tenant_id AND t.template_id=d.template_id
  JOIN public.forms_published_definition f ON f.tenant_id=t.tenant_id AND f.template_id=t.template_id
  WHERE d.tenant_id=a->>'tenant_id' AND t.country_of_care=a->>'country_of_care' AND t.deleted_at IS NULL
    AND d.retired_at IS NULL AND (t.status='published' OR (p_existing AND t.status='superseded'))
    AND (p_deployment IS NULL OR d.deployment_id=p_deployment) AND (p_program IS NULL OR t.program_id=p_program)
    AND f.presentation->>'kind'=p_kind
  ORDER BY t.template_version DESC,d.deployed_at DESC,d.deployment_id DESC LIMIT 1 FOR SHARE OF d,t;
  IF result IS NULL THEN RAISE EXCEPTION 'forms_definition_unavailable' USING ERRCODE='02000'; END IF;
  -- A table/row lock wait can outlive the session or request nonce.
  PERFORM public.forms_live_actor();
  RETURN result;
END $$;
ALTER FUNCTION public.forms_resolve_consult_definition(TEXT,TEXT,TEXT,TEXT,TEXT,BOOLEAN) OWNER TO forms_publication_owner;
REVOKE ALL ON FUNCTION public.forms_resolve_consult_definition(TEXT,TEXT,TEXT,TEXT,TEXT,BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forms_resolve_consult_definition(TEXT,TEXT,TEXT,TEXT,TEXT,BOOLEAN) TO telecheck_app_role;

CREATE FUNCTION public.forms_submit_governance_artifact(p_kind TEXT,p_template TEXT,p_content JSONB,p_development BOOLEAN) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a JSONB; t public.forms_template; content JSONB; hash TEXT; artifact UUID;
BEGIN
  a := public.forms_live_actor('operator');
  IF p_kind NOT IN ('clinical_review','marketing_copy','mode2_contract') OR p_development IS NULL OR octet_length(p_content::TEXT)>32768 THEN RAISE EXCEPTION 'forms_artifact_invalid' USING ERRCODE='22023'; END IF;
  IF p_kind='clinical_review' THEN
    SELECT * INTO t FROM public.forms_template WHERE tenant_id=a->>'tenant_id' AND template_id=p_template FOR SHARE;
    IF NOT FOUND OR t.status<>'draft' OR t.created_by<>a->>'account_id' OR (t.approval_governance->>'development_only')::BOOLEAN IS DISTINCT FROM p_development THEN RAISE EXCEPTION 'forms_artifact_unavailable' USING ERRCODE='42501'; END IF;
    hash := public.forms_template_hash(t);
    content := jsonb_build_object('template_id',t.template_id,'template_version',t.template_version,'program_id',t.program_id,'country_of_care',t.country_of_care,'schema_hash',hash,'presentation',t.presentation_content,'branching_logic',t.branching_logic,'eligibility_logic',t.eligibility_logic,'approval_governance',t.approval_governance);
  ELSE
    IF p_template IS NOT NULL THEN RAISE EXCEPTION 'forms_artifact_invalid' USING ERRCODE='22023'; END IF;
    content := p_content;
    IF p_kind='marketing_copy' THEN
      PERFORM public.forms_require_keys(content,ARRAY['text','molecule_id','country_of_care'],ARRAY['text','molecule_id','country_of_care']);
      IF NOT public.forms_safe_text(content->'text',1000) OR NOT public.forms_safe_text(content->'molecule_id',100) OR content->>'country_of_care' IS DISTINCT FROM a->>'country_of_care' THEN RAISE EXCEPTION 'forms_artifact_invalid' USING ERRCODE='22023'; END IF;
    ELSE
      PERFORM public.forms_require_keys(content,ARRAY['fields'],ARRAY['fields']);
      IF jsonb_typeof(content->'fields') IS DISTINCT FROM 'array' OR jsonb_array_length(content->'fields') NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'forms_artifact_invalid' USING ERRCODE='22023'; END IF;
    END IF;
    hash := encode(public.digest(content::TEXT,'sha256'),'hex');
  END IF;
  PERFORM public.forms_live_actor('operator');
  INSERT INTO public.forms_governance_artifact(tenant_id,kind,template_id,content,content_hash,author_id,development_only)
  VALUES(a->>'tenant_id',p_kind,p_template,content,hash,a->>'account_id',p_development) RETURNING artifact_id INTO artifact;
  RETURN jsonb_build_object('artifact_id',artifact,'content_hash',hash,'status','pending','development_only',p_development);
END $$;
ALTER FUNCTION public.forms_submit_governance_artifact(TEXT,TEXT,JSONB,BOOLEAN) OWNER TO forms_publication_owner;
REVOKE ALL ON FUNCTION public.forms_submit_governance_artifact(TEXT,TEXT,JSONB,BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forms_submit_governance_artifact(TEXT,TEXT,JSONB,BOOLEAN) TO telecheck_app_role;

CREATE FUNCTION public.forms_review_governance_artifact(p_id UUID,p_hash TEXT,p_decision TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a JSONB; r public.forms_governance_artifact; t public.forms_template;
BEGIN
  a := public.forms_live_actor();
  SELECT * INTO r FROM public.forms_governance_artifact WHERE tenant_id=a->>'tenant_id' AND artifact_id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'forms_artifact_unavailable' USING ERRCODE='02000'; END IF;
  a := public.forms_live_actor(CASE r.kind WHEN 'clinical_review' THEN 'clinical_reviewer' WHEN 'marketing_copy' THEN 'marketing_reviewer' ELSE 'mode2_reviewer' END);
  IF r.author_id=a->>'account_id' OR r.content_hash IS DISTINCT FROM p_hash OR r.status<>'pending' OR p_decision NOT IN ('approved','rejected') THEN RAISE EXCEPTION 'forms_review_invalid' USING ERRCODE='22023'; END IF;
  IF r.kind='clinical_review' THEN
    SELECT * INTO t FROM public.forms_template WHERE tenant_id=r.tenant_id AND template_id=r.template_id FOR SHARE;
    IF NOT FOUND OR t.status<>'draft' OR public.forms_template_hash(t)<>r.content_hash THEN RAISE EXCEPTION 'forms_review_stale' USING ERRCODE='22023'; END IF;
  END IF;
  PERFORM public.forms_live_actor(CASE r.kind WHEN 'clinical_review' THEN 'clinical_reviewer' WHEN 'marketing_copy' THEN 'marketing_reviewer' ELSE 'mode2_reviewer' END);
  UPDATE public.forms_governance_artifact SET status=p_decision,reviewer_id=a->>'account_id',reviewed_at=clock_timestamp() WHERE artifact_id=p_id;
  RETURN jsonb_build_object('artifact_id',p_id,'content_hash',r.content_hash,'status',p_decision,'development_only',r.development_only);
END $$;
ALTER FUNCTION public.forms_review_governance_artifact(UUID,TEXT,TEXT) OWNER TO forms_publication_owner;
REVOKE ALL ON FUNCTION public.forms_review_governance_artifact(UUID,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forms_review_governance_artifact(UUID,TEXT,TEXT) TO telecheck_app_role;

CREATE FUNCTION public.forms_read_governance_artifact(p_id UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a JSONB; r public.forms_governance_artifact;
BEGIN
  a := public.forms_live_actor();
  SELECT * INTO r FROM public.forms_governance_artifact WHERE tenant_id=a->>'tenant_id' AND artifact_id=p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'forms_artifact_unavailable' USING ERRCODE='02000'; END IF;
  IF r.author_id<>a->>'account_id' THEN PERFORM public.forms_live_actor(CASE r.kind WHEN 'clinical_review' THEN 'clinical_reviewer' WHEN 'marketing_copy' THEN 'marketing_reviewer' ELSE 'mode2_reviewer' END); END IF;
  PERFORM public.forms_live_actor();
  RETURN to_jsonb(r)-'tenant_id';
END $$;
ALTER FUNCTION public.forms_read_governance_artifact(UUID) OWNER TO forms_publication_owner;
REVOKE ALL ON FUNCTION public.forms_read_governance_artifact(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forms_read_governance_artifact(UUID) TO telecheck_app_role;
