'use client'

import { useRemoteResource } from '@/lib/use-remote-resource'

function decodeContacts(value: unknown) {
  if (!value || typeof value !== 'object') throw new Error('Контакты временно недоступны.')
  const data = value as { phone?: string | null; email?: string | null }
  return { phone: typeof data.phone === 'string' ? data.phone : null, email: typeof data.email === 'string' ? data.email : null }
}

export function StorefrontContact() {
  const { data, error, reload } = useRemoteResource('/api/storefront/contacts', decodeContacts)
  if (error) return <div className="contact"><button type="button" onClick={reload}>Повторить загрузку контактов</button></div>
  if (!data?.phone && !data?.email) return null
  return <div className="contact" aria-label="Контакты магазина">
    {data.phone ? <a href={'tel:' + data.phone.replace(/[^+\d]/g, '')}>{data.phone}</a> : null}
    {data.email ? <a href={'mailto:' + data.email}>{data.email}</a> : null}
  </div>
}
