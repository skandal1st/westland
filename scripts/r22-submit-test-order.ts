/** Guarded test submission. XML preview rolls back query/attempt/delivery writes. */
import fs from 'node:fs';
import type {PrismaClient} from '@prisma/client';
import {prisma as db} from '../src/lib/db';
import {saveSourceMapping} from '../src/lib/integrations/mappings';
import {submitOrder} from '../src/lib/orders/orders';
import {querySales} from '../src/lib/integrations/onec/sale';
import {openExchangeSession} from '../src/lib/integrations/onec/ledger';
import {sourceCredentials} from '../src/lib/integrations/onec/credentials';
import {assertLicenseActive,reloadLicenseState} from '../src/lib/license';
import {readCommercialSnapshot} from '../src/lib/orders/commercial-snapshot';
import {sha256} from '../src/lib/integrations/onec/storage';
async function main(){
 const url=new URL(process.env.DATABASE_URL||'');if(process.env.R22_ACCEPTANCE!=='1'||url.hostname!=='postgres-r22'||url.pathname!=='/axima_r22_acceptance')throw Error('isolated_database_required');
 const plan=JSON.parse(fs.readFileSync('/app/r22-config/test-order-plan.json','utf8'));
 const ref=plan.buyer.navigationRef;if(!/^[0-9a-f]{32}$/.test(ref))throw Error('navigation_ref_required');
 const guid=[ref.slice(24,32),ref.slice(20,24),ref.slice(16,20),ref.slice(0,4),ref.slice(4,16)].join('-');if(guid!==plan.buyer.externalId||plan.buyer.navigationMetadata!=='Справочник.Контрагенты')throw Error('buyer_guid_mismatch');
 const source=await db.integrationConnection.findUniqueOrThrow({where:{id:plan.sourceConnectionId}});const store=await db.store.findUniqueOrThrow({where:{id:source.storeId}});
 if(store.slug!=='r22-acceptance'||source.environment!=='TEST'||source.id!==process.env.ONEC_EXCHANGE_CONNECTION_ID||source.provider!=='ONE_C')throw Error('source_guard');
 assertLicenseActive(reloadLicenseState());
 const receipt=await db.checkoutReceipt.findUniqueOrThrow({where:{key:'r22-first-real-order-draft'},include:{order:{include:{user:true,customer:true}}}});const draft=receipt.order;
 if(draft.storeId!==store.id||draft.customer.inn!==plan.buyer.inn||draft.customer.legalName!==plan.buyer.legalName||draft.number!=='R22-00001'||!draft.total.equals(plan.line.total))throw Error('draft_mismatch');
 if(draft.status!=='DRAFT')throw Error('already_submitted_inspect_existing_order');
 const actor=await db.user.findUniqueOrThrow({where:{storeId_email:{storeId:store.id,email:'r22-acceptance@localhost'}},select:{id:true,email:true}});
 await saveSourceMapping(store.id,source.id,{entityType:'customer',externalId:guid,entityId:draft.customerId},actor);
 const order=await submitOrder(draft.user,draft.id);const terms=readCommercialSnapshot(order.commercialSnapshot,order);
 if(!terms||terms.tax.rate!==22||terms.tax.amount!=='48.69'||terms.total!=='270.00'||terms.buyer.inn!==plan.buyer.inn)throw Error('snapshot_mismatch');
 const credentials=await sourceCredentials(),credential=credentials.find(c=>c.connectionId===source.id);if(!credential)throw Error('credential_missing');const secret=process.env.NEXTAUTH_SECRET!;
 const session=await openExchangeSession(store.id,credential,secret);let xml='';const rollback=new Error('preview_rollback');
 const previewClient={$transaction:async(work:any,options:any)=>{try{await db.$transaction(async tx=>{xml=await work(tx);throw rollback},options)}catch(e){if(e!==rollback)throw e}return xml}} as unknown as PrismaClient;
 await querySales({storeId:store.id,sessionId:session.id,credentials,secret},previewClient);
 if(!xml.includes('<Ид>'+order.id+'</Ид>')||!xml.includes('<Ид>'+guid+'</Ид>')||!xml.includes('<Сумма>270.00</Сумма>')||!xml.includes('<Сумма>48.69</Сумма>'))throw Error('xml_mismatch');
 fs.writeFileSync('/tmp/r22-first-order-preview.xml',xml);
 const record=await db.orderExport.findUniqueOrThrow({where:{orderId:order.id}});
 const report={checkedAt:new Date().toISOString(),number:order.number,orderId:order.id,status:order.status,total:terms.total,tax:terms.tax,exportStatus:record.status,attempts:record.attempts,xmlSha256:sha256(xml),previewRolledBack:true,deliveryRows:await db.onecSaleDelivery.count({where:{exportId:record.id}}),invoiceCount:await db.invoice.count({where:{orderId:order.id}})};
 fs.writeFileSync('/tmp/r22-first-order-queued.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 if(record.status!=='PENDING'||record.attempts!==0||report.deliveryRows!==0||report.invoiceCount!==0)throw Error('unexpected_export_state');
}
main().finally(()=>db.$disconnect()).catch(e=>{console.error(e.message);process.exitCode=1});
