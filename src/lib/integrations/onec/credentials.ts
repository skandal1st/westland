import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { z } from 'zod'
import { checkCredentials, type Credentials } from './exchange'
import { ExchangeError } from './storage'

const schema = z.array(z.object({ connectionId: z.string().min(1), user: z.string().min(1), pass: z.string().min(1) }).strict()).min(1)
export type SourceCredential = Credentials & { connectionId: string }
export async function sourceCredentials(): Promise<SourceCredential[]> {
  let rows: SourceCredential[]
  if (process.env.ONEC_SOURCES_FILE) {
    try { rows = schema.parse(JSON.parse(await fs.readFile(process.env.ONEC_SOURCES_FILE, 'utf8'))) }
    catch { throw new ExchangeError('source_credentials_not_configured', 503) }
  } else {
    const { ONEC_EXCHANGE_CONNECTION_ID: connectionId, ONEC_EXCHANGE_USER: user, ONEC_EXCHANGE_PASSWORD: pass } = process.env
    if (!connectionId || !user || !pass) throw new ExchangeError('source_credentials_not_configured', 503)
    rows = [{ connectionId, user, pass }]
  }
  if (new Set(rows.map(row => row.connectionId)).size !== rows.length || new Set(rows.map(row => row.user)).size !== rows.length) throw new ExchangeError('source_credentials_ambiguous', 503)
  return rows
}
export function credentialDigest(credential: SourceCredential, secret: string): string {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(credential)).digest('hex')
}
export function matchCredential(rows: SourceCredential[], basic: Credentials | null): SourceCredential {
  const matched = rows.filter(row => checkCredentials(basic, row))
  if (matched.length !== 1) throw new ExchangeError('authentication_failed', 401)
  return matched[0]
}
