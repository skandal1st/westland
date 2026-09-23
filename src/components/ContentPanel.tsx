'use client'
/* eslint-disable @next/next/no-img-element -- Uploaded assets are served directly with their verified content type. */
import { useState } from 'react'
import { useRemoteResource, readArray } from '@/lib/use-remote-resource'
type Banner = { id: string; name: string; placement: 'HOME' | 'CATALOG'; brandId: string | null; desktopImageUrl: string | null; mobileImageUrl: string | null; linkUrl: string | null; isActive: boolean; sortOrder: number; startsAt: string | null; endsAt: string | null; brand: { name: string } | null }
type Brand = { id: string; name: string }
const decodeBanners = (v: unknown) => readArray<Banner>(v, 'banners')
const decodeBrands = (v: unknown) => readArray<Brand>(v, 'brands')
const empty = (): Omit<Banner, 'brand'> => ({ id: '', name: '', placement: 'CATALOG', brandId: null, desktopImageUrl: null, mobileImageUrl: null, linkUrl: '', isActive: true, sortOrder: 0, startsAt: null, endsAt: null })
function localDate(value: string | null) { if (!value) return ''; const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) }
export function ContentPanel() {
  const banners = useRemoteResource('/api/staff/banners', decodeBanners)
  const brands = useRemoteResource('/api/staff/brands', decodeBrands)
  const [draft, setDraft] = useState<ReturnType<typeof empty> | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)
  const patch = (value: Partial<ReturnType<typeof empty>>) => setDraft(d => d ? { ...d, ...value } : d)
  const mutate = async (url: string, method: string, data?: unknown) => {
    setBusy(true); setMessage('')
    try {
      const response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) })
      if (!response.ok) {
        const result = await response.json().catch(() => ({}))
        throw new Error(result.error === 'image_required' ? 'Загрузите основное изображение, чтобы включить баннер.' : result.error === 'invalid_dates' ? 'Окончание показа должно быть позже начала.' : response.status === 403 ? 'Нет доступа к изменению баннеров.' : 'Не удалось сохранить баннер. Проверьте поля и повторите.')
      }
      setDraft(null); setRemoving(null); setMessage(method === 'DELETE' ? 'Баннер удалён.' : 'Баннер сохранён.'); await banners.reload()
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Нет связи с сервером.') }
    finally { setBusy(false) }
  }
  const upload = async (file: File | undefined, field: 'desktopImageUrl' | 'mobileImageUrl') => {
    if (!file) return
    if (file.size > 8 * 1024 * 1024) { setMessage('Изображение должно быть не больше 8 МБ.'); return }
    setBusy(true); setMessage('')
    try {
      const response = await fetch('/api/staff/banners/upload', { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file })
      if (!response.ok) throw new Error('Не удалось загрузить изображение. Используйте JPG, PNG или WebP до 8 МБ, без анимации.')
      const result = await response.json(); patch({ [field]: result.url })
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Нет связи с сервером.') }
    finally { setBusy(false) }
  }
  return <div>
    <p className="settings-note">Рекламные баннеры на главной и в каталоге. Привяжите баннер к бренду, чтобы вести покупателя к его товарам, или укажите свою ссылку. Промотовары по условиям заказа настраиваются отдельно.</p>
    <button className="button button-primary" disabled={busy} onClick={() => { setDraft(empty()); setMessage('') }}>Добавить баннер</button>
    {message ? <p role="status">{message}</p> : null}
    {draft ? <form className="admin-banner-form" onSubmit={e => { e.preventDefault(); const { id, ...data } = draft; void mutate('/api/staff/banners' + (id ? '/' + id : ''), id ? 'PATCH' : 'POST', data) }}>
      <h2>{draft.id ? 'Редактирование баннера' : 'Новый баннер'}</h2>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
        <label>Название баннера<input required maxLength={200} value={draft.name} onChange={e => patch({ name: e.target.value })} /></label>
        <div className="admin-toolbar"><label>Где показывать<select value={draft.placement} onChange={e => patch({ placement: e.target.value as Banner['placement'] })}><option value="CATALOG">Каталог</option><option value="HOME">Главная</option></select></label>
        <label>Бренд<select value={draft.brandId ?? ''} disabled={brands.loading || !!brands.error} onChange={e => patch({ brandId: e.target.value || null })}><option value="">Общий баннер</option>{brands.data?.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label></div>
        {brands.error ? <p role="alert">{brands.error} <button type="button" onClick={brands.reload}>Загрузить бренды</button></p> : !brands.loading && !brands.data?.length ? <p>Создайте бренды во вкладке «Каталог → Бренды», отметив нужные категории 1С.</p> : null}
        <label>Основное изображение · JPG, PNG, WebP до 8 МБ<input type="file" accept="image/jpeg,image/png,image/webp" onChange={e => { void upload(e.target.files?.[0], 'desktopImageUrl'); e.target.value = '' }} /></label>
        {draft.desktopImageUrl ? <img className="admin-banner-preview" src={draft.desktopImageUrl} alt="Предпросмотр основного баннера" /> : <p>Для публикации требуется изображение. Рекомендуем горизонтальный формат 3:1.</p>}
        <label>Изображение для телефона · необязательно<input type="file" accept="image/jpeg,image/png,image/webp" onChange={e => { void upload(e.target.files?.[0], 'mobileImageUrl'); e.target.value = '' }} /></label>
        {draft.mobileImageUrl ? <><img className="admin-banner-preview" src={draft.mobileImageUrl} alt="Предпросмотр мобильного баннера" /><button type="button" onClick={() => patch({ mobileImageUrl: null })}>Использовать основное на телефоне</button></> : null}
        <label>Ссылка · необязательно<input value={draft.linkUrl ?? ''} placeholder={draft.brandId ? 'По умолчанию — товары выбранного бренда' : '/catalog'} onChange={e => patch({ linkUrl: e.target.value })} /></label>
        <div className="admin-toolbar"><label>Начало показа<input type="datetime-local" value={localDate(draft.startsAt)} onChange={e => patch({ startsAt: e.target.value ? new Date(e.target.value).toISOString() : null })} /></label><label>Окончание показа<input type="datetime-local" value={localDate(draft.endsAt)} onChange={e => patch({ endsAt: e.target.value ? new Date(e.target.value).toISOString() : null })} /></label></div>
        <label>Порядок показа<input type="number" min="0" max="100000" value={draft.sortOrder} onChange={e => patch({ sortOrder: Number(e.target.value) })} /></label>
        <label className="admin-check"><input type="checkbox" checked={draft.isActive} onChange={e => patch({ isActive: e.target.checked })} />Показывать баннер</label>
        <div className="admin-toolbar"><button type="submit" className="button button-primary" disabled={draft.isActive && !draft.desktopImageUrl}>Сохранить баннер</button><button type="button" className="button button-secondary" onClick={() => setDraft(null)}>Отмена</button></div>
      </fieldset>
      {busy ? <p role="status">Сохранение…</p> : null}
    </form> : null}
    {banners.loading ? <p role="status">Загрузка баннеров…</p> : banners.error ? <p role="alert">{banners.error} <button onClick={banners.reload}>Повторить</button></p> : !banners.data?.length ? <p className="staff-placeholder">Баннеров пока нет. Добавьте изображение для первой акции.</p> : null}
    {banners.data?.map(b => <article className="admin-banner-row" key={b.id}>
      {b.desktopImageUrl ? <img src={b.desktopImageUrl} alt={b.name} /> : <span>Без изображения</span>}
      <div><strong>{b.name}</strong><small>{b.placement === 'HOME' ? 'Главная' : 'Каталог'} · {b.brand?.name ?? 'Общий'} · {b.isActive ? 'Включён' : 'Выключен'}</small><small>{b.startsAt ? new Date(b.startsAt).toLocaleString('ru-RU') : 'Без даты начала'} — {b.endsAt ? new Date(b.endsAt).toLocaleString('ru-RU') : 'без даты окончания'}</small></div>
      <div className="admin-banner-actions"><button disabled={busy} onClick={() => { setDraft(b); setMessage('') }}>Редактировать</button><button disabled={busy} onClick={() => mutate('/api/staff/banners/' + b.id, 'PATCH', { isActive: !b.isActive })}>{b.isActive ? 'Выключить' : 'Включить'}</button><button disabled={busy} onClick={() => setRemoving(b.id)}>Удалить</button></div>
      {removing === b.id ? <div className="admin-banner-actions">Удалить «{b.name}»?<button disabled={busy} onClick={() => mutate('/api/staff/banners/' + b.id, 'DELETE')}>Да, удалить</button><button onClick={() => setRemoving(null)}>Отмена</button></div> : null}
    </article>)}
  </div>
}
