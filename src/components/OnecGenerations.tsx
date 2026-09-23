'use client'
import { useState } from 'react'

type Session = { id: string; createdAt: string; files: { name: string; size: number; sealed: boolean; kind?: string }[] }
type Data = { sessions: Session[]; generations: { id: string; createdAt: string }[] }
const reasons: Record<string, string> = {
  exchange_data_required: 'Выберите завершённый каталог или предложения из одной выгрузки 1С.',
  session_files_incomplete: 'В выбранной сессии есть недогруженные файлы. Завершите обмен.',
  duplicate_manifest_filename: 'В выбранных сессиях повторяются имена файлов. Выберите один согласованный набор.',
  session_source_changed: 'Источник изменился. Обновите список и повторите выгрузку.',
}
export function OnecGenerations({ connectionId, onSelectGeneration }: { connectionId: string; onSelectGeneration: (id: string) => void }) {
  const [data, setData] = useState<Data | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [generationSelection, setGenerationSelection] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const url = `/api/staff/integrations/${connectionId}/generations`
  async function load() {
    const response = await fetch(url)
    if (!response.ok) throw new Error('Не удалось загрузить список файлов.')
    setData(await response.json())
  }
  async function refresh() {
    setBusy(true); setMessage('')
    try { await load() } catch { setMessage('Не удалось загрузить список файлов.') } finally { setBusy(false) }
  }
  async function publish() {
    setBusy(true); setMessage('')
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionIds: selected }) })
      const result = await response.json()
      if (!response.ok) { setMessage(reasons[result.error] ?? 'Набор не сохранён. Проверьте выбор и права администратора.'); return }
      onSelectGeneration(result.id); setGenerationSelection(result.id); setSelected([]); await load(); setMessage(`Выбран зафиксированный набор от ${new Date(result.createdAt).toLocaleString('ru-RU')}.`)
    } catch { setMessage('Не удалось связаться с сервером.') } finally { setBusy(false) }
  }
  return <div style={{ gridColumn: '1 / -1' }}>
    <button type="button" disabled={busy} onClick={refresh}>Файлы обмена</button>
    {data ? <div>
      <p>Выберите сессии одной выгрузки: каталог, предложения или оба файла. В импорт попадут только выбранные завершённые файлы.</p>
      {data.generations[0] ? <p>Последний набор: {new Date(data.generations[0].createdAt).toLocaleString('ru-RU')}</p> : <p>Готового набора для импорта пока нет.</p>}
      {data.generations.length ? <label>Набор для проверки или синхронизации<select value={generationSelection} disabled={busy} onChange={event => { setGenerationSelection(event.target.value); onSelectGeneration(event.target.value) }}><option value="" disabled>Выберите набор</option>{data.generations.map(g => <option key={g.id} value={g.id}>{new Date(g.createdAt).toLocaleString("ru-RU")} · {g.id}</option>)}</select></label> : null}
      {data.sessions.length === 0 ? <p>Выполните обмен из 1С, затем обновите список.</p> : null}
      {data.sessions.map(session => <label key={session.id} style={{ display: 'block', margin: '8px 0' }}>
        <input type="checkbox" disabled={busy || !session.files.length || session.files.some(file => file.name.toLowerCase().endsWith('.xml') && !file.sealed)} checked={selected.includes(session.id)} onChange={event => setSelected(ids => event.target.checked ? [...ids, session.id] : ids.filter(id => id !== session.id))} />
        {new Date(session.createdAt).toLocaleString('ru-RU')} — {session.files.map(file => `${file.name} (${Math.ceil(file.size / 1024)} КБ, ${file.sealed ? 'завершён' : file.name.toLowerCase().endsWith('.xml') ? 'принимается' : 'ожидает фиксации'})`).join('; ') || 'нет файлов'}
      </label>)}
      <button type="button" disabled={busy || !selected.length} onClick={publish}>Зафиксировать выбранный набор</button>
    </div> : null}
    {message ? <p role="status">{message}</p> : null}
  </div>
}
