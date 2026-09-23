import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkBoundaries, ADAPTER_IMPORTS } from './commerce-boundaries.mjs'
function check(file, code) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axima-boundary-'))
  try { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, code); return checkBoundaries(root) }
  finally { if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('axima-boundary-')) throw new Error('Unsafe temporary cleanup path'); fs.rmSync(root, { recursive: true, force: true }) }
}
test('only the three declared diagnostics imports are allowed', () => {
  for (const [file, names] of Object.entries(ADAPTER_IMPORTS)) assert.deepEqual(check(file, "import { " + names[0] + " as local } from '@/lib/integrations/onec/status'"), [])
})
test('an allowed route cannot import another export or provider implementation', () => {
  const file = Object.keys(ADAPTER_IMPORTS)[0]
  for (const code of ["import { scanGroups } from '@/lib/integrations/onec/status'", "import * as status from '@/lib/integrations/onec/status'", "export { readStatus } from '@/lib/integrations/onec/status'", "import { readStatus } from '@/lib/integrations/onec/provider'"]) assert.equal(check(file, code).length, 1)
})
test('multiline, relative, re-export, require and dynamic imports are checked', () => {
  for (const code of ["import {\n readStatus\n} from '@/lib/integrations/onec/status'", "export * from '../../lib/integrations/onec/status'", "require('@/lib/integrations/onec/status')", "import(\n '@/lib/integrations/onec/status'\n)"]) assert.equal(check('src/app/example.ts', code).length, 1)
})
test('nearby routes and similarly named directories are not exempt', () => {
  assert.equal(check('src/app/api/staff/integrations/onec/new/route.ts', "import { readStatus } from '@/lib/integrations/onec/status'").length, 1)
  assert.equal(check('src/lib/integrations-other/test.ts', "import { readStatus } from '@/lib/integrations/onec/status'").length, 1)
})
test('adapter implementation imports remain permitted', () => assert.deepEqual(check('src/lib/integrations/registry.ts', "import { provider } from './onec/provider'"), []))
test('client-name hardcodes still fail inside adapters', () => assert.equal(check('src/lib/integrations/a.ts', "if (client === 'westside') {}").length, 1))

test('TypeScript import-equals and import types keep the same boundary', () => {
  for (const code of ["import status = require('@/lib/integrations/onec/status')", "type T = import('@/lib/integrations/onec/status').GroupNode"]) assert.equal(check('src/app/example.ts', code).length, 1)
})
