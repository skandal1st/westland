'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

type Resource<T> = { url: string; data: T | null; loading: boolean; error: string | null }

/** Latest request wins, including retries and navigation back to an earlier URL. */
export function useRemoteResource<T>(url: string, decode: (value: unknown) => T) {
  const [state, setState] = useState<Resource<T>>({ url, data: null, loading: true, error: null })
  const sequence = useRef(0)
  const controller = useRef<AbortController | null>(null)

  const reload = useCallback(async () => {
    const request = ++sequence.current
    controller.current?.abort()
    const next = new AbortController()
    controller.current = next
    setState(previous => ({ url, data: previous.url === url ? previous.data : null, loading: true, error: null }))
    try {
      const response = await fetch(url, { signal: next.signal, cache: 'no-store' })
      if (!response.ok) {
        throw new Error(response.status === 401 ? 'Войдите в аккаунт, чтобы продолжить.' : response.status === 403 ? 'Нет доступа к этим данным. Обратитесь к менеджеру.' : 'Не удалось загрузить данные. Попробуйте ещё раз.')
      }
      const data = decode(await response.json())
      if (sequence.current === request && !next.signal.aborted) setState({ url, data, loading: false, error: null })
    } catch (error) {
      if (sequence.current === request && !next.signal.aborted) {
        setState(previous => ({ ...previous, loading: false, error: error instanceof TypeError ? 'Нет связи с сервером. Проверьте соединение и повторите запрос.' : error instanceof SyntaxError ? 'Получен некорректный ответ сервера. Повторите запрос.' : error instanceof Error ? error.message : 'Не удалось загрузить данные. Повторите запрос.' }))
      }
    }
  }, [url, decode])

  useEffect(() => {
    void reload()
    return () => { controller.current?.abort() }
  }, [reload])

  // A changed URL must never render the previous channel's prices, even before the effect runs.
  return { ...(state.url === url ? state : { data: null, loading: true, error: null }), reload }
}

export function readArray<T>(value: unknown, key: string): T[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as Record<string, unknown>)[key])) {
    throw new Error('Получен неполный ответ сервера. Повторите запрос.')
  }
  return (value as Record<string, T[]>)[key]
}
