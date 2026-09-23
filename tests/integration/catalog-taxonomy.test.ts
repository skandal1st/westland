import { beforeAll, afterAll, it, expect } from 'vitest'
import { PrismaClient } from '@prisma/client'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openExchangeSession, initializeSession, receiveChunk, finishFile, publishGeneration } from '@/lib/integrations/onec/ledger'
import { createOneCProvider } from '@/lib/integrations/onec/provider'
import { scanGroups } from '@/lib/integrations/onec/status'
import { setCategoryBrand } from '@/lib/integrations/onec/manage-brands'
import { setCategoryGroups, readCategoryGroups } from '@/lib/integrations/onec/manage-categories'
import { applyProductSnapshot } from '@/lib/catalog/import'
import { applyProductBatch } from '@/lib/catalog/import-batch'
import { catalogFacets, listCatalog, listCatalogNav } from '@/lib/catalog/read'
const db=new PrismaClient(),code='test-catalog-taxonomy'
let storeId:string,connectionId:string,targetId:string,otherId:string,actor:{id:string;email:string},payloads:unknown[]
const oldDir=process.env.ONEC_EXCHANGE_DIR
async function publish(xml:string) {
  const credentials=[{connectionId,user:'onec',pass:'fixture-password'}],secret='fixture-secret'
  const session=await openExchangeSession(storeId,credentials[0],secret,db),authority={storeId,sessionId:session.id,credentials,secret}
  await initializeSession(authority,db);await receiveChunk(authority,'import.xml',Buffer.from(xml),db);await finishFile(authority,'import.xml',db)
  return publishGeneration(storeId,connectionId,[session.id],actor,db)
}
beforeAll(async()=>{
  process.env.ONEC_EXCHANGE_DIR=await fs.mkdtemp(path.join(os.tmpdir(),'taxonomy-'))
  await db.store.deleteMany({where:{slug:code}})
  storeId=(await db.store.create({data:{slug:code,name:code}})).id
  connectionId=(await db.integrationConnection.create({data:{storeId,name:'source',provider:'ONE_C',environment:'TEST',sourceState:'ACTIVE',enabled:true}})).id
  actor=await db.user.create({data:{storeId,email:'admin@taxonomy.test',name:'Admin',role:'ADMIN',passwordHash:'fixture'}})
  targetId=(await db.category.create({data:{storeId,name:'Табак',slug:'tobacco'}})).id
  otherId=(await db.category.create({data:{storeId,name:'Другая подборка',slug:'other'}})).id
  const group=(id:string,name:string,children='')=>'<Группа><Ид>'+id+'</Ид><Наименование>'+name+'</Наименование>'+(children?'<Группы>'+children+'</Группы>':'')+'</Группа>'
  const groups=group('a','Табак без Дарксайда',group('bonche','Bonche',group('line','Линейка',group('leaf','100 г'))))+group('b','Товары Burn',group('burn','Burn'))+group('d','Товары DS',group('ds','Darkside'))
  const products=[['p1','leaf'],['p2','burn'],['p3','ds']].map(([id,g])=>'<Товар><Ид>'+id+'</Ид><Артикул>'+id+'</Артикул><Наименование>'+id+'</Наименование><Группы><Ид>'+g+'</Ид></Группы></Товар>').join('')
  const generation=await publish('<КоммерческаяИнформация><Классификатор><Группы>'+groups+'</Группы></Классификатор><Каталог><Товары>'+products+'</Товары></Каталог></КоммерческаяИнформация>')
  payloads=(await createOneCProvider(connectionId,generation.id).pullProducts()).items
  await db.$transaction(tx=>applyProductBatch({storeId,connectionId,payloads},tx))
})
afterAll(async()=>{await db.providerSnapshot.deleteMany({where:{storeId}});await db.inbox.deleteMany({where:{storeId}});await db.store.delete({where:{id:storeId}});await db.$disconnect();if(oldDir===undefined)delete process.env.ONEC_EXCHANGE_DIR;else process.env.ONEC_EXCHANGE_DIR=oldDir})
it('keeps three source identities while mapping all nested products into one site category',async()=>{
  const refs=await db.externalReference.findMany({where:{connectionId,entityType:'category'},select:{id:true,entityId:true,externalId:true},orderBy:{externalId:'asc'}})
  expect((await setCategoryGroups(storeId,connectionId,['a','b','d'],targetId,actor.id)).productsUpdated).toBe(3)
  expect(await db.product.count({where:{storeId,categoryId:targetId}})).toBe(3)
  expect(await db.externalReference.findMany({where:{connectionId,entityType:'category'},select:{id:true,entityId:true,externalId:true},orderBy:{externalId:'asc'}})).toEqual(refs)
  expect((await readCategoryGroups(connectionId)).find(g=>g.externalId==='leaf')).toMatchObject({categoryId:null,effectiveCategoryId:targetId})
})
it('inherits marked brands at different depths and provides category facets with correct counts',async()=>{
  await setCategoryBrand(storeId,connectionId,'bonche',true,actor.id);await setCategoryBrand(storeId,connectionId,'burn',true,actor.id);await setCategoryBrand(storeId,connectionId,'ds',true,actor.id)
  const facets=await catalogFacets({storeId,categorySlug:'tobacco'})
  expect(facets.brands.map(b=>[b.name,b.count])).toEqual([['Bonche',1],['Burn',1],['Darkside',1]])
  const bonche=facets.brands.find(b=>b.name==='Bonche')!
  const result=await listCatalog({storeId,categorySlug:'tobacco',brandSlug:bonche.slug})
  expect(result.total).toBe(1);expect(result.items[0].displayName).toBe('p1')
  await setCategoryBrand(storeId,connectionId,'leaf',true,actor.id)
  expect((await catalogFacets({storeId,categorySlug:'tobacco'})).brands.some(b=>b.name==='100 г')).toBe(true)
  await setCategoryBrand(storeId,connectionId,'leaf',false,actor.id)
  expect((await catalogFacets({storeId,categorySlug:'tobacco'})).brands.some(b=>b.name==='Bonche')).toBe(true)
})
it('honors child overrides, clearing returns to parent and removing root mapping restores the original category',async()=>{
  await setCategoryGroups(storeId,connectionId,['line'],otherId,actor.id)
  expect((await listCatalog({storeId,categorySlug:'other'})).total).toBe(1)
  await db.$transaction(tx=>applyProductBatch({storeId,connectionId,payloads},tx))
  expect((await listCatalog({storeId,categorySlug:'other'})).total).toBe(1)
  await setCategoryGroups(storeId,connectionId,['line'],null,actor.id)
  expect((await listCatalog({storeId,categorySlug:'tobacco'})).total).toBe(3)
  await setCategoryGroups(storeId,connectionId,['a'],null,actor.id)
  expect((await listCatalog({storeId,categorySlug:'tobacco'})).total).toBe(2)
  await setCategoryGroups(storeId,connectionId,['a'],targetId,actor.id)
})
it('preserves mappings for existing and new products in classifier-free deltas, single and batch imports',async()=>{
  const products=['p1','p4','p5'].map(id=>'<Товар><Ид>'+id+'</Ид><Артикул>'+id+'</Артикул><Наименование>'+id+'</Наименование><Группы><Ид>leaf</Ид></Группы></Товар>').join('')
  const generation=await publish('<КоммерческаяИнформация><Каталог СодержитТолькоИзменения="true"><Товары>'+products+'</Товары></Каталог></КоммерческаяИнформация>')
  const delta=(await createOneCProvider(connectionId,generation.id).pullProducts()).items
  await applyProductSnapshot({storeId,connectionId,payload:delta[0]},db)
  await db.$transaction(tx=>applyProductBatch({storeId,connectionId,payloads:delta.slice(1)},tx))
  expect((await listCatalog({storeId,categorySlug:'tobacco',brandSlug:'bonche'})).total).toBe(3)
  expect((await scanGroups(connectionId)).some(g=>g.externalId==='burn')).toBe(true)
  expect((await scanGroups(connectionId)).find(g=>g.externalId==='leaf')?.path).toEqual(['Табак без Дарксайда','Bonche','Линейка','100 г'])
  await db.category.update({where:{id:targetId},data:{name:'Табак сайта',sortOrder:7}})
  await applyProductSnapshot({storeId,connectionId,payload:payloads[0]},db)
  expect(await db.category.findUnique({where:{id:targetId}})).toMatchObject({name:'Табак сайта',sortOrder:7})
})
it('rejects foreign targets, preserves source config and hides hidden-category products from facets and nav',async()=>{
  const foreign=await db.store.create({data:{slug:code+'-foreign',name:'Foreign'}})
  try {
    const category=await db.category.create({data:{storeId:foreign.id,name:'Foreign',slug:'foreign'}})
    await expect(setCategoryGroups(storeId,connectionId,['a'],category.id,actor.id)).rejects.toThrow('invalid_category')
    await expect(setCategoryGroups(storeId,connectionId,['missing'],targetId,actor.id)).rejects.toThrow('group_not_found')
    await db.category.update({where:{id:targetId},data:{hidden:true}})
    expect((await catalogFacets({storeId})).brands).toHaveLength(0)
    expect((await listCatalogNav(storeId)).brands).toHaveLength(0)
    await db.category.update({where:{id:targetId},data:{hidden:false}})
    expect((await catalogFacets({storeId})).brands).toHaveLength(3)
  } finally {await db.store.delete({where:{id:foreign.id}})}
})
