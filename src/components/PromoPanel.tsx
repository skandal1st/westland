'use client'
/* eslint-disable @next/next/no-img-element -- Staff uploads are served from a validated local image endpoint. */
import { useState } from 'react'
import { useRemoteResource, readArray } from '@/lib/use-remote-resource'
import type { GiftRule } from '@/lib/promotions/gifts'
import { StaffProductPicker } from './StaffProductPicker'
type Promotion = { id?: string; name: string; isActive: boolean; showOnHome: boolean; homeImageUrl: string | null; homeDescription: string | null; startsAt: string | null; endsAt: string | null; rule: GiftRule }
type Option = { id: string; name: string }
const decode = (v: unknown) => ({ promotions: readArray<Promotion>(v, 'promotions'), enabled: (v as { enabled?: boolean }).enabled === true })
const decodeBrands = (v: unknown) => readArray<Option>(v, 'brands')
const decodeCategories = (v: unknown) => readArray<Option>(v, 'categories')
const decodeCommerce = (v: unknown) => v as { channels: Option[]; priceGroups: Option[] }
const blank = (): Promotion => ({ name: '', isActive: false, showOnHome: false, homeImageUrl: null, homeDescription: null, startsAt: null, endsAt: null, rule: { condition: {}, reward: {}, minQty: 20, rewardQty: 1, maxRewardQty: null, channelIds: [], priceGroupIds: [] } })
const localDate = (value: string | null) => { if (!value) return ''; const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) }
export function PromoPanel() {
  const promos = useRemoteResource('/api/staff/gift-promotions', decode)
  const brands = useRemoteResource('/api/staff/brands', decodeBrands)
  const categories = useRemoteResource('/api/staff/categories', decodeCategories)
  const commerce = useRemoteResource('/api/staff/commerce', decodeCommerce)
  const [draft, setDraft] = useState<Promotion | null>(null)
  const [modes, setModes] = useState({ condition: 'FILTER', reward: 'PRODUCT' })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)
  const patch = (data: Partial<Promotion>) => setDraft(d => d ? { ...d, ...data } : d)
  const rule = (data: Partial<GiftRule>) => setDraft(d => d ? { ...d, rule: { ...d.rule, ...data } } : d)
  const facet = (key: 'condition' | 'reward', data: Partial<GiftRule['condition']>) => setDraft(d => d ? { ...d, rule: { ...d.rule, [key]: { ...d.rule[key], ...data } } } : d)
  const open = (p: Promotion) => { setDraft(p); setModes({ condition: p.rule.condition.productId ? 'PRODUCT' : 'FILTER', reward: p.rule.reward.productId ? 'PRODUCT' : 'FILTER' }); setMessage('') }
  const save = async (p: Promotion) => {
    setBusy(true); setMessage('')
    try {
      const response = await fetch('/api/staff/gift-promotions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: p.id, name: p.name, isActive: p.isActive, showOnHome: p.showOnHome, homeImageUrl: p.homeImageUrl, homeDescription: p.homeDescription, startsAt: p.startsAt, endsAt: p.endsAt, rule: p.rule }) })
      if (!response.ok) throw new Error(response.status === 403 ? 'Изменение акций доступно администратору при включённом модуле промотоваров.' : 'Проверьте условие, награду, количества и даты акции.')
      setDraft(null); setMessage('Акция сохранена. Условия проверяются в корзине и при оформлении.'); await promos.reload()
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Нет связи с сервером.') }
    finally { setBusy(false) }
  }
  const remove = async (id: string) => {
    setBusy(true)
    try { const r = await fetch('/api/staff/gift-promotions?id=' + encodeURIComponent(id), { method: 'DELETE' }); if (!r.ok) throw new Error(); setRemoving(null); await promos.reload() }
    catch { setMessage('Не удалось удалить акцию. Повторите запрос.') } finally { setBusy(false) }
  }
  const uploadHomeImage = async (file: File | undefined) => {
    if (!file) return
    if (file.size > 8 * 1024 * 1024) { setMessage('Изображение должно быть не больше 8 МБ.'); return }
    setBusy(true); setMessage('')
    try {
      const response = await fetch('/api/staff/gift-promotions/upload', { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file })
      if (!response.ok) throw new Error('Не удалось загрузить изображение. Используйте JPG, PNG или WebP до 8 МБ.')
      const result = await response.json(); patch({ homeImageUrl: result.url })
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Нет связи с сервером.') }
    finally { setBusy(false) }
  }
  const describe = (f: GiftRule['condition']) => f.productId ? 'Выбранный товар' : [brands.data?.find(b => b.id === f.brandId)?.name, categories.data?.find(c => c.id === f.categoryId)?.name, f.packaging].filter(Boolean).join(' · ')
  return <div>
    <p className="settings-note">За каждые N купленных единиц добавляем промотовар бесплатно. Например: 20 товаров бренда → 1 подарок. Можно задать конкретный подарок или группу, из которой покупатель выберет товар. Подарки не участвуют в выполнении условий других акций.</p>
    <button className="button button-primary" disabled={busy || !promos.data?.enabled} onClick={() => { setDraft(blank()); setModes({ condition: 'FILTER', reward: 'PRODUCT' }); setMessage('') }}>Добавить акцию</button>
    {promos.data && !promos.data.enabled ? <p role="status">Модуль промотоваров ещё не активирован для этого магазина. Для создания акций включите promotions в лицензии и настройках развёртывания.</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {[promos, brands, categories, commerce].map((r, i) => r.error ? <p role="alert" key={i}>{r.error} <button onClick={r.reload}>Повторить загрузку</button></p> : null)}
    {draft ? <form className="admin-banner-form" onSubmit={e => { e.preventDefault(); void save(draft) }}>
      <h2>{draft.id ? 'Редактирование акции' : 'Новая акция'}</h2>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
        <label>Название акции<input required maxLength={200} value={draft.name} onChange={e => patch({ name: e.target.value })} /></label>
        {(['condition', 'reward'] as const).map(key => <fieldset className="admin-merge" key={key}><legend>{key === 'condition' ? 'Условие покупки' : 'Промотовар в подарок'}</legend>
          <label>{key === 'condition' ? 'Что нужно купить' : 'Что добавить бесплатно'}<select value={modes[key]} onChange={e => { setModes(m => ({ ...m, [key]: e.target.value })); rule({ [key]: {} }) }}><option value="FILTER">Группа товаров</option><option value="PRODUCT">Конкретный товар</option></select></label>
          {modes[key] === 'PRODUCT' ? <StaffProductPicker key={key + (draft.id ?? 'new')} label={key === 'condition' ? 'Товар для условия' : 'Подарочный товар'} value={draft.rule[key].productId} onChange={id => facet(key, { productId: id })} /> : <>
            <label>Бренд<select value={draft.rule[key].brandId ?? ''} onChange={e => facet(key, { brandId: e.target.value || undefined })}><option value="">Любой бренд</option>{brands.data?.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
            <label>Категория<select value={draft.rule[key].categoryId ?? ''} onChange={e => facet(key, { categoryId: e.target.value || undefined })}><option value="">Любая категория</option>{categories.data?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label>Фасовка · точное название, необязательно<input value={draft.rule[key].packaging ?? ''} onChange={e => facet(key, { packaging: e.target.value || undefined })} /></label>
            <small>Выберите хотя бы один признак. Если задано несколько, товар должен соответствовать всем.</small>
          </>}
          <label>{key === 'condition' ? 'За каждые, шт.' : 'Количество в подарок, шт.'}<input required type="number" min="1" max="100000" value={key === 'condition' ? draft.rule.minQty : draft.rule.rewardQty} onChange={e => rule(key === 'condition' ? { minQty: Number(e.target.value) } : { rewardQty: Number(e.target.value) })} /></label>
        </fieldset>)}
        <label>Максимум подарков в одной заявке · необязательно<input type="number" min="1" max="100000" value={draft.rule.maxRewardQty ?? ''} onChange={e => rule({ maxRewardQty: e.target.value ? Number(e.target.value) : null })} /></label>
        <fieldset className="admin-merge"><legend>Баннер на главной</legend>
          <label className="admin-check"><input type="checkbox" checked={draft.showOnHome} onChange={e => patch({ showOnHome: e.target.checked })} />Показывать на главной</label>
          {draft.showOnHome ? <>
            <label>Короткое описание · необязательно<textarea rows={3} maxLength={300} value={draft.homeDescription ?? ''} onChange={e => patch({ homeDescription: e.target.value || null })} /></label>
            <label>Изображение баннера · JPG, PNG, WebP до 8 МБ<input type="file" accept="image/jpeg,image/png,image/webp" onChange={e => { void uploadHomeImage(e.target.files?.[0]); e.target.value = '' }} /></label>
            {draft.homeImageUrl ? <><img className="admin-banner-preview" src={draft.homeImageUrl} alt="Предпросмотр баннера акции" /><button type="button" onClick={() => patch({ homeImageUrl: null })}>Удалить изображение</button></> : <small>Без изображения акция будет показана как фирменный текстовый баннер.</small>}
          </> : null}
        </fieldset>
        <fieldset className="admin-merge"><legend>Каналы и покупатели</legend><p>Без отметок акция действует во всех каналах и ценовых группах.</p>
          {commerce.data?.channels?.map(c => <label className="admin-check" key={c.id}><input type="checkbox" checked={draft.rule.channelIds.includes(c.id)} onChange={e => rule({ channelIds: e.target.checked ? [...draft.rule.channelIds, c.id] : draft.rule.channelIds.filter(id => id !== c.id) })} />{c.name}</label>)}
          {commerce.data?.priceGroups?.map(g => <label className="admin-check" key={g.id}><input type="checkbox" checked={draft.rule.priceGroupIds.includes(g.id)} onChange={e => rule({ priceGroupIds: e.target.checked ? [...draft.rule.priceGroupIds, g.id] : draft.rule.priceGroupIds.filter(id => id !== g.id) })} />Группа: {g.name}</label>)}
        </fieldset>
        <div className="admin-toolbar"><label>Начало акции<input type="datetime-local" value={localDate(draft.startsAt)} onChange={e => patch({ startsAt: e.target.value ? new Date(e.target.value).toISOString() : null })} /></label><label>Окончание акции<input type="datetime-local" value={localDate(draft.endsAt)} onChange={e => patch({ endsAt: e.target.value ? new Date(e.target.value).toISOString() : null })} /></label></div>
        <label className="admin-check"><input type="checkbox" checked={draft.isActive} onChange={e => patch({ isActive: e.target.checked })} />Акция включена</label>
        <div className="admin-toolbar"><button className="button button-primary">Сохранить акцию</button><button type="button" className="button button-secondary" onClick={() => setDraft(null)}>Отмена</button></div>
      </fieldset>
    </form> : null}
    {promos.loading ? <p role="status">Загрузка акций…</p> : !promos.error && !promos.data?.promotions.length ? <p className="staff-placeholder">Акций пока нет. Добавьте условие покупки и промотовар.</p> : null}
    {promos.data?.promotions.map(p => <article className="admin-promo-row" key={p.id}><div><strong>{p.name}</strong><p>{p.rule.minQty} шт. ({describe(p.rule.condition)}) → {p.rule.rewardQty} шт. ({describe(p.rule.reward)})</p><small>{p.isActive ? 'Включена' : 'Выключена'}{p.showOnHome ? ' · На главной' : ''}{p.rule.maxRewardQty ? ' · Не больше ' + p.rule.maxRewardQty + ' подарков' : ''}</small></div><div className="admin-banner-actions"><button disabled={busy || !promos.data?.enabled} onClick={() => open(p)}>Редактировать</button><button disabled={busy || !promos.data?.enabled} onClick={() => save({ ...p, isActive: !p.isActive })}>{p.isActive ? 'Выключить' : 'Включить'}</button><button disabled={busy || !promos.data?.enabled} onClick={() => setRemoving(p.id!)}>Удалить</button></div>{removing === p.id ? <p>Удалить «{p.name}»? <button disabled={busy} onClick={() => remove(p.id!)}>Да, удалить</button> <button onClick={() => setRemoving(null)}>Отмена</button></p> : null}</article>)}
  </div>
}
