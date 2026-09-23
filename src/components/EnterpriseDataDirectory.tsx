'use client';
import { useState, type FormEvent } from 'react';
type Row = {
    id: string;
    kind: string;
    externalId: string;
    name: string;
    inn: string;
    kpp: string;
    archived: boolean;
    syncToSite: boolean;
    updatedAt: string;
    normalized: {
        counterpartyIds?: string[];
        fullName?: string;
        article?: string;
        code?: string;
        baseUnit?: {
            code: string;
            name: string;
        };
        contacts?: {
            kind: string;
            label: string;
            display: string;
        }[];
    };
    links: {
        assignment?: {origin: 'MANUAL' | 'ONE_C'; customerName: string; reason?: string; assignedAt: string} | null;
        entityType: string;
        entityId: string;
        name: string;
    }[];
};
type Result = {
    counterparties?: {externalId: string; name: string; inn: string}[];
    rows: Row[];
    total: number;
    page: number;
    editable: boolean;
    latest: {
        receivedAt: string;
        objectCount: number;
    } | null;
};
const errors: Record<string, string> = { partner_customer_mapping_required: 'Сначала сопоставьте выбранного контрагента сайта с его карточкой в справочнике «Контрагенты».', partner_customer_link_required: 'Прямая связь с выбранным контрагентом не найдена. Проверьте принадлежность точки и подтвердите ручное сопоставление с основанием.', partner_file_size: 'Файл больше 4 МБ. Выгрузите меньшую группу партнёров.', partner_file_invalid: 'Файл не соответствует формату AXIMA.Partners/1.', partner_source_mismatch: 'Файл относится к другому источнику 1С.', partner_snapshot_stale: 'Получен более старый или конфликтующий снимок. Сделайте новую выгрузку.', partner_batch_conflict: 'Этот пакет уже был загружен с другим содержимым.', ed_point_restrictions_required: 'Сначала назначьте существующие точки каждому покупателю этого контрагента в управлении точками. Это исключит автоматический доступ к новой точке.', ed_customer_requisites_mismatch: 'ИНН/КПП выбранного покупателя не совпадают с карточкой 1С.', ed_customer_identity_changed: 'Контрагент уже закреплён за отправленными заказами. Изменение этой связи требует отдельного разбора.', mapping_target_in_use: 'Карточка сайта уже связана с другой записью 1С.', product_source_conflict: 'Товар принадлежит другому источнику.', product_remap_requires_migration: 'У товара уже есть другая связь. Перенос требует отдельного разбора.', ed_point_already_linked: 'Эта точка уже связана с другим покупателем.', ed_directory_record_archived: 'Карточка 1С отмечена как устаревшая.', source_jobs_pending: 'Дождитесь завершения текущего импорта.' };
export function EnterpriseDataDirectory({ connectionId }: {
    connectionId: string;
}) {
    const [data, setData] = useState<Result | null>(null), [kind, setKind] = useState('counterparty'), [query, setQuery] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [selected, setSelected] = useState<Row | null>(null);
    const [targetQuery, setTargetQuery] = useState(''), [choices, setChoices] = useState<{
        id: string;
        name: string;
        locations?: {id: string; name: string; city: string; address: string}[];
    }[]>([]), [entityId, setEntityId] = useState('');
    const [locationId, setLocationId] = useState('');
    const [manual, setManual] = useState(false), [reason, setReason] = useState('');
    const [point, setPoint] = useState({ name: '', city: '', address: '' });
    const url = `/api/staff/integrations/${connectionId}/directory`;
    async function load(page = 1) { setBusy(true); setMessage(''); try {
        const r = await fetch(url + '?' + new URLSearchParams({ kind, q: query, page: String(page) }));
        if (!r.ok)
            throw Error();
        setData(await r.json());
        setSelected(null);
    }
    catch {
        setMessage('Не удалось загрузить справочник. Повторите запрос.');
    }
    finally {
        setBusy(false);
    } }
    function select(row: Row) { setLocationId(''); setManual(false); setReason(''); setSelected(row); setEntityId(''); setChoices([]); setTargetQuery(row.inn || row.name); setPoint({ name: row.name, city: '', address: '' }); setMessage(''); }
    async function searchTargets(e: FormEvent) { e.preventDefault(); setBusy(true); try {
        const r = await fetch(url + '?' + new URLSearchParams({ mode: 'choices', kind: selected!.kind, q: targetQuery }));
        if (!r.ok)
            throw Error();
        setChoices((await r.json()).choices);
    }
    catch {
        setMessage('Поиск недоступен. Повторите запрос.');
    }
    finally {
        setBusy(false);
    } }
    async function act(action: string) { if (!selected)
        return; setBusy(true); setMessage(''); try {
        const body = { action, recordId: selected.id, ...(action === 'linkCustomer' ? { entityId } : action === 'syncProduct' && entityId ? { entityId } : action === 'createPoint' ? { customerId: entityId, ...point, ...(locationId ? {locationId} : {}), ...(selected.kind === 'partner' && manual ? { manualAssignment: { confirmed: true, reason } } : {}) } : {}) };
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const result = await r.json();
        if (!r.ok) {
            setMessage(errors[result.error] ?? 'Не удалось сохранить. Проверьте выбранную карточку и права администратора.');
            return;
        }
        await load(data?.page ?? 1);
        setMessage(action === 'createPoint' ? 'Связь точки сохранена. Доступ покупателю назначается в управлении точками.' : 'Связь и настройки обновления сохранены.');
    }
    catch {
        setMessage('Не удалось связаться с сервером.');
    }
    finally {
        setBusy(false);
    } }
    async function uploadPartners(file: File) {
        setBusy(true); setMessage('');
        try {
            if (file.size > 4 * 1024 * 1024) { setMessage(errors.partner_file_size); return; }
            const r = await fetch(url + '/partners', {method: 'POST', headers: {'content-type': 'application/json'}, body: file});
            const result = await r.json();
            if (!r.ok) { setMessage(errors[result.error] ?? 'Импорт не выполнен. Проверьте файл и права администратора.'); return; }
            setMessage(`Партнёров принято: ${result.objects}${result.reused ? '. Этот пакет уже загружался' : ''}. Выберите справочник «Партнёры / точки» и нажмите «Найти».`);
        } catch { setMessage('Не удалось загрузить файл.'); }
        finally { setBusy(false); }
    }
    return <div style={{ gridColumn: '1 / -1' }}>
  <button type="button" disabled={busy} onClick={() => load()}>Справочники 1С</button>
  {data && <section aria-label="Справочники 1С">
   <p>Полученные из 1С карточки хранятся отдельно от аккаунтов. Связи с покупателями и доступ к точкам назначаются на сайте.</p>
   {data.editable && <details><summary>Импорт ранее сохранённого файла партнёров</summary><p>Код источника: <code>{connectionId}</code></p><p>Для ранее сохранённых файлов AXIMA.Partners/1. Это разовый импорт, он не включает автоматическую синхронизацию. Существующие назначения точек сохраняются.</p><input type="file" accept=".json,application/json" aria-label="Файл партнёров 1С" disabled={busy} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void uploadPartners(file); }}/></details>}
   <form onSubmit={e => { e.preventDefault(); void load(); }} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
    <label>Справочник <select value={kind} disabled={busy} onChange={e => { setKind(e.target.value); setSelected(null); }}><option value="counterparty">Контрагенты</option><option value="partner">Партнёры / точки</option><option value="product">Номенклатура</option><option value="productGroup">Группы номенклатуры</option><option value="counterpartyGroup">Группы контрагентов</option></select></label>
    <label>Название, ИНН или код 1С <input value={query} maxLength={100} onChange={e => setQuery(e.target.value)}/></label><button disabled={busy}>Найти</button>
   </form>
   <p>Найдено: {data.total}. {data.latest ? `Последний пакет: ${new Date(data.latest.receivedAt).toLocaleString('ru-RU')}, записей: ${data.latest.objectCount}.` : 'Пакеты EnterpriseData ещё не поступали. Состав справочников зависит от настроенного источника.'}</p>
   <div style={{ overflowX: 'auto' }}><table><thead><tr><th>Карточка 1С</th><th>ИНН / артикул</th><th>Связь с сайтом</th><th>Действия</th></tr></thead><tbody>{data.rows.map(row => <tr key={row.id}><td>{row.name}{row.archived ? ' · устарела' : ''}</td><td>{row.inn || row.normalized.article || row.normalized.code || '—'}</td><td>{row.links.length ? row.links.map(l => l.name).join(', ') : 'Не назначена'}{row.syncToSite ? ' · обновление товара включено' : ''}</td><td><button type="button" disabled={busy} onClick={() => select(row)}>Открыть</button></td></tr>)}</tbody></table></div>
   <div><button type="button" disabled={busy || data.page === 1} onClick={() => load(data.page - 1)}>Назад</button> Страница {data.page} <button type="button" disabled={busy || data.page * 25 >= data.total} onClick={() => load(data.page + 1)}>Далее</button></div>
   {selected && <div style={{ border: '1px solid #d4d4d8', padding: 16, marginTop: 12, borderRadius: 8 }}>
    <h4>{selected.name}</h4>{selected.links.map(l => <div key={l.entityType}><p>Связь: {l.name}</p>{l.assignment && <p>Контрагент: {l.assignment.customerName}. {l.assignment.origin === 'MANUAL' ? 'Назначено вручную' : 'По прямой связи из 1С'} · {new Date(l.assignment.assignedAt).toLocaleString('ru-RU')}{l.assignment.reason ? ` · Основание: ${l.assignment.reason}` : ''}</p>}</div>)}<p>Код 1С: {selected.externalId}</p>{selected.normalized.fullName && <p>{selected.normalized.fullName}</p>}
    {selected.kind === 'partner' && <div><strong>Контрагенты по связи из 1С</strong>{selected.normalized.counterpartyIds?.length ? selected.normalized.counterpartyIds.map(id => {const c = data.counterparties?.find(v => v.externalId === id); return <p key={id}>{c ? `${c.name} · ${c.inn}` : `${id} — карточка контрагента ещё не получена`}</p>;}) : <p>Прямые связи не переданы. Администратор может проверить принадлежность точки и сопоставить её с контрагентом вручную.</p>}</div>}
    {selected.normalized.contacts?.map((c, i) => <p key={i} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{c.label || c.kind}: {c.display}</p>)}
    {data.editable && !selected.archived && ['product', 'counterparty', 'partner'].includes(selected.kind) && <>
     <form onSubmit={searchTargets}><label>Найти {selected.kind === 'product' ? 'товар' : 'контрагента'} сайта <input value={targetQuery} maxLength={100} onChange={e => setTargetQuery(e.target.value)}/></label><button disabled={busy}>Поиск</button></form>
     <label>Карточка сайта <select value={entityId} disabled={busy} onChange={e => { setEntityId(e.target.value); setLocationId(''); setPoint({name: selected.name, city: '', address: ''}); setManual(false); setReason(''); }}><option value="">Выберите карточку</option>{choices.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
     {selected.kind === 'product' ? <><p>Включение обновляет базовые сведения товара. Описания витрины, цены, остатки и изображения этим действием не заменяются. Без выбора используется существующая связь или создаётся новая карточка товара.</p><button type="button" disabled={busy} onClick={() => act('syncProduct')}>Включить обновление товара</button></> : <>
      {selected.kind === 'counterparty' && <button type="button" disabled={busy || !entityId} onClick={() => act('linkCustomer')}>Связать контрагента с покупателем</button>}
      <details><summary>Сопоставить точку с выбранным контрагентом</summary><p>Используйте для карточки магазина или филиала. Проверьте адрес из 1С. Доступ пользователям назначается отдельно.</p>
       <form onSubmit={e => { e.preventDefault(); void act('createPoint'); }}><label>Точка сайта <select value={locationId} disabled={busy || !entityId} onChange={e => { const id = e.target.value; setLocationId(id); setManual(false); setReason(''); const location = choices.find(c => c.id === entityId)?.locations?.find(l => l.id === id); setPoint(location ? {name: location.name, city: location.city, address: location.address} : {name: selected.name, city: '', address: ''}); }}><option value="">Создать новую точку</option>{choices.find(c => c.id === entityId)?.locations?.map(l => <option key={l.id} value={l.id}>{l.name} · {l.city}, {l.address}</option>)}</select></label>{(['name', 'city', 'address'] as const).map((key, i) => <label key={key}>{['Название точки', 'Город', 'Адрес'][i]} <input required readOnly={!!locationId} value={point[key]} maxLength={key === 'address' ? 2000 : 200} onChange={e => setPoint(v => ({ ...v, [key]: e.target.value }))}/></label>)}{selected.kind === 'partner' && <fieldset disabled={busy || !entityId}><legend>Сопоставление контрагента</legend><p>По умолчанию проверяется прямая связь из 1С. Для ручного назначения сначала сопоставьте контрагента сайта с карточкой 1С в справочнике «Контрагенты».</p><label><input type="checkbox" checked={manual} onChange={e => setManual(e.target.checked)}/> Подтверждаю принадлежность этой точки контрагенту «{choices.find(c => c.id === entityId)?.name ?? 'выберите карточку'}» и назначаю связь вручную</label>{manual && <label>Основание назначения <textarea required minLength={5} maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} placeholder="Например: принадлежность точки подтверждена владельцем"/></label>}</fieldset>}<button disabled={busy || !entityId || (manual && reason.trim().length < 5)}>{locationId ? 'Сохранить сопоставление' : 'Создать точку и сохранить связь'}</button></form>
      </details>
     </>}
    </>}
    {data.editable && selected.syncToSite && <button type="button" disabled={busy} onClick={() => act('stopProductSync')}>Остановить обновление товара</button>}
    <button type="button" onClick={() => setSelected(null)}>Закрыть карточку</button>
   </div>}
  </section>}
  {message && <p role="status">{message}</p>}
 </div>;
}
