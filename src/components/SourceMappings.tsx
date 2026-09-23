'use client'
import { useState, type FormEvent } from 'react'
type Choice = { id: string; name: string; code: string; currency?: string }
type Data = { mappings: { entityType: string; externalId: string; entityId: string; details?: Record<string, unknown> }[]; locations: Choice[]; priceBooks: Choice[]; channels: Choice[] }
const labels: Record<string, string> = { priceType: 'Тип цены', location: 'Склад', seller: 'Продавец', customer: 'Контрагент CommerceML', edCustomer: 'Контрагент EnterpriseData', product: 'Товар', channel: 'Канал' }
const errors: Record<string, string> = { source_jobs_pending: 'Дождитесь завершения задач источника перед изменением соответствий.', mapping_target_in_use: 'Объект уже связан с другим кодом в этом источнике.', mapping_target_not_found: 'Объект не найден в текущем магазине.', product_source_conflict: 'Этот товар уже принадлежит другому источнику.', source_retired: 'Архивный источник нельзя изменять.' }
export function SourceMappings({ connectionId }: { connectionId: string }) {
  const [data, setData] = useState<Data | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const [kind, setKind] = useState('priceType'), [externalId, setExternalId] = useState(''), [entityId, setEntityId] = useState('')
  const [sellerName, setSellerName] = useState(''), [sellerInn, setSellerInn] = useState('')
  const [vatEnabled, setVatEnabled] = useState(false), [vatRate, setVatRate] = useState('')
  const [channelMapping, setChannelMapping] = useState({ channelId: '', warehouseExternalId: '', priceTypeExternalId: '', sellerExternalId: '' })
  const url = `/api/staff/integrations/${connectionId}/mappings`
  async function load() { const response = await fetch(url); if (!response.ok) throw new Error(); setData(await response.json()) }
  async function open() { setBusy(true); setMessage(''); try { await load() } catch { setMessage('Соответствия не загружены. Повторите запрос.') } finally { setBusy(false) } }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage('')
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entityType: kind, externalId, entityId, ...(kind === 'seller' ? { seller: { ...data?.mappings.find(m => m.entityType === 'seller' && m.externalId === externalId)?.details, companyName: sellerName, inn: sellerInn, vatEnabled, ...(vatEnabled ? { vatRate: Number(vatRate) } : {}) } } : {}) }) })
      const result = await response.json()
      if (!response.ok) { setMessage(errors[result.error] ?? 'Соответствие не сохранено. Проверьте значения и права администратора.'); return }
      await load(); setMessage('Соответствие сохранено для этого источника.')
    } catch { setMessage('Не удалось связаться с сервером.') } finally { setBusy(false) }
  }
  async function saveChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage('')
    try {
      const response = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(channelMapping) })
      const result = await response.json()
      if (!response.ok) { setMessage(errors[result.error] ?? 'Канал не настроен. Проверьте все соответствия и права администратора.'); return }
      await load(); setMessage(result.applied ? 'Настройки применены к каналу активного источника.' : 'Настройки сохранены для будущей активации этого источника.')
    } catch { setMessage('Не удалось связаться с сервером.') } finally { setBusy(false) }
  }
  const choices = kind === 'priceType' ? data?.priceBooks : kind === 'location' ? data?.locations : kind === 'seller' ? data?.channels : null
  return <div style={{ gridColumn: '1 / -1' }}>
    <button type="button" onClick={open} disabled={busy}>Соответствия источника</button>
    {data ? <div>
      <p>Код из 1С связывается с объектом магазина только в этом профиле. При смене склада или прайс-листа прежние импортированные значения снимаются до следующей синхронизации.</p>
      <form onSubmit={save}>
        <label>Вид соответствия <select value={kind} onChange={e => { setKind(e.target.value); setEntityId('') }}>{Object.entries(labels).filter(([k]) => k !== 'channel').map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label>Код (GUID) в 1С <input required value={externalId} onChange={e => {
          setExternalId(e.target.value)
          const previous = data.mappings.find(m => m.entityType === 'seller' && m.externalId === e.target.value)
          if (kind === 'seller' && previous?.details) { setEntityId(previous.entityId); setSellerName(String(previous.details.companyName ?? '')); setSellerInn(String(previous.details.inn ?? '')); setVatEnabled(previous.details.vatEnabled === true); setVatRate(String(previous.details.vatRate ?? '')) }
        }} /></label>
        <label>Объект магазина {choices ? <select required value={entityId} onChange={e => setEntityId(e.target.value)}><option value="">Выберите объект</option>{choices.map(c => <option key={c.id} value={c.id}>{c.name} ({c.code}){c.currency ? ` · ${c.currency}` : ''}</option>)}</select> : <input required placeholder="ID объекта магазина" value={entityId} onChange={e => setEntityId(e.target.value)} />}</label>
        {kind === 'seller' ? <><label>Название продавца <input required value={sellerName} onChange={e => setSellerName(e.target.value)} /></label><label>ИНН продавца <input required value={sellerInn} onChange={e => setSellerInn(e.target.value)} /></label><label><input type="checkbox" checked={vatEnabled} onChange={e => setVatEnabled(e.target.checked)} />Продавец применяет НДС</label>{vatEnabled ? <label>Ставка НДС, % <input required type="number" min="0" max="100" value={vatRate} onChange={e => setVatRate(e.target.value)} /></label> : null}</> : null}
        <button disabled={busy} type="submit">Сохранить соответствие</button>
      </form>
      <form onSubmit={saveChannel}>
        <p>Связать канал со складом, прайс-листом и продавцом этого источника. Для активного источника настройки применяются сразу; для подготовительного сохраняются до активации.</p>
        <label>Канал <select required value={channelMapping.channelId} onChange={e => setChannelMapping(v => ({ ...v, channelId: e.target.value, sellerExternalId: '' }))}><option value="">Выберите канал</option>{data.channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        {([{ key: 'warehouseExternalId', kind: 'location', label: 'Склад 1С' }, { key: 'priceTypeExternalId', kind: 'priceType', label: 'Тип цены 1С' }, { key: 'sellerExternalId', kind: 'seller', label: 'Продавец 1С' }] as const).map(field => <label key={field.key}>{field.label} <select required value={channelMapping[field.key]} onChange={e => setChannelMapping(v => ({ ...v, [field.key]: e.target.value }))}><option value="">Выберите соответствие</option>{data.mappings.filter(m => m.entityType === field.kind).map(m => <option key={m.externalId} value={m.externalId}>{m.externalId}</option>)}</select></label>)}
        <button type="submit" disabled={busy}>Сохранить настройки канала</button>
      </form>
      <table><thead><tr><th>Вид</th><th>Код 1С</th><th>Объект магазина</th></tr></thead><tbody>{data.mappings.map(m => <tr key={`${m.entityType}:${m.externalId}`}><td>{labels[m.entityType]}</td><td>{m.externalId}</td><td>{[...data.locations, ...data.priceBooks, ...data.channels].find(c => c.id === m.entityId)?.name ?? m.entityId}</td></tr>)}</tbody></table>
      {!data.mappings.length ? <p>Соответствий пока нет.</p> : null}
    </div> : null}
    {message ? <p role="status">{message}</p> : null}
  </div>
}
