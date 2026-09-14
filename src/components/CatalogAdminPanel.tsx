'use client'

import { useCallback, useEffect, useState } from 'react'

type Product = {
  id: string
  canonicalName: string
  status: string
  displayName: string | null
  slug: string | null
  description: string
  sku: string | null
}

export function CatalogAdminPanel() {
  const [products, setProducts] = useState<Product[]>([])
  const [editing, setEditing] = useState<Product | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const response = await fetch('/api/staff/products')
    if (response.ok) setProducts((await response.json()).products ?? [])
  }, [])

  useEffect(() => { load() }, [load])

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!editing) return
    setSaving(true)
    setError(null)
    const form = new FormData(event.currentTarget)
    const response = await fetch(`/api/staff/products/${editing.id}/content`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: String(form.get('displayName') ?? ''),
        slug: String(form.get('slug') ?? ''),
        description: String(form.get('description') ?? ''),
      }),
    })
    setSaving(false)
    if (response.ok) {
      setEditing(null)
      await load()
    } else {
      const data = await response.json().catch(() => ({}))
      setError(data.error === 'SLUG_TAKEN' ? 'Такой slug уже используется.' : 'Не удалось сохранить.')
    }
  }

  if (products.length === 0) {
    return <div className="staff-placeholder"><h2>Товары</h2><p>Каталог пуст. Канонические позиции появятся после импорта из учётной системы (M4); здесь сотрудник дополняет их контент.</p></div>
  }

  return (
    <div className="moderation-list">
      <div className="moderation-head"><span>Каноническое имя</span><span>Витрина</span><span>SKU</span><span>Действие</span></div>
      {products.map((product) => (
        <div className="moderation-row" key={product.id}>
          <span><strong>{product.canonicalName}</strong><small>{product.status}</small></span>
          <span><strong>{product.displayName ?? '—'}</strong><small>/{product.slug ?? ''}</small></span>
          <span>{product.sku ?? '—'}</span>
          <span className="moderation-actions"><button type="button" onClick={() => { setEditing(product); setError(null) }}>Редактировать контент</button></span>
        </div>
      ))}

      {editing ? (
        <form className="auth-card" onSubmit={save} style={{ marginTop: 16 }}>
          <h2>Контент: {editing.canonicalName}</h2>
          <label>Отображаемое имя<input name="displayName" defaultValue={editing.displayName ?? editing.canonicalName} required /></label>
          <label>Slug<input name="slug" defaultValue={editing.slug ?? ''} required /></label>
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
