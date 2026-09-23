/** Creates only a local DRAFT in the isolated R22 database; never submits to 1C. */
import fs from 'node:fs';
import { prisma as db } from '../src/lib/db';
import { SellerRequisitesSchema } from '../src/lib/invoices/requisites';
import { saveSourceMapping, saveSourceChannel } from '../src/lib/integrations/mappings';
import { setCartChannel, setCartItem } from '../src/lib/cart/cart';
import { checkout } from '../src/lib/cart/checkout';
import { assertLicenseActive, reloadLicenseState } from '../src/lib/license';
import { grossTax } from '../src/lib/money';

async function main() {
 const url=new URL(process.env.DATABASE_URL||'');
 if(process.env.R22_ACCEPTANCE!=='1'||url.hostname!=='postgres-r22'||url.pathname!=='/axima_r22_acceptance')throw Error('isolated_database_required');
 const plan=JSON.parse(fs.readFileSync('/app/r22-config/test-order-plan.json','utf8'));
 if(!plan.seller.confirmedByUser||plan.seller.vatEnabled!==true||plan.seller.vatRate!==22||!/^\d{10}(\d{2})?$/.test(plan.buyer.inn)||!plan.buyer.legalName||plan.line.quantity!==1)throw Error('confirmed_plan_required');
 const source=await db.integrationConnection.findUniqueOrThrow({where:{id:plan.sourceConnectionId}});
 const store=await db.store.findUniqueOrThrow({where:{id:source.storeId}});
 if(store.slug!=='r22-acceptance'||source.environment!=='TEST'||source.provider!=='ONE_C'||source.sourceState!=='ACTIVE'||!source.enabled||source.id!==process.env.ONEC_EXCHANGE_CONNECTION_ID)throw Error('isolated_source_required');
 assertLicenseActive(reloadLicenseState());
 const key='r22-first-real-order-draft';
 const receipt=await db.checkoutReceipt.findUnique({where:{key},include:{order:true}});
 if(receipt){console.log(JSON.stringify({event:'existing_draft',orderId:receipt.orderId,number:receipt.order.number,status:receipt.order.status}));return}
 if(await db.order.count())throw Error('unexpected_existing_orders');
 const seller=SellerRequisitesSchema.parse(plan.seller);
 const price=await db.priceEntry.findUniqueOrThrow({where:{priceBookId_variantId:{priceBookId:plan.priceType.localId,variantId:plan.line.variantId}}});
 if(price.sourceConnectionId!==source.id||!price.amount.equals(plan.line.unitPrice))throw Error('price_changed_requires_confirmation');
 const product=await db.productVariant.findUniqueOrThrow({where:{id:plan.line.variantId},include:{product:true}});
 if(product.storeId!==store.id||product.status!=='ACTIVE'||product.product.status!=='ACTIVE'||!product.isDefault||product.unitsPerPack!==1)throw Error('variant_changed');
 const actor=await db.user.findUniqueOrThrow({where:{storeId_email:{storeId:store.id,email:'r22-acceptance@localhost'}},select:{id:true,email:true}});
 const channel=await db.fulfillmentChannel.upsert({where:{storeId_code:{storeId:store.id,code:'r22-test-bank'}},create:{storeId:store.id,code:'r22-test-bank',name:'R22 ТЕСТ — НЕ ОТГРУЖАТЬ',paymentMethod:'BANK_TRANSFER',inventoryLocationId:plan.warehouse.localId,priceBookId:plan.priceType.localId},update:{}});
 await saveSourceMapping(store.id,source.id,{entityType:'seller',externalId:plan.seller.externalId,entityId:channel.id,seller},actor);
 await saveSourceChannel(store.id,source.id,{channelId:channel.id,warehouseExternalId:plan.warehouse.externalId,priceTypeExternalId:plan.priceType.externalId,sellerExternalId:plan.seller.externalId},actor);
 const customer=await db.customer.upsert({where:{storeId_inn:{storeId:store.id,inn:plan.buyer.inn}},create:{storeId:store.id,inn:plan.buyer.inn,kpp:plan.buyer.kpp,legalName:plan.buyer.legalName,displayName:plan.buyer.displayName},update:{}});
 if(customer.legalName!==plan.buyer.legalName)throw Error('customer_changed');
 let delivery=await db.customerLocation.findFirst({where:{customerId:customer.id,...plan.delivery}});
 delivery??=await db.customerLocation.create({data:{customerId:customer.id,...plan.delivery}});
 const buyer=await db.user.upsert({where:{storeId_email:{storeId:store.id,email:'r22-buyer@localhost'}},create:{storeId:store.id,customerId:customer.id,email:'r22-buyer@localhost',name:'R22 test buyer',passwordHash:'!disabled',role:'BUYER',status:'ACTIVE'},update:{}});
 if(buyer.customerId!==customer.id||buyer.storeId!==store.id||buyer.role!=='BUYER')throw Error('buyer_changed');
 await setCartChannel(buyer,channel.id);await setCartItem(buyer,product.id,1);
 const order=await checkout(buyer,{deliveryLocationId:delivery.id,comment:plan.comment,idempotencyKey:key});
 const state=await db.order.findUniqueOrThrow({where:{id:order.id},include:{items:true,export:true}});
 const stock=await db.stock.findUniqueOrThrow({where:{variantId_locationId:{variantId:product.id,locationId:plan.warehouse.localId}}});
 if(state.status!=='DRAFT'||state.export||!stock.reserved.isZero()||state.items.length!==1||!state.total.equals(plan.line.total))throw Error('draft_verification_failed');
 const report={event:'draft_created',orderId:order.id,number:order.number,status:state.status,total:state.total.toString(),taxPreview:grossTax(state.total,seller),items:state.items.length,exportCreated:false,reserved:stock.reserved.toString(),buyerMappingPending:true};
 fs.writeFileSync('/tmp/r22-test-order-draft.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
main().finally(()=>db.$disconnect()).catch(e=>{console.error(e.message);process.exitCode=1});
