import { beforeEach,it,expect,vi } from 'vitest'
import { NextResponse } from 'next/server'
const mocks=vi.hoisted(()=>({auth:vi.fn(),source:vi.fn(),products:vi.fn(),customers:vi.fn(),apply:vi.fn(),records:vi.fn(),count:vi.fn(),receipt:vi.fn(),refs:vi.fn(),points:vi.fn()}))
vi.mock('@/lib/authz',()=>({requireApiUser:mocks.auth}))
vi.mock('@/lib/db',()=>({prisma:{integrationConnection:{findFirst:mocks.source},product:{findMany:mocks.products},customer:{findMany:mocks.customers},enterpriseDataRecord:{findMany:mocks.records,count:mocks.count},partnerDirectoryImport:{findFirst:mocks.receipt},externalReference:{findMany:mocks.refs},customerLocation:{findMany:mocks.points}}}))
vi.mock('@/lib/integrations/enterprisedata/directory',async original=>({...await original<typeof import('@/lib/integrations/enterprisedata/directory')>(),applyDirectoryAction:mocks.apply}))
import { GET,POST } from './route'
const context={params:{id:'source'}}
beforeEach(()=>{vi.resetAllMocks();mocks.auth.mockResolvedValue({user:{id:'staff',storeId:'my-store',role:'STAFF'}});mocks.source.mockResolvedValue({id:'source'});mocks.products.mockResolvedValue([]);mocks.customers.mockResolvedValue([])})
it('returns authorization failures without reading source data or mutating mappings',async()=>{
 mocks.auth.mockResolvedValue({response:NextResponse.json({error:'forbidden'},{status:403})})
 expect((await GET(new Request('http://localhost'),context)).status).toBe(403)
 expect((await POST(new Request('http://localhost',{method:'POST',body:'{}'}),context)).status).toBe(403)
 expect(mocks.source).not.toHaveBeenCalled();expect(mocks.apply).not.toHaveBeenCalled()
 expect(mocks.auth).toHaveBeenLastCalledWith(['ADMIN'], 'commerce-core')
})
it('scopes source and target search to the authenticated store',async()=>{
 await GET(new Request('http://localhost?mode=choices&kind=product&q=ROYAL'),context)
 expect(mocks.source.mock.calls[0][0].where).toMatchObject({id:'source',storeId:'my-store'})
 expect(mocks.products.mock.calls[0][0]).toMatchObject({where:{storeId:'my-store'},take:20})
})
it('does not expose choices for a foreign source',async()=>{
 mocks.source.mockResolvedValue(null)
 expect((await GET(new Request('http://localhost?mode=choices'),context)).status).toBe(404)
 expect(mocks.customers).not.toHaveBeenCalled()
})
it('rejects oversized delivery addresses and passes an authorized action with server-owned store binding',async()=>{
 const request=(body:unknown)=>new Request('http://localhost',{method:'POST',body:JSON.stringify(body)})
 expect((await POST(request({action:'createPoint',recordId:'record',customerId:'buyer',name:'Shop',city:'City',address:'x'.repeat(255)}),context)).status).toBe(400)
 mocks.apply.mockResolvedValue({ok:true})
 expect((await POST(request({action:'linkCustomer',recordId:'record',entityId:'buyer'}),context)).status).toBe(200)
 expect(mocks.apply.mock.calls[0][0]).toEqual({storeId:'my-store',connectionId:'source'})
})

it('requires explicit confirmation and a reason; provenance and actor cannot be supplied by the client',async()=>{
 const base={action:'createPoint',recordId:'partner',customerId:'customer',name:'Shop',city:'City',address:'Street'}
 const send=(manualAssignment:unknown)=>POST(new Request('http://localhost',{method:'POST',body:JSON.stringify({...base,manualAssignment})}),context)
 for(const invalid of [{confirmed:false,reason:'Owner confirmed'},{confirmed:true,reason:'  '},{confirmed:true,reason:'x'.repeat(1001)},{confirmed:true,reason:'Owner confirmed',actorId:'forged'}]) expect((await send(invalid)).status).toBe(400)
 expect(mocks.apply).not.toHaveBeenCalled()
 mocks.apply.mockResolvedValue({ok:true})
 expect((await send({confirmed:true,reason:' Owner confirmed '})).status).toBe(200)
 expect(mocks.apply.mock.calls[0][1].manualAssignment).toEqual({confirmed:true,reason:'Owner confirmed'})
 expect(mocks.apply.mock.calls[0][2].id).toBe('staff')
 expect(mocks.auth).toHaveBeenLastCalledWith(['ADMIN'], 'commerce-core')
})

it('returns the saved manual assignment independently of absent source links, scoped to partner mappings',async()=>{
 mocks.source.mockResolvedValue({id:'source',sourceState:'ACTIVE',enabled:true})
 mocks.records.mockResolvedValueOnce([{id:'record',kind:'partner',externalId:'partner-guid',normalized:{counterpartyIds:[]}}]).mockResolvedValueOnce([])
 mocks.count.mockResolvedValue(1);mocks.receipt.mockResolvedValue(null)
 const assignment={origin:'MANUAL',reason:'Owner confirmed',customerName:'Legal customer',assignedAt:'2026-01-01T00:00:00Z'}
 mocks.refs.mockResolvedValue([{entityType:'utPartnerPoint',externalId:'partner-guid',entityId:'point',sourceData:assignment},{entityType:'edCustomer',externalId:'partner-guid',entityId:'unrelated',sourceData:{private:'must not appear'}}])
 mocks.points.mockResolvedValue([{id:'point',name:'Existing point'}])
 const response=await GET(new Request('http://localhost?kind=partner'),context),data=await response.json()
 expect(data.rows[0].normalized.counterpartyIds).toEqual([])
 expect(data.rows[0].links).toEqual([{entityType:'utPartnerPoint',externalId:'partner-guid',entityId:'point',name:'Existing point',assignment}])
 expect(data.editable).toBe(false)
 expect(mocks.points.mock.calls[0][0].where.customer.storeId).toBe('my-store')
})
it('offers existing points only through the scoped customer search',async()=>{
 mocks.customers.mockResolvedValue([{id:'customer',displayName:'Legal',inn:'262814584465',locations:[{id:'point',name:'Shop',city:'City',address:'Street'}]}])
 const response=await GET(new Request('http://localhost?mode=choices&kind=partner&q=262814584465'),context)
 expect((await response.json()).choices[0].locations[0].id).toBe('point')
 expect(mocks.customers.mock.calls[0][0].where.storeId).toBe('my-store')
})
