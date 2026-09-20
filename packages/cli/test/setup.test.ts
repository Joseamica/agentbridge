import { decodeLink, loadIdentity, loadOrCreateIdentity, openStore, setProfile } from '@agentbridge/core'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { plainSocketFactory, startFakeBoard, type FakeBoard } from '../../core/test/support/fake-board'
import { runSetup, type SetupContext } from '../src/commands/setup'
import { memoryOutput, PromptEOF } from '../src/context'

const allowAnyRelay = (inputs: readonly unknown[]): string[] => inputs.filter((x): x is string => typeof x === 'string').slice(0, 5)

let root: string
let identityHome: string
let profileHome: string
let shareDir: string
let repoDir: string
let board: FakeBoard
const cleanups: Array<() => Promise<void> | void> = []

function scripted(answers: string[]) {
  const queue = [...answers]
  const asked: string[] = []
  const prompt = async (question: string) => {
    asked.push(question)
    const next = queue.shift()
    if (next === undefined) throw new PromptEOF()
    return next
  }
  // A leftover answer means the flow asked fewer questions than the test assumed, so the test is
  // exercising a different path than its name claims.
  const expectDrained = () => expect(queue).toEqual([])
  return { prompt, asked, expectDrained }
}

const noopRunner = async () => ({ code: 0, stdout: '', stderr: '' })

function context(o: Partial<SetupContext> & { prompt: SetupContext['prompt'] }): SetupContext {
  return {
    home: identityHome,
    out: memoryOutput(),
    env: process.env,
    run: noopRunner,
    relayPolicy: allowAnyRelay,
    createSocket: plainSocketFactory,
    repoDir,
    profileHome,
    ...o,
  } as SetupContext
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ab-setup-'))
  identityHome = join(root, 'identidad')
  profileHome = join(root, 'perfil')
  shareDir = join(root, 'compartido')
  repoDir = join(root, 'repo')
  await mkdir(join(repoDir, 'plugins/agentbridge/dist'), { recursive: true })
  await writeFile(join(repoDir, 'plugins/agentbridge/dist/server.js'), '// bundle')
  board = await startFakeBoard()
  cleanups.push(() => board.close())
})

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function seedIdentityAndProfile(): Promise<void> {
  await loadOrCreateIdentity(identityHome)
  const store = await openStore(identityHome, { relayPolicy: allowAnyRelay })
  setProfile(store, { name: 'Ana', relays: [board.url], now: 1_700_000_000 })
  store.close()
}

describe('the identity step', () => {
  it('creates the key, asks for a name once, and keeps the same key on a second run', async () => {
    const out = memoryOutput()
    const first = scripted(['Ana', '2', 'n', 'n'])
    await runSetup(context({ prompt: first.prompt, out }))
    first.expectDrained()
    const created = await loadIdentity(identityHome)
    expect(created).not.toBeNull()

    // The second run must not replace the key: a new one would silently orphan every permission
    // this person already has, and nobody would connect them again without being asked.
    const second = scripted(['2', 'n', 'n'])
    await runSetup(context({ prompt: second.prompt, out: memoryOutput() }))
    second.expectDrained()
    expect((await loadIdentity(identityHome))?.publicKey).toBe(created?.publicKey)
    // And it did not ask for the name again.
    expect(second.asked.some((q) => q.includes('nombre'))).toBe(false)
  })

  it("prints this person's own link, and it decodes to their own key", async () => {
    const out = memoryOutput()
    const { prompt, expectDrained } = scripted(['Ana', '2', 'n', 'n'])
    await runSetup(context({ prompt, out }))
    expectDrained()
    const printed = out.lines.flatMap((line) => line.match(/agentbridge:nprofile1[0-9a-z]+/g) ?? [])
    expect(printed.length).toBeGreaterThan(0)
    const identity = await loadIdentity(identityHome)
    expect(decodeLink(printed[0]!).publicKey).toBe(identity?.publicKey)
  })

  it('refuses a name longer than the profile allows, and asks again', async () => {
    const out = memoryOutput()
    const { prompt, expectDrained } = scripted(['x'.repeat(81), 'Ana', '2', 'n', 'n'])
    await runSetup(context({ prompt, out }))
    expectDrained()
    const store = await openStore(identityHome, { relayPolicy: allowAnyRelay })
    const { getProfile } = await import('@agentbridge/core')
    expect(getProfile(store).name).toBe('Ana')
    store.close()
  })
})

describe('the asking side', () => {
  it('connects with the link the person pastes', async () => {
    await seedIdentityAndProfile()
    const links: string[] = []
    const { prompt, expectDrained } = scripted(['2', 's', 'agentbridge:nprofile1ejemplo', 'n'])
    await runSetup(context({ prompt, connectWith: async (link: string) => void links.push(link) }))
    expectDrained()
    expect(links).toEqual(['agentbridge:nprofile1ejemplo'])
  })

  it('says what to do later when the person does not have a link yet', async () => {
    await seedIdentityAndProfile()
    const out = memoryOutput()
    const { prompt, expectDrained } = scripted(['2', 'n', 'n'])
    await runSetup(context({ prompt, out }))
    expectDrained()
    const text = out.lines.join('\n')
    // Every instruction is copy-pasteable: never a bare command name.
    expect(text).toContain('connect')
    expect(text).not.toMatch(/^\s*connect\b/m)
  })

  it('registers the MCP server when asked to', async () => {
    await seedIdentityAndProfile()
    const calls: string[][] = []
    const { prompt, expectDrained } = scripted(['2', 'n', 's'])
    await runSetup(
      context({
        prompt,
        run: async (command, args) => {
          calls.push([command, ...args])
          return { code: 0, stdout: '', stderr: '' }
        },
      }),
    )
    expectDrained()
    expect(calls.some((c) => c[0] === 'claude' && c.includes('mcp') && c.includes('add'))).toBe(true)
  })
})

describe('the answering side', () => {
  it('prepares the shared folder and the dedicated profile, and never writes AgentBridge state into it', async () => {
    await seedIdentityAndProfile()
    const { prompt, expectDrained } = scripted(['1', shareDir, ''])
    await runSetup(context({ prompt }))
    expectDrained()
    await expect(access(join(profileHome, 'start.sh'))).resolves.toBeUndefined()
    await expect(access(join(shareDir, 'CLAUDE.md'))).resolves.toBeUndefined()
    // Q1: the dedicated folder is Claude's profile, not a second AgentBridge home.
    await expect(access(join(profileHome, 'identity.json'))).rejects.toThrow()
    await expect(access(join(profileHome, 'agentbridge.db'))).rejects.toThrow()
    expect(await readFile(join(profileHome, 'start.sh'), 'utf8')).toContain(`export AGENTBRIDGE_HOME='${identityHome}'`)
  })

  it('refuses a shared folder that would contain the identity', async () => {
    await seedIdentityAndProfile()
    const { prompt } = scripted(['1', root, ''])
    await expect(runSetup(context({ prompt }))).rejects.toThrow(/llave|identidad/i)
  })

  it("tells the person to give their link to whoever will ask them", async () => {
    await seedIdentityAndProfile()
    const out = memoryOutput()
    const { prompt, expectDrained } = scripted(['1', shareDir, ''])
    await runSetup(context({ prompt, out }))
    expectDrained()
    const text = out.lines.join('\n')
    expect(text).toMatch(/agentbridge:nprofile1/)
    expect(text).toMatch(/dáselo|pásaselo|mándaselo/i)
  })

  it("lists doctor's failing checks as pending work instead of claiming it is done", async () => {
    await seedIdentityAndProfile()
    const out = memoryOutput()
    // A real diagnostic failure, not a crash: the bundle exists (so setupResponder completes) and
    // the board refuses reads, so doctor's own board check fails and the summary has to say so.
    board.options = { ...board.options, rejectReads: true }
    const { prompt, expectDrained } = scripted(['1', shareDir, ''])
    await runSetup(context({ prompt, out }))
    expectDrained()
    const text = out.lines.join('\n')
    // Searching the whole output would pass on the "[falta] Tablero …" line doctor prints on its
    // own. What this test is about is the summary: the failing check has to be repeated under
    // "Pendiente:", where the person looks for what is left to do.
    const summary = text.slice(text.indexOf('Pendiente:'))
    expect(summary).toMatch(/Tablero/)
  })
})
