# Local platform runtime

The full platform is in development. These commands establish the real PostgreSQL substrate; they do not imply that every frontend workflow or provider is implemented.

## Database migrations

Install Node.js 20 or later and run `npm ci`. Provision an isolated PostgreSQL 15+ cluster with a migration principal authorized to create the roles, extensions, and schema in the canonical chain. The current chain uses a `postgres` ownership anchor with superuser semantics; an RDS-compatible ownership design remains separate required work. Do not run the application as that migration principal.

Set `MIGRATION_DATABASE_URL` through the shell or secret manager without putting credentials in tracked files, then run:

```sh
npm run migrate:apply
```

The cross-platform Node runner validates every source file, acquires an advisory lock, checks SHA-256 history, and applies each migration and its tracking row in one transaction. It removes a paired, top-level transaction wrapper from legacy SQL and performs early lexical checks for unsupported commands. The authoritative containment boundary is a temporary SECURITY INVOKER PL/pgSQL function called through SELECT: PostgreSQL forbids transaction termination in that function, including nested DO/CALL or syntax not recognized by the diagnostic lexer. Schema changes and the history insert therefore share the runner-owned transaction. This follows [PostgreSQL transaction-management semantics](https://www.postgresql.org/docs/16/plpgsql-transactions.html). SQL errors report a migration filename and SQLSTATE; connection strings, SQL text, and parameters are not printed.

A second run applies nothing. A changed or missing historical source, an inserted migration below the applied frontier, or missing/unverified historical checksums fails closed. This command is immediately suitable for fresh clusters and its own verified histories. Older `apply-migrations.sh` or test-harness histories require a separately verified adoption procedure; do not invent their checksums or delete history to bypass that check. The legacy shell command is retained for compatibility pending that migration.

Use separate PostgreSQL clusters for the integrated platform and the automated suite. Migrations create cluster-level roles with some intentionally unguarded creation, so a second pristine database within an already-migrated cluster is not a clean-room installation. For local native PostgreSQL, bind only to `127.0.0.1`, use SCRAM authentication and separate ports/data directories, and store generated local credentials outside the repository. For containers, use separate volumes and instances.

## Verification

Set `TEST_DATABASE_URL` to an isolated test cluster and run `npm run test:migrations`. The test creates and removes only a randomly named database of its own. It proves transactional rollback of DDL, tracking consistency, replay, checksum-change refusal, and refusal to adopt unsigned history. It also validates the complete checked-in migration inventory and SQL lexical edge cases, including continued escape strings and nested procedural transaction control.

The initial Windows verification used PostgreSQL 16.15 from EDB's official Windows archive, SHA-256 `5e8afffe67daf949aeeb03b74951f1ec2324e1888f73fbd036ab0e567ab004d9`. All 79 forward migrations through 080 applied to a fresh cluster; the repeat reported zero applied and 79 previously applied. This is local evidence, not production infrastructure certification.

## Application and frontend configuration

The backend requires `DATABASE_URL` for the ordinary application role and a separate `BIND_ACTOR_CONTEXT_DATABASE_URL` for `bind_actor_context_role`. Keep test-header authentication disabled. Real authentication and tenant binding must be exercised before declaring an integrated care journey complete. Production KMS readiness, ordinary-role grant completion, provider setup, seeds, and the complete startup command remain active implementation work.

The clinician frontend now has explicit real/development-mock mode; real mode must never fall back to fixtures. The patient frontend still needs the server-encrypted intake contract. Set `TELECHECK_PROJECT_ROOT` to the spec repository when running the delivery cockpit from a sibling worktree; its historical default assumes a nested checkout. The delivery cockpit is distinct from the clinical platform operator portal.
