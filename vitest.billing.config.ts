import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    // Configuration validation only: these focused tests never connect.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://synthetic:unused@127.0.0.1:1/unused',
      REDIS_URL: 'redis://127.0.0.1:1',
    },
    include: [
      'src/modules/billing/**/*.test.ts',
      'src/modules/async-consult/internal/handlers/initiate-consult-v1.test.ts',
    ],
    testTimeout: 15000,
  },
});
