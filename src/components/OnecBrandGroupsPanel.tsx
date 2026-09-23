'use client'
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useRemoteResource } from '@/lib/use-remote-resource'

type Group = { externalId: string; parentId: string | null; name: string; path: string[]; isBrand: boolean; brand: { slug: string; products: number } | null }
type Node = { group: Group; children: Node[]; inheritedBrand: string | null; count: number }
const decode = (value: unknown) => value as { hasConnection: boolean; brandCount: number; groups: Group[] }

function groupTree(groups: Group[]) {
  const nodes = new Map(groups.map(group => [group.externalId, { group, children: [], inheritedBrand: null, count: 0 } as Node]))
  const roots: Node[] = []
  for (const node of Array.from(nodes.values())) {
    const parent = node.group.parentId ? nodes.get(node.group.parentId) : undefined
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  }
  const visited = new Set<string>()
  const visit = (node: Node, brand: string | null): number => {
    visited.add(node.group.externalId)
    node.inheritedBrand = brand
    node.children = node.children.filter(child => !visited.has(child.group.externalId))
    node.count = node.children.reduce((count, child) => count + 1 + visit(child, node.group.isBrand ? node.group.name : brand), 0)
    return node.count
  }
  roots.forEach(root => visit(root, null))
  return roots
}

export function OnecBrandGroupsPanel() {
  const { data, loading, error, reload } = useRemoteResource('/api/staff/integrations/onec/brand-groups', decode)
  const [query, setQuery] = useState('')
  const [onlyBrands, setOnlyBrands] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const roots = useMemo(() => groupTree(data?.groups ?? []), [data?.groups])
  const { visible, autoOpen } = useMemo(() => {
    const visible = new Set<string>(), autoOpen = new Set<string>(), term = query.trim().toLocaleLowerCase()
    const visit = (node: Node): boolean => {
      const childMatches = node.children.map(visit).some(Boolean)
      const matches = (!onlyBrands || node.group.isBrand || !!node.inheritedBrand) && node.group.path.join(' / ').toLocaleLowerCase().includes(term)
      if (matches || childMatches) visible.add(node.group.externalId)
      if (childMatches && (term || onlyBrands)) autoOpen.add(node.group.externalId)
      return matches || childMatches
    }
    roots.forEach(visit)
    return { visible, autoOpen }
  }, [roots, query, onlyBrands])
  const toggle = async (group: Group) => {
    setBusy(true); setMessage('')
    try {
      const response = await fetch('/api/staff/integrations/onec/brand-groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ externalId: group.externalId, isBrand: !group.isBrand }) })
      if (!response.ok) throw new Error(response.status === 403 ? 'Назначение брендов доступно администратору.' : 'Не удалось сохранить соответствие. Повторите запрос.')
      const result = await response.json()
      setMessage('Соответствие сохранено. Обновлено товаров: ' + result.productsUpdated)
      if (!group.isBrand) setExpanded(previous => ({ ...previous, [group.externalId]: true }))
      await reload()
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Нет связи с сервером.') }
    finally { setBusy(false) }
  }
  const setAll = (value: boolean) => setExpanded(Object.fromEntries((data?.groups ?? []).map(g => [g.externalId, value])))
  const renderNodes = (nodes: Node[], depth = 0) => <ul className="brand-tree-level">{nodes.filter(node => visible.has(node.group.externalId)).map(node => {
    const g = node.group, children = node.children.filter(child => visible.has(child.group.externalId))
    const open = expanded[g.externalId] ?? (autoOpen.has(g.externalId) || depth === 0)
    const childId = 'brand-children-' + encodeURIComponent(g.externalId)
    return <li key={g.externalId}>
      <div className={'brand-tree-row' + (g.isBrand ? ' on' : '')} style={{ paddingInlineStart: Math.min(depth, 6) * 16 + 8 }}>
        {children.length ? <button type="button" className="brand-tree-toggle" aria-expanded={open} aria-controls={childId} aria-label={(open ? 'Свернуть ' : 'Развернуть ') + g.name} onClick={() => setExpanded(previous => ({ ...previous, [g.externalId]: !open }))}>{open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</button> : <span className="brand-tree-spacer" />}
        <label className="brand-tree-label"><input type="checkbox" disabled={busy} checked={g.isBrand} aria-label={'Назначить бренд ' + g.name} onChange={() => toggle(g)} /><span><b>{g.name}</b><small>{g.isBrand ? 'Бренд' : node.inheritedBrand ? 'Входит в бренд ' + node.inheritedBrand : 'Папка 1С'}{node.count ? ' · Вложенных папок: ' + node.count : ''}</small></span></label>
        {g.isBrand && g.brand ? <Link className="brand-tree-link" href={'/brands/' + encodeURIComponent(g.brand.slug)}>{g.brand.products} товаров · Открыть бренд</Link> : null}
      </div>
      {children.length ? <div id={childId} hidden={!open}>{open ? renderNodes(children, depth + 1) : null}</div> : null}
    </li>
  })}</ul>
  return <section className="onec-status">
    <h2>Бренды из категорий 1С</h2>
    <p className="settings-note">Отметьте папку бренда — товары во всех вложенных папках получат этот бренд. Если внутри отмечен другой бренд, для его ветки действует собственное назначение. Стрелка сворачивает папку и не меняет назначения.</p>
    <div className="admin-toolbar"><label>Поиск категории<input value={query} onChange={e => { setQuery(e.target.value); setExpanded({}) }} placeholder="Название или путь" /></label><label className="admin-check"><input type="checkbox" checked={onlyBrands} onChange={e => { setOnlyBrands(e.target.checked); setExpanded({}) }} />Только ветки брендов</label><span>Отмечено: {data?.brandCount ?? 0}</span></div>
    {!!data?.groups.length ? <div className="brand-tree-toolbar"><button type="button" onClick={() => setAll(false)}>Свернуть всё</button><button type="button" onClick={() => setAll(true)}>Развернуть всё</button><span>Папок в подборке: {visible.size}</span></div> : null}
    {loading ? <p role="status">Загрузка категорий из 1С…</p> : null}
    {error ? <p role="alert">{error} <button onClick={reload}>Повторить</button></p> : null}
    {busy ? <p role="status">Применяем соответствие к товарам…</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {!loading && !error && !data?.groups.length ? <p>{data?.hasConnection ? 'В сохранённом каталоге не найдены категории с товарами. Проверьте состав каталога в разделе «Интеграции».' : 'Сначала подключите 1С в разделе «Интеграции».'}</p> : null}
    <div className="brand-groups-list brand-tree" aria-label="Дерево папок и брендов">{renderNodes(roots)}</div>
    {!!data?.groups.length && !visible.size ? <p>Ничего не найдено. Измените поиск.</p> : null}
  </section>
}
