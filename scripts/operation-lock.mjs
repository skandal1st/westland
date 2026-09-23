import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
export function acquireOperationLock(deployment, action) {
  fs.mkdirSync(deployment, { recursive: true })
  const dir = path.join(deployment, '.operation.lock')
  const inherited = process.env.AXIMA_DEPLOY_LOCK_TOKEN
  if (inherited) {
    const owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'))
    if (action !== 'backup' || owner.action !== 'update' || owner.token !== inherited) throw Error('Invalid delegated deployment lock')
    process.kill(owner.pid, 0)
    return { token: inherited, release() {} }
  }
  try { fs.mkdirSync(dir, { mode: 0o700 }) }
  catch { throw Error('Installation is locked: deployment/.operation.lock. Check owner PID and services before removing a stale lock.') }
  const token = crypto.randomUUID()
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, action, token, startedAt: new Date().toISOString() }), { mode: 0o600 })
  return { token, release() { fs.unlinkSync(path.join(dir, 'owner.json')); fs.rmdirSync(dir) } }
}
