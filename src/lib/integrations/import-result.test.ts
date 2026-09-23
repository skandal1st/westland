import { expect, it } from 'vitest'
import { classifyImport, summarizeStages } from './import-result'
it.each([
  [{ imported: 0, failed: 2 }, 'failed'],
  [{ imported: 1, failed: 2 }, 'partial'],
  [{ imported: 0, skipped: 1, failed: 2 }, 'partial'],
  [{ imported: 0, failed: 0 }, 'success'],
])('classifies counters without calling zero import a success when rows failed', (stats, outcome) => expect(classifyImport(stats)).toBe(outcome))
it('removed records count as progress when a later stage fails', () => {
  expect(summarizeStages([{ type: 'catalog.import', status: 'succeeded', outcome: 'success', stats: { imported: 0, removed: 3, failed: 0 } }, { type: 'prices.import', status: 'failed', outcome: 'failed' }])).toBe('partial')
})
