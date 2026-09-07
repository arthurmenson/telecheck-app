-- One publication boundary for Forms and SI-023. No application DML grant.
SET LOCAL search_path = pg_catalog, public, pg_temp;
CREATE ROLE forms_publication_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT USAGE ON SCHEMA public TO forms_publication_owner;
GRANT EXECUTE ON FUNCTION public.current_tenant_id(), public.kms_current_actor_context() TO forms_publication_owner;
GRANT SELECT, INSERT, UPDATE ON public.forms_template, public.forms_deployment TO forms_publication_owner;
GRANT SELECT (tenant_id,account_id,status,account_type,deleted_at) ON public.accounts TO forms_publication_owner;

CREATE TABLE public.forms_governance_membership (
  tenant_id VARCHAR(26) NOT NULL REFERENCES public.tenants(id),
  account_id VARCHAR(26) NOT NULL,
  capability TEXT NOT NULL CHECK (capability IN ('operator','reviewer','clinical_reviewer','marketing_reviewer','mode2_reviewer')),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, account_id, capability),
  FOREIGN KEY (tenant_id, account_id) REFERENCES public.accounts(tenant_id, account_id)
);
CREATE TABLE public.forms_governance_artifact (
  artifact_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(26) NOT NULL REFERENCES public.tenants(id),
  kind TEXT NOT NULL CHECK (kind IN ('clinical_review','marketing_copy','mode2_contract')),
  template_id VARCHAR(26),
  content JSONB NOT NULL,
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  author_id VARCHAR(26) NOT NULL,
  reviewer_id VARCHAR(26),
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','withdrawn')) DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  reviewed_at TIMESTAMPTZ,
  development_only BOOLEAN NOT NULL,
  UNIQUE (tenant_id, artifact_id),
  FOREIGN KEY (tenant_id, template_id) REFERENCES public.forms_template(tenant_id, template_id),
  FOREIGN KEY (tenant_id, author_id) REFERENCES public.accounts(tenant_id, account_id),
  FOREIGN KEY (tenant_id, reviewer_id) REFERENCES public.accounts(tenant_id, account_id),
  CHECK (reviewer_id IS NULL OR reviewer_id <> author_id),
  CHECK ((status = 'pending') = (reviewer_id IS NULL))
);
CREATE TABLE public.forms_published_definition (
  tenant_id VARCHAR(26) NOT NULL,
  template_id VARCHAR(26) NOT NULL,
  template_version INTEGER NOT NULL,
  schema_hash TEXT NOT NULL CHECK (schema_hash ~ '^[a-f0-9]{64}$'),
  presentation JSONB NOT NULL,
  governance JSONB NOT NULL,
  published_by VARCHAR(26) NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, template_id),
  FOREIGN KEY (tenant_id, template_id) REFERENCES public.forms_template(tenant_id, template_id)
);
ALTER TABLE public.forms_governance_membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forms_governance_membership FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.forms_governance_membership USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id());
ALTER TABLE public.forms_governance_artifact ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forms_governance_artifact FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.forms_governance_artifact USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id());
ALTER TABLE public.forms_published_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forms_published_definition FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.forms_published_definition USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id());
GRANT SELECT ON public.forms_governance_membership TO forms_publication_owner;
GRANT SELECT, INSERT, UPDATE ON public.forms_governance_artifact TO forms_publication_owner;
GRANT SELECT, INSERT ON public.forms_published_definition TO forms_publication_owner;
REVOKE ALL ON public.forms_governance_membership, public.forms_governance_artifact, public.forms_published_definition FROM PUBLIC, telecheck_app_role;

CREATE FUNCTION public.forms_live_actor(p_capability TEXT DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a RECORD;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'forms_auth_unavailable' USING ERRCODE = '42501';
  END IF;
  -- Take the capability relation lock before resolving identity. Otherwise a
  -- membership read could block after KMS checked session/nonce expiry.
  IF p_capability IS NOT NULL THEN LOCK TABLE public.forms_governance_membership IN ACCESS SHARE MODE; END IF;
  BEGIN SELECT * INTO STRICT a FROM public.kms_current_actor_context();
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'forms_auth_unavailable' USING ERRCODE = '42501'; END;
  IF p_capability='clinical_reviewer' AND a.actor_role<>'clinician' THEN RAISE EXCEPTION 'forms_scope_unavailable' USING ERRCODE='42501'; END IF;
  IF p_capability IS NOT NULL AND (a.actor_role NOT IN ('tenant_admin','clinician') OR NOT EXISTS (
    SELECT 1 FROM public.forms_governance_membership m WHERE m.tenant_id = a.tenant_id
    AND m.account_id = a.account_id AND m.capability = p_capability AND m.revoked_at IS NULL
  )) THEN RAISE EXCEPTION 'forms_scope_unavailable' USING ERRCODE = '42501'; END IF;
  -- The first identity read and membership lookup hold their relation locks.
  -- Refresh wall-clock identity after the capability read before returning it.
  IF p_capability IS NOT NULL THEN
    BEGIN SELECT * INTO STRICT a FROM public.kms_current_actor_context();
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'forms_auth_unavailable' USING ERRCODE = '42501'; END;
  END IF;
  RETURN jsonb_build_object('tenant_id',a.tenant_id,'account_id',a.account_id,'session_id',a.session_id,'actor_role',a.actor_role,'country_of_care',a.country_of_care);
END $$;
ALTER FUNCTION public.forms_live_actor(TEXT) OWNER TO forms_publication_owner;
REVOKE ALL ON FUNCTION public.forms_live_actor(TEXT) FROM PUBLIC;

CREATE FUNCTION public.forms_require_keys(v JSONB, allowed TEXT[], required TEXT[]) RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT (v ?& required) OR EXISTS (
    SELECT 1 FROM jsonb_object_keys(v) k WHERE NOT (k = ANY(allowed))
  ) OR EXISTS (SELECT 1 FROM jsonb_each(v) e WHERE e.value='null'::JSONB
  ) THEN RAISE EXCEPTION 'forms_contract_invalid' USING ERRCODE = '22023'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.forms_require_keys(JSONB,TEXT[],TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forms_require_keys(JSONB,TEXT[],TEXT[]) TO forms_publication_owner;

CREATE FUNCTION public.forms_safe_text(v JSONB, max_length INTEGER) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  -- Match JavaScript/Zod UTF-16 bounds: a supplementary code point uses two units.
  SELECT jsonb_typeof(v) = 'string'
    AND length(v #>> '{}') + regexp_count(v #>> '{}', U&'[\+010000-\+10FFFF]') BETWEEN 1 AND max_length
    AND (v #>> '{}') !~ '[<>\x00-\x08\x0B\x0C\x0E-\x1F]'
$$;
REVOKE ALL ON FUNCTION public.forms_safe_text(JSONB,INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forms_safe_text(JSONB,INTEGER) TO forms_publication_owner;

CREATE FUNCTION public.forms_validate_presentation(p JSONB, country TEXT) RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE f JSONB; o JSONB; prior JSONB := '{}'::JSONB; source JSONB; opt_values TEXT[]; keys TEXT[];
BEGIN
  IF octet_length(p::TEXT) > 65536 THEN RAISE EXCEPTION 'forms_contract_invalid' USING ERRCODE = '22023'; END IF;
  PERFORM public.forms_require_keys(p,ARRAY['contract_version','kind','locale','title','description','fields','elements'],ARRAY['contract_version','kind','locale','title','fields','elements']);
  IF p->>'contract_version' IS DISTINCT FROM 'consult_intake_v1' OR p->>'kind' NOT IN ('general_consult','program')
    OR p->>'locale' IS DISTINCT FROM ('en-' || country) OR NOT public.forms_safe_text(p->'title',200)
    OR (p ? 'description' AND NOT public.forms_safe_text(p->'description',1000))
    OR jsonb_typeof(p->'fields') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'fields') NOT BETWEEN 1 AND 64
    OR jsonb_typeof(p->'elements') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'elements') > 16
  THEN RAISE EXCEPTION 'forms_contract_invalid' USING ERRCODE = '22023'; END IF;
  FOR f IN SELECT * FROM jsonb_array_elements(p->'fields') LOOP
    keys := ARRAY['id','type','label','help_text','required','visible_when'];
    IF f->>'type' = 'text' THEN keys := keys || ARRAY['max_length'];
    ELSIF f->>'type' = 'number' THEN keys := keys || ARRAY['min','max'];
    ELSIF f->>'type' = 'select' THEN keys := keys || ARRAY['options'];
    ELSIF f->>'type' = 'multiselect' THEN keys := keys || ARRAY['options','max_selections'];
    ELSIF f->>'type' IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'forms_contract_invalid' USING ERRCODE = '22023'; END IF;
    PERFORM public.forms_require_keys(f,keys,ARRAY['id','type','label','required']);
    IF f->>'id' !~ '^[a-z][a-z0-9_]{0,63}$' OR f->>'id' ~* 'research|consent' OR prior ? (f->>'id')
      OR NOT public.forms_safe_text(f->'label',200) OR (f ? 'help_text' AND NOT public.forms_safe_text(f->'help_text',500))
      OR jsonb_typeof(f->'required') IS DISTINCT FROM 'boolean'
    THEN RAISE EXCEPTION 'forms_contract_invalid' USING ERRCODE = '22023'; END IF;
    IF f->>'type' = 'text' AND (jsonb_typeof(f->'max_length') IS DISTINCT FROM 'number' OR (f->>'max_length') !~ '^[0-9]+$' OR (f->>'max_length')::NUMERIC NOT BETWEEN 1 AND 4000)
    THEN RAISE EXCEPTION 'forms_contract_invalid' USING ERRCODE = '22023'; END IF;
    IF f->>'type' = 'number' AND (jsonb_typeof(f->'min') IS DISTINCT FROM 'number' OR jsonb_typeof(f->'max') IS DISTINCT FROM 'number' OR (f->>'min')::NUMERIC > (f->>'max')::NUMERIC OR abs((f->>'min')::NUMERIC) > 1e15 OR abs((f->>'max')::NUMERIC) > 1e15)
    THEN RAISE EXCEPTION 'forms_contract_invalid' USING ERRCODE = '22023'; END IF;
    IF f->>'type' IN ('select','multiselect') THEN
      IF jsonb_typeof(f->'options') IS DISTINCT FROM 'array' OR jsonb_array_length(f->'options') NOT BETWEEN 2 AND 32 THEN RAISE EXCEPTION 'forms_contract_invalid' USING ERRCODE = '22023'; END IF;
      opt_values := ARRAY[]::TEXT[];
      FOR o IN SELECT * FROM jsonb_array_elements(f->'options') LOOP
        PERFORM public.forms_require_keys(o,ARRAY['value','label'],ARRAY['value','label']);
        IF o->>'value' !~ '^[a-z][a-z0-9_]{0,63}$' OR o->>'value' = ANY(opt_values) OR NOT public.forms_safe_text(o->'label',100)
        THEN RAISE EXCEPTION 'forms_contract_invalid' USING ERRCODE = '22023'; END IF;
        opt_values := array_append(opt_values,o->>'value');
      END LOOP;
      IF f->>'type' = 'multiselect' AND (jsonb_typeof(f->'max_selections') IS DISTINCT FROM 'number' OR (f->>'max_selections') !~ '^[0-9]+$' OR (f->>'max_selections')::NUMERIC NOT BETWEEN 1 AND jsonb_array_length(f->'options'))
      THEN RAISE EXCEPTION 'forms_contract_invalid' USING ERRCODE = '22023'; END IF;
    END IF;
    IF f ? 'visible_when' THEN
      PERFORM public.forms_require_keys(f->'visible_when',ARRAY['field_id','equals'],ARRAY['field_id','equals']);
      source := prior->(f->'visible_when'->>'field_id');
      IF source IS NULL OR source ? 'visible_when' OR NOT (
        (source->>'type' = 'boolean' AND jsonb_typeof(f->'visible_when'->'equals') = 'boolean') OR
        (source->>'type' = 'select' AND EXISTS (SELECT 1 FROM jsonb_array_elements(source->'options') x WHERE x->'value' = f->'visible_when'->'equals'))
      ) THEN RAISE EXCEPTION 'forms_contract_invalid' USING ERRCODE = '22023'; END IF;
    END IF;
    prior := prior || jsonb_build_object(f->>'id',f);
  END LOOP;
  FOR o IN SELECT * FROM jsonb_array_elements(p->'elements') LOOP
    IF o->>'copy_classification' = 'program_level' THEN
      PERFORM public.forms_require_keys(o,ARRAY['copy_classification','text'],ARRAY['copy_classification','text']);
      IF NOT public.forms_safe_text(o->'text',1000) THEN RAISE EXCEPTION 'forms_contract_invalid' USING ERRCODE = '22023'; END IF;
    ELSIF o->>'copy_classification' = 'molecule_level' THEN
      PERFORM public.forms_require_keys(o,ARRAY['copy_classification','marketing_copy_id','content_hash'],ARRAY['copy_classification','marketing_copy_id','content_hash']);
      IF o->>'marketing_copy_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR o->>'content_hash' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'forms_contract_invalid' USING ERRCODE = '22023'; END IF;
    ELSE RAISE EXCEPTION 'forms_contract_invalid' USING ERRCODE = '22023'; END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.forms_validate_presentation(JSONB,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forms_validate_presentation(JSONB,TEXT) TO forms_publication_owner;

CREATE FUNCTION public.forms_template_hash(t public.forms_template) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT encode(public.digest(jsonb_build_object('tenant_id',t.tenant_id,'template_id',t.template_id,'template_version',t.template_version,'program_id',t.program_id,'country_of_care',t.country_of_care,'author',t.created_by,'presentation',t.presentation_content,'branching',t.branching_logic,'eligibility',t.eligibility_logic,'governance',t.approval_governance)::TEXT,'sha256'),'hex')
$$;
REVOKE ALL ON FUNCTION public.forms_template_hash(public.forms_template) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.forms_template_hash(public.forms_template) TO forms_publication_owner;

CREATE FUNCTION public.forms_enforce_publication() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a JSONB; hash TEXT; g JSONB; el JSONB; artifact public.forms_governance_artifact; l3 JSONB; rule JSONB; field JSONB;
BEGIN
  IF OLD.status <> 'draft' AND (
    NEW.presentation_content IS DISTINCT FROM OLD.presentation_content OR NEW.branching_logic IS DISTINCT FROM OLD.branching_logic
    OR NEW.eligibility_logic IS DISTINCT FROM OLD.eligibility_logic OR NEW.approval_governance IS DISTINCT FROM OLD.approval_governance
    OR NEW.program_id IS DISTINCT FROM OLD.program_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.template_id IS DISTINCT FROM OLD.template_id OR NEW.template_version IS DISTINCT FROM OLD.template_version
    OR NEW.country_of_care IS DISTINCT FROM OLD.country_of_care OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.status = 'draft'
  ) THEN RAISE EXCEPTION 'forms_published_immutable' USING ERRCODE = '22023'; END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status <> 'published' THEN RETURN NEW; END IF;
  IF OLD.status <> 'draft' OR OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'forms_version_not_draft' USING ERRCODE = '22023'; END IF;
  a := public.forms_live_actor('reviewer');
  IF a->>'tenant_id' IS DISTINCT FROM NEW.tenant_id OR a->>'country_of_care' IS DISTINCT FROM NEW.country_of_care THEN RAISE EXCEPTION 'forms_scope_unavailable' USING ERRCODE = '42501'; END IF;
  -- Every care-affecting construct is either explicitly typed below or rejected.
  -- All six I-030 categories therefore have no external research-state dependency.
  IF lower(jsonb_build_array(NEW.presentation_content,NEW.branching_logic,NEW.eligibility_logic,NEW.approval_governance)::TEXT) ~ 'research[_ .-]*consent|research[_ .-]*status' THEN RAISE EXCEPTION 'forms_research_dependency' USING ERRCODE = '22023'; END IF;
  PERFORM public.forms_validate_presentation(NEW.presentation_content,NEW.country_of_care);
  IF NEW.branching_logic NOT IN ('{}'::JSONB,'{"rules":[],"computed_fields":[]}'::JSONB) THEN RAISE EXCEPTION 'forms_unsupported_branching' USING ERRCODE = '22023'; END IF;
  g := NEW.approval_governance;
  PERFORM public.forms_require_keys(g,ARRAY['mode','mode2_contract_id','mode2_contract_hash','development_only'],ARRAY['mode','development_only']);
  IF jsonb_typeof(g->'development_only') IS DISTINCT FROM 'boolean' OR g->>'mode' NOT IN ('mode1','mode2') THEN RAISE EXCEPTION 'forms_governance_invalid' USING ERRCODE = '22023'; END IF;
  IF NEW.presentation_content->>'kind' = 'general_consult' AND (
    NEW.eligibility_logic NOT IN ('{}'::JSONB,'{"eligibility_rules":[],"contraindications":[]}'::JSONB)
    OR g->>'mode' <> 'mode1' OR jsonb_array_length(NEW.presentation_content->'elements') <> 0
  ) THEN RAISE EXCEPTION 'forms_general_contract_invalid' USING ERRCODE = '22023'; END IF;
  hash := public.forms_template_hash(NEW);
  IF NEW.eligibility_logic NOT IN ('{}'::JSONB,'{"eligibility_rules":[],"contraindications":[]}'::JSONB) THEN
    l3 := NEW.eligibility_logic;
    PERFORM public.forms_require_keys(l3,ARRAY['eligibility_rules','contraindications'],ARRAY['eligibility_rules','contraindications']);
    IF l3->'contraindications' <> '[]'::JSONB OR jsonb_typeof(l3->'eligibility_rules') IS DISTINCT FROM 'array' OR jsonb_array_length(l3->'eligibility_rules') NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'forms_eligibility_invalid' USING ERRCODE = '22023'; END IF;
    FOR rule IN SELECT * FROM jsonb_array_elements(l3->'eligibility_rules') LOOP
      PERFORM public.forms_require_keys(rule,ARRAY['field_id','operator','value','outcome'],ARRAY['field_id','operator','value','outcome']);
      SELECT f INTO field FROM jsonb_array_elements(NEW.presentation_content->'fields') f WHERE f->>'id' = rule->>'field_id';
      IF field IS NULL OR rule->>'outcome' IS DISTINCT FROM 'clinical_review_required' OR rule->>'operator' NOT IN ('equals','lt','gt')
        OR (rule->>'operator' IN ('lt','gt') AND (field->>'type' <> 'number' OR jsonb_typeof(rule->'value') <> 'number'))
      THEN RAISE EXCEPTION 'forms_eligibility_invalid' USING ERRCODE = '22023'; END IF;
      IF rule->>'operator'='equals' AND NOT (
        (field->>'type'='text' AND public.forms_safe_text(rule->'value',(field->>'max_length')::INTEGER)) OR
        (field->>'type'='boolean' AND jsonb_typeof(rule->'value')='boolean') OR
        (field->>'type'='number' AND jsonb_typeof(rule->'value')='number') OR
        (field->>'type'='select' AND EXISTS(SELECT 1 FROM jsonb_array_elements(field->'options') o WHERE o->'value'=rule->'value'))
      ) THEN RAISE EXCEPTION 'forms_eligibility_invalid' USING ERRCODE='22023'; END IF;
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM public.forms_governance_artifact r JOIN public.forms_governance_membership m ON m.tenant_id=r.tenant_id AND m.account_id=r.reviewer_id AND m.capability='clinical_reviewer' AND m.revoked_at IS NULL
      JOIN public.accounts approver ON approver.tenant_id=r.tenant_id AND approver.account_id=r.reviewer_id AND approver.account_type='clinician' AND approver.status='active' AND approver.deleted_at IS NULL
      WHERE r.tenant_id=NEW.tenant_id AND r.template_id=NEW.template_id AND r.kind='clinical_review' AND r.status='approved'
      AND r.content_hash=hash AND r.author_id=NEW.created_by AND r.reviewer_id<>NEW.created_by AND r.development_only=(g->>'development_only')::BOOLEAN)
    THEN RAISE EXCEPTION 'forms_independent_clinical_approval_required' USING ERRCODE = '22023'; END IF;
  END IF;
  FOR el IN SELECT * FROM jsonb_array_elements(NEW.presentation_content->'elements') LOOP
    IF el->>'copy_classification' = 'molecule_level' THEN
      SELECT r.* INTO artifact FROM public.forms_governance_artifact r JOIN public.forms_governance_membership m ON m.tenant_id=r.tenant_id AND m.account_id=r.reviewer_id AND m.capability='marketing_reviewer' AND m.revoked_at IS NULL
      JOIN public.accounts approver ON approver.tenant_id=r.tenant_id AND approver.account_id=r.reviewer_id AND approver.account_type IN ('tenant_admin','clinician') AND approver.status='active' AND approver.deleted_at IS NULL
      WHERE r.tenant_id=NEW.tenant_id AND r.artifact_id=(el->>'marketing_copy_id')::UUID AND r.kind='marketing_copy' AND r.status='approved' AND r.content_hash=el->>'content_hash' AND r.content->>'country_of_care'=NEW.country_of_care AND (NOT r.development_only OR (g->>'development_only')::BOOLEAN);
      IF NOT FOUND THEN RAISE EXCEPTION 'forms_approved_marketing_copy_required' USING ERRCODE = '22023'; END IF;
    END IF;
  END LOOP;
  IF g->>'mode' = 'mode1' THEN
    IF g ? 'mode2_contract_id' OR g ? 'mode2_contract_hash' THEN RAISE EXCEPTION 'forms_mode2_contract_invalid' USING ERRCODE = '22023'; END IF;
  ELSE
    IF NOT(g ?& ARRAY['mode2_contract_id','mode2_contract_hash']) OR g->>'mode2_contract_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR g->>'mode2_contract_hash' !~ '^[a-f0-9]{64}$'
    THEN RAISE EXCEPTION 'forms_mode2_contract_invalid' USING ERRCODE='22023'; END IF;
    SELECT r.* INTO artifact FROM public.forms_governance_artifact r JOIN public.forms_governance_membership m ON m.tenant_id=r.tenant_id AND m.account_id=r.reviewer_id AND m.capability='mode2_reviewer' AND m.revoked_at IS NULL
    JOIN public.accounts approver ON approver.tenant_id=r.tenant_id AND approver.account_id=r.reviewer_id AND approver.account_type IN ('tenant_admin','clinician') AND approver.status='active' AND approver.deleted_at IS NULL
    WHERE r.tenant_id=NEW.tenant_id AND r.artifact_id=(g->>'mode2_contract_id')::UUID AND r.kind='mode2_contract' AND r.status='approved' AND r.content_hash=g->>'mode2_contract_hash' AND (NOT r.development_only OR (g->>'development_only')::BOOLEAN);
    IF NOT FOUND OR artifact.content->'fields' IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_object('id',f->'id','type',f->'type','required',f->'required') ORDER BY f->>'id') FROM jsonb_array_elements(NEW.presentation_content->'fields') f)
    THEN RAISE EXCEPTION 'forms_mode2_contract_invalid' USING ERRCODE = '22023'; END IF;
  END IF;
  PERFORM public.forms_live_actor('reviewer');
  INSERT INTO public.forms_published_definition(tenant_id,template_id,template_version,schema_hash,presentation,governance,published_by)
    VALUES(NEW.tenant_id,NEW.template_id,NEW.template_version,hash,NEW.presentation_content,g,a->>'account_id');
  PERFORM public.forms_live_actor('reviewer');
  NEW.research_consent_static_analysis_status := 'pass';
  NEW.published_at := clock_timestamp();
  RETURN NEW;
END $$;
ALTER FUNCTION public.forms_enforce_publication() OWNER TO forms_publication_owner;
REVOKE ALL ON FUNCTION public.forms_enforce_publication() FROM PUBLIC;
CREATE TRIGGER forms_publication_boundary BEFORE UPDATE ON public.forms_template FOR EACH ROW EXECUTE FUNCTION public.forms_enforce_publication();

CREATE FUNCTION public.forms_published_definition_immutable() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RAISE EXCEPTION 'forms_definition_immutable' USING ERRCODE='42501'; END $$;
REVOKE ALL ON FUNCTION public.forms_published_definition_immutable() FROM PUBLIC;
CREATE TRIGGER forms_definition_immutable BEFORE UPDATE OR DELETE ON public.forms_published_definition FOR EACH ROW EXECUTE FUNCTION public.forms_published_definition_immutable();
