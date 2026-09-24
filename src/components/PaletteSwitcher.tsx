'use client'

import { Check } from 'lucide-react'
import { useSession } from 'next-auth/react'
import { useState } from 'react'
import { resolvePalette, type PaletteId } from '@/lib/palette'
import { useStoreProfile } from '@/lib/store-profile-context'

const palettes = [
  { id: 'violet', name: 'Фиолетовая', colors: ['#7800f0', '#13d8c8'] },
  { id: 'blue', name: 'Синяя', colors: ['#1557d6', '#21c7d9'] },
  { id: 'graphite', name: 'Графитовая', colors: ['#25282d', '#35c985'] },
  { id: 'burgundy', name: 'Бордовая', colors: ['#8b1e3f', '#e2b84b'] },
] as const satisfies ReadonlyArray<{ id: PaletteId; name: string; colors: readonly string[] }>

export function PaletteSwitcher() {
  const profile = useStoreProfile()
  const { data: session } = useSession()
  const [active, setActive] = useState<PaletteId>(() => resolvePalette(profile.theme.defaultPalette))
  const [busy, setBusy] = useState<PaletteId | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const canChange = session?.user?.role === 'ADMIN'

  const selectPalette = async (id: PaletteId) => {
    if (!canChange || id === active) return
    setBusy(id)
    setMessage(null)
    try {
      const response = await fetch('/api/staff/settings/palette', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ palette: id }),
      })
      if (!response.ok) {
        setMessage(response.status === 403 ? 'Изменение доступно только администратору.' : 'Не удалось сохранить цветовую схему. Повторите попытку.')
        return
      }
      document.documentElement.dataset.palette = id
      setActive(id)
      setMessage('Цветовая схема сохранена для всех посетителей сайта.')
    } catch {
      setMessage('Не удалось связаться с сервером. Проверьте подключение и повторите.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="palette-settings">
      <h3>Цветовая схема</h3>
      <p className="settings-note">Выбор применяется ко всему сайту и сохраняется для всех посетителей. По умолчанию используется графитовая схема.</p>
      <div className="palette-settings-options" role="radiogroup" aria-label="Цветовая схема сайта">
        {palettes.map((palette) => (
          <button
            className={active === palette.id ? 'active' : ''}
            key={palette.id}
            type="button"
            role="radio"
            aria-checked={active === palette.id}
            disabled={!canChange || busy !== null}
            onClick={() => void selectPalette(palette.id)}
          >
            <span className="palette-settings-swatches" aria-hidden="true">
              {palette.colors.map((color) => <i key={color} style={{ background: color }} />)}
            </span>
            <span>{busy === palette.id ? 'Сохранение…' : palette.name}</span>
            {active === palette.id ? <Check aria-hidden="true" /> : null}
          </button>
        ))}
      </div>
      {!canChange ? <p className="settings-note">Изменять схему может только администратор.</p> : null}
      {message ? <p className="palette-settings-message" role="status">{message}</p> : null}
    </section>
  )
}
