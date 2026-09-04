/**
 * Symlink the core DeepSeek Harness packages (cordis, dsh-tools, dsh-home-paths,
 * dsh-credentials) from the local dsh profile's node_modules into this
 * workspace's node_modules, so the linked plugin resolves the SAME instances
 * the host process uses (the host links this plugin into
 * ~/.dsh/profiles/node_modules and Node resolves through the realpath, i.e.
 * this workspace tree).
 *
 * Run once after clone / profile update:
 *   node scripts/link-core.mjs
 */
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const CORE_PACKAGES = [
  'cordis',
  'dsh-tools',
  'dsh-home-paths',
  'dsh-credentials',
  'dsh-settings',
  'dsh-llm',
]

const profileHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileCore = join(profileHome, 'profiles', 'node_modules', '@deepseek-ai')
const target = resolve(process.cwd(), 'node_modules', '@deepseek-ai')

if (!existsSync(profileCore)) {
  console.error(`[link-core] profile core dir not found: ${profileCore}`)
  console.error('[link-core] is dsh installed? expected DSH_HOME/profiles/node_modules/@deepseek-ai')
  process.exit(1)
}

mkdirSync(target, { recursive: true })
for (const pkg of CORE_PACKAGES) {
  const dest = join(target, pkg)
  if (existsSync(dest)) {
    console.log(`[link-core] exists: ${pkg}`)
    continue
  }
  const src = join(profileCore, pkg)
  if (!existsSync(src)) {
    console.warn(`[link-core] missing in profile, skipped: ${pkg}`)
    continue
  }
  try {
    symlinkSync(src, dest, 'junction')
    console.log(`[link-core] linked: ${pkg}`)
  } catch (error) {
    console.warn(`[link-core] failed to link ${pkg}: ${error.message}`)
  }
}
