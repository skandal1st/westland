import { OUTCOME_LABELS, STATUS_LABELS, STAGE_LABELS, reasonLabel, type SyncReport, type StageResult } from '@/lib/integrations/import-result'
export function ImportStages({ results }: { results: StageResult[] }) {
  return <table><thead><tr><th>Этап</th><th>Результат</th><th>Применено / без изменений / ошибок строк / снято</th></tr></thead>
    <tbody>{results.map(stage => <tr key={stage.type}>
      <td>{STAGE_LABELS[stage.type] ?? 'Этап обмена'}</td>
      <td>{STATUS_LABELS[stage.status] ?? 'Статус не определён'}{stage.status === 'retrying' && stage.outcome === 'partial' ? ' · часть данных применена' : ''}
        {stage.message ? <div>{reasonLabel(stage.message)}</div> : null}
        {stage.issues?.length ? <ul>{stage.issues.map((issue, index) => <li key={index}>{issue.externalId ? `${issue.externalId}: ` : ''}{reasonLabel(issue.message)}</li>)}</ul> : null}
      </td>
      <td>{stage.stats ? `${stage.stats.imported} / ${stage.stats.skipped ?? 0} / ${stage.stats.failed} / ${stage.stats.removed ?? 0}` : '—'}
        {stage.stats?.catalogDeleted ? <div>Исключено по удалению в каталоге: {stage.stats.catalogDeleted} товаров</div> : null}
        {stage.stats?.unknownDeleted ? <div>Удалённых товаров без локальной записи: {stage.stats.unknownDeleted}</div> : null}
        {stage.stats?.previouslyProcessed ? <div>В предыдущих попытках обработано: {stage.stats.previouslyProcessed}</div> : null}
      </td>
    </tr>)}</tbody>
  </table>
}
export function ImportResult({ report }: { report: SyncReport }) {
  return <section aria-label="Результат синхронизации" style={{ gridColumn: '1 / -1', overflowX: 'auto' }}>
    <p role="status"><strong>{OUTCOME_LABELS[report.outcome]}</strong></p>
    <ImportStages results={report.results} />
    {report.outcome === 'pending' || report.outcome === 'running' ? <small>Состояние обновляется автоматически. Следующий этап начнётся после успешного завершения предыдущего; временные ошибки повторяются по расписанию.</small> : <small>Отчёт этого запуска сохранён. Повтор отдельного задания не запускает оставшиеся этапы; после исправления причин запустите синхронизацию заново.</small>}
  </section>
}
