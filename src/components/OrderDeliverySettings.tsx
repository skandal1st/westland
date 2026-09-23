'use client'
import { useState, type FormEvent } from 'react'
type State = { config: { enabled: boolean; format?: string; timeZone?: string; numberPrefix?: string; partnerAssignment?: 'TEST_PROCESSOR_V1' }; environment: string; pending: number; delivered: number; numberPrefix?: string; prefixFrozen: boolean; editable: boolean }
export function OrderDeliverySettings({ connectionId }: { connectionId: string }) {
  const [state, setState] = useState<State | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const [format, setFormat] = useState('ENTERPRISEDATA_1_20'), [enabled, setEnabled] = useState(false), [prefix, setPrefix] = useState('AX')
  const url = '/api/staff/integrations/' + connectionId + '/order-delivery'
  async function load() {
    const response = await fetch(url)
    if (!response.ok) throw new Error('load')
    const data: State = await response.json(); setState(data)
    setEnabled(data.config.enabled); setFormat(data.config.format ?? 'ENTERPRISEDATA_1_20'); setPrefix(data.numberPrefix ?? data.config.numberPrefix ?? 'AX')
  }
  async function open() { setBusy(true); setMessage(''); try { await load() } catch { setMessage('Не удалось загрузить настройки отправки.') } finally { setBusy(false) } }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('')
    try {
      const config = enabled ? { enabled: true, format, currency: 'RUB', timeZone: state?.config.timeZone ?? 'Europe/Moscow', ...(format === 'ENTERPRISEDATA_1_20' ? { numberPrefix: prefix } : {}) } : { enabled: false }
      const response = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) })
      const result = await response.json()
      if (!response.ok) { setMessage(result.error === 'sale_receipts_pending' ? 'Сначала завершите отправку заказов, ожидающих подтверждения 1С.' : result.error === 'ed_partner_processor_retired' ? 'Назначение точки обработкой отключено. Обновите страницу: точка передаётся в комментарии заказа.' : result.error === 'ed_number_prefix_frozen' ? 'Префикс уже используется в отправленных заказах и не может быть изменён.' : 'Настройки не сохранены. Проверьте права и значения.'); return }
      await load(); setMessage('Настройки отправки сохранены.')
    } catch { setMessage('Не удалось связаться с сервером.') } finally { setBusy(false) }
  }
  return <div style={{ gridColumn: '1 / -1' }}>
    <button type="button" onClick={open} disabled={busy}>Отправка заказов в 1С</button>
    {state ? <form onSubmit={save}>
      <fieldset disabled={busy || !state.editable}>
        <legend>Формат заказов</legend>
        <label><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Отправлять подтверждённые покупателем заказы</label>
        <label>Формат <select value={format} onChange={e => setFormat(e.target.value)}><option value="ENTERPRISEDATA_1_20">EnterpriseData 1.20</option><option value="COMMERCEML_2_10">CommerceML 2.10</option></select></label>
        {format === 'ENTERPRISEDATA_1_20' ? <><label>Префикс номера <input value={prefix} onChange={e => setPrefix(e.target.value.toUpperCase())} pattern="[A-Z]{2}" maxLength={2} required disabled={state.prefixFrozen} /></label>
          <p>Контрагент, склад, товары, цены и НДС передаются из подтверждённого заказа. Название точки и способ оплаты указаны в комментарии, адрес — в поле доставки. Клиента и соглашение определяет 1С по контрагенту. Дополнительная обработка назначения точки не требуется.</p>
          <p>Ожидают подтверждения 1С: {state.pending}. Доставлено: {state.delivered}. Подтверждение доставки не означает согласование заказа менеджером.</p>
        </> : null}
        <button type="submit" disabled={busy}>Сохранить отправку заказов</button>
      </fieldset>
    </form> : null}
    {message ? <p role="status">{message}</p> : null}
  </div>
}
