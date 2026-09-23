/** Only the isolated, proven-rejected R22-00001. Preserve all prior XML/attempt history. */
import fs from 'node:fs';
import {prisma as db} from '../src/lib/db';
import {saveSourceMapping} from '../src/lib/integrations/mappings';
import {setCartChannel,setCartItem} from '../src/lib/cart/cart';
import {checkout} from '../src/lib/cart/checkout';
import {submitOrder,transitionOrder} from '../src/lib/orders/orders';
import {assertLicenseActive,reloadLicenseState} from '../src/lib/license';
import {recordAudit} from '../src/lib/audit';
async function main(){
 const u=new URL(process.env.DATABASE_URL||'');if(process.env.R22_ACCEPTANCE!=='1'||u.hostname!=='postgres-r22'||u.pathname!=='/axima_r22_acceptance')throw Error('isolated_database_required');
 const plan=JSON.parse(fs.readFileSync('/app/r22-config/test-order-plan.json','utf8'));const proof=JSON.parse(fs.readFileSync('/app/r22-config/address-error-proof.json','utf8'));
 if(!proof.events.some((e:any)=>e.comment.includes('Обработано: 1')&&e.comment.includes('Создано: 0'))||!proof.events.some((e:any)=>e.comment.startsWith('Поле объекта не обнаружено (Адрес)')))throw Error('rejection_evidence_required');
 if(!plan.warehouse.addressConfirmedByUser||plan.warehouse.warehouseAddress.city!=='Евпатория')throw Error('warehouse_address_required');
 const source=await db.integrationConnection.findUniqueOrThrow({where:{id:plan.sourceConnectionId}});const store=await db.store.findUniqueOrThrow({where:{id:source.storeId}});
 if(store.slug!=='r22-acceptance'||source.environment!=='TEST'||source.id!==process.env.ONEC_EXCHANGE_CONNECTION_ID)throw Error('test_source_required');
 assertLicenseActive(reloadLicenseState());
 const old=await db.order.findUniqueOrThrow({where:{id:'cmubir7n6000sfhkfbpbxbj1x'},include:{export:true,user:true}});
 if(old.storeId!==store.id||old.number!=='R22-00001'||old.export?.externalId||old.export?.submittedAt||old.export?.confirmedAt||await db.invoice.count({where:{orderId:old.id}}))throw Error('old_order_not_proven_unconfirmed');
 if(await db.checkoutReceipt.findUnique({where:{key:'r22-warehouse-address-retry'}}))throw Error('replacement_already_exists_inspect_it');
 if(old.status!=='SUBMITTED'||old.export?.status!=='AWAITING_ACK'||old.export.attempts!==1)throw Error('old_order_state_changed');
 const actor=await db.user.findUniqueOrThrow({where:{storeId_email:{storeId:store.id,email:'r22-acceptance@localhost'}}});
 await saveSourceMapping(store.id,source.id,{entityType:'location',externalId:plan.warehouse.externalId,entityId:plan.warehouse.localId,warehouseAddress:plan.warehouse.warehouseAddress},actor);
 await setCartChannel(old.user,old.fulfillmentChannelId);await setCartItem(old.user,plan.line.variantId,1);
 const next=await checkout(old.user,{deliveryLocationId:old.deliveryLocationId,comment:plan.comment+'; повтор R22-00001 после ошибки чтения адреса',idempotencyKey:'r22-warehouse-address-retry'});
 if(!next.total.equals('270'))throw Error('replacement_price_changed');
 await transitionOrder({storeId:store.id,orderId:old.id,to:'CANCELLED',expectedStatus:'SUBMITTED',actor});
 await db.$transaction(async tx=>{
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${old.id} FOR UPDATE`;
  const affected=await tx.orderExport.updateMany({where:{id:old.export!.id,status:'AWAITING_ACK',submittedAt:null,externalId:null},data:{status:'FAILED',lastError:'UT114 warehouse address parsing failed; no document created; replaced by '+next.number}});
  if(affected.count!==1)throw Error('old_export_changed');
  await recordAudit(tx,{storeId:store.id,actor,action:'OnecTestOrderReplacedAfterProvenRejection',targetType:'Order',targetId:old.id,metadata:{replacementOrderId:next.id,eventLogSha256:proof.sourceSha256}});
 });
 const order=await submitOrder(old.user,next.id);const exp=await db.orderExport.findUniqueOrThrow({where:{orderId:order.id}});
 const previous=await db.onecSaleDelivery.findUniqueOrThrow({where:{exportId:old.export.id}});
 const report={at:new Date().toISOString(),oldNumber:old.number,oldOrderId:old.id,oldStatus:'CANCELLED',oldExportStatus:'FAILED',oldDeliverySha256:previous.sha256,oldDeliveryPreserved:true,number:order.number,orderId:order.id,status:order.status,exportStatus:exp.status,attempts:exp.attempts,total:order.total.toString(),warehouseAddress:plan.warehouse.warehouseAddress};
 fs.writeFileSync('/tmp/r22-address-replacement.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
main().finally(()=>db.$disconnect()).catch(e=>{console.error(e.message);process.exitCode=1});
