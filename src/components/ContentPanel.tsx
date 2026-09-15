'use client'

import { useCallback, useEffect, useState } from 'react'
import { Image as ImageIcon, Trash2 } from 'lucide-react'

type Banner = {
  id: string
  name: string
  placement: 'HOME' | 'CATALOG'
  isActive: boolean
  sortOrder: number
  startsAt: string | null
  endsAt: string | null
  brand: { name: string } | null
}

type BrandPage = { id: string; brandId: string; title: string; isActive: boolean; brand: { name: string; slug: string } | null }

/** Backoffice content management: banners + brand pages (plan §M9). */
export function ContentPanel() {
  const [banners, setBanners] = useState<Banner[]>([])
  const [pages, setPages] = useState<BrandPage[]>([])
  const [name, setName] = useState('')
  const [placement, setPlacement] = useState<'HOME' | 'CATALOG'>('CATALOG')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [b, p] = await Promise.all([
      fetch('/api/staff/banners').then((r) => (r.ok ? r.json() : { banners: [] })),
      fetch('/api/staff/content/brand-pages').then((r) => (r.ok ? r.json() : { pages: [] })),
    ])
    setBanners(b.banners ?? [])
    setPages(p.pages ?? [])
  }, [])

  useEffect(() => { load() }, [load])

  const createBanner = async () => {
    if (!name.trim()) return
    setBusy(true)
    setMessage(null)
    try {
      const response = await fetch('/api/staff/banners', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), placement }),
      })
      if (response.ok) { setName(''); await load() } else setMessage('Не удалось создать баннер.')
    } finally { setBusy(false) }
  }

  const toggleBanner = async (banner: Banner) => {
    await fetch(`/api/staff/banners/${banner.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ isActive: !banner.isActive }),
    })
    await load()
  }

  const removeBanner = async (id: string) => {
    await fetch(`/api/staff/banners/${id}`, { method: 'DELETE' })
    await load()
  }

  const fmtWindow = (b: Banner) => {
    if (!b.startsAt && !b.endsAt) return 'без ограничения по дате'
    const s = b.startsAt ? new Date(b.startsAt).toLocaleDateString('ru-RU') : '…'
    const e = b.endsAt ? new Date(b.endsAt).toLocaleDateString('ru-RU') : '…'
    return `${s} — ${e}`
  }

  return (
    <div className="moderation-list">
      <div className="staff-toolbar" style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Название баннера" aria-label="Название баннера" />
        <select value={placement} onChange={(e) => setPlacement(e.target.value as 'HOME' | 'CATALOG')} aria-label="Размещение">
          <option value="CATALOG">Каталог</option>
          <option value="HOME">Главная</option>
        </select>
        <button type="button" className="button button-primary" disabled={busy} onClick={createBanner}>Добавить баннер</button>
      </div>
      {message ? <p className="auth-error" role="status">{message}</p> : null}

      <div className="moderation-head"><span>Баннер</span><span>Размещение</span><span>Период</span><span>Действие</span></div>
      {banners.length === 0 ? <p className="staff-placeholder">Баннеров нет. Добавьте первый.</p> : null}
      {banners.map((banner) => (
        <div className="moderation-row" key={banner.id}>
          <span><strong><ImageIcon size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />{banner.name}</strong><small>{banner.brand ? `бренд: ${banner.brand.name}` : 'общий'}</small></span>
          <span>{banner.placement === 'HOME' ? 'Главная' : 'Каталог'}</span>
          <span>{fmtWindow(banner)}</span>
          <span className="moderation-actions">
            <button type="button" onClick={() => toggleBanner(banner)}>{banner.isActive ? 'Выключить' : 'Включить'}</button>
            <button type="button" aria-label={'Удалить ' + banner.name} onClick={() => removeBanner(banner.id)}><Trash2 size={14} /></button>
          </span>
        </div>
      ))}

      <div className="moderation-head" style={{ marginTop: 20 }}><span>Брендовая страница</span><span>Бренд</span><span>Статус</span><span /></div>
      {pages.length === 0 ? <p className="staff-placeholder">Брендовых страниц нет.</p> : null}
      {pages.map((page) => (
        <div className="moderation-row" key={page.id}>
          <span><strong>{page.title}</strong></span>
          <span>{page.brand?.name ?? page.brandId}</span>
          <span><b style={{ color: page.isActive ? 'var(--success)' : 'var(--muted)' }}>{page.isActive ? 'Активна' : 'Черновик'}</b></span>
          <span />
        </div>
      ))}
    </div>
  )
}
