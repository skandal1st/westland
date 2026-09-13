'use client'

import { Check, Palette } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useStoreProfile } from '@/lib/store-profile-context'

const palettes = [
  { id: 'violet', name: 'Фиолетовая', colors: ['#7800f0', '#13d8c8'] },
  { id: 'blue', name: 'Синяя', colors: ['#1557d6', '#21c7d9'] },
  { id: 'graphite', name: 'Графитовая', colors: ['#25282d', '#35c985'] },
  { id: 'burgundy', name: 'Бордовая', colors: ['#8b1e3f', '#e2b84b'] },
] as const

type PaletteId = (typeof palettes)[number]['id']

function isPalette(value: string | null): value is PaletteId {
  return palettes.some((palette) => palette.id === value)
}

export function PaletteSwitcher() {
  const profile = useStoreProfile()
  const paletteKey = `${profile.storageNamespace}-palette`
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState<PaletteId>(isPalette(profile.theme.defaultPalette) ? profile.theme.defaultPalette : 'violet')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const saved = window.localStorage.getItem(paletteKey)
    if (isPalette(saved)) setActive(saved)
  }, [paletteKey])

  useEffect(() => {
    if (!open) return

    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const selectPalette = (id: PaletteId) => {
    document.documentElement.dataset.palette = id
    window.localStorage.setItem(paletteKey, id)
    setActive(id)
    setOpen(false)
  }

  return (
    <div className="palette-switcher" ref={rootRef}>
      <button
        className="palette-trigger"
        type="button"
        aria-label="Выбрать цветовую палитру"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        <Palette aria-hidden="true" />
      </button>
      {open ? (
        <div className="palette-menu" role="menu" aria-label="Цветовые палитры">
          <strong>Цвет интерфейса</strong>
          {palettes.map((palette) => (
            <button
              className={active === palette.id ? 'active' : ''}
              key={palette.id}
              type="button"
              role="menuitemradio"
              aria-checked={active === palette.id}
              onClick={() => selectPalette(palette.id)}
            >
              <span className="palette-swatches" aria-hidden="true">
                {palette.colors.map((color) => <i key={color} style={{ background: color }} />)}
              </span>
              <span>{palette.name}</span>
              {active === palette.id ? <Check aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
