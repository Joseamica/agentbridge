import { describe, expect, it } from 'vitest'
import { memoryOutput, type CliContext } from '../src/context'
import { USAGE, run, runWith, type Command } from '../src/router'

const ctx = (): CliContext & { out: ReturnType<typeof memoryOutput> } =>
  ({ home: '/tmp/agentbridge-does-not-exist', out: memoryOutput(), env: {} }) as CliContext & { out: ReturnType<typeof memoryOutput> }

describe('the command table', () => {
  it('lists every 0.2 command and none of the 0.1 ones', async () => {
    for (const name of ['setup', 'setup-responder', 'doctor', 'link', 'connect', 'contacts', 'whoami', 'requests', 'approve', 'reject', 'revoke', 'ask', 'ticket', 'mcp']) {
      expect(USAGE).toContain(name)
    }
    for (const gone of ['enroll', 'invite', 'accept', 'admin', 'AGENTBRIDGE_RELAY_URL', 'AGENTBRIDGE_ADMIN_TOKEN']) {
      expect(USAGE).not.toContain(gone)
    }
  })

  it('refuses a deleted command with the help text and exit code 1', async () => {
    const c = ctx()
    expect(await run(['enroll', 'algo'], c)).toBe(1)
    expect(c.out.errors.join('\n')).toContain('Comando desconocido')
  })

  it('prints the help text with exit code 0', async () => {
    const c = ctx()
    expect(await run([], c)).toBe(0)
    expect(c.out.lines.join('\n')).toBe(USAGE)
  })

  it('turns a missing identity into a Spanish error and exit code 1, not a stack trace', async () => {
    const c = ctx()
    expect(await run(['contacts'], c)).toBe(1)
    expect(c.out.errors.join('\n')).toMatch(/setup/)
  })

  it('never prints the text of an unexpected error', async () => {
    const c = ctx()
    const boom = Object.assign(new Error('/Users/alguien/carpeta compartida: CANARIO'), { code: 'EACCES' })
    const failing: Record<string, Command> = { boom: async () => { throw boom } }
    expect(await runWith(failing, ['boom'], c)).toBe(2)
    const printed = [...c.out.lines, ...c.out.errors].join('\n')
    expect(printed).not.toContain('CANARIO')
    expect(printed).not.toContain('carpeta compartida')
  })
})
