/**
 * Bundle the browser half with esbuild: relative imports inlined, react /
 * react/jsx-runtime externalized (the shell's ModuleLoader provides them at
 * runtime, same as the official client bundles). Emits a CJS body plus an
 * external source map; wrap-client.mjs seals them into the ModuleLoader
 * envelope via the onEnd hook (runs in build and watch modes).
 */
import { resolve, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = resolve(repoRoot, 'packages/dsh-doc-import')
const pkgRequire = createRequire(resolve(pkgDir, 'package.json'))
const esbuild = pkgRequire('esbuild')
const { build, context } = esbuild
const watch = process.argv.includes('--watch')

function wrap() {
  const result = spawnSync(process.execPath, [resolve(repoRoot, 'scripts/wrap-client.mjs')], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const wrapPlugin = {
  name: 'wrap-client',
  setup(buildApi) {
    buildApi.onEnd(() => wrap())
  },
}

const options = {
  entryPoints: [resolve(pkgDir, 'src/client/index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['react', 'react/jsx-runtime'],
  outfile: resolve(pkgDir, 'lib/client.body.js'),
  sourcemap: 'external',
  logLevel: 'warning',
  minify: false,
  plugins: [wrapPlugin],
}

if (watch) {
  const ctx = await context(options)
  await ctx.watch()
  console.log('[build-client] watching src/client … (Ctrl+C to stop)')
} else {
  await build(options)
  console.log('[build-client] bundled lib/client.body.js')
}
