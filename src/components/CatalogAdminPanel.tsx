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
  attributes: Record<string, string>
  packaging: string | null
  manuallyEdited: boolean
  sku: string | null
  sourceSku?: string | null
}

const decodeProducts = (value: unknown) => value as { products: Product[]; total: number }

class AttributesInputError extends Error {}

function attributesText(attributes: Record<string, string>) {
  return Object.entries(attributes).map(([name, value]) => `${name}: ${value}`).join('\n')
}

function parseAttributes(value: string) {
  const lines = value.split('\n').map(line => line.trim()).filter(Boolean)
  if (lines.length > 30) throw new AttributesInputError('Можно добавить не больше 30 характеристик.')
  const attributes = Object.create(null) as Record<string, string>
  for (const line of lines) {
    const separator = line.indexOf(':')
    const name = separator < 0 ? '' : line.slice(0, separator).trim()
    const attributeValue = separator < 0 ? '' : line.slice(separator + 1).trim()
    if (!name || !attributeValue) throw new AttributesInputError(`Заполните характеристику в формате «Название: значение»: ${line}`)
    if (name.length > 80 || attributeValue.length > 500) throw new AttributesInputError('Название характеристики должно быть до 80 символов, значение — до 500.')
    attributes[name] = attributeValue
  }
  return attributes
}

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
    const attributes = parseAttributes(String(form.get('attributes') ?? ''))
    const response = await fetch(`/api/staff/products/${editing.id}/content`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: String(form.get('displayName') ?? ''),
        slug: String(form.get('slug') ?? ''),
        description: String(form.get('description') ?? ''),
        attributes,
      }),
    })
    if (response.ok) {
      setEditing(null)
      await load()
    } else {
      const data = await response.json().catch(() => ({}))
      setError(data.error === 'SLUG_TAKEN' ? 'Такой адрес страницы уже используется.' : 'Не удалось сохранить.')
    }
    } catch (cause) { setError(cause instanceof AttributesInputError ? cause.message : 'Нет связи с сервером. Повторите сохранение.') } finally { setSaving(false) }
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
          <span><strong>{product.displayName ?? '—'}</strong><small>/{product.slug ?? ''}</small>{product.manuallyEdited ? <small>Дополнено на сайте</small> : null}</span>
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
        <form className="admin-banner-form product-content-form" onSubmit={save}>
          <h2>Информация о товаре</h2>
          <p className="settings-note">Поля сайта дополняют данные 1С и сохраняются при следующих обменах.</p>
          <fieldset className="product-source-data"><legend>Данные из 1С</legend><dl><div><dt>Название</dt><dd>{editing.canonicalName}</dd></div><div><dt>Артикул</dt><dd>{editing.sourceSku ?? editing.sku ?? '—'}</dd></div><div><dt>Упаковка</dt><dd>{editing.packaging || '—'}</dd></div></dl></fieldset>
          <label>Название на сайте<input name="displayName" maxLength={200} defaultValue={editing.displayName ?? editing.canonicalName} required /></label>
          <label>Адрес страницы<input name="slug" maxLength={200} defaultValue={editing.slug ?? ''} required /></label>
          <label>Дополнительное описание<textarea name="description" maxLength={10000} defaultValue={editing.description} rows={5} placeholder="Состав, особенности, рекомендации или другая полезная покупателю информация" /></label>
          <label>Характеристики<textarea name="attributes" defaultValue={attributesText(editing.attributes)} rows={6} placeholder={'Крепость: средняя\nВес: 25 г'} /><small>Одна характеристика на строку в формате «Название: значение», максимум 30.</small></label>
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
