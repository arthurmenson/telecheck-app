# Backup redaction runbook (Layer 5)

Staging backups are taken ONLY through the wrapper; operators never run a raw `pg_dump` to a file.

```bash
BACKUP_DATABASE_URL='postgres://<read-only-role>:...@localhost:5432/telecheck' \
AGE_RECIPIENTS_FILE=/home/deploy/.age-recipients \
npm run backup:redacted -- /home/deploy/backups
```

What happens: `pg_dump --no-owner --no-privileges` → `scripts/pii-scrub.mjs --mode backup` (whole regex library, fail closed) → `age -R` public-key encryption → structural verification → `<UTC stamp>-db.sql.age` + `<UTC stamp>-db.manifest.json` in the output directory. Nothing unredacted and nothing unencrypted touches the output directory; a failure at any stage leaves no artifact.

Restore is a **diagnostic** path (redacted values are `[REDACTED:<label>]` and numeric fidelity is not preserved), never a recovery path — Pilot 1 holds no PHI worth preserving faithfully. Decryption happens off-VPS with the age private key (see the incident-response runbook's key management section).

Prerequisites on the VPS: `age` on PATH, the recipients file readable by the deploy user, `pg_dump` matching the server major version, and `npm ci` (the scrub runs under `tsx`).

Refused `pg_dump` options (they would bypass the pipe or change the stream): `-f/--file`, `-F/--format` (plain is forced), `-Z/--compress`, `-j/--jobs`, `-E/--encoding` (UTF8 is forced). Safe extras such as `--table=public.x`, `--schema-only`, `--data-only` pass through. An empty dump is refused; a failure after the artifact was published withdraws this run's files.
