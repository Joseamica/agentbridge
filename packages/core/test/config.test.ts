import { join } from 'node:path'
import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { agentbridgeHome } from '../src/config'

describe('agentbridgeHome', () => {
  it('defaults to ~/.agentbridge', () => {
    expect(agentbridgeHome({})).toBe(join(homedir(), '.agentbridge'))
  })

  it('honors AGENTBRIDGE_HOME', () => {
    expect(agentbridgeHome({ AGENTBRIDGE_HOME: '/tmp/ab' })).toBe('/tmp/ab')
  })
})
