'use client'
/* eslint-disable @next/next/no-img-element -- Brand logos are validated staff uploads served by the application. */
import { useMemo, useState } from 'react'
import { readArray, useRemoteResource } from '@/lib/use-remote-resource'

type Brand = { id: string; name: string; slug: string; logoUrl: string | null; _count: { products: number } }
const decode = (value: unknown) => readArray<Brand>(value, 'brands')

export function BrandLogosPanel() {
  const brands = useRemoteResource('/api/staff/brands', decode)
  const [query, setQuery] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const visible = useMemo(() => (brands.data ?? []).filter(brand => brand.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [brands.data, query])
  const upload = async (brand: Brand, file: File | undefined) => {
    if (!file) return
    if (file.size > 8 * 1024 * 1024) { setMessage('Логотип должен быть не больше 8 МБ.'); return }
    setBusyId(brand.id); setMessage('')
    try {
      const response = await fetch('/api/staff/brands/' + encodeURIComponent(brand.id) + '/logo', { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file })
      if (!response.ok) throw new Error('Не удалось загрузить логотип. Используйте JPG, PNG или WebP до 8 МБ.')
      setMessage('Логотип «' + brand.name + '» сохранён.'); await brands.reload()
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Нет связи с сервером.') }
    finally { setBusyId(null) }
  }
  const remove = async (brand: Brand) => {
    setBusyId(brand.id); setMessage('')
    try {
      const response = await fetch('/api/staff/brands/' + encodeURIComponent(brand.id) + '/logo', { method: 'DELETE' })
      if (!response.ok) throw new Error('Не удалось удалить логотип.')
      setMessage('Логотип «' + brand.name + '» удалён.'); await brands.reload()
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Нет связи с сервером.') }
    finally { setBusyId(null) }
  }
  return <section className="brand-logo-admin">
    <h2>Логотипы брендов</h2>
    <p className="settings-note">Загрузите логотипы, которые будут показаны на главной. Бренды без логотипа в витрину не попадут.</p>
    <label className="admin-search">Поиск бренда<input value={query} onChange={event => setQuery(event.target.value)} placeholder="Название бренда" /></label>
    {message ? <p role="status">{message}</p> : null}
    {brands.loading ? <p role="status">Загрузка брендов…</p> : brands.error ? <p role="alert">{brands.error} <button onClick={brands.reload}>Повторить</button></p> : null}
    <div className="brand-logo-admin-list">
      {visible.map(brand => <article className="brand-logo-admin-row" key={brand.id}>
        <div className="brand-logo-admin-preview">{brand.logoUrl ? <img src={brand.logoUrl} alt="" /> : <span aria-hidden="true">{brand.name.slice(0, 2).toLocaleUpperCase()}</span>}</div>
        <div><strong>{brand.name}</strong><small>{brand._count.products} товаров</small></div>
        <div className="admin-banner-actions">
          <label className="brand-logo-upload">{brand.logoUrl ? 'Заменить' : 'Загрузить'}<input disabled={busyId === brand.id} type="file" accept="image/jpeg,image/png,image/webp" onChange={event => { void upload(brand, event.target.files?.[0]); event.target.value = '' }} /></label>
          {brand.logoUrl ? <button disabled={busyId === brand.id} onClick={() => void remove(brand)}>Удалить</button> : null}
        </div>
      </article>)}
    </div>
    {!brands.loading && !brands.error && !visible.length ? <p className="staff-placeholder">Бренды не найдены.</p> : null}
  </section>
}
