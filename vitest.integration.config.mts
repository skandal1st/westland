import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { assertTestDatabase } from './scripts/test-db-guard.mjs'

assertTestDatabase()

/**
 * Integration test config. Requires a real PostgreSQL reachable via
 * DATABASE_URL (see scripts/test-db-setup.mjs). Runs serially so tests do not
 * fight over the same schema.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  // Match Next.js: automatic JSX runtime so .tsx (e.g. the PDF renderer) needs no React import.
  esbuild: { jsx: 'automatic' },
})
