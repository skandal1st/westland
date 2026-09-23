'use client'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { CategoryNode } from '@/lib/catalog/tree'
export function CascadeCatalogMenu({nodes,onNavigate}:{nodes:CategoryNode[];onNavigate:()=>void}) {
  const [path,setPath]=useState<string[]>([]), scroller=useRef<HTMLDivElement>(null)
  const columns:Array<{parent:CategoryNode|null;nodes:CategoryNode[]}>= [{parent:null,nodes}]
  for(const id of path){const selected=columns[columns.length-1].nodes.find(n=>n.id===id);if(!selected?.children.length)break;columns.push({parent:selected,nodes:selected.children})}
  useEffect(()=>{const el=scroller.current;if(el)el.scrollTo({left:Math.max(0,el.scrollWidth-el.clientWidth),behavior:'auto'})},[path])
  return <nav className="cascade-menu" aria-label="Категории каталога"><div className="cascade-menu-intro"><Link href="/catalog" onClick={onNavigate}>Весь каталог</Link><span>Выберите категорию, затем вложенную папку</span>{path.length?<button className="cascade-back" type="button" onClick={()=>setPath(path.slice(0,-1))}>← Назад</button>:null}</div><div className="cascade-columns" ref={scroller}>{columns.map((column,depth)=><section className="cascade-column" key={column.parent?.id??'root'} aria-label={column.parent?.name??'Категории верхнего уровня'}><div className="cascade-column-heading"><strong>{column.parent?.name??'Категории'}</strong>{column.parent?<Link href={'/catalog?category='+encodeURIComponent(column.parent.slug)} onClick={onNavigate}>Все товары категории</Link>:null}</div>{column.nodes.map(node=>node.children.length?<button type="button" key={node.id} className={'cascade-item'+(path[depth]===node.id?' selected':'')} aria-pressed={path[depth]===node.id} onClick={()=>setPath([...path.slice(0,depth),node.id])}><span>{node.name}</span><ChevronRight size={16}/></button>:<Link className="cascade-item" key={node.id} href={'/catalog?category='+encodeURIComponent(node.slug)} onClick={onNavigate}><span>{node.name}</span><small>{node.count}</small></Link>)}</section>)}</div>{!nodes.length?<p className="mega-empty">Категории появятся после импорта каталога.</p>:null}</nav>
}
