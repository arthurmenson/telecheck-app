import type { DbClient } from '../../src/lib/db.ts';

/** Shared-cluster catalog writes must serialize across parallel test files. */
export async function configureBindRole(client: DbClient, password: string): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(password)) throw new Error('invalid synthetic bind password');
  await client.query("SELECT pg_advisory_lock(hashtext('test_configure_bind_role'))");
  try {
    await client.query(`ALTER ROLE bind_actor_context_role WITH LOGIN PASSWORD '${password}'`);
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('test_configure_bind_role'))");
  }
}
