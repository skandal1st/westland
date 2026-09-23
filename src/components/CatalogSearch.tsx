'use client'

import { Search } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState, type FormEvent } from 'react'

export function CatalogSearch({ className, onSearch }: { className: string; onSearch?: () => void }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const current = pathname === '/catalog' ? params.get('q') ?? '' : ''
  const [query, setQuery] = useState(current)
  useEffect(() => { setQuery(current) }, [current])
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const next = new URLSearchParams(pathname === '/catalog' ? params.toString() : '')
    next.delete('page')
    next.delete('filter')
    if (query.trim()) next.set('q', query.trim())
    else next.delete('q')
    onSearch?.()
    router.push('/catalog' + (next.size ? '?' + next.toString() : ''), { scroll: false })
  }
  return <form className={className} role="search" aria-label="Поиск в шапке" onSubmit={submit}>
    <button type="submit" aria-label="Найти товары"><Search aria-hidden="true" /></button>
    <input type="search" name="q" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} aria-label="Поиск по каталогу" placeholder="Название или артикул" />
  </form>
}
