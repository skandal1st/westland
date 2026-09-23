import { SaxesParser } from 'saxes'

const MAX_BYTES = 8 * 1024 * 1024
const EDM = new Set(['http://schemas.microsoft.com/ado/2006/04/edm', 'http://schemas.microsoft.com/ado/2007/05/edm', 'http://schemas.microsoft.com/ado/2008/09/edm', 'http://schemas.microsoft.com/ado/2009/11/edm'])
const CATALOGS = ['Catalog_Партнеры', 'Catalog_Контрагенты'] as const
export class ODataDiscoveryError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ODataDiscoveryError' }
}
const fail = (code: string): never => { throw new ODataDiscoveryError(code) }
export type ODataProperty = { name: string; type: string; nullable: boolean }
export type ODataMetadata = { catalogs: Array<{ name: string; entityType: string; properties: ODataProperty[] }>; complexTypes: Record<string, ODataProperty[]>; missing: string[] }

/** Schema inventory only: no assumption about UT versions or partner ownership. */
export function inspectODataMetadata(xml: string): ODataMetadata {
  if (Buffer.byteLength(xml, 'utf8') > MAX_BYTES) fail('odata_response_too_large')
  const types = new Map<string, ODataProperty[]>(), complexes = new Map<string, ODataProperty[]>()
  const sets = new Map<string, string>()
  let namespace = '', current: ODataProperty[] | undefined
  const parser = new SaxesParser({ xmlns: true })
  parser.on('doctype', () => fail('odata_doctype_forbidden'))
  parser.on('error', () => fail('odata_metadata_invalid'))
  parser.on('opentag', tag => {
    if (!EDM.has(tag.uri)) return
    const attr = (name: string) => Object.values(tag.attributes).find(a => a.local === name && !a.uri)?.value ?? ''
    if (tag.local === 'Schema') namespace = attr('Namespace')
    if (tag.local === 'EntityType' || tag.local === 'ComplexType') {
      current = []
      const name = namespace + '.' + attr('Name'), map = tag.local === 'EntityType' ? types : complexes
      if (!namespace || !attr('Name') || map.has(name)) fail('odata_metadata_invalid')
      map.set(name, current)
    }
    if (tag.local === 'Property' && current) {
      if (!attr('Name') || !attr('Type') || current.some(p => p.name === attr('Name'))) fail('odata_metadata_invalid')
      current.push({ name: attr('Name'), type: attr('Type'), nullable: attr('Nullable') !== 'false' })
    }
    if (tag.local === 'EntitySet') {
      if (sets.has(attr('Name'))) fail('odata_metadata_invalid')
      sets.set(attr('Name'), attr('EntityType'))
    }
  })
  parser.on('closetag', tag => {
    if (EDM.has(tag.uri) && ['EntityType', 'ComplexType'].includes(tag.local)) current = undefined
  })
  try { parser.write(xml).close() } catch (error) {
    if (error instanceof ODataDiscoveryError) throw error
    return fail('odata_metadata_invalid')
  }
  if (!sets.size) fail('odata_metadata_invalid')
  const catalogs = CATALOGS.filter(name => sets.has(name)).map(name => {
    const entityType = sets.get(name)!, properties = types.get(entityType)
    if (!properties) return fail('odata_metadata_type_missing')
    return { name, entityType, properties }
  })
  return { catalogs, complexTypes: Object.fromEntries(complexes), missing: CATALOGS.filter(name => !sets.has(name)) }
}

export type ODataReadConfig = { baseUrl: string; username: string; password: string }
export function validateODataReadConfig(value: ODataReadConfig) {
  let base: URL
  try { base = new URL(value.baseUrl) } catch { return fail('odata_url_invalid') }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !base.pathname.replace(/\/$/, '').endsWith('/odata/standard.odata')) fail('odata_url_invalid')
  if (typeof value.username !== 'string' || !value.username || /[:\r\n]/.test(value.username) || typeof value.password !== 'string' || !value.password) fail('odata_credentials_invalid')
  base.pathname = base.pathname.replace(/\/$/, '') + '/'
  return base
}

/** GET only, no redirects carrying credentials, bounded response/time; config is server-owned. */
export async function discoverOData(config: ODataReadConfig, fetcher: typeof fetch = fetch) {
  const base = validateODataReadConfig(config)
  const authorization = 'Basic ' + Buffer.from(config.username + ':' + config.password).toString('base64')
  async function read(path: string, accept: string) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await fetcher(new URL(path, base), { method: 'GET', redirect: 'error', headers: { authorization, accept }, signal: controller.signal })
      if (!response.ok) { await response.body?.cancel(); return fail('odata_http_' + response.status) }
      if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); return fail('odata_response_too_large') }
      const reader = response.body?.getReader()
      if (!reader) return fail('odata_response_empty')
      let size = 0
      const chunks: Uint8Array[] = []
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_BYTES) { await reader.cancel(); return fail('odata_response_too_large') }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    } catch (error) {
      if (error instanceof ODataDiscoveryError) throw error
      // Network exceptions can include a URL or credentials. Never expose the raw cause.
      return fail(controller.signal.aborted ? 'odata_timeout' : 'odata_connection_failed')
    } finally { clearTimeout(timer) }
  }
  const metadata = inspectODataMetadata(await read('$metadata', 'application/xml'))
  const access: Array<{ catalog: string; readable: boolean; empty: boolean | null; error?: string }> = []
  for (const catalog of metadata.catalogs) {
    if (!catalog.properties.some(p => p.name === 'Ref_Key' && p.type === 'Edm.Guid')) {
      access.push({ catalog: catalog.name, readable: false, empty: null, error: 'odata_reference_field_missing' }); continue
    }
    try {
      const body = JSON.parse(await read(encodeURIComponent(catalog.name) + '?$top=1&$select=Ref_Key&$format=json', 'application/json'))
      if (!Array.isArray(body.value) || body.value.length > 1 || body.value.some((row: { Ref_Key?: unknown }) => typeof row?.Ref_Key !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.Ref_Key))) fail('odata_data_invalid')
      access.push({ catalog: catalog.name, readable: true, empty: body.value.length === 0 })
    } catch (error) {
      access.push({ catalog: catalog.name, readable: false, empty: null, error: error instanceof ODataDiscoveryError ? error.code : 'odata_data_invalid' })
    }
  }
  return { checkedAt: new Date().toISOString(), readyForMapping: metadata.missing.length === 0 && access.every(a => a.readable), metadata, access }
}
