import { assertCapability, CapabilityError } from '@/lib/capabilities'
import { LicenseError } from '@/lib/license'
import { receiveSaleFile } from './sale-inbox'
import { querySales, acknowledgeSales } from './sale'
import { saleProfile } from './sale-document'
import { getActiveStore } from '@/lib/store'
import { COOKIE_NAME, mintSession, parseBasicAuth, readCookie, safeFilename, verifySession } from '@/lib/integrations/onec/exchange'
import { sourceCredentials, matchCredential } from '@/lib/integrations/onec/credentials'
import { authenticateSession, openExchangeSession, initializeSession, receiveChunk, finishFile, closeSession } from '@/lib/integrations/onec/ledger'
import { CHUNK_LIMIT, ExchangeError, readLimitedBody } from '@/lib/integrations/onec/storage'

const text = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers } })
export async function handleOnecExchange(request: Request): Promise<Response> {
  try {
    const secret = process.env.NEXTAUTH_SECRET
    if (!secret) throw new ExchangeError('exchange_not_configured', 503)
    const credentials = await sourceCredentials(), store = await getActiveStore(), url = new URL(request.url)
    const type = url.searchParams.get('type'), mode = url.searchParams.get('mode')
    if (type !== 'catalog' && type !== 'sale') throw new ExchangeError('unsupported_type', 400)
    if (mode === 'checkauth') {
      const credential = matchCredential(credentials, parseBasicAuth(request.headers.get('authorization')))
      assertCapability('commerce-core')
      const session = await openExchangeSession(store.id, credential, secret)
      const token = mintSession(secret, session.id)
      return text(`success\n${COOKIE_NAME}\n${token}`, 200, { 'set-cookie': `${COOKIE_NAME}=${token}; Path=/api/integrations/1c; HttpOnly; SameSite=Lax` })
    }
    const sessionId = verifySession(secret, readCookie(request.headers.get('cookie'), COOKIE_NAME))
    if (!sessionId) throw new ExchangeError('session_cookie_required', 401)
    const authority = { storeId: store.id, sessionId, credentials, secret }
    const session = await authenticateSession(authority)
    if (!(type === 'sale' && mode === 'success')) assertCapability('commerce-core')
    if (type === 'sale') {
      if (session.connection.sourceState !== 'ACTIVE' || !session.connection.enabled) throw new ExchangeError('source_not_active', 503)
      if (mode === 'init') { saleProfile(session.connection.config); return text(`zip=no\nfile_limit=${CHUNK_LIMIT}`) }
      if (mode === 'query') return text(await querySales(authority), 200, { 'content-type': 'application/xml; charset=utf-8' })
      if (mode === 'success') { await acknowledgeSales(authority); return text('success') }
      if (mode === 'file') {
        if (request.method !== 'POST') throw new ExchangeError('file_requires_post', 405)
        const name = safeFilename(url.searchParams.get('filename'))
        if (!name) throw new ExchangeError('invalid_filename', 400)
        await receiveSaleFile(authority, name, await readLimitedBody(request))
        return text('success')
      }
      throw new ExchangeError('unsupported_sale_mode', 400)
    }
    if (mode === 'init') { await initializeSession(authority); return text(`zip=no\nfile_limit=${CHUNK_LIMIT}`) }
    if (mode === 'file' || mode === 'import') {
      const name = safeFilename(url.searchParams.get('filename'))
      if (!name) throw new ExchangeError('invalid_filename', 400)
      if (mode === 'file') {
        if (request.method !== 'POST') throw new ExchangeError('file_requires_post', 405)
        await receiveChunk(authority, name, await readLimitedBody(request))
      } else await finishFile(authority, name)
      return text('success')
    }
    if (mode === 'complete') { await closeSession(authority); return text('success') }
    if (mode === 'deactivate') throw new ExchangeError('deactivation_requires_full_delta_contract')
    throw new ExchangeError('unsupported_catalog_mode', 400)
  } catch (error) {
    if (error instanceof LicenseError || error instanceof CapabilityError) return text('failure\n' + error.message, 403)
    if (error instanceof ExchangeError) return text(`failure\n${error.code}`, error.status)
    throw error
  }
}
