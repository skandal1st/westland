'use client'
import Link from 'next/link'
import { CheckCircle2, FileDown } from 'lucide-react'
import { useState } from 'react'
import { StorefrontHeader } from '@/components/StorefrontHeader'
import { fulfillmentChannels } from '@/lib/commerce'
import { useCart } from '@/store/cart-store'
import { useCommerceStore } from '@/store/commerce-store'
export default function CheckoutPage() {
  const [done, setDone] = useState(false)
  const { lines, clear } = useCart()
  const paymentMethod = useCommerceStore((state) => state.paymentMethod)
  const points = useCommerceStore((state) => state.deliveryPoints)
  const selectedPointId = useCommerceStore((state) => state.selectedDeliveryPointId)
  const selectPoint = useCommerceStore((state) => state.setSelectedDeliveryPoint)
  const channel = fulfillmentChannels[paymentMethod]
  const total = lines.reduce((sum, line) => sum + line.product.price * line.quantity, 0)
  if (done) return <><StorefrontHeader /><main className="checkout-success"><CheckCircle2 /><h1>Заказ WS-DEMO создан</h1><p>{paymentMethod === 'BANK_TRANSFER' ? 'Счёт подготовлен. Заказ будет поставлен в очередь отправки в выбранную учётную систему.' : 'Наличный заказ принят и будет передан сотруднику магазина.'}</p>{paymentMethod === 'BANK_TRANSFER' ? <button className="button button-primary"><FileDown /> Скачать PDF-счёт</button> : null}<Link href="/catalog">Вернуться в каталог</Link></main></>
  return <><StorefrontHeader /><main className="checkout-page"><section><h1>Оформление заказа</h1><div className="checkout-channel"><span>Способ оплаты</span><strong>{channel.label}</strong><small>{channel.warehouseName}</small><Link href="/catalog">Изменить в каталоге</Link></div><label>Юридическое лицо<select><option>ООО «Партнёр Запад» · ИНН 0000000000</option></select></label><label>Точка доставки<select value={selectedPointId} onChange={(event) => selectPoint(event.target.value)} required><option value="" disabled>Выберите точку</option>{points.map((point) => <option key={point.id} value={point.id}>{point.name} · {point.city}, {point.address}</option>)}</select></label><Link className="manage-locations" href="/account/locations">Управлять точками доставки</Link><label>Комментарий<textarea placeholder="Комментарий к заказу" /></label></section><aside><h2>Ваш заказ</h2>{lines.map((line) => <div key={line.product.id}><span>{line.product.name} × {line.quantity}</span><b>{(line.product.price * line.quantity).toLocaleString('ru-RU')} ₽</b></div>)}<div className="checkout-total"><span>Итого</span><strong>{total.toLocaleString('ru-RU')} ₽</strong></div><button className="button button-primary" disabled={lines.length === 0 || !selectedPointId} onClick={() => { setDone(true); clear() }}>Оформить и получить счёт</button><small>{points.length === 0 ? 'Добавьте точку доставки, чтобы оформить заказ.' : paymentMethod === 'BANK_TRANSFER' ? 'После оформления будет сформирован PDF-счёт.' : 'Оплата производится при получении заказа.'}</small></aside></main></>
}
