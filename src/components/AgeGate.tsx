'use client'

import Image from 'next/image'
import { useEffect, useState } from 'react'
import { useStoreProfile } from '@/lib/store-profile-context'

export function AgeGate() {
  const profile = useStoreProfile()
  const storageKey = `${profile.storageNamespace}-age-confirmed`
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!profile.policies.requireAgeConfirmation) {
      setVisible(false)
      return
    }
    setVisible(localStorage.getItem(storageKey) !== 'yes')
  }, [storageKey, profile.policies.requireAgeConfirmation])

  if (!visible) return null
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="age-modal" role="dialog" aria-modal="true" aria-labelledby="age-title">
        <Image className="age-logo" src="/brand/westside-logo.png" alt={profile.identity.name} width={96} height={96} priority />
        <h2 id="age-title">Вам уже исполнилось 18 лет?</h2>
        <p>Сайт предназначен только для совершеннолетних представителей юридических лиц.</p>
        <div className="age-actions">
          <button className="button button-primary" onClick={() => {
            localStorage.setItem(storageKey, 'yes')
            setVisible(false)
          }}>Да, мне есть 18</button>
          <a className="button button-secondary" href="https://ya.ru">Нет</a>
        </div>
      </section>
    </div>
  )
}
