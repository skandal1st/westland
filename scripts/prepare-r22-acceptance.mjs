import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto'
import { generateInstallationIdentity, signGrant, verifyGrantEnvelope } from '../packages/license-core/index.mjs'

const root = path.resolve('deployment/r22-acceptance')
if (fs.existsSync(root)) throw new Error('Acceptance directory already exists; reuse it without replacing credentials.')
fs.mkdirSync(root, { recursive: true })
const secret = () => randomBytes(32).toString('hex')
const password = secret(), exchangePassword = secret(), connectionId = randomUUID()
const identity = generateInstallationIdentity()
const publisher = generateKeyPairSync('ed25519')
const publicKey = publisher.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const grant = signGrant({
  schemaVersion: 1, licenseId: 'r22-acceptance-fixture', customerId: 'r22-acceptance',
  installationId: identity.installationId, installationPublicKeyThumbprint: identity.publicKeyThumbprint,
  deploymentClass: 'production', modules: ['commerce-core', 'commerce-b2b'],
  release: { channel: 'stable' }, issuedAt: new Date().toISOString(),
  runtimeExpiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
}, publisher.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'r22-fixture')
verifyGrantEnvelope(grant, { 'r22-fixture': publicKey }, identity.privateKeyPem)
const write = (name, contents) => fs.writeFileSync(path.join(root, name), contents, { mode: 0o600, flag: 'wx' })
write('license.json', JSON.stringify(grant))
write('publisher-public.pem', publicKey)
write('installation-private-key.pem', identity.privateKeyPem)
write('profile.json', JSON.stringify({"store":{"code":"r22-acceptance","name":"R22 — изолированная проверка УТ 11.4"},"modules":["commerce-core","commerce-b2b"],"runtime":{"catalogRequiresAuth":true,"registration":"manual","requireAgeConfirmation":true,"themeId":"default","defaultPalette":"violet","defaultChannelCode":"R22"},"integration":{"provider":"one-c"}}, null, 2))
write('postgres.env', `POSTGRES_USER=axima_r22\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=axima_r22_acceptance\n`)
write('runtime.env', `DATABASE_URL=postgresql://axima_r22:${password}@postgres-r22:5432/axima_r22_acceptance
NEXTAUTH_URL=http://127.0.0.1:3312
NEXTAUTH_SECRET=${secret()}
STORE_PROFILE_PATH=/app/r22-config/profile.json
LICENSE_ENFORCE=1
LICENSE_GRANT_PATH=/app/r22-config/license.json
LICENSE_INSTALLATION_KEY_PATH=/app/r22-config/installation-private-key.pem
LICENSE_PUBLISHER_PUBLIC_KEY_PATH=/app/r22-config/publisher-public.pem
ONEC_EXCHANGE_CONNECTION_ID=${connectionId}
ONEC_EXCHANGE_USER=r22-acceptance
ONEC_EXCHANGE_PASSWORD=${exchangePassword}
R22_ACCEPTANCE=1
`)
write('connection.json', JSON.stringify({
  url: 'http://127.0.0.1:3312/api/integrations/1c/exchange',
  proposedPublicUrl: 'https://westsidetobacco.ru/api/integrations/1c/r22-acceptance',
  user: 'r22-acceptance', password: exchangePassword, connectionId,
}, null, 2))
console.log('Prepared isolated acceptance files: deployment/r22-acceptance. Credentials were not printed.')
