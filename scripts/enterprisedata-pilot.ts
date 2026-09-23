import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { EnterpriseDataError, inspectMessage, MAX_XML_BYTES } from '../src/lib/integrations/enterprisedata/message'
import { initializeJournal, journalStatus, prepareOrder, recordReceipt } from '../src/lib/integrations/enterprisedata/journal'
import { ZodError } from 'zod'

function read(path: string) {
  if (statSync(path).size > MAX_XML_BYTES) throw new EnterpriseDataError('ed_file_too_large')
  return readFileSync(path)
}
function output(path: string, xml: string) {
  // Never overwrite another exchange packet. The journal allows byte-identical regeneration.
  writeFileSync(path, xml, { flag: 'wx', mode: 0o600 })
}
function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'inspect' && args.length === 1) {
    const m = inspectMessage(read(args[0]))
    console.log(JSON.stringify({ ...m, objects: undefined, objectCounts: m.objects.reduce<Record<string, number>>((a, o) => ({ ...a, [o.name]: (a[o.name] ?? 0) + 1 }), {}) }, null, 2))
  } else if (command === 'init' && args.length === 3) {
    const result = initializeJournal(args[0], read(args[1])); output(args[2], result.xml)
    console.log(JSON.stringify({ initialized: true, reused: result.reused }))
  } else if (command === 'prepare' && args.length === 4) {
    const result = prepareOrder(args[0], JSON.parse(read(args[1]).toString('utf8').replace(/^\uFEFF/, '')), read(args[2]))
    output(args[3], result.xml)
    console.log(JSON.stringify({ documentId: result.documentId, messageNo: result.messageNo, sha256: result.sha256, reused: result.reused }))
  } else if (command === 'receipt' && args.length === 2) {
    console.log(JSON.stringify(recordReceipt(args[0], read(args[1]))))
  } else if (command === 'status' && args.length === 1) {
    console.log(JSON.stringify(journalStatus(args[0]), null, 2))
  } else {
    console.log('Offline TEST pilot, EnterpriseData 1.20. No network/database access.\n'
      + 'inspect <peer.xml>\ninit <journal-dir> <peer-settings.xml> <new-reply.xml>\n'
      + 'prepare <journal-dir> <input.json> <peer-evidence.xml> <new-message.xml>\n'
      + 'receipt <journal-dir> <peer-message.xml>\nstatus <journal-dir>')
    if (command && command !== 'help') process.exitCode = 1
  }
}
try { main() } catch (error) {
  // Do not print input, customer data, filesystem paths or stack traces.
  console.error(error instanceof EnterpriseDataError ? error.code : error instanceof ZodError ? 'ed_invalid_input' : 'ed_file_operation_failed')
  process.exitCode = 1
}
