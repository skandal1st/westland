'use client'

import { productStatusLabel } from '@/lib/status-labels'
import { useState } from 'react'
import { useRemoteResource } from '@/lib/use-remote-resource'

type Product = {
  id: string
  canonicalName: string
  status: string
  displayName: string | null
  slug: string | null
  description: string
  sku: string | null
  sourceSku?: string | null
}

const decodeProducts = (value: unknown) => value as { products: Product[]; total: number }
export function CatalogAdminPanel() {
  const [page, setPage] = useState(0)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const { data, loading, error: loadError, reload: load } = useRemoteResource('/api/staff/products?take=50&skip=' + page * 50 + '&q=' + encodeURIComponent(search), decodeProducts)
  const products = data?.products ?? []
  const total = data?.total ?? 0
  const [editing, setEditing] = useState<Product | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!editing) return
    setSaving(true)
    setError(null)
    const form = new FormData(event.currentTarget)
    try {
    const response = await fetch(`/api/staff/products/${editing.id}/content`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: String(form.get('displayName') ?? ''),
        slug: String(form.get('slug') ?? ''),
        description: String(form.get('description') ?? ''),
      }),
    })
    if (response.ok) {
      setEditing(null)
      await load()
    } else {
      const data = await response.json().catch(() => ({}))
      setError(data.error === 'SLUG_TAKEN' ? 'Такой адрес страницы уже используется.' : 'Не удалось сохранить.')
    }
    } catch { setError('Нет связи с сервером. Повторите сохранение.') } finally { setSaving(false) }
  }


  return (
    <div className="moderation-list">
      <form className="admin-toolbar" onSubmit={e => { e.preventDefault(); setSearch(query.trim()); setPage(0); setEditing(null) }}>
        <label>Поиск по всему каталогу<input value={query} onChange={e => setQuery(e.target.value)} placeholder="Название, артикул или код" /></label>
        <button className="button button-primary">Найти</button>
        {search ? <button type="button" className="button button-secondary" onClick={() => { setQuery(''); setSearch(''); setPage(0) }}>Сбросить</button> : null}
      </form>
      {loading ? <p role="status">Загрузка товаров…</p> : loadError ? <p role="alert">{loadError} <button onClick={load}>Повторить</button></p> : <p role="status">Найдено товаров: {total.toLocaleString('ru-RU')}. Показаны все статусы, включая архивные.</p>}
      {!loading && !loadError && !total ? <p>Товары не найдены{search ? '. Измените запрос.' : '. Загрузите каталог из 1С.'}</p> : null}
      <div className="moderation-head"><span>Каноническое имя</span><span>Витрина</span><span>Артикул / код</span><span>Действие</span></div>
      {products.map((product) => (
        <div className="moderation-row" key={product.id}>
          <span><strong>{product.canonicalName}</strong><small>{productStatusLabel(product.status)}</small></span>
          <span><strong>{product.displayName ?? '—'}</strong><small>/{product.slug ?? ''}</small></span>
          <span>{product.sourceSku ?? product.sku ?? '—'}{product.sourceSku && product.sourceSku !== product.sku ? <small style={{ overflowWrap: 'anywhere' }}>Код: {product.sku}</small> : null}</span>
          <span className="moderation-actions"><button type="button" onClick={() => { setEditing(product); setError(null) }}>Редактировать контент</button></span>
        </div>
      ))}

      {total > 50 ? <nav className="catalog-pagination" aria-label="Страницы товаров">
        <button className="button button-secondary" disabled={loading || page === 0} onClick={() => { setPage(p => p - 1); setEditing(null) }}>Назад</button>
        <span>Страница {page + 1} из {Math.ceil(total / 50)}</span>
        <button className="button button-secondary" disabled={loading || (page + 1) * 50 >= total} onClick={() => { setPage(p => p + 1); setEditing(null) }}>Далее</button>
      </nav> : null}
      {editing ? (
        <form className="auth-card" onSubmit={save} style={{ marginTop: 16 }}>
          <h2>Контент: {editing.canonicalName}</h2>
          <label>Отображаемое имя<input name="displayName" defaultValue={editing.displayName ?? editing.canonicalName} required /></label>
          <label>Адрес страницы<input name="slug" defaultValue={editing.slug ?? ''} required /></label>
          <label>Описание<textarea name="description" defaultValue={editing.description} rows={4} /></label>
          {error ? <p className="auth-error" role="alert">{error}</p> : null}
          <div className="form-row">
            <button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Сохранение…' : 'Сохранить'}</button>
            <button className="button button-secondary" type="button" onClick={() => setEditing(null)}>Отмена</button>
          </div>
        </form>
      ) : null}
    </div>
  )
}
