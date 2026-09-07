-- A populated deployment requires a reviewed forward correction: policy approval,
-- version mappings and declined choices are evidence beyond canonical grants.
SET LOCAL search_path = pg_catalog, public, pg_temp;
DO $rollback_guard$
BEGIN
  LOCK TABLE public.consent_care_membership, public.consent_care_policy,
    public.consent_care_policy_term, public.consent_care_decision IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.consent_care_membership)
    OR EXISTS (SELECT 1 FROM public.consent_care_policy)
    OR EXISTS (SELECT 1 FROM public.consent_care_policy_term)
    OR EXISTS (SELECT 1 FROM public.consent_care_decision) THEN
    RAISE EXCEPTION 'consent_rollback_requires_reviewed_forward_migration'
      USING ERRCODE = '0A000';
  END IF;
END
$rollback_guard$;
DROP FUNCTION public.consent_care_withdraw_policy(TEXT,TEXT);
DROP FUNCTION public.consent_care_status(TEXT);
DROP FUNCTION IF EXISTS public.consent_care_decision_detail(TEXT);
DROP FUNCTION public.consent_care_withdraw(TEXT,TEXT,TEXT);
DROP FUNCTION public.consent_care_history(INTEGER);
DROP TRIGGER consent_care_choice_evidence ON public.consent_care_decision;
DROP FUNCTION public.consent_care_require_choice_evidence();
DROP FUNCTION public.consent_care_record_choices(TEXT,TEXT,TEXT,JSONB,JSONB);
DROP FUNCTION public.consent_care_latest_choice(TEXT,TEXT,TEXT);
DROP FUNCTION public.consent_care_resolve_policy(TEXT);
DROP TRIGGER consent_care_policy_evidence ON public.consent_care_policy;
DROP FUNCTION public.consent_care_require_policy_evidence();
DROP FUNCTION public.consent_care_current_write(XID);
DROP FUNCTION public.consent_care_get_policy(TEXT);
DROP FUNCTION public.consent_care_publish_policy(TEXT,TEXT,JSONB);
DROP FUNCTION public.consent_care_create_policy(TEXT,JSONB,TEXT);
DROP FUNCTION public.consent_care_validate_policy(JSONB);
DROP FUNCTION public.consent_care_safe_text(JSONB,INTEGER);
DROP FUNCTION public.consent_care_check_keys(JSONB,TEXT[]);
DROP FUNCTION public.consent_care_canonical_json(JSONB);
DROP TRIGGER consent_care_policy_immutable ON public.consent_care_policy;
DROP FUNCTION public.consent_care_policy_immutable();
DROP FUNCTION public.consent_care_live_actor(TEXT);
DROP TABLE public.consent_care_decision;
DROP TABLE public.consent_care_policy_term;
DROP TABLE public.consent_care_policy;
DROP TABLE public.consent_care_membership;
REVOKE consent_care_patient, consent_care_operator FROM telecheck_app_role;
REVOKE ALL ON public.consent, public.consent_versions FROM consent_care_owner;
REVOKE ALL ON public.audit_records,public.domain_events_outbox FROM consent_care_owner;
REVOKE SELECT (tenant_id,config_key,config_value),UPDATE(config_value) ON public.ccr_configs FROM consent_care_owner;
REVOKE SELECT (country,default_locale) ON public.country_profiles FROM consent_care_owner;
REVOKE SELECT (account_id,tenant_id,country_of_care) ON public.accounts FROM consent_care_owner;
REVOKE EXECUTE ON FUNCTION public.current_tenant_id(),public.kms_current_actor_context() FROM consent_care_owner;
REVOKE USAGE ON SCHEMA public FROM consent_care_owner,consent_care_patient,consent_care_operator;
DROP ROLE consent_care_patient;
DROP ROLE consent_care_operator;
DROP ROLE consent_care_owner;
