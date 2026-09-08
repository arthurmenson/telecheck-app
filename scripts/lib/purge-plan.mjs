// purge-plan.mjs — renders the Pilot 1 env-purge SQL plan from the checked-in
// classification map (scripts/pilot-1-purge-classification.json).
//
// Per docs/PII_SCREENING_AND_LOG_REDACTION_SPEC.md §Purge table classification
// policy: every table is `allowlist` (TRUNCATE, never CASCADE), `preserved`
// (never touched) or `scoped-delete` (DELETE with a recorded predicate). The
// plan is ONE transaction with the attestation; the caller wraps it. The
// rendered SQL is deterministic so its digest can be recorded on the audit
// row.
//
// CLI:  node scripts/lib/purge-plan.mjs render [--fail-after audit|truncate|delete]
//       node scripts/lib/purge-plan.mjs list <allowlist|preserved|scoped-delete>
//       node scripts/lib/purge-plan.mjs digest
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CLASSIFICATION_PATH = path.join(here, '..', 'pilot-1-purge-classification.json');
export const CLASSES = new Set(['allowlist', 'preserved', 'scoped-delete']);
const IDENT = /^[a-z_][a-z0-9_]*$/;

export function loadClassification(file = CLASSIFICATION_PATH) {
  const map = JSON.parse(fs.readFileSync(file, 'utf8'));
  validateClassification(map);
  return map;
}

/** Structural validation — every violation is a build-time failure. */
export function validateClassification(map) {
  if (!map || typeof map !== 'object' || typeof map.tables !== 'object') {
    throw new Error('classification: missing "tables"');
  }
  const names = Object.keys(map.tables);
  if (names.length === 0) throw new Error('classification: no tables');
  for (const name of names) {
    if (!IDENT.test(name))
      throw new Error(`classification: invalid table name ${JSON.stringify(name)}`);
    const entry = map.tables[name];
    if (!entry || !CLASSES.has(entry.class)) {
      throw new Error(
        `classification: ${name} has no valid class (allowlist | preserved | scoped-delete)`,
      );
    }
    if (entry.class === 'scoped-delete') {
      if (typeof entry.predicate !== 'string' || entry.predicate.trim() === '') {
        throw new Error(`classification: scoped-delete table ${name} needs a predicate`);
      }
      if (/;|--|\/\*/.test(entry.predicate)) {
        throw new Error(`classification: predicate for ${name} may not contain ; or comments`);
      }
    } else if (entry.predicate !== undefined) {
      throw new Error(`classification: ${name} is ${entry.class} and must not carry a predicate`);
    }
    if (entry.disableUserTriggersForTruncate !== undefined) {
      if (entry.class !== 'allowlist' || entry.disableUserTriggersForTruncate !== true) {
        throw new Error(
          `classification: disableUserTriggersForTruncate is only valid as true on an allowlist table (${name})`,
        );
      }
    }
  }
  // Stored derived relations: every materialized view must be classified too;
  // an allowlist view is REFRESHed inside the purge transaction (Codex R3).
  const mvs = map.materializedViews ?? {};
  for (const name of Object.keys(mvs)) {
    if (!IDENT.test(name))
      throw new Error(`classification: invalid materialized view name ${JSON.stringify(name)}`);
    const entry = mvs[name];
    if (!entry || !['allowlist', 'preserved'].includes(entry.class)) {
      throw new Error(`classification: materialized view ${name} must be allowlist or preserved`);
    }
    if (map.tables[name])
      throw new Error(
        `classification: ${name} is listed both as a table and as a materialized view`,
      );
  }
  // Mixed-baseline safeguard (spec step 5): accounts is NEVER allowlist.
  const accounts = map.tables.accounts;
  if (!accounts || accounts.class !== 'scoped-delete') {
    throw new Error(
      'classification: accounts MUST be scoped-delete (mixed baseline + participant)',
    );
  }
  if (!/cohort_classification\s*=\s*'participant'/.test(accounts.predicate)) {
    throw new Error(
      "classification: accounts predicate must be cohort_classification = 'participant'",
    );
  }
  for (const t of [
    'audit_records',
    'audit_dedupe_markers',
    'domain_events_outbox',
    'tenants',
    'schema_migrations',
  ]) {
    if (map.tables[t]?.class !== 'preserved')
      throw new Error(`classification: ${t} MUST be preserved`);
  }
}

export function matviewsOfClass(map, cls) {
  const mvs = map.materializedViews ?? {};
  return Object.keys(mvs)
    .filter((v) => mvs[v].class === cls)
    .sort();
}

export function tablesOfClass(map, cls) {
  return Object.keys(map.tables)
    .filter((t) => map.tables[t].class === cls)
    .sort();
}

const FAIL_POINTS = new Set(['audit', 'truncate', 'delete']);

function injectedFailure(stage) {
  return `DO $$ BEGIN RAISE EXCEPTION 'pilot-1-env-purge: TEST failure injected after ${stage}'; END $$;\n`;
}

/**
 * Renders the mutation part of the plan (the caller has already inserted the
 * attestation inside the same transaction). Order: one TRUNCATE naming every
 * allowlist table (PostgreSQL resolves FKs among the listed set; RESTRICT so a
 * reference from an unlisted table aborts), then each scoped DELETE, then
 * post-checks that abort the transaction if anything participant-scoped
 * survived. `failAfter` is a TEST-ONLY hook used by the attestation-transaction
 * suite to prove rollback; it is refused unless PILOT_1_TEST_FAIL_AFTER is set
 * by the caller explicitly.
 */
export function renderPlan(map, { failAfter = null } = {}) {
  if (failAfter !== null && !FAIL_POINTS.has(failAfter)) {
    throw new Error(`renderPlan: unknown fail point ${String(failAfter)}`);
  }
  const allow = tablesOfClass(map, 'allowlist');
  // Scoped deletes run BEFORE the accounts delete: their predicates select
  // participant-bound rows via accounts, and their FKs reference it.
  const scoped = tablesOfClass(map, 'scoped-delete').filter((t) => t !== 'accounts');
  if (map.tables.accounts) scoped.push('accounts');
  const guarded = allow.filter((t) => map.tables[t].disableUserTriggersForTruncate === true);
  let sql =
    '-- Pilot 1 env-purge plan — generated from scripts/pilot-1-purge-classification.json\n';
  sql += `-- classification version ${map.version}; ${allow.length} allowlist, ${scoped.length} scoped-delete, ${tablesOfClass(map, 'preserved').length} preserved\n`;
  if (guarded.length) sql += `-- user triggers disabled for TRUNCATE on: ${guarded.join(', ')}\n`;
  if (failAfter === 'audit') sql += injectedFailure('audit');
  // Migration 095's immutability triggers fire on TRUNCATE; USER triggers on
  // those tables are disabled for the TRUNCATE only, re-enabled right after
  // and post-checked, all inside the caller's transaction (Codex R1).
  for (const t of guarded) sql += `ALTER TABLE public.${t} DISABLE TRIGGER USER;\n`;
  sql += 'TRUNCATE TABLE ' + allow.map((t) => `public.${t}`).join(', ') + ' RESTRICT;\n';
  for (const t of guarded) sql += `ALTER TABLE public.${t} ENABLE TRIGGER USER;\n`;
  if (failAfter === 'truncate') sql += injectedFailure('truncate');
  for (const t of scoped) {
    sql += `DELETE FROM public.${t} WHERE ${map.tables[t].predicate};\n`;
  }
  if (failAfter === 'delete') sql += injectedFailure('delete');
  // Stored projections are refreshed AFTER their sources are purged, inside
  // the same transaction, so no participant state survives in them.
  for (const v of matviewsOfClass(map, 'allowlist'))
    sql += `REFRESH MATERIALIZED VIEW public.${v};\n`;
  // Post-checks: abort (and therefore roll back the attestation too) if any
  // allowlist table still has rows or any scoped predicate still matches.
  sql += 'DO $$\nDECLARE v_n BIGINT;\nBEGIN\n';
  for (const t of allow) {
    sql += `  SELECT COUNT(*) INTO v_n FROM public.${t};\n  IF v_n <> 0 THEN RAISE EXCEPTION 'pilot-1-env-purge: % rows survived TRUNCATE of ${t}', v_n; END IF;\n`;
  }
  for (const t of scoped) {
    sql += `  SELECT COUNT(*) INTO v_n FROM public.${t} WHERE ${map.tables[t].predicate};\n  IF v_n <> 0 THEN RAISE EXCEPTION 'pilot-1-env-purge: % ${t} rows still match the scoped predicate', v_n; END IF;\n`;
  }
  for (const v of matviewsOfClass(map, 'allowlist')) {
    sql += `  SELECT COUNT(*) INTO v_n FROM public.${v};\n  IF v_n <> 0 THEN RAISE EXCEPTION 'pilot-1-env-purge: % rows survived in materialized view ${v}', v_n; END IF;\n`;
  }
  for (const t of guarded) {
    sql += `  SELECT COUNT(*) INTO v_n FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = '${t}' AND NOT tg.tgisinternal AND tg.tgenabled = 'D';\n  IF v_n <> 0 THEN RAISE EXCEPTION 'pilot-1-env-purge: % user trigger(s) on ${t} still disabled', v_n; END IF;\n`;
  }
  sql += 'END $$;\n';
  return sql;
}

export function planDigest(sql) {
  return createHash('sha256').update(sql).digest('hex');
}

function cli(argv) {
  const [cmd, ...rest] = argv;
  const map = loadClassification();
  if (cmd === 'render') {
    let failAfter = null;
    const i = rest.indexOf('--fail-after');
    if (i >= 0) failAfter = rest[i + 1] ?? null;
    process.stdout.write(renderPlan(map, { failAfter }));
    return 0;
  }
  if (cmd === 'list') {
    const cls = rest[0];
    if (!CLASSES.has(cls)) throw new Error(`list: unknown class ${cls}`);
    process.stdout.write(tablesOfClass(map, cls).join('\n') + '\n');
    return 0;
  }
  if (cmd === 'digest') {
    process.stdout.write(planDigest(renderPlan(map)) + '\n');
    return 0;
  }
  if (cmd === 'validate') {
    process.stdout.write(`ok: ${Object.keys(map.tables).length} tables classified\n`);
    return 0;
  }
  process.stderr.write(
    'usage: purge-plan.mjs render [--fail-after audit|truncate|delete] | list <class> | digest | validate\n',
  );
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(cli(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`purge-plan: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
