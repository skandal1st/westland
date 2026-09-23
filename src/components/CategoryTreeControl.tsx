'use client'
import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
export type TreeChoice = { id: string; name: string; slug?: string; count?: number; children: TreeChoice[] }
export function CategoryTreeControl({ nodes, selectedId, onSelect, disabled=false, label='Категории', searchable=false }: { nodes: TreeChoice[]; selectedId?: string | null; onSelect:(node:TreeChoice)=>void; disabled?:boolean; label?:string; searchable?:boolean }) {
  const [expanded,setExpanded]=useState<Record<string,boolean>>({}),[query,setQuery]=useState('')
  const ancestors=useMemo(()=>{const result:string[]=[];const visit=(rows:TreeChoice[],path:string[]):boolean=>rows.some(n=>{if(n.id===selectedId){result.push(...path);return true}return visit(n.children,[...path,n.id])});visit(nodes,[]);return result},[nodes,selectedId])
  useEffect(()=>{setExpanded(old=>({...old,...Object.fromEntries(ancestors.map(id=>[id,true]))}))},[ancestors])
  const filtered=useMemo(()=>{const term=query.trim().toLocaleLowerCase();const visit=(rows:TreeChoice[]):TreeChoice[]=>rows.flatMap(n=>{if(!term||n.name.toLocaleLowerCase().includes(term))return [n];const children=visit(n.children);return children.length?[{...n,children}]:[]});return visit(nodes)},[nodes,query])
  const render=(rows:TreeChoice[],depth=0)=><ul className="category-tree-level">{rows.map(n=>{const open=expanded[n.id]??!!query;return <li key={n.id}><div className={'category-tree-row'+(selectedId===n.id?' selected':'')} style={{paddingInlineStart:Math.min(depth,6)*12}}>{n.children.length?<button type="button" className="category-tree-disclosure" aria-expanded={open} aria-label={(open?'Свернуть ':'Развернуть ')+n.name} onClick={()=>setExpanded(old=>({...old,[n.id]:!open}))}>{open?<ChevronDown size={16}/>:<ChevronRight size={16}/>}</button>:<span className="category-tree-spacer"/>}<button type="button" className="category-tree-choice" disabled={disabled} aria-pressed={selectedId===n.id} onClick={()=>{setExpanded(old=>({...old,[n.id]:true}));onSelect(n)}}><span>{n.name}</span>{n.count!==undefined?<small>{n.count}</small>:null}</button></div>{open&&n.children.length?render(n.children,depth+1):null}</li>})}</ul>
  return <div className="category-tree-control" aria-label={label}>{searchable?<label className="category-tree-search">Поиск папки<input value={query} onChange={e=>{setQuery(e.target.value);setExpanded({})}} placeholder="Название категории"/></label>:null}{render(filtered)}{!filtered.length?<p>Папки не найдены.</p>:null}</div>
}
export function choicesFromRows(rows: {id:string;parentId:string|null;name:string;slug?:string}[]):TreeChoice[] {
  const nodes=new Map(rows.map(r=>[r.id,{id:r.id,name:r.name,slug:r.slug,children:[]} as TreeChoice])),roots:TreeChoice[]=[]
  for(const row of rows){const node=nodes.get(row.id)!,parent=row.parentId?nodes.get(row.parentId):undefined;if(parent&&parent!==node)parent.children.push(node);else roots.push(node)}
  return roots
}
