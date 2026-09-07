# SI-026: patient care crisis admission

Engineering implementation amendment under the user's autonomous full-platform authorization. This is not clinical classifier validation, clinical protocol approval, regulatory advice, or evidence that an escalation recipient was contacted.

## Contract and precedence

Call `admitPatientCareInput({tenant, accountId, sessionId, actorNonce, idempotencyKey?}, body, source)` through the Crisis Response public interface. The trusted source is `form_response` or `messaging`. Run it after JSON parsing and authentication, before business schema, query/path, consent, form, payment and idempotency validation, in its own transaction. The normal care mutation must not proceed on any `crisis_interruption` result. Authenticated actor context is compared with the live database nonce, session, account, tenant and country before writes, after waits and before returning. No cached patient result bypasses authorization.

The HTTP parser admits at most 1 MiB. The iterative scanner examines all string **values**, including values in unknown fields, invalid business objects, arrays and deeply nested objects. It bounds total string bytes and traversal nodes; it does not scan property names or decode unsupported media. The detector remains the existing `crisisDetector` keyword engineering classifier. `no_detection` means only that this classifier found no match; it is not a clinical negative finding.

Results are discriminated:

| Result                        | Meaning                                                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `no_detection`                | Live own-patient authorization succeeded; ordinary validation may continue.                                                      |
| `recorded` / `pending`        | Canonical event, detected lifecycle, Category A audit and escalation outbox committed; actual event ID returned.                 |
| `not_recorded` / `not_queued` | Failure before possible commit; safety resources remain available when their separate lookup succeeds.                           |
| `unconfirmed` / `unconfirmed` | Failure after the commit boundary became possible; recording or queueing cannot be asserted either way. Retry the same selector. |

An authorization denial is a tenant-blind 401/403 error, not a successful interruption. Authenticated recording failures return safe resources and a bounded, process-level `crisis.admission.unavailable` operational signal without request IDs, tenant identifiers, error text, classification or clinical input. Missing country configuration is explicitly `resources.status=unavailable`; no country number or medical advice is invented.

## Truthful data model and attribution

SI-022 and the CDM v1.9-to-v1.10 amendment define six crisis types and three severity levels. The existing floor detector emits `abuse_disclosure` and `general_crisis`, which were absent from that stored vocabulary. Migration094 adds these two types verbatim. It also adds `severity=unassessed`: the keyword classifier cannot establish imminence or exclude immediate risk. Mapping to `non_imminent`, `imminent`, `life_threatening` or a different clinical category would falsely claim an assessment. Existing classifications are unchanged.

This path is attributed to the actual authenticated **patient**, with `detector_version=keyword_engineering_v1`, null AI workload/autonomy fields, and the server-selected input surface. It creates `none → detected / initial_detection`. It does not create an acknowledged, responded, resolved or delivered state. The pending `crisis.detected.v1` domain outbox contains bounded event/audit references, source, detector version and unassessed severity. It is an escalation work item, not a notification delivery ledger. The legacy `regulatory_reporting_enabled=false` records that this bounded admission has not activated automated regulatory dispatch; it does not assess reporting obligations. A future real worker needs a real service identity and configured recipients/routing before it can record actual dispatch/delivery or staff acknowledgement. No synthetic clinician or AI-service actor is created.

The new private `crisis_care_admission` table binds tenant, own patient, canonical event, source, detector version, detected type and retry selector digest. RLS is enabled and forced. Only the constrained SECURITY DEFINER owner can read/write it; the ordinary application role can acquire only the bounded public patient capability. SQL derives the patient, random event ID and random server signal; callers cannot select severity or actor. Deferred constraints require the matching same-transaction lifecycle, Category A audit and outbox, preventing a direct application-role SQL call from committing a partial record. Legacy initiation/acknowledgement/response/resolution/sweep entry points reject patient actors before replay or mutation; their private originals are not executable by application slice roles.

## Privacy and retries

The module retains **no original trigger text**, payload, body fingerprint or encrypted duplicate. Existing crisis intake envelope columns stay null. Therefore there is no new trigger-text KMS operation or plaintext clinical copy to protect. Ordinary clinical intake is not saved on interruption. If a future requirement retains trigger text, it must add an authenticated `pii_sensitive_clinical` envelope with an exact server-owned resource/field binding; the legacy UUID envelope is not sufficient proof of classified KMS compatibility.

The SHA-256 digest is of the optional transport idempotency selector only. It is never a hash of the clinical body or trigger text. Deduplication scopes it to tenant, patient, source and actual detected category. Concurrent identical retries commit one event/audit/outbox. Reusing a selector with a different detected category creates another event rather than suppressing the new category. A changed body with the same category and selector is the same safety operation; this API does not certify body equivalence. With no selector, each call is a distinct detection and no cross-request deduplication is claimed.

## Validation and rollback

`scripts/verify-patient-crisis-admission.mjs` uses real loopback HTTP against a clearly synthetic ingress harness, real Identity email registration, ordinary application login and separate bind/Identity logins. The harness invokes the public API before an intentionally invalid business validator. It checks both US and Ghana, actual persisted event/lifecycle/audit/outbox metadata, four concurrent retries, other-patient and tenant isolation, private SQL denial, legacy patient denial, missing SQL evidence, outbox-failure rollback with resources, revoked-session replay, and nonce expiry/session expiry/account suspension while admission waits on a database lock. It does not mount a production test route. The root care integration separately verifies the real production intake route and encrypted ordinary care workflow.

The colocated tests cover all five detector classifications, unknown/deep/late-admitted strings, no-detection live checks, no input in SQL/audit/outbox arguments, resources lookup failure, failed outbox, uncertain commit and identity mismatch. Full PostgreSQL tests, RLS inventory, migration apply/replay and build checks complement this evidence.

Rollback094 revokes the new patient capability and preserves all immutable clinical/audit/outbox/retry evidence and the vocabulary needed to interpret it. It retains the legacy patient anti-bypass wrappers. Do not remove the enum values, erase event rows or restore weaker patient writers after any committed admission. Re-enable deliberately with reviewed grants; an already-applied migration replay is not an activation toggle.

References: I-019 floor detection, I-003/I-027 audit, I-023/I-025 tenant isolation, SI-022 crisis lifecycle, CDM v1.9-to-v1.10 amendment, migrations033/035/036/053/054, and the current classified KMS086 live-actor trust anchor. Canonical corpus reconciliation and clinical/language efficacy validation remain separate work.
