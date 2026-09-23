'use client'
import { useState } from 'react'
import { readArray, useRemoteResource } from '@/lib/use-remote-resource'
type Product = { id: string; canonicalName: string; displayName: string | null; sourceSku: string | null; status: string }
const decode = (v: unknown) => readArray<Product>(v, 'products')
export function StaffProductPicker({ value, onChange, label }: { value?: string; onChange: (id?: string) => void; label: string }) {
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(!value)
  const resource = useRemoteResource('/api/staff/products?take=20&' + (!open && value ? 'id=' + encodeURIComponent(value) : 'q=' + encodeURIComponent(search)), decode)
  return <div className="staff-product-picker">
    <label>{label}<input value={query} placeholder={value && !open ? resource.data?.[0]?.displayName ?? resource.data?.[0]?.canonicalName ?? 'Выбран товар' : 'Название или артикул'} onChange={e => setQuery(e.target.value)} /></label>
    <button type="button" onClick={() => { setSearch(query.trim()); setOpen(true) }}>Найти товар</button>
    {value ? <button type="button" onClick={() => { onChange(undefined); setOpen(true) }}>Снять выбор</button> : null}
    {resource.loading ? <p role="status">Загрузка товаров…</p> : resource.error ? <p role="alert">{resource.error}</p> : open ? <div className="staff-product-results">{resource.data?.filter(p => p.status === 'ACTIVE').map(p => <button type="button" key={p.id} onClick={() => { onChange(p.id); setQuery(''); setOpen(false) }}>{p.displayName ?? p.canonicalName}<small>{p.sourceSku}</small></button>)}{!resource.data?.length ? <p>Товары не найдены.</p> : <small>Первые 20 совпадений. Уточните запрос, чтобы найти нужный товар.</small>}</div> : null}
  </div>
}
