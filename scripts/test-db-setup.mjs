#!/usr/bin/env node
/**
 * Prepare a database for integration tests.
 *
 * Requires DATABASE_URL to point at a reachable PostgreSQL (locally this is the
 * `postgres-test` service from docker-compose.test.yml). Applies committed migrations via
 * `prisma migrate deploy` so integration tests run against the same schema
 * production will use — never `db push`.
 */
import { execFileSync } from 'node:child_process'
import { assertTestDatabase } from './test-db-guard.mjs'

try {
  assertTestDatabase()
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { stdio: 'inherit', timeout: 120_000 })
  console.log('✓ test database migrated')
} catch (error) {
  console.error('test-db-setup: migration failed', error?.message ?? error)
  process.exit(1)
}
