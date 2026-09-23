import fs from 'node:fs'
import crypto from 'node:crypto'
export const immutableImage = value => /^(sha256:[a-f0-9]{64}|[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64})$/.test(value ?? '')
export function persistImage(file, image) {
  if (!immutableImage(image)) throw Error('APP_IMAGE must be immutable')
  const stat = fs.statSync(file)
  const content = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => !/^APP_IMAGE=/.test(line)).join('\n').trimEnd() + '\nAPP_IMAGE=' + image + '\n'
  const tmp = file + '.' + crypto.randomUUID() + '.tmp'
  try {
    fs.writeFileSync(tmp, content, { mode: stat.mode & 0o777 })
    if (process.platform !== 'win32') fs.chownSync(tmp, stat.uid, stat.gid)
    fs.renameSync(tmp, file)
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) }
}
// Deliberately narrow automatic rollback contract. Data rewrites, constraints,
// defaults, functions, table drops/renames and complex SQL need a separate rehearsal.
// Reviewed additive expansion: GiftPromotion is new; existing Cart/OrderItem receive only nullable columns.
// The mandatory copy rehearsal still runs candidate AND previous-image Prisma reads before production migration.
// Exact digest prevents this exception from authorizing edits, data rewrites or unrelated constraints.
const reviewedAdditiveMigrations = new Set(['78176c9ff6d3ae68177818cd14b5b86ab5e8150aa1333de347378a063cae2d44'])
export function assertAdditiveMigration(sql) {
  if (reviewedAdditiveMigrations.has(crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex'))) return
  const statements = sql.replace(/--[^\r\n]*/g, '').split(';').map(x => x.trim()).filter(Boolean)
  const id = '(?:"[A-Za-z_][A-Za-z0-9_]*"|[A-Za-z_][A-Za-z0-9_]*)'
  const type = '(?:TEXT|BOOLEAN|INTEGER|BIGINT|DOUBLE PRECISION|TIMESTAMP(?:\\([0-6]\\))?|DECIMAL\\([0-9]+,\\s*[0-9]+\\))'
  const column = new RegExp('^ALTER TABLE ' + id + ' ADD COLUMN ' + id + ' ' + type + '$', 'i')
  const index = new RegExp('^CREATE INDEX ' + id + ' ON ' + id + '\\s*\\(' + id + '(?:\\s*,\\s*' + id + ')*\\)$', 'i')
  if (!statements.length || statements.some(statement => !column.test(statement.replace(/\s+/g, ' ')) && !index.test(statement.replace(/\s+/g, ' ')))) throw Error('Migration exceeds automatic additive rollback contract; rehearse and review it separately')
}
