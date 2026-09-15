'use client'

import { useCallback, useEffect, useState } from 'react'

type Connection = {
  id: string
  provider: string
  name: string
  enabled: boolean
  checkpoint: { processed: number; page: number; completed: boolean } | null
  lastJob: { status: string; attempts: number; finishedAt: string | null; lastError: string | null } | null
}

type IntegrationError = { id: string; code: string; message: string; createdAt: string }

type Job = { id: string; type: string; status: string; attempts: number; maxAttempts: number; lastError: string | null; retryable: boolean; errorCount: number }

// Sample fixtures let the mock provider run end-to-end before a real 1C exists.
const DEMO_FIXTURES = [
  { externalId: 'DEMO-1', sku: 'DEMO-1', name: 'Демо товар 1', packaging: '25 г', unitsPerPack: 40, barcode: '4600000000011' },
  { externalId: 'DEMO-2', sku: 'DEMO-2', name: 'Демо товар 2', packaging: '30 г', unitsPerPack: 30, barcode: '4600000000028' },
  { externalId: 'DEMO-3', sku: 'DEMO-3', name: 'Демо товар 3', packaging: '100 г', unitsPerPack: 10 },
]

export function IntegrationsPanel() {
  const [connections, setConnections] = useState<Connection[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, IntegrationError[]>>({})
  const [jobs, setJobs] = useState<Record<string, Job[]>>({})
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    const response = await fetch('/api/staff/integrations')
    if (response.ok) setConnections((await response.json()).connections ?? [])
  }, [])

  useEffect(() => { load() }, [load])

  const createDemo = async () => {
    setMessage(null)
    const response = await fetch('/api/staff/integrations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'CUSTOM', name: `demo-${Date.now()}`, enabled: true, config: { fixtures: DEMO_FIXTURES, pageSize: 2 } }),
    })
    if (response.ok) await load()
    else setMessage('Не удалось создать подключение (нужна роль ADMIN).')
  }

  const sync = async (id: string) => {
    setBusyId(id)
    setMessage(null)
    try {
      const response = await fetch(`/api/staff/integrations/${id}/sync`, { method: 'POST' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setMessage(data.error === 'provider_not_configured' ? `Провайдер ${data.provider} ещё не настроен (контракт TBD).` : 'Синхронизация не выполнена.')
      } else {
        const stats = data.results?.[0]?.stats
        setMessage(stats ? `Импорт: страниц ${stats.pages}, добавлено ${stats.imported}, пропущено ${stats.skipped}, ошибок ${stats.failed}.` : `Задача ${data.jobId} обработана.`)
      }
      await load()
      await loadErrors(id)
    } finally {
      setBusyId(null)
    }
  }

  const loadErrors = async (id: string) => {
    const response = await fetch(`/api/staff/integrations/${id}/errors`)
    if (response.ok) {
      const data = await response.json()
      setErrors((prev) => ({ ...prev, [id]: data.errors ?? [] }))
    }
  }

  const loadJobs = async (id: string) => {
    const response = await fetch(`/api/staff/integrations/${id}/jobs`)
    if (response.ok) {
      const data = await response.json()
      setJobs((prev) => ({ ...prev, [id]: data.jobs ?? [] }))
    }
  }

  const retryJob = async (connectionId: string, jobId: string) => {
    setMessage(null)
    const response = await fetch(`/api/staff/jobs/${jobId}/retry`, { method: 'POST' })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      setMessage(data.error === 'provider_not_configured' ? `Провайдер ${data.provider} не настроен.` : 'Retry не выполнен.')
    } else {
      setMessage(data.idempotent ? 'Задача уже была успешной — повтор не требуется.' : `Retry: статус ${data.result?.status ?? 'обработан'}.`)
    }
    await Promise.all([loadJobs(connectionId), load()])
  }

  return (
    <div className="moderation-list">
      <div className="staff-toolbar" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <p>Импорт каталога через заменяемый Operational Provider. 1С — контракт TBD; демо-подключение использует mock-провайдер.</p>
        <button type="button" className="button button-secondary" onClick={createDemo}>Добавить демо-подключение</button>
      </div>
      {message ? <p className="auth-error" role="status">{message}</p> : null}
      <div className="moderation-head"><span>Провайдер</span><span>Checkpoint</span><span>Последняя задача</span><span>Действие</span></div>
      {connections.length === 0 ? <p className="staff-placeholder">Нет подключений. Добавьте демо-подключение или настройте провайдера.</p> : null}
      {connections.map((connection) => (
        <div className="moderation-row" key={connection.id}>
          <span><strong>{connection.name}</strong><small>{connection.provider}{connection.enabled ? '' : ' · выключен'}</small></span>
          <span>{connection.checkpoint ? `${connection.checkpoint.processed} поз. ${connection.checkpoint.completed ? '(готово)' : '(в процессе)'}` : '—'}</span>
          <span>{connection.lastJob ? <><strong>{connection.lastJob.status}</strong>{connection.lastJob.lastError ? <small>{connection.lastJob.lastError}</small> : null}</> : '—'}</span>
          <span className="moderation-actions">
            <button type="button" disabled={busyId === connection.id} onClick={() => sync(connection.id)}>{busyId === connection.id ? 'Синхронизация…' : 'Запустить синхронизацию'}</button>
            <button type="button" onClick={() => loadJobs(connection.id)}>Задачи</button>
            <button type="button" onClick={() => loadErrors(connection.id)}>Ошибки</button>
          </span>
          {jobs[connection.id]?.length ? (
            <div className="integration-jobs" style={{ gridColumn: '1 / -1' }}>
              {jobs[connection.id].map((job) => (
                <div key={job.id} className="integration-job-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '6px 0', borderTop: '1px solid var(--line)' }}>
                  <span><b>{job.type}</b> · {job.status} · попыток {job.attempts}/{job.maxAttempts}{job.lastError ? <small style={{ display: 'block', color: 'var(--muted)' }}>{job.lastError}</small> : null}</span>
                  {job.retryable ? <button type="button" onClick={() => retryJob(connection.id, job.id)}>Повторить</button> : <small style={{ color: 'var(--success)' }}>—</small>}
                </div>
              ))}
            </div>
          ) : null}
          {errors[connection.id]?.length ? (
            <ul className="integration-errors" style={{ gridColumn: '1 / -1' }}>
              {errors[connection.id].map((error) => <li key={error.id}><b>{error.code}</b> {error.message}</li>)}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  )
}
