'use client'

import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck, ShieldAlert, ShieldX, RefreshCw } from 'lucide-react'

type License = {
  status: 'ACTIVE' | 'INVALID' | 'ABSENT'
  enforced: boolean
  reason: string | null
  licenseId: string | null
  customerId: string | null
  installationId: string | null
  deploymentClass: string | null
  modules: string[]
}

const LABEL: Record<License['status'], string> = { ACTIVE: 'Активна', INVALID: 'Недействительна', ABSENT: 'Отсутствует' }

/** Backoffice license status + capability indication + reactivation reload (plan §M9/§M10). */
export function LicensePanel() {
  const [license, setLicense] = useState<License | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    const response = await fetch('/api/staff/license')
    if (response.ok) setLicense(await response.json())
  }, [])

  useEffect(() => { load() }, [load])

  const reload = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const response = await fetch('/api/staff/license/reload', { method: 'POST' })
      if (response.ok) { await load(); setMessage('Лицензия перечитана с диска.') }
      else setMessage('Требуется роль администратора.')
    } finally { setBusy(false) }
  }

  if (!license) return <p className="staff-placeholder">Загрузка статуса лицензии…</p>

  const Icon = license.status === 'ACTIVE' ? ShieldCheck : license.status === 'INVALID' ? ShieldX : ShieldAlert
  const color = license.status === 'ACTIVE' ? 'var(--success)' : license.status === 'INVALID' ? 'var(--danger, #c0392b)' : 'var(--muted)'

  return (
    <div className="moderation-list">
      <div className="staff-toolbar" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Icon color={color} />
          <strong style={{ color }}>{LABEL[license.status]}</strong>
          <small>{license.enforced ? 'enforcement включён' : 'enforcement выключен (dev)'}</small>
        </span>
        <button type="button" className="button button-secondary" disabled={busy} onClick={reload}><RefreshCw size={14} /> Перечитать лицензию</button>
      </div>
      {message ? <p className="auth-error" role="status">{message}</p> : null}
      {license.reason ? <p className="staff-placeholder">Причина: {license.reason}</p> : null}

      <div className="moderation-head"><span>Поле</span><span>Значение</span></div>
      <div className="moderation-row"><span>Лицензия</span><span>{license.licenseId ?? '—'}</span></div>
      <div className="moderation-row"><span>Клиент</span><span>{license.customerId ?? '—'}</span></div>
      <div className="moderation-row"><span>Инсталляция</span><span>{license.installationId ?? '—'}</span></div>
      <div className="moderation-row"><span>Класс развёртывания</span><span>{license.deploymentClass ?? '—'}</span></div>
      <div className="moderation-row"><span>Лицензированные модули</span><span>{license.modules.length ? license.modules.join(', ') : '—'}</span></div>

      {license.status !== 'ACTIVE' && license.enforced ? (
        <p className="staff-placeholder" style={{ marginTop: 12 }}>
          Мутации (оформление заказов, импорт, изменения в backoffice) заблокированы. Витрина и чтение работают. Активируйте лицензию при развёртывании и нажмите «Перечитать лицензию».
        </p>
      ) : null}
    </div>
  )
}
