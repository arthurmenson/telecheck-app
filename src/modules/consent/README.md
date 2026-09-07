# Consent and delegated access

The versioned care-consent path publishes independently reviewed terms, records explicit choices with server-generated evidence, and exposes private history, exact historical terms and withdrawal. See [CARE_CONSENT.md](../../../docs/CARE_CONSENT.md) for the API, controls and acceptance procedure.

The three older consent routes (`POST /consents`, `POST /consents/revoke`, `GET /consents/me`) return authenticated `410 consent.versioned_policy_required`. They no longer accept client-authored evidence or expose unbounded history. Legacy internal services remain for existing callers; they do not prove acceptance of the current reviewed policy.

Migration 093 owns policy, term mapping, decision and operator-capability tables with forced tenant RLS. Narrow patient/operator roles cannot access raw tables or assume the private owner. Canonical consent and version records remain append-only.

Existing delegation invite, accept, decline, revoke, list and scope routes retain earlier regression coverage. The new patient-only flow does not claim a completed caregiver journey or authorize delegate access.

Publication is a software control, not proof of clinical or legal approval. Account closure, registration-time platform terms, clinical/worker integration, full delegation and data-rights journeys, administration/configuration activation and production acceptance remain separate platform work. Route presence does not establish full-module completion.

## Spec references

- ADR-001 (modular monolith)
- ADR-023 (multi-tenancy Model A)
- ADR-028 (research data partnership Posture A — adds 5th `research_data_use` consent tier; gated by I-029)
- Consent + Delegated Access Slice PRD v1.0
- Canonical Data Model v1.2 §3 entities #11 (Consent) + #12 (ConsentVersion) + #13 (Delegation) + #14 (DelegationScope)
- State Machines v1.1 §2 (consent lifecycle) + §4 (delegation lifecycle)
- Contracts Pack v5.2 INVARIANTS (I-003 audit append-only, I-023 / I-024 / I-025 / I-027 tenant isolation), AUDIT_EVENTS, DOMAIN_EVENTS, IDEMPOTENCY (v5.1), GLOSSARY
- Tenant Threading Addendum v1.0 §3.X (consent slice)
