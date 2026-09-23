import { expect, it } from 'vitest'
import type { Prisma } from '@prisma/client'
import { assertDraftFresh, DRAFT_TTL_MS } from './draft'

it.each([-1, 0, 1])('evaluates the exact TTL boundary using database time: offset %s ms', async offset => {
  const createdAt = new Date('2026-09-20T10:00:00.000Z')
  const now = new Date(createdAt.getTime() + DRAFT_TTL_MS + offset)
  const tx = { $queryRaw: async () => [{ now }] } as unknown as Prisma.TransactionClient
  const result = assertDraftFresh(tx, createdAt)
  if (offset < 0) expect(await result).toEqual(now)
  else await expect(result).rejects.toMatchObject({ code: 'DRAFT_EXPIRED' })
})
