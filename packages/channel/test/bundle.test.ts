import { loadOrCreateIdentity, nowSeconds, openStore, setProfile } from '@agentbridge/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const bundle = join(root, 'plugins/agentbridge/dist/server.js')

beforeAll(() => {
  execFileSync('node', ['scripts/build.mjs'], { cwd: root, stdio: 'pipe' })
})

describe('plugin bundle', () => {
  it('starts over stdio with no repository dependencies and lists the reply tool', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ab-bundle-'))
    await loadOrCreateIdentity(home)
    const store = await openStore(home)
    // A valid relay address that can never resolve (RFC 6761), so this smoke test stays offline.
    setProfile(store, { name: 'Prueba', relays: ['wss://relay.invalid'], now: nowSeconds() })
    store.close()
    const transport = new StdioClientTransport({
      command: 'node',
      args: [bundle],
      cwd: tmpdir(),
      env: { ...(process.env as Record<string, string>), AGENTBRIDGE_HOME: home },
      stderr: 'pipe',
    })
    const client = new Client({ name: 'smoke', version: '0.0.0' })
    await client.connect(transport)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['reply'])
    expect(client.getServerCapabilities()?.experimental?.['claude/channel']).toEqual({})
    await client.close()
  })

  it('exits with a clear message when this computer has no identity yet', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ab-empty-'))
    let stderr = ''
    try {
      execFileSync('node', [bundle], { env: { ...process.env, AGENTBRIDGE_HOME: home }, stdio: 'pipe', timeout: 5000 })
    } catch (err) {
      stderr = String((err as { stderr?: Buffer }).stderr)
    }
    expect(stderr).toContain('setup')
  })
})
