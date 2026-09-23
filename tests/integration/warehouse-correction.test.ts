import { afterAll, beforeEach, afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import contract from '../fixtures/onec/r05-contract.json'
import sample from '../fixtures/onec/r05-source-sample.json'
import { applyProductSnapshot } from '@/lib/catalog/import'

const db = new PrismaClient()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axima-r08-'))
let storeId: string, connectionId: string, spec: any
const targetIds = new Map<string, string>(), channelIds = new Map<string, string>(), variantIds = new Map<string, string>()
const script = path.resolve('scripts/correct-warehouse-channels.mjs')
const filename = path.join(dir, 'plan.json')
function run(args: string[] = [], input = spec) {
  fs.writeFileSync(filename, JSON.stringify(input))
  return JSON.parse(execFileSync(process.execPath, [script, filename, ...args], { encoding: 'utf8', timeout: 30_000, windowsHide: true }))
}
function failure(args: string[], input = spec, env = process.env) {
  fs.writeFileSync(filename, JSON.stringify(input))
  const result = spawnSync(process.execPath, [script, filename, ...args], { encoding: 'utf8', timeout: 30_000, windowsHide: true, env })
  expect(result.status).toBe(1)
  return JSON.parse(result.stderr).error as string
}
beforeEach(async () => {
  storeId = (await db.store.create({ data: { slug: `r08-${randomUUID()}`, name: 'R08' } })).id
  connectionId = (await db.integrationConnection.create({ data: { storeId, provider: 'ONE_C', name: 'R08 test', environment: 'TEST', sourceState: 'ACTIVE', enabled: true } })).id
  targetIds.clear(); channelIds.clear(); variantIds.clear()
  for (const item of sample.samples) {
    const sku = item.product.article || item.product.barcode || item.product.code
    const imported = await applyProductSnapshot({ storeId, connectionId, payload: { externalId: item.externalId, sku, name: item.product.name } }, db)
    variantIds.set(sku, imported.variantId)
  }
  for (const mapping of contract.channels) {
    const wrong = await db.inventoryLocation.create({ data: { storeId, code: mapping.warehouseExternalId, name: 'Wrong legacy location' } })
    const target = await db.inventoryLocation.create({ data: { storeId, code: mapping.inventoryLocationCode, name: mapping.inventoryLocationCode } })
    targetIds.set(mapping.code, target.id)
    await db.externalReference.create({ data: { connectionId, entityType: 'location', externalId: mapping.warehouseExternalId, entityId: target.id } })
    const channel = await db.fulfillmentChannel.create({ data: { storeId, code: mapping.code, name: mapping.code, paymentMethod: mapping.paymentMethod as 'CASH' | 'BANK_TRANSFER', inventoryLocationId: wrong.id, sellerLegalEntity: { preserve: true } } })
    channelIds.set(mapping.code, channel.id)
    for (const item of sample.samples) {
      const sku = item.product.article || item.product.barcode || item.product.code
      const available = (item.warehouses as Record<string, string>)[mapping.warehouseExternalId]
      await db.stock.create({ data: { locationId: target.id, variantId: variantIds.get(sku)!, available, sourceUpdatedAt: new Date('2026-09-18T12:55:47Z') } })
    }
    // A stale projection absent at the target must be removed on correction.
    const p = await db.product.create({ data: { storeId, canonicalName: 'Stale projection fixture' } })
    const v = await db.productVariant.create({ data: { storeId, productId: p.id, sku: `stale-${mapping.code}` } })
    await db.availabilityProjection.create({ data: { fulfillmentChannelId: channel.id, variantId: v.id, availableQuantity: 999 } })
  }
  spec = { storeId, connectionId, channels: contract.channels.map(c => ({ code: c.code, warehouseExternalId: c.warehouseExternalId, locationCode: c.inventoryLocationCode,
    controls: contract.controls.map(item => ({ sku: item.sku, available: item.expectedAvailable[c.code as 'rs' | 'nal'] })) })) }
})
afterEach(async () => {
  await db.providerSnapshot.deleteMany({ where: { storeId } })
  await db.integrationError.deleteMany({ where: { storeId } })
  await db.store.delete({ where: { id: storeId } })
})
afterAll(() => db.$disconnect())

it('dry-run writes nothing; reviewed apply repairs both channels and exact projections; repeat is a no-op', async () => {
  const before = await db.fulfillmentChannel.findMany({ where: { storeId }, orderBy: { code: 'asc' } })
  const dry = run()
  expect(dry.mode).toBe('dry-run')
  expect(dry.changes.every((c: any) => c.changed && c.projectionsAfter === 5)).toBe(true)
  expect(await db.fulfillmentChannel.findMany({ where: { storeId }, orderBy: { code: 'asc' } })).toEqual(before)
  expect(await db.availabilityProjection.count({ where: { fulfillmentChannel: { storeId } } })).toBe(2)
  expect(await db.auditEntry.count({ where: { storeId } })).toBe(0)
  const applied = run(['--apply', `--expected-digest=${dry.digest}`])
  expect(applied.mode).toBe('applied')
  for (const c of contract.channels) {
    const channel = await db.fulfillmentChannel.findUniqueOrThrow({ where: { id: channelIds.get(c.code)! } })
    expect(channel.inventoryLocationId).toBe(targetIds.get(c.code))
    expect(channel.sellerLegalEntity).toEqual({ preserve: true })
    for (const control of contract.controls) {
      const projection = await db.availabilityProjection.findUniqueOrThrow({ where: { variantId_fulfillmentChannelId: { variantId: variantIds.get(control.sku)!, fulfillmentChannelId: channel.id } } })
      expect(projection.availableQuantity.toString()).toBe(control.expectedAvailable[c.code as 'rs' | 'nal'])
      expect(projection.sourceUpdatedAt).toEqual(new Date('2026-09-18T12:55:47Z'))
    }
  }
  expect(await db.availabilityProjection.count({ where: { fulfillmentChannel: { storeId } } })).toBe(10)
  const again = run()
  expect(again.changes.every((c: any) => !c.changed)).toBe(true)
  run(['--apply', `--expected-digest=${again.digest}`])
  expect(await db.auditEntry.count({ where: { storeId, action: 'WarehouseChannelsCorrected' } })).toBe(1)
  fs.writeFileSync(path.join(dir, 'successful-dry-run.json'), JSON.stringify(dry, null, 2))
  fs.writeFileSync(path.join(dir, 'successful-apply.json'), JSON.stringify(applied, null, 2))
})

it('mapping error on the second channel prevents any correction', async () => {
  const dry = run()
  await db.externalReference.updateMany({ where: { connectionId, entityType: 'location', externalId: contract.channels[1].warehouseExternalId }, data: { entityId: (await db.fulfillmentChannel.findUniqueOrThrow({ where: { id: channelIds.get('nal')! } })).inventoryLocationId } })
  expect(failure(['--apply', `--expected-digest=${dry.digest}`])).toMatch(/warehouse_mapping_mismatch/)
  expect(await db.fulfillmentChannel.count({ where: { storeId, inventoryLocationId: { in: Array.from(targetIds.values()) } } })).toBe(0)
  expect(await db.auditEntry.count({ where: { storeId } })).toBe(0)
})

it('projection drift invalidates the reviewed digest', async () => {
  const dry = run()
  await db.availabilityProjection.updateMany({ where: { fulfillmentChannelId: channelIds.get('rs')! }, data: { availableQuantity: 998 } })
  expect(failure(['--apply', `--expected-digest=${dry.digest}`])).toBe('stale_preview')
  expect(await db.fulfillmentChannel.count({ where: { storeId, inventoryLocationId: { in: Array.from(targetIds.values()) } } })).toBe(0)
})

it('missing mapping, missing control stock and foreign store source are explicit errors', async () => {
  expect(failure([], { ...spec, storeId: 'other-store' })).toBe('source_not_active_onec')
  expect(failure([], { ...spec, channels: [{ ...spec.channels[0], warehouseExternalId: 'unknown' }] })).toMatch(/warehouse_mapping_missing/)
  expect(failure([], { ...spec, channels: [{ ...spec.channels[0], controls: [{ sku: 'absent', available: '0' }] }] })).toMatch(/control_stock_missing/)
  expect(failure([], { ...spec, channels: [{ ...spec.channels[0], controls: [{ sku: contract.controls[0].sku, available: '999' }] }] })).toMatch(/control_stock_mismatch/)
})

it('apply needs reviewed digest, isolated test DB and TEST source; running jobs block preview', async () => {
  expect(failure(['--apply'])).toBe('reviewed_digest_required')
  expect(failure(['--apply', '--expected-digest=' + '0'.repeat(64)], spec, { ...process.env, AXIMA_TEST_DATABASE: '0' })).toMatch(/Refusing test database/)
  await db.integrationConnection.update({ where: { id: connectionId }, data: { environment: 'PRODUCTION' } })
  const dry = run()
  expect(failure(['--apply', `--expected-digest=${dry.digest}`])).toBe('apply_requires_test_source')
  await db.integrationJob.create({ data: { storeId, connectionId, type: 'catalog.import', idempotencyKey: randomUUID(), status: 'RUNNING' } })
  expect(failure([])).toBe('source_has_running_jobs')
})


it('a late database failure rolls back both channel updates, projections and audit', async () => {
  const dry = run()
  // The guarded disposable DB rejects only this fixture's audit row, after all
  // channel/projection writes. This verifies an actual transaction rollback.
  const constraint = `r08_${randomUUID().replaceAll('-', '')}`
  await db.$executeRawUnsafe(`ALTER TABLE "AuditEntry" ADD CONSTRAINT "${constraint}" CHECK ("targetId" <> '${connectionId}' OR "action" <> 'WarehouseChannelsCorrected')`)
  try {
    expect(failure(['--apply', `--expected-digest=${dry.digest}`])).toMatch(/constraint|check/i)
    expect(await db.fulfillmentChannel.count({ where: { storeId, inventoryLocationId: { in: Array.from(targetIds.values()) } } })).toBe(0)
    const rows = await db.availabilityProjection.findMany({ where: { fulfillmentChannel: { storeId } } })
    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.availableQuantity.toString() === '999')).toBe(true)
    expect(await db.auditEntry.count({ where: { storeId } })).toBe(0)
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "AuditEntry" DROP CONSTRAINT "${constraint}"`)
  }
})
