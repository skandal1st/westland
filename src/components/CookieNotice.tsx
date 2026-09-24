'use client'

import { useEffect, useState } from 'react'

const COOKIE_NAME = 'westside_cookie_notice'

export function CookieNotice() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const accepted = document.cookie.split(';').some(part => part.trim().startsWith(`${COOKIE_NAME}=`))
    setVisible(!accepted)
  }, [])

  if (!visible) return null

  const acknowledge = () => {
    const secure = window.location.protocol === 'https:' ? '; Secure' : ''
    document.cookie = `${COOKIE_NAME}=accepted; Max-Age=31536000; Path=/; SameSite=Lax${secure}`
    setVisible(false)
  }

  return <aside className="cookie-notice" aria-label="Уведомление об использовании cookies" aria-live="polite">
    <p><strong>Мы используем cookies</strong><span>Технические cookies нужны для входа, корзины и сохранения настроек сайта.</span></p>
    <button type="button" className="button button-primary" onClick={acknowledge}>Понятно</button>
  </aside>
}
