'use client'
import { useState } from 'react'
import { useRemoteResource } from '@/lib/use-remote-resource'

type Block = { id: string; title: string | null; body: unknown; isActive: boolean } | null
type Draft = { title: string; text: string; ctaLabel: string; ctaHref: string; isActive: boolean }
const fallback: Draft = { title: 'О компании', text: 'Расскажите покупателям о компании, ассортименте и условиях сотрудничества.', ctaLabel: 'Стать партнёром', ctaHref: '/register', isActive: true }
const decode = (value: unknown) => (value as { block?: Block }).block ?? null
function toDraft(block: Block): Draft {
  const body = block?.body && typeof block.body === 'object' ? block.body as Record<string, unknown> : {}
  return block ? { title: block.title ?? fallback.title, text: typeof body.text === 'string' ? body.text : fallback.text, ctaLabel: typeof body.ctaLabel === 'string' ? body.ctaLabel : '', ctaHref: typeof body.ctaHref === 'string' ? body.ctaHref : '', isActive: block.isActive } : fallback
}

export function HomeContentEditor() {
  const resource = useRemoteResource('/api/staff/content/home', decode)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const save = async (value: Draft) => {
    setBusy(true); setMessage('')
    try {
      const response = await fetch('/api/staff/content/home', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
      if (!response.ok) throw new Error('Проверьте заголовок, текст и ссылку блока.')
      setDraft(null); setMessage('Блок главной страницы сохранён.'); await resource.reload()
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Нет связи с сервером.') }
    finally { setBusy(false) }
  }
  const patch = (value: Partial<Draft>) => setDraft(current => current ? { ...current, ...value } : current)
  const current = toDraft(resource.data ?? null)
  return <section className="home-content-admin">
    <div className="admin-section-heading"><div><h2>Описание компании и CTA</h2><p className="settings-note">Этот редакционный блок завершает главную страницу. Кнопку можно убрать, оставив её поля пустыми.</p></div>{!draft ? <button className="button button-secondary" disabled={resource.loading || Boolean(resource.error)} onClick={() => { setDraft(current); setMessage('') }}>{resource.data ? 'Редактировать блок' : 'Настроить блок'}</button> : null}</div>
    {message ? <p role="status">{message}</p> : null}
    {resource.loading ? <p role="status">Загрузка блока…</p> : resource.error ? <p role="alert">{resource.error} <button onClick={resource.reload}>Повторить</button></p> : null}
    {!draft && resource.data ? <div className="home-content-admin-summary"><strong>{current.title}</strong><p>{current.text}</p><small>{current.isActive ? 'Показывается на главной' : 'Скрыт'}{current.ctaLabel ? ' · Кнопка: ' + current.ctaLabel : ''}</small></div> : null}
    {draft ? <form className="admin-banner-form" onSubmit={event => { event.preventDefault(); void save(draft) }}>
      <h3>Блок на главной</h3><fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
        <label>Заголовок<input required maxLength={160} value={draft.title} onChange={event => patch({ title: event.target.value })} /></label>
        <label>Текст<textarea required rows={6} maxLength={1800} value={draft.text} onChange={event => patch({ text: event.target.value })} /></label>
        <label>Текст кнопки<input maxLength={80} value={draft.ctaLabel} onChange={event => patch({ ctaLabel: event.target.value })} /></label>
        <label>Ссылка кнопки<input maxLength={500} placeholder="/register или https://…" value={draft.ctaHref} onChange={event => patch({ ctaHref: event.target.value })} /></label>
        <label className="admin-check"><input type="checkbox" checked={draft.isActive} onChange={event => patch({ isActive: event.target.checked })} />Показывать блок на главной</label>
        <div className="admin-toolbar"><button className="button button-primary">Сохранить блок</button><button type="button" className="button button-secondary" onClick={() => setDraft(null)}>Отмена</button></div>
      </fieldset>
    </form> : null}
  </section>
}
