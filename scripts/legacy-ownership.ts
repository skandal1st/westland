/** Explicit operator command; never invoked by startup, migrations or the worker. */
import fs from 'node:fs/promises'
import { PrismaClient } from '@prisma/client'
import { draftLegacyOwnership, applyLegacyOwnership, rollbackLegacyOwnership } from '../src/lib/integrations/onec/legacy-ownership'

async function main() {
  const [mode, ...args] = process.argv.slice(2)
  const allowed: Record<string, string[]> = { draft: ['request', 'output'], apply: ['plan', 'confirm', 'actor'], rollback: ['batch', 'confirm', 'actor'], status: ['digest'] }
  if (!mode || mode === '--help') {
    console.log('legacy-ownership: draft --request request.json --output plan.json | apply --plan plan.json --confirm DIGEST --actor ADMIN_ID | rollback --batch ID --confirm DIGEST --actor ADMIN_ID | status --digest DIGEST')
    return
  }
  if (!allowed[mode] || args.length % 2) throw new Error('invalid_arguments')
  const flags = new Map<string, string>()
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i].replace(/^--/, '')
    if (args[i] !== `--${flag}` || !allowed[mode].includes(flag) || flags.has(flag) || !args[i + 1]) throw new Error('invalid_arguments')
    flags.set(flag, args[i + 1])
  }
  for (const flag of allowed[mode]) if (!flags.has(flag)) throw new Error(`missing_${flag}`)
  const read = async (name: string) => JSON.parse(await fs.readFile(flags.get(name)!, 'utf8')) as unknown
  const db = new PrismaClient()
  try {
    if (mode === 'draft') {
      const plan = await draftLegacyOwnership(await read('request'), db)
      await fs.writeFile(flags.get('output')!, JSON.stringify(plan, null, 2), { flag: 'wx', mode: 0o600 })
      console.log(JSON.stringify({ digest: plan.digest, rows: plan.decisions.length, blockers: plan.blockers.length, mappings: plan.createMappings.length, warnings: plan.warnings, output: flags.get('output') }))
    } else if (mode === 'apply') console.log(JSON.stringify(await applyLegacyOwnership(await read('plan'), flags.get('confirm')!, flags.get('actor')!, db)))
    else if (mode === 'rollback') console.log(JSON.stringify(await rollbackLegacyOwnership(flags.get('batch')!, flags.get('confirm')!, flags.get('actor')!, db)))
    else {
      const batch = await db.legacyOwnershipBatch.findUnique({ where: { digest: flags.get('digest')! }, select: { id: true, storeId: true, connectionId: true, digest: true, appliedAt: true, rolledBackAt: true } })
      if (!batch) throw new Error('ownership_receipt_not_found')
      console.log(JSON.stringify(batch))
    }
  } finally { await db.$disconnect() }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
