import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyPatientCrisisHistoryRollback } from './verify-patient-crisis-history-rollback.mjs';

test('rollback guard refuses non-local, wrong, or unconfirmed acceptance targets before mutation', async (t) => {
  const prior = process.env.CARE_SYNTHETIC_ACCEPTANCE;
  try {
    for (const [name, enabled, host, database, actualDatabase] of [
      [
        'missing explicit acceptance',
        undefined,
        'localhost',
        'telecheck_care_intake',
        'telecheck_care_intake',
      ],
      [
        'disabled acceptance',
        'false',
        'localhost',
        'telecheck_care_intake',
        'telecheck_care_intake',
      ],
      ['remote address', 'true', '192.0.2.1', 'telecheck_care_intake', 'telecheck_care_intake'],
      [
        'remote hostname',
        'true',
        'database.example.invalid',
        'telecheck_care_intake',
        'telecheck_care_intake',
      ],
      [
        'substring hostname',
        'true',
        'localhost.example.invalid',
        'telecheck_care_intake',
        'telecheck_care_intake',
      ],
      [
        'missing actual client destination',
        'true',
        undefined,
        'telecheck_care_intake',
        'telecheck_care_intake',
      ],
      [
        'wrong client database',
        'true',
        'localhost',
        'telecheck_production',
        'telecheck_care_intake',
      ],
      [
        'wrong actual database',
        'true',
        'localhost',
        'telecheck_care_intake',
        'telecheck_production',
      ],
    ])
      await t.test(name, async () => {
        if (enabled === undefined) delete process.env.CARE_SYNTHETIC_ACCEPTANCE;
        else process.env.CARE_SYNTHETIC_ACCEPTANCE = enabled;
        const queries = [];
        const db = {
          connectionParameters: { host, database },
          query: async (sql) => {
            queries.push(sql);
            assert.equal(sql, 'SELECT current_database() AS db');
            return { rows: [{ db: actualDatabase }] };
          },
        };
        await assert.rejects(verifyPatientCrisisHistoryRollback(db), assert.AssertionError);
        assert.deepEqual(
          queries,
          name === 'wrong actual database' ? ['SELECT current_database() AS db'] : [],
        );
      });
  } finally {
    if (prior === undefined) delete process.env.CARE_SYNTHETIC_ACCEPTANCE;
    else process.env.CARE_SYNTHETIC_ACCEPTANCE = prior;
  }
});
