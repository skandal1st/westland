import { PrismaClient } from '@prisma/client'
import { runJob } from '../../src/lib/integrations/jobs'
import { createMockProvider } from '../../src/lib/integrations/mock-provider'
async function main() {
const db = new PrismaClient()
const job = await db.integrationJob.findUniqueOrThrow({ where: { id: process.argv.at(-1) } })
const remote = createMockProvider({ products: [
  { externalId: 'first', sku: 'FIRST', name: 'First' }, { externalId: 'second', sku: 'SECOND', name: 'Second' },
], pageSize: 1 })
await runJob(job, { provider: { ...remote, pullProducts: async cursor => {
  if (cursor) {
    process.stdout.write('R14_CRASH_READY\n')
    setInterval(() => undefined, 1_000)
    await new Promise(() => undefined)
  }
  return remote.pullProducts(cursor)
} } }, db)

}
main().catch(error => { console.error(error); process.exitCode = 1 })
