import {describe,it,expect,vi,beforeEach} from 'vitest'
const mocks=vi.hoisted(()=>({auth:vi.fn(),import:vi.fn()}))
vi.mock('@/lib/authz',()=>({requireApiUser:mocks.auth}))
vi.mock('@/lib/integrations/enterprisedata/partners',()=>({importPartners:mocks.import,MAX_PARTNER_BYTES:4194304}))
import {POST} from './route'
beforeEach(()=>{vi.clearAllMocks();mocks.auth.mockResolvedValue({user:{id:'a',email:'a@test',storeId:'trusted'}});mocks.import.mockResolvedValue({ok:true,objects:1})})
describe('partner import endpoint',()=>{
 it('requires ADMIN before parsing or invoking importer',async()=>{mocks.auth.mockResolvedValue({response:new Response('',{status:403})});expect((await POST(new Request('http://local',{method:'POST',body:'bad'}),{params:{id:'src'}})).status).toBe(403);expect(mocks.auth).toHaveBeenCalledWith(['ADMIN'], 'commerce-core');expect(mocks.import).not.toHaveBeenCalled()})
 it('uses authenticated store and route source',async()=>{const r=await POST(new Request('http://local',{method:'POST',body:'{}'}),{params:{id:'src'}});expect(r.status).toBe(200);expect(mocks.import.mock.calls[0][0]).toEqual({storeId:'trusted',connectionId:'src'})})
 it('limits actual streamed bytes even without content length',async()=>{const r=await POST(new Request('http://local',{method:'POST',body:'x'.repeat(4194305)}),{params:{id:'src'}});expect(r.status).toBe(413);expect(mocks.import).not.toHaveBeenCalled()})
})
