#!/usr/bin/env node
/**
 * Architectural boundary check (M0).
 *
 * Enforces two invariants from the brief and PLATFORM_FOUNDATION.md:
 *   1. No client-name hardcode in logic — e.g. `if (client === 'westside')`.
 *      Client differences belong in StoreProfile/config, not code branches.
 *   2. No provider-specific integration code imported into the domain/app layer.
 *      Provider adapters (moysklad, onec, 1c, ...) must stay behind the
 *      OperationalProvider port; domain code depends on the port, not the impl.
 *
 * Exit non-zero on any violation so CI blocks the merge.
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const SRC = path.join(ROOT, 'src')

/** Directories that are allowed to reference provider names (the adapter layer). */
const PROVIDER_ALLOWED_PREFIXES = [path.join('src', 'lib', 'integrations')]

const CLIENT_HARDCODE = [
  // if (client === 'westside'), profile == "westside", switch on client name, etc.
  /(===?|!==?)\s*['"`]westside['"`]/i,
  /['"`]westside['"`]\s*(===?|!==?)/i,
]

// Import of a provider-specific module from outside the adapter layer.
const PROVIDER_IMPORT = /\b(?:import|require)\b[^\n]*['"`][^'"`]*\/(moysklad|onec|one-c|1c)(?:\/|['"`])/i

/** @type {string[]} */
const violations = []

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue
      walk(full)
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      scan(full)
    }
  }
}

function scan(file) {
  const rel = path.relative(ROOT, file)
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  const inAdapterLayer = PROVIDER_ALLOWED_PREFIXES.some((p) => rel.startsWith(p))

  lines.forEach((line, i) => {
    for (const pattern of CLIENT_HARDCODE) {
      if (pattern.test(line)) {
        violations.push(`${rel}:${i + 1}  client-name hardcode in logic → ${line.trim()}`)
      }
    }
    if (!inAdapterLayer && PROVIDER_IMPORT.test(line)) {
      violations.push(`${rel}:${i + 1}  provider-specific import outside adapter layer → ${line.trim()}`)
    }
  })
}

if (!fs.existsSync(SRC)) {
  console.error('boundary-check: src/ not found')
  process.exit(1)
}

walk(SRC)

if (violations.length > 0) {
  console.error(`\n✗ commerce boundary check failed (${violations.length}):\n`)
  for (const v of violations) console.error('  ' + v)
  console.error('\nSee docs/AXIMA_COMMERCE_IMPLEMENTATION_PLAN.md §3 and docs/PLATFORM_FOUNDATION.md.')
  process.exit(1)
}

console.log('✓ commerce boundary check passed')
