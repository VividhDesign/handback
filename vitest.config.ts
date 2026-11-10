import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    env: { PAYPAL_ENV: 'sandbox', DB_PATH: ':memory:', DATA_DIR: '.test-data' },
  },
});
