'use client'

import { useRef, useState } from 'react'
import { FileText } from 'lucide-react'

export function InvoiceDownloadLink({ orderId, label = 'Счёт (PDF)' }: { orderId: string; label?: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inProgress = useRef(false)
  async function download() {
    if (inProgress.current) return
    inProgress.current = true
    setBusy(true); setError(null)
    try {
      const response = await fetch('/api/orders/' + encodeURIComponent(orderId) + '/invoice/pdf', { cache: 'no-store' })
      if (!response.ok || !response.headers.get('content-type')?.includes('application/pdf')) throw new Error('pdf_unavailable')
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url; link.download = 'invoice-' + orderId + '.pdf'
      document.body.appendChild(link); link.click(); link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch { setError('Не удалось скачать счёт. Повторите скачивание или обратитесь к менеджеру.') }
    finally { inProgress.current = false; setBusy(false) }
  }
  return <span className="invoice-download">
    <button type="button" className="button button-secondary" disabled={busy} onClick={download}><FileText />{busy ? 'Загрузка счёта…' : error ? 'Повторить скачивание счёта' : label}</button>
    {error ? <span role="alert">{error}</span> : null}
  </span>
}
