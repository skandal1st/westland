const { PrismaClient } = require('@prisma/client')
const url = new URL(process.env.DATABASE_URL || '')
if (process.env.R22_ACCEPTANCE !== '1' || url.hostname !== 'postgres-r22' || url.pathname !== '/axima_r22_acceptance') throw new Error('R22 isolated database guard')
const db = new PrismaClient()
async function main() {
  const store = await db.store.upsert({ where: { slug: 'r22-acceptance' }, create: { slug: 'r22-acceptance', name: 'R22 TEST — no orders' }, update: {} })
  await db.appSettings.upsert({ where: { storeId: store.id }, create: { storeId: store.id, invoicePrefix: 'R22', catalogRequiresAuth: true }, update: {} })
  const id = process.env.ONEC_EXCHANGE_CONNECTION_ID
  if (!id) throw new Error('Exchange connection ID required')
  const existing = await db.integrationConnection.findUnique({ where: { id } })
  if (existing && (existing.storeId !== store.id || existing.provider !== 'ONE_C' || existing.environment !== 'TEST')) throw new Error('Source identity mismatch')
  await db.integrationConnection.upsert({ where: { id }, update: {}, create: {
    id, storeId: store.id, provider: 'ONE_C', name: 'UT 11.4 acceptance only',
    environment: 'TEST', sourceState: 'ACTIVE', enabled: true,
    config: { saleExport: { enabled: true, format: 'COMMERCEML_2_10', currency: 'RUB', timeZone: 'Europe/Moscow' } },
  } })
  console.log(JSON.stringify({ store: store.slug, orders: await db.order.count({ where: { storeId: store.id } }), seededOrders: 0, sourceEnvironment: 'TEST' }))
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error.message); process.exitCode = 1 })
