#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { z } from 'zod';
import { assertTestDatabase } from './test-db-guard.mjs';

// No runtime GUIDs or channel names: the reviewed JSON supplies all mappings.
const schema = z.object({
  storeId: z.string().min(1), connectionId: z.string().min(1),
  channels: z.array(z.object({
    code: z.string().min(1), warehouseExternalId: z.string().min(1), locationCode: z.string().min(1),
    controls: z.array(z.object({ sku: z.string().min(1), available: z.string().regex(/^\d+(\.\d{1,3})?$/) }).strict()).min(1),
  }).strict()).min(1).max(100),
}).strict();
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw new Error(code); };
const projectShape = row => ({ variantId: row.variantId, availableQuantity: String(row.availableQuantity ?? row.available), sourceUpdatedAt: row.sourceUpdatedAt });

async function preview(tx, spec) {
  if (new Set(spec.channels.map(c => c.code)).size !== spec.channels.length) fail('duplicate_channel');
  const source = await tx.integrationConnection.findUnique({ where: { id: spec.connectionId } });
  if (!source || source.storeId !== spec.storeId || source.provider !== 'ONE_C' || source.sourceState !== 'ACTIVE' || !source.enabled) fail('source_not_active_onec');
  if (await tx.integrationJob.count({ where: { connectionId: source.id, status: 'RUNNING' } })) fail('source_has_running_jobs');
  const changes = [], material = [], replacements = [];
  for (const mapping of [...spec.channels].sort((a, b) => a.code.localeCompare(b.code))) {
    const channel = await tx.fulfillmentChannel.findUnique({ where: { storeId_code: { storeId: spec.storeId, code: mapping.code } } });
    if (!channel) fail(`channel_not_found:${mapping.code}`);
    const ref = await tx.externalReference.findUnique({ where: { connectionId_entityType_externalId: { connectionId: source.id, entityType: 'location', externalId: mapping.warehouseExternalId } } });
    if (!ref) fail(`warehouse_mapping_missing:${mapping.code}`);
    const target = await tx.inventoryLocation.findUnique({ where: { id: ref.entityId } });
    if (!target || target.storeId !== spec.storeId || target.code !== mapping.locationCode) fail(`warehouse_mapping_mismatch:${mapping.code}`);
    const stocks = await tx.stock.findMany({ where: { locationId: target.id }, orderBy: { variantId: 'asc' }, include: { variant: { select: { sku: true, storeId: true } } } });
    if (stocks.some(row => row.variant.storeId !== spec.storeId)) fail('cross_store_stock');
    const previous = await tx.availabilityProjection.findMany({ where: { fulfillmentChannelId: channel.id }, orderBy: { variantId: 'asc' } });
    const bySku = new Map(stocks.map(row => [row.variant.sku, row]));
    const controls = mapping.controls.map(control => {
      const row = bySku.get(control.sku);
      if (!row) fail(`control_stock_missing:${mapping.code}:${control.sku}`);
      if (!row.available.equals(new Prisma.Decimal(control.available))) fail(`control_stock_mismatch:${mapping.code}:${control.sku}`);
      return { sku: control.sku, expected: new Prisma.Decimal(control.available).toString(), actual: row.available.toString() };
    });
    const expectedRows = stocks.map(projectShape), previousRows = previous.map(projectShape);
    const changed = channel.inventoryLocationId !== target.id || hash(previousRows) !== hash(expectedRows);
    changes.push({ channelId: channel.id, code: channel.code, warehouseExternalId: mapping.warehouseExternalId,
      beforeLocationId: channel.inventoryLocationId, afterLocationId: target.id, afterLocationCode: target.code,
      projectionsBefore: previous.length, projectionsAfter: stocks.length, changed, controls });
    material.push({ channelId: channel.id, beforeLocationId: channel.inventoryLocationId, targetId: target.id, warehouseExternalId: mapping.warehouseExternalId, previousRows, expectedRows });
    replacements.push({ channelId: channel.id, targetId: target.id, changed, rows: expectedRows });
  }
  const plan = { schemaVersion: 1, storeId: spec.storeId, connectionId: source.id, environment: source.environment, changes,
    digest: hash({ spec, source: { id: source.id, environment: source.environment, sourceState: source.sourceState }, material }) };
  return { plan, replacements };
}

async function main() {
  const args = process.argv.slice(2);
  const filename = args.shift();
  if (!filename || args.some(arg => arg !== '--dry-run' && arg !== '--apply' && !arg.startsWith('--expected-digest=')) || (args.includes('--dry-run') && args.includes('--apply'))) {
    fail('usage: node scripts/correct-warehouse-channels.mjs plan.json [--dry-run | --apply --expected-digest=SHA256]');
  }
  const apply = args.includes('--apply');
  const expectedDigest = args.find(arg => arg.startsWith('--expected-digest='))?.split('=')[1];
  if (apply) {
    assertTestDatabase(); // R08 is a rehearsal; production rollout belongs to R40.
    if (!expectedDigest || !/^[0-9a-f]{64}$/.test(expectedDigest)) fail('reviewed_digest_required');
  }
  const spec = schema.parse(JSON.parse(fs.readFileSync(filename, 'utf8')));
  const db = new PrismaClient();
  try {
    const result = await db.$transaction(async tx => {
      if (!apply) await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const { plan, replacements } = await preview(tx, spec);
      if (!apply) return { mode: 'dry-run', ...plan };
      if (plan.environment !== 'TEST') fail('apply_requires_test_source');
      if (plan.digest !== expectedDigest) fail('stale_preview');
      for (const replacement of replacements) {
        if (!replacement.changed) continue;
        await tx.fulfillmentChannel.update({ where: { id: replacement.channelId }, data: { inventoryLocationId: replacement.targetId } });
        // Replace the projection atomically with the channel link. Entries from
        // the previous warehouse must disappear, including SKUs absent here.
        await tx.availabilityProjection.deleteMany({ where: { fulfillmentChannelId: replacement.channelId } });
        for (let offset = 0; offset < replacement.rows.length; offset += 500) {
          await tx.availabilityProjection.createMany({ data: replacement.rows.slice(offset, offset + 500).map(row => ({ ...row, fulfillmentChannelId: replacement.channelId })) });
        }
        const actual = await tx.availabilityProjection.findMany({ where: { fulfillmentChannelId: replacement.channelId }, orderBy: { variantId: 'asc' } });
        if (hash(actual.map(projectShape)) !== hash(replacement.rows)) fail('projection_verification_failed');
      }
      if (replacements.some(r => r.changed)) await tx.auditEntry.create({ data: { storeId: spec.storeId, action: 'WarehouseChannelsCorrected', targetType: 'IntegrationConnection', targetId: spec.connectionId,
        summary: 'R08 reviewed test warehouse correction', metadata: { digest: plan.digest, changes: plan.changes } } });
      return { mode: 'applied', ...plan };
    }, { isolationLevel: 'Serializable', timeout: 120_000 });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally { await db.$disconnect(); }
}
main().catch(error => { process.stderr.write(JSON.stringify({ error: error instanceof z.ZodError ? 'invalid_plan' : error.message }) + '\n'); process.exitCode = 1; });
