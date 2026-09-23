/** One-off user-requested 22% trial. Only the isolated R22 database; no runtime format changes. */
import fs from 'node:fs'
import type {PrismaClient} from '@prisma/client'
import {prisma as db} from '../src/lib/db'
import {setCartChannel,setCartItem} from '../src/lib/cart/cart'
import {checkout} from '../src/lib/cart/checkout'
import {submitOrder} from '../src/lib/orders/orders'
import {assertLicenseActive,reloadLicenseState} from '../src/lib/license'
import {recordAudit} from '../src/lib/audit'
import {querySales} from '../src/lib/integrations/onec/sale'
import {openExchangeSession} from '../src/lib/integrations/onec/ledger'
import {sourceCredentials} from '../src/lib/integrations/onec/credentials'
import {sha256} from '../src/lib/integrations/onec/storage'
import {readCommercialSnapshot} from '../src/lib/orders/commercial-snapshot'
async function main(){
 const url=new URL(process.env.DATABASE_URL||'')
 if(process.env.R22_ACCEPTANCE!=='1'||url.hostname!=='postgres-r22'||url.pathname!=='/axima_r22_acceptance')throw Error('isolated_database_required')
 const plan=JSON.parse(fs.readFileSync('/app/r22-config/test-order-plan.json','utf8'))
 const source=await db.integrationConnection.findUniqueOrThrow({where:{id:plan.sourceConnectionId},include:{store:true}})
 if(source.store.slug!=='r22-acceptance'||source.environment!=='TEST'||source.id!==process.env.ONEC_EXCHANGE_CONNECTION_ID||source.provider!=='ONE_C')throw Error('test_source_required')
 assertLicenseActive(reloadLicenseState())
 const key='r23-vat-percent-test'
 const existing=await db.checkoutReceipt.findUnique({where:{key},include:{order:{include:{export:true}}}})
 if(existing&&(existing.order.storeId!==source.storeId||existing.order.status!=='SUBMITTED'||existing.order.export?.status!=='PENDING'||existing.order.export.attempts!==0))throw Error('existing_trial_already_transmitted_inspect_it')
 if(await db.orderExport.count({where:{connectionId:source.id,...(existing?{orderId:{not:existing.orderId}}:{}),status:{in:['PENDING','RETRYING','AWAITING_ACK']}}}))throw Error('other_queued_orders')
 const before=await db.onecSaleDelivery.findMany({where:{connectionId:source.id},orderBy:{id:'asc'}})
 const old=await db.order.findUniqueOrThrow({where:{id:'cmubnj1dg000a13cvc8ss6yth'},include:{user:true,export:{include:{onecDelivery:true}}}})
 if(old.storeId!==source.storeId||old.number!=='R22-00004'||old.status!=='SUBMITTED'||old.export?.status!=='DELIVERED'||old.export.onecDelivery?.sha256!=='c75f1778cc0a84ef99ab247b1ad6c81a5d547322546f11bf11cf0a3d6a94c64f')throw Error('previous_order_changed')
 const actor=await db.user.findUniqueOrThrow({where:{storeId_email:{storeId:source.storeId,email:'r22-acceptance@localhost'}}})
 await setCartChannel(old.user,old.fulfillmentChannelId)
 await setCartItem(old.user,plan.line.variantId,1)
 const draft=existing?.order??await checkout(old.user,{deliveryLocationId:old.deliveryLocationId,comment:plan.comment+'; проба формата ставки 22% вместо 22 по просьбе пользователя; НЕ ОТГРУЖАТЬ, НЕ ОПЛАЧИВАТЬ',idempotencyKey:key})
 if(!draft.total.equals('270'))throw Error('test_price_changed')
 const order=existing?draft:await submitOrder(old.user,draft.id)
 const terms=readCommercialSnapshot(order.commercialSnapshot,order)
 if(!terms||terms.tax.rate!==22||terms.tax.amount!=='48.69'||terms.total!=='270.00')throw Error('snapshot_mismatch')
 const exp=await db.orderExport.findUniqueOrThrow({where:{orderId:order.id}})
 const credentials=await sourceCredentials(),credential=credentials.find(c=>c.connectionId===source.id)
 if(!credential)throw Error('credential_missing')
 const secret=process.env.NEXTAUTH_SECRET!
 const session=await openExchangeSession(source.storeId,credential,secret)
 let changed=0
 const client={$transaction:async(work:any,options:any)=>db.$transaction(async tx=>{
  const createTrial=async(args:any)=>{
   if(args.data.exportId!==exp.id||args.data.connectionId!==source.id)throw Error('unexpected_delivery')
   const original=args.data.xml as string
   if(!original.includes('<Ид>'+order.id+'</Ид>')||(original.split('<Ставка>22</Ставка>').length-1)!==3)throw Error('unexpected_rate_fields')
   const xml=original.replaceAll('<Ставка>22</Ставка>','<Ставка>22%</Ставка>')
   if(xml.replaceAll('<Ставка>22%</Ставка>','<Ставка>22</Ставка>')!==original)throw Error('unexpected_xml_change')
   changed++
   return tx.onecSaleDelivery.create({...args,data:{...args.data,xml,sha256:sha256(Buffer.from(xml))}})
  }
  const delegate=new Proxy(tx.onecSaleDelivery,{get(target,prop){if(prop==='create')return createTrial;const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value}})
  const wrapped=new Proxy(tx,{get(target,prop){if(prop==='onecSaleDelivery')return delegate;const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value}})
  const xml=await work(wrapped)
  if(changed!==1)throw Error('expected_one_new_delivery')
  await recordAudit(tx,{storeId:source.storeId,actor,action:'OnecTestPercentRatePrepared',targetType:'Order',targetId:order.id,metadata:{request:'User requested rate 22% instead of 22',scope:'isolated acceptance database only',changedFields:3,transportAcknowledged:false}})
  return xml
 },options)} as unknown as PrismaClient
 await querySales({storeId:source.storeId,sessionId:session.id,credentials,secret},client)
 // A fresh standard query must serve exactly the stored trial, without any override.
 const verifySession=await openExchangeSession(source.storeId,credential,secret)
 const xml=await querySales({storeId:source.storeId,sessionId:verifySession.id,credentials,secret})
 if((xml.match(/<Документ>/g)||[]).length!==1||(xml.split('<Ставка>22%</Ставка>').length-1)!==3||xml.includes('<Ставка>22</Ставка>'))throw Error('standard_query_did_not_serve_trial')
 const after=await db.onecSaleDelivery.findMany({where:{id:{in:before.map(x=>x.id)}},orderBy:{id:'asc'}})
 if(JSON.stringify(before)!==JSON.stringify(after))throw Error('historical_delivery_changed')
 const state=await db.orderExport.findUniqueOrThrow({where:{id:exp.id},include:{onecDelivery:true}})
 const invoices=await db.invoice.count({where:{orderId:order.id}})
 if(state.status!=='AWAITING_ACK'||state.attempts!==1||state.submittedAt||state.confirmedAt||state.externalId||invoices)throw Error('unexpected_delivery_state')
 const report={at:new Date().toISOString(),number:order.number,orderId:order.id,status:order.status,exportStatus:state.status,attempts:state.attempts,rateText:'22%',rateFields:3,total:'270.00',vat:'48.69',deliverySha256:state.onecDelivery!.sha256,priorDeliveriesUnchanged:true,standardQueryVerified:true,actualUtExchangePending:true,invoices}
 fs.writeFileSync('/tmp/r23-percent-preview.xml',xml)
 fs.writeFileSync('/tmp/r23-percent-order.json',JSON.stringify(report,null,2))
 console.log(JSON.stringify(report))
}
main().finally(()=>db.$disconnect()).catch(e=>{console.error(e.message);process.exitCode=1})
