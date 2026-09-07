# Published consultation intake

The Forms public boundary supplies an immutable, authenticated intake definition to the care owner. It validates answers in memory. It does not create a second plaintext `forms_submission`, record clinical answers in audit events, or encrypt/store the care owner's record.

## Public integration

`resolveConsultIntakeDefinition(tx, context, selection)` resolves the latest deployed, published template for the authenticated patient's tenant, country and intake kind. `context` contains the verified account, session and request nonce. Its return value contains `template_id`, `template_version`, `deployment_id`, `program_id`, `country_of_care`, `schema_hash`, `development_only`, and `presentation`.

Forms uses the existing tenant/actor context helpers, which clear their bindings on unwind. A nested call does not preserve the caller's outer SQL tenant/nonce settings. Explicitly rebind the trusted context before each following care-owner or KMS operation. The supplied transaction itself remains open, and its row locks remain held.

Persist that binding with the encrypted care record. On draft update or submission, call `validateConsultIntake(tx, context, persistedBinding, kind, answers, 'draft' | 'submit')`. The function re-resolves the exact deployment and compares template, version and schema hash. It returns the definition and validated answers without persistence. The care owner must perform its own ownership check, canonical byte bound, encryption, transaction audit and outbox work. A server-persisted binding may continue using a superseded version until its deployment is retired or its template is archived/deleted. Missing or changed pinned definitions raise `forms.definition_restart_required` (409); a caller cannot select an old version with a request-body flag.

The schema hash covers tenant, template identity/version, program, country, author and all four template layers. Published layers and the published snapshot are immutable. The SQL resolver locks the selected deployment and template until its transaction finishes, then rechecks live authentication after any wait. Retiring a deployment therefore serializes with use of that definition.

Forms does not resolve or grant care/jurisdictional consent. That remains the Consent module's authority. A research opt-in is not an intake field or a condition for care.

## Closed render contract

`consult_intake_v1` supports English US/Ghana presentations, 1–64 uniquely named fields, and text, boolean, number, select and multiselect types. Every type has explicit bounds. Conditions can depend only on an earlier, unconditional boolean or select field; arbitrary expressions, computed fields, unknown keys and cycles are rejected. Fields cannot use research/consent identifiers. A submission requires every visible required answer; a draft can be incomplete but must still satisfy types and bounds. Unknown fields and stale hidden answers fail validation. `false` and `0` are valid supplied values, not missing answers.

Text answers are limited to 4,000 UTF-16 code units per field and 16,000 aggregate string code units including selections. The care owner additionally enforces its canonical JSON UTF-8 byte limit before encryption. Object values, unsupported numeric values, unrecognized options, duplicate multiselect values and control characters fail validation.

The initial `general_consult` presentation has no marketing elements, no Layer 3 eligibility rules and Mode 1 governance. This is a positively validated restricted contract; none of the publication gates can be disabled with an environment variable.

## Publication and review

Both the Forms publish endpoints and SI-023 administrator approval call the same SQL publication operation. Migration 090's trigger rejects a draft-to-published update that fails any gate, including an update attempted through another privileged wrapper:

1. **I-030 independence:** all six care-affecting categories are restricted to the closed local grammar. Unsupported branches/computations and research-state references in any layer fail closed. This is a restricted-language implementation, not a general expression analyzer.
2. **Approved marketing copy:** molecule-level elements contain an approved same-tenant artifact ID and exact content hash. Approval requires a different authenticated reviewer with explicit marketing-review membership. Publication rechecks the reviewer's active, undeleted account, current `tenant_admin` or `clinician` account type, membership and country. Historical reviewer sessions do not need to remain open. General consultation admits no elements.
3. **Mode 2 contract:** Mode 2 requires an approved artifact whose ordered field ID/type/required contract exactly matches the proposed presentation. Publication rechecks active membership and the reviewer's current active, undeleted staff account (`tenant_admin` or `clinician`). Missing, pending, malformed and mismatched references fail closed. General consultation admits only Mode 1.
4. **Layer 3 clinical approval:** the only admitted nonempty rules flag `clinical_review_required`; they cannot automatically approve treatment. Publication requires an independent clinician's approval of the exact full-template hash, including all four layers. The reviewer must still have active clinical-review membership and an active clinician account. Editing any covered draft content invalidates the earlier approval. General consultation admits no Layer 3 rules.

The artifact review endpoint exposes the actual immutable submitted content for inspection and requires its exact hash in the decision. No generated approval, default reviewer or production approval seed is provided. Synthetic acceptance accounts and artifacts are explicitly development-only. Production API creation and definition resolution reject development-only artifacts/templates. Qualified reviewer assignment and actual clinical/content decisions remain human operational responsibilities; successful engineering tests do not constitute those approvals.

Explicit `forms_governance_membership` capabilities are `operator`, `reviewer`, `clinical_reviewer`, `marketing_reviewer`, and `mode2_reviewer`. Provision/revoke memberships through the authorized database administration process after verifying the staff role and qualification. The ordinary application role cannot grant itself memberships, access the private artifact/snapshot tables, or assume the publication owner. Membership alone is insufficient: every operation also checks the live account, session, tenant and binder-issued nonce. A clinical reviewer must be a clinician account. Existing generic tenant-admin role claims do not imply these new capabilities.

Authenticated endpoints (all mutations require an idempotency key):

| Endpoint                                                   | Purpose / capability                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| `POST /v0/forms/consult-templates`                         | Create a draft and assign its family version / operator                   |
| `POST /v0/forms/consult-templates/:templateId/publish`     | Publish with all four gates / reviewer                                    |
| `POST /v0/forms/consult-templates/:templateId/deploy`      | Deploy a published definition / operator                                  |
| `POST /v0/forms/consult-deployments/:deploymentId/retire`  | Retire a deployment, requiring affected intakes to restart / operator     |
| `GET /v0/forms/consult-definitions?kind=general_consult`   | Resolve a published patient definition                                    |
| `POST /v0/forms/governance/artifacts`                      | Submit a clinical, marketing or Mode 2 artifact / operator                |
| `GET /v0/forms/governance/artifacts/:artifactId`           | Inspect artifact content / its author or designated review capability     |
| `POST /v0/forms/governance/artifacts/:artifactId/decision` | Approve/reject the exact submitted hash / independent designated reviewer |

SI-023 submit and decision endpoints also enforce operator/reviewer membership and fresh actor context. All four handler families (new Forms governance, legacy direct publication, SI-023 submission and SI-023 decision) authorize before and after the entire idempotency transaction. The final check runs after cache/outbox waits and cache completion, and also checks a cached replay before its response can leave the helper. An early precheck alone is insufficient. A non-replay SQL failure is preserved without issuing a new query against an aborted transaction. The submission receipt uses a narrow SQL function rather than granting the application raw review-history access.

The SI-023 submission SQL function independently checks live operator authorization after template/review lock waits, before writes and before returning. This applies to initial submission and revision resubmission even when an ordinary application connection invokes the function through `admin_basic_operator` without an HTTP handler. Revocation or session/nonce expiry during a lifecycle write aborts the entire SQL transaction, including any review root already inserted. These checks preserve the pre-existing draft/deletion and in-flight-review state guards.

## Persistence and evidence

Migrations 090–092 add one NOLOGIN, NOSUPERUSER, NOBYPASSRLS, NOINHERIT function owner and three private FORCE-RLS tables. No new raw application DML grant is introduced. New security-definer functions fix their search path with `pg_temp` last. The publication family advisory lock serializes version creation, supersession and deployment.

Publication inserts an immutable snapshot. A deferred database constraint requires a matching `config_change_validated` audit record and `forms.publication.checked` outbox event written in that same transaction, including the exact schema hash. The application flushes this constraint while tenant/actor context is still bound. SAVEPOINT insertions count as current-transaction evidence; previously committed evidence does not. A SQL publication call without durable evidence rolls back. Other new mutations emit only server-derived IDs, hashes and statuses through the existing audit/outbox helpers.

Legacy migration fixtures can contain published templates without a new snapshot. They are not served by this resolver. Ordinary application users cannot insert a pre-published template; the publication trigger guards updates and does not rewrite historical privileged seed data.

## Verification and rollback

`npm run verify:forms-publication` uses a disposable development database with separate migration-fixture, application, binder and identity connections. It provisions only synthetic accounts, sessions and capability memberships through the fixture connection; template creation, review, publication and deployment go through real authenticated HTTP operations. It runs for both US and Ghana and covers all four publication gates, exact-hash stale approval rejection, SQL bypass/evidence denial, SI-023 parity, cross-tenant isolation, session/nonce expiry during a blocked definition read, pinned superseded definitions and retirement. It also checks current staff qualification for both content artifacts through direct and SI-023 publication, all 24 country/handler/invalidation combinations while cached replay waits on reservation, authorized replay preservation, and rollback of a fresh mutation whose authorization expires during its outbox wait. Another 24 direct-SQL cases invalidate operator membership, session or nonce while submission waits on a template row, revision review row, initial lifecycle write or revision lifecycle write. Each asserts authorization denial, attempted COMMIT becoming ROLLBACK, and unchanged review/lifecycle rows. CI runs this after the main and migration suites using its ephemeral PostgreSQL service. No external messaging provider is used.

Unit tests separately cover the typed conditional answer validator. Existing publication integration tests retain supersession and audit/outbox assertions using live reviewer fixtures; old fabricated-JWT tests now assert denial rather than pretending to prove a working authenticated publication flow.

Apply migrations through the hash-checking migration runner. Rollbacks are supplied in reverse order 092, 091, 090 and restore the latest pre-090 SI-023 wrappers before dropping the new owner/tables: submission from migration 052 (including its locked draft/deletion guard), and decision from migration 043. Rollback removes the new governance/snapshot data and must be an explicitly planned operational action after preserving required evidence. It is not an automatic response to a failed publication attempt.

`npm run verify:forms-rollback` commits these rollbacks in an explicitly disposable database (`NODE_ENV=development`, `FORMS_ROLLBACK_DISPOSABLE_DATABASE=true`, with the same separate fixture/application/binder URLs). It checks ordinary-role SQL submission behavior before and after the committed rollback for published, superseded, archived, soft-deleted draft and valid draft templates in both countries, and compares restored function bodies against the latest baseline sources. CI runs this after Forms acceptance; the database intentionally ends at the pre-Forms schema. Never run this verification against a database whose Forms governance/snapshot data must be retained.

Program publication gates are available for review mechanics and exact contract checking. This package does not implement a program's clinical rules engine, approved clinical content, clinician credentialing process, care consent, payment or consultation completion. Those remain separate platform work owned by their respective modules.
