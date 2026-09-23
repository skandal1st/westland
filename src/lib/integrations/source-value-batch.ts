import { Prisma } from '@prisma/client'
import { IntegrationInputError as InputError } from './errors'

export type SourceValue = { variantId: string; targetId: string; scope: string; amount: number }

/** Runs inside the authoritative import transaction. Staging avoids per-tuple queries and unbounded IN lists. */
export async function applySourceValues(tx: Prisma.TransactionClient, input: {
  connectionId: string; generationId: string; stream: 'prices' | 'availability'; rows: SourceValue[]
  deleted: string[]; fullScope: string[]; sourceUpdatedAt: Date | null
}) {
  const price = input.stream === 'prices'
  const table = Prisma.raw(price ? '"PriceEntry"' : '"Stock"')
  const target = Prisma.raw(price ? '"priceBookId"' : '"locationId"')
  const conflict = price ? 'price_source_conflict' : 'stock_source_conflict'
  await tx.$executeRaw`CREATE TEMP TABLE "SourceValueStage" (
    "variantId" text NOT NULL, "targetId" text NOT NULL, scope text NOT NULL, amount numeric NOT NULL,
    PRIMARY KEY ("variantId", "targetId")
  ) ON COMMIT DROP`
  for (let i = 0; i < input.rows.length; i += 1000) {
    await tx.$executeRaw`INSERT INTO "SourceValueStage" SELECT * FROM jsonb_to_recordset(${JSON.stringify(input.rows.slice(i, i + 1000))}::jsonb)
      AS r("variantId" text, "targetId" text, scope text, amount numeric)`
  }
  await tx.$executeRaw`ANALYZE "SourceValueStage"`
  const foreign = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT t.id FROM ${table} t JOIN "SourceValueStage" s ON t."variantId" = s."variantId" AND t.${target} = s."targetId"
    WHERE t."sourceConnectionId" IS DISTINCT FROM ${input.connectionId} LIMIT 1`)
  if (foreign.length) throw new InputError(conflict)
  // Remove only this source's old mapping of a tuple. Never claim an unowned/foreign value.
  await tx.$executeRaw(Prisma.sql`DELETE FROM ${table} t USING "SourceValueStage" s
    WHERE t."sourceConnectionId" = ${input.connectionId} AND t."variantId" = s."variantId"
      AND t."sourceScopeKey" = s.scope AND t.${target} <> s."targetId"`)
  let written: number
  if (price) {
    await tx.$executeRaw`DELETE FROM "PriceEntry" t USING "SourceValueStage" s
      WHERE s.amount = 0 AND t."variantId" = s."variantId" AND t."priceBookId" = s."targetId" AND t."sourceConnectionId" = ${input.connectionId}`
    written = await tx.$executeRaw`INSERT INTO "PriceEntry" (id, "variantId", "priceBookId", amount, "sourceConnectionId", "sourceGenerationId", "sourceScopeKey", "updatedAt")
      SELECT gen_random_uuid()::text, s."variantId", s."targetId", s.amount, ${input.connectionId}, ${input.generationId}, s.scope, CURRENT_TIMESTAMP
      FROM "SourceValueStage" s WHERE s.amount > 0 ORDER BY s."variantId", s."targetId"
      ON CONFLICT ("priceBookId", "variantId") DO UPDATE SET amount = EXCLUDED.amount,
        "sourceConnectionId" = EXCLUDED."sourceConnectionId", "sourceGenerationId" = EXCLUDED."sourceGenerationId",
        "sourceScopeKey" = EXCLUDED."sourceScopeKey", "updatedAt" = EXCLUDED."updatedAt"
      WHERE "PriceEntry"."sourceConnectionId" = ${input.connectionId}`
  } else {
    written = await tx.$executeRaw`INSERT INTO "Stock" (id, "variantId", "locationId", available, reserved, "sourceUpdatedAt", "sourceConnectionId", "sourceGenerationId", "sourceScopeKey", "updatedAt")
      SELECT gen_random_uuid()::text, s."variantId", s."targetId", s.amount, 0, ${input.sourceUpdatedAt}, ${input.connectionId}, ${input.generationId}, s.scope, CURRENT_TIMESTAMP
      FROM "SourceValueStage" s ORDER BY s."variantId", s."targetId"
      ON CONFLICT ("variantId", "locationId") DO UPDATE SET available = EXCLUDED.available,
        "sourceUpdatedAt" = EXCLUDED."sourceUpdatedAt", "sourceConnectionId" = EXCLUDED."sourceConnectionId",
        "sourceGenerationId" = EXCLUDED."sourceGenerationId", "sourceScopeKey" = EXCLUDED."sourceScopeKey", "updatedAt" = EXCLUDED."updatedAt"
      WHERE "Stock"."sourceConnectionId" = ${input.connectionId}`
  }
  if (written !== input.rows.filter(r => !price || r.amount > 0).length) throw new InputError(conflict)
  const deleted = JSON.stringify(input.deleted), scopes = JSON.stringify(input.fullScope)
  return tx.$executeRaw(Prisma.sql`DELETE FROM ${table} t WHERE t."sourceConnectionId" = ${input.connectionId} AND (
    t."variantId" IN (SELECT jsonb_array_elements_text(${deleted}::jsonb)) OR (
      t."sourceScopeKey" IN (SELECT jsonb_array_elements_text(${scopes}::jsonb)) AND NOT EXISTS (
        SELECT 1 FROM "SourceValueStage" s WHERE s."variantId" = t."variantId" AND s."targetId" = t.${target}
      )
    )
  )`)
}
