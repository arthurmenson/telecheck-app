/**
 * Telecheck app entry point — binds the Fastify instance to a port.
 *
 * Production deployment runs this via `node dist/server.js` after `npm run build`.
 * Local dev runs via `npm run dev` (tsx watch).
 *
 * Tests do NOT import this file — they import buildApp() from ./app.ts directly
 * to exercise routes via fastify.inject() without binding to a real port.
 */

import { buildApp } from './app.js';

const port = Number(process.env['PORT'] ?? 3000);
const host = process.env['HOST'] ?? '0.0.0.0';

async function main(): Promise<void> {
  const app = await buildApp();

  // Graceful shutdown on SIGTERM / SIGINT (per cloud-native discipline)
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutdown signal received, closing app');
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ port, host });
    app.log.info({ port, host }, 'telecheck-app listening');
  } catch (err) {
    app.log.error({ err }, 'failed to bind listener');
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('fatal error during startup:', err);
  process.exit(1);
});
