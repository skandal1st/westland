'use client'
import { useEffect, useState, type FormEvent } from 'react'
import { formatMoney } from '@/lib/money-format'
import type { CommercialSnapshot } from '@/lib/orders/commercial-snapshot'

const ERRORS:Record<string,string>={
 NOT_FOUND:'Заказ не найден.',FORBIDDEN:'Недостаточно прав для подтверждения.',INVALID_STATE:'Заказ пока нельзя подтвердить: проверьте получение в 1С и его текущий статус.',
 INVALID_INPUT:'Заполните номер, дату, суммы и оба подтверждения проверки.',TERMS_CHANGED:'Условия изменились. Закройте форму и откройте её снова для сверки.',AMOUNTS_MISMATCH:'Сумма или НДС не совпадают с заявкой. Не подтверждайте изменённый заказ: требуется согласование с покупателем.',CANCELLATION_REQUESTED:'Покупатель запросил отмену. Сначала обработайте обращение.',ALREADY_CONFIRMED:'Заказ уже проверен. Обновите список.',DOCUMENT_ALREADY_LINKED:'Этот документ 1С уже связан с другим заказом.',
}
export function ManualOrderConfirmation({orderId,onDone,onClose}:{orderId:string;onDone:()=>Promise<void>;onClose:()=>void}){
 const [preview,setPreview]=useState<{number:string;terms:CommercialSnapshot;termsHash:string}|null>(null)
 const [error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false)
 const [number,setNumber]=useState(''),[date,setDate]=useState(''),[total,setTotal]=useState(''),[vat,setVat]=useState('')
 const [matched,setMatched]=useState(false),[checked,setChecked]=useState(false)
 useEffect(()=>{let active=true;fetch('/api/staff/orders/'+orderId+'/manual-confirm').then(async r=>{const data=await r.json();if(!r.ok)throw Error(ERRORS[data.error]||'Не удалось открыть условия заказа.');if(active)setPreview(data)}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[orderId])
 async function submit(e:FormEvent){
  e.preventDefault();if(!preview||busy)return;setBusy(true);setError(null)
  try{
   const normalize=(s:string)=>{const value=s.trim().replace(',','.');return /^\d+(\.\d{1,2})?$/.test(value)?value.split('.')[0]+'.'+(value.split('.')[1]||'').padEnd(2,'0'):value}
   const r=await fetch('/api/staff/orders/'+orderId+'/manual-confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({documentNumber:number,documentDate:date,total:normalize(total),vatAmount:normalize(vat),termsHash:preview.termsHash,termsMatch:matched,vatChecked:checked})})
   const result=await r.json();if(!r.ok)throw Error(ERRORS[result.error]||'Подтверждение не выполнено. Проверьте права и доступность сервиса.')
   await onDone();onClose()
  }catch(e){setError(e instanceof Error?e.message:'Не удалось подтвердить заказ. Повторите попытку.')}finally{setBusy(false)}
 }
 const t=preview?.terms
 return <form className="manual-order-confirmation" onSubmit={submit} aria-label="Проверка заказа в 1С">
  <h3>Проверка заказа в 1С{preview?' · '+preview.number:''}</h3>
  <p>Сверьте документ 1С с этими условиями. При отличиях сначала согласуйте изменения с покупателем.</p>
  {error?<p role="alert">{error}</p>:null}
  {!t&&!error?<p role="status">Загрузка условий…</p>:null}
  {t?<>
   <dl className="manual-order-parties">
    <div><dt>Продавец</dt><dd>{t.seller?.companyName} · ИНН {t.seller?.inn}</dd></div>
    <div><dt>Покупатель</dt><dd>{t.buyer.legalName} · ИНН {t.buyer.inn}</dd></div>
    <div><dt>Доставка</dt><dd>{t.delivery.city}, {t.delivery.address}</dd></div>
    <div><dt>Склад / оплата</dt><dd>{t.warehouse.name} · {t.channel.paymentMethod==='CASH'?'Наличный расчёт':'Безналичный расчёт'}</dd></div>
   </dl>
   <ul className="manual-order-lines">{t.lines.map(line=><li key={line.id}><b>{line.name}</b><span>{line.sourceSku||line.sku} · {line.quantity} × {formatMoney(line.unitPrice)} = {formatMoney(line.lineTotal)} {t.currency}</span></li>)}</ul>
   <p><b>Итого: {formatMoney(t.total)} {t.currency}</b> · {t.tax.mode==='NO_VAT'?'Без НДС':'НДС '+t.tax.rate+'% включён: '+formatMoney(t.tax.amount!)} </p>
   <div className="manual-order-fields">
    <label>Номер документа 1С<input autoFocus required maxLength={64} value={number} onChange={e=>setNumber(e.target.value)} disabled={busy}/></label>
    <label>Дата документа 1С<input required type="date" value={date} onChange={e=>setDate(e.target.value)} disabled={busy}/></label>
    <label>Сумма в документе 1С<input required inputMode="decimal" value={total} onChange={e=>setTotal(e.target.value)} disabled={busy}/></label>
    <label>НДС в документе 1С<input required inputMode="decimal" value={vat} onChange={e=>setVat(e.target.value)} disabled={busy}/></label>
   </div>
   <label className="manual-order-check"><input type="checkbox" required checked={matched} onChange={e=>setMatched(e.target.checked)} disabled={busy}/>Состав, количество, цены, стороны, доставка и способ оплаты совпадают; заказ согласован в 1С.</label>
   <label className="manual-order-check"><input type="checkbox" required checked={checked} onChange={e=>setChecked(e.target.checked)} disabled={busy}/>НДС проверен, при необходимости пересчитан, документ сохранён.</label>
  </>:null}
  <div className="manual-order-actions"><button className="button button-primary" type="submit" disabled={!t||busy}>{busy?'Сохранение…':'Подтвердить проверку'}</button><button className="button button-secondary" type="button" onClick={onClose} disabled={busy}>Закрыть</button></div>
 </form>
}
