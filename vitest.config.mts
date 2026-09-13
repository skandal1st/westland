import { defineConfig } from 'vitest/config'
import path from 'node:path'

/**
 * Unit test config. Fast, no external services.
 * Integration tests (real Postgres) live in vitest.integration.config.mts and
 * are excluded here.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'packages/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tests/integration/**'],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
})
