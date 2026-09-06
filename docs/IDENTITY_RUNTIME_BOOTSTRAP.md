# Identity runtime bootstrap

Migrations 081–083 establish ordinary application reads and a separate Identity database boundary. The app and Identity roles remain NOSUPERUSER, NOBYPASSRLS, and NOINHERIT. Ordinary SQL cannot read or alter PINs, OTPs, email passcodes, devices or authentication replay records, create/rewrite sessions, or mutate accounts. The Identity role can insert twelve registration columns and update status/activated_at; it cannot write account_type or cohort_classification. Registration uses patient/unclassified defaults. Privileged staff provisioning and cohort governance remain separate.

Every Identity handler transaction, including its idempotency reservation, credential mutation, audit and response cache, uses the dedicated login. Default public Identity service/repository calls also own a transaction, so audit failure rolls back their state changes. The connection's actual role and safety attributes are checked at boot and acquisition; application and bind principals must have no direct or transitive Identity membership. Tenant context is cleared before pool reuse. Missing Identity configuration fails production startup. Test fallback requires both NODE_ENV=test and the explicitly installed integration-harness connection; it is not a development or production fallback.

The private identity_idempotency_keys table has forced tenant RLS and service-only grants. Authentication handlers never read the general replay cache, even for encoded URL spellings. All private completed responses expire within 900 seconds or the shorter endpoint limit. Migration083 moves existing canonical Identity entries with their original expiry and removes legacy bearer/passcode responses from the general cache. This one-time relocation requires the trusted migration principal to have SUPERUSER or BYPASSRLS so suspended tenants are included; table ownership alone is insufficient under FORCE RLS. Runtime principals never receive those privileges. An additional restrictive policy protects the general Identity namespace. This is an engineering correction to the implemented authentication trust boundary, not a new ratification claim for historical SI-010 documentation. Audit and domain-event history remain append-only.

`GET /v0/identity/accounts/me` now resolves the account from a verified JWT and an active database session. The session must belong to that account; suspended, archived, deleted, stale-role, fabricated-session, and delegated contexts fail closed. Global administrators use their home tenant for their own identity operations.

Device registration and listing use the same authentication. The legacy optional `account_id` input is accepted only when it equals the authenticated account. Revoking an unowned, absent, or already-revoked device returns the same 204 response and changes no unowned record. Device audits record the authenticated actor ID and type, including clinician/operator/delegate identities. Nonpatient accounts do not receive a fabricated target_patient_id. System attribution is retained for actual internal service calls; existing audit history is never rewritten. Authentication runs before idempotency replay, including after logout.

## Synthetic acceptance

Install dependencies with `npm ci`, apply the reviewed migration chain to a dedicated local PostgreSQL cluster, and provision separate login secrets for `telecheck_app_role`, `identity_service_role` and `bind_actor_context_role`. Migration083 creates Identity as NOLOGIN; provisioning enables LOGIN and sets its secret without adding membership or changing safety attributes. Keep the migration principal separate. `DATABASE_URL`, `IDENTITY_DATABASE_URL` and `BIND_ACTOR_CONTEXT_DATABASE_URL` must use their respective logins. Use secret-manager or shell environment injection and never commit credentials.

For this synthetic probe only, configure:

```text
NODE_ENV=development
AUTH_DEV_OTP_ECHO=true
EMAIL_PROVIDER=noop
SMS_PROVIDER=noop
DATABASE_SSL_MODE=disable
TENANT_HOST_OVERRIDES=localhost=Telecheck-US,ghana.localhost=Telecheck-Ghana
```

Supply `JWT_SIGNING_KEY`, `RESUME_TOKEN_SECRET`, `REDIS_URL`, and all three database URLs through the environment, then run:

```sh
npm run verify:identity-runtime
```

The probe checks actual application, Identity and bind connections, branding in both tenants, three synthetic registrations, account self-read, device registration/replay, same-tenant ownership, cross-tenant rejection, logout and rejected stale replay. It creates only `synthetic-runtime-…@example.invalid` accounts, prints no tokens or passcodes, delivers no messages, and retains its synthetic database/audit history. Custom local hosts can be supplied through `IDENTITY_PROBE_US_HOST` and `IDENTITY_PROBE_GH_HOST`. Development pretty logging now has its required `pino-pretty` dependency.

The standalone probe was verified on PostgreSQL16.15 with three actual runtime logins and a fresh82-file migration chain. Automated tests cover credential-write/role-assumption denial, private-cache tenant isolation and read/write denial, account control columns, audit rollback, and alias-independent replay TTL. Fixtures that seed privileged accounts use explicit harness connections; they do not imply that ordinary registration can create staff accounts. Production provider activation, clinical encrypted intake/review, and the remaining launch platform are still required work.
