'use client'

import { providerLabel } from '@/lib/status-labels'
import { ImportResult, ImportStages } from './ImportResult'
import { OUTCOME_LABELS, STATUS_LABELS, STAGE_LABELS, reasonLabel, type SyncReport, type RunResult } from '@/lib/integrations/import-result'
import { OrderDeliverySettings } from './OrderDeliverySettings'
import { SourceMappings } from './SourceMappings'
import { EnterpriseDataDirectory } from './EnterpriseDataDirectory'
import { SourcePreflight } from './SourcePreflight'
import { OnecGenerations } from './OnecGenerations'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { readArray, useRemoteResource } from '@/lib/use-remote-resource'

type Connection = {
  id: string
  provider: string
  name: string
  enabled: boolean
  environment: 'UNCLASSIFIED' | 'TEST' | 'PRODUCTION'
  sourceState: 'PREPARING' | 'ACTIVE' | 'RETIRED'
  canSync: boolean
  checkpoint: { processed: number; page: number; completed: boolean } | null
  lastRun: { id: string; status: string; stats: SyncReport | null; createdAt: string } | null
  lastJob: { status: string; attempts: number; finishedAt: string | null; lastError: string | null } | null
}

type IntegrationError = { id: string; code: string; message: string; createdAt: string }

type Job = { id: string; type: string; status: string; attempts: number; maxAttempts: number; lastError: string | null; retryable: boolean; errorCount: number; latestAttempt?: { stats: RunResult | null } | null }

// Sample fixtures let the mock provider run end-to-end before a real 1C exists.
const DEMO_FIXTURES = [
  { externalId: 'DEMO-1', sku: 'DEMO-1', name: 'Демо товар 1', packaging: '25 г', unitsPerPack: 40, barcode: '4600000000011' },
  { externalId: 'DEMO-2', sku: 'DEMO-2', name: 'Демо товар 2', packaging: '30 г', unitsPerPack: 30, barcode: '4600000000028' },
  { externalId: 'DEMO-3', sku: 'DEMO-3', name: 'Демо товар 3', packaging: '100 г', unitsPerPack: 10 },
]

const decodeConnections = (value: unknown) => readArray<Connection>(value, 'connections')

export function IntegrationsPanel() {
  const connectionResource = useRemoteResource('/api/staff/integrations', decodeConnections)
  const connections = connectionResource.data ?? []
  const load = connectionResource.reload
  const [detailState, setDetailState] = useState<Record<string, 'loading' | 'error' | 'ready'>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, IntegrationError[]>>({})
  const [jobs, setJobs] = useState<Record<string, Job[]>>({})
  const [message, setMessage] = useState<string | null>(null)
  const [sourceName, setSourceName] = useState('1С — тестовая база')
  const [environment, setEnvironment] = useState<'TEST' | 'PRODUCTION'>('TEST')
  const [creating, setCreating] = useState(false)
  const [generationIds, setGenerationIds] = useState<Record<string, string>>({})

  const detailRequests = useRef<Record<string, number>>({})
  const loadDetail = useCallback(async (id: string, kind: 'errors' | 'jobs', signal?: AbortSignal) => {
    const key = id + ':' + kind
    const request = (detailRequests.current[key] ?? 0) + 1
    detailRequests.current[key] = request
    setDetailState(previous => ({ ...previous, [key]: 'loading' }))
    try {
      const response = await fetch(`/api/staff/integrations/${id}/${kind}`, { signal, cache: 'no-store' })
      if (!response.ok) throw new Error('detail_unavailable')
      const data: unknown = await response.json()
      if (detailRequests.current[key] !== request || signal?.aborted) return
      if (kind === 'errors') {
        const entries = readArray<IntegrationError>(data, 'errors')
        setErrors(previous => ({ ...previous, [id]: entries }))
      } else {
        const entries = readArray<Job>(data, 'jobs')
        setJobs(previous => ({ ...previous, [id]: entries }))
      }
      setDetailState(previous => ({ ...previous, [key]: 'ready' }))
    } catch {
      if (detailRequests.current[key] === request && !signal?.aborted) setDetailState(previous => ({ ...previous, [key]: 'error' }))
    }
  }, [])
  const loadErrors = (id: string) => loadDetail(id, 'errors')
  const loadJobs = (id: string) => loadDetail(id, 'jobs')

  const activeIds = connections.filter(c => ['PENDING', 'RUNNING'].includes(c.lastRun?.status ?? '') || ['PENDING', 'RUNNING', 'RETRYING'].includes(c.lastJob?.status ?? '') || jobs[c.id]?.some(j => ['PENDING', 'RUNNING', 'RETRYING'].includes(j.status))).map(c => c.id).sort().join(',')
  useEffect(() => {
    if (!activeIds) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        await Promise.all([load(), ...activeIds.split(',').map(id => loadDetail(id, 'jobs'))])
      }
      finally { if (!controller.signal.aborted) timer = setTimeout(poll, 5_000) }
    }
    timer = setTimeout(poll, 2_000)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [activeIds, load, loadDetail])

  const createDemo = async () => {
    setMessage(null)
    const response = await fetch('/api/staff/integrations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'CUSTOM', name: `demo-${Date.now()}`, environment: 'TEST', enabled: false, config: { fixtures: DEMO_FIXTURES, pageSize: 2 } }),
    })
    if (response.ok) await load()
    else setMessage('Не удалось создать подключение (нужна роль администратора).')
  }

  const createOnec = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setMessage(null)
    setCreating(true)
    try {
      const response = await fetch('/api/staff/integrations', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'ONE_C', name: sourceName, environment }),
      })
      if (!response.ok) { setMessage('Профиль не создан. Проверьте название и права администратора.'); return }
      await load()
      setMessage('Профиль создан в подготовке. Текущий источник обмена сохранён.')
    } catch { setMessage('Не удалось связаться с сервером. Попробуйте ещё раз.') }
    finally { setCreating(false) }
  }

  const classifySource = async (id: string, value: string) => {
    if (value !== 'TEST' && value !== 'PRODUCTION') return
    setBusyId(id)
    setMessage(null)
    try {
      const response = await fetch(`/api/staff/integrations/${id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ environment: value }),
      })
      if (!response.ok) setMessage('Среда не сохранена. Нужна роль администратора; для смены уже указанной среды создайте отдельный профиль.')
      else await load()
    } catch { setMessage('Не удалось связаться с сервером. Попробуйте ещё раз.') }
    finally { setBusyId(null) }
  }

  const sync = async (id: string) => {
    setBusyId(id)
    setMessage(null)
    try {
      const response = await fetch(`/api/staff/integrations/${id}/sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ generationId: generationIds[id] }) })
      const data = await response.json().catch(() => ({}))
      if (!response.ok && !data.runId) setMessage(reasonLabel(data.error ?? 'Синхронизация не выполнена.'))
      else if (response.status === 202) setMessage('Синхронизация принята в очередь. Этапы будут выполнены по порядку.')
      else if (data.outcome) setMessage(OUTCOME_LABELS[data.outcome] ?? 'Результат сохранён.')
      await Promise.all([load(), loadErrors(id), loadJobs(id)])
    } catch { setMessage('Не удалось получить результат. Обновите список: запрос мог продолжить выполнение на сервере.') } finally {
      setBusyId(null)
    }
  }


  const retryJob = async (connectionId: string, jobId: string) => {
    setMessage(null); setBusyId(connectionId)
    try {
      const response = await fetch(`/api/staff/jobs/${jobId}/retry`, { method: 'POST' })
      const data = await response.json().catch(() => ({}))
      if (response.status === 202 && data.queued) setMessage('Повтор принят в очередь.')
      else if (data.result) setMessage(`${OUTCOME_LABELS[data.result.outcome] ?? 'Результат задания'}${data.result.message ? `: ${reasonLabel(data.result.message)}` : ''}`)
      else if (data.idempotent) setMessage('Задание уже было успешным — повтор не требуется.')
      else setMessage(reasonLabel(data.error ?? 'Результат повтора не получен. Обновите список заданий.'))
      await Promise.all([loadJobs(connectionId), loadErrors(connectionId), load()])
    } catch { setMessage('Не удалось получить результат повтора. Обновите список заданий.') }
    finally { setBusyId(null) }
  }

  return (
    <div className="moderation-list integrations-panel">
      <div className="staff-toolbar" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <p>Для каждой базы 1С создайте отдельный профиль. Новый профиль остаётся в подготовке и не заменяет текущий источник.</p>
        <button type="button" onClick={() => load().catch(() => setMessage('Не удалось обновить результаты.'))}>Обновить результаты</button>
        <button type="button" className="button button-secondary" onClick={createDemo}>Демо-профиль</button>
      </div>
      <form onSubmit={createOnec} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'end', gap: 12, marginBottom: 16 }}>
        <label>Название профиля<input required maxLength={160} value={sourceName} onChange={event => setSourceName(event.target.value)} /></label>
        <label>Среда<select value={environment} onChange={event => setEnvironment(event.target.value as 'TEST' | 'PRODUCTION')}>
          <option value="TEST">Тестовая база</option><option value="PRODUCTION">Боевая база</option>
        </select></label>
        <button type="submit" className="button button-primary" disabled={creating}>{creating ? 'Создание…' : 'Подготовить профиль 1С'}</button>
      </form>
      {message ? <p className="auth-error" role="status">{message}</p> : null}
      <div className="moderation-head"><span>Провайдер</span><span>Каталог</span><span>Последняя задача</span><span>Действие</span></div>
      {connectionResource.loading ? <p role="status">Загрузка подключений…</p> : null}
      {connectionResource.error ? <div className="load-error" role="alert"><span>{connectionResource.error}</span><button type="button" onClick={load}>Повторить загрузку подключений</button></div> : null}
      {!connectionResource.loading && !connectionResource.error && connections.length === 0 ? <p className="staff-placeholder">Нет подключений. Добавьте демо-подключение или настройте провайдера.</p> : null}
      {connections.map((connection) => (
        <div className="moderation-row" key={connection.id}>
          <span><strong>{connection.name}</strong><small>{providerLabel(connection.provider)} · {{ TEST: 'Тестовая база', PRODUCTION: 'Боевая база', UNCLASSIFIED: 'Среда не указана' }[connection.environment]} · {{ PREPARING: 'Подготовка', ACTIVE: 'Активен', RETIRED: 'Архив' }[connection.sourceState]}</small>
            {connection.environment === 'UNCLASSIFIED' ? <label>Указать текущую среду<select value="" disabled={busyId === connection.id} onChange={event => classifySource(connection.id, event.target.value)}>
              <option value="" disabled>Выберите среду</option><option value="TEST">Тестовая база</option><option value="PRODUCTION">Боевая база</option>
            </select></label> : null}
            {connection.sourceState === 'PREPARING' ? <small>Файлы можно загрузить для проверки. Импорт и продажи через этот источник отключены.</small> : null}
          </span>
          <span>{connection.checkpoint ? `${connection.checkpoint.processed} поз. ${connection.checkpoint.completed ? '(чтение завершено)' : '(этап не завершён)'}` : '—'}</span>
          <span>{connection.lastJob ? <><strong>{STATUS_LABELS[connection.lastJob.status.toLowerCase()] ?? 'Статус не определён'}</strong>{connection.lastJob.lastError ? <small>{connection.lastJob.lastError}</small> : null}</> : '—'}</span>
          <span className="moderation-actions">
            <button type="button" disabled={!connection.canSync || busyId === connection.id} onClick={() => sync(connection.id)}>{busyId === connection.id ? 'Синхронизация…' : 'Запустить синхронизацию'}</button>
            <button type="button" onClick={() => loadJobs(connection.id)}>Задачи</button>
            <button type="button" onClick={() => loadErrors(connection.id)}>Ошибки</button>
          </span>
          {connection.lastRun?.stats ? <ImportResult report={connection.lastRun.stats} /> : null}
            {connection.provider === 'ONE_C' ? <><EnterpriseDataDirectory connectionId={connection.id} /><SourceMappings connectionId={connection.id} /><OrderDeliverySettings connectionId={connection.id} /></> : null}
          {connection.provider === 'ONE_C' && connection.sourceState !== 'RETIRED' ? <OnecGenerations connectionId={connection.id} onSelectGeneration={id => setGenerationIds(current => ({ ...current, [connection.id]: id }))} /> : null}
          {connection.provider === 'ONE_C' && connection.sourceState === 'PREPARING' ? <SourcePreflight key={connection.id + (generationIds[connection.id] ?? '')} connectionId={connection.id} generationId={generationIds[connection.id]} /> : null}
          {(['jobs', 'errors'] as const).map(kind => {
            const state = detailState[connection.id + ':' + kind]
            const label = kind === 'jobs' ? 'заданий' : 'ошибок'
            return state === 'loading' ? <p key={kind} role="status">Загрузка {label}…</p>
              : state === 'error' ? <div key={kind} className="load-error" role="alert"><span>Не удалось загрузить список {label}.</span><button type="button" onClick={() => loadDetail(connection.id, kind)}>Повторить загрузку {label}</button></div>
              : state === 'ready' && !(kind === 'jobs' ? jobs[connection.id] : errors[connection.id])?.length ? <p key={kind}>Список {label} пуст.</p> : null
          })}
          {jobs[connection.id]?.length ? (
            <div className="integration-jobs" style={{ gridColumn: '1 / -1' }}>
              {jobs[connection.id].map((job) => (
                <div key={job.id} className="integration-job-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '6px 0', borderTop: '1px solid var(--line)' }}>
                  <span><b>{STAGE_LABELS[job.type] ?? 'Задание обмена'}</b> · {STATUS_LABELS[job.status.toLowerCase()] ?? 'Статус не определён'} · попыток {job.attempts}/{job.maxAttempts}{job.lastError ? <small style={{ display: 'block', color: 'var(--muted)' }}>{job.lastError}</small> : null}</span>
                  {job.latestAttempt?.stats?.outcome ? <ImportStages results={[job.latestAttempt.stats]} /> : null}
                  {job.retryable && connection.canSync ? <button type="button" disabled={busyId === connection.id} onClick={() => retryJob(connection.id, job.id)}>Повторить</button> : <small style={{ color: 'var(--success)' }}>—</small>}
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
