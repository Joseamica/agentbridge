// Assembles a self-contained, publishable copy of AgentBridge into dist/pack.
//
// The root package.json is `private: true` and a workspaces root, so it cannot be published,
// and packages/cli cannot either because its package.json depends on the @agentbridge/core
// workspace via `"@agentbridge/core": "*"`. Both the CLI and the channel plugin are already
// bundled into self-contained ESM by esbuild (scripts/build.mjs), so nothing here needs a
// node_modules or a `dependencies` field of its own — this script just gathers the two
// bundles, the plugin manifests, and a fresh package.json into one directory that `npm pack`
// (or `npm publish`) can run against directly.
//
// The plugins/ and .claude-plugin/ layout below is deliberately identical to the repo root's
// own layout: packages/cli/src/commands/setup-responder.ts's defaultRepoDir() walks up from
// wherever it is actually running looking for plugins/agentbridge/dist/server.js, so an
// installed package only resolves its own plugin bundle if that relative layout matches what
// a from-source checkout has.
import { spawnSync } from 'node:child_process'
import { access, chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'dist/pack')

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

// Rebuild both esbuild bundles first, so the assembled package always reflects current
// source rather than a dist/ left over from an earlier, possibly stale, build.
const build = spawnSync(process.execPath, [join(repoRoot, 'scripts/build.mjs')], { cwd: repoRoot, stdio: 'inherit' })
if (build.status !== 0) {
  console.error('scripts/build.mjs failed; aborting pack.')
  process.exit(build.status ?? 1)
}

const cliBundle = join(repoRoot, 'packages/cli/dist/main.js')
const pluginBundle = join(repoRoot, 'plugins/agentbridge/dist/server.js')
for (const bundle of [cliBundle, pluginBundle]) {
  if (!(await exists(bundle))) {
    console.error(`Expected build output missing: ${bundle}`)
    process.exit(1)
  }
}

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

// bin/ — the CLI bundle, published as the `agentbridge` executable.
await mkdir(join(outDir, 'bin'), { recursive: true })
await cp(cliBundle, join(outDir, 'bin/agentbridge.js'))
await chmod(join(outDir, 'bin/agentbridge.js'), 0o755)

// plugins/agentbridge — the Claude Code channel plugin: bundle, manifest, and MCP wiring.
await mkdir(join(outDir, 'plugins/agentbridge/dist'), { recursive: true })
await cp(pluginBundle, join(outDir, 'plugins/agentbridge/dist/server.js'))
await mkdir(join(outDir, 'plugins/agentbridge/.claude-plugin'), { recursive: true })
await cp(
  join(repoRoot, 'plugins/agentbridge/.claude-plugin/plugin.json'),
  join(outDir, 'plugins/agentbridge/.claude-plugin/plugin.json'),
)
await cp(join(repoRoot, 'plugins/agentbridge/.mcp.json'), join(outDir, 'plugins/agentbridge/.mcp.json'))

// .claude-plugin/marketplace.json at the package root — what `claude plugin marketplace add
// <repoDir>` needs to find the plugin above.
await mkdir(join(outDir, '.claude-plugin'), { recursive: true })
await cp(join(repoRoot, '.claude-plugin/marketplace.json'), join(outDir, '.claude-plugin/marketplace.json'))

await cp(join(repoRoot, 'README.md'), join(outDir, 'README.md'))
await cp(join(repoRoot, 'LICENSE'), join(outDir, 'LICENSE'))

// Single source of truth for the published version: the plugin manifest's own version, so
// this never drifts from what the plugin itself reports.
const pluginManifest = JSON.parse(await readFile(join(repoRoot, 'plugins/agentbridge/.claude-plugin/plugin.json'), 'utf8'))

const pkg = {
  name: '@joseamica/agentbridge',
  version: pluginManifest.version,
  description:
    "Ask another person's coding agent a question, with their explicit revocable permission, from a single CLI or from inside your own Claude Code.",
  license: 'MIT',
  repository: { type: 'git', url: 'git+https://github.com/Joseamica/agentbridge.git' },
  homepage: 'https://github.com/Joseamica/agentbridge#readme',
  bugs: { url: 'https://github.com/Joseamica/agentbridge/issues' },
  keywords: ['agentbridge', 'claude-code', 'cli', 'mcp', 'agent', 'relay'],
  engines: { node: '>=22.4' },
  type: 'module',
  bin: { agentbridge: 'bin/agentbridge.js' },
  files: ['bin', 'plugins', '.claude-plugin', 'README.md', 'LICENSE'],
}
await writeFile(join(outDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)

console.log(`Publishable package assembled at ${outDir}`)
