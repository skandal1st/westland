'use client'
/* eslint-disable @next/next/no-img-element -- Product images are validated staff uploads served by the application. */

import { productStatusLabel } from '@/lib/status-labels'
import { ImagePlus, Star, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useRemoteResource } from '@/lib/use-remote-resource'

type Product = {
  id: string
  canonicalName: string
  status: string
  displayName: string | null
  slug: string | null
  description: string
  imageUrls: string[]
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
  const [uploading, setUploading] = useState(false)
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
        imageUrls: editing.imageUrls,
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

  const uploadImages = async (files: FileList | null) => {
    if (!editing || !files?.length) return
    const remaining = 8 - editing.imageUrls.length
    if (remaining <= 0) { setError('Для одного товара можно добавить не больше 8 изображений.'); return }
    if (files.length > remaining) { setError(`Можно добавить ещё ${remaining}. Уменьшите количество выбранных файлов.`); return }
    const selected = Array.from(files).slice(0, remaining)
    const invalid = selected.find(file => file.size > 8 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
    if (invalid) { setError('Используйте JPG, PNG или WebP размером до 8 МБ.'); return }
    setUploading(true); setError(null)
    try {
      const results = await Promise.allSettled(selected.map(async file => {
        const response = await fetch(`/api/staff/products/${editing.id}/images`, { method: 'POST', headers: { 'content-type': file.type }, body: file })
        if (!response.ok) throw new Error('upload_failed')
        return (await response.json() as { url: string }).url
      }))
      const uploaded = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
      setEditing(current => current?.id === editing.id ? { ...current, imageUrls: [...current.imageUrls, ...uploaded] } : current)
      if (uploaded.length !== selected.length) setError(`Загружено ${uploaded.length} из ${selected.length}. Повторите загрузку остальных файлов.`)
    } catch { setError('Не удалось загрузить изображения. Проверьте соединение и повторите попытку.') }
    finally { setUploading(false) }
  }

  const makePrimary = (url: string) => setEditing(current => current ? { ...current, imageUrls: [url, ...current.imageUrls.filter(item => item !== url)] } : current)
  const removeImage = (url: string) => setEditing(current => current ? { ...current, imageUrls: current.imageUrls.filter(item => item !== url) } : current)


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
          <section className="product-images-editor" aria-labelledby="product-images-title">
            <div className="product-images-heading"><div><h3 id="product-images-title">Изображения товара</h3><p>Первое изображение используется как главное. Изменения применятся после сохранения товара.</p></div><span>{editing.imageUrls.length} / 8</span></div>
            <div className="product-images-grid">
              {editing.imageUrls.map((url, index) => <figure key={url}>
                <img src={url} alt={`${editing.displayName ?? editing.canonicalName}, изображение ${index + 1}`} />
                {index === 0 ? <figcaption><Star aria-hidden="true" /> Главное</figcaption> : <button type="button" onClick={() => makePrimary(url)}><Star aria-hidden="true" /> Сделать главным</button>}
                <button type="button" className="product-image-remove" aria-label={`Удалить изображение ${index + 1}`} onClick={() => removeImage(url)}><Trash2 aria-hidden="true" /></button>
              </figure>)}
              {editing.imageUrls.length < 8 ? <label className="product-image-upload"><ImagePlus aria-hidden="true" /><strong>{uploading ? 'Загрузка…' : 'Добавить фото'}</strong><small>JPG, PNG или WebP<br />до 8 МБ</small><input type="file" multiple accept="image/jpeg,image/png,image/webp" disabled={uploading} onChange={event => { void uploadImages(event.target.files); event.target.value = '' }} /></label> : null}
            </div>
          </section>
          <label>Характеристики<textarea name="attributes" defaultValue={attributesText(editing.attributes)} rows={6} placeholder={'Крепость: средняя\nВес: 25 г'} /><small>Одна характеристика на строку в формате «Название: значение», максимум 30.</small></label>
          {error ? <p className="auth-error" role="alert">{error}</p> : null}
          <div className="form-row">
            <button className="button button-primary" type="submit" disabled={saving || uploading}>{saving ? 'Сохранение…' : uploading ? 'Загрузка изображений…' : 'Сохранить'}</button>
            <button className="button button-secondary" type="button" disabled={uploading} onClick={() => setEditing(null)}>Отмена</button>
          </div>
        </form>
      ) : null}
    </div>
  )
}
