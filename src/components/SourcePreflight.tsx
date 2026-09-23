'use client'
import { useState } from 'react'
import type { SourcePreflightReport } from '@/lib/integrations/preflight'

const reasons: Record<string, string> = {
  candidate_not_preparing: 'Для перехода нужен отключённый профиль в состоянии подготовки.',
  source_environment_required: 'Укажите среду источника.',
  expired_incomplete_uploads: 'Есть незавершённые загрузки с истёкшей сессией; они не входят в выбранный набор.',
  incomplete_uploads: 'Есть незавершённые загрузки файлов источника.',
  generation_required: 'Выберите зафиксированный набор файлов.',
  generation_source_changed: 'Набор относится к другому источнику или устаревшей версии профиля.',
  generation_streams_incomplete: 'В наборе нужны каталог и предложения.',
  full_generation_required: 'Для перехода нужна полная выгрузка каталога, цен и остатков.',
  full_scope_required: 'Не перечислены типы цен или склады полной выгрузки.',
  generation_manifest_invalid: 'Повреждён состав зафиксированного набора.',
  generation_file_integrity_failed: 'Содержимое файла не совпадает с сохранённым хешем.',
  generation_unreadable_or_invalid: 'Не удалось прочитать или разобрать XML набора.',
  generation_timestamps_differ: 'Время формирования каталога и предложений различается.',
  source_timestamp_unknown: 'Время источника неизвестно; свежесть остатков не подтверждена.',
  mapping_target_not_found: 'Соответствие ссылается на отсутствующий объект или другой магазин.',
  product_source_conflict: 'Товар уже связан с другим источником.',
  seller_requisites_invalid: 'Реквизиты продавца не заполнены.',
  channel_mapping_missing: 'Для активного канала не настроено соответствие.',
  channel_mappings_incomplete: 'Проверьте склад, тип цены и продавца канала.',
  channel_scope_missing: 'Склад или тип цены канала отсутствует в выгрузке.',
  active_channels_missing: 'Нет активных каналов продаж.',
  price_type_unmapped: 'Не сопоставлен тип цены.',
  warehouse_unmapped: 'Не сопоставлен склад.',
  unfinished_jobs: 'Есть незавершённые или требующие разбора задания.',
  unfinished_runs: 'Есть незавершённые синхронизации.',
  unfinished_checkpoints: 'Есть незавершённые этапы импорта.',
  unfinished_orders: 'Есть незавершённые заказы.',
  unfinished_exports: 'Есть незавершённые выгрузки заказов.',
  duplicate_product_identity: 'В каталоге повторяется внешний ID.',
  duplicate_offer_identity: 'В предложениях повторяется внешний ID.',
  variant_identity_ambiguous: 'У товара неоднозначный основной вариант.',
  source_identity_sku_conflict: 'Занят внутренний SKU, вычисленный для нового товара.',
  offer_product_missing_from_catalog: 'Предложение отсутствует в полном каталоге.',
  duplicate_source_value: 'Повторяется цена или остаток одной позиции.',
  value_outside_full_scope: 'Значение выходит за объявленную область полной выгрузки.',
  invalid_source_number: 'Некорректное числовое значение.',
  source_number_precision: 'Превышена допустимая точность цены или остатка.',
  price_currency_mismatch: 'Валюта цены не совпадает с прайс-листом.',
  price_source_conflict: 'Цена принадлежит другому источнику или не имеет владельца.',
  stock_source_conflict: 'Остаток принадлежит другому источнику или не имеет владельца.',
  catalog_tombstone_precedes_offer: 'Удаление в каталоге имеет приоритет над предложением этого набора.',
  identities_kept_separate: 'Совпадающие артикулы и ID сохраняются как отдельные товары разных источников.',
  preflight_size_limit: 'Набор превышает лимит проверки 512 МБ.',
  preflight_row_limit: 'Набор превышает лимит проверки 100 000 товаров или предложений.',
}
const changes = { new: 'Новый', changed: 'Изменён', unchanged: 'Без изменений', deleted: 'Удаление', absent: 'Нет в полном каталоге' }

export function SourcePreflight({ connectionId, generationId }: { connectionId: string; generationId?: string }) {
  const [report, setReport] = useState<SourcePreflightReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function preview() {
    setBusy(true); setReport(null); setMessage('')
    try {
      const response = await fetch(`/api/staff/integrations/${connectionId}/preflight`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ generationId }),
      })
      if (!response.ok) { setMessage('Проверка не выполнена. Нужны права администратора и доступный источник.'); return }
      setReport(await response.json())
    } catch { setMessage('Не удалось получить отчёт. Повторите проверку.') }
    finally { setBusy(false) }
  }
  function download() {
    if (!report) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a'); a.href = url; a.download = `source-preflight-${report.source.id}.json`; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <section style={{ gridColumn: '1 / -1', minWidth: 0, overflowWrap: 'anywhere' }} aria-label="Проверка перехода">
    <p>Выберите полный набор в разделе «Файлы обмена», затем проверьте переход. Отчёт не активирует источник.</p>
    <button type="button" disabled={busy} onClick={preview}>{busy ? 'Проверка…' : 'Проверить переход'}</button>
    {message ? <p role="alert">{message}</p> : null}
    {report ? <div>
      <p role="status"><strong>{report.dataReady ? 'Проверка данных пройдена.' : 'Переход заблокирован: есть замечания.'}</strong> Источник не активирован. Для переключения ещё нужны резервная копия, остановка записи и завершение процедуры перехода.</p>
      <p>Проверено: {new Date(report.checkedAt).toLocaleString('ru-RU')}. Отчёт отражает состояние на этот момент; после изменений запустите проверку снова.</p>
      <p>Новых товаров: {report.summary.new}; изменённых: {report.summary.changed}; удалений: {report.summary.deleted}; цен: {report.summary.priceRows}; остатков: {report.summary.stockRows}; отрицательных: {report.summary.negativeStocks}.</p>
      <p>В текущих данных тестовых цен: {report.testData.prices}, остатков: {report.testData.stocks}. Без владельца: {report.unowned.prices} цен и {report.unowned.stocks} остатков.</p>
      {report.blockers.length ? <ul>{report.blockers.map(b => <li key={b.code}><strong>{reasons[b.code] ?? b.code}</strong> ({b.count}){b.examples.length ? <small> {b.examples.join('; ')}</small> : null}</li>)}</ul> : null}
      {report.warnings.length ? <details><summary>Предупреждения ({report.warnings.length})</summary><ul>{report.warnings.map(b => <li key={b.code}>{reasons[b.code] ?? b.code} ({b.count})</li>)}</ul></details> : null}
      <details><summary>Товары и совпадения</summary>
        <p>Совпадений SKU/ID: {report.collisions.length}. Ниже первые 100 товаров; полный перечень и значения доступны в JSON.</p>
        <div style={{ overflowX: 'auto' }}><table><thead><tr><th>Товар</th><th style={{ whiteSpace: "nowrap" }}>Артикул</th><th style={{ whiteSpace: "nowrap" }}>Изменение</th></tr></thead><tbody>{report.products.slice(0, 100).map(p => <tr key={p.externalId}><td>{p.name || p.externalId}</td><td>{p.sourceSku}</td><td>{changes[p.change]}</td></tr>)}</tbody></table></div>
      </details>
      <button type="button" onClick={download}>Скачать полный отчёт JSON</button>
    </div> : null}
  </section>
}
