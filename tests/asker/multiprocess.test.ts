import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  applyApproval,
  createOutboundQuestion,
  createOutboundRequest,
  getOutboundQuestion,
  listOutboundQuestions,
  loadOrCreateIdentity,
  nowSeconds,
  openStore,
  setProfile,
} from '@agentbridge/core'
import { startFakeBoard, testIdentity, until, type Cleanups } from '../responder/support'
import { startAsker } from './support'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
// scripts/build.mjs writes the CLI bundle here (the channel's bundle is the one under plugins/).
const cli = join(root, 'packages', 'cli', 'dist', 'main.js')
const ana = testIdentity(76)
const beto = testIdentity(77)
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

const cleanups: Cleanups = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

beforeAll(() => {
  // The CLI bundle is what a person actually runs; building it here keeps the test honest.
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'pipe' })
}, 120_000)

// `board` here is anything with a url: a real fake board for the in-process test, or
// `wss://relay.invalid` for the ones that spawn a process (which cannot reach a local ws:// board).
//
// The policy matters: `setProfile` and `createOutboundRequest` both run the relays through it, and
// the production one refuses `ws://`. A home seeded for the in-process board therefore has to be
// opened with the permissive policy; a home seeded for a child process must NOT be, because the
// child opens it with the production policy and has to find usable relays there.
const allowAnyRelay = (inputs: readonly unknown[]): string[] =>
  inputs.filter((value): value is string => typeof value === 'string' && value.startsWith('ws')).slice(0, 5)

async function seedHome(board: { url: string }): Promise<string> {
  const home = join(await mkdtemp(join(tmpdir(), 'ab-multi-')), 'home')
  const local = board.url.startsWith('ws://')
  const store = await openStore(home, local ? { relayPolicy: allowAnyRelay } : {})
  setProfile(store, { name: 'Beto', relays: [board.url], now: nowSeconds() })
  createOutboundRequest(store, { pubkey: ana.publicKey, requestId: uuid(1), relays: [board.url], now: nowSeconds() })
  applyApproval(store, { pubkey: ana.publicKey, requestId: uuid(1), generation: 1, name: 'Ana', relays: [board.url], now: nowSeconds() })
  store.close()
  await writeFile(join(home, 'identity.json'), JSON.stringify({ version: 1, secretKey: Buffer.from(beto.secretKey).toString('hex') }), { mode: 0o600 })
  return home
}

// Runs a command as a real child process *without* blocking this one. `execFileSync` would freeze
// the event loop of the process that hosts the fake board, so nothing could answer the child — the
// test would prove the opposite of concurrency.
function runCli(args: string[], home: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      env: { ...process.env, AGENTBRIDGE_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`the CLI did not finish: ${args.join(' ')}`))
    }, 60_000)
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr })
    })
  })
}

// A spawned CLI or MCP process runs with the production relay policy, which only accepts `wss://`
// (`checkRelayUrl`), and with the default socket factory. It therefore cannot talk to a local
// `ws://` fake board, and nothing in this plan weakens that rule for a test. So the two halves are
// tested where each one is real:
//   • what needs two OS processes (a CLI writing a home a live server is using, an MCP server that
//     must exit on EOF, two identity creations racing) uses real processes and a home whose relay is
//     `wss://relay.invalid` — never reachable, which is exactly what those assertions need;
//   • what needs a relay (one publication, no claim left behind) uses two services in one process
//     against a fake board, which is a real test of the store, the claim and the publisher.
describe('a CLI process writes a home that a live asker is using', () => {
  it('stores the question the CLI created, and the live side ends up owning no claim', async () => {
    const home = await seedHome({ url: 'wss://relay.invalid' })
    const live = await startAsker({ identity: beto, relays: ['wss://relay.invalid'], cleanups, home })
    live.service.start()

    const { code } = await runCli(['ask', 'ana', '¿quién publica esto?', '--no-wait'], home)
    expect(code).toBe(0)

    const store = await openStore(home)
    cleanups.push(async () => store.close())
    const asked = listOutboundQuestions(store)[0]!
    expect(asked.text).toBe('¿quién publica esto?')
    // Nothing can be published to a relay that does not exist, so it stays `sending` — and neither
    // process leaves a claim behind once its round ends.
    expect(asked.state).toBe('sending')
    await until(() => (store.db.prepare('SELECT count(*) AS n FROM outbox WHERE claimed_by IS NOT NULL').get() as { n: number }).n === 0, 30_000, 'both processes to release their claims')
  }, 120_000)
})

describe('two askers on one home and one board', () => {
  it('publish the question exactly once between them, and both see it as sent', async () => {
    const board = await startFakeBoard()
    cleanups.push(() => board.close())
    const home = await seedHome(board)

    // Two services over the same home, the way the MCP server and a CLI command share it: one
    // persistent, one running a single sync.
    const persistent = await startAsker({ identity: beto, relays: [board.url], cleanups, home })
    persistent.service.start()
    const oneShot = await startAsker({ identity: beto, relays: [board.url], cleanups, home })

    const question = await oneShot.service.ask('ana', '¿quién publica esto?')
    await Promise.all([oneShot.sync(), persistent.service.sync()])

    const wraps = () => board.events.filter((event) => event.kind === 1059).length
    await until(() => wraps() >= 1, 30_000, 'the question to reach the board')
    // Exactly one: the claim is what stops both from publishing it, and the first retry is five
    // minutes away, so a second wrap here would mean the claim failed.
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    expect(wraps()).toBe(1)

    // Nobody had to be told: the publisher's hook promotes it (P1), and no claim is left behind.
    await until(() => getOutboundQuestion(oneShot.store, ana.publicKey, question.questionId)?.state === 'sent', 30_000, 'the question to be marked sent')
    expect(oneShot.store.db.prepare('SELECT count(*) AS n FROM outbox WHERE claimed_by IS NOT NULL').get()).toMatchObject({ n: 0 })
  }, 120_000)
})

describe('two identity creations at once', () => {
  it('ends with exactly one identity, from two separate processes', async () => {
    const home = join(await mkdtemp(join(tmpdir(), 'ab-identity-race-')), 'home')
    // Two real processes, started together: one wins the link(2) that creates identity.json and the
    // other finds it. Doing this in one process would prove nothing about the file-level race.
    // Written to a real .mts file rather than passed to `tsx --eval`: an --eval script is treated as
    // CommonJS, where top-level await is a syntax error.
    const scriptPath = join(await mkdtemp(join(tmpdir(), 'ab-identity-script-')), 'create.mts')
    await writeFile(
      scriptPath,
      [
        `import { loadOrCreateIdentity } from ${JSON.stringify(join(root, 'packages/core/src/identity.ts'))}`,
        'const { identity, created } = await loadOrCreateIdentity(process.argv[2])',
        'process.stdout.write(JSON.stringify({ publicKey: identity.publicKey, created }))',
      ].join('\n'),
    )
    const run = () =>
      new Promise<{ publicKey: string; created: boolean }>((resolve, reject) => {
        const child = spawn('npx', ['tsx', scriptPath, home], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        let err = ''
        child.stdout.on('data', (chunk) => {
          out += String(chunk)
        })
        child.stderr.on('data', (chunk) => {
          err += String(chunk)
        })
        child.once('error', reject)
        child.once('exit', (code) => (code === 0 ? resolve(JSON.parse(out) as { publicKey: string; created: boolean }) : reject(new Error(err))))
      })
    const both = await Promise.all([run(), run()])
    expect(both[0]!.publicKey).toBe(both[1]!.publicKey)
    expect(both.filter((one) => one.created)).toHaveLength(1)
  }, 120_000)
})

describe('the MCP server', () => {
  it('exits when its stdin closes, instead of waiting for a close that never comes', async () => {
    // `wss://relay.invalid` never resolves, so this exercises the shutdown path without needing a
    // board a spawned process could not reach anyway.
    const home = await seedHome({ url: 'wss://relay.invalid' })

    const child = spawn(process.execPath, [cli, 'mcp'], {
      cwd: root,
      env: { ...process.env, AGENTBRIDGE_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    cleanups.push(async () => {
      if (child.exitCode === null) child.kill('SIGKILL')
    })

    // Give it time to start and to try its relays, then close the pipe.
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    child.stdin.end()

    const exited = await Promise.race([
      new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000)),
    ])
    expect(exited).toBe(true)
  }, 90_000)
})

describe('a command always ends', () => {
  it('finishes even when its relays never answer', async () => {
    // A spawned process cannot reach a local ws:// board (production policy), so the unreachable
    // case is the honest one here: `wss://relay.invalid` never resolves. The "connects and then
    // says nothing" case is covered in-process by Task 5's device test, which can inject a board.
    const home = await seedHome({ url: 'wss://relay.invalid' })

    const started = Date.now()
    const { code, stderr } = await runCli(['contacts'], home)
    expect(code).toBe(0)
    // Two syncs of at most 10 s each, plus a cold Node start: 40 s is the contractual budget plus a
    // generous margin, and tight enough to fail if a sync ever waits for a pool timeout instead of
    // its own deadline.
    expect(Date.now() - started).toBeLessThan(40_000)
    // …and it printed the listing rather than failing early for some unrelated reason.
    expect(stderr).toBe('')
  }, 120_000)
})

// Not in the brief: Task 10's review found that AskerService.waitForAnswer calls device.start(), so
// a plain `ask --wait` runs the same live subscription, retry, history and purge timers the MCP
// server runs (P5's persistent machinery), for up to the person's own --wait budget. That was
// accepted deliberately, on the condition that this task prove the two coexist on one home: a real
// MCP server process (persistent) and a real `ask --wait` CLI process (short-lived, but running the
// same background machinery for its own duration) hitting the same sqlite file from two separate OS
// processes at once.
//
// Same relay constraint as every other spawned-process test in this file: a spawned process cannot
// reach a local ws:// fake board (the production relay policy only accepts wss://), so both
// processes share `wss://relay.invalid`, which never resolves. This is therefore a test of the
// store, the claim and the two processes' lifecycles under real concurrent writes — not of a
// successful publish, which the in-process "two askers on one home and one board" test above already
// covers against a real board.
//
// A SQLITE_BUSY here is expected under this contention and must be survived, not avoided: Task 6's
// review found that a single rejected sync used to poison AskerService forever (a rejected `.then()`
// chain never runs again), and two real processes running device.start()'s full timer set
// (publisher every 5 s, history and purge on start) against one WAL file is exactly the load that
// would have caught it. Nothing here serializes the two processes on purpose.
describe('an MCP server and a CLI ask --wait on the same home', () => {
  it('neither loses the question nor corrupts the other, and both end cleanly', async () => {
    const home = await seedHome({ url: 'wss://relay.invalid' })

    const mcp = spawn(process.execPath, [cli, 'mcp'], {
      cwd: root,
      env: { ...process.env, AGENTBRIDGE_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let mcpStderr = ''
    mcp.stderr.on('data', (chunk) => {
      mcpStderr += String(chunk)
    })
    cleanups.push(async () => {
      if (mcp.exitCode === null) mcp.kill('SIGKILL')
    })

    // No pause here on purpose: "at the same time" means both processes' cold start (each opening
    // the store and each immediately running its own purge() and wakePublisher()) overlaps too, not
    // just their later timers — the highest-contention moment for two processes sharing one home.
    //
    // --wait (not --no-wait) is the point: only a positive wait makes waitForAnswer call
    // device.start(), which is the exact code path Task 10's review flagged. The relay never
    // answers, so this runs the full --wait budget with both processes' timers live at once.
    const { code, stderr } = await runCli(['ask', 'ana', '¿siguen sincronizados los dos procesos?', '--wait', '8'], home)
    expect(code).toBe(0)
    // The CLI's own AskerService is built without a `log` callback (see asker/session.ts), so any
    // internal failure it absorbed (a SQLITE_BUSY included) produces no stderr of its own — only an
    // escaped, uncaught error would print here, through router.ts's own outer catch.
    expect(stderr).toBe('')

    mcp.stdin.end()
    const mcpExited = await Promise.race([
      new Promise<boolean>((resolve) => mcp.once('exit', () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000)),
    ])
    expect(mcpExited).toBe(true)
    // The MCP server's own Device *is* given a log callback (mcp-asker.ts), so a caught SQLITE_BUSY
    // would appear here as a `[agentbridge] publishing failed (...)` line rather than as a crash —
    // that is the "survived, not avoided" outcome this test allows, so this is a diagnostic capture,
    // not an assertion: an uncaught crash would instead have failed the `mcpExited` check above, or
    // left a claim behind in the assertions that follow.
    void mcpStderr

    const store = await openStore(home)
    cleanups.push(async () => store.close())
    const questions = listOutboundQuestions(store)
    // Stored once: only the CLI process ever calls createOutboundQuestion, but this also rules out
    // any corruption that would have produced a partial or duplicated row under contention.
    expect(questions).toHaveLength(1)
    expect(questions[0]!.text).toBe('¿siguen sincronizados los dos procesos?')
    // No relay exists to accept the wrap, so it stays `sending` — the same honest state as the first
    // scenario in this file.
    expect(questions[0]!.state).toBe('sending')
    // Whatever contention the two processes' publishers and purges ran into, neither ends holding
    // the other's claim.
    await until(
      () => (store.db.prepare('SELECT count(*) AS n FROM outbox WHERE claimed_by IS NOT NULL').get() as { n: number }).n === 0,
      10_000,
      'both processes to release their claims',
    )
  }, 120_000)
})
