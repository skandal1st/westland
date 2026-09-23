import fs from 'node:fs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
const root = 'deployment/r22-acceptance'
const credentials = JSON.parse(fs.readFileSync(root + '/connection.json', 'utf8'))
if (credentials.url !== 'http://127.0.0.1:3312/api/integrations/1c/exchange') throw new Error('Local acceptance URL guard')
const isPublic = process.argv.includes('--public')
const endpoint = isPublic ? 'https://westsidetobacco.ru/api/integrations/1c/r22-acceptance' : credentials.url
const url = endpoint + '?type=sale&mode='
const savedFile = root + (isPublic ? '/public-http-session.json' : '/http-session.json')
const digest = value => createHash('sha256').update(value).digest('hex')
const report = { endpoint, real1C: false, checks: [] }
let cookie, expected
const call = mode => fetch(url + mode, { headers: { cookie } })
if (process.argv.includes('--resume')) {
  ({ cookie, expected } = JSON.parse(fs.readFileSync(savedFile, 'utf8')))
} else {
  const unauthenticated = await fetch(url + 'query')
  assert.equal(unauthenticated.status, 401); report.checks.push('unauthenticated query rejected')
  const bad = await fetch(url + 'checkauth', { headers: { authorization: 'Basic ' + Buffer.from(credentials.user + ':wrong').toString('base64') } })
  assert.equal(bad.status, 401); report.checks.push('wrong password rejected')
  const auth = await fetch(url + 'checkauth', { headers: { authorization: 'Basic ' + Buffer.from(credentials.user + ':' + credentials.password).toString('base64') } })
  assert.equal(auth.status, 200)
  const lines = (await auth.text()).split('\n'); cookie = lines[1] + '=' + lines[2]
  const init = await call('init'); assert.equal(init.status, 200); assert.match(await init.text(), /^zip=no\nfile_limit=\d+$/)
  report.checks.push('checkauth and init passed')
}
const query = await call('query'); assert.equal(query.status, 200)
assert.match(query.headers.get('content-type'), /^application\/xml/)
const xml = await query.text(); assert.match(xml, /ВерсияСхемы="2.10"/); assert.ok(!xml.includes('<Документ>'))
if (expected) { assert.equal(digest(xml), expected); report.checks.push('same session and exact XML survived app restart') }
else { expected = digest(xml); fs.writeFileSync(savedFile, JSON.stringify({ cookie, expected }), { mode: 0o600 }) }
assert.equal(await (await call('query')).text(), xml)
report.checks.push('empty queue and stable repeat')
for (let i = 0; i < 2; i++) { const ack = await call('success'); assert.equal(ack.status, 200); assert.equal(await ack.text(), 'success') }
report.checks.push('repeated transport receipt passed')
const file = await fetch(url + 'file&filename=orders.xml', { method: 'POST', headers: { cookie }, body: '<test/>' })
assert.equal(file.status, 503); assert.equal(await file.text(), 'failure\nsale_ack_import_not_configured')
report.checks.push('unsupported inbound acknowledgement fails explicitly')
const name = isPublic ? 'r22-acceptance-public-http.json' : process.argv.includes('--resume') ? 'r22-acceptance-http-after-restart.json' : 'r22-acceptance-http.json'
fs.writeFileSync('docs/audits/evidence/remediation/' + name, JSON.stringify({ ...report, xmlSha256: expected, passed: true }, null, 2) + '\n')
console.log(JSON.stringify(report))
