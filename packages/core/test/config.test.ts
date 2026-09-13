import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentbridgeHome, readConfig, writeConfig } from '@agentbridge/core'

describe('client config', () => {
  it('uses AGENTBRIDGE_HOME when set', () => {
    expect(agentbridgeHome({ AGENTBRIDGE_HOME: '/tmp/ab-x' })).toBe('/tmp/ab-x')
  })

  it('returns null when there is no config yet', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ab-'))
    expect(await readConfig(home)).toBeNull()
  })

  it('writes the config with private permissions and reads it back', async () => {
    const home = join(await mkdtemp(join(tmpdir(), 'ab-')), 'nested')
    const cfg = { relayUrl: 'https://r.example.com', deviceToken: 't'.repeat(43), handle: 'amieva', displayName: 'Amieva' }
    const file = await writeConfig(cfg, home)
    expect(await readConfig(home)).toEqual(cfg)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await stat(home)).mode & 0o777).toBe(0o700)
  })
})
