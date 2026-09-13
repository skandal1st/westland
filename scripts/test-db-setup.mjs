#!/usr/bin/env node
/**
 * Prepare a database for integration tests.
 *
 * Requires DATABASE_URL to point at a reachable PostgreSQL (locally this is the
 * `postgres` service from docker-compose.yml). Applies committed migrations via
 * `prisma migrate deploy` so integration tests run against the same schema
 * production will use — never `db push`.
 */
import { execSync } from 'node:child_process'

if (!process.env.DATABASE_URL) {
  console.error('test-db-setup: DATABASE_URL is required (start Postgres, e.g. `docker compose up -d postgres`).')
  process.exit(1)
}

try {
  execSync('npx prisma migrate deploy', { stdio: 'inherit' })
  console.log('✓ test database migrated')
} catch (error) {
  console.error('test-db-setup: migration failed', error?.message ?? error)
  process.exit(1)
}
