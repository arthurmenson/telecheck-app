import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://synthetic:unused@127.0.0.1:1/unused',
      REDIS_URL: 'redis://127.0.0.1:1',
    },
    include: [
      'src/modules/async-consult/internal/services/clinical-*.test.ts',
      'src/modules/async-consult/internal/handlers/submit-intake-v1.test.ts',
      'src/modules/crisis-response/internal/patient-history.test.ts',
      'src/modules/identity/internal/services/staff-contract.test.ts',
    ],
    testTimeout: 15000,
  },
});
