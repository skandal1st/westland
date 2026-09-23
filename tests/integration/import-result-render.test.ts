import { expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ImportResult } from '@/components/ImportResult'
it('renders all three stages, partial result, rejection reason and blocked stage', () => {
  const html = renderToStaticMarkup(createElement(ImportResult, { report: { runId: 'run', generationId: null, outcome: 'partial', results: [
    { type: 'catalog.import', status: 'succeeded', outcome: 'success', stats: { imported: 2, failed: 0 } },
    { type: 'prices.import', status: 'failed', outcome: 'failed', message: 'price_currency_mismatch', stats: { imported: 0, failed: 1 } },
    { type: 'availability.import', status: 'skipped', outcome: 'skipped', message: 'previous_stage_incomplete' },
  ] } }))
  for (const text of ['Выполнено частично', 'Каталог', 'Цены', 'Остатки', 'Валюта 1С', 'Предыдущий этап', 'Не запускалось']) expect(html).toContain(text)
  expect(html).not.toContain('Завершено успешно')
})

it('explains successful catalog-deletion reconciliation without hiding excluded rows', () => {
  const html = renderToStaticMarkup(createElement(ImportResult, { report: { runId: 'run', generationId: 'gen', outcome: 'success', results: [
    { type: 'availability.import', status: 'succeeded', outcome: 'success', stats: { imported: 87865, failed: 0, skipped: 2235, catalogDeleted: 447, unknownDeleted: 21 } },
  ] } }))
  for (const text of ['Завершено успешно', 'Исключено по удалению в каталоге', '447', 'Удалённых товаров без локальной записи', '21', '2235']) expect(html).toContain(text)
})
