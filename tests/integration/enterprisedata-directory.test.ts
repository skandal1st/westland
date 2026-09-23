import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { mkdtempSync,readFileSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach,afterEach,afterAll,it,expect,vi } from 'vitest'
import { importDirectory,applyDirectoryAction } from '@/lib/integrations/enterprisedata/directory'
import { openFileTransport } from '@/lib/integrations/enterprisedata/http-files'
import { siteTransport } from '@/lib/integrations/enterprisedata/site-transport'
import { writeXmlZip } from '@/lib/integrations/enterprisedata/zip'
import { directoryMessage,productXml,customerXml,directoryPeer,productGuid } from '../fixtures/enterprisedata-directory'
import { buyerLocationsWhere } from '@/lib/account/location-access'
const db=new PrismaClient();let binding:{storeId:string;connectionId:string},actor:{id:string;email:string},customerId:string
const dirs:string[]=[]
beforeEach(async()=>{
 const store=await db.store.create({data:{slug:'ed-directory-'+randomUUID(),name:'Isolated directory test'}})
 const source=await db.integrationConnection.create({data:{storeId:store.id,name:'ED',provider:'ONE_C',environment:'TEST',sourceState:'ACTIVE',enabled:true,config:{saleExport:{enabled:true,format:'ENTERPRISEDATA_1_20',currency:'RUB',timeZone:'Europe/Moscow',numberPrefix:'AX'}}}})
 binding={storeId:store.id,connectionId:source.id}
 const staff=await db.user.create({data:{storeId:store.id,email:'admin@test.invalid',name:'Admin',passwordHash:'test',role:'ADMIN',status:'ACTIVE'}});actor=staff
 customerId=(await db.customer.create({data:{storeId:store.id,displayName:'Local legal name',legalName:'Local legal name',inn:'262814584465'}})).id
})
afterEach(async()=>{await db.store.delete({where:{id:binding.storeId}});dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true}));vi.restoreAllMocks()});afterAll(()=>db.$disconnect())
const importData=(objects:string[],no=1)=>importDirectory(binding,directoryPeer,directoryMessage(objects,no),db)
const record=(kind='counterparty')=>db.enterpriseDataRecord.findFirstOrThrow({where:{connectionId:binding.connectionId,kind}})
it('mirrors independent source identities, does not create accounts, preserves omitted contacts and rejects stale/conflicting messages',async()=>{
 const contacts='<КонтактнаяИнформация><Строка><ВидКонтактнойИнформации>ПочтовыйАдрес</ВидКонтактнойИнформации><ЗначенияПолей>&lt;КонтактнаяИнформация Представление="Test street 1"/&gt;</ЗначенияПолей></Строка></КонтактнаяИнформация>'
 await importData([productXml(),customerXml('Source name',contacts)])
 expect(await db.enterpriseDataRecord.count({where:{connectionId:binding.connectionId}})).toBe(2)
 expect(await db.product.count({where:{storeId:binding.storeId}})).toBe(0)
 expect(await db.user.count({where:{storeId:binding.storeId}})).toBe(1)
 expect((await importData([productXml(),customerXml('Source name',contacts)])).reused).toBe(true)
 await expect(importData([customerXml('Different bytes')])).rejects.toThrow('ed_directory_message_conflict')
 await importData([customerXml('Renamed')],3)
 const row=await record();expect(row.name).toBe('Renamed');expect((row.normalized as any).contacts[0].display).toBe('Test street 1')
 await expect(importData([customerXml()],2)).rejects.toThrow('ed_directory_message_stale')
 expect((await db.customer.findUniqueOrThrow({where:{id:customerId}})).legalName).toBe('Local legal name')
})
it('rolls back the whole packet for unsupported or duplicated objects and another source peer',async()=>{
 await expect(importData([productXml(),'<Документ.ЗаказКлиента/>'])).rejects.toThrow('ed_directory_type_unsupported')
 await expect(importData([productXml(),productXml()])).rejects.toThrow('ed_directory_duplicate_identity')
 await expect(importDirectory(binding,{...directoryPeer,from:randomUUID()},directoryMessage([productXml()]),db)).rejects.toThrow('ed_directory_peer_mismatch')
 expect(await db.enterpriseDataImport.count({where:{connectionId:binding.connectionId}})).toBe(0)
 expect(await db.enterpriseDataRecord.count({where:{connectionId:binding.connectionId}})).toBe(0)
})
it('links a matching buyer explicitly, preserves mapping and rejects foreign stores or mismatched INN',async()=>{
 await importData([customerXml()]);const row=await record()
 await applyDirectoryAction(binding,{action:'linkCustomer',recordId:row.id,entityId:customerId},actor,db)
 await importData([customerXml('Renamed by 1C')],2)
 expect(await db.externalReference.count({where:{connectionId:binding.connectionId,entityType:'edCustomer',entityId:customerId}})).toBe(1)
 await expect(applyDirectoryAction({...binding,storeId:'foreign'},{action:'linkCustomer',recordId:row.id,entityId:customerId},actor,db)).rejects.toThrow('ed_source_inactive')
 const other=await db.customer.create({data:{storeId:binding.storeId,displayName:'Other',legalName:'Other',inn:'7712345678'}})
 await expect(applyDirectoryAction(binding,{action:'linkCustomer',recordId:row.id,entityId:other.id},actor,db)).rejects.toThrow('ed_customer_requisites_mismatch')
})
it('updates opted-in products by GUID while preserving display content, prices, identifiers and packaging',async()=>{
 await importData([productXml()]);const row=await record('product')
 const result=await applyDirectoryAction(binding,{action:'syncProduct',recordId:row.id},actor,db)
 const variant=await db.productVariant.findFirstOrThrow({where:{productId:result.entityId}})
 await db.productVariant.update({where:{id:variant.id},data:{packaging:'Original pack',unitsPerPack:5}})
 await db.productIdentifier.create({data:{variantId:variant.id,type:'BARCODE',value:'1234567'}})
 await db.commerceProductContent.update({where:{productId:result.entityId},data:{displayName:'Staff display name'}})
 const book=await db.priceBook.create({data:{storeId:binding.storeId,name:'Prices',code:'TEST'}});await db.priceEntry.create({data:{priceBookId:book.id,variantId:variant.id,amount:270}})
 await importData([productXml('Updated source product')],2)
 expect((await db.product.findUniqueOrThrow({where:{id:result.entityId}})).canonicalName).toBe('Updated source product')
 expect((await db.commerceProductContent.findUniqueOrThrow({where:{productId:result.entityId}})).displayName).toBe('Staff display name')
 expect((await db.productVariant.findUniqueOrThrow({where:{id:variant.id}})).unitsPerPack).toBe(5)
 expect(await db.productIdentifier.count({where:{variantId:variant.id,value:'1234567'}})).toBe(1)
 expect((await db.priceEntry.findFirstOrThrow({where:{variantId:variant.id}})).amount.toString()).toBe('270')
 await applyDirectoryAction(binding,{action:'stopProductSync',recordId:row.id},actor,db)
 await importData([productXml('Mirror only')],3)
 expect((await db.product.findUniqueOrThrow({where:{id:result.entityId}})).canonicalName).toBe('Updated source product')
 expect(await db.externalReference.count({where:{connectionId:binding.connectionId,entityType:'product',externalId:productGuid}})).toBe(1)
})
it('creates a point idempotently without granting buyer access and preserves local address on re-import',async()=>{
 await importData([customerXml()]);const row=await record()
 const buyer=await db.user.create({data:{storeId:binding.storeId,customerId,email:'buyer@test.invalid',name:'Buyer',passwordHash:'test',role:'BUYER',status:'ACTIVE',deliveryPointsRestricted:true}})
 const input={action:'createPoint' as const,recordId:row.id,customerId,name:'Shop',city:'City',address:'Street 1'}
 const point=await applyDirectoryAction(binding,input,actor,db);expect((await applyDirectoryAction(binding,input,actor,db)).entityId).toBe(point.entityId)
 expect(await db.userDeliveryPointGrant.count({where:{locationId:point.entityId}})).toBe(0)
 const where=await buyerLocationsWhere({...buyer,priceGroupId:null},db);expect(await db.customerLocation.count({where})).toBe(0)
 await importData([customerXml('Renamed')],2);expect((await db.customerLocation.findUniqueOrThrow({where:{id:point.entityId}})).address).toBe('Street 1')
})
it('retains file payload without ACK on DB failure and repairs DB-commit/file-ACK crash on retry',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ed-directory-'));dirs.push(dir)
 const files=openFileTransport(dir,()=>directoryPeer,false,undefined,true),bridge=siteTransport(files,binding,db,true)
 const q=(v:Record<string,string>)=>new URLSearchParams(v),session=randomUUID(),peerQ={NodeCode:directoryPeer.from,ExchangePlanName:directoryPeer.plan},xml=directoryMessage([customerXml(),productXml()])
 await bridge.handle('PutFilePart',q({SessionID:session,PartNumber:'1'}),writeXmlZip(xml));await bridge.handle('SaveFileFromParts',q({SessionID:session,PartCount:'1'}))
 const args={...peerQ,FileID:session},ack=vi.spyOn(files,'acceptBusinessMessage').mockImplementationOnce(()=>{throw Error('simulated crash after DB commit')})
 await expect(bridge.handle('DownloadData',q(args))).rejects.toThrow('simulated crash')
 expect(JSON.parse(readFileSync(join(dir,'state.json'),'utf8')).applied).toBe(0)
 expect(await db.enterpriseDataImport.count({where:{connectionId:binding.connectionId}})).toBe(1)
 ack.mockRestore();await bridge.handle('DownloadData',q(args));await bridge.handle('DownloadData',q(args))
 expect(JSON.parse(readFileSync(join(dir,'state.json'),'utf8')).applied).toBe(1)
 expect(await db.enterpriseDataRecord.count({where:{connectionId:binding.connectionId}})).toBe(2)
})

it('does not merge same-INN records or expose a new point to unrestricted legacy buyers',async()=>{
 await importData([customerXml(),customerXml('Another shop').replace('22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333')])
 expect(await db.enterpriseDataRecord.count({where:{connectionId:binding.connectionId,inn:'262814584465'}})).toBe(2)
 const row=await record();await db.user.create({data:{storeId:binding.storeId,customerId,email:'legacy@test.invalid',name:'Legacy',passwordHash:'test',role:'BUYER',status:'ACTIVE',deliveryPointsRestricted:false}})
 await expect(applyDirectoryAction(binding,{action:'createPoint',recordId:row.id,customerId,name:'Shop',city:'City',address:'Street'},actor,db)).rejects.toThrow('ed_point_restrictions_required')
 expect(await db.customerLocation.count({where:{customerId}})).toBe(0)
})
it('does not ACK or commit a packet when a mapped product cannot be projected',async()=>{
 await importData([productXml()]);const row=await record('product');await applyDirectoryAction(binding,{action:'syncProduct',recordId:row.id},actor,db)
 const ref=await db.externalReference.findFirstOrThrow({where:{connectionId:binding.connectionId,entityType:'product'}})
 await db.productVariant.updateMany({where:{productId:ref.entityId},data:{isDefault:false}})
 const dir=mkdtempSync(join(tmpdir(),'ed-directory-failure-'));dirs.push(dir)
 const files=openFileTransport(dir,()=>directoryPeer,false,undefined,true),bridge=siteTransport(files,binding,db,true),q=(v:Record<string,string>)=>new URLSearchParams(v),session=randomUUID()
 await bridge.handle('PutFilePart',q({SessionID:session,PartNumber:'1'}),writeXmlZip(directoryMessage([customerXml(),productXml('Invalid variant')],2)))
 await bridge.handle('SaveFileFromParts',q({SessionID:session,PartCount:'1'}))
 // Seed packet 1 in the new file journal as an empty historical receipt, then replay the failed packet.
 const emptySession=randomUUID();await bridge.handle('PutFilePart',q({SessionID:emptySession,PartNumber:'1'}),writeXmlZip(directoryMessage([],1)));await bridge.handle('SaveFileFromParts',q({SessionID:emptySession,PartCount:'1'}));await bridge.handle('DownloadData',q({NodeCode:directoryPeer.from,ExchangePlanName:directoryPeer.plan,FileID:emptySession}))
 await expect(bridge.handle('DownloadData',q({NodeCode:directoryPeer.from,ExchangePlanName:directoryPeer.plan,FileID:session}))).rejects.toThrow('VARIANT_IDENTITY_AMBIGUOUS')
 expect(JSON.parse(readFileSync(join(dir,'state.json'),'utf8')).applied).toBe(1)
 expect(await db.enterpriseDataRecord.count({where:{connectionId:binding.connectionId,kind:'counterparty'}})).toBe(0)
 expect((await record('product')).name).toBe('Test product')
 expect(await db.enterpriseDataImport.count({where:{connectionId:binding.connectionId}})).toBe(1)
})

const partnerId = 'c46df2b1-ef22-43ac-9fa5-238a556283df'
const partnerPayload = (connectionId: string, overrides: Record<string,unknown> = {}) => ({format: 'AXIMA.Partners/1', connectionId, batchId: randomUUID(), exportedAt: '2026-01-01T00:00:00Z', partners: [{externalId: partnerId, name: 'Test shop', code: '0001', archived: false, contacts: [{kind: 'Адрес', label: 'Адрес точки', display: 'City, street 1', city: 'City'}], counterpartyIds: []}], ...overrides})
it('imports native partner snapshots independently of ED counters; replay is idempotent and conflicting or stale packets cannot change rows', async () => {
 const {importPartners} = await import('@/lib/integrations/enterprisedata/partners')
 const payload = partnerPayload(binding.connectionId), bytes = Buffer.from(JSON.stringify(payload))
 expect((await importPartners(binding,bytes,actor,db)).objects).toBe(1)
 expect((await importPartners(binding,bytes,actor,db)).reused).toBe(true)
 expect(await db.enterpriseDataImport.count({where: {connectionId: binding.connectionId}})).toBe(0)
 expect(await db.partnerDirectoryImport.count({where: {connectionId: binding.connectionId}})).toBe(1)
 expect(await db.customerLocation.count({where: {customerId}})).toBe(0)
 await expect(importPartners(binding,Buffer.from(JSON.stringify({...payload,partners: []})),actor,db)).rejects.toThrow('partner_file_invalid')
 await expect(importPartners(binding,Buffer.from(JSON.stringify({...payload,exportedAt: '2026-01-02T00:00:00Z'})),actor,db)).rejects.toThrow('partner_batch_conflict')
 await expect(importPartners(binding,Buffer.from(JSON.stringify(partnerPayload(binding.connectionId,{exportedAt:'2025-12-31T00:00:00Z'}))),actor,db)).rejects.toThrow('partner_snapshot_stale')
 expect((await record('partner')).name).toBe('Test shop')
})
it('checks fixed source, duplicate identities and rolls back an entire partner batch', async()=>{
 const {importPartners} = await import('@/lib/integrations/enterprisedata/partners')
 const payload=partnerPayload(binding.connectionId), send=(v:unknown,b=binding)=>importPartners(b,Buffer.from(JSON.stringify(v)),actor,db)
 await expect(send({...payload,connectionId:randomUUID()})).rejects.toThrow('partner_source_mismatch')
 await expect(send(payload,{...binding,storeId:'foreign'})).rejects.toThrow('ed_source_inactive')
 await expect(send({...payload,partners:[payload.partners[0],payload.partners[0]]})).rejects.toThrow('partner_duplicate_identity')
 await send(payload)
 await expect(send({...partnerPayload(binding.connectionId,{exportedAt:'2025-01-01T00:00:00Z'}),partners:[{...payload.partners[0],externalId:randomUUID()},payload.partners[0]]})).rejects.toThrow('partner_snapshot_stale')
 expect(await db.enterpriseDataRecord.count({where:{connectionId:binding.connectionId,kind:'partner'}})).toBe(1)
})
it('requires the explicit 1C counterparty relation and matching local mapping before creating a partner point without grants',async()=>{
 const {importPartners} = await import('@/lib/integrations/enterprisedata/partners')
 await importData([customerXml()]);const customerRow=await record()
 const payload=partnerPayload(binding.connectionId);payload.partners[0].counterpartyIds=[customerRow.externalId] as never[]
 await importPartners(binding,Buffer.from(JSON.stringify(payload)),actor,db)
 const partner=await record('partner'),action={action:'createPoint' as const,recordId:partner.id,customerId,name:'Shop',city:'City',address:'Street 1'}
 await expect(applyDirectoryAction(binding,action,actor,db)).rejects.toThrow('partner_customer_link_required')
 await applyDirectoryAction(binding,{action:'linkCustomer',recordId:customerRow.id,entityId:customerId},actor,db)
 const result=await applyDirectoryAction(binding,action,actor,db)
 expect((await applyDirectoryAction(binding,action,actor,db)).entityId).toBe(result.entityId)
 expect(await db.userDeliveryPointGrant.count({where:{locationId:result.entityId}})).toBe(0)
 expect(await db.externalReference.count({where:{connectionId:binding.connectionId,entityType:'utPartnerPoint',externalId:partnerId}})).toBe(1)
 const newer=partnerPayload(binding.connectionId,{exportedAt:'2026-01-02T00:00:00Z'});newer.partners[0].name='Renamed';newer.partners[0].counterpartyIds=payload.partners[0].counterpartyIds
 await importPartners(binding,Buffer.from(JSON.stringify(newer)),actor,db)
 expect((await record('partner')).name).toBe('Renamed')
 expect((await db.customerLocation.findUniqueOrThrow({where:{id:result.entityId}})).name).toBe('Shop')
})

it('persists an explicit manual partner assignment with evidence, retains it on replay/import, and never grants access',async()=>{
 const {importPartners}=await import('@/lib/integrations/enterprisedata/partners')
 await importData([customerXml()]);const customerRow=await record()
 const payload=partnerPayload(binding.connectionId)
 await importPartners(binding,Buffer.from(JSON.stringify(payload)),actor,db)
 const partner=await record('partner'),base={action:'createPoint' as const,recordId:partner.id,customerId,name:'Natali',city:'City',address:'Street 130'}
 await expect(applyDirectoryAction(binding,base,actor,db)).rejects.toThrow('partner_customer_link_required')
 const action={...base,manualAssignment:{confirmed:true as const,reason:'Confirmed by the owner'}}
 await expect(applyDirectoryAction(binding,action,actor,db)).rejects.toThrow('partner_customer_mapping_required')
 await applyDirectoryAction(binding,{action:'linkCustomer',recordId:customerRow.id,entityId:customerId},actor,db)
 const buyer=await db.user.create({data:{storeId:binding.storeId,customerId,email:'manual-buyer@test.invalid',name:'Buyer',passwordHash:'test',role:'BUYER',status:'ACTIVE',deliveryPointsRestricted:true}})
 const result=await applyDirectoryAction(binding,action,actor,db)
 const ref=await db.externalReference.findFirstOrThrow({where:{connectionId:binding.connectionId,entityType:'utPartnerPoint'}})
 expect(ref.sourceData).toMatchObject({origin:'MANUAL',customerId,counterpartyId:customerRow.externalId,partnerId,sourceCounterpartyIds:[],actorId:actor.id,reason:'Confirmed by the owner'})
 expect((await applyDirectoryAction(binding,{...action,manualAssignment:{confirmed:true,reason:'Different retry reason'}},actor,db)).entityId).toBe(result.entityId)
 expect((await applyDirectoryAction(binding,base,actor,db)).entityId).toBe(result.entityId)
 await importPartners(binding,Buffer.from(JSON.stringify(partnerPayload(binding.connectionId,{exportedAt:'2026-01-02T00:00:00Z'}))),actor,db)
 expect((await db.externalReference.findUniqueOrThrow({where:{id:ref.id}})).sourceData).toEqual(ref.sourceData)
 expect((await record('partner')).normalized).toMatchObject({counterpartyIds:[]})
 expect(await db.customerLocation.count({where:{customerId}})).toBe(1)
 expect(await db.userDeliveryPointGrant.count({where:{locationId:result.entityId}})).toBe(0)
 expect(await db.customerLocation.count({where:await buyerLocationsWhere({...buyer,priceGroupId:null},db)})).toBe(0)
 const entries=await db.auditEntry.findMany({where:{storeId:binding.storeId,action:'PartnerPointAssigned'}})
 expect(entries).toHaveLength(1);expect(entries[0]).toMatchObject({actorId:actor.id,targetId:result.entityId,metadata:ref.sourceData})
 const other=await db.customer.create({data:{storeId:binding.storeId,displayName:'Other',legalName:'Other',inn:'7712345678'}})
 await expect(applyDirectoryAction(binding,{...action,customerId:other.id},actor,db)).rejects.toThrow('ed_point_already_linked')
})
it('manual assignment cannot bypass target/source scope, archived records or buyer restrictions',async()=>{
 const {importPartners}=await import('@/lib/integrations/enterprisedata/partners')
 await importData([customerXml()]);const customerRow=await record()
 await applyDirectoryAction(binding,{action:'linkCustomer',recordId:customerRow.id,entityId:customerId},actor,db)
 const payload=partnerPayload(binding.connectionId)
 await importPartners(binding,Buffer.from(JSON.stringify(payload)),actor,db)
 const partner=await record('partner'),action={action:'createPoint' as const,recordId:partner.id,customerId,name:'Shop',city:'City',address:'Street',manualAssignment:{confirmed:true as const,reason:'Confirmed by owner'}}
 await expect(applyDirectoryAction({...binding,storeId:'foreign'},action,actor,db)).rejects.toThrow('ed_source_inactive')
 await expect(applyDirectoryAction(binding,{...action,customerId:'foreign'},actor,db)).rejects.toThrow('mapping_target_not_found')
 await expect(applyDirectoryAction(binding,{...action,recordId:customerRow.id},actor,db)).rejects.toThrow('ed_directory_kind_mismatch')
 await db.enterpriseDataRecord.update({where:{id:partner.id},data:{archived:true}})
 await expect(applyDirectoryAction(binding,action,actor,db)).rejects.toThrow('ed_directory_record_archived')
 await db.enterpriseDataRecord.update({where:{id:partner.id},data:{archived:false}})
 await db.user.create({data:{storeId:binding.storeId,customerId,email:'unrestricted@test.invalid',name:'Buyer',passwordHash:'test',role:'BUYER',status:'ACTIVE',deliveryPointsRestricted:false}})
 await expect(applyDirectoryAction(binding,action,actor,db)).rejects.toThrow('ed_point_restrictions_required')
 expect(await db.externalReference.count({where:{connectionId:binding.connectionId,entityType:'utPartnerPoint'}})).toBe(0)
 expect(await db.auditEntry.count({where:{storeId:binding.storeId,action:'PartnerPointAssigned'}})).toBe(0)
})

it('links an existing point without duplicating or editing it, forbids a foreign point and competing source identities',async()=>{
 const {importPartners}=await import('@/lib/integrations/enterprisedata/partners')
 await importData([customerXml()]);const customerRow=await record()
 await applyDirectoryAction(binding,{action:'linkCustomer',recordId:customerRow.id,entityId:customerId},actor,db)
 await importPartners(binding,Buffer.from(JSON.stringify(partnerPayload(binding.connectionId))),actor,db)
 const partner=await record('partner'),point=await db.customerLocation.create({data:{customerId,name:'Existing',city:'Local city',address:'Local address'}})
 const other=await db.customer.create({data:{storeId:binding.storeId,displayName:'Other',legalName:'Other',inn:'7712345678'}})
 const foreignPoint=await db.customerLocation.create({data:{customerId:other.id,name:'Other point',city:'Other',address:'Other'}})
 const action={action:'createPoint' as const,recordId:partner.id,customerId,locationId:foreignPoint.id,name:'Ignored',city:'Ignored',address:'Ignored',manualAssignment:{confirmed:true as const,reason:'Owner confirmed existing point'}}
 await expect(applyDirectoryAction(binding,action,actor,db)).rejects.toThrow('mapping_target_not_found')
 const result=await applyDirectoryAction(binding,{...action,locationId:point.id},actor,db)
 expect(result.entityId).toBe(point.id)
 expect(await db.customerLocation.count({where:{customerId}})).toBe(1)
 expect(await db.customerLocation.findUniqueOrThrow({where:{id:point.id}})).toEqual(point)
 expect(await db.userDeliveryPointGrant.count({where:{locationId:point.id}})).toBe(0)
 const payload=partnerPayload(binding.connectionId);payload.partners[0].externalId=randomUUID()
 await importPartners(binding,Buffer.from(JSON.stringify(payload)),actor,db)
 const second=await db.enterpriseDataRecord.findFirstOrThrow({where:{connectionId:binding.connectionId,externalId:payload.partners[0].externalId}})
 await expect(applyDirectoryAction(binding,{...action,recordId:second.id,locationId:point.id},actor,db)).rejects.toThrow('ed_point_already_linked')
 await expect(applyDirectoryAction(binding,action,actor,db)).rejects.toThrow('ed_point_already_linked')
})
