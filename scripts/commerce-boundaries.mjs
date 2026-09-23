#!/usr/bin/env node
/** Domain code depends on integration ports; only explicit transport adapters may inspect provider data. */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

// These authenticated 1C administration endpoints read local exchange diagnostics.
// Exceptions are exact file + module + named exports, not a directory-wide bypass.
export const ADAPTER_IMPORTS = {
  'src/app/api/staff/integrations/onec/status/route.ts': ['readStatus'],
  'src/app/api/staff/integrations/onec/brand-groups/route.ts': ['scanGroups'],
  'src/app/api/staff/integrations/onec/warehouses/route.ts': ['scanWarehouses'],
}
const STATUS_MODULE = '@/lib/integrations/onec/status'
const CLIENT_HARDCODE = [/(===?|!==?)\s*['"`]westside['"`]/i, /['"`]westside['"`]\s*(===?|!==?)/i]
const PROVIDER_MODULE = /(?:^|\/)(moysklad|onec|one-c|1c)(?:\/|$)/i

export function checkBoundaries(root) {
  const violations = []
  const src = path.join(root, 'src')
  if (!fs.existsSync(src)) return ['boundary-check: src/ not found']
  function scan(file) {
    const rel = path.relative(root, file).split(path.sep).join('/')
    const text = fs.readFileSync(file, 'utf8')
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const inAdapterLayer = rel.startsWith('src/lib/integrations/')
    const report = (node, message) => violations.push(rel + ':' + (source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1) + '  ' + message)
    text.split(/\r?\n/).forEach((line, i) => {
      if (CLIENT_HARDCODE.some(pattern => pattern.test(line))) violations.push(rel + ':' + (i + 1) + '  client-name hardcode in logic → ' + line.trim())
    })
    function visit(node) {
      let specifier
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier
      else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) specifier = node.moduleReference.expression
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal
      else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) specifier = node.arguments[0]
      if (specifier && (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier)) && !inAdapterLayer) {
        const module = specifier.text.replaceAll('\\', '/')
        if (PROVIDER_MODULE.test(module)) {
          const bindings = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : undefined
          const names = bindings && ts.isNamedImports(bindings) ? bindings.elements.map(item => (item.propertyName ?? item.name).text) : []
          const allowed = ADAPTER_IMPORTS[rel]
          const exception = allowed && module === STATUS_MODULE && ts.isImportDeclaration(node)
            && !node.importClause?.name && names.length > 0 && names.every(name => allowed.includes(name))
          if (!exception) report(node, 'provider-specific import outside adapter layer → ' + module)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { if (!['node_modules', '.next'].includes(entry.name)) walk(full) }
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) scan(full)
    }
  }
  walk(src)
  return violations
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const violations = checkBoundaries(process.cwd())
  if (violations.length) { console.error('Commerce boundary check FAILED:\n' + violations.join('\n')); process.exitCode = 1 }
  else console.log('Commerce boundary check PASSED (three exact diagnostic adapter imports permitted)')
}
