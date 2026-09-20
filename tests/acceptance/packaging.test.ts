import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = join(import.meta.dirname, '../..')
const packDir = join(repoRoot, 'dist/pack')

// One assembly for the whole file: `npm run pack` rebuilds both esbuild bundles, so doing it per
// test would triple a slow step for no extra coverage.
function assemble(): void {
  const result = spawnSync(process.execPath, [join(repoRoot, 'scripts/pack.mjs')], { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`pack failed: ${result.stderr || result.stdout}`)
}

describe('the publishable package', () => {
  it('declares 0.2.0, the supported Node floor and the files it ships', async () => {
    assemble()
    const pkg = JSON.parse(await readFile(join(packDir, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(pkg.version).toBe('0.2.0')
    expect(pkg.engines).toEqual({ node: '>=22.13' })
    expect(pkg.bin).toEqual({ agentbridge: 'bin/agentbridge.js' })
    expect(pkg.files).toEqual(['bin', 'plugins', '.claude-plugin', 'README.md', 'LICENSE'])
    // 0.2 has no relay of ours. A keyword is what people search by, and this one would promise
    // something the product no longer is.
    expect(pkg.keywords).not.toContain('relay')
  })

  it('ships a CLI that starts and shows the 0.2 commands', async () => {
    assemble()
    const result = spawnSync(process.execPath, [join(packDir, 'bin/agentbridge.js'), '--help'], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    for (const command of ['link', 'connect', 'requests', 'approve', 'reject', 'revoke', 'ask', 'ticket', 'mcp']) {
      expect(result.stdout).toContain(command)
    }
    for (const gone of ['enroll', 'invite', 'accept', 'admin']) {
      expect(result.stdout).not.toContain(gone)
    }
  })

  it('carries the channel plugin where setup-responder looks for it', async () => {
    assemble()
    const manifest = JSON.parse(
      await readFile(join(packDir, 'plugins/agentbridge/.claude-plugin/plugin.json'), 'utf8'),
    ) as { version?: string }
    expect(manifest.version).toBe('0.2.0')
    await expect(readFile(join(packDir, 'plugins/agentbridge/dist/server.js'), 'utf8')).resolves.toContain('agentbridge')
  })
})
