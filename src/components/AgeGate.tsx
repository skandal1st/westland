'use client'

import Image from 'next/image'
import { useEffect, useState } from 'react'

export function AgeGate() {
  const [visible, setVisible] = useState(false)
  useEffect(() => setVisible(localStorage.getItem('westside-age-confirmed') !== 'yes'), [])
  if (!visible) return null
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="age-modal" role="dialog" aria-modal="true" aria-labelledby="age-title">
        <Image className="age-logo" src="/brand/westside-logo.png" alt="Westside" width={96} height={96} priority />
        <h2 id="age-title">Вам уже исполнилось 18 лет?</h2>
        <p>Сайт предназначен только для совершеннолетних представителей юридических лиц.</p>
        <div className="age-actions">
          <button className="button button-primary" onClick={() => {
            localStorage.setItem('westside-age-confirmed', 'yes')
            setVisible(false)
          }}>Да, мне есть 18</button>
          <a className="button button-secondary" href="https://ya.ru">Нет</a>
        </div>
      </section>
    </div>
  )
}
