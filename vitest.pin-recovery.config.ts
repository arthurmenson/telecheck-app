import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/modules/identity/internal/services/patient-pin-session-receipt.test.ts'],
    testTimeout: 10000,
  },
});
