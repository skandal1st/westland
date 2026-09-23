import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs'

/** Bounded operator log. Rotation never changes the durable exchange journal. */
export function appendTransportAudit(file: string, event: unknown, maxBytes = 5 * 1024 * 1024, archives = 5) {
  const line = JSON.stringify(event) + '\n'
  if (Buffer.byteLength(line) > maxBytes) throw new Error('audit_event_too_large')
  if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > maxBytes) {
    if (existsSync(file + '.' + archives)) unlinkSync(file + '.' + archives)
    for (let n = archives - 1; n >= 1; n--) if (existsSync(file + '.' + n)) renameSync(file + '.' + n, file + '.' + (n + 1))
    renameSync(file, file + '.1')
  }
  appendFileSync(file, line, { mode: 0o600 })
}
