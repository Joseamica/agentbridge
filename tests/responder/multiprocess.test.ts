import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  acquireChannelLock,
  approveConnection,
  currentProcess,
  getChannelLock,
  isProcessAlive,
  loadOrCreateIdentity,
  nowSeconds,
  openStore,
  recordIncomingRequest,
  revokeConnection,
  setProfile,
} from '@agentbridge/core'
import { testIdentity, until } from './support'

const root = resolve(import.meta.dirname, '../..')
const bundle = join(root, 'plugins/agentbridge/dist/server.js')
const coreEntry = JSON.stringify(join(root, 'packages/core/src/index.ts'))
const keysEntry = JSON.stringify(join(root, 'packages/core/test/support/keys.ts'))
const children: ChildProcess[] = []
const clients: Client[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {})
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
})

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'pipe' })
}, 120_000)

async function newHome(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'ab-multi-')), 'home')
}

type Script = { child: ChildProcess; waitFor(prefix: string, ms?: number): Promise<string>; exited: Promise<number | null> }

function runScript(source: string): Script {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
  children.push(child)
  const lines: string[] = []
  let stderr = ''
  createInterface({ input: child.stdout! }).on('line', (line) => lines.push(line))
  child.stderr!.on('data', (chunk) => (stderr += String(chunk)))
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)))
  const waitFor = async (prefix: string, ms = 30_000) => {
    const started = Date.now()
    for (;;) {
      const line = lines.find((l) => l.startsWith(prefix))
      if (line) return line
      if (child.exitCode !== null) throw new Error(`the child exited before printing "${prefix}": ${stderr}`)
      if (Date.now() - started > ms) throw new Error(`timed out waiting for "${prefix}": ${stderr}`)
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  return { child, waitFor, exited }
}

async function startBundledChannel(home: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundle],
    cwd: tmpdir(),
    env: { ...(process.env as Record<string, string>), AGENTBRIDGE_HOME: home },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'fake-claude', version: '0.0.0' })
  await client.connect(transport)
  // Registered for cleanup as soon as the transport is live: a listTools() rejection below must
  // still leave the bundled child reachable by afterEach, not orphaned.
  clients.push(client)
  await client.listTools()
  return client
}

// Seeds an identity plus a profile with a relay address that can never resolve (RFC 6761), so a
// bundled channel started against this home never touches the network.
async function seedHome(home: string): Promise<void> {
  await loadOrCreateIdentity(home)
  const setupStore = await openStore(home)
  setProfile(setupStore, { name: 'Ana', relays: ['wss://relay.invalid'], now: nowSeconds() })
  setupStore.close()
}

describe('responder processes', () => {
  it('refuses a second channel for the same identity, and a graceful SIGTERM shutdown releases the lock', async () => {
    const home = await newHome()
    await seedHome(home)

    const first = await startBundledChannel(home)
    const second = await new Promise<{ code: unknown; stderr: string }>((done) => {
      execFile(process.execPath, [bundle], { env: { ...process.env, AGENTBRIDGE_HOME: home }, timeout: 15_000 }, (err, _stdout, stderr) =>
        done({ code: err ? (err as { code?: unknown }).code : 0, stderr: String(stderr) }),
      )
    })
    expect(second.code).toBe(1)
    expect(second.stderr).toContain('Ya hay otro canal de AgentBridge abierto')
    void first

    const store = await openStore(home)
    try {
      const held = getChannelLock(store)
      if (!held) throw new Error('expected the first channel to hold the lock')
      // A real SIGTERM (not the MCP client closing its own stdio) proves main.ts's own shutdown
      // handler releases the lock: the row is never deleted, so it keeps its epoch and its pid drops
      // to 0.
      process.kill(held.pid, 'SIGTERM')
      // A slower poll: isProcessAlive shells out to `ps`, and the default 25 ms interval would spawn
      // hundreds of them over a 15 s wait for no benefit here.
      await until(() => !isProcessAlive(held), 15_000, 'the first channel to end', 200)
      expect(store.db.prepare('SELECT pid, process_start, epoch FROM channel_lock WHERE id = 1').get()).toEqual({
        pid: 0,
        process_start: '',
        epoch: held.epoch,
      })
    } finally {
      store.close()
    }
    const third = await startBundledChannel(home)
    await third.close()
  }, 120_000)

  it('exits without releasing the lock when fenced by another owner while it is still alive', async () => {
    const home = await newHome()
    await seedHome(home)

    const channel = await startBundledChannel(home)
    // Captured from connect: the dispatcher only ever logs this exact line from its own fence()
    // path, so finding it on stderr (rather than merely finding the process dead) rules out an
    // unrelated startup crash satisfying the same liveness check.
    let stderr = ''
    const transport = channel.transport as StdioClientTransport | undefined
    transport?.stderr?.on('data', (chunk) => (stderr += String(chunk)))
    const store = await openStore(home)
    try {
      const held = getChannelLock(store)
      if (!held) throw new Error('expected the channel to hold the lock')
      const self = currentProcess()
      // The channel is still alive: only a misjudged liveness probe would ever hand its lock away.
      // Force that exact situation (as the suspended-channel test below does) to prove fencing holds
      // even then, and that the channel exits without touching the row a new owner now holds.
      const takeover = acquireChannelLock(store, { self, isAlive: () => false, now: nowSeconds() })
      if (takeover.kind !== 'acquired') throw new Error('expected the test process to take the lock over')
      expect(takeover).toEqual({ kind: 'acquired', epoch: held.epoch + 1, requeued: 0 })

      // Same reasoning as above: a slower poll avoids hundreds of `ps` spawns over the wait.
      await until(() => !isProcessAlive(held), 15_000, 'the fenced channel to exit', 200)

      expect(stderr).toContain('another channel took the lock for this identity; stopping')
      expect(store.db.prepare('SELECT pid, process_start, epoch FROM channel_lock WHERE id = 1').get()).toEqual({
        pid: self.pid,
        process_start: self.start,
        epoch: takeover.epoch,
      })
    } finally {
      store.close()
    }
  }, 60_000)

  it('takes the lock only from an owner that no longer exists, and requeues what it had in flight', async () => {
    const home = await newHome()
    const owner = runScript(`
import { acquireChannelLock, currentProcess, isProcessAlive, nowSeconds, openStore } from ${coreEntry}
const store = await openStore(${JSON.stringify(home)})
const lock = acquireChannelLock(store, { self: currentProcess(), isAlive: isProcessAlive, now: nowSeconds() })
const sender = 'a'.repeat(64)
const now = nowSeconds()
store.db.prepare("INSERT INTO inbox_questions (sender_pubkey, question_id, rumor_id, rumor_created_at, generation, text, state, admitted, received_at, updated_at) VALUES (?, 'q1', ?, ?, 1, 'hola', 'dispatched', 1, ?, ?)").run(sender, 'b'.repeat(64), now, now, now)
store.db.prepare("INSERT INTO attempts (attempt_id, sender_pubkey, question_id, code, epoch, deadline_ms, state, created_at) VALUES ('att', ?, 'q1', 'ABCD', ?, ?, 'active', ?)").run(sender, lock.epoch, Date.now() + 600000, now)
console.log('ready ' + lock.kind + ' ' + lock.epoch)
setInterval(() => {}, 1000)
`)
    expect(await owner.waitFor('ready')).toBe('ready acquired 1')

    const store = await openStore(home)
    try {
      expect(acquireChannelLock(store, { self: currentProcess(), isAlive: isProcessAlive, now: nowSeconds() })).toMatchObject({
        kind: 'held',
        holder: { pid: owner.child.pid, epoch: 1 },
      })
      owner.child.kill('SIGKILL')
      await owner.exited
      expect(acquireChannelLock(store, { self: currentProcess(), isAlive: isProcessAlive, now: nowSeconds() })).toEqual({ kind: 'acquired', epoch: 2, requeued: 1 })
      expect(store.db.prepare("SELECT state FROM inbox_questions WHERE question_id = 'q1'").get()?.state).toBe('queued')
      expect(store.db.prepare("SELECT state, cancel_reason FROM attempts WHERE attempt_id = 'att'").get()).toEqual({ state: 'cancelled', cancel_reason: 'recovered' })
    } finally {
      store.close()
    }
  }, 60_000)

  it('fences a suspended channel that lost the lock: its late answer confirms nothing', async () => {
    const home = await newHome()
    const stale = runScript(`
import { createInterface } from 'node:readline'
import { acquireChannelLock, admitQuestion, answerQuestion, approveRequest, nowSeconds, openStore, recordIncomingRequest, reserveNextQuestion } from ${coreEntry}
import { testIdentity } from ${keysEntry}
const responder = testIdentity(131)
const asker = testIdentity(132)
const store = await openStore(${JSON.stringify(home)})
const now = nowSeconds()
const lock = acquireChannelLock(store, { self: { pid: process.pid, start: 'stale-channel' }, isAlive: () => false, now })
recordIncomingRequest(store, { pubkey: asker.publicKey, requestId: '00000000-0000-4000-8000-000000000001', requestRumorId: 'c'.repeat(64), declaredName: 'Beto', note: '', relays: ['wss://relay.example.com'], now })
approveRequest(store, { pubkey: asker.publicKey, now })
admitQuestion(store, { identity: responder, senderPubkey: asker.publicKey, questionId: '00000000-0000-4000-8000-000000000002', rumorId: 'd'.repeat(64), rumorCreatedAt: now, generation: 1, text: 'hola', now })
const reserved = reserveNextQuestion(store, { epoch: lock.epoch, nowMs: Date.now(), attemptTimeoutMs: 600000, identity: responder })
console.log('reserved ' + reserved.attempt.code)
for await (const line of createInterface({ input: process.stdin })) {
  if (line !== 'go') continue
  const outcome = answerQuestion(store, { epoch: lock.epoch, code: reserved.attempt.code, nowMs: Date.now(), identity: responder, text: 'tarde', source: 'x', confidence: 'creo' })
  console.log('outcome ' + outcome.kind)
  store.close()
  process.exit(0)
}
`)
    await stale.waitFor('reserved ')
    stale.child.kill('SIGSTOP')

    const store = await openStore(home)
    try {
      // A suspended owner is still alive, so the real probe would refuse. Fencing must hold even if
      // the lock is taken anyway (for example because liveness was misjudged).
      expect(acquireChannelLock(store, { self: currentProcess(), isAlive: () => false, now: nowSeconds() })).toEqual({
        kind: 'acquired',
        epoch: 2,
        requeued: 1,
      })
      stale.child.kill('SIGCONT')
      stale.child.stdin!.write('go\n')
      expect(await stale.waitFor('outcome ')).toBe('outcome fenced')
      expect(await stale.exited).toBe(0)
      expect(store.db.prepare('SELECT state FROM inbox_questions').get()?.state).toBe('queued')
      expect(store.db.prepare("SELECT count(*) AS n FROM outbox WHERE label = 'answer'").get()?.n).toBe(0)
    } finally {
      store.close()
    }
  }, 60_000)

  it('never leaves a waiting question or an unclaimed receipt when a revocation races admissions from other processes', async () => {
    const home = await newHome()
    const responder = testIdentity(141)
    const asker = testIdentity(142)
    const setup = await openStore(home)
    setProfile(setup, { name: 'Ana', now: nowSeconds() })
    recordIncomingRequest(setup, { pubkey: asker.publicKey, requestId: '00000000-0000-4000-8000-000000000009', requestRumorId: 'e'.repeat(64), declaredName: 'Beto', note: '', relays: ['wss://relay.example.com'], now: nowSeconds() })
    approveConnection(setup, { identity: responder, idPrefix: asker.publicKey.slice(0, 8), now: nowSeconds() })
    setup.close()

    const admitter = (k: number) =>
      runScript(`
import { admitQuestion, nowSeconds, openStore } from ${coreEntry}
import { testIdentity } from ${keysEntry}
const responder = testIdentity(141)
const asker = testIdentity(142)
const store = await openStore(${JSON.stringify(home)})
for (let i = 0; i < 40; i++) {
  const n = ${k} * 1000 + i
  admitQuestion(store, { identity: responder, senderPubkey: asker.publicKey, questionId: '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0'), rumorId: n.toString(16).padStart(64, '0'), rumorCreatedAt: nowSeconds(), generation: 1, text: 'p' + n, now: nowSeconds() })
  if (i === 0) console.log('started')
  await new Promise((r) => setTimeout(r, 5))
}
store.close()
console.log('done')
`)
    const scripts = [1, 2, 3].map(admitter)
    await Promise.all(scripts.map((s) => s.waitFor('started')))

    const store = await openStore(home)
    try {
      revokeConnection(store, { identity: responder, name: 'beto', now: nowSeconds() })
      await Promise.all(scripts.map((s) => s.waitFor('done', 60_000)))
      expect(store.db.prepare('SELECT count(*) AS n FROM inbox_questions').get()?.n).toBe(120)
      expect(store.db.prepare("SELECT count(*) AS n FROM inbox_questions WHERE state IN ('queued', 'dispatched')").get()?.n).toBe(0)
      expect(store.db.prepare("SELECT count(*) AS n FROM outbox WHERE label = 'receipt'").get()?.n).toBe(0)
    } finally {
      store.close()
    }
  }, 120_000)
})
