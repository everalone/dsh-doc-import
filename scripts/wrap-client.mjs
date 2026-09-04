/**
 * Wrap the esbuild-bundled client body into the `window.__ModuleLoader__.load`
 * envelope the dsh web shell expects (the format official tsdown-built client
 * bundles use: CJS factory receiving `require` for the loader-registered
 * modules — react / react/jsx-runtime — and a sourceMappingURL trailer whose
 * `.map` sibling the client-modules combo reads).
 *
 * The bundle body is produced by scripts/build-client.mjs into lib/client.body.js.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = resolve(repoRoot, 'packages/dsh-doc-import')
const bodyPath = join(pkgDir, 'lib', 'client.body.js')
const outPath = join(pkgDir, 'lib', 'client.js')
const body = readFileSync(bodyPath, 'utf8')

const wrapped = [
  'window.__ModuleLoader__.load({',
  '\tid: "dsh-doc-import",',
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  body,
  '\t\treturn module.exports;',
  '\t}',
  '});',
  '//# sourceMappingURL=client.js.map',
  '',
].join('\n')

writeFileSync(outPath, wrapped)
console.log(`[wrap-client] wrote ${outPath} (${Buffer.byteLength(wrapped)} bytes)`)
