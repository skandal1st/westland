'use client'
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRemoteResource, readArray } from '@/lib/use-remote-resource'
import { CategoryTreeControl, choicesFromRows } from './CategoryTreeControl'
type Category = { id: string; parentId: string | null; name: string; slug: string; hidden: boolean; sortOrder: number; products: number }
type Group = { externalId: string; name: string; path: string[]; depth: number; categoryId: string | null; effectiveCategoryId: string | null }
const decode = (v: unknown) => readArray<Category>(v, 'categories')
const decodeGroups = (v: unknown) => ({ groups: readArray<Group>(v, 'groups'), hasConnection: (v as { hasConnection: boolean }).hasConnection })
export function CategoriesPanel() {
  const [activeCategory, setActiveCategory] = useState('')
  const categories = useRemoteResource('/api/staff/categories', decode)
  const source = useRemoteResource('/api/staff/category-groups', decodeGroups)
  const [name,setName] = useState(''), [query,setQuery] = useState(''), [onlyRoots,setOnlyRoots] = useState(true)
  const [selected,setSelected] = useState<string[]>([]), [target,setTarget] = useState('')
  const [busy,setBusy] = useState(false), [message,setMessage] = useState('')
  const list = categories.data ?? []
  const categoryTree = useMemo(()=>choicesFromRows(categories.data??[]),[categories.data])
  const activeId = activeCategory || list.find(c=>!c.parentId)?.id
  const mutate = async (url: string, method: string, body: unknown) => {
    setBusy(true);setMessage('')
    try {
      const response = await fetch(url,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)})
      if (!response.ok) throw Error(response.status===403?'Изменение категорий доступно администратору.':'Не удалось сохранить. Обновите данные и повторите.')
      const result = await response.json()
      if (result.category) { setName('');setTarget(result.category.id);setMessage('Категория создана. Теперь выберите для неё папки 1С.') }
      else if (typeof result.productsUpdated==='number') { setSelected([]);setMessage('Соответствия сохранены. Перенесено товаров: '+result.productsUpdated) }
      else setMessage('Изменения сохранены.')
      await Promise.all([categories.reload(),source.reload()])
    } catch(e) { setMessage(e instanceof Error?e.message:'Нет связи с сервером.') }
    finally {setBusy(false)}
  }
  const visible = (source.data?.groups ?? []).filter(g => (!onlyRoots || g.depth===1) && g.path.join(' / ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  return <div className="categories-panel">
    <h2>Категории сайта</h2>
    <p className="settings-note">Создайте категорию для покупателей, затем свяжите с ней одну или несколько папок 1С. Название сайта и соответствия сохраняются при обмене. Структура 1С остаётся исходной.</p>
    <form className="admin-toolbar" onSubmit={e=>{e.preventDefault();void mutate('/api/staff/categories','POST',{name})}}><label>Новая категория<input required maxLength={200} value={name} onChange={e=>setName(e.target.value)} placeholder="Например, Табак" /></label><button className="button button-primary" disabled={busy || !name.trim()}>Создать категорию</button></form>
    {message?<p role="status">{message}</p>:null}
    {categories.loading?<p role="status">Загрузка категорий…</p>:null}
    {categories.error?<p role="alert">{categories.error} <button onClick={categories.reload}>Повторить</button></p>:null}
    <div className="category-admin-layout"><CategoryTreeControl nodes={categoryTree} selectedId={activeId} onSelect={node=>setActiveCategory(node.id)} searchable/><div className="site-category-list">{list.filter(c=>c.id===activeId).map(c=><div className="site-category-row" key={c.id+c.name+c.sortOrder}>
      <label>Название<input aria-label={'Название '+c.name} defaultValue={c.name} maxLength={200} disabled={busy} onBlur={e=>{const value=e.target.value.trim();if(value&&value!==c.name)void mutate('/api/staff/categories/'+c.id,'PATCH',{name:value});else if(!value)e.target.value=c.name}} /></label>
      <label>Порядок<input aria-label={'Порядок '+c.name} type="number" min="0" max="100000" defaultValue={c.sortOrder} disabled={busy} onBlur={e=>{const value=Number(e.target.value);if(value!==c.sortOrder&&Number.isInteger(value)&&value>=0)void mutate('/api/staff/categories/'+c.id,'PATCH',{sortOrder:value})}} /></label>
      <span>{c.products.toLocaleString('ru-RU')} товаров</span><button type="button" disabled={busy} onClick={()=>mutate('/api/staff/categories/'+c.id,'PATCH',{hidden:!c.hidden})}>{c.hidden?'Показать':'Скрыть'}</button><Link href={'/catalog?category='+encodeURIComponent(c.slug)}>Открыть</Link>
    </div>)}</div></div>
    <h2>Папки 1С → категории сайта</h2>
    <p className="settings-note">Отметьте папки и выберите категорию сайта. Вложенные папки сохраняют свою структуру внутри выбранной категории, включая новые папки при следующей загрузке. Если вложенной папке назначена своя категория, действует её правило. Снятие соответствия возвращает товары к правилу родителя или исходной категории.</p>
    <div className="admin-toolbar"><label>Поиск папки<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Название или путь в 1С" /></label><label className="admin-check"><input type="checkbox" checked={onlyRoots} onChange={e=>setOnlyRoots(e.target.checked)} />Только первый уровень</label></div>
    <fieldset className="admin-merge" disabled={busy || source.loading}>
      <legend>Выбрано папок: {selected.length}</legend><div className="admin-toolbar"><label>Категория сайта<select value={target} onChange={e=>setTarget(e.target.value)}><option value="">Выберите категорию</option>{list.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <button className="button button-primary" disabled={!selected.length || !target} onClick={()=>mutate('/api/staff/category-groups','POST',{externalIds:selected,categoryId:target})}>Назначить категорию</button><button className="button button-secondary" disabled={!selected.length} onClick={()=>mutate('/api/staff/category-groups','POST',{externalIds:selected,categoryId:null})}>Снять соответствие</button><button disabled={!selected.length} onClick={()=>setSelected([])}>Снять выбор</button></div>
      {!!selected.length&&target?<p>Выбранные папки и их вложенные товары будут показаны в «{list.find(c=>c.id===target)?.name}». Явные правила вложенных папок сохранятся.</p>:null}
    </fieldset>
    {source.loading?<p role="status">Загрузка папок 1С…</p>:source.error?<p role="alert">{source.error} <button onClick={source.reload}>Повторить</button></p>:!source.data?.hasConnection?<p>Подключите источник в разделе «Интеграции».</p>:null}
    <div className="source-group-list">{visible.map(g=><label className="source-group-row" key={g.externalId}><input type="checkbox" disabled={busy} aria-label={'Выбрать папку '+g.path.join(' / ')} checked={selected.includes(g.externalId)} onChange={e=>setSelected(prev=>e.target.checked?[...prev,g.externalId]:prev.filter(id=>id!==g.externalId))} /><span><b>{g.name}</b><small>{g.path.join(' / ')}</small></span><span>{list.find(c=>c.id===g.effectiveCategoryId)?.name ?? 'Исходная категория'}<small>{g.categoryId?'Своё правило':g.effectiveCategoryId?'Правило родителя':'Без соответствия'}</small></span></label>)}</div>
    {!source.loading&&!source.error&&!visible.length?<p>Папки не найдены. Измените поиск или включите вложенные уровни.</p>:null}
  </div>
}
