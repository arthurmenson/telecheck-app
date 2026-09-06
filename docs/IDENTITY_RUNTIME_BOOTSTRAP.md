# Identity runtime bootstrap

Migrations 081 and 082 add the ordinary-role grants needed for tenant branding, registration, sessions, and device self-service. The application remains NOSUPERUSER, NOBYPASSRLS, and NOINHERIT. Tenant-owned Identity and configuration tables retain forced RLS. Audit records and domain events permit append/read only; opaque audit dedupe markers retain the explicit non-PHI, non-RLS contract of migration 022. No clinical base-table or actor-binding-table grants are added.

`GET /v0/identity/accounts/me` now resolves the account from a verified JWT and an active database session. The session must belong to that account; suspended, archived, deleted, stale-role, fabricated-session, and delegated contexts fail closed. Global administrators use their home tenant for their own identity operations.

Device registration and listing use the same authentication. The legacy optional `account_id` input is accepted only when it equals the authenticated account. Revoking an unowned, absent, or already-revoked device returns the same 204 response and changes no unowned record. Real authenticated actor IDs are recorded in device audits. Authentication runs before idempotency replay, including after logout.

## Synthetic acceptance

Install dependencies with `npm ci`, apply the reviewed migration chain to a dedicated local PostgreSQL cluster, and provision separate login secrets for `telecheck_app_role` and `bind_actor_context_role`. Keep the migration principal separate. `DATABASE_URL` must use the ordinary role; `BIND_ACTOR_CONTEXT_DATABASE_URL` must use the binding role. Use secret-manager or shell environment injection and never commit credentials.

For this synthetic probe only, configure:

```text
NODE_ENV=development
AUTH_DEV_OTP_ECHO=true
EMAIL_PROVIDER=noop
SMS_PROVIDER=noop
DATABASE_SSL_MODE=disable
TENANT_HOST_OVERRIDES=localhost=Telecheck-US,ghana.localhost=Telecheck-Ghana
```

Supply `JWT_SIGNING_KEY`, `RESUME_TOKEN_SECRET`, `REDIS_URL`, and both database URLs through the environment, then run:

```sh
npm run verify:identity-runtime
```

The probe checks actual application and bind connections, branding in both tenants, three synthetic registrations, account self-read, device registration/replay, same-tenant ownership, cross-tenant rejection, logout and rejected stale replay. It creates only `synthetic-runtime-…@example.invalid` accounts, prints no tokens or passcodes, delivers no messages, and retains its synthetic database/audit history. Custom local hosts can be supplied through `IDENTITY_PROBE_US_HOST` and `IDENTITY_PROBE_GH_HOST`. Development pretty logging now has its required `pino-pretty` dependency.

These controls and the standalone probe were verified on PostgreSQL 16.15 with real app/bind login connections. Automated integration tests also verify ordinary-role access, forced RLS and immutable-history privileges. This package establishes Identity and branding; production provider activation, clinical encrypted intake/review, and the rest of the launch platform remain separate required work.
