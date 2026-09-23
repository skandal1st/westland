/** Shared serialized contract. Does not import server modules. */
export type ImportOutcome = 'success' | 'partial' | 'failed' | 'skipped'
export type ImportCounters = { imported: number; failed: number; skipped?: number; pages?: number; removed?: number; previouslyProcessed?: number; catalogDeleted?: number; unknownDeleted?: number }
export type ImportIssue = { code: string; message: string; externalId?: string }
export type ImportFailure = { message: string; code?: string }
export function importFailure(error: unknown): ImportFailure {
  if (error instanceof ImportExecutionError) return importFailure(error.cause)
  const primary = error
  const code = primary && typeof primary === 'object' && 'code' in primary && typeof primary.code === 'string' ? primary.code : undefined
  return { message: primary instanceof Error ? primary.message : String(primary), ...(code ? { code } : {}) }
}
export type RunResult = {
  jobId: string; type: string; status: 'succeeded' | 'partial' | 'failed' | 'retrying' | 'skipped'
  outcome: ImportOutcome; message?: string; stats?: ImportCounters; issues?: ImportIssue[]; failure?: ImportFailure
}
export type StageResult = { type: string; status: RunResult['status'] | 'pending' | 'running'; outcome?: ImportOutcome; jobId?: string; message?: string; stats?: ImportCounters; issues?: ImportIssue[]; failure?: ImportFailure }
export type SyncReport = { runId: string; generationId: string | null; error?: string; outcome: ImportOutcome | 'running' | 'pending'; results: StageResult[] }
export const IMPORT_STAGES = ['catalog.import', 'prices.import', 'availability.import'] as const
export function hasImportProgress(stats?: ImportCounters): boolean {
  return Boolean(stats && stats.imported + (stats.skipped ?? 0) + (stats.removed ?? 0) + (stats.previouslyProcessed ?? 0) > 0)
}
export function classifyImport(stats: ImportCounters, interrupted = false): ImportOutcome {
  if (!interrupted && stats.failed === 0) return 'success'
  return hasImportProgress(stats) ? 'partial' : 'failed'
}
export function summarizeStages(results: StageResult[]): ImportOutcome {
  if (results.every(r => r.outcome === 'success')) return 'success'
  if (results.some(r => r.outcome === 'partial' || hasImportProgress(r.stats))) return 'partial'
  return 'failed'
}
/** Carry known committed progress across a transport/projection failure. */
export class ImportExecutionError extends Error {
  get code() { return importFailure(this.cause).code }
  constructor(public readonly cause: unknown, public stats: ImportCounters) {
    super(cause instanceof Error ? cause.message : String(cause)); this.name = 'ImportExecutionError'
  }
}
export const STAGE_LABELS: Record<string, string> = { 'catalog.import': 'Каталог', 'prices.import': 'Цены', 'availability.import': 'Остатки' }
export const OUTCOME_LABELS: Record<string, string> = { pending: 'Принято в очередь', success: 'Завершено успешно', partial: 'Выполнено частично', failed: 'Не выполнено', skipped: 'Не выполнялось', running: 'Выполняется' }
export const STATUS_LABELS: Record<string, string> = { succeeded: 'Успешно', partial: 'Частично', failed: 'Ошибка', retrying: 'Ошибка, ожидает повтора', skipped: 'Не запускалось', pending: 'Ожидает запуска', running: 'Выполняется' }
export function reasonLabel(message: string): string {
  const reasons: Record<string, string> = {
    source_sync_busy: 'Для источника уже выполняется другая синхронизация. Дождитесь её завершения.',
    execution_lease_expired: 'Исполнитель перестал отвечать. Попытка прервана; повтор ограничен настройками задания.',
    execution_lease_lost: 'Исполнение остановлено: право записи больше не принадлежит этому процессу.',
    job_not_claimable: 'Задание уже захвачено, завершено или ещё не готово к повтору.',
    job_already_active: 'Для этого потока уже есть активное задание.',
    previous_stage_incomplete: 'Предыдущий этап не завершён успешно.', provider_stream_not_supported: 'Провайдер не поддерживает этот поток данных.',
    import_rows_failed: 'Есть строки, которые не удалось применить. Исправьте причины и повторите импорт.',
    price_type_unmapped: 'Тип цены 1С не сопоставлен с прайс-листом.', warehouse_unmapped: 'Склад 1С не сопоставлен.',
    price_currency_mismatch: 'Валюта 1С не совпадает с валютой прайс-листа.', job_running: 'Задание уже выполняется.',
    generation_required: 'Сначала зафиксируйте завершённый набор файлов.', source_not_active: 'Источник не активен.',
    generation_source_changed: 'Источник изменился. Нужна новая выгрузка.', older_generation_rejected: 'Более новый набор уже применён.',
    catalog_generation_not_applied: 'Сначала должен успешно завершиться каталог этого набора файлов.',
    full_scope_required: 'Для полного импорта нужен список типов цен или складов.',
    price_source_conflict: 'У цены другой или неподтверждённый источник.', stock_source_conflict: 'У остатка другой или неподтверждённый источник.',
    checkpoint_generation_mismatch: 'Нельзя продолжить незавершённый импорт на другом наборе.', provider_not_configured: 'Провайдер не настроен.',
  }
  return reasons[message] ?? message
}

export function storedAttemptResult(value: unknown, job: { id: string; type: string; status: string }): RunResult | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.outcome === 'string' && ['success', 'partial', 'failed', 'skipped'].includes(raw.outcome) && typeof raw.status === 'string') return raw as unknown as RunResult
  if (typeof raw.imported !== 'number' || typeof raw.failed !== 'number') return null
  const stats = raw as unknown as ImportCounters
  const outcome = classifyImport(stats, job.status === 'FAILED' || job.status === 'RETRYING')
  return { jobId: job.id, type: job.type, status: outcome === 'success' ? 'succeeded' : outcome === 'partial' ? 'partial' : 'failed', outcome, stats,
    ...(stats.failed > 0 ? { message: 'import_rows_failed' } : {}) }
}
