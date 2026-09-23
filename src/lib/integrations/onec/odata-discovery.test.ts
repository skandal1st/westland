import { expect, it, vi } from 'vitest'
import { discoverOData, inspectODataMetadata, validateODataReadConfig } from './odata-discovery'
const schema = (extra = '') => `<?xml version="1.0"?><edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx"><edmx:DataServices><Schema xmlns="http://schemas.microsoft.com/ado/2008/09/edm" Namespace="StandardODATA">
<EntityType Name="Catalog_Партнеры"><Key><PropertyRef Name="Ref_Key"/></Key><Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/><Property Name="Description" Type="Edm.String"/><Property Name="КонтактнаяИнформация" Type="Collection(StandardODATA.Contacts)"/></EntityType>
<EntityType Name="Catalog_Контрагенты"><Property Name="Ref_Key" Type="Edm.Guid"/><Property Name="Партнер_Key" Type="Edm.Guid"/><Property Name="ИНН" Type="Edm.String"/></EntityType>
<ComplexType Name="Contacts"><Property Name="Представление" Type="Edm.String"/></ComplexType>
<EntityContainer Name="Container"><EntitySet Name="Catalog_Партнеры" EntityType="StandardODATA.Catalog_Партнеры"/><EntitySet Name="Catalog_Контрагенты" EntityType="StandardODATA.Catalog_Контрагенты"/>${extra}</EntityContainer>
</Schema></edmx:DataServices></edmx:Edmx>`
const config = { baseUrl: 'https://erp.example.test/ut/odata/standard.odata', username: 'reader', password: 'private-password' }
it('inventories the actual relationship and contact fields without inferring ownership', () => {
  const report = inspectODataMetadata(schema())
  expect(report.missing).toEqual([])
  expect(report.catalogs[1].properties.map(p => p.name)).toContain('Партнер_Key')
  expect(report.complexTypes['StandardODATA.Contacts']).toEqual([{ name: 'Представление', type: 'Edm.String', nullable: true }])
  expect(report.catalogs[0].properties[0].nullable).toBe(false)
})
it('does not report unpublished catalogs as available', () => {
  expect(inspectODataMetadata(schema().replace('<EntitySet Name="Catalog_Партнеры" EntityType="StandardODATA.Catalog_Партнеры"/>', '')).missing).toEqual(['Catalog_Партнеры'])
})
it('rejects HTML, DTDs and ambiguous entity sets', () => {
  expect(() => inspectODataMetadata('<html>login</html>')).toThrow('odata_metadata_invalid')
  expect(() => inspectODataMetadata('<!DOCTYPE x SYSTEM "https://attacker.test/x">' + schema())).toThrow()
  expect(() => inspectODataMetadata(schema('<EntitySet Name="Catalog_Партнеры" EntityType="elsewhere"/>'))).toThrow('odata_metadata_invalid')
})
it.each(['http://erp.test/ut/odata/standard.odata', 'https://user:pass@erp.test/ut/odata/standard.odata', 'https://erp.test/ut/odata/standard.odata?x=1', 'https://erp.test/ut'])('refuses an unsafe or wrong endpoint %s', baseUrl => {
  expect(() => validateODataReadConfig({ ...config, baseUrl })).toThrow('odata_url_invalid')
})
it('uses only GET metadata and one identifier per catalog, without returning identities or credentials', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(schema())).mockResolvedValueOnce(Response.json({ value: [{ Ref_Key: '0c1383e7-5ba2-11ef-a082-00155d07ca23' }] })).mockResolvedValueOnce(Response.json({ value: [] }))
  const report = await discoverOData(config, fetcher)
  expect(report.readyForMapping).toBe(true)
  expect(report.access.map(a => a.empty)).toEqual([false, true])
  expect(JSON.stringify(report)).not.toContain('0c1383e7')
  expect(JSON.stringify(report)).not.toContain(config.password)
  expect(fetcher).toHaveBeenCalledTimes(3)
  for (const [url, init] of fetcher.mock.calls) {
    expect(url.origin).toBe('https://erp.example.test')
    expect(init.method).toBe('GET')
    expect(init.redirect).toBe('error')
  }
  expect(fetcher.mock.calls[1][0].searchParams.get('$select')).toBe('Ref_Key')
  expect(fetcher.mock.calls[1][0].searchParams.get('$top')).toBe('1')
})
it('reports denied read access and does not mark the source ready', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(schema())).mockResolvedValueOnce(new Response('private error', { status: 403 })).mockResolvedValueOnce(Response.json({ value: [] }))
  const report = await discoverOData(config, fetcher)
  expect(report.readyForMapping).toBe(false)
  expect(report.access[0].error).toBe('odata_http_403')
  expect(JSON.stringify(report)).not.toContain('private error')
})
it('caps responses and sanitizes network failures', async () => {
  await expect(discoverOData(config, vi.fn().mockResolvedValue(new Response('', { headers: { 'content-length': String(9 * 1024 * 1024) } })))).rejects.toThrow('odata_response_too_large')
  await expect(discoverOData(config, vi.fn().mockRejectedValue(new Error(config.password)))).rejects.toThrow('odata_connection_failed')
})
