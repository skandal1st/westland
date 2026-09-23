import { createHash, timingSafeEqual } from 'node:crypto'
import { SetupError, type HttpSetup } from './http-setup'
import { FILE_METHODS, type FileReply } from './http-files'
import { type IncomingMessage, createServer } from 'node:http'

/** SSL HTTP transport; business processing is delegated to the configured handler.
 * Reference: 1c-syntax/ssl_3_1 a49b661bab6bc49ff5ea5f422f89de95487fcd46,
 * ТранспортСообщенийОбменаHTTP/ObjectModule.bsl and exchange_dsl_1_0_0_1.
 * Reference author ООО 1С-Софт, CC BY 4.0; independent TS implementation.
 */
export type ProbeOptions = {
  username: string; password: string; basePath: string; setup?: HttpSetup; files?: { handle(operation: string, query: URLSearchParams, body?: Buffer): FileReply | Promise<FileReply> }
  audit?: (event: { at: string; operation: string; status: number; errorCode?: string }) => void
}
async function readBody(req: IncomingMessage) {
  const limit = 1024 * 1024
  if (Number(req.headers['content-length'] ?? '0') > limit) throw new SetupError(413, 'ed_setup_body_too_large')
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0, failed = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (failed) return
      if (size > limit) { failed = true; chunks.length = 0; reject(new SetupError(413, 'ed_setup_body_too_large')); return }
      chunks.push(chunk)
    })
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)) })
    req.on('error', () => reject(new SetupError(400, 'ed_setup_body_interrupted')))
    req.on('aborted', () => reject(new SetupError(400, 'ed_setup_body_interrupted')))
  })
}
export function createEnterpriseDataProbe(options: ProbeOptions) {
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(options.username) || !/^[A-Za-z0-9_-]{32,128}$/.test(options.password)
    || !/^\/[a-z0-9/-]+$/.test(options.basePath) || options.basePath.endsWith('/')) throw new Error('ed_probe_config_invalid')
  const prefix = options.basePath + '/hs/exchange_dsl_1_0_0_1'
  const expected = createHash('sha256').update('Basic ' + Buffer.from(options.username + ':' + options.password).toString('base64')).digest()
  let windowStart = Date.now(), attempts = 0
  const server = createServer(async (req, res) => {
    const now = Date.now()
    if (now - windowStart >= 60_000) { windowStart = now; attempts = 0 }
    const requestUrl = (req.url ?? '').replace(/^\/+/, '/'), pathname = requestUrl.split('?')[0]
    const name = pathname.startsWith(prefix + '/v1/') ? pathname.slice((prefix + '/v1/').length) : ''
    const operation = pathname === prefix + '/version' ? 'version'
      : ['GetIBParameters', 'CreateExchangeNode', ...Object.keys(FILE_METHODS)].includes(name) ? name : 'unsupported'
    const reply = (status: number, body: string | Buffer, type: 'text' | 'json' | 'binary' = 'json', errorCode?: string) => {
      try { options.audit?.({ at: new Date().toISOString(), operation, status, ...(errorCode ? { errorCode } : {}) }) }
      catch { status = 503; body = '{"message":"ed_probe_audit_unavailable"}'; type = 'json' }
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Type', type === 'binary' ? 'application/octet-stream' : type === 'text' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8')
      res.writeHead(status); res.end(body)
    }
    if (++attempts > 120) { res.setHeader('Retry-After', '60'); return reply(429, '{"message":"ed_probe_rate_limit"}') }
    const auth = req.headers.authorization ?? ''
    if (auth.length > 512 || !timingSafeEqual(createHash('sha256').update(auth).digest(), expected)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="AXIMA ED TEST", charset="UTF-8"')
      return reply(401, '{"message":"ed_probe_unauthorized"}')
    }
    const acceptsBody = req.method === 'POST' && (options.setup && operation === 'CreateExchangeNode' || options.files && operation === 'PutFilePart')
    if (!acceptsBody && (req.headers['transfer-encoding'] || req.headers['content-length'] && req.headers['content-length'] !== '0')) {
      res.setHeader('Connection', 'close'); return reply(413, '{"message":"ed_probe_body_forbidden"}')
    }
    try {
      if (operation === 'version') {
        if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return reply(405, '{"message":"ed_probe_get_required"}') }
        if (requestUrl.includes('?')) return reply(400, '{"message":"ed_probe_query_forbidden"}')
        return reply(200, '1', 'text')
      }
      const query = new URL(requestUrl, 'http://localhost').searchParams
      if (options.setup && operation === 'GetIBParameters') {
        if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return reply(405, '{"message":"ed_setup_get_required"}') }
        const parameters = options.setup.parameters(query)
        if (options.files && parameters.NodeExists) parameters.DataSynchronizationSetupCompleted = true
        return reply(200, JSON.stringify(parameters))
      }
      if (options.setup && operation === 'CreateExchangeNode') {
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return reply(405, '{"message":"ed_setup_post_required"}') }
        if (Array.from(query.keys()).length) return reply(400, '{"message":"ed_setup_query_forbidden"}')
        const body = await readBody(req); let value: unknown
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body).replace(/^\uFEFF/, '')) }
        catch { throw new SetupError(400, 'ed_setup_json_invalid') }
        options.setup.create(value); return reply(200, '', 'text')
      }
      if (options.files && Object.prototype.hasOwnProperty.call(FILE_METHODS, operation)) {
        if (req.method !== FILE_METHODS[operation]) { res.setHeader('Allow', FILE_METHODS[operation]); return reply(405, '{"message":"ed_file_method_invalid"}') }
        const result = await options.files.handle(operation, query, operation === 'PutFilePart' ? await readBody(req) : undefined)
        return reply(200, result.body, result.type)
      }
      if (pathname.startsWith(prefix + '/v1/')) return reply(501, JSON.stringify({ message: 'AXIMA ED: операция пока не включена; данные не приняты.' }))
      return reply(404, '{"message":"ed_probe_route_not_found"}')
    } catch (error) {
      if (res.destroyed) return
      if (error instanceof SetupError) {
        if (error.status === 413) res.setHeader('Connection', 'close')
        return reply(error.status, JSON.stringify({ message: error.code }), 'json', error.code)
      }
      return reply(503, '{"message":"ed_transport_unavailable"}', 'json', 'ed_transport_unavailable')
    }
  })
  server.headersTimeout = 10_000; server.requestTimeout = 15_000; server.keepAliveTimeout = 2_000; server.maxHeadersCount = 40
  return server
}
