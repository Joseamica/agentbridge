# AgentBridge 0.2 — Plan 1: Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the self-hosted relay and build, inside `packages/core`, every transport and state primitive AgentBridge 0.2 needs to talk over public Nostr relays: a local identity, hostile-input relay URL checks, a transactional SQLite store (contacts, outbox, history cursors), sealed NIP-59 envelopes with proof of work, a minimal NIP-01 relay client with NIP-42 AUTH, backpressure and paginated history recovery — all proven by tests that need neither Docker nor internet, plus one opt-in live test against real public relays.

**Architecture:** This is plan 1 of 4. Plan 2 (responder: dispatcher and channel), plan 3 (asker: service, CLI, MCP) and plan 4 (setup, doctor, packaging, docs, acceptance) are written after this one lands, because they build on the exact interfaces produced here. `nostr-tools` is used **only for cryptographic primitives** (keys, NIP-44, event hashing and signatures, NIP-19, the NIP-42 auth template); the relay client is our own small NIP-01 implementation over `ws`, because the library's relay layer leaked unhandled rejections during the 2026-09-16 spike and does not give the control over AUTH retries, backpressure and pinned DNS that the spec requires. The CLI and channel keep compiling against the old `RelayHttpClient` until plans 2 and 3 replace them; only relay-coupled tests are removed now.

**Tech Stack:** Node ≥ 22.13 (`node:sqlite`, `worker_threads`, `node:net` `BlockList`), TypeScript 5.9 (type-check only), npm workspaces, `nostr-tools` 2.25.2 (exact), `ws` 8.21.3 (exact), zod 4, vitest 5, esbuild 0.28.

**Spec:** `docs/superpowers/specs/2026-09-16-nostr-transport-design.md` (revision 4). Read it before starting any task. Codex audit reports that shaped it: `.context/codex-spec-audit-2026-09-16.md`, `.context/codex-spec-audit2-2026-09-16.md`, `.context/codex-spec-audit3-2026-09-16.md` (local only, git-ignored).

## Global Constraints

- Node floor: `engines.node` is `>=22.13` in the root `package.json` **and** in `scripts/pack.mjs`.
- `nostr-tools` pinned to exactly `2.25.2`; `ws` pinned to exactly `8.21.3`; `@types/ws` as a dev dependency. No other new runtime dependency.
- Protocol: own application on NIP-59. Wrap kind `1059`, seal kind `13`, rumor kind `8059` (arbitrary, never published). **Not** NIP-17: never publish kind 10050, never use kind 14.
- Proof of work (NIP-13), fixed in the protocol: **16 bits** on every wrap, **22 bits** on wraps carrying `connect_request`. Not configurable.
- Size caps per layer: wrap event ≤ 64 KB (65 536 bytes, serialized JSON) and the outgoing `["EVENT",…]` frame ≤ 64 KB; seal ≤ 40 KB (40 960 bytes); rumor ≤ 28 KB (28 672 bytes); every text field ≤ 16 KB (16 384 bytes) in UTF-8 **and** within `LIMITS` (`questionMaxChars` 4000, `answerMaxChars` 8000, `sourceMaxChars` 500).
- Time rules: any `created_at` (wrap or rumor) may be at most **10 minutes** in the future. A question expires at `rumor.created_at + 24 h`. A `connect_request` is accepted only if its `rumor.created_at` is at most **7 days** old. NIP-59 randomizes seal and wrap `created_at` up to **2 days** back. Every wrap carries a NIP-40 `expiration` tag at publish time + 7 days.
- Retention: message content 7 days; message decisions (including request records) 9 days; contact state (generation counter, permission state, max observed generation, relays) never expires.
- Contacts: at most 5 relays per contact; one pending inbound request per public key; at most 20 pending inbound requests (evict the oldest); a key rejected in the last 7 days is ignored; permission changes need a generation **greater** than the max observed; questions need a generation **equal** to the current approved one.
- Relay URLs are hostile input: `wss://` only, no credentials, query or fragment, ≤ 200 characters, host must be a domain name (not an IP literal), DNS answers validated inside the socket's own `lookup` (no loopback, private, link-local, CGNAT, ULA, multicast, documentation, benchmarking or reserved ranges, no IPv4-mapped or NAT64 IPv6), no redirects, TLS verified against the host name. The production socket factory re-validates every URL with `checkRelayUrl`, so no caller can bypass the rules with an IP literal.
- Receiving: frames are read from each socket sequentially and every handler is awaited, so `ws`'s own flow control stops reading when AgentBridge falls behind; the receive queue holds at most 200 items (a push waits for room), with one decryption at a time and nothing dropped. Live subscription `since = now − 2 days − 10 min`. If processing fails after `precheckWrap`, the caller deletes the wrap id from `SeenIds`.
- History recovery covers 9 days in 1-day windows, pages with `limit` 200 and escalates to 400 then 800 when a page that may be truncated shares one second; otherwise the window is incomplete. A page counts as possibly truncated when it holds at least `min(limit, trusted)` events, where `trusted = max(100, largest page this relay has returned)`. Short pages are confirmed with a strictly older query. A possibly truncated page moves `until` to the second of its k-th newest distinct valid event, where k = min(limit, trusted) minus the page's entries that are not distinct valid events (k ≤ 0 → incomplete); a page raises the largest page by at most the limit it asked for; each window has a budget of 250 queries, after which it is incomplete. Accepted limitation: a relay that caps filter limits below 100, or that caps below the requested limit while also delivering extra events before EOSE, can hide same-second ties from history recovery, and a relay that truncates other than newest-first can hide older events; NIP-59 randomizes seconds over two days, every message goes to up to 5 relays, and senders retry with fresh wraps for 7 days. A window is marked complete only after everything received in it is persisted **and** its end is older than `read time − 2 days − 10 min`.
- Outbox: one row per logical message (`recipient` + `rumor_id`); `claimDue` abandons expired rows first and asks an `authorize` callback inside its transaction before claiming each row (unauthorized rows are abandoned); claims last 2 minutes; regeneration at most once every 10 minutes per logical message; pending bytes ≤ 1 MB per recipient and ≤ 20 MB per identity (over the cap the row is stored but postponed 10 minutes); at most 60 publishes per minute per identity, reserved with `reservePublish` inside the `beforeSend` guard that runs immediately before each `EVENT` write, which also re-checks the claim (one publish = one logical message sent to up to 5 relays); asker retry schedule every 5 min during the first hour, then every 30 min, until 7 days after first enqueue; content is purged 7 days after the rumor's creation, whatever the row's state.
- Local files: identity and state live in `AGENTBRIDGE_HOME` (default `~/.agentbridge`), directory `0700`; `identity.json` `0600`, written to a temporary file and linked into place with `link()` so two concurrent creators never produce two identities or a half-written file; `agentbridge.db` pre-created `0600` so SQLite's WAL and SHM files inherit `0600`.
- SQLite: WAL, `busy_timeout` 5000 ms, foreign keys on, every read-modify-write inside `BEGIN IMMEDIATE`; `node:sqlite` is imported dynamically **after** installing a filter that suppresses only SQLite's `ExperimentalWarning`.
- `verifyEvent` from `nostr-tools` trusts an internal marker copied by object spread. Only verify objects freshly produced by `JSON.parse`, and build tamper tests with `JSON.parse(JSON.stringify(event))`.
- User-facing text is Spanish; identifiers, logs and model instructions are English. `npm test` needs neither Docker nor internet; `npm run test:live` is the only suite that touches public relays.

---

## File Structure

```text
package.json                                   workspaces without apps/relay, engines >=22.13, scripts test / test:live
vitest.config.ts                               default suite: packages/*/test and tests/**, excludes tests/live
vitest.live.config.ts                          opt-in suite: tests/live/**/*.live.test.ts
tsconfig.json                                  no apps/*
scripts/pack.mjs                               engines >=22.13
CLAUDE.md                                      test instructions without Docker

packages/core/package.json                     + nostr-tools 2.25.2, ws 8.21.3
packages/core/src/index.ts                     re-exports every module below
packages/core/src/errors.ts                    UserFacingError (Spanish message for people)
packages/core/src/nostr-constants.ts           NOSTR: kinds, PoW bits, size caps, time rules, queue and history numbers
packages/core/src/identity.ts                  identity.json create/load, agentbridge: link encode/decode
packages/core/src/relay-url.ts                 checkRelayUrl, sanitizeRelayList, isForbiddenAddress, safeLookup
packages/core/src/store/db.ts                  openStore, Store.tx (BEGIN IMMEDIATE, joins outer tx), migrations runner, warning filter
packages/core/src/store/schema.ts              MIGRATIONS (v1: contacts, requests, outbox, publish_log, cursors)
packages/core/src/store/contacts.ts            request records, inbound requests/approve/reject/revoke, outbound request/approval/rejection/revocation, generation rules, local names
packages/core/src/store/outbox.ts              enqueue/regenerate, claimDue(authorize), stillClaimed, reservePublish, markPublished, markFailed, resolveOutboxMessage, deleteUnclaimedFor, purgeOutbox
packages/core/src/store/cursors.ts             history windows per relay and role
packages/core/src/envelope/messages.ts         zod schemas for the 8 protocol messages, byte checks
packages/core/src/envelope/pow.ts              leading-zero bits, nonce mining in a worker thread
packages/core/src/envelope/seal.ts             createRumor, wrapRumor (seal, wrap, PoW, expiration, size checks)
packages/core/src/envelope/open.ts             precheckWrap (steps 1–4), openWrap (steps 6–9)
packages/core/src/envelope/dedupe.ts           bounded LRU set of seen wrap ids
packages/core/src/envelope/time.ts             isFutureDated, questionExpiresAt, isQuestionExpired, isRequestTooOld
packages/core/src/boards/connection.ts         BoardConnection: sequential NIP-01 frame reader over ws, OK/EOSE/CLOSED/NOTICE, NIP-42 AUTH retry
packages/core/src/boards/socket.ts             createPinnedSocketFactory / pinnedSocketFactory (checkRelayUrl + safeLookup), SocketFactory type
packages/core/src/boards/receive-queue.ts      ReceiveQueue: bounded, push waits for room, one item at a time
packages/core/src/boards/pool.ts               BoardPool: publish to ≤5 relays, live subscription with reconnect and backpressure, one-shot query
packages/core/src/boards/history.ts            recoverHistory: windows, pagination, ties, completeness

packages/core/test/support/fake-board.ts       in-memory NIP-01 relay over ws for tests
packages/core/test/support/keys.ts             deterministic test identities
packages/core/test/support/craft.ts            hostile envelope builder for pipeline tests
packages/core/test/*.test.ts                   one test file per module above
tests/live/boards.live.test.ts                 round trip against real public relays (opt-in)

Deleted: apps/relay/, render.yaml, packages/cli/test/{account,ask,doctor,setup}.test.ts,
         packages/channel/test/relay-client.test.ts, tests/e2e/pipe.test.ts
```

---

### Task 1: Remove the relay, its Postgres-coupled tests, and raise the Node floor

**Files:**
- Delete: `apps/relay/` (entire directory), `render.yaml`, `packages/cli/test/account.test.ts`, `packages/cli/test/ask.test.ts`, `packages/cli/test/doctor.test.ts`, `packages/cli/test/setup.test.ts`, `packages/channel/test/relay-client.test.ts`, `tests/e2e/pipe.test.ts`
- Modify: `package.json`, `vitest.config.ts`, `tsconfig.json`, `scripts/pack.mjs:90`, `CLAUDE.md:7-8`
- Test: `packages/core/test/published.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a repository whose `npm test` and `npm run typecheck` pass with no Docker container running. The CLI sources (`account.ts`, `ask.ts`, `setup.ts`, `doctor.ts`) still compile against `RelayHttpClient`; plans 3 and 4 replace them and bring back their tests.

The deleted CLI tests covered commands that plans 3 and 4 rewrite from scratch (enrollment disappears, `setup` and `doctor` change their homes and flow). Their safety scenarios — dangerous shared folders, EOF handling, retries — must be re-created in plan 4; this task records that obligation in the commit message.

- [ ] **Step 1: Create the branch and tag the published 0.1.1**

```bash
cd ~/Documents/Programming/agent-bridge
git switch main
git tag v0.1.1 44531cd
git switch -c v0.2-foundations
```

The tag stays local. Push it only when the owner says so.

- [ ] **Step 2: Write the failing test**

Append to `packages/core/test/published.test.ts`, inside the existing `describe('published package name', …)` block, after the last `it(…)`:

```ts
  it('requires the Node version that ships node:sqlite without a flag, in both manifests', async () => {
    const root = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
    expect(root.engines.node).toBe('>=22.13')
    const pack = await readFile(join(repoRoot, 'scripts/pack.mjs'), 'utf8')
    expect(pack).toContain("engines: { node: '>=22.13' }")
  })

  it('no longer ships the self-hosted relay or its database scripts', async () => {
    const root = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
    expect(root.workspaces).toEqual(['packages/core', 'packages/channel', 'packages/cli'])
    expect(root.scripts['db:up']).toBeUndefined()
    expect(root.scripts['db:down']).toBeUndefined()
    await expect(readFile(join(repoRoot, 'render.yaml'), 'utf8')).rejects.toThrow()
  })
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run packages/core/test/published.test.ts`
Expected: FAIL — `expected '>=22.4' to be '>=22.13'` and the workspaces assertion lists `apps/relay`.

- [ ] **Step 4: Delete the relay and the tests that import its helpers**

```bash
git rm -r -q apps/relay render.yaml \
  packages/cli/test/account.test.ts packages/cli/test/ask.test.ts \
  packages/cli/test/doctor.test.ts packages/cli/test/setup.test.ts \
  packages/channel/test/relay-client.test.ts tests/e2e/pipe.test.ts
grep -rn "apps/relay\|relay/test/helpers\|from 'pg'" packages tests || echo "no references left"
```

Expected: `no references left`.

- [ ] **Step 5: Update the root manifest**

Replace the whole content of `package.json` with:

```json
{
  "name": "agentbridge",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.13" },
  "workspaces": ["packages/core", "packages/channel", "packages/cli"],
  "scripts": {
    "test": "vitest run",
    "test:live": "vitest run --config vitest.live.config.ts",
    "typecheck": "tsc -p tsconfig.json",
    "build": "node scripts/build.mjs",
    "pack": "node scripts/pack.mjs"
  },
  "devDependencies": {
    "@types/node": "^22.20.2",
    "esbuild": "^0.28.2",
    "tsx": "^4.23.13",
    "typescript": "5.9.3",
    "vitest": "^5.0.0"
  }
}
```

- [ ] **Step 6: Update test and type-check configuration**

Replace `vitest.config.ts` with:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['tests/live/**', '**/node_modules/**'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
})
```

Create `vitest.live.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

// Opt-in: talks to real public Nostr relays over the internet. Never part of `npm test`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/live/**/*.live.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
})
```

In `tsconfig.json`, replace the `include` line with:

```json
  "include": ["packages/*/src", "packages/*/test", "tests", "vitest.config.ts", "vitest.live.config.ts"]
```

In `scripts/pack.mjs`, replace `  engines: { node: '>=22.4' },` with `  engines: { node: '>=22.13' },`.

- [ ] **Step 7: Update the project instructions**

In `CLAUDE.md`, replace these two lines:

```markdown
- Tests need Docker Postgres: `npm run db:up`, then `npm test`. They only ever talk to the
  container on port 55432 — never point TEST_DATABASE_URL or DATABASE_URL anywhere else.
```

with:

```markdown
- `npm test` needs neither Docker nor internet. `npm run test:live` is the only suite that talks to
  public Nostr relays; run it on purpose, never in a loop.
```

- [ ] **Step 8: Refresh the lockfile and verify**

```bash
npm install
npm run typecheck
npx vitest run packages/core/test/published.test.ts
npm test
```

Expected: `npm install` removes `fastify`, `pg` and friends from `package-lock.json`; type-check passes; the published test PASSES; the full suite passes with no Docker container running.

- [ ] **Step 9: Commit**

```bash
git add -A package.json package-lock.json vitest.config.ts vitest.live.config.ts tsconfig.json scripts/pack.mjs CLAUDE.md packages/core/test/published.test.ts
git commit -m "chore: remove the self-hosted relay and raise the Node floor to 22.13

AgentBridge 0.2 talks over public Nostr relays. The Fastify + Postgres relay,
its Render blueprint and every test that imported its helpers are gone, so
npm test needs neither Docker nor internet. node:sqlite needs Node 22.13.

The CLI tests for enroll/invite/accept/ask/setup/doctor went with the relay
helpers. Plans 3 and 4 rewrite those commands and must bring back their
coverage, including setup's dangerous-folder, EOF and retry scenarios."
```

---

### Task 2: Protocol constants, user-facing errors and the local identity

**Files:**
- Create: `packages/core/src/errors.ts`, `packages/core/src/nostr-constants.ts`, `packages/core/src/identity.ts`, `packages/core/test/support/keys.ts`
- Modify: `packages/core/package.json`, `packages/core/src/index.ts`
- Test: `packages/core/test/identity.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `class UserFacingError extends Error` — message is Spanish and safe to print.
  - `const NOSTR` (every number in Global Constraints) and `nowSeconds(): number`.
  - `type Identity = { secretKey: Uint8Array; publicKey: string }` (`publicKey` is 64 lowercase hex).
  - `IDENTITY_FILE = 'identity.json'`, `LINK_PREFIX = 'agentbridge:'`.
  - `loadIdentity(home: string): Promise<Identity | null>`
  - `loadOrCreateIdentity(home: string): Promise<{ identity: Identity; created: boolean }>`
  - `encodeLink(publicKey: string, relays: readonly string[]): string`
  - `type DecodedLink = { publicKey: string; relays: string[] }` and `decodeLink(input: string): DecodedLink` — `relays` are **unvalidated**; callers pass them through `sanitizeRelayList` (Task 3).
  - Test helper `testIdentity(seed: number): Identity`.

- [ ] **Step 1: Add the dependency**

In `packages/core/package.json`, replace the `dependencies` line with:

```json
  "dependencies": { "nostr-tools": "2.25.2", "zod": "^4.6.3" }
```

Run: `npm install`
Expected: `nostr-tools@2.25.2` appears in `package-lock.json`.

- [ ] **Step 2: Write the failing tests**

Create `packages/core/test/support/keys.ts`:

```ts
import { getPublicKey } from 'nostr-tools/pure'
import type { Identity } from '../../src/identity'

// Deterministic, valid secp256k1 secret keys for tests. seed must be 1–255.
export function testIdentity(seed: number): Identity {
  if (!Number.isInteger(seed) || seed < 1 || seed > 255) throw new Error('seed must be an integer from 1 to 255')
  const secretKey = new Uint8Array(32)
  secretKey[0] = 1
  secretKey[31] = seed
  return { secretKey, publicKey: getPublicKey(secretKey) }
}
```

Create `packages/core/test/identity.test.ts`:

```ts
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { IDENTITY_FILE, UserFacingError, decodeLink, encodeLink, loadIdentity, loadOrCreateIdentity } from '@agentbridge/core'

const run = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, '../../..')
const newHome = async () => join(await mkdtemp(join(tmpdir(), 'ab-identity-')), 'home')

describe('local identity', () => {
  it('creates a private identity file inside a private folder and reads the same key back', async () => {
    const home = await newHome()
    const { identity, created } = await loadOrCreateIdentity(home)
    expect(created).toBe(true)
    expect(identity.publicKey).toMatch(/^[0-9a-f]{64}$/)
    expect((await stat(home)).mode & 0o777).toBe(0o700)
    expect((await stat(join(home, IDENTITY_FILE))).mode & 0o777).toBe(0o600)
    const again = await loadIdentity(home)
    expect(again?.publicKey).toBe(identity.publicKey)
    expect(Buffer.from(again!.secretKey).equals(Buffer.from(identity.secretKey))).toBe(true)
  })

  it('returns the existing identity instead of creating a second one', async () => {
    const home = await newHome()
    const first = await loadOrCreateIdentity(home)
    const second = await loadOrCreateIdentity(home)
    expect(second.created).toBe(false)
    expect(second.identity.publicKey).toBe(first.identity.publicKey)
  })

  it('returns null when no identity exists yet', async () => {
    expect(await loadIdentity(await newHome())).toBeNull()
  })

  it('never produces two identities when several callers race in one process, and leaves no temp files', async () => {
    const home = await newHome()
    const results = await Promise.all(Array.from({ length: 6 }, () => loadOrCreateIdentity(home)))
    expect(new Set(results.map((r) => r.identity.publicKey)).size).toBe(1)
    expect(results.filter((r) => r.created)).toHaveLength(1)
    expect((await readdir(home)).sort()).toEqual([IDENTITY_FILE])
  })

  it('never produces two identities when separate processes race', async () => {
    const home = await newHome()
    const script = `import { loadOrCreateIdentity } from ${JSON.stringify(join(repoRoot, 'packages/core/src/identity.ts'))}
const r = await loadOrCreateIdentity(${JSON.stringify(home)})
process.stdout.write(JSON.stringify({ publicKey: r.identity.publicKey, created: r.created }))`
    const outputs = await Promise.all(
      Array.from({ length: 4 }, () =>
        run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: repoRoot }),
      ),
    )
    const parsed = outputs.map((o) => JSON.parse(o.stdout) as { publicKey: string; created: boolean })
    expect(new Set(parsed.map((p) => p.publicKey)).size).toBe(1)
    expect(parsed.filter((p) => p.created)).toHaveLength(1)
    expect((await readdir(home)).sort()).toEqual([IDENTITY_FILE])
  })

  it('reports a damaged identity file in Spanish without echoing its contents', async () => {
    const home = await newHome()
    await loadOrCreateIdentity(home)
    await writeFile(join(home, IDENTITY_FILE), '{"version":1,"secretKey":"not-hex-and-secret-looking"}')
    const err = await loadIdentity(home).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UserFacingError)
    expect((err as Error).message).toContain('dañado')
    expect((err as Error).message).not.toContain('secret-looking')
  })
})

describe('agentbridge: links', () => {
  const pubkey = 'e9451985e285d64afb4594cf538593e53e9fedfbec8bdaec8e9399df40ea41b8'

  it('round-trips the public key and relays', () => {
    const link = encodeLink(pubkey, ['wss://relay.primal.net', 'wss://nos.lol'])
    expect(link.startsWith('agentbridge:nprofile1')).toBe(true)
    expect(decodeLink(link)).toEqual({ publicKey: pubkey, relays: ['wss://relay.primal.net', 'wss://nos.lol'] })
  })

  it('never puts more than five relays in a link', () => {
    const relays = Array.from({ length: 7 }, (_, i) => `wss://r${i}.example.com`)
    expect(decodeLink(encodeLink(pubkey, relays)).relays).toHaveLength(5)
  })

  it('accepts a bare nprofile and surrounding whitespace', () => {
    const bare = encodeLink(pubkey, []).slice('agentbridge:'.length)
    expect(decodeLink(`  ${bare}\n`)).toEqual({ publicKey: pubkey, relays: [] })
  })

  it.each(['', 'hola', 'agentbridge:', 'agentbridge:npub1abc', 'nprofile1qqqqqq', `agentbridge:${'nprofile1'.padEnd(3000, 'q')}`])(
    'rejects %j with a Spanish error',
    (input) => {
      expect(() => decodeLink(input)).toThrow(UserFacingError)
      expect(() => decodeLink(input)).toThrow(/enlace de AgentBridge no es válido/)
    },
  )

  it('refuses to encode a malformed public key', () => {
    expect(() => encodeLink('ABC', [])).toThrow()
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/identity.test.ts`
Expected: FAIL — `loadOrCreateIdentity` (and the other imports) are not exported by `@agentbridge/core`.

- [ ] **Step 4: Implement errors and constants**

Create `packages/core/src/errors.ts`:

```ts
// An error whose message is written for the person using AgentBridge, in Spanish, and is safe to
// print as-is: it never contains keys, decrypted third-party content or shared-folder paths.
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserFacingError'
  }
}
```

Create `packages/core/src/nostr-constants.ts`:

```ts
const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// Every number the 0.2 protocol fixes (docs/superpowers/specs/2026-09-16-nostr-transport-design.md).
// Durations are in seconds, sizes in bytes.
export const NOSTR = {
  wrapKind: 1059,
  sealKind: 13,
  // Never published: it only exists inside a seal. Deliberately not 14, so a NIP-17 chat app
  // pointed at an AgentBridge key does not render our JSON as a conversation.
  rumorKind: 8059,
  powMessageBits: 16,
  powRequestBits: 22,
  maxWrapBytes: 64 * 1024,
  maxSealBytes: 40 * 1024,
  maxRumorBytes: 28 * 1024,
  maxTextBytes: 16 * 1024,
  futureToleranceSeconds: 10 * MINUTE,
  randomizationSeconds: 2 * DAY,
  wrapExpirationSeconds: 7 * DAY,
  questionTtlSeconds: DAY,
  requestMaxAgeSeconds: 7 * DAY,
  contentRetentionSeconds: 7 * DAY,
  decisionRetentionSeconds: 9 * DAY,
  maxRelaysPerContact: 5,
  maxRelayUrlLength: 200,
  maxPendingRequests: 20,
  rejectedRequestCooldownSeconds: 7 * DAY,
  receiveQueueMax: 200,
  historyDays: 9,
  historyPageLimits: [200, 400, 800],
  claimSeconds: 2 * MINUTE,
  regenerationIntervalSeconds: 10 * MINUTE,
  maxPendingBytesPerRecipient: 1024 * 1024,
  maxPendingBytesPerIdentity: 20 * 1024 * 1024,
  capPostponeSeconds: 10 * MINUTE,
  maxPublishesPerMinute: 60,
  retryFirstHourIntervalSeconds: 5 * MINUTE,
  retryAfterFirstHourIntervalSeconds: 30 * MINUTE,
  retryWindowSeconds: 7 * DAY,
  liveSinceSeconds: 2 * DAY + 10 * MINUTE,
  // History recovery assumes relays honor filter limits of at least this many events. A relay that
  // caps lower can hide same-second ties from history (see Task 15).
  minTrustedRelayLimit: 100,
} as const

export const nowSeconds = (): number => Math.floor(Date.now() / 1000)
```

- [ ] **Step 5: Implement the identity**

Create `packages/core/src/identity.ts`:

```ts
import { randomBytes } from 'node:crypto'
import { chmod, link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decode, nprofileEncode } from 'nostr-tools/nip19'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { UserFacingError } from './errors'
import { NOSTR } from './nostr-constants'

export const IDENTITY_FILE = 'identity.json'
export const LINK_PREFIX = 'agentbridge:'

export type Identity = { secretKey: Uint8Array; publicKey: string }
export type DecodedLink = { publicKey: string; relays: string[] }

const HEX_64 = /^[0-9a-f]{64}$/

function damaged(file: string): UserFacingError {
  return new UserFacingError(`El archivo de identidad ${file} está dañado y no se puede leer.`)
}

function parseIdentityFile(raw: string, file: string): Identity {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw damaged(file)
  }
  const record = parsed as { version?: unknown; secretKey?: unknown } | null
  if (record?.version !== 1 || typeof record.secretKey !== 'string' || !HEX_64.test(record.secretKey)) throw damaged(file)
  const secretKey = Uint8Array.from(Buffer.from(record.secretKey, 'hex'))
  try {
    return { secretKey, publicKey: getPublicKey(secretKey) }
  } catch {
    throw damaged(file)
  }
}

export async function loadIdentity(home: string): Promise<Identity | null> {
  const file = join(home, IDENTITY_FILE)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  return parseIdentityFile(raw, file)
}

// The key is written completely to a private temporary file first and then hard-linked into
// place. link() fails with EEXIST when identity.json already exists, so concurrent creators —
// threads or separate processes — can never leave two identities or a half-written file: the
// loser reads the winner's key.
export async function loadOrCreateIdentity(home: string): Promise<{ identity: Identity; created: boolean }> {
  const existing = await loadIdentity(home)
  if (existing) return { identity: existing, created: false }
  await mkdir(home, { recursive: true, mode: 0o700 })
  await chmod(home, 0o700)
  const file = join(home, IDENTITY_FILE)
  const secretKey = generateSecretKey()
  const temp = join(home, `.identity-${process.pid}-${randomBytes(6).toString('hex')}.tmp`)
  await writeFile(temp, `${JSON.stringify({ version: 1, secretKey: Buffer.from(secretKey).toString('hex') })}\n`, {
    mode: 0o600,
    flag: 'wx',
  })
  try {
    await chmod(temp, 0o600)
    await link(temp, file)
    return { identity: { secretKey, publicKey: getPublicKey(secretKey) }, created: true }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    const winner = await loadIdentity(home)
    if (!winner) throw err
    return { identity: winner, created: false }
  } finally {
    await unlink(temp).catch(() => {})
  }
}

export function encodeLink(publicKey: string, relays: readonly string[]): string {
  if (!HEX_64.test(publicKey)) throw new Error('encodeLink: publicKey must be 64 lowercase hex characters')
  return `${LINK_PREFIX}${nprofileEncode({ pubkey: publicKey, relays: relays.slice(0, NOSTR.maxRelaysPerContact) })}`
}

// The relays in a link are an unsigned locator written by whoever shared it. They are returned
// as-is; every caller must pass them through sanitizeRelayList before storing or connecting.
export function decodeLink(input: string): DecodedLink {
  const invalid = new UserFacingError(
    'Ese enlace de AgentBridge no es válido. Pide que te lo copien completo: empieza con "agentbridge:nprofile1".',
  )
  const trimmed = input.trim()
  const code = trimmed.startsWith(LINK_PREFIX) ? trimmed.slice(LINK_PREFIX.length) : trimmed
  if (!code.startsWith('nprofile1') || code.length > 2000) throw invalid
  let decoded: ReturnType<typeof decode>
  try {
    decoded = decode(code)
  } catch {
    throw invalid
  }
  if (decoded.type !== 'nprofile' || !HEX_64.test(decoded.data.pubkey)) throw invalid
  return { publicKey: decoded.data.pubkey, relays: [...(decoded.data.relays ?? [])] }
}
```

In `packages/core/src/index.ts`, append:

```ts
export * from './errors'
export * from './nostr-constants'
export * from './identity'
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/identity.test.ts && npm run typecheck`
Expected: PASS (all identity and link tests), type-check clean.

- [ ] **Step 7: Commit**

```bash
git add packages/core/package.json package-lock.json packages/core/src/errors.ts packages/core/src/nostr-constants.ts packages/core/src/identity.ts packages/core/src/index.ts packages/core/test/support/keys.ts packages/core/test/identity.test.ts
git commit -m "feat(core): local Nostr identity with race-free creation and agentbridge: links"
```

---

### Task 3: Relay URLs as hostile input, with DNS checked inside the socket's own lookup

**Files:**
- Create: `packages/core/src/relay-url.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/relay-url.test.ts`

**Interfaces:**
- Consumes: `NOSTR.maxRelayUrlLength`, `NOSTR.maxRelaysPerContact` (Task 2).
- Produces:
  - `type RelayUrlCheck = { ok: true; url: string } | { ok: false; reason: string }` (`reason` is Spanish; `url` is normalized: lowercase host, no trailing slash on an empty path).
  - `checkRelayUrl(input: string): RelayUrlCheck`
  - `sanitizeRelayList(inputs: readonly unknown[]): string[]` — keeps valid ones, normalized, de-duplicated, first 5.
  - `isForbiddenAddress(address: string): boolean`
  - `safeLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void` — `net.LookupFunction`-compatible; errors carry `code = 'EAGENTBRIDGE_FORBIDDEN_ADDRESS'`.
  - `type LookupImpl = (hostname: string, options: { all: true }) => Promise<Array<{ address: string; family: number }>>` and `createSafeLookup(resolve?: LookupImpl)` (the testable core of `safeLookup`).

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/relay-url.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { checkRelayUrl, createSafeLookup, isForbiddenAddress, sanitizeRelayList } from '@agentbridge/core'

type Resolved = Array<{ address: string; family: number }>

function lookupWith(answers: Resolved) {
  const safe = createSafeLookup(async () => answers)
  return (options: { all?: boolean }) =>
    new Promise<{ err: NodeJS.ErrnoException | null; result: unknown }>((done) => {
      safe('relay.example.com', options, (err, address, family) =>
        done({ err, result: options.all ? address : { address, family } }),
      )
    })
}

describe('checkRelayUrl', () => {
  it.each([
    ['wss://relay.primal.net', 'wss://relay.primal.net'],
    ['wss://Relay.Primal.NET/', 'wss://relay.primal.net'],
    ['  wss://nos.lol  ', 'wss://nos.lol'],
    ['wss://relay.example.com/inbox', 'wss://relay.example.com/inbox'],
    ['wss://relay.example.com:4443', 'wss://relay.example.com:4443'],
  ])('accepts and normalizes %j', (input, expected) => {
    expect(checkRelayUrl(input)).toEqual({ ok: true, url: expected })
  })

  it.each([
    'ws://relay.example.com',
    'https://relay.example.com',
    'wss://user:pass@relay.example.com',
    'wss://relay.example.com/?x=1',
    'wss://relay.example.com/#frag',
    'wss://127.0.0.1',
    'wss://[::1]',
    'wss://10.0.0.8:7777',
    'wss://localhost',
    'wss://intranet',
    'not a url',
    `wss://${'a'.repeat(190)}.example.com`,
  ])('rejects %j with a Spanish reason', (input) => {
    const result = checkRelayUrl(input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/tablero/)
  })
})

describe('sanitizeRelayList', () => {
  it('keeps only valid relays, normalized, without duplicates, at most five', () => {
    const input = [
      'wss://a.example.com/',
      'wss://A.example.com',
      'ws://b.example.com',
      42,
      'wss://c.example.com',
      'wss://d.example.com',
      'wss://e.example.com',
      'wss://f.example.com',
      'wss://g.example.com',
    ]
    expect(sanitizeRelayList(input)).toEqual([
      'wss://a.example.com',
      'wss://c.example.com',
      'wss://d.example.com',
      'wss://e.example.com',
      'wss://f.example.com',
    ])
  })
})

describe('isForbiddenAddress', () => {
  it.each([
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.4', '192.0.0.8', '192.0.2.10',
    '192.168.1.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.251', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '64:ff9b::a00:1', '100::1', '2001:db8::1', 'fc00::1', 'fd12:3456::1',
    'fe80::1', 'ff02::1', 'not-an-ip',
  ])('forbids %s', (address) => {
    expect(isForbiddenAddress(address)).toBe(true)
  })

  it.each(['8.8.8.8', '1.1.1.1', '104.16.132.229', '2606:4700::6810:84e5', '2001:4860:4860::8888'])('allows %s', (address) => {
    expect(isForbiddenAddress(address)).toBe(false)
  })
})

describe('safeLookup', () => {
  it('passes public answers through in both callback shapes', async () => {
    const lookup = lookupWith([{ address: '104.16.132.229', family: 4 }])
    expect(await lookup({ all: true })).toEqual({ err: null, result: [{ address: '104.16.132.229', family: 4 }] })
    expect(await lookup({})).toEqual({ err: null, result: { address: '104.16.132.229', family: 4 } })
  })

  it('fails the whole lookup when any answer is forbidden, so a rebinding answer can never be used', async () => {
    const { err } = await lookupWith([
      { address: '104.16.132.229', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])({ all: true })
    expect(err?.code).toBe('EAGENTBRIDGE_FORBIDDEN_ADDRESS')
  })

  it('fails when the name resolves to nothing', async () => {
    const { err } = await lookupWith([])({})
    expect(err?.code).toBe('ENOTFOUND')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/relay-url.test.ts`
Expected: FAIL — `checkRelayUrl` is not exported.

- [ ] **Step 3: Implement**

Create `packages/core/src/relay-url.ts`:

```ts
import { lookup as dnsLookup } from 'node:dns/promises'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { NOSTR } from './nostr-constants'

export type RelayUrlCheck = { ok: true; url: string } | { ok: false; reason: string }
export type LookupImpl = (hostname: string, options: { all: true }) => Promise<Array<{ address: string; family: number }>>

const reject = (reason: string): RelayUrlCheck => ({ ok: false, reason })

// Relay addresses arrive in links and in connection requests written by other people. They are
// hostile input: the checks here keep an approved contact from steering this machine toward
// localhost or the local network. DNS is checked separately, inside the socket's own lookup.
export function checkRelayUrl(input: string): RelayUrlCheck {
  const trimmed = input.trim()
  if (trimmed.length === 0 || trimmed.length > NOSTR.maxRelayUrlLength) {
    return reject(`La dirección del tablero debe tener entre 1 y ${NOSTR.maxRelayUrlLength} caracteres.`)
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return reject('La dirección del tablero no es una URL válida.')
  }
  if (url.protocol !== 'wss:') return reject('La dirección del tablero debe empezar con wss:// (conexión segura).')
  if (url.username || url.password) return reject('La dirección del tablero no puede llevar usuario ni contraseña.')
  if (url.search || url.hash || trimmed.includes('?') || trimmed.includes('#')) {
    return reject('La dirección del tablero no puede llevar parámetros ni fragmentos.')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) !== 0) return reject('La dirección del tablero debe usar un nombre de dominio, no una IP.')
  if (!host.includes('.') || host.endsWith('.localhost') || host === 'localhost') {
    return reject('La dirección del tablero debe ser un dominio público.')
  }
  const path = url.pathname === '/' ? '' : url.pathname
  const normalized = `wss://${url.host.toLowerCase()}${path}`
  if (normalized.length > NOSTR.maxRelayUrlLength) {
    return reject(`La dirección del tablero debe tener entre 1 y ${NOSTR.maxRelayUrlLength} caracteres.`)
  }
  return { ok: true, url: normalized }
}

export function sanitizeRelayList(inputs: readonly unknown[]): string[] {
  const out: string[] = []
  for (const input of inputs) {
    if (typeof input !== 'string') continue
    const checked = checkRelayUrl(input)
    if (checked.ok && !out.includes(checked.url)) out.push(checked.url)
    if (out.length === NOSTR.maxRelaysPerContact) break
  }
  return out
}

// One list per family: a single BlockList treats IPv4 and IPv4-mapped IPv6 as equivalent, so an
// ::ffff:0:0/96 rule in the same list would forbid every public IPv4 address too.
const forbidden4 = new BlockList()
const forbidden6 = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  forbidden4.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7],
  ['fe80::', 10], ['ff00::', 8],
] as const) {
  forbidden6.addSubnet(network, prefix, 'ipv6')
}

export function isForbiddenAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return forbidden4.check(address, 'ipv4')
  if (family === 6) return forbidden6.check(address, 'ipv6')
  return true
}

function lookupError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException
  err.code = code
  return err
}

// Returns a net.LookupFunction that resolves once and refuses the whole answer if any address is
// forbidden. Because the socket connects with exactly what this callback returns, there is no
// second resolution a rebinding DNS server could swap.
export function createSafeLookup(resolve: LookupImpl = (hostname, options) => dnsLookup(hostname, options)): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { all: true })
      .then((answers) => {
        if (answers.length === 0) throw lookupError('ENOTFOUND', `no addresses for ${hostname}`)
        if (answers.some((a) => isForbiddenAddress(a.address))) {
          throw lookupError('EAGENTBRIDGE_FORBIDDEN_ADDRESS', `${hostname} resolves to a forbidden address`)
        }
        const wanted = typeof options.family === 'number' && options.family !== 0 ? answers.filter((a) => a.family === options.family) : answers
        if (wanted.length === 0) throw lookupError('ENOTFOUND', `no addresses of the requested family for ${hostname}`)
        if (options.all) callback(null, wanted)
        else callback(null, wanted[0]!.address, wanted[0]!.family)
      })
      .catch((err: NodeJS.ErrnoException) => callback(err, '', 0))
  }
}

export const safeLookup: LookupFunction = createSafeLookup()
```

In `packages/core/src/index.ts`, append:

```ts
export * from './relay-url'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/relay-url.test.ts && npm run typecheck`
Expected: PASS. If `callback(null, wanted)` does not type-check against `LookupFunction`'s overloads, cast the callback once at the top of the returned function (`const cb = callback as (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void`) and use `cb` — the runtime contract (array when `all`, string plus family otherwise) is what the tests pin.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/relay-url.ts packages/core/src/index.ts packages/core/test/relay-url.test.ts
git commit -m "feat(core): treat relay URLs as hostile input and validate DNS inside the socket lookup"
```

---

### Task 4: SQLite store — private files, serialized transactions, migrations

**Files:**
- Create: `packages/core/src/store/db.ts`, `packages/core/src/store/schema.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/store-db.test.ts`

**Interfaces:**
- Consumes: `UserFacingError`, `nowSeconds` (Task 2); `sanitizeRelayList` (Task 3); `CLI_COMMAND` (existing `packages/core/src/published.ts`).
- Produces:
  - `DB_FILE = 'agentbridge.db'`
  - `type Migration = { version: number; name: string; sql: string }` and `MIGRATIONS: readonly Migration[]` (v1: `contacts`, `requests`, `outbox`, `publish_log`, `cursors`). Plans 2 and 3 append migrations v2 and v3.
  - `type RelayPolicy = (inputs: readonly unknown[]) => string[]`
  - `type Store = { readonly db: DatabaseSync; readonly path: string; readonly relayPolicy: RelayPolicy; tx<T>(fn: () => T): T; close(): void }`
  - `openStore(home: string, options?: { migrations?: readonly Migration[]; relayPolicy?: RelayPolicy }): Promise<Store>` — default `relayPolicy` is `sanitizeRelayList`. **Only tests** pass a permissive policy so contacts can point at local fake boards (`ws://127.0.0.1:…`).
  - `installSqliteWarningFilter(): void`
  - `Store.tx` semantics: runs `fn` inside `BEGIN IMMEDIATE`; a nested call joins the outer transaction; a thrown error rolls the whole outer transaction back; a callback that returns a Promise is rejected and rolled back.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/store-db.test.ts`:

```ts
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { DB_FILE, MIGRATIONS, UserFacingError, installSqliteWarningFilter, openStore, type Migration } from '@agentbridge/core'

const run = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, '../../..')
const newHome = async () => join(await mkdtemp(join(tmpdir(), 'ab-store-')), 'home')
const counterMigration: Migration = { version: 1, name: 'counter', sql: 'CREATE TABLE counter (id INTEGER PRIMARY KEY, n INTEGER NOT NULL); INSERT INTO counter (id, n) VALUES (1, 0);' }

describe('openStore', () => {
  it('creates a private database whose WAL and SHM files are private too', async () => {
    const home = await newHome()
    const store = await openStore(home)
    store.tx(() => store.db.prepare("INSERT INTO cursors (relay, role, day_start, complete, updated_at) VALUES ('wss://a.example.com', 'asker', 0, 0, 1)").run())
    expect((await stat(home)).mode & 0o777).toBe(0o700)
    const files = (await readdir(home)).filter((f) => f.startsWith(DB_FILE))
    expect(files.sort()).toEqual([DB_FILE, `${DB_FILE}-shm`, `${DB_FILE}-wal`])
    for (const f of files) expect((await stat(join(home, f))).mode & 0o777).toBe(0o600)
    store.close()
  })

  it('applies each migration exactly once across reopenings', async () => {
    const home = await newHome()
    const first = await openStore(home)
    const versions = () => first.db.prepare('SELECT version FROM schema_version ORDER BY version').all().map((r) => r.version)
    expect(versions()).toEqual(MIGRATIONS.map((m) => m.version))
    first.close()
    const second = await openStore(home)
    expect(second.db.prepare('SELECT count(*) AS n FROM schema_version').get()?.n).toBe(MIGRATIONS.length)
    second.close()
  })

  it('refuses a database written by a newer AgentBridge, in Spanish', async () => {
    const home = await newHome()
    const store = await openStore(home)
    store.db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (999, ?, 1)').run('future')
    store.close()
    const err = await openStore(home).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UserFacingError)
    expect((err as Error).message).toMatch(/versión más nueva/)
  })

  it('uses sanitizeRelayList as the relay policy unless a test injects another one', async () => {
    const store = await openStore(await newHome())
    expect(store.relayPolicy(['ws://127.0.0.1:7777', 'wss://relay.primal.net/'])).toEqual(['wss://relay.primal.net'])
    store.close()
    const permissive = await openStore(await newHome(), { relayPolicy: (xs) => xs.filter((x): x is string => typeof x === 'string') })
    expect(permissive.relayPolicy(['ws://127.0.0.1:7777'])).toEqual(['ws://127.0.0.1:7777'])
    permissive.close()
  })
})

describe('Store.tx', () => {
  it('commits on success and rolls back on a thrown error', async () => {
    const store = await openStore(await newHome(), { migrations: [counterMigration] })
    const read = () => store.db.prepare('SELECT n FROM counter WHERE id = 1').get()?.n
    store.tx(() => store.db.prepare('UPDATE counter SET n = n + 1').run())
    expect(read()).toBe(1)
    expect(() =>
      store.tx(() => {
        store.db.prepare('UPDATE counter SET n = n + 1').run()
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(read()).toBe(1)
    store.close()
  })

  it('joins an outer transaction, so an inner failure rolls back the outer work', async () => {
    const store = await openStore(await newHome(), { migrations: [counterMigration] })
    expect(() =>
      store.tx(() => {
        store.db.prepare('UPDATE counter SET n = 10').run()
        store.tx(() => {
          store.db.prepare('UPDATE counter SET n = 20').run()
          throw new Error('inner')
        })
      }),
    ).toThrow('inner')
    expect(store.db.prepare('SELECT n FROM counter WHERE id = 1').get()?.n).toBe(0)
    store.close()
  })

  it('rejects asynchronous callbacks and rolls back what they started', async () => {
    const store = await openStore(await newHome(), { migrations: [counterMigration] })
    expect(() =>
      store.tx(() => {
        store.db.prepare('UPDATE counter SET n = 5').run()
        return Promise.resolve()
      }),
    ).toThrow(/synchronous/)
    expect(store.db.prepare('SELECT n FROM counter WHERE id = 1').get()?.n).toBe(0)
    store.close()
  })

  it('serializes read-modify-write across processes without losing updates', async () => {
    const home = await newHome()
    ;(await openStore(home, { migrations: [counterMigration] })).close()
    const script = `import { openStore } from ${JSON.stringify(join(repoRoot, 'packages/core/src/store/db.ts'))}
const store = await openStore(${JSON.stringify(home)}, { migrations: ${JSON.stringify([counterMigration])} })
for (let i = 0; i < 50; i++) {
  store.tx(() => {
    const n = store.db.prepare('SELECT n FROM counter WHERE id = 1').get().n
    store.db.prepare('UPDATE counter SET n = ? WHERE id = 1').run(n + 1)
  })
}
store.close()`
    await Promise.all(Array.from({ length: 4 }, () => run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: repoRoot })))
    const store = await openStore(home, { migrations: [counterMigration] })
    expect(store.db.prepare('SELECT n FROM counter WHERE id = 1').get()?.n).toBe(200)
    store.close()
  })
})

describe('installSqliteWarningFilter', () => {
  it('suppresses only the SQLite experimental warning', async () => {
    installSqliteWarningFilter()
    const seen: string[] = []
    const listener = (w: Error) => seen.push(`${w.name}: ${w.message}`)
    process.on('warning', listener)
    process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning')
    process.emitWarning('Something else is experimental', 'ExperimentalWarning')
    await new Promise((r) => setImmediate(r))
    process.off('warning', listener)
    expect(seen).toEqual(['ExperimentalWarning: Something else is experimental'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/store-db.test.ts`
Expected: FAIL — `openStore` is not exported.

- [ ] **Step 3: Write the schema**

Create `packages/core/src/store/schema.ts`:

```ts
export type Migration = { version: number; name: string; sql: string }

// Plans 2 and 3 append their own versions. Never edit a migration once it has shipped.
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'contacts, outbox and history cursors',
    sql: `
CREATE TABLE contacts (
  pubkey TEXT NOT NULL CHECK (length(pubkey) = 64),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  state TEXT NOT NULL CHECK (state IN ('requested', 'pending', 'approved', 'rejected', 'revoked')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  max_generation_seen INTEGER NOT NULL DEFAULT 0 CHECK (max_generation_seen >= 0),
  request_id TEXT,
  request_rumor_id TEXT,
  local_name TEXT,
  declared_name TEXT,
  note TEXT,
  relays TEXT NOT NULL DEFAULT '[]',
  requested_at INTEGER,
  decided_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (pubkey, direction)
);
CREATE UNIQUE INDEX contacts_local_name ON contacts (direction, local_name) WHERE local_name IS NOT NULL;
CREATE INDEX contacts_requested ON contacts (direction, state, requested_at);

CREATE TABLE requests (
  sender_pubkey TEXT NOT NULL CHECK (length(sender_pubkey) = 64),
  request_id TEXT NOT NULL,
  rumor_id TEXT NOT NULL CHECK (length(rumor_id) = 64),
  decision TEXT CHECK (decision IN ('approved', 'rejected')),
  decision_generation INTEGER,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  PRIMARY KEY (sender_pubkey, request_id)
);

CREATE TABLE outbox (
  recipient TEXT NOT NULL CHECK (length(recipient) = 64),
  rumor_id TEXT NOT NULL CHECK (length(rumor_id) = 64),
  rumor_json TEXT NOT NULL,
  label TEXT NOT NULL,
  pow_bits INTEGER NOT NULL CHECK (pow_bits IN (16, 22)),
  relays TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  policy TEXT NOT NULL CHECK (policy IN ('once', 'retry_until_resolved')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'published', 'abandoned')),
  attempts INTEGER NOT NULL DEFAULT 0,
  first_enqueued_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  last_generated_at INTEGER NOT NULL,
  last_published_at INTEGER,
  claimed_by TEXT,
  claimed_until INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (recipient, rumor_id)
);
CREATE INDEX outbox_due ON outbox (state, next_attempt_at);

CREATE TABLE publish_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL
);
CREATE INDEX publish_log_at ON publish_log (at);

CREATE TABLE cursors (
  relay TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('asker', 'responder')),
  day_start INTEGER NOT NULL CHECK (day_start % 86400 = 0),
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (relay, role, day_start)
);
`,
  },
]
```

The visible pending request is a `contacts` row with `direction = 'inbound'` and `state = 'requested'` (one row per person, so the generation counter survives eviction and re-requests). The `requests` table is the spec's entity record: the immutable `(sender, requestId)` identity, its `rumor_id`, and the decision taken on it, kept 9 days so retries can repeat that decision.

- [ ] **Step 4: Implement the store**

Create `packages/core/src/store/db.ts`:

```ts
import { chmod, mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { UserFacingError } from '../errors'
import { nowSeconds } from '../nostr-constants'
import { CLI_COMMAND } from '../published'
import { sanitizeRelayList } from '../relay-url'
import { MIGRATIONS, type Migration } from './schema'

export { MIGRATIONS, type Migration } from './schema'

export const DB_FILE = 'agentbridge.db'

export type RelayPolicy = (inputs: readonly unknown[]) => string[]

export type Store = {
  readonly db: DatabaseSync
  readonly path: string
  readonly relayPolicy: RelayPolicy
  tx<T>(fn: () => T): T
  close(): void
}

let warningFilterInstalled = false

// Node prints an ExperimentalWarning the first time node:sqlite loads on some versions. It would
// land in the middle of Spanish CLI output. Only that exact warning is dropped.
export function installSqliteWarningFilter(): void {
  if (warningFilterInstalled) return
  warningFilterInstalled = true
  const original = process.emitWarning.bind(process) as (...args: unknown[]) => void
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === 'string' ? warning : warning.message
    const first = rest[0]
    const type =
      typeof first === 'string' ? first : ((first as { type?: string } | undefined)?.type ?? (warning instanceof Error ? warning.name : undefined))
    if (type === 'ExperimentalWarning' && /sqlite/i.test(message)) return
    original(warning, ...rest)
  }) as typeof process.emitWarning
}

export async function openStore(
  home: string,
  options: { migrations?: readonly Migration[]; relayPolicy?: RelayPolicy } = {},
): Promise<Store> {
  installSqliteWarningFilter()
  const { DatabaseSync } = await import('node:sqlite')
  await mkdir(home, { recursive: true, mode: 0o700 })
  await chmod(home, 0o700)
  const path = join(home, DB_FILE)
  // SQLite creates the -wal and -shm files with the main file's permissions, so the main file
  // exists as 0600 before SQLite ever opens it.
  const handle = await open(path, 'a', 0o600)
  await handle.close()
  await chmod(path, 0o600)

  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;')

  let depth = 0
  const tx = <T>(fn: () => T): T => {
    const guard = (result: T): T => {
      if (result instanceof Promise) throw new Error('Store.tx callbacks must be synchronous')
      return result
    }
    if (depth > 0) return guard(fn())
    db.exec('BEGIN IMMEDIATE')
    depth++
    try {
      const result = guard(fn())
      db.exec('COMMIT')
      return result
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // The transaction was already closed by SQLite (for example after a failed COMMIT).
      }
      throw err
    } finally {
      depth--
    }
  }

  const migrations = [...(options.migrations ?? MIGRATIONS)].sort((a, b) => a.version - b.version)
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
  const newest = db.prepare('SELECT max(version) AS v FROM schema_version').get()?.v
  const known = migrations.at(-1)?.version ?? 0
  if (typeof newest === 'number' && newest > known) {
    db.close()
    throw new UserFacingError(
      `La base de datos de AgentBridge en ${home} es de una versión más nueva. Actualiza con: ${CLI_COMMAND} --help`,
    )
  }
  for (const migration of migrations) {
    tx(() => {
      if (db.prepare('SELECT 1 FROM schema_version WHERE version = ?').get(migration.version)) return
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(migration.version, migration.name, nowSeconds())
    })
  }

  return { db, path, relayPolicy: options.relayPolicy ?? sanitizeRelayList, tx, close: () => db.close() }
}
```

In `packages/core/src/index.ts`, append:

```ts
export * from './store/db'
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/store-db.test.ts && npm run typecheck`
Expected: PASS, including the four-process counter reaching exactly 200.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/store/db.ts packages/core/src/store/schema.ts packages/core/src/index.ts packages/core/test/store-db.test.ts
git commit -m "feat(core): private SQLite store with serialized transactions and versioned migrations"
```

---

### Task 5: Contacts — request records, approvals, revocations and generations

**Files:**
- Create: `packages/core/src/store/contacts.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/store-contacts.test.ts`

**Interfaces:**
- Consumes: `Store`, `openStore` (Task 4); `UserFacingError`, `NOSTR` (Task 2); `HandleSchema` (existing `protocol.ts`).
- Produces:
  - `type Direction = 'inbound' | 'outbound'` — `inbound`: this person may ask **me**; `outbound`: **I** may ask this person.
  - `type ContactState = 'requested' | 'pending' | 'approved' | 'rejected' | 'revoked'` (`requested` only inbound, `pending` only outbound).
  - `type Contact = { pubkey: string; direction: Direction; state: ContactState; generation: number; maxGenerationSeen: number; requestId: string | null; requestRumorId: string | null; localName: string | null; declaredName: string | null; note: string | null; relays: string[]; requestedAt: number | null; decidedAt: number | null; createdAt: number; updatedAt: number }`
  - Reads: `getContact(store, pubkey, direction): Contact | null`, `findContactByLocalName(store, direction, localName): Contact | null`, `listContacts(store, direction): Contact[]`, `listPendingRequests(store): Contact[]`, `findRequestsByPrefix(store, prefix): Contact[]`, `slugifyName(input): string`.
  - Responder side:
    - `type IncomingRequest = { pubkey: string; requestId: string; requestRumorId: string; declaredName: string; note: string; relays: readonly unknown[]; now: number }`
    - `type IncomingRequestOutcome = { kind: 'stored'; evictedPubkey: string | null } | { kind: 'duplicate' } | { kind: 'approved_already'; contact: Contact } | { kind: 'rejected_already'; contact: Contact } | { kind: 'ignored_recently_rejected' } | { kind: 'ignored_stale' } | { kind: 'conflict' }`
    - `recordIncomingRequest(store, input: IncomingRequest): IncomingRequestOutcome` — first consults the request record `(pubkey, requestId)`: a different `rumor_id` is a `conflict`; a decided record repeats its decision (`approved_already` only while that approval is still the current permission, otherwise `ignored_stale`); an undecided record is a `duplicate` only while it is still the visible pending request, otherwise `ignored_stale`. A request never seen before from an approved person is recorded as approved with the current generation (`approved_already`), so a person who lost their local state gets the same answer.
    - `approveRequest(store, { pubkey, now }): { contact: Contact; changed: boolean }`, `rejectRequest(store, { pubkey, now })`, `revokeInbound(store, { pubkey, now })` — same return shape; approve and reject also write the decision into the request record.
    - `purgeRequests(store, now): { droppedPending: number; forgottenRecords: number }` — drops pending requests older than 7 days and request records older than 9 days (by decision time, or creation time if undecided).
    - `isQuestionAllowed(store, pubkey, generation): boolean`
  - Asker side: `createOutboundRequest(store, { pubkey, requestId, relays, now }): { contact: Contact; created: boolean }`; `applyApproval(store, { pubkey, requestId, generation, name, relays, now }): 'applied' | 'ignored'` (only for the **pending** request with that id and a higher generation); `applyRejection(store, { pubkey, requestId, now }): 'applied' | 'ignored'`; `applyRevocation(store, { pubkey, generation, now }): 'applied' | 'ignored'` (a higher generation always raises the max observed generation, but a pending request stays pending); `askPermission(store, pubkey): { generation: number } | null`.
  - Every writer runs inside `store.tx`, so plan 2 can compose `revokeInbound` with outbox and inbox changes in one outer transaction.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/store-contacts.test.ts`:

```ts
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  NOSTR,
  UserFacingError,
  applyApproval,
  applyRejection,
  applyRevocation,
  approveRequest,
  askPermission,
  createOutboundRequest,
  findRequestsByPrefix,
  getContact,
  isQuestionAllowed,
  listPendingRequests,
  openStore,
  purgeRequests,
  recordIncomingRequest,
  rejectRequest,
  revokeInbound,
  slugifyName,
  type Store,
} from '@agentbridge/core'

const pk = (n: number) => n.toString(16).padStart(64, '0')
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const rumorId = (n: number) => `f${n.toString(16).padStart(63, '0')}`
const DAY = 86_400
let store: Store

beforeEach(async () => {
  store = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-contacts-')), 'home'))
})

function request(n: number, overrides: Partial<Parameters<typeof recordIncomingRequest>[1]> = {}) {
  return recordIncomingRequest(store, {
    pubkey: pk(n),
    requestId: uuid(n),
    requestRumorId: rumorId(n),
    declaredName: `Persona ${n}`,
    note: 'hola',
    relays: ['wss://relay.primal.net/', 'ws://127.0.0.1:9'],
    now: 1_000_000 + n,
    ...overrides,
  })
}

describe('inbound requests', () => {
  it('stores a request with sanitized relays', () => {
    expect(request(1)).toEqual({ kind: 'stored', evictedPubkey: null })
    expect(getContact(store, pk(1), 'inbound')).toMatchObject({
      state: 'requested',
      generation: 0,
      requestId: uuid(1),
      relays: ['wss://relay.primal.net'],
    })
  })

  it('keeps one pending request per key: a retry is a duplicate, a newer request replaces it, a retry of the replaced one is stale', () => {
    request(1)
    expect(request(1)).toEqual({ kind: 'duplicate' })
    expect(request(1, { requestId: uuid(99), requestRumorId: rumorId(99), note: 'nueva' })).toEqual({ kind: 'stored', evictedPubkey: null })
    expect(getContact(store, pk(1), 'inbound')).toMatchObject({ requestId: uuid(99), note: 'nueva' })
    expect(request(1)).toEqual({ kind: 'ignored_stale' })
    expect(getContact(store, pk(1), 'inbound')?.requestId).toBe(uuid(99))
    expect(listPendingRequests(store)).toHaveLength(1)
  })

  it('reports a conflict when a known request id arrives inside a different rumor', () => {
    request(1)
    expect(request(1, { requestRumorId: rumorId(500) })).toEqual({ kind: 'conflict' })
  })

  it('evicts the oldest pending request when the list is full instead of refusing new ones', () => {
    for (let n = 1; n <= NOSTR.maxPendingRequests; n++) request(n)
    expect(request(500)).toEqual({ kind: 'stored', evictedPubkey: pk(1) })
    expect(getContact(store, pk(1), 'inbound')).toBeNull()
    expect(listPendingRequests(store)).toHaveLength(NOSTR.maxPendingRequests)
  })

  it('keeps the generation counter of a previously approved person when their new request is evicted', () => {
    request(1)
    approveRequest(store, { pubkey: pk(1), now: 2_000_000 })
    revokeInbound(store, { pubkey: pk(1), now: 2_000_001 })
    request(1, { requestId: uuid(77), requestRumorId: rumorId(77), now: 2_000_002 })
    for (let n = 2; n <= NOSTR.maxPendingRequests + 1; n++) request(n, { now: 3_000_000 + n })
    expect(getContact(store, pk(1), 'inbound')).toMatchObject({ state: 'revoked', generation: 2, requestId: null })
  })

  it('approves once, assigns unique local names, and treats a second approval as no change', () => {
    request(1, { declaredName: 'Ana' })
    request(2, { declaredName: 'Ana' })
    const first = approveRequest(store, { pubkey: pk(1), now: 2_000_000 })
    expect(first.changed).toBe(true)
    expect(first.contact).toMatchObject({ state: 'approved', generation: 1, maxGenerationSeen: 1, localName: 'ana' })
    expect(approveRequest(store, { pubkey: pk(2), now: 2_000_001 }).contact.localName).toBe('ana-2')
    expect(approveRequest(store, { pubkey: pk(1), now: 2_000_002 })).toMatchObject({ changed: false, contact: { generation: 1 } })
  })

  it('refuses to approve when there is no request, in Spanish', () => {
    expect(() => approveRequest(store, { pubkey: pk(9), now: 1 })).toThrow(UserFacingError)
  })

  it('repeats the approval for a retried request and for a brand-new request from an approved person', () => {
    request(1)
    approveRequest(store, { pubkey: pk(1), now: 2_000_000 })
    expect(request(1)).toMatchObject({ kind: 'approved_already', contact: { generation: 1 } })
    expect(request(1, { requestId: uuid(40), requestRumorId: rumorId(40) })).toMatchObject({ kind: 'approved_already', contact: { generation: 1 } })
    expect(request(1, { requestId: uuid(40), requestRumorId: rumorId(40) })).toMatchObject({ kind: 'approved_already' })
  })

  it('handles rejection: the same request repeats the decision, others are ignored for 7 days, then accepted again', () => {
    request(1, { now: 1_000_000 })
    expect(rejectRequest(store, { pubkey: pk(1), now: 1_000_100 }).contact.state).toBe('rejected')
    expect(request(1, { now: 1_000_200 })).toMatchObject({ kind: 'rejected_already' })
    expect(request(1, { requestId: uuid(50), requestRumorId: rumorId(50), now: 1_000_300 })).toEqual({ kind: 'ignored_recently_rejected' })
    expect(request(1, { requestId: uuid(51), requestRumorId: rumorId(51), now: 1_000_100 + 7 * DAY })).toEqual({ kind: 'stored', evictedPubkey: null })
  })

  it('revokes with a strictly higher generation and only allows questions carrying the current one', () => {
    request(1)
    approveRequest(store, { pubkey: pk(1), now: 2_000_000 })
    expect(isQuestionAllowed(store, pk(1), 1)).toBe(true)
    expect(revokeInbound(store, { pubkey: pk(1), now: 2_000_001 })).toMatchObject({ changed: true, contact: { state: 'revoked', generation: 2 } })
    expect(isQuestionAllowed(store, pk(1), 1)).toBe(false)
    expect(revokeInbound(store, { pubkey: pk(1), now: 2_000_002 }).changed).toBe(false)
    request(1, { requestId: uuid(60), requestRumorId: rumorId(60), now: 2_000_003 })
    expect(approveRequest(store, { pubkey: pk(1), now: 2_000_004 }).contact.generation).toBe(3)
    expect(isQuestionAllowed(store, pk(1), 3)).toBe(true)
    expect(isQuestionAllowed(store, pk(1), 1)).toBe(false)
  })

  it('never lets a retry of an old approved request displace a newer pending one', () => {
    request(1)
    approveRequest(store, { pubkey: pk(1), now: 2_000_000 })
    revokeInbound(store, { pubkey: pk(1), now: 2_000_001 })
    expect(request(1)).toEqual({ kind: 'ignored_stale' })
    request(1, { requestId: uuid(70), requestRumorId: rumorId(70), now: 2_000_002 })
    expect(request(1)).toEqual({ kind: 'ignored_stale' })
    expect(getContact(store, pk(1), 'inbound')).toMatchObject({ state: 'requested', requestId: uuid(70) })
  })

  it('refuses to revoke someone who never had permission', () => {
    request(1)
    expect(() => revokeInbound(store, { pubkey: pk(1), now: 1 })).toThrow(UserFacingError)
  })

  it('drops pending requests after 7 days and forgets request records after 9', () => {
    request(1, { now: 1_000_000 })
    request(2, { now: 1_000_000 + 6 * DAY })
    expect(purgeRequests(store, 1_000_001 + 7 * DAY)).toEqual({ droppedPending: 1, forgottenRecords: 0 })
    expect(listPendingRequests(store).map((c) => c.pubkey)).toEqual([pk(2)])
    expect(purgeRequests(store, 1_000_000 + 9 * DAY)).toEqual({ droppedPending: 0, forgottenRecords: 1 })
    expect(request(1, { now: 1_000_000 + 9 * DAY })).toEqual({ kind: 'stored', evictedPubkey: null })
  })

  it('finds pending requests by a key prefix of at least 8 hex characters', () => {
    request(0x1234abcd)
    expect(findRequestsByPrefix(store, pk(0x1234abcd).slice(0, 8))).toHaveLength(1)
    expect(() => findRequestsByPrefix(store, 'abc')).toThrow(UserFacingError)
    expect(() => findRequestsByPrefix(store, "'; DROP TABLE contacts; --")).toThrow(UserFacingError)
  })
})

describe('outbound requests', () => {
  const link = { relays: ['wss://nos.lol'] }

  it('creates one pending request per person and returns the same request id on retries', () => {
    const first = createOutboundRequest(store, { pubkey: pk(1), requestId: uuid(1), ...link, now: 10 })
    expect(first).toMatchObject({ created: true, contact: { state: 'pending', requestId: uuid(1), relays: ['wss://nos.lol'] } })
    expect(createOutboundRequest(store, { pubkey: pk(1), requestId: uuid(2), ...link, now: 11 })).toMatchObject({
      created: false,
      contact: { requestId: uuid(1) },
    })
  })

  it('refuses a link without any valid relay, in Spanish', () => {
    expect(() => createOutboundRequest(store, { pubkey: pk(1), requestId: uuid(1), relays: ['ws://127.0.0.1:1'], now: 1 })).toThrow(UserFacingError)
  })

  it('applies approvals only for the pending request and a higher generation; late older messages are ignored', () => {
    createOutboundRequest(store, { pubkey: pk(1), requestId: uuid(1), ...link, now: 10 })
    expect(applyApproval(store, { pubkey: pk(1), requestId: uuid(9), generation: 1, name: 'Dev', relays: [], now: 11 })).toBe('ignored')
    expect(applyApproval(store, { pubkey: pk(1), requestId: uuid(1), generation: 3, name: 'Dev Ejemplo', relays: ['wss://relay.primal.net'], now: 12 })).toBe('applied')
    expect(askPermission(store, pk(1))).toEqual({ generation: 3 })
    expect(getContact(store, pk(1), 'outbound')).toMatchObject({ localName: 'dev-ejemplo', relays: ['wss://relay.primal.net'] })
    expect(applyRevocation(store, { pubkey: pk(1), generation: 2, now: 13 })).toBe('ignored')
    expect(askPermission(store, pk(1))).toEqual({ generation: 3 })
    expect(applyRevocation(store, { pubkey: pk(1), generation: 4, now: 14 })).toBe('applied')
    expect(askPermission(store, pk(1))).toBeNull()
    expect(applyApproval(store, { pubkey: pk(1), requestId: uuid(1), generation: 5, name: 'Dev', relays: [], now: 15 })).toBe('ignored')
  })

  it('never turns a rejected request into an approval', () => {
    createOutboundRequest(store, { pubkey: pk(1), requestId: uuid(1), ...link, now: 10 })
    expect(applyRejection(store, { pubkey: pk(1), requestId: uuid(2), now: 11 })).toBe('ignored')
    expect(applyRejection(store, { pubkey: pk(1), requestId: uuid(1), now: 12 })).toBe('applied')
    expect(applyApproval(store, { pubkey: pk(1), requestId: uuid(1), generation: 1, name: 'Dev', relays: [], now: 13 })).toBe('ignored')
    expect(getContact(store, pk(1), 'outbound')?.state).toBe('rejected')
  })

  it('keeps a pending request pending when a late revocation of an older permission arrives', () => {
    createOutboundRequest(store, { pubkey: pk(1), requestId: uuid(1), ...link, now: 10 })
    expect(applyRevocation(store, { pubkey: pk(1), generation: 2, now: 11 })).toBe('applied')
    expect(getContact(store, pk(1), 'outbound')).toMatchObject({ state: 'pending', maxGenerationSeen: 2 })
    expect(applyApproval(store, { pubkey: pk(1), requestId: uuid(1), generation: 3, name: 'Dev', relays: [], now: 12 })).toBe('applied')
  })

  it('refuses a new request when permission already exists, and allows one after a rejection', () => {
    createOutboundRequest(store, { pubkey: pk(1), requestId: uuid(1), ...link, now: 10 })
    applyApproval(store, { pubkey: pk(1), requestId: uuid(1), generation: 1, name: 'Dev', relays: [], now: 11 })
    expect(() => createOutboundRequest(store, { pubkey: pk(1), requestId: uuid(2), ...link, now: 12 })).toThrow(UserFacingError)
    createOutboundRequest(store, { pubkey: pk(2), requestId: uuid(3), ...link, now: 10 })
    applyRejection(store, { pubkey: pk(2), requestId: uuid(3), now: 11 })
    expect(createOutboundRequest(store, { pubkey: pk(2), requestId: uuid(4), ...link, now: 12 })).toMatchObject({
      created: true,
      contact: { requestId: uuid(4) },
    })
  })
})

describe('slugifyName', () => {
  it.each([
    ['María Núñez', 'maria-nunez'],
    ['  Dev   Ejemplo!! ', 'dev-ejemplo'],
    ['!!!', 'contacto'],
    ['x', 'contacto'],
    ['a'.repeat(60), 'a'.repeat(24)],
  ])('%j becomes %j', (input, expected) => {
    expect(slugifyName(input)).toBe(expected)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/store-contacts.test.ts`
Expected: FAIL — `recordIncomingRequest` is not exported.

- [ ] **Step 3: Implement**

Create `packages/core/src/store/contacts.ts`:

```ts
import { UserFacingError } from '../errors'
import { NOSTR } from '../nostr-constants'
import { HandleSchema } from '../protocol'
import type { Store } from './db'

export type Direction = 'inbound' | 'outbound'
export type ContactState = 'requested' | 'pending' | 'approved' | 'rejected' | 'revoked'

export type Contact = {
  pubkey: string
  direction: Direction
  state: ContactState
  generation: number
  maxGenerationSeen: number
  requestId: string | null
  requestRumorId: string | null
  localName: string | null
  declaredName: string | null
  note: string | null
  relays: string[]
  requestedAt: number | null
  decidedAt: number | null
  createdAt: number
  updatedAt: number
}

export type IncomingRequest = {
  pubkey: string
  requestId: string
  requestRumorId: string
  declaredName: string
  note: string
  relays: readonly unknown[]
  now: number
}

export type IncomingRequestOutcome =
  | { kind: 'stored'; evictedPubkey: string | null }
  | { kind: 'duplicate' }
  | { kind: 'approved_already'; contact: Contact }
  | { kind: 'rejected_already'; contact: Contact }
  | { kind: 'ignored_recently_rejected' }
  | { kind: 'ignored_stale' }
  | { kind: 'conflict' }

type ContactRow = {
  pubkey: string
  direction: Direction
  state: ContactState
  generation: number
  max_generation_seen: number
  request_id: string | null
  request_rumor_id: string | null
  local_name: string | null
  declared_name: string | null
  note: string | null
  relays: string
  requested_at: number | null
  decided_at: number | null
  created_at: number
  updated_at: number
}

type RequestRow = {
  sender_pubkey: string
  request_id: string
  rumor_id: string
  decision: 'approved' | 'rejected' | null
  decision_generation: number | null
  created_at: number
  decided_at: number | null
}

const HEX_64 = /^[0-9a-f]{64}$/

function assertPubkey(pubkey: string): void {
  if (!HEX_64.test(pubkey)) throw new Error('contacts: pubkey must be 64 lowercase hex characters')
}

function toContact(row: ContactRow): Contact {
  return {
    pubkey: row.pubkey,
    direction: row.direction,
    state: row.state,
    generation: row.generation,
    maxGenerationSeen: row.max_generation_seen,
    requestId: row.request_id,
    requestRumorId: row.request_rumor_id,
    localName: row.local_name,
    declaredName: row.declared_name,
    note: row.note,
    relays: JSON.parse(row.relays) as string[],
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const selectRow = (store: Store, pubkey: string, direction: Direction) =>
  store.db.prepare('SELECT * FROM contacts WHERE pubkey = ? AND direction = ?').get(pubkey, direction) as ContactRow | undefined

const selectRequest = (store: Store, sender: string, requestId: string) =>
  store.db.prepare('SELECT * FROM requests WHERE sender_pubkey = ? AND request_id = ?').get(sender, requestId) as RequestRow | undefined

function decideRequest(store: Store, sender: string, requestId: string, decision: 'approved' | 'rejected', generation: number | null, now: number): void {
  store.db
    .prepare('UPDATE requests SET decision = ?, decision_generation = ?, decided_at = ? WHERE sender_pubkey = ? AND request_id = ?')
    .run(decision, generation, now, sender, requestId)
}

export function getContact(store: Store, pubkey: string, direction: Direction): Contact | null {
  const row = selectRow(store, pubkey, direction)
  return row ? toContact(row) : null
}

export function findContactByLocalName(store: Store, direction: Direction, localName: string): Contact | null {
  const row = store.db.prepare('SELECT * FROM contacts WHERE direction = ? AND local_name = ?').get(direction, localName) as ContactRow | undefined
  return row ? toContact(row) : null
}

export function listContacts(store: Store, direction: Direction): Contact[] {
  return (store.db.prepare('SELECT * FROM contacts WHERE direction = ? ORDER BY local_name, created_at').all(direction) as ContactRow[]).map(toContact)
}

export function listPendingRequests(store: Store): Contact[] {
  return (
    store.db.prepare("SELECT * FROM contacts WHERE direction = 'inbound' AND state = 'requested' ORDER BY requested_at, rowid").all() as ContactRow[]
  ).map(toContact)
}

export function findRequestsByPrefix(store: Store, prefix: string): Contact[] {
  const normalized = prefix.trim().toLowerCase()
  if (!/^[0-9a-f]{8,64}$/.test(normalized)) {
    throw new UserFacingError('El identificador debe tener al menos 8 caracteres hexadecimales, tal como aparece en la lista de solicitudes.')
  }
  return (
    store.db
      .prepare("SELECT * FROM contacts WHERE direction = 'inbound' AND state = 'requested' AND pubkey LIKE ? ORDER BY requested_at")
      .all(`${normalized}%`) as ContactRow[]
  ).map(toContact)
}

export function slugifyName(input: string): string {
  const base = input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 24)
    .replace(/-+$/, '')
  return HandleSchema.safeParse(base).success ? base : 'contacto'
}

function uniqueLocalName(store: Store, direction: Direction, declared: string): string {
  const base = slugifyName(declared)
  for (let i = 1; i < 10_000; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`
    if (!findContactByLocalName(store, direction, candidate)) return candidate
  }
  throw new Error('contacts: could not allocate a local name')
}

// A person who was ever approved keeps their contact row forever (generation counter, max observed
// generation): only the visible pending request goes away. Request records are left alone.
function dropRequest(store: Store, pubkey: string, now: number): void {
  const row = selectRow(store, pubkey, 'inbound')
  if (!row) return
  if (row.generation > 0) {
    store.db
      .prepare(
        "UPDATE contacts SET state = 'revoked', request_id = NULL, request_rumor_id = NULL, note = NULL, requested_at = NULL, updated_at = ? WHERE pubkey = ? AND direction = 'inbound'",
      )
      .run(now, pubkey)
  } else {
    store.db.prepare("DELETE FROM contacts WHERE pubkey = ? AND direction = 'inbound'").run(pubkey)
  }
}

function makeRoom(store: Store, now: number): string | null {
  const count = store.db.prepare("SELECT count(*) AS n FROM contacts WHERE direction = 'inbound' AND state = 'requested'").get()?.n as number
  if (count < NOSTR.maxPendingRequests) return null
  const oldest = store.db
    .prepare("SELECT pubkey FROM contacts WHERE direction = 'inbound' AND state = 'requested' ORDER BY requested_at, rowid LIMIT 1")
    .get() as { pubkey: string }
  dropRequest(store, oldest.pubkey, now)
  return oldest.pubkey
}

export function recordIncomingRequest(store: Store, input: IncomingRequest): IncomingRequestOutcome {
  assertPubkey(input.pubkey)
  const declaredName = input.declaredName.trim().slice(0, 80)
  const note = input.note.slice(0, 500)
  return store.tx((): IncomingRequestOutcome => {
    const row = selectRow(store, input.pubkey, 'inbound')
    const record = selectRequest(store, input.pubkey, input.requestId)

    if (record) {
      if (record.rumor_id !== input.requestRumorId) return { kind: 'conflict' }
      if (record.decision === 'rejected') return row ? { kind: 'rejected_already', contact: toContact(row) } : { kind: 'ignored_stale' }
      if (record.decision === 'approved') {
        return row?.state === 'approved' && row.generation === record.decision_generation
          ? { kind: 'approved_already', contact: toContact(row) }
          : { kind: 'ignored_stale' }
      }
      return row?.state === 'requested' && row.request_id === input.requestId ? { kind: 'duplicate' } : { kind: 'ignored_stale' }
    }

    if (row?.state === 'approved') {
      // The asker lost track of a permission it already has. Record this request as approved with the
      // current generation, so its retries repeat the same answer.
      store.db
        .prepare(
          "INSERT INTO requests (sender_pubkey, request_id, rumor_id, decision, decision_generation, created_at, decided_at) VALUES (?, ?, ?, 'approved', ?, ?, ?)",
        )
        .run(input.pubkey, input.requestId, input.requestRumorId, row.generation, input.now, input.now)
      return { kind: 'approved_already', contact: toContact(row) }
    }
    if (row?.state === 'rejected' && row.decided_at !== null && input.now - row.decided_at < NOSTR.rejectedRequestCooldownSeconds) {
      return { kind: 'ignored_recently_rejected' }
    }

    store.db
      .prepare('INSERT INTO requests (sender_pubkey, request_id, rumor_id, created_at) VALUES (?, ?, ?, ?)')
      .run(input.pubkey, input.requestId, input.requestRumorId, input.now)
    const relays = JSON.stringify(store.relayPolicy(input.relays))
    const evictedPubkey = row?.state === 'requested' ? null : makeRoom(store, input.now)
    if (row) {
      store.db
        .prepare(
          "UPDATE contacts SET state = 'requested', request_id = ?, request_rumor_id = ?, declared_name = ?, note = ?, relays = ?, requested_at = ?, decided_at = NULL, updated_at = ? WHERE pubkey = ? AND direction = 'inbound'",
        )
        .run(input.requestId, input.requestRumorId, declaredName, note, relays, input.now, input.now, input.pubkey)
    } else {
      store.db
        .prepare(
          "INSERT INTO contacts (pubkey, direction, state, request_id, request_rumor_id, declared_name, note, relays, requested_at, created_at, updated_at) VALUES (?, 'inbound', 'requested', ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(input.pubkey, input.requestId, input.requestRumorId, declaredName, note, relays, input.now, input.now, input.now)
    }
    return { kind: 'stored', evictedPubkey }
  })
}

export function approveRequest(store: Store, input: { pubkey: string; now: number }): { contact: Contact; changed: boolean } {
  return store.tx(() => {
    const row = selectRow(store, input.pubkey, 'inbound')
    if (row?.state === 'approved') return { contact: toContact(row), changed: false }
    if (row?.state !== 'requested' || row.request_id === null) throw new UserFacingError('No hay una solicitud pendiente de esa persona.')
    const generation = row.generation + 1
    const localName = row.local_name ?? uniqueLocalName(store, 'inbound', row.declared_name ?? '')
    store.db
      .prepare(
        "UPDATE contacts SET state = 'approved', generation = ?, max_generation_seen = ?, local_name = ?, decided_at = ?, updated_at = ? WHERE pubkey = ? AND direction = 'inbound'",
      )
      .run(generation, generation, localName, input.now, input.now, input.pubkey)
    decideRequest(store, input.pubkey, row.request_id, 'approved', generation, input.now)
    return { contact: toContact(selectRow(store, input.pubkey, 'inbound')!), changed: true }
  })
}

export function rejectRequest(store: Store, input: { pubkey: string; now: number }): { contact: Contact; changed: boolean } {
  return store.tx(() => {
    const row = selectRow(store, input.pubkey, 'inbound')
    if (row?.state === 'rejected') return { contact: toContact(row), changed: false }
    if (row?.state !== 'requested' || row.request_id === null) throw new UserFacingError('No hay una solicitud pendiente de esa persona.')
    store.db
      .prepare("UPDATE contacts SET state = 'rejected', decided_at = ?, updated_at = ? WHERE pubkey = ? AND direction = 'inbound'")
      .run(input.now, input.now, input.pubkey)
    decideRequest(store, input.pubkey, row.request_id, 'rejected', null, input.now)
    return { contact: toContact(selectRow(store, input.pubkey, 'inbound')!), changed: true }
  })
}

export function revokeInbound(store: Store, input: { pubkey: string; now: number }): { contact: Contact; changed: boolean } {
  return store.tx(() => {
    const row = selectRow(store, input.pubkey, 'inbound')
    if (row?.state === 'revoked') return { contact: toContact(row), changed: false }
    if (row?.state !== 'approved') throw new UserFacingError('Esa persona no tiene permiso para preguntarte.')
    const generation = row.generation + 1
    store.db
      .prepare(
        "UPDATE contacts SET state = 'revoked', generation = ?, max_generation_seen = ?, decided_at = ?, updated_at = ? WHERE pubkey = ? AND direction = 'inbound'",
      )
      .run(generation, generation, input.now, input.now, input.pubkey)
    return { contact: toContact(selectRow(store, input.pubkey, 'inbound')!), changed: true }
  })
}

export function purgeRequests(store: Store, now: number): { droppedPending: number; forgottenRecords: number } {
  return store.tx(() => {
    const stale = store.db
      .prepare("SELECT pubkey FROM contacts WHERE direction = 'inbound' AND state = 'requested' AND requested_at <= ?")
      .all(now - NOSTR.requestMaxAgeSeconds) as Array<{ pubkey: string }>
    for (const { pubkey } of stale) dropRequest(store, pubkey, now)
    const forgotten = store.db
      .prepare('DELETE FROM requests WHERE coalesce(decided_at, created_at) <= ?')
      .run(now - NOSTR.decisionRetentionSeconds)
    return { droppedPending: stale.length, forgottenRecords: Number(forgotten.changes) }
  })
}

export function isQuestionAllowed(store: Store, pubkey: string, generation: number): boolean {
  const row = selectRow(store, pubkey, 'inbound')
  return row?.state === 'approved' && row.generation === generation
}

export function createOutboundRequest(
  store: Store,
  input: { pubkey: string; requestId: string; relays: readonly unknown[]; now: number },
): { contact: Contact; created: boolean } {
  assertPubkey(input.pubkey)
  return store.tx(() => {
    const row = selectRow(store, input.pubkey, 'outbound')
    if (row?.state === 'pending') return { contact: toContact(row), created: false }
    if (row?.state === 'approved') throw new UserFacingError('Ya tienes permiso para preguntarle a esa persona.')
    const relays = store.relayPolicy(input.relays)
    if (relays.length === 0) {
      throw new UserFacingError('Ese enlace no trae ningún tablero válido, así que no hay dónde dejar tu solicitud.')
    }
    if (row) {
      store.db
        .prepare(
          "UPDATE contacts SET state = 'pending', request_id = ?, relays = ?, requested_at = ?, decided_at = NULL, updated_at = ? WHERE pubkey = ? AND direction = 'outbound'",
        )
        .run(input.requestId, JSON.stringify(relays), input.now, input.now, input.pubkey)
    } else {
      store.db
        .prepare(
          "INSERT INTO contacts (pubkey, direction, state, request_id, relays, requested_at, created_at, updated_at) VALUES (?, 'outbound', 'pending', ?, ?, ?, ?, ?)",
        )
        .run(input.pubkey, input.requestId, JSON.stringify(relays), input.now, input.now, input.now)
    }
    return { contact: toContact(selectRow(store, input.pubkey, 'outbound')!), created: true }
  })
}

export function applyApproval(
  store: Store,
  input: { pubkey: string; requestId: string; generation: number; name: string; relays: readonly unknown[]; now: number },
): 'applied' | 'ignored' {
  return store.tx(() => {
    const row = selectRow(store, input.pubkey, 'outbound')
    if (!row || row.state !== 'pending' || row.request_id !== input.requestId || input.generation <= row.max_generation_seen) return 'ignored'
    const sanitized = store.relayPolicy(input.relays)
    const relays = sanitized.length > 0 ? JSON.stringify(sanitized) : row.relays
    const declared = input.name.trim().slice(0, 80)
    const localName = row.local_name ?? uniqueLocalName(store, 'outbound', declared)
    store.db
      .prepare(
        "UPDATE contacts SET state = 'approved', generation = ?, max_generation_seen = ?, declared_name = ?, local_name = ?, relays = ?, decided_at = ?, updated_at = ? WHERE pubkey = ? AND direction = 'outbound'",
      )
      .run(input.generation, input.generation, declared, localName, relays, input.now, input.now, input.pubkey)
    return 'applied'
  })
}

export function applyRejection(store: Store, input: { pubkey: string; requestId: string; now: number }): 'applied' | 'ignored' {
  return store.tx(() => {
    const row = selectRow(store, input.pubkey, 'outbound')
    if (row?.state !== 'pending' || row.request_id !== input.requestId) return 'ignored'
    store.db
      .prepare("UPDATE contacts SET state = 'rejected', decided_at = ?, updated_at = ? WHERE pubkey = ? AND direction = 'outbound'")
      .run(input.now, input.now, input.pubkey)
    return 'applied'
  })
}

// A newer revocation always raises the max observed generation. A request that is still pending
// stays pending: the revocation is about an older permission, and the pending request may still be
// approved with a higher generation.
export function applyRevocation(store: Store, input: { pubkey: string; generation: number; now: number }): 'applied' | 'ignored' {
  return store.tx(() => {
    const row = selectRow(store, input.pubkey, 'outbound')
    if (!row || input.generation <= row.max_generation_seen) return 'ignored'
    store.db
      .prepare(
        "UPDATE contacts SET state = CASE WHEN state = 'pending' THEN 'pending' ELSE 'revoked' END, max_generation_seen = ?, decided_at = ?, updated_at = ? WHERE pubkey = ? AND direction = 'outbound'",
      )
      .run(input.generation, input.now, input.now, input.pubkey)
    return 'applied'
  })
}

export function askPermission(store: Store, pubkey: string): { generation: number } | null {
  const row = selectRow(store, pubkey, 'outbound')
  return row?.state === 'approved' ? { generation: row.generation } : null
}
```

In `packages/core/src/index.ts`, append:

```ts
export * from './store/contacts'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/store-contacts.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/store/contacts.ts packages/core/src/index.ts packages/core/test/store-contacts.test.ts
git commit -m "feat(core): contacts with request records, bounded requests, strictly increasing generations and ordered permission changes"
```

---

### Task 6: Outbox — one row per logical message, authorized claims, publish reservations and caps

**Files:**
- Create: `packages/core/src/store/outbox.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/store-outbox.test.ts`

**Interfaces:**
- Consumes: `Store` (Task 4); `NOSTR` (Task 2).
- Produces:
  - `type OutboxPolicy = 'once' | 'retry_until_resolved'` — `once`: responses (receipt, answer, rejected, connect decisions), regenerated only on request; `retry_until_resolved`: the asker's questions and connection requests, re-published on the retry schedule until `resolveOutboxMessage` or 7 days.
  - `type OutboxRumor = { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string }` (structurally identical to `Rumor` from Task 10).
  - `type EnqueueInput = { recipient: string; rumor: OutboxRumor; label: string; powBits: 16 | 22; relays: readonly string[]; policy: OutboxPolicy; now: number }`
  - `type EnqueueOutcome = 'enqueued' | 'postponed_cap' | 'already_pending' | 'regenerated' | 'regeneration_too_soon' | 'abandoned'`
  - `type OutboxItem = { recipient: string; rumorId: string; rumor: OutboxRumor; label: string; powBits: 16 | 22; relays: string[]; policy: OutboxPolicy; attempts: number; firstEnqueuedAt: number }`
  - `enqueue(store, input): EnqueueOutcome`
  - `claimDue(store, { owner, now, limit, authorize }): OutboxItem[]` — in one transaction: abandons pending rows past their window (`retry_until_resolved` 7 days, `once` 9 days after first enqueue), then for each due, unclaimed row calls `authorize(item)`; refused rows are abandoned, accepted rows are claimed for 2 minutes. Plans 2 and 3 pass the permission and generation check as `authorize`.
  - `stillClaimed(store, { recipient, rumorId, owner, now }): boolean`
  - `reservePublish(store, { recipient, rumorId, owner, now }): 'reserved' | 'claim_lost' | 'over_budget'` — called from the `beforeSend` guard of `BoardPool.publish` (Task 14), so it runs at the moment of the write; it re-checks the claim and takes one of the 60 publishes allowed per minute (one publish = one logical message to up to 5 relays: the guard reserves on the first write and only re-checks `stillClaimed` on the others).
  - `postpone(store, { recipient, rumorId, owner, retryAt }): 'ok' | 'claim_lost'` — releases a claim without counting an attempt (use after `over_budget`).
  - `markPublished(store, { recipient, rumorId, owner, now }): 'ok' | 'claim_lost'`
  - `markFailed(store, { recipient, rumorId, owner, now }): 'ok' | 'claim_lost'`
  - `resolveOutboxMessage(store, { recipient, rumorId }): boolean`
  - `deleteUnclaimedFor(store, { recipient, now }): number`
  - `purgeOutbox(store, now): number` — deletes every row whose rumor was created more than 7 days ago, whatever its state, and old publish reservations.
- Relay lists are **not** sanitized here: they come from contacts, which already applied `store.relayPolicy`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/store-outbox.test.ts`:

```ts
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  NOSTR,
  claimDue,
  deleteUnclaimedFor,
  enqueue,
  markFailed,
  markPublished,
  openStore,
  postpone,
  purgeOutbox,
  reservePublish,
  resolveOutboxMessage,
  stillClaimed,
  type EnqueueInput,
  type Store,
} from '@agentbridge/core'

const hex = (n: number) => n.toString(16).padStart(64, '0')
const RECIPIENT = hex(0xabc)
const OTHER = hex(0xdef)
const T0 = 2_000_000_000
const allow = () => true
let store: Store

beforeEach(async () => {
  store = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-outbox-')), 'home'))
})

function input(n: number, overrides: Partial<EnqueueInput> = {}): EnqueueInput {
  return {
    recipient: RECIPIENT,
    rumor: { id: hex(n), pubkey: hex(1), created_at: T0, kind: NOSTR.rumorKind, tags: [], content: `mensaje ${n}` },
    label: 'answer',
    powBits: 16,
    relays: ['wss://relay.primal.net'],
    policy: 'once',
    now: T0,
    ...overrides,
  }
}

const claimOne = (owner: string, now: number) => claimDue(store, { owner, now, limit: 10, authorize: allow })
const rowState = (n: number, recipient = RECIPIENT) =>
  store.db.prepare('SELECT state, attempts, next_attempt_at FROM outbox WHERE recipient = ? AND rumor_id = ?').get(recipient, hex(n)) as
    | { state: string; attempts: number; next_attempt_at: number }
    | undefined

describe('enqueue', () => {
  it('stores one row per logical message', () => {
    expect(enqueue(store, input(1))).toBe('enqueued')
    expect(enqueue(store, input(1))).toBe('already_pending')
    expect(store.db.prepare('SELECT count(*) AS n FROM outbox').get()?.n).toBe(1)
  })

  it('rejects malformed input as a programming error', () => {
    expect(() => enqueue(store, input(1, { relays: [] }))).toThrow(/relays/)
    expect(() => enqueue(store, input(1, { recipient: 'nope' }))).toThrow(/hex/)
  })

  it('regenerates a published response at most once every 10 minutes', () => {
    enqueue(store, input(1))
    claimOne('a', T0)
    expect(markPublished(store, { recipient: RECIPIENT, rumorId: hex(1), owner: 'a', now: T0 })).toBe('ok')
    expect(enqueue(store, input(1, { now: T0 + 60 }))).toBe('regeneration_too_soon')
    expect(enqueue(store, input(1, { now: T0 + NOSTR.regenerationIntervalSeconds }))).toBe('regenerated')
    expect(claimOne('a', T0 + NOSTR.regenerationIntervalSeconds).map((i) => i.rumorId)).toEqual([hex(1)])
  })

  it('stores but postpones messages beyond the per-recipient byte cap', () => {
    const big = (n: number) => input(n, { rumor: { ...input(n).rumor, content: 'x'.repeat(300_000) } })
    expect([1, 2, 3].map((n) => enqueue(store, big(n)))).toEqual(['enqueued', 'enqueued', 'enqueued'])
    expect(enqueue(store, big(4))).toBe('postponed_cap')
    expect(claimOne('a', T0).map((i) => i.rumorId)).toEqual([hex(1), hex(2), hex(3)])
    for (const n of [1, 2, 3]) markPublished(store, { recipient: RECIPIENT, rumorId: hex(n), owner: 'a', now: T0 })
    expect(claimOne('b', T0 + NOSTR.capPostponeSeconds).map((i) => i.rumorId)).toEqual([hex(4)])
  })
})

describe('claims', () => {
  it('gives a due row to exactly one owner until its claim expires', () => {
    enqueue(store, input(1))
    expect(claimOne('a', T0)).toHaveLength(1)
    expect(claimOne('b', T0 + 1)).toHaveLength(0)
    expect(stillClaimed(store, { recipient: RECIPIENT, rumorId: hex(1), owner: 'a', now: T0 + 1 })).toBe(true)
    expect(stillClaimed(store, { recipient: RECIPIENT, rumorId: hex(1), owner: 'b', now: T0 + 1 })).toBe(false)
    const expired = T0 + NOSTR.claimSeconds
    expect(stillClaimed(store, { recipient: RECIPIENT, rumorId: hex(1), owner: 'a', now: expired })).toBe(false)
    expect(claimOne('b', expired)).toHaveLength(1)
    expect(markPublished(store, { recipient: RECIPIENT, rumorId: hex(1), owner: 'a', now: expired + 1 })).toBe('claim_lost')
    expect(markPublished(store, { recipient: RECIPIENT, rumorId: hex(1), owner: 'b', now: expired + 1 })).toBe('ok')
  })

  it('asks authorize inside the claim and abandons what it refuses', () => {
    enqueue(store, input(1))
    enqueue(store, input(2, { recipient: OTHER }))
    const claimed = claimDue(store, { owner: 'a', now: T0, limit: 10, authorize: (item) => item.recipient === RECIPIENT })
    expect(claimed.map((i) => i.recipient)).toEqual([RECIPIENT])
    expect(rowState(2, OTHER)?.state).toBe('abandoned')
    expect(claimDue(store, { owner: 'b', now: T0 + 1_000, limit: 10, authorize: allow }).map((i) => i.recipient)).toEqual([RECIPIENT])
  })
})

describe('publish reservations', () => {
  it('allows at most 60 publishes per minute, reserved right before publishing', () => {
    for (let n = 1; n <= 70; n++) enqueue(store, input(n))
    expect(claimDue(store, { owner: 'a', now: T0, limit: 100, authorize: allow })).toHaveLength(70)
    const reserve = (n: number, now: number) => reservePublish(store, { recipient: RECIPIENT, rumorId: hex(n), owner: 'a', now })
    const first = Array.from({ length: 70 }, (_, i) => reserve(i + 1, T0))
    expect(first.filter((r) => r === 'reserved')).toHaveLength(60)
    expect(first.filter((r) => r === 'over_budget')).toHaveLength(10)
    expect(reserve(61, T0 + 60)).toBe('reserved')
  })

  it('refuses a reservation once the claim is lost', () => {
    enqueue(store, input(1))
    claimOne('a', T0)
    claimOne('b', T0 + NOSTR.claimSeconds)
    expect(reservePublish(store, { recipient: RECIPIENT, rumorId: hex(1), owner: 'a', now: T0 + NOSTR.claimSeconds })).toBe('claim_lost')
  })

  it('postpones a claimed row without counting an attempt', () => {
    enqueue(store, input(1))
    claimOne('a', T0)
    expect(postpone(store, { recipient: RECIPIENT, rumorId: hex(1), owner: 'a', retryAt: T0 + 300 })).toBe('ok')
    expect(claimOne('a', T0 + 299)).toHaveLength(0)
    expect(claimOne('a', T0 + 300)).toHaveLength(1)
    expect(rowState(1)?.attempts).toBe(0)
  })
})

describe('schedules', () => {
  const retry = (n: number) => input(n, { policy: 'retry_until_resolved', label: 'question' })

  it('re-publishes retried messages every 5 minutes for an hour, then every 30 minutes, and never after 7 days', () => {
    enqueue(store, retry(1))
    const publishAt = (now: number) => {
      expect(claimOne('a', now)).toHaveLength(1)
      expect(markPublished(store, { recipient: RECIPIENT, rumorId: hex(1), owner: 'a', now })).toBe('ok')
      return rowState(1)
    }
    expect(publishAt(T0)).toMatchObject({ state: 'pending', next_attempt_at: T0 + 300 })
    expect(claimOne('a', T0 + 299)).toHaveLength(0)
    expect(publishAt(T0 + 3_600)).toMatchObject({ state: 'pending', next_attempt_at: T0 + 3_600 + 1_800 })
    expect(claimOne('a', T0 + NOSTR.retryWindowSeconds)).toHaveLength(0)
    expect(rowState(1)?.state).toBe('abandoned')
  })

  it('abandons a response nobody could deliver for 9 days instead of publishing it late', () => {
    enqueue(store, input(1))
    expect(claimOne('a', T0 + NOSTR.decisionRetentionSeconds)).toHaveLength(0)
    expect(rowState(1)?.state).toBe('abandoned')
  })

  it('backs off failed attempts exponentially up to 30 minutes', () => {
    enqueue(store, input(1))
    let now = T0
    const delays: number[] = []
    for (let i = 0; i < 8; i++) {
      expect(claimOne('a', now)).toHaveLength(1)
      markFailed(store, { recipient: RECIPIENT, rumorId: hex(1), owner: 'a', now })
      const next = rowState(1)!.next_attempt_at
      delays.push(next - now)
      now = next
    }
    expect(delays).toEqual([30, 60, 120, 240, 480, 960, 1_800, 1_800])
  })

  it('resolveOutboxMessage stops a retried message for good', () => {
    enqueue(store, retry(1))
    expect(resolveOutboxMessage(store, { recipient: RECIPIENT, rumorId: hex(1) })).toBe(true)
    expect(claimOne('a', T0)).toHaveLength(0)
  })
})

describe('cleanup', () => {
  it('deletes everything for a recipient except rows currently claimed', () => {
    enqueue(store, input(1))
    enqueue(store, input(2))
    enqueue(store, input(3))
    claimDue(store, { owner: 'a', now: T0, limit: 1, authorize: allow })
    expect(deleteUnclaimedFor(store, { recipient: RECIPIENT, now: T0 + 1 })).toBe(2)
    expect((store.db.prepare('SELECT rumor_id FROM outbox').all() as Array<{ rumor_id: string }>).map((r) => r.rumor_id)).toEqual([hex(1)])
  })

  it('purges message content 7 days after the rumor was created, whatever the row state', () => {
    enqueue(store, input(1))
    enqueue(store, input(2, { rumor: { ...input(2).rumor, created_at: T0 + 100 } }))
    expect(purgeOutbox(store, T0 + NOSTR.contentRetentionSeconds - 1)).toBe(0)
    expect(purgeOutbox(store, T0 + NOSTR.contentRetentionSeconds)).toBe(1)
    expect(rowState(2)?.state).toBe('pending')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/store-outbox.test.ts`
Expected: FAIL — `enqueue` is not exported.

- [ ] **Step 3: Implement**

Create `packages/core/src/store/outbox.ts`:

```ts
import { NOSTR } from '../nostr-constants'
import type { Store } from './db'

export type OutboxPolicy = 'once' | 'retry_until_resolved'
export type OutboxRumor = { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string }

export type EnqueueInput = {
  recipient: string
  rumor: OutboxRumor
  label: string
  powBits: 16 | 22
  relays: readonly string[]
  policy: OutboxPolicy
  now: number
}

export type EnqueueOutcome = 'enqueued' | 'postponed_cap' | 'already_pending' | 'regenerated' | 'regeneration_too_soon' | 'abandoned'

export type OutboxItem = {
  recipient: string
  rumorId: string
  rumor: OutboxRumor
  label: string
  powBits: 16 | 22
  relays: string[]
  policy: OutboxPolicy
  attempts: number
  firstEnqueuedAt: number
}

type ClaimRef = { recipient: string; rumorId: string; owner: string }

type OutboxRow = {
  recipient: string
  rumor_id: string
  rumor_json: string
  label: string
  pow_bits: 16 | 22
  relays: string
  bytes: number
  policy: OutboxPolicy
  state: 'pending' | 'published' | 'abandoned'
  attempts: number
  first_enqueued_at: number
  next_attempt_at: number
  last_generated_at: number
  last_published_at: number | null
  claimed_by: string | null
  claimed_until: number | null
  updated_at: number
}

const HEX_64 = /^[0-9a-f]{64}$/

const selectRow = (store: Store, recipient: string, rumorId: string) =>
  store.db.prepare('SELECT * FROM outbox WHERE recipient = ? AND rumor_id = ?').get(recipient, rumorId) as OutboxRow | undefined

const toItem = (row: OutboxRow): OutboxItem => ({
  recipient: row.recipient,
  rumorId: row.rumor_id,
  rumor: JSON.parse(row.rumor_json) as OutboxRumor,
  label: row.label,
  powBits: row.pow_bits,
  relays: JSON.parse(row.relays) as string[],
  policy: row.policy,
  attempts: row.attempts,
  firstEnqueuedAt: row.first_enqueued_at,
})

export function enqueue(store: Store, input: EnqueueInput): EnqueueOutcome {
  if (!HEX_64.test(input.recipient) || !HEX_64.test(input.rumor.id)) {
    throw new Error('outbox: recipient and rumor id must be 64 lowercase hex characters')
  }
  if (input.relays.length === 0 || input.relays.length > NOSTR.maxRelaysPerContact) {
    throw new Error('outbox: between 1 and 5 relays are required')
  }
  return store.tx((): EnqueueOutcome => {
    const row = selectRow(store, input.recipient, input.rumor.id)
    if (row) {
      if (row.state === 'pending') return 'already_pending'
      if (row.state === 'abandoned') return 'abandoned'
      if (input.now - row.last_generated_at < NOSTR.regenerationIntervalSeconds) return 'regeneration_too_soon'
      store.db
        .prepare(
          "UPDATE outbox SET state = 'pending', relays = ?, next_attempt_at = ?, last_generated_at = ?, updated_at = ? WHERE recipient = ? AND rumor_id = ?",
        )
        .run(JSON.stringify(input.relays), input.now, input.now, input.now, input.recipient, input.rumor.id)
      return 'regenerated'
    }
    const rumorJson = JSON.stringify(input.rumor)
    const bytes = Buffer.byteLength(rumorJson)
    const pendingForRecipient = Number(
      store.db.prepare("SELECT coalesce(sum(bytes), 0) AS b FROM outbox WHERE recipient = ? AND state = 'pending'").get(input.recipient)?.b ?? 0,
    )
    const pendingForIdentity = Number(store.db.prepare("SELECT coalesce(sum(bytes), 0) AS b FROM outbox WHERE state = 'pending'").get()?.b ?? 0)
    const overCap =
      pendingForRecipient + bytes > NOSTR.maxPendingBytesPerRecipient || pendingForIdentity + bytes > NOSTR.maxPendingBytesPerIdentity
    store.db
      .prepare(
        `INSERT INTO outbox (recipient, rumor_id, rumor_json, label, pow_bits, relays, bytes, policy, state, attempts,
           first_enqueued_at, next_attempt_at, last_generated_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
      )
      .run(
        input.recipient,
        input.rumor.id,
        rumorJson,
        input.label,
        input.powBits,
        JSON.stringify(input.relays),
        bytes,
        input.policy,
        input.now,
        overCap ? input.now + NOSTR.capPostponeSeconds : input.now,
        input.now,
        input.now,
      )
    return overCap ? 'postponed_cap' : 'enqueued'
  })
}

export function claimDue(
  store: Store,
  input: { owner: string; now: number; limit: number; authorize: (item: OutboxItem) => boolean },
): OutboxItem[] {
  return store.tx(() => {
    store.db
      .prepare(
        `UPDATE outbox SET state = 'abandoned', claimed_by = NULL, claimed_until = NULL, updated_at = ?
         WHERE state = 'pending'
           AND ((policy = 'retry_until_resolved' AND first_enqueued_at <= ?) OR (policy = 'once' AND first_enqueued_at <= ?))`,
      )
      .run(input.now, input.now - NOSTR.retryWindowSeconds, input.now - NOSTR.decisionRetentionSeconds)
    const rows = store.db
      .prepare(
        `SELECT * FROM outbox WHERE state = 'pending' AND next_attempt_at <= ? AND (claimed_until IS NULL OR claimed_until <= ?)
         ORDER BY next_attempt_at, rowid LIMIT ?`,
      )
      .all(input.now, input.now, input.limit) as OutboxRow[]
    const abandon = store.db.prepare(
      "UPDATE outbox SET state = 'abandoned', claimed_by = NULL, claimed_until = NULL, updated_at = ? WHERE recipient = ? AND rumor_id = ?",
    )
    const claim = store.db.prepare('UPDATE outbox SET claimed_by = ?, claimed_until = ?, updated_at = ? WHERE recipient = ? AND rumor_id = ?')
    const granted: OutboxItem[] = []
    for (const row of rows) {
      const item = toItem(row)
      if (!input.authorize(item)) {
        abandon.run(input.now, row.recipient, row.rumor_id)
        continue
      }
      claim.run(input.owner, input.now + NOSTR.claimSeconds, input.now, row.recipient, row.rumor_id)
      granted.push(item)
    }
    return granted
  })
}

export function stillClaimed(store: Store, input: ClaimRef & { now: number }): boolean {
  const row = selectRow(store, input.recipient, input.rumorId)
  return row?.state === 'pending' && row.claimed_by === input.owner && (row.claimed_until ?? 0) > input.now
}

export function reservePublish(store: Store, input: ClaimRef & { now: number }): 'reserved' | 'claim_lost' | 'over_budget' {
  return store.tx(() => {
    if (!stillClaimed(store, input)) return 'claim_lost'
    store.db.prepare('DELETE FROM publish_log WHERE at <= ?').run(input.now - 60)
    const used = Number(store.db.prepare('SELECT count(*) AS n FROM publish_log').get()?.n ?? 0)
    if (used >= NOSTR.maxPublishesPerMinute) return 'over_budget'
    store.db.prepare('INSERT INTO publish_log (at) VALUES (?)').run(input.now)
    return 'reserved'
  })
}

export function postpone(store: Store, input: ClaimRef & { retryAt: number }): 'ok' | 'claim_lost' {
  return store.tx(() => {
    const row = selectRow(store, input.recipient, input.rumorId)
    if (!row || row.state !== 'pending' || row.claimed_by !== input.owner) return 'claim_lost'
    store.db
      .prepare('UPDATE outbox SET next_attempt_at = ?, claimed_by = NULL, claimed_until = NULL WHERE recipient = ? AND rumor_id = ?')
      .run(input.retryAt, input.recipient, input.rumorId)
    return 'ok'
  })
}

function finish(
  store: Store,
  input: ClaimRef & { now: number },
  decide: (row: OutboxRow, attempts: number) => { state: OutboxRow['state']; nextAttemptAt: number; published: boolean },
): 'ok' | 'claim_lost' {
  return store.tx(() => {
    const row = selectRow(store, input.recipient, input.rumorId)
    if (!row || row.state !== 'pending' || row.claimed_by !== input.owner) return 'claim_lost'
    const attempts = row.attempts + 1
    const next = decide(row, attempts)
    store.db
      .prepare(
        `UPDATE outbox SET state = ?, attempts = ?, next_attempt_at = ?, last_published_at = CASE WHEN ? THEN ? ELSE last_published_at END,
           claimed_by = NULL, claimed_until = NULL, updated_at = ? WHERE recipient = ? AND rumor_id = ?`,
      )
      .run(next.state, attempts, next.nextAttemptAt, next.published ? 1 : 0, input.now, input.now, input.recipient, input.rumorId)
    return 'ok'
  })
}

export function markPublished(store: Store, input: ClaimRef & { now: number }): 'ok' | 'claim_lost' {
  return finish(store, input, (row) => {
    if (row.policy === 'once') return { state: 'published', nextAttemptAt: row.next_attempt_at, published: true }
    const age = input.now - row.first_enqueued_at
    if (age >= NOSTR.retryWindowSeconds) return { state: 'abandoned', nextAttemptAt: row.next_attempt_at, published: true }
    const interval = age < 3_600 ? NOSTR.retryFirstHourIntervalSeconds : NOSTR.retryAfterFirstHourIntervalSeconds
    return { state: 'pending', nextAttemptAt: input.now + interval, published: true }
  })
}

export function markFailed(store: Store, input: ClaimRef & { now: number }): 'ok' | 'claim_lost' {
  return finish(store, input, (row, attempts) => {
    const age = input.now - row.first_enqueued_at
    const limit = row.policy === 'once' ? NOSTR.decisionRetentionSeconds : NOSTR.retryWindowSeconds
    if (age >= limit) return { state: 'abandoned', nextAttemptAt: row.next_attempt_at, published: false }
    const delay = Math.min(NOSTR.retryAfterFirstHourIntervalSeconds, 30 * 2 ** (attempts - 1))
    return { state: 'pending', nextAttemptAt: input.now + delay, published: false }
  })
}

export function resolveOutboxMessage(store: Store, input: { recipient: string; rumorId: string }): boolean {
  const result = store.tx(() => store.db.prepare('DELETE FROM outbox WHERE recipient = ? AND rumor_id = ?').run(input.recipient, input.rumorId))
  return Number(result.changes) > 0
}

export function deleteUnclaimedFor(store: Store, input: { recipient: string; now: number }): number {
  const result = store.tx(() =>
    store.db
      .prepare("DELETE FROM outbox WHERE recipient = ? AND NOT (state = 'pending' AND claimed_until IS NOT NULL AND claimed_until > ?)")
      .run(input.recipient, input.now),
  )
  return Number(result.changes)
}

// Rows carry full question and answer text, so they follow the 7-day content retention by the
// rumor's own creation date — pending, published or abandoned alike.
export function purgeOutbox(store: Store, now: number): number {
  return store.tx(() => {
    store.db.prepare('DELETE FROM publish_log WHERE at <= ?').run(now - 60)
    const result = store.db
      .prepare("DELETE FROM outbox WHERE json_extract(rumor_json, '$.created_at') <= ?")
      .run(now - NOSTR.contentRetentionSeconds)
    return Number(result.changes)
  })
}
```

In `packages/core/src/index.ts`, append:

```ts
export * from './store/outbox'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/store-outbox.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/store/outbox.ts packages/core/src/index.ts packages/core/test/store-outbox.test.ts
git commit -m "feat(core): outbox with authorized claims, publish reservations, retry schedules, caps and content retention"
```

---

### Task 7: History cursors — which day windows are provably complete

**Files:**
- Create: `packages/core/src/store/cursors.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/store-cursors.test.ts`

**Interfaces:**
- Consumes: `Store` (Task 4); `NOSTR` (Task 2).
- Produces:
  - `DAY_SECONDS = 86_400`
  - `type CursorRole = 'asker' | 'responder'`
  - `type HistoryWindow = { since: number; until: number }` (`until` is inclusive, `since + 86_399`, matching NIP-01 filter semantics).
  - `historyWindows(store, { relay, role, now }): HistoryWindow[]` — every aligned day from `floor((now − 9 days) / day)` to `floor(now / day)`, newest first, skipping windows already marked complete.
  - `markWindowComplete(store, { relay, role, since, readStartedAt, now }): boolean` — refuses (returns `false`) when the window's end is not older than `readStartedAt − NOSTR.liveSinceSeconds`, because a wrap published after the read began may still be dated inside it.
  - `purgeCursors(store, now): number`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/store-cursors.test.ts`:

```ts
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { DAY_SECONDS, NOSTR, historyWindows, markWindowComplete, openStore, purgeCursors, type Store } from '@agentbridge/core'

const RELAY = 'wss://relay.primal.net'
const NOW = 20_000 * DAY_SECONDS + 43_200
let store: Store

beforeEach(async () => {
  store = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-cursors-')), 'home'))
})

describe('historyWindows', () => {
  it('covers nine days back in aligned, inclusive day windows, newest first', () => {
    const windows = historyWindows(store, { relay: RELAY, role: 'responder', now: NOW })
    expect(windows).toHaveLength(NOSTR.historyDays + 1)
    expect(windows[0]).toEqual({ since: 20_000 * DAY_SECONDS, until: 20_000 * DAY_SECONDS + DAY_SECONDS - 1 })
    expect(windows.at(-1)).toEqual({ since: (20_000 - 9) * DAY_SECONDS, until: (20_000 - 9) * DAY_SECONDS + DAY_SECONDS - 1 })
  })

  it('skips completed windows, per relay and per role', () => {
    const old = (20_000 - 5) * DAY_SECONDS
    expect(markWindowComplete(store, { relay: RELAY, role: 'responder', since: old, readStartedAt: NOW, now: NOW })).toBe(true)
    expect(historyWindows(store, { relay: RELAY, role: 'responder', now: NOW }).map((w) => w.since)).not.toContain(old)
    expect(historyWindows(store, { relay: RELAY, role: 'asker', now: NOW }).map((w) => w.since)).toContain(old)
    expect(historyWindows(store, { relay: 'wss://nos.lol', role: 'responder', now: NOW }).map((w) => w.since)).toContain(old)
  })
})

describe('markWindowComplete', () => {
  it('refuses windows a newly published wrap could still be dated into', () => {
    const yesterday = (20_000 - 1) * DAY_SECONDS
    const twoDaysAgo = (20_000 - 2) * DAY_SECONDS
    const threeDaysAgo = (20_000 - 3) * DAY_SECONDS
    expect(markWindowComplete(store, { relay: RELAY, role: 'asker', since: yesterday, readStartedAt: NOW, now: NOW })).toBe(false)
    expect(markWindowComplete(store, { relay: RELAY, role: 'asker', since: twoDaysAgo, readStartedAt: NOW, now: NOW })).toBe(false)
    expect(markWindowComplete(store, { relay: RELAY, role: 'asker', since: threeDaysAgo, readStartedAt: NOW, now: NOW })).toBe(true)
  })

  it('rejects windows that are not aligned to a day', () => {
    expect(() => markWindowComplete(store, { relay: RELAY, role: 'asker', since: 123, readStartedAt: NOW, now: NOW })).toThrow(/aligned/)
  })
})

describe('purgeCursors', () => {
  it('drops windows older than the history horizon', () => {
    const ancient = (20_000 - 30) * DAY_SECONDS
    markWindowComplete(store, { relay: RELAY, role: 'asker', since: ancient, readStartedAt: NOW, now: NOW })
    markWindowComplete(store, { relay: RELAY, role: 'asker', since: (20_000 - 4) * DAY_SECONDS, readStartedAt: NOW, now: NOW })
    expect(purgeCursors(store, NOW)).toBe(1)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/store-cursors.test.ts`
Expected: FAIL — `historyWindows` is not exported.

- [ ] **Step 3: Implement**

Create `packages/core/src/store/cursors.ts`:

```ts
import { NOSTR } from '../nostr-constants'
import type { Store } from './db'

export const DAY_SECONDS = 86_400

export type CursorRole = 'asker' | 'responder'
export type HistoryWindow = { since: number; until: number }

const alignDay = (t: number) => Math.floor(t / DAY_SECONDS) * DAY_SECONDS

export function historyWindows(store: Store, input: { relay: string; role: CursorRole; now: number }): HistoryWindow[] {
  const first = alignDay(input.now - NOSTR.historyDays * DAY_SECONDS)
  const last = alignDay(input.now)
  const complete = new Set(
    (
      store.db
        .prepare('SELECT day_start FROM cursors WHERE relay = ? AND role = ? AND complete = 1 AND day_start BETWEEN ? AND ?')
        .all(input.relay, input.role, first, last) as Array<{ day_start: number }>
    ).map((r) => r.day_start),
  )
  const windows: HistoryWindow[] = []
  for (let day = last; day >= first; day -= DAY_SECONDS) {
    if (!complete.has(day)) windows.push({ since: day, until: day + DAY_SECONDS - 1 })
  }
  return windows
}

// NIP-59 dates seals and wraps up to two days in the past, so a wrap published at any moment
// after `readStartedAt` can still land in a window that ends later than
// readStartedAt − 2 days − 10 minutes. Only windows that ended before that point can be final.
export function markWindowComplete(
  store: Store,
  input: { relay: string; role: CursorRole; since: number; readStartedAt: number; now: number },
): boolean {
  if (input.since % DAY_SECONDS !== 0) throw new Error('cursors: window must be aligned to a day')
  if (input.since + DAY_SECONDS - 1 > input.readStartedAt - NOSTR.liveSinceSeconds) return false
  store.tx(() =>
    store.db
      .prepare(
        `INSERT INTO cursors (relay, role, day_start, complete, updated_at) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT (relay, role, day_start) DO UPDATE SET complete = 1, updated_at = excluded.updated_at`,
      )
      .run(input.relay, input.role, input.since, input.now),
  )
  return true
}

export function purgeCursors(store: Store, now: number): number {
  const horizon = alignDay(now - (NOSTR.historyDays + 1) * DAY_SECONDS)
  const result = store.tx(() => store.db.prepare('DELETE FROM cursors WHERE day_start < ?').run(horizon))
  return Number(result.changes)
}
```

In `packages/core/src/index.ts`, append:

```ts
export * from './store/cursors'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/store-cursors.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/store/cursors.ts packages/core/src/index.ts packages/core/test/store-cursors.test.ts
git commit -m "feat(core): history cursors that only mark day windows complete once no new wrap can land in them"
```

---

### Task 8: Protocol messages and time rules

**Files:**
- Create: `packages/core/src/envelope/messages.ts`, `packages/core/src/envelope/time.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/envelope-messages.test.ts`

**Interfaces:**
- Consumes: `NOSTR` (Task 2); `LIMITS`, `ConfidenceSchema` (existing `protocol.ts`).
- Produces:
  - `MessageSchema` (zod discriminated union on `type`, every variant strict, `v: 1`) and `type Message`, `type MessageType = Message['type']`.
  - Variants exactly as the spec table: `connect_request { requestId, name, note, relays }`, `connect_approved { requestId, generation, name, relays }`, `connect_rejected { requestId }`, `connect_revoked { generation }`, `question { questionId, generation, text }`, `receipt { questionId }`, `answer { questionId, text, source, confidence }`, `rejected { questionId, reason }` with `reason ∈ expired | limit | unanswered | stale_generation`.
  - `powBitsFor(type: MessageType): 16 | 22`
  - `isFutureDated(createdAt, now): boolean`, `questionExpiresAt(rumorCreatedAt): number`, `isQuestionExpired(rumorCreatedAt, now): boolean`, `isRequestTooOld(rumorCreatedAt, now): boolean`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/envelope-messages.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  MessageSchema,
  NOSTR,
  isFutureDated,
  isQuestionExpired,
  isRequestTooOld,
  powBitsFor,
  questionExpiresAt,
  type Message,
} from '@agentbridge/core'

const id = '3b241101-e2bb-4255-8caf-4136c566a962'

const valid: Message[] = [
  { v: 1, type: 'connect_request', requestId: id, name: 'Ana', note: 'Hola', relays: ['wss://nos.lol'] },
  { v: 1, type: 'connect_approved', requestId: id, generation: 1, name: 'Dev', relays: [] },
  { v: 1, type: 'connect_rejected', requestId: id },
  { v: 1, type: 'connect_revoked', generation: 2 },
  { v: 1, type: 'question', questionId: id, generation: 1, text: '¿Qué timeout aplica?' },
  { v: 1, type: 'receipt', questionId: id },
  { v: 1, type: 'answer', questionId: id, text: '30 s', source: 'README.md', confidence: 'seguro' },
  { v: 1, type: 'rejected', questionId: id, reason: 'stale_generation' },
]

describe('MessageSchema', () => {
  it.each(valid)('accepts $type', (message) => {
    expect(MessageSchema.parse(message)).toEqual(message)
  })

  it.each([
    [{ v: 2, type: 'receipt', questionId: id }, 'unknown version'],
    [{ v: 1, type: 'ping' }, 'unknown type'],
    [{ v: 1, type: 'receipt', questionId: id, extra: true }, 'extra field'],
    [{ v: 1, type: 'receipt', questionId: 'not-a-uuid' }, 'bad uuid'],
    [{ v: 1, type: 'connect_revoked', generation: 0 }, 'generation zero'],
    [{ v: 1, type: 'question', questionId: id, generation: 1, text: '   ' }, 'blank text'],
    [{ v: 1, type: 'question', questionId: id, generation: 1, text: 'x'.repeat(4001) }, 'question too long'],
    [{ v: 1, type: 'answer', questionId: id, text: 'x'.repeat(8001), source: 's', confidence: 'creo' }, 'answer too long'],
    [{ v: 1, type: 'answer', questionId: id, text: 'ok', source: 's'.repeat(501), confidence: 'creo' }, 'source too long'],
    [{ v: 1, type: 'answer', questionId: id, text: '€'.repeat(6000), source: 's', confidence: 'creo' }, 'within chars but over 16 KB'],
    [{ v: 1, type: 'answer', questionId: id, text: 'ok', source: 's', confidence: 'quizas' }, 'bad confidence'],
    [{ v: 1, type: 'connect_request', requestId: id, name: 'Ana', note: '', relays: Array(6).fill('wss://a.example.com') }, 'too many relays'],
    [{ v: 1, type: 'rejected', questionId: id, reason: 'because' }, 'bad reason'],
  ])('rejects %j (%s)', (message, _description) => {
    expect(MessageSchema.safeParse(message).success).toBe(false)
  })

  it('requires 22 bits of proof of work only for connection requests', () => {
    expect(powBitsFor('connect_request')).toBe(22)
    for (const m of valid.filter((m) => m.type !== 'connect_request')) expect(powBitsFor(m.type)).toBe(16)
  })
})

describe('time rules', () => {
  const now = 1_800_000_000

  it('allows at most ten minutes of clock skew into the future', () => {
    expect(isFutureDated(now + NOSTR.futureToleranceSeconds, now)).toBe(false)
    expect(isFutureDated(now + NOSTR.futureToleranceSeconds + 1, now)).toBe(true)
  })

  it('expires a question exactly 24 hours after the rumor was created', () => {
    expect(questionExpiresAt(now)).toBe(now + 86_400)
    expect(isQuestionExpired(now, now + 86_399)).toBe(false)
    expect(isQuestionExpired(now, now + 86_400)).toBe(true)
  })

  it('accepts connection requests up to seven days old', () => {
    expect(isRequestTooOld(now, now + 7 * 86_400)).toBe(false)
    expect(isRequestTooOld(now, now + 7 * 86_400 + 1)).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/envelope-messages.test.ts`
Expected: FAIL — `MessageSchema` is not exported.

- [ ] **Step 3: Implement**

Create `packages/core/src/envelope/messages.ts`:

```ts
import { z } from 'zod'
import { NOSTR } from '../nostr-constants'
import { ConfidenceSchema, LIMITS } from '../protocol'

const Uuid = z.uuid()
const Generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const RelayHints = z.array(z.string().max(NOSTR.maxRelayUrlLength)).max(NOSTR.maxRelaysPerContact)

const text = (maxChars: number) =>
  z
    .string()
    .max(maxChars)
    .refine((s) => Buffer.byteLength(s, 'utf8') <= NOSTR.maxTextBytes, { message: `must be at most ${NOSTR.maxTextBytes} bytes` })
const filled = (maxChars: number) => text(maxChars).refine((s) => s.trim().length > 0, { message: 'must not be blank' })

export const MessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ v: z.literal(1), type: z.literal('connect_request'), requestId: Uuid, name: filled(80), note: text(500), relays: RelayHints }),
  z.strictObject({ v: z.literal(1), type: z.literal('connect_approved'), requestId: Uuid, generation: Generation, name: filled(80), relays: RelayHints }),
  z.strictObject({ v: z.literal(1), type: z.literal('connect_rejected'), requestId: Uuid }),
  z.strictObject({ v: z.literal(1), type: z.literal('connect_revoked'), generation: Generation }),
  z.strictObject({ v: z.literal(1), type: z.literal('question'), questionId: Uuid, generation: Generation, text: filled(LIMITS.questionMaxChars) }),
  z.strictObject({ v: z.literal(1), type: z.literal('receipt'), questionId: Uuid }),
  z.strictObject({
    v: z.literal(1),
    type: z.literal('answer'),
    questionId: Uuid,
    text: filled(LIMITS.answerMaxChars),
    source: filled(LIMITS.sourceMaxChars),
    confidence: ConfidenceSchema,
  }),
  z.strictObject({
    v: z.literal(1),
    type: z.literal('rejected'),
    questionId: Uuid,
    reason: z.enum(['expired', 'limit', 'unanswered', 'stale_generation']),
  }),
])

export type Message = z.infer<typeof MessageSchema>
export type MessageType = Message['type']

export function powBitsFor(type: MessageType): 16 | 22 {
  return type === 'connect_request' ? NOSTR.powRequestBits : NOSTR.powMessageBits
}
```

Create `packages/core/src/envelope/time.ts`:

```ts
import { NOSTR } from '../nostr-constants'

export const isFutureDated = (createdAt: number, now: number): boolean => createdAt > now + NOSTR.futureToleranceSeconds

// The sender cannot pick an expiry: it is derived from the rumor's own date, which is never allowed
// in the future and is reused unchanged by every retry.
export const questionExpiresAt = (rumorCreatedAt: number): number => rumorCreatedAt + NOSTR.questionTtlSeconds

export const isQuestionExpired = (rumorCreatedAt: number, now: number): boolean => now >= questionExpiresAt(rumorCreatedAt)

export const isRequestTooOld = (rumorCreatedAt: number, now: number): boolean => now - rumorCreatedAt > NOSTR.requestMaxAgeSeconds
```

In `packages/core/src/index.ts`, append:

```ts
export * from './envelope/messages'
export * from './envelope/time'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/envelope-messages.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/envelope/messages.ts packages/core/src/envelope/time.ts packages/core/src/index.ts packages/core/test/envelope-messages.test.ts
git commit -m "feat(core): strict protocol messages with byte caps and sender-proof time rules"
```

---

### Task 9: Proof of work mined off the event loop

**Files:**
- Create: `packages/core/src/envelope/pow.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/envelope-pow.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (uses `nostr-tools/nip13` `getPow`).
- Produces:
  - `type UnsignedEvent = { pubkey: string; created_at: number; kind: number; tags: string[][]; content: string }`
  - `type MinedEvent = UnsignedEvent & { id: string }`
  - `leadingZeroBits(hexId: string): number`
  - `mineEvent(event: UnsignedEvent, bits: number, options?: { signal?: AbortSignal }): Promise<MinedEvent>` — appends `['nonce', <n>, '<bits>']`, keeps `created_at` unchanged (NIP-59 needs its randomized date), runs in a `worker_threads` worker created from inline source so the esbuild single-file bundles keep working.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/envelope-pow.test.ts`:

```ts
import { getEventHash } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { leadingZeroBits, mineEvent, type UnsignedEvent } from '@agentbridge/core'

const base: UnsignedEvent = {
  pubkey: 'e9451985e285d64afb4594cf538593e53e9fedfbec8bdaec8e9399df40ea41b8',
  created_at: 1_700_000_000,
  kind: 1059,
  tags: [['p', 'a'.repeat(64)], ['expiration', '1700604800']],
  content: 'x'.repeat(4_000),
}

describe('mineEvent', () => {
  it('finds a nonce whose NIP-01 id has the requested leading zero bits, without touching the date or other tags', async () => {
    const mined = await mineEvent(base, 16)
    expect(mined.id).toBe(getEventHash(mined))
    expect(leadingZeroBits(mined.id)).toBeGreaterThanOrEqual(16)
    expect(mined.created_at).toBe(base.created_at)
    expect(mined.tags.slice(0, 2)).toEqual(base.tags)
    expect(mined.tags[2]).toEqual(['nonce', expect.stringMatching(/^\d+$/), '16'])
    expect(base.tags).toHaveLength(2)
  })

  it('mines 16 bits over a 4 KB event in well under ten seconds', async () => {
    const started = Date.now()
    await mineEvent(base, 16)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('keeps the event loop responsive while mining', async () => {
    let ticks = 0
    const timer = setInterval(() => ticks++, 10)
    await mineEvent(base, 18)
    clearInterval(timer)
    expect(ticks).toBeGreaterThan(3)
  })

  it('stops when aborted', async () => {
    const controller = new AbortController()
    const mining = mineEvent(base, 32, { signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    await expect(mining).rejects.toThrow(/aborted/)
  })

  it('rejects impossible difficulties', () => {
    expect(() => mineEvent(base, 33)).toThrow(RangeError)
    expect(() => mineEvent(base, -1)).toThrow(RangeError)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/envelope-pow.test.ts`
Expected: FAIL — `mineEvent` is not exported.

- [ ] **Step 3: Implement**

Create `packages/core/src/envelope/pow.ts`:

```ts
import { Worker } from 'node:worker_threads'
import { getPow } from 'nostr-tools/nip13'

export type UnsignedEvent = { pubkey: string; created_at: number; kind: number; tags: string[][]; content: string }
export type MinedEvent = UnsignedEvent & { id: string }

export const leadingZeroBits = (hexId: string): number => getPow(hexId)

// Inline CommonJS source so the worker survives esbuild's single-file bundles (a separate worker
// file would not be copied into dist). Serialization matches NIP-01 exactly, and created_at is
// never changed: NIP-59 wraps carry a deliberately randomized past date.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { createHash } = require('node:crypto')
const { event, bits } = workerData
const nonce = ['nonce', '0', String(bits)]
const tags = [...event.tags, nonce]
const zeros = (buf) => {
  let n = 0
  for (const byte of buf) {
    if (byte === 0) { n += 8; continue }
    return n + Math.clz32(byte) - 24
  }
  return n
}
for (let i = 0; ; i++) {
  nonce[1] = String(i)
  const hash = createHash('sha256').update(JSON.stringify([0, event.pubkey, event.created_at, event.kind, tags, event.content])).digest()
  if (zeros(hash) >= bits) {
    parentPort.postMessage({ nonce: nonce[1], id: hash.toString('hex') })
    break
  }
}
`

export function mineEvent(event: UnsignedEvent, bits: number, options: { signal?: AbortSignal } = {}): Promise<MinedEvent> {
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) throw new RangeError('bits must be an integer from 0 to 32')
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('mining aborted'))
      return
    }
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { event, bits } })
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      void worker.terminate()
      fn()
    }
    const onAbort = () => settle(() => reject(new Error('mining aborted')))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    worker.once('message', (m: { nonce: string; id: string }) =>
      settle(() => resolve({ ...event, tags: [...event.tags, ['nonce', m.nonce, String(bits)]], id: m.id })),
    )
    worker.once('error', (err) => settle(() => reject(err)))
  })
}
```

In `packages/core/src/index.ts`, append:

```ts
export * from './envelope/pow'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/envelope-pow.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/envelope/pow.ts packages/core/src/index.ts packages/core/test/envelope-pow.test.ts
git commit -m "feat(core): NIP-13 proof of work mined in a worker thread"
```

---

### Task 10: Sealing — rumor, seal, wrap, expiration and size checks per layer

**Files:**
- Create: `packages/core/src/envelope/seal.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/envelope-seal.test.ts`

**Interfaces:**
- Consumes: `Identity`, `UserFacingError`, `NOSTR` (Task 2); `MessageSchema`, `Message`, `powBitsFor` (Task 8); `mineEvent` (Task 9).
- Produces:
  - `type Rumor = { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string }` (unsigned; assignable to `OutboxRumor` from Task 6).
  - `class EnvelopeSizeError extends UserFacingError` — Spanish message.
  - `createRumor(message: Message, sender: Identity, createdAt: number): Rumor` — size problems in `text`, `source`, `note` or `name` throw `EnvelopeSizeError`; any other schema failure throws a plain `Error` (programming error).
  - `type WrapOptions = { now: number; random?: () => number; signal?: AbortSignal }`
  - `wrapRumor(rumor: Rumor, sender: Identity, recipientPubkey: string, options: WrapOptions): Promise<NostrEvent>` — seal kind 13 signed by the sender, wrap kind 1059 signed by a fresh key, both dated `now − floor(random() × 2 days)`, wrap tags `['p', recipient]`, `['expiration', now + 7 days]`, `['nonce', n, bits]` with bits from `powBitsFor`. Every call produces a new wrap, so a retry reuses the rumor in a fresh envelope.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/envelope-seal.test.ts`:

```ts
import { decrypt, getConversationKey } from 'nostr-tools/nip44'
import { getEventHash, verifyEvent, type NostrEvent } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { EnvelopeSizeError, NOSTR, createRumor, leadingZeroBits, wrapRumor, type Message } from '@agentbridge/core'
import { testIdentity } from './support/keys'

const sender = testIdentity(1)
const recipient = testIdentity(2)
const NOW = 1_800_000_000
const questionId = '3b241101-e2bb-4255-8caf-4136c566a962'
const question: Message = { v: 1, type: 'question', questionId, generation: 1, text: '¿Qué timeout aplica?' }

function unwrap(wrap: NostrEvent) {
  const seal = JSON.parse(decrypt(wrap.content, getConversationKey(recipient.secretKey, wrap.pubkey)))
  const rumor = JSON.parse(decrypt(seal.content, getConversationKey(recipient.secretKey, seal.pubkey)))
  return { seal, rumor }
}

describe('createRumor', () => {
  it('builds an unsigned rumor authored by the sender, with the private kind and a valid id', () => {
    const rumor = createRumor(question, sender, NOW)
    expect(rumor).toMatchObject({ pubkey: sender.publicKey, created_at: NOW, kind: NOSTR.rumorKind, tags: [] })
    expect(JSON.parse(rumor.content)).toEqual(question)
    expect(rumor.id).toBe(getEventHash(rumor))
    expect('sig' in rumor).toBe(false)
  })

  it('refuses a text over 16 KB with a Spanish size error', () => {
    const answer = { v: 1, type: 'answer', questionId, text: '€'.repeat(6000), source: 's', confidence: 'creo' } as Message
    expect(() => createRumor(answer, sender, NOW)).toThrow(EnvelopeSizeError)
    expect(() => createRumor(answer, sender, NOW)).toThrow(/demasiado grande/)
  })

  it('treats any other invalid message as a programming error', () => {
    const broken = { v: 1, type: 'receipt', questionId: 'nope' } as unknown as Message
    const err = (() => {
      try {
        createRumor(broken, sender, NOW)
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(EnvelopeSizeError)
  })
})

describe('wrapRumor', () => {
  it('seals, wraps, back-dates, tags expiration and mines 16 bits for a question', async () => {
    const rumor = createRumor(question, sender, NOW)
    const wrap = await wrapRumor(rumor, sender, recipient.publicKey, { now: NOW, random: () => 0.5 })
    expect(wrap.kind).toBe(NOSTR.wrapKind)
    expect(wrap.pubkey).not.toBe(sender.publicKey)
    expect(wrap.created_at).toBe(NOW - NOSTR.randomizationSeconds / 2)
    expect(wrap.tags).toEqual([
      ['p', recipient.publicKey],
      ['expiration', String(NOW + NOSTR.wrapExpirationSeconds)],
      ['nonce', expect.stringMatching(/^\d+$/), '16'],
    ])
    expect(leadingZeroBits(wrap.id)).toBeGreaterThanOrEqual(16)
    expect(verifyEvent(JSON.parse(JSON.stringify(wrap)))).toBe(true)
    const { seal, rumor: inner } = unwrap(wrap)
    expect(seal).toMatchObject({ kind: NOSTR.sealKind, pubkey: sender.publicKey, tags: [] })
    expect(seal.created_at).toBeLessThanOrEqual(NOW)
    expect(seal.created_at).toBeGreaterThanOrEqual(NOW - NOSTR.randomizationSeconds)
    expect(verifyEvent(seal)).toBe(true)
    expect(inner).toEqual(rumor)
  })

  it('produces a brand-new wrap for every retry of the same rumor', async () => {
    const rumor = createRumor(question, sender, NOW)
    const a = await wrapRumor(rumor, sender, recipient.publicKey, { now: NOW })
    const b = await wrapRumor(rumor, sender, recipient.publicKey, { now: NOW })
    expect(a.id).not.toBe(b.id)
    expect(a.pubkey).not.toBe(b.pubkey)
    expect(unwrap(a).rumor).toEqual(unwrap(b).rumor)
  })

  it('mines 22 bits for a connection request', { timeout: 120_000 }, async () => {
    const request: Message = { v: 1, type: 'connect_request', requestId: questionId, name: 'Ana', note: '', relays: [] }
    const wrap = await wrapRumor(createRumor(request, sender, NOW), sender, recipient.publicKey, { now: NOW })
    expect(leadingZeroBits(wrap.id)).toBeGreaterThanOrEqual(22)
    expect(wrap.tags.at(-1)).toEqual(['nonce', expect.stringMatching(/^\d+$/), '22'])
  })

  it.each([
    ['8000 one-byte characters', 'a'.repeat(8000)],
    ['5000 three-byte characters', '€'.repeat(5000)],
  ])('fits a maximum answer made of %s under the 64 KB frame cap', async (_label, text) => {
    const answer: Message = { v: 1, type: 'answer', questionId, text, source: 's'.repeat(500), confidence: 'creo' }
    const wrap = await wrapRumor(createRumor(answer, sender, NOW), sender, recipient.publicKey, { now: NOW })
    expect(Buffer.byteLength(JSON.stringify(['EVENT', wrap]))).toBeLessThanOrEqual(NOSTR.maxWrapBytes)
  })

  it('refuses, in Spanish, an answer whose JSON escaping would push the wrap past 64 KB', async () => {
    const answer: Message = { v: 1, type: 'answer', questionId, text: '"'.repeat(8000), source: 's', confidence: 'creo' }
    const attempt = async () => wrapRumor(createRumor(answer, sender, NOW), sender, recipient.publicKey, { now: NOW })
    await expect(attempt()).rejects.toThrow(EnvelopeSizeError)
  })

  it('refuses to wrap a rumor written by someone else', async () => {
    const rumor = createRumor(question, sender, NOW)
    await expect(wrapRumor(rumor, testIdentity(3), recipient.publicKey, { now: NOW })).rejects.toThrow(/author/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/envelope-seal.test.ts`
Expected: FAIL — `createRumor` is not exported.

- [ ] **Step 3: Implement**

Create `packages/core/src/envelope/seal.ts`:

```ts
import { encrypt, getConversationKey } from 'nostr-tools/nip44'
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, type NostrEvent } from 'nostr-tools/pure'
import { UserFacingError } from '../errors'
import type { Identity } from '../identity'
import { NOSTR } from '../nostr-constants'
import { MessageSchema, powBitsFor, type Message } from './messages'
import { mineEvent } from './pow'

export type Rumor = { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string }
export type WrapOptions = { now: number; random?: () => number; signal?: AbortSignal }

export class EnvelopeSizeError extends UserFacingError {
  constructor() {
    super('El mensaje es demasiado grande para enviarse por los tableros. Acórtalo e inténtalo de nuevo.')
    this.name = 'EnvelopeSizeError'
  }
}

const HEX_64 = /^[0-9a-f]{64}$/
const TEXT_FIELDS = new Set(['text', 'source', 'note', 'name'])
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')
// The nonce tag added by mining is at most ["nonce","4294967295","22"] plus a separator.
const NONCE_TAG_SLACK_BYTES = 40

export function createRumor(message: Message, sender: Identity, createdAt: number): Rumor {
  const parsed = MessageSchema.safeParse(message)
  if (!parsed.success) {
    const sizeProblem = parsed.error.issues.some(
      (issue) => TEXT_FIELDS.has(String(issue.path.at(-1))) && (issue.code === 'too_big' || (issue.code === 'custom' && issue.message.includes('bytes'))),
    )
    if (sizeProblem) throw new EnvelopeSizeError()
    throw new Error(`createRumor: invalid message at ${parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ')}`)
  }
  const unsigned = { pubkey: sender.publicKey, created_at: createdAt, kind: NOSTR.rumorKind, tags: [] as string[][], content: JSON.stringify(parsed.data) }
  const rumor: Rumor = { ...unsigned, id: getEventHash(unsigned) }
  if (jsonBytes(rumor) > NOSTR.maxRumorBytes) throw new EnvelopeSizeError()
  return rumor
}

export async function wrapRumor(rumor: Rumor, sender: Identity, recipientPubkey: string, options: WrapOptions): Promise<NostrEvent> {
  if (rumor.pubkey !== sender.publicKey) throw new Error('wrapRumor: the rumor author must be the sender')
  if (!HEX_64.test(recipientPubkey)) throw new Error('wrapRumor: recipientPubkey must be 64 lowercase hex characters')
  if (jsonBytes(rumor) > NOSTR.maxRumorBytes) throw new EnvelopeSizeError()
  const message = MessageSchema.parse(JSON.parse(rumor.content))
  const random = options.random ?? Math.random
  const pastDate = () => options.now - Math.floor(random() * NOSTR.randomizationSeconds)

  const seal = finalizeEvent(
    {
      kind: NOSTR.sealKind,
      created_at: pastDate(),
      tags: [],
      content: encrypt(JSON.stringify(rumor), getConversationKey(sender.secretKey, recipientPubkey)),
    },
    sender.secretKey,
  )
  if (jsonBytes(seal) > NOSTR.maxSealBytes) throw new EnvelopeSizeError()

  const wrapKey = generateSecretKey()
  const unsigned = {
    pubkey: getPublicKey(wrapKey),
    created_at: pastDate(),
    kind: NOSTR.wrapKind,
    tags: [
      ['p', recipientPubkey],
      ['expiration', String(options.now + NOSTR.wrapExpirationSeconds)],
    ],
    content: encrypt(JSON.stringify(seal), getConversationKey(wrapKey, recipientPubkey)),
  }
  const placeholder = { ...unsigned, id: '0'.repeat(64), sig: '0'.repeat(128) }
  if (jsonBytes(['EVENT', placeholder]) + NONCE_TAG_SLACK_BYTES > NOSTR.maxWrapBytes) throw new EnvelopeSizeError()

  const mined = await mineEvent(unsigned, powBitsFor(message.type), { signal: options.signal })
  const wrap = finalizeEvent({ kind: mined.kind, created_at: mined.created_at, tags: mined.tags, content: mined.content }, wrapKey)
  if (wrap.id !== mined.id) throw new Error('wrapRumor: the mined id does not match the signed wrap')
  if (jsonBytes(['EVENT', wrap]) > NOSTR.maxWrapBytes) throw new EnvelopeSizeError()
  return wrap
}
```

In `packages/core/src/index.ts`, append:

```ts
export * from './envelope/seal'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/envelope-seal.test.ts && npm run typecheck`
Expected: PASS. The 22-bit test takes several seconds; it has its own 120 s timeout.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/envelope/seal.ts packages/core/src/index.ts packages/core/test/envelope-seal.test.ts
git commit -m "feat(core): NIP-59 sealing with fresh wraps per retry, expiration tags and per-layer size checks"
```

---

### Task 11: Opening — the receive pipeline, cheapest checks first

**Files:**
- Create: `packages/core/src/envelope/dedupe.ts`, `packages/core/src/envelope/open.ts`, `packages/core/test/support/craft.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/envelope-open.test.ts`

**Interfaces:**
- Consumes: `Identity`, `NOSTR` (Task 2); `MessageSchema`, `Message`, `isFutureDated` (Task 8); `leadingZeroBits`, `mineEvent` (Task 9); `Rumor`, `createRumor`, `wrapRumor` (Task 10).
- Produces:
  - `class SeenIds { constructor(max?: number); has(id: string): boolean; add(id: string): void; delete(id: string): void; readonly size: number }` — insertion-ordered, evicts the oldest past `max` (default 10 000).
  - **Contract for plans 2 and 3:** `precheckWrap` records the wrap id as seen. If anything after it fails before the message is persisted (decryption succeeded but the database write threw, the process was aborted), the caller must call `seen.delete(wrapId)` so a later copy or a history re-read can deliver it. Validation failures from `openWrap` stay in the cache.
  - `type OpenContext = { identity: Identity; now: number; seen: SeenIds }`
  - `type OpenFailureStage = 'size' | 'structure' | 'id' | 'pow' | 'duplicate' | 'signature' | 'seal' | 'rumor' | 'content' | 'request_pow'`
  - `type OpenFailure = { ok: false; stage: OpenFailureStage; detail: string }` — `detail` is an English log line that never contains decrypted content.
  - `type PrecheckedWrap = { ok: true; wrap: NostrEvent; powBits: number }`
  - `type OpenedMessage = { ok: true; wrapId: string; senderPubkey: string; rumor: Rumor; message: Message; powBits: number }`
  - `precheckWrap(raw: unknown, ctx: OpenContext): PrecheckedWrap | OpenFailure` — spec steps 1–4 (size, structure, kind, single `p` tag equal to me, date; id and 16-bit PoW; duplicate; signature). A wrap id is recorded as seen **only after** its signature verifies, so a forged copy cannot block the genuine one.
  - `openWrap(prechecked: PrecheckedWrap, ctx: OpenContext): OpenedMessage | OpenFailure` — spec steps 6–9 (decrypt and verify seal, decrypt and verify rumor, author equals seal signer, content schema, 22 bits for `connect_request`). Step 5 (the queue) lives in `boards` (Task 14); step 10 (authorization) lives in plans 2 and 3.
  - Test helper `craftWrap(options: CraftOptions): Promise<NostrEvent>` for building hostile envelopes.

- [ ] **Step 1: Write the test helper**

Create `packages/core/test/support/craft.ts`:

```ts
import { encrypt, getConversationKey } from 'nostr-tools/nip44'
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, type NostrEvent } from 'nostr-tools/pure'
import { NOSTR, mineEvent, type Identity } from '@agentbridge/core'

export type CraftOptions = {
  sender: Identity
  recipientPubkey: string
  content: unknown
  now: number
  sealSigner?: Identity
  sealPlaintext?: string
  sealKind?: number
  rumorKind?: number
  rumorCreatedAt?: number
  wrapCreatedAt?: number
  bits?: number
}

// Builds envelopes the production code would refuse to build, for pipeline tests. The result is a
// fresh JSON copy, like an event parsed from a relay frame.
export async function craftWrap(o: CraftOptions): Promise<NostrEvent> {
  const unsignedRumor = {
    pubkey: o.sender.publicKey,
    created_at: o.rumorCreatedAt ?? o.now,
    kind: o.rumorKind ?? NOSTR.rumorKind,
    tags: [] as string[][],
    content: typeof o.content === 'string' ? o.content : JSON.stringify(o.content),
  }
  const rumor = { ...unsignedRumor, id: getEventHash(unsignedRumor) }
  const signer = o.sealSigner ?? o.sender
  const seal = finalizeEvent(
    {
      kind: o.sealKind ?? NOSTR.sealKind,
      created_at: o.now,
      tags: [],
      content: encrypt(JSON.stringify(rumor), getConversationKey(signer.secretKey, o.recipientPubkey)),
    },
    signer.secretKey,
  )
  const wrapKey = generateSecretKey()
  const unsignedWrap = {
    pubkey: getPublicKey(wrapKey),
    created_at: o.wrapCreatedAt ?? o.now,
    kind: NOSTR.wrapKind,
    tags: [['p', o.recipientPubkey]],
    content: encrypt(o.sealPlaintext ?? JSON.stringify(seal), getConversationKey(wrapKey, o.recipientPubkey)),
  }
  const mined = o.bits ? await mineEvent(unsignedWrap, o.bits) : unsignedWrap
  const wrap = finalizeEvent({ kind: mined.kind, created_at: mined.created_at, tags: mined.tags, content: mined.content }, wrapKey)
  return JSON.parse(JSON.stringify(wrap)) as NostrEvent
}
```

- [ ] **Step 2: Write the failing tests**

Create `packages/core/test/envelope-open.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  NOSTR,
  SeenIds,
  createRumor,
  leadingZeroBits,
  openWrap,
  precheckWrap,
  wrapRumor,
  type Message,
  type OpenContext,
} from '@agentbridge/core'
import { craftWrap } from './support/craft'
import { testIdentity } from './support/keys'

const sender = testIdentity(1)
const recipient = testIdentity(2)
const attacker = testIdentity(3)
const NOW = 1_800_000_000
const questionId = '3b241101-e2bb-4255-8caf-4136c566a962'
const question: Message = { v: 1, type: 'question', questionId, generation: 1, text: '¿Qué timeout aplica?' }
const context = (): OpenContext => ({ identity: recipient, now: NOW, seen: new SeenIds() })

function openRaw(raw: unknown, ctx = context()) {
  const pre = precheckWrap(raw, ctx)
  return pre.ok ? openWrap(pre, ctx) : pre
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const genuine = async (message: Message = question, to = recipient.publicKey) =>
  copy(await wrapRumor(createRumor(message, sender, NOW), sender, to, { now: NOW }))

describe('receive pipeline', () => {
  it('opens a genuine question and reports the authenticated sender', async () => {
    const wrap = await genuine()
    expect(openRaw(wrap)).toMatchObject({ ok: true, wrapId: wrap.id, senderPubkey: sender.publicKey, message: question })
  })

  it('rejects oversize events before parsing them', async () => {
    expect(openRaw({ ...(await genuine()), content: 'x'.repeat(70_000) })).toMatchObject({ ok: false, stage: 'size' })
  })

  it('rejects malformed events, other kinds, other recipients and future dates as structure problems', async () => {
    expect(openRaw({ hello: 'world' })).toMatchObject({ stage: 'structure' })
    expect(openRaw({ ...(await genuine()), kind: 1 })).toMatchObject({ stage: 'structure' })
    expect(openRaw(await genuine(question, attacker.publicKey))).toMatchObject({ stage: 'structure' })
    const future = await craftWrap({ sender, recipientPubkey: recipient.publicKey, content: question, now: NOW, wrapCreatedAt: NOW + 3_600, bits: 16 })
    expect(openRaw(future)).toMatchObject({ stage: 'structure' })
  })

  it('rejects an id that does not match the content', async () => {
    const wrap = await genuine()
    expect(openRaw({ ...wrap, content: `${wrap.content.slice(0, -4)}AAAA` })).toMatchObject({ stage: 'id' })
  })

  it('rejects wraps without 16 bits of proof of work', async () => {
    let weak = await craftWrap({ sender, recipientPubkey: recipient.publicKey, content: question, now: NOW })
    while (leadingZeroBits(weak.id) >= NOSTR.powMessageBits) {
      weak = await craftWrap({ sender, recipientPubkey: recipient.publicKey, content: question, now: NOW })
    }
    expect(openRaw(weak)).toMatchObject({ stage: 'pow' })
  })

  it('rejects a bad signature without letting the forged copy block the genuine wrap', async () => {
    const wrap = await genuine()
    const ctx = context()
    const forged = { ...wrap, sig: 'f'.repeat(128) }
    expect(openRaw(forged, ctx)).toMatchObject({ stage: 'signature' })
    expect(openRaw(wrap, ctx)).toMatchObject({ ok: true })
    expect(openRaw(wrap, ctx)).toMatchObject({ stage: 'duplicate' })
  })

  it('rejects a wrap whose content is not a seal', async () => {
    const wrap = await craftWrap({ sender, recipientPubkey: recipient.publicKey, content: question, now: NOW, sealPlaintext: 'not json', bits: 16 })
    expect(openRaw(wrap)).toMatchObject({ stage: 'seal' })
    const wrongKind = await craftWrap({ sender, recipientPubkey: recipient.publicKey, content: question, now: NOW, sealKind: 1, bits: 16 })
    expect(openRaw(wrongKind)).toMatchObject({ stage: 'seal' })
  })

  it('rejects impersonation: a rumor claiming the sender inside a seal signed by someone else', async () => {
    const wrap = await craftWrap({ sender, sealSigner: attacker, recipientPubkey: recipient.publicKey, content: question, now: NOW, bits: 16 })
    expect(openRaw(wrap)).toMatchObject({ stage: 'rumor' })
  })

  it('rejects rumors of another kind or dated in the future', async () => {
    const chat = await craftWrap({ sender, recipientPubkey: recipient.publicKey, content: question, now: NOW, rumorKind: 14, bits: 16 })
    expect(openRaw(chat)).toMatchObject({ stage: 'rumor' })
    const future = await craftWrap({ sender, recipientPubkey: recipient.publicKey, content: question, now: NOW, rumorCreatedAt: NOW + 3_600, bits: 16 })
    expect(openRaw(future)).toMatchObject({ stage: 'rumor' })
  })

  it('rejects content that is not a valid protocol message', async () => {
    const notJson = await craftWrap({ sender, recipientPubkey: recipient.publicKey, content: 'hola', now: NOW, bits: 16 })
    expect(openRaw(notJson)).toMatchObject({ stage: 'content' })
    const unknown = await craftWrap({ sender, recipientPubkey: recipient.publicKey, content: { v: 1, type: 'ping' }, now: NOW, bits: 16 })
    expect(openRaw(unknown)).toMatchObject({ stage: 'content' })
  })

  it('requires 22 bits for connection requests even though 16 bits pass the precheck', async () => {
    const request: Message = { v: 1, type: 'connect_request', requestId: questionId, name: 'Ana', note: '', relays: [] }
    const craft = () => craftWrap({ sender, recipientPubkey: recipient.publicKey, content: request, now: NOW, bits: 16 })
    let cheap = await craft()
    while (leadingZeroBits(cheap.id) >= NOSTR.powRequestBits) cheap = await craft()
    expect(openRaw(cheap)).toMatchObject({ stage: 'request_pow' })
  })

  it('never includes decrypted content in failure details', async () => {
    const secret = 'CONTENIDO-SECRETO-123'
    const wrap = await craftWrap({ sender, recipientPubkey: recipient.publicKey, content: { v: 1, type: 'ping', secret }, now: NOW, bits: 16 })
    const result = openRaw(wrap)
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(secret)
  })
})

describe('SeenIds', () => {
  it('forgets the oldest ids past its capacity', () => {
    const seen = new SeenIds(2)
    seen.add('a')
    seen.add('b')
    seen.add('a')
    seen.add('c')
    expect([seen.has('a'), seen.has('b'), seen.has('c'), seen.size]).toEqual([false, true, true, 2])
  })

  it('forgets an id on request, so a message whose persistence failed can be delivered again', () => {
    const seen = new SeenIds()
    seen.add('a')
    seen.delete('a')
    expect(seen.has('a')).toBe(false)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/envelope-open.test.ts`
Expected: FAIL — `SeenIds` is not exported.

- [ ] **Step 4: Implement**

Create `packages/core/src/envelope/dedupe.ts`:

```ts
export class SeenIds {
  private readonly ids = new Set<string>()

  constructor(private readonly max = 10_000) {}

  has(id: string): boolean {
    return this.ids.has(id)
  }

  add(id: string): void {
    if (this.ids.has(id)) return
    this.ids.add(id)
    if (this.ids.size > this.max) {
      const oldest = this.ids.values().next().value
      if (oldest !== undefined) this.ids.delete(oldest)
    }
  }

  delete(id: string): void {
    this.ids.delete(id)
  }

  get size(): number {
    return this.ids.size
  }
}
```

Create `packages/core/src/envelope/open.ts`:

```ts
import { decrypt, getConversationKey } from 'nostr-tools/nip44'
import { getEventHash, verifyEvent, type NostrEvent } from 'nostr-tools/pure'
import { z } from 'zod'
import type { Identity } from '../identity'
import { NOSTR } from '../nostr-constants'
import type { SeenIds } from './dedupe'
import { MessageSchema, type Message } from './messages'
import { leadingZeroBits } from './pow'
import type { Rumor } from './seal'
import { isFutureDated } from './time'

export type OpenContext = { identity: Identity; now: number; seen: SeenIds }
export type OpenFailureStage = 'size' | 'structure' | 'id' | 'pow' | 'duplicate' | 'signature' | 'seal' | 'rumor' | 'content' | 'request_pow'
export type OpenFailure = { ok: false; stage: OpenFailureStage; detail: string }
export type PrecheckedWrap = { ok: true; wrap: NostrEvent; powBits: number }
export type OpenedMessage = { ok: true; wrapId: string; senderPubkey: string; rumor: Rumor; message: Message; powBits: number }

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/)
const Timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const Tags = z.array(z.array(z.string()))
const EventShape = z.strictObject({
  id: Hex64,
  pubkey: Hex64,
  created_at: Timestamp,
  kind: z.number().int().nonnegative(),
  tags: Tags,
  content: z.string(),
  sig: z.string().regex(/^[0-9a-f]{128}$/),
})
const RumorShape = z.strictObject({ id: Hex64, pubkey: Hex64, created_at: Timestamp, kind: z.number().int().nonnegative(), tags: Tags, content: z.string() })

const fail = (stage: OpenFailureStage, detail: string): OpenFailure => ({ ok: false, stage, detail })

function byteSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

// nostr-tools' verifyEvent trusts a marker that object spread copies. Always verify a plain object
// rebuilt field by field from parsed data.
const plainEvent = (e: z.infer<typeof EventShape>): NostrEvent => ({
  id: e.id,
  pubkey: e.pubkey,
  created_at: e.created_at,
  kind: e.kind,
  tags: e.tags,
  content: e.content,
  sig: e.sig,
})

export function precheckWrap(raw: unknown, ctx: OpenContext): PrecheckedWrap | OpenFailure {
  if (byteSize(raw) > NOSTR.maxWrapBytes) return fail('size', 'event exceeds 64 KB')
  const shape = EventShape.safeParse(raw)
  if (!shape.success) return fail('structure', 'malformed event')
  const wrap = plainEvent(shape.data)
  if (wrap.kind !== NOSTR.wrapKind) return fail('structure', 'not a gift wrap')
  const recipients = wrap.tags.filter((t) => t[0] === 'p')
  if (recipients.length !== 1 || recipients[0]![1] !== ctx.identity.publicKey) return fail('structure', 'not addressed to this identity')
  if (isFutureDated(wrap.created_at, ctx.now)) return fail('structure', 'wrap dated in the future')
  if (getEventHash(wrap) !== wrap.id) return fail('id', 'wrap id does not match its content')
  const powBits = leadingZeroBits(wrap.id)
  if (powBits < NOSTR.powMessageBits) return fail('pow', 'wrap has less than 16 bits of proof of work')
  if (ctx.seen.has(wrap.id)) return fail('duplicate', 'wrap already processed')
  if (!verifyEvent(wrap)) return fail('signature', 'invalid wrap signature')
  ctx.seen.add(wrap.id)
  return { ok: true, wrap, powBits }
}

export function openWrap(prechecked: PrecheckedWrap, ctx: OpenContext): OpenedMessage | OpenFailure {
  let sealRaw: unknown
  try {
    sealRaw = JSON.parse(decrypt(prechecked.wrap.content, getConversationKey(ctx.identity.secretKey, prechecked.wrap.pubkey)))
  } catch {
    return fail('seal', 'wrap content is not a decryptable seal')
  }
  if (byteSize(sealRaw) > NOSTR.maxSealBytes) return fail('seal', 'seal exceeds 48 KB')
  const sealShape = EventShape.safeParse(sealRaw)
  if (!sealShape.success) return fail('seal', 'malformed seal')
  const seal = plainEvent(sealShape.data)
  if (seal.kind !== NOSTR.sealKind) return fail('seal', 'unexpected seal kind')
  if (isFutureDated(seal.created_at, ctx.now)) return fail('seal', 'seal dated in the future')
  if (getEventHash(seal) !== seal.id || !verifyEvent(seal)) return fail('seal', 'invalid seal signature')

  let rumorRaw: unknown
  try {
    rumorRaw = JSON.parse(decrypt(seal.content, getConversationKey(ctx.identity.secretKey, seal.pubkey)))
  } catch {
    return fail('rumor', 'seal content is not a decryptable rumor')
  }
  if (byteSize(rumorRaw) > NOSTR.maxRumorBytes) return fail('rumor', 'rumor exceeds 32 KB')
  const rumorShape = RumorShape.safeParse(rumorRaw)
  if (!rumorShape.success) return fail('rumor', 'malformed rumor')
  const r = rumorShape.data
  const rumor: Rumor = { id: r.id, pubkey: r.pubkey, created_at: r.created_at, kind: r.kind, tags: r.tags, content: r.content }
  if (rumor.kind !== NOSTR.rumorKind) return fail('rumor', 'unexpected rumor kind')
  if (getEventHash(rumor) !== rumor.id) return fail('rumor', 'rumor id does not match its content')
  if (rumor.pubkey !== seal.pubkey) return fail('rumor', 'rumor author differs from the seal signer')
  if (isFutureDated(rumor.created_at, ctx.now)) return fail('rumor', 'rumor dated in the future')

  let content: unknown
  try {
    content = JSON.parse(rumor.content)
  } catch {
    return fail('content', 'rumor content is not JSON')
  }
  const message = MessageSchema.safeParse(content)
  if (!message.success) return fail('content', 'rumor content is not a valid protocol message')
  if (message.data.type === 'connect_request' && prechecked.powBits < NOSTR.powRequestBits) {
    return fail('request_pow', 'connection request has less than 22 bits of proof of work')
  }
  return { ok: true, wrapId: prechecked.wrap.id, senderPubkey: seal.pubkey, rumor, message: message.data, powBits: prechecked.powBits }
}
```

In `packages/core/src/index.ts`, append:

```ts
export * from './envelope/dedupe'
export * from './envelope/open'
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/envelope-open.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/envelope/dedupe.ts packages/core/src/envelope/open.ts packages/core/src/index.ts packages/core/test/support/craft.ts packages/core/test/envelope-open.test.ts
git commit -m "feat(core): receive pipeline that verifies size, id, work and signature before decrypting"
```

---

### Task 12: A fake NIP-01 relay for tests

**Files:**
- Create: `packages/core/test/support/fake-board.ts`
- Modify: `packages/core/package.json`, root `package.json` (dev dependency)
- Test: `packages/core/test/fake-board.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (uses `ws` and `nostr-tools/pure`).
- Produces (test-only):
  - `type Filter = { ids?: string[]; kinds?: number[]; '#p'?: string[]; since?: number; until?: number; limit?: number }`
  - `type FakeBoardOptions = { requireAuthToRead?: boolean; requireAuthToWrite?: boolean; sendAuthChallenge?: boolean; rejectReads?: boolean; ignoreReads?: boolean; maxFrameBytes?: number; maxLimit?: number; dropIncoming?: (event: NostrEvent) => boolean }` — defaults: no auth, challenge sent whenever auth is required, `maxFrameBytes` 65 536, `maxLimit` 500.
  - `type FakeBoard = { readonly url: string; readonly events: NostrEvent[]; readonly authenticated: Set<string>; readonly frames: unknown[][]; options: FakeBoardOptions; inject(event: NostrEvent): void; disconnectAll(): void; close(): Promise<void> }` — `frames` records every frame received from clients; `inject` stores without validation and broadcasts to matching live subscriptions.
  - `startFakeBoard(options?: FakeBoardOptions): Promise<FakeBoard>` — listens on `ws://127.0.0.1:<random port>`.
  - `plainSocketFactory: (url: string) => WebSocket` — for tests only; production uses `pinnedSocketFactory` (Task 13), which refuses `ws://`.

- [ ] **Step 1: Add the dependencies**

In `packages/core/package.json`, replace the `dependencies` line with:

```json
  "dependencies": { "nostr-tools": "2.25.2", "ws": "8.21.3", "zod": "^4.6.3" }
```

In the root `package.json`, add to `devDependencies` (keep alphabetical order):

```json
    "@types/ws": "8.18.1",
```

Run: `npm install`
Expected: `ws@8.21.3` and `@types/ws@8.18.1` in `package-lock.json`.

- [ ] **Step 2: Write the failing tests**

Create `packages/core/test/fake-board.test.ts`:

```ts
import { makeAuthEvent } from 'nostr-tools/nip42'
import { finalizeEvent, type NostrEvent } from 'nostr-tools/pure'
import WebSocket from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { startFakeBoard, type FakeBoard } from './support/fake-board'
import { testIdentity } from './support/keys'

const alice = testIdentity(1)
const boards: FakeBoard[] = []
afterEach(async () => {
  await Promise.all(boards.splice(0).map((b) => b.close()))
})

async function board(options = {}) {
  const b = await startFakeBoard(options)
  boards.push(b)
  return b
}

async function client(url: string) {
  const ws = new WebSocket(url)
  const inbox: unknown[][] = []
  ws.on('message', (data) => inbox.push(JSON.parse(String(data))))
  await new Promise((r) => ws.once('open', r))
  const next = async (predicate: (f: unknown[]) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const found = inbox.find(predicate)
      if (found) {
        inbox.splice(inbox.indexOf(found), 1)
        return found
      }
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('frame not received')
  }
  return { ws, next, inbox, send: (frame: unknown[]) => ws.send(JSON.stringify(frame)) }
}

const note = (content: string, created_at: number, p = 'b'.repeat(64)): NostrEvent =>
  finalizeEvent({ kind: 1059, created_at, tags: [['p', p]], content }, alice.secretKey)

describe('fake board', () => {
  it('stores events, answers OK, reports duplicates and serves them newest first with EOSE', async () => {
    const b = await board()
    const c = await client(b.url)
    const older = note('a', 100)
    const newer = note('b', 200)
    c.send(['EVENT', older])
    expect(await c.next((f) => f[0] === 'OK')).toEqual(['OK', older.id, true, ''])
    c.send(['EVENT', newer])
    await c.next((f) => f[0] === 'OK')
    c.send(['EVENT', older])
    expect(await c.next((f) => f[0] === 'OK')).toEqual(['OK', older.id, true, 'duplicate: already have this event'])
    c.send(['REQ', 's1', { kinds: [1059], '#p': ['b'.repeat(64)], limit: 10 }])
    expect((await c.next((f) => f[0] === 'EVENT'))[2]).toMatchObject({ id: newer.id })
    expect((await c.next((f) => f[0] === 'EVENT'))[2]).toMatchObject({ id: older.id })
    expect(await c.next((f) => f[0] === 'EOSE')).toEqual(['EOSE', 's1'])
    c.ws.close()
  })

  it('pushes new matching events to live subscriptions', async () => {
    const b = await board()
    const c = await client(b.url)
    c.send(['REQ', 'live', { kinds: [1059], since: 50 }])
    await c.next((f) => f[0] === 'EOSE')
    b.inject(note('later', 300))
    expect((await c.next((f) => f[0] === 'EVENT'))[1]).toBe('live')
    c.ws.close()
  })

  it('requires NIP-42 auth when configured, and accepts a valid AUTH event', async () => {
    const b = await board({ requireAuthToRead: true, requireAuthToWrite: true })
    const c = await client(b.url)
    const challenge = (await c.next((f) => f[0] === 'AUTH'))[1] as string
    c.send(['REQ', 's', { kinds: [1059] }])
    expect(await c.next((f) => f[0] === 'CLOSED')).toEqual(['CLOSED', 's', 'auth-required: reading requires authentication'])
    const auth = finalizeEvent(makeAuthEvent(b.url, challenge), alice.secretKey)
    c.send(['AUTH', auth])
    expect(await c.next((f) => f[0] === 'OK')).toEqual(['OK', auth.id, true, ''])
    expect(b.authenticated.has(alice.publicKey)).toBe(true)
    c.send(['REQ', 's', { kinds: [1059] }])
    expect(await c.next((f) => f[0] === 'EOSE')).toEqual(['EOSE', 's'])
    c.ws.close()
  })

  it('can reject reads, reject oversize frames and pretend to store events it drops', async () => {
    const b = await board({ rejectReads: true, maxFrameBytes: 600, dropIncoming: () => true })
    const c = await client(b.url)
    const big = note('x'.repeat(700), 1)
    c.send(['EVENT', big])
    expect(await c.next((f) => f[0] === 'OK')).toEqual(['OK', big.id, false, 'invalid: event too large'])
    const small = note('y', 1)
    c.send(['EVENT', small])
    expect(await c.next((f) => f[0] === 'OK')).toEqual(['OK', small.id, true, ''])
    expect(b.events).toHaveLength(0)
    c.send(['REQ', 'r', {}])
    expect(await c.next((f) => f[0] === 'CLOSED')).toEqual(['CLOSED', 'r', 'restricted: reads are disabled'])
    c.ws.close()
  })

  it('caps results at its own maximum limit', async () => {
    const b = await board({ maxLimit: 3 })
    for (let i = 0; i < 5; i++) b.inject(note(String(i), 1000 + i))
    const c = await client(b.url)
    c.send(['REQ', 'cap', { limit: 100 }])
    await c.next((f) => f[0] === 'EOSE')
    expect(c.inbox.filter((f) => f[0] === 'EVENT')).toHaveLength(3)
    c.ws.close()
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/fake-board.test.ts`
Expected: FAIL — cannot resolve `./support/fake-board`.

- [ ] **Step 4: Implement the fake board**

Create `packages/core/test/support/fake-board.ts`:

```ts
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { verifyEvent, type NostrEvent } from 'nostr-tools/pure'
import WebSocket, { WebSocketServer } from 'ws'

export type Filter = { ids?: string[]; kinds?: number[]; '#p'?: string[]; since?: number; until?: number; limit?: number }

export type FakeBoardOptions = {
  requireAuthToRead?: boolean
  requireAuthToWrite?: boolean
  sendAuthChallenge?: boolean
  rejectReads?: boolean
  ignoreReads?: boolean
  maxFrameBytes?: number
  maxLimit?: number
  dropIncoming?: (event: NostrEvent) => boolean
}

export type FakeBoard = {
  readonly url: string
  readonly events: NostrEvent[]
  readonly authenticated: Set<string>
  readonly frames: unknown[][]
  options: FakeBoardOptions
  inject(event: NostrEvent): void
  disconnectAll(): void
  close(): Promise<void>
}

export const plainSocketFactory = (url: string): WebSocket => new WebSocket(url, { perMessageDeflate: false })

function matches(filter: Filter, event: NostrEvent): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false
  if (filter['#p'] && !event.tags.some((t) => t[0] === 'p' && filter['#p']!.includes(t[1] ?? ''))) return false
  if (filter.since !== undefined && event.created_at < filter.since) return false
  if (filter.until !== undefined && event.created_at > filter.until) return false
  return true
}

type Session = { socket: WebSocket; challenge: string; authed: Set<string>; subs: Map<string, Filter[]> }

export async function startFakeBoard(initial: FakeBoardOptions = {}): Promise<FakeBoard> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
  const events: NostrEvent[] = []
  const authenticated = new Set<string>()
  const frames: unknown[][] = []
  const sessions = new Set<Session>()

  const board: FakeBoard = {
    url,
    events,
    authenticated,
    frames,
    options: { ...initial },
    inject(event) {
      events.push(event)
      broadcast(event)
    },
    disconnectAll() {
      for (const s of sessions) s.socket.terminate()
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sessions) s.socket.terminate()
        server.close(() => resolve())
      }),
  }

  const send = (s: Session, frame: unknown[]) => {
    if (s.socket.readyState === WebSocket.OPEN) s.socket.send(JSON.stringify(frame))
  }

  function broadcast(event: NostrEvent) {
    for (const s of sessions) {
      for (const [id, filters] of s.subs) {
        if (filters.some((f) => matches(f, event))) send(s, ['EVENT', id, event])
      }
    }
  }

  server.on('connection', (socket) => {
    const session: Session = { socket, challenge: randomBytes(16).toString('hex'), authed: new Set(), subs: new Map() }
    sessions.add(session)
    socket.on('close', () => sessions.delete(session))
    const o = () => board.options
    if ((o().requireAuthToRead || o().requireAuthToWrite) && o().sendAuthChallenge !== false) send(session, ['AUTH', session.challenge])

    socket.on('message', (data) => {
      const text = String(data)
      let frame: unknown
      try {
        frame = JSON.parse(text)
      } catch {
        send(session, ['NOTICE', 'error: invalid JSON'])
        return
      }
      if (!Array.isArray(frame)) return
      frames.push(frame)
      const [type] = frame
      if (type === 'EVENT') {
        const event = frame[1] as NostrEvent
        if (Buffer.byteLength(text) > (o().maxFrameBytes ?? 65_536)) {
          send(session, ['OK', event?.id ?? '', false, 'invalid: event too large'])
          return
        }
        if (!verifyEvent(JSON.parse(JSON.stringify(event)))) {
          send(session, ['OK', event?.id ?? '', false, 'invalid: bad signature'])
          return
        }
        if (o().requireAuthToWrite && session.authed.size === 0) {
          send(session, ['OK', event.id, false, 'auth-required: publishing requires authentication'])
          return
        }
        if (events.some((e) => e.id === event.id)) {
          send(session, ['OK', event.id, true, 'duplicate: already have this event'])
          return
        }
        send(session, ['OK', event.id, true, ''])
        if (o().dropIncoming?.(event)) return
        events.push(event)
        broadcast(event)
        return
      }
      if (type === 'REQ') {
        const id = String(frame[1])
        const filters = frame.slice(2) as Filter[]
        if (o().ignoreReads) return
        if (o().rejectReads) {
          send(session, ['CLOSED', id, 'restricted: reads are disabled'])
          return
        }
        if (o().requireAuthToRead && session.authed.size === 0) {
          send(session, ['CLOSED', id, 'auth-required: reading requires authentication'])
          return
        }
        session.subs.set(id, filters)
        const maxLimit = o().maxLimit ?? 500
        const out = new Map<string, NostrEvent>()
        for (const filter of filters) {
          const limit = Math.min(filter.limit ?? maxLimit, maxLimit)
          const hits = events
            .filter((e) => matches(filter, e))
            .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
            .slice(0, limit)
          for (const hit of hits) out.set(hit.id, hit)
        }
        for (const hit of [...out.values()].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))) {
          send(session, ['EVENT', id, hit])
        }
        send(session, ['EOSE', id])
        return
      }
      if (type === 'CLOSE') {
        session.subs.delete(String(frame[1]))
        return
      }
      if (type === 'AUTH') {
        const auth = JSON.parse(JSON.stringify(frame[1])) as NostrEvent
        const tag = (name: string) => auth.tags?.find((t) => t[0] === name)?.[1]
        const fresh = Math.abs(auth.created_at - Math.floor(Date.now() / 1000)) <= 600
        const valid = auth.kind === 22242 && tag('challenge') === session.challenge && tag('relay') === url && fresh && verifyEvent(auth)
        if (valid) {
          session.authed.add(auth.pubkey)
          authenticated.add(auth.pubkey)
        }
        send(session, ['OK', auth.id, valid, valid ? '' : 'invalid: bad auth event'])
      }
    })
  })

  return board
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/fake-board.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/package.json package.json package-lock.json packages/core/test/support/fake-board.ts packages/core/test/fake-board.test.ts
git commit -m "test(core): in-memory NIP-01 relay with auth, caps, rejection and drop modes"
```

---

### Task 13: Board connection — a sequential NIP-01 reader over a validated, pinned socket, with NIP-42 retry

**Files:**
- Create: `packages/core/src/boards/socket.ts`, `packages/core/src/boards/connection.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/boards-connection.test.ts`

**Interfaces:**
- Consumes: `Identity` (Task 2); `checkRelayUrl`, `safeLookup`, `createSafeLookup` (Task 3); `startFakeBoard`, `plainSocketFactory` (Task 12, tests only).
- Produces:
  - `type SocketFactory = (url: string) => WebSocket` (`ws` client).
  - `createPinnedSocketFactory(lookup?: LookupFunction): SocketFactory` and `pinnedSocketFactory = createPinnedSocketFactory()` — re-validates every URL with `checkRelayUrl` (so `wss://127.0.0.1` or `wss://localhost` throw before any socket exists), connects to the normalized URL with `lookup`, `followRedirects: false`, `maxPayload` 1 MiB, `handshakeTimeout` 10 s, no compression.
  - `type Filter = { kinds?: number[]; '#p'?: string[]; since?: number; until?: number; limit?: number }`
  - `type SubscriptionHandlers = { onEvent(raw: unknown): void | Promise<void>; onEose(): void; onClosed(reason: string): void }`
  - `type PublishResult = { ok: boolean; message: string }`
  - `class BoardConnection extends EventEmitter` with `constructor({ url, identity, createSocket?, timeoutMs?, log? })`, `readonly url`, `get isOpen(): boolean`, `connect(): Promise<void>`, `publish(event: NostrEvent, beforeSend?: () => boolean): Promise<PublishResult>`, `subscribe(id: string, filters: Filter[], handlers: SubscriptionHandlers): void`, `unsubscribe(id: string): void`, `close(): void`; emits `'close'`.
  - `beforeSend` runs synchronously immediately before **each** `EVENT` write — after the connection is open and again after a NIP-42 retry. If it returns `false`, nothing is written and the result is `{ ok: false, message: 'error: publish guard refused' }`. Plans 2 and 3 use it to re-check the outbox claim and take the publish reservation at the moment of sending.
  - Behavior: frames are read through `createWebSocketStream(socket, { readableObjectMode: true })` one at a time, and `onEvent` is **awaited** before the next frame is read — so a slow consumer makes `ws` stop reading from the network instead of piling frames up in memory (while an `onEvent` is pending, `OK` frames for publishes on the same connection also wait). `OK false` or `CLOSED` whose reason starts with `auth-required:` triggers **one** NIP-42 authentication (using the last `AUTH` challenge) and one retry; without a challenge, or if auth fails, the original result is returned. A closed socket resolves every pending publish with `{ ok: false, message: 'error: connection closed' }` and closes every subscription with that reason. Frames that are not JSON arrays are ignored; an exception thrown by a handler is logged and does not stop the reader.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/boards-connection.test.ts`:

```ts
import { finalizeEvent, type NostrEvent } from 'nostr-tools/pure'
import { afterEach, describe, expect, it } from 'vitest'
import { BoardConnection, createPinnedSocketFactory, createSafeLookup, pinnedSocketFactory, type SubscriptionHandlers } from '@agentbridge/core'
import { plainSocketFactory, startFakeBoard, type FakeBoardOptions } from './support/fake-board'
import { testIdentity } from './support/keys'

const me = testIdentity(5)
const other = testIdentity(6)
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function setup(options: FakeBoardOptions = {}) {
  const board = await startFakeBoard(options)
  const conn = new BoardConnection({ url: board.url, identity: me, createSocket: plainSocketFactory, timeoutMs: 2_000 })
  cleanups.push(() => board.close(), () => conn.close())
  await conn.connect()
  return { board, conn }
}

const wrapFor = (content: string, created_at = 1_000): NostrEvent =>
  finalizeEvent({ kind: 1059, created_at, tags: [['p', me.publicKey]], content }, other.secretKey)

function recorder(onEvent?: (raw: unknown) => void | Promise<void>) {
  const events: unknown[] = []
  let eose = 0
  const closed: string[] = []
  const handlers: SubscriptionHandlers = {
    onEvent: async (e) => {
      events.push(e)
      await onEvent?.(e)
    },
    onEose: () => eose++,
    onClosed: (r) => closed.push(r),
  }
  return { handlers, events, closed, eose: () => eose }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(check()).toBe(true)
}

describe('BoardConnection', () => {
  it('publishes and reports the relay verdict', async () => {
    const { conn } = await setup()
    const event = wrapFor('hola')
    expect(await conn.publish(event)).toEqual({ ok: true, message: '' })
    expect(await conn.publish(event)).toEqual({ ok: true, message: 'duplicate: already have this event' })
  })

  it('reports a rejection without throwing', async () => {
    const { conn } = await setup({ maxFrameBytes: 300 })
    expect(await conn.publish(wrapFor('x'.repeat(400)))).toEqual({ ok: false, message: 'invalid: event too large' })
  })

  it('authenticates once and retries when publishing requires auth', async () => {
    const { board, conn } = await setup({ requireAuthToWrite: true })
    expect(await conn.publish(wrapFor('con auth'))).toEqual({ ok: true, message: '' })
    expect(board.authenticated.has(me.publicKey)).toBe(true)
    expect(board.frames.filter((f) => f[0] === 'AUTH')).toHaveLength(1)
  })

  it('returns the auth-required verdict when the relay never sent a challenge', async () => {
    const { conn } = await setup({ requireAuthToWrite: true, sendAuthChallenge: false })
    expect(await conn.publish(wrapFor('sin reto'))).toMatchObject({ ok: false, message: expect.stringMatching(/^auth-required:/) })
  })

  it('never writes the event when the guard refuses right before sending', async () => {
    const { board, conn } = await setup()
    expect(await conn.publish(wrapFor('vetado'), () => false)).toEqual({ ok: false, message: 'error: publish guard refused' })
    expect(board.frames.filter((f) => f[0] === 'EVENT')).toHaveLength(0)
  })

  it('runs the guard again before the write that follows authentication', async () => {
    const { conn } = await setup({ requireAuthToWrite: true })
    let calls = 0
    expect(await conn.publish(wrapFor('dos veces'), () => ++calls <= 2)).toEqual({ ok: true, message: '' })
    expect(calls).toBe(2)
    let refused = 0
    const { conn: second } = await setup({ requireAuthToWrite: true })
    expect(await second.publish(wrapFor('segunda vez no'), () => ++refused === 1)).toEqual({ ok: false, message: 'error: publish guard refused' })
  })

  it('serves stored events, then EOSE, then live events', async () => {
    const { board, conn } = await setup()
    board.inject(wrapFor('guardado', 500))
    const r = recorder()
    conn.subscribe('s', [{ kinds: [1059], '#p': [me.publicKey] }], r.handlers)
    await until(() => r.eose() === 1)
    expect(r.events).toHaveLength(1)
    board.inject(wrapFor('en vivo', 600))
    await until(() => r.events.length === 2)
  })

  it('waits for a slow event handler before reading the next frame', async () => {
    const { board, conn } = await setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const r = recorder(async (raw) => {
      if ((raw as NostrEvent).content === 'primero') await gate
    })
    conn.subscribe('s', [{ kinds: [1059] }], r.handlers)
    await until(() => r.eose() === 1)
    board.inject(wrapFor('primero', 700))
    board.inject(wrapFor('segundo', 701))
    await until(() => r.events.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(r.events).toHaveLength(1)
    release()
    await until(() => r.events.length === 2)
  })

  it('authenticates and re-subscribes when reading requires auth', async () => {
    const { board, conn } = await setup({ requireAuthToRead: true })
    board.inject(wrapFor('privado', 700))
    const r = recorder()
    conn.subscribe('s', [{ kinds: [1059] }], r.handlers)
    await until(() => r.eose() === 1)
    expect(r.events).toHaveLength(1)
    expect(r.closed).toEqual([])
  })

  it('passes a non-auth CLOSED reason through without retrying', async () => {
    const { board, conn } = await setup({ rejectReads: true })
    const r = recorder()
    conn.subscribe('s', [{ kinds: [1059] }], r.handlers)
    await until(() => r.closed.length === 1)
    expect(r.closed).toEqual(['restricted: reads are disabled'])
    expect(board.frames.filter((f) => f[0] === 'REQ')).toHaveLength(1)
  })

  it('closes subscriptions and pending publishes when the socket drops', async () => {
    const { board, conn } = await setup({ ignoreReads: true })
    const r = recorder()
    conn.subscribe('s', [{ kinds: [1059] }], r.handlers)
    let closedEvent = false
    conn.on('close', () => (closedEvent = true))
    board.disconnectAll()
    await until(() => closedEvent)
    expect(r.closed).toEqual(['error: connection closed'])
    expect(conn.isOpen).toBe(false)
    expect(await conn.publish(wrapFor('tarde'))).toEqual({ ok: false, message: 'error: connection closed' })
  })
})

describe('pinned socket factory', () => {
  it.each(['ws://relay.example.com', 'wss://127.0.0.1:7777', 'wss://[::1]', 'wss://localhost:9', 'wss://relay.example.com/?x=1'])(
    'refuses %s before opening any socket',
    (url) => {
      expect(() => pinnedSocketFactory(url)).toThrow(/tablero/)
    },
  )

  it('refuses to connect when the validated name resolves to a forbidden address', async () => {
    const factory = createPinnedSocketFactory(createSafeLookup(async () => [{ address: '10.0.0.1', family: 4 }]))
    const socket = factory('wss://relay.example.com')
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => socket.once('error', resolve))
    expect(error.code).toBe('EAGENTBRIDGE_FORBIDDEN_ADDRESS')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/boards-connection.test.ts`
Expected: FAIL — `BoardConnection` is not exported.

- [ ] **Step 3: Implement the socket factory**

Create `packages/core/src/boards/socket.ts`:

```ts
import type { LookupFunction } from 'node:net'
import WebSocket from 'ws'
import { checkRelayUrl, safeLookup } from '../relay-url'

export type SocketFactory = (url: string) => WebSocket

// Every URL is re-validated here, whoever the caller is: an IP literal would skip `lookup`
// entirely. ws forwards `lookup` to tls.connect, so the socket connects with exactly the addresses
// that lookup validated — no second DNS resolution for a rebinding server to swap.
export function createPinnedSocketFactory(lookup: LookupFunction = safeLookup): SocketFactory {
  return (url) => {
    const checked = checkRelayUrl(url)
    if (!checked.ok) throw new Error(`pinnedSocketFactory: ${checked.reason}`)
    const options: WebSocket.ClientOptions & { lookup: LookupFunction } = {
      lookup,
      followRedirects: false,
      maxPayload: 1024 * 1024,
      handshakeTimeout: 10_000,
      perMessageDeflate: false,
    }
    return new WebSocket(checked.url, options)
  }
}

export const pinnedSocketFactory: SocketFactory = createPinnedSocketFactory()
```

- [ ] **Step 4: Implement the connection**

Create `packages/core/src/boards/connection.ts`:

```ts
import { EventEmitter } from 'node:events'
import { makeAuthEvent } from 'nostr-tools/nip42'
import { finalizeEvent, type NostrEvent } from 'nostr-tools/pure'
import WebSocket, { createWebSocketStream } from 'ws'
import type { Identity } from '../identity'
import { pinnedSocketFactory, type SocketFactory } from './socket'

export type Filter = { kinds?: number[]; '#p'?: string[]; since?: number; until?: number; limit?: number }
export type SubscriptionHandlers = { onEvent(raw: unknown): void | Promise<void>; onEose(): void; onClosed(reason: string): void }
export type PublishResult = { ok: boolean; message: string }

export type BoardConnectionOptions = {
  url: string
  identity: Identity
  createSocket?: SocketFactory
  timeoutMs?: number
  log?: (line: string) => void
}

type Subscription = { filters: Filter[]; handlers: SubscriptionHandlers; retriedAuth: boolean }

const CLOSED_REASON = 'error: connection closed'

export class BoardConnection extends EventEmitter {
  readonly url: string
  private readonly identity: Identity
  private readonly createSocket: SocketFactory
  private readonly timeoutMs: number
  private readonly log: (line: string) => void
  private socket: WebSocket | null = null
  private opening: Promise<void> | null = null
  private challenge: string | null = null
  private authenticated = false
  private authInFlight: Promise<boolean> | null = null
  private readonly pendingOk = new Map<string, (result: PublishResult) => void>()
  private readonly subs = new Map<string, Subscription>()

  constructor(options: BoardConnectionOptions) {
    super()
    this.url = options.url
    this.identity = options.identity
    this.createSocket = options.createSocket ?? pinnedSocketFactory
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.log = options.log ?? (() => {})
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  connect(): Promise<void> {
    if (this.opening) return this.opening
    this.opening = new Promise<void>((resolve, reject) => {
      let socket: WebSocket
      try {
        socket = this.createSocket(this.url)
      } catch (err) {
        this.opening = null
        reject(err)
        return
      }
      this.socket = socket
      // The stream must exist before the first frame can arrive; it owns all reading from here on.
      const stream = createWebSocketStream(socket, { readableObjectMode: true })
      stream.on('error', (err) => this.log(`${this.url}: ${err.message}`))
      void this.readFrames(stream)
      const timer = setTimeout(() => {
        socket.terminate()
        reject(new Error(`timed out connecting to ${this.url}`))
      }, this.timeoutMs)
      socket.on('open', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      socket.on('close', () => {
        clearTimeout(timer)
        reject(new Error(`connection to ${this.url} closed`))
        this.handleClose(socket)
      })
    })
    return this.opening
  }

  async publish(event: NostrEvent, beforeSend: () => boolean = () => true): Promise<PublishResult> {
    const first = await this.sendEvent(event, beforeSend)
    if (first.ok || !first.message.startsWith('auth-required:')) return first
    if (!(await this.authenticate())) return first
    return this.sendEvent(event, beforeSend)
  }

  subscribe(id: string, filters: Filter[], handlers: SubscriptionHandlers): void {
    this.subs.set(id, { filters, handlers, retriedAuth: false })
    if (!this.send(['REQ', id, ...filters])) {
      this.subs.delete(id)
      handlers.onClosed(CLOSED_REASON)
    }
  }

  unsubscribe(id: string): void {
    if (this.subs.delete(id)) this.send(['CLOSE', id])
  }

  close(): void {
    this.socket?.close()
  }

  private async readFrames(stream: AsyncIterable<unknown>): Promise<void> {
    try {
      for await (const chunk of stream) await this.onFrame(chunk)
    } catch {
      // Socket errors surface through the 'close' handler.
    }
  }

  private send(frame: unknown[]): boolean {
    if (!this.isOpen) return false
    this.socket!.send(JSON.stringify(frame))
    return true
  }

  private sendEvent(event: NostrEvent, beforeSend: () => boolean): Promise<PublishResult> {
    return new Promise((resolve) => {
      if (!this.isOpen) {
        resolve({ ok: false, message: CLOSED_REASON })
        return
      }
      // Checked at the last synchronous moment before the write, so a claim that expired while we
      // were connecting or authenticating can never be published.
      if (!beforeSend()) {
        resolve({ ok: false, message: 'error: publish guard refused' })
        return
      }
      const timer = setTimeout(() => {
        this.pendingOk.delete(event.id)
        resolve({ ok: false, message: 'error: timed out waiting for OK' })
      }, this.timeoutMs)
      this.pendingOk.set(event.id, (result) => {
        clearTimeout(timer)
        this.pendingOk.delete(event.id)
        resolve(result)
      })
      this.send(['EVENT', event])
    })
  }

  private authenticate(): Promise<boolean> {
    if (this.authenticated) return Promise.resolve(true)
    const challenge = this.challenge
    if (!challenge) return Promise.resolve(false)
    this.authInFlight ??= new Promise<boolean>((resolve) => {
      const auth = finalizeEvent(makeAuthEvent(this.url, challenge), this.identity.secretKey)
      const timer = setTimeout(() => {
        this.pendingOk.delete(auth.id)
        resolve(false)
      }, this.timeoutMs)
      this.pendingOk.set(auth.id, (result) => {
        clearTimeout(timer)
        this.pendingOk.delete(auth.id)
        this.authenticated = result.ok
        resolve(result.ok)
      })
      if (!this.send(['AUTH', auth])) {
        clearTimeout(timer)
        this.pendingOk.delete(auth.id)
        resolve(false)
      }
    }).finally(() => {
      this.authInFlight = null
    })
    return this.authInFlight
  }

  private async onFrame(chunk: unknown): Promise<void> {
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    let frame: unknown
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    if (!Array.isArray(frame) || typeof frame[0] !== 'string') return
    switch (frame[0]) {
      case 'EVENT': {
        const sub = this.subs.get(String(frame[1]))
        if (!sub) return
        try {
          await sub.handlers.onEvent(frame[2])
        } catch (err) {
          this.log(`${this.url}: event handler failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
      case 'EOSE': {
        this.subs.get(String(frame[1]))?.handlers.onEose()
        return
      }
      case 'CLOSED': {
        const id = String(frame[1])
        const reason = String(frame[2] ?? '')
        const sub = this.subs.get(id)
        if (!sub) return
        if (reason.startsWith('auth-required:') && !sub.retriedAuth) {
          sub.retriedAuth = true
          void this.authenticate().then((ok) => {
            if (!this.subs.has(id)) return
            if (ok && this.send(['REQ', id, ...sub.filters])) return
            this.subs.delete(id)
            sub.handlers.onClosed(reason)
          })
          return
        }
        this.subs.delete(id)
        sub.handlers.onClosed(reason)
        return
      }
      case 'OK': {
        this.pendingOk.get(String(frame[1]))?.({ ok: frame[2] === true, message: String(frame[3] ?? '') })
        return
      }
      case 'AUTH': {
        if (typeof frame[1] === 'string') this.challenge = frame[1]
        return
      }
      case 'NOTICE': {
        this.log(`${this.url} notice: ${String(frame[1]).slice(0, 200)}`)
        return
      }
    }
  }

  private handleClose(socket: WebSocket): void {
    if (this.socket !== socket) return
    this.socket = null
    this.opening = null
    this.challenge = null
    this.authenticated = false
    for (const resolve of [...this.pendingOk.values()]) resolve({ ok: false, message: CLOSED_REASON })
    this.pendingOk.clear()
    const subs = [...this.subs.values()]
    this.subs.clear()
    for (const sub of subs) sub.handlers.onClosed(CLOSED_REASON)
    this.emit('close')
  }
}
```

In `packages/core/src/index.ts`, append:

```ts
export * from './boards/socket'
export * from './boards/connection'
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/boards-connection.test.ts && npm run typecheck`
Expected: PASS. No test needs the internet: the forbidden-address case injects its resolver.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/boards/socket.ts packages/core/src/boards/connection.ts packages/core/src/index.ts packages/core/test/boards-connection.test.ts
git commit -m "feat(core): sequential NIP-01 board connection over a validated, DNS-pinned socket with a single NIP-42 retry"
```

---

### Task 14: Board pool — publish to several relays, one-shot queries, bounded live subscription

**Files:**
- Create: `packages/core/src/boards/receive-queue.ts`, `packages/core/src/boards/pool.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/boards-queue.test.ts`, `packages/core/test/boards-pool.test.ts`

**Interfaces:**
- Consumes: `Identity`, `NOSTR`, `nowSeconds` (Task 2); `BoardConnection`, `Filter`, `SocketFactory` (Task 13); `startFakeBoard`, `plainSocketFactory` (Task 12, tests only).
- Produces:
  - `class ReceiveQueue<T>` with `constructor({ max, process(item, source): Promise<void>, onPressure?(source, waiting): void, onError?(err, source): void })`, `push(source: string, item: T): Promise<void>` (waits while the queue holds `max` items), `readonly length: number` (never above `max`), `idle(): Promise<void>`. Processes one item at a time, in arrival order; never drops items; `onPressure(source, true)` when a push has to wait and `(source, false)` when it gets room.
  - `type PoolOptions = { identity: Identity; createSocket?: SocketFactory; timeoutMs?: number; reconnectDelaysMs?: readonly number[]; now?: () => number; log?: (line: string) => void; onPressure?: (relay: string, waiting: boolean) => void }`
  - `type PublishOutcome = { accepted: string[]; rejected: Array<{ relay: string; reason: string }> }`
  - `type QueryResult = { events: unknown[]; complete: boolean; closedReason: string | null }` — `complete` means `EOSE` arrived.
  - `type LiveHandlers<T> = { precheck(raw: unknown, relay: string): T | null; process(item: T, relay: string): Promise<void> }` — **contract:** if `process` fails after `precheckWrap` recorded the wrap id, `process` must call `seen.delete(wrapId)` before rethrowing (Task 11).
  - `class BoardPool` with `publish(relays, event, beforeSend?): Promise<PublishOutcome>` (at most 5 distinct relays, in parallel, never throws; `beforeSend` is handed to every `BoardConnection.publish`, so plans 2 and 3 re-check the claim and take the `reservePublish` reservation at the moment of each write), `query(relay, filter, timeoutMs?): Promise<QueryResult>` (never throws), `subscribeLive<T>(relays, handlers): { close(): Promise<void> }` (filter `{ kinds: [1059], '#p': [me], since: now() − NOSTR.liveSinceSeconds }`; each frame's `precheck` runs on arrival and the connection waits for `queue.push`, so a full queue stops reading from that relay; reconnects with `reconnectDelaysMs` — default `[1000, 2000, 5000, 10000, 30000, 60000]` — resetting the delay after each `EOSE`), and `close(): Promise<void>` (first closes every live subscription created by this pool, then the connections).

- [ ] **Step 1: Write the failing queue tests**

Create `packages/core/test/boards-queue.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ReceiveQueue } from '@agentbridge/core'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('ReceiveQueue', () => {
  it('processes one item at a time, in arrival order', async () => {
    let running = 0
    let maxRunning = 0
    const seen: number[] = []
    const queue = new ReceiveQueue<number>({
      max: 100,
      process: async (n) => {
        running++
        maxRunning = Math.max(maxRunning, running)
        await sleep(2)
        seen.push(n)
        running--
      },
    })
    for (let n = 0; n < 20; n++) await queue.push('a', n)
    await queue.idle()
    expect(seen).toEqual([...Array(20).keys()])
    expect(maxRunning).toBe(1)
  })

  it('never holds more than max items: producers wait for room, and nothing is dropped', async () => {
    const signals: Array<[string, boolean]> = []
    let processed = 0
    let longest = 0
    const queue = new ReceiveQueue<number>({
      max: 10,
      onPressure: (source, waiting) => signals.push([source, waiting]),
      process: async () => {
        longest = Math.max(longest, queue.length)
        await sleep(1)
        processed++
      },
    })
    const producer = async (source: string, count: number) => {
      for (let n = 0; n < count; n++) await queue.push(source, n)
    }
    await Promise.all([producer('a', 40), producer('b', 40)])
    await queue.idle()
    expect(processed).toBe(80)
    expect(longest).toBeLessThanOrEqual(10)
    expect(queue.length).toBe(0)
    expect(signals).toContainEqual(['a', true])
    expect(signals).toContainEqual(['a', false])
  })

  it('reports processing errors and keeps going', async () => {
    const errors: string[] = []
    const done: number[] = []
    const queue = new ReceiveQueue<number>({
      max: 10,
      onError: (err) => errors.push((err as Error).message),
      process: async (n) => {
        if (n === 1) throw new Error('boom')
        done.push(n)
      },
    })
    for (const n of [0, 1, 2]) await queue.push('a', n)
    await queue.idle()
    expect(errors).toEqual(['boom'])
    expect(done).toEqual([0, 2])
  })
})
```

- [ ] **Step 2: Write the failing pool tests**

Create `packages/core/test/boards-pool.test.ts`:

```ts
import { finalizeEvent, type NostrEvent } from 'nostr-tools/pure'
import { afterEach, describe, expect, it } from 'vitest'
import { BoardPool, NOSTR, type PoolOptions } from '@agentbridge/core'
import { plainSocketFactory, startFakeBoard, type FakeBoard, type FakeBoardOptions } from './support/fake-board'
import { testIdentity } from './support/keys'

const me = testIdentity(7)
const stranger = testIdentity(8)
const NOW = 10_000_000
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function board(options: FakeBoardOptions = {}): Promise<FakeBoard> {
  const b = await startFakeBoard(options)
  cleanups.push(() => b.close())
  return b
}

function pool(extra: Partial<PoolOptions> = {}): BoardPool {
  const p = new BoardPool({ identity: me, createSocket: plainSocketFactory, timeoutMs: 2_000, now: () => NOW, reconnectDelaysMs: [20], ...extra })
  cleanups.push(() => p.close())
  return p
}

const signed = (content: string): NostrEvent =>
  finalizeEvent({ kind: 1059, created_at: NOW, tags: [['p', me.publicKey]], content }, stranger.secretKey)

const fake = (n: number): NostrEvent => ({
  id: n.toString(16).padStart(64, '0'),
  pubkey: 'c'.repeat(64),
  created_at: NOW,
  kind: 1059,
  tags: [['p', me.publicKey]],
  content: String(n),
  sig: 'd'.repeat(128),
})

const until = async (check: () => boolean, tries = 500) => {
  for (let i = 0; i < tries && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(check()).toBe(true)
}
const reqCount = (b: FakeBoard) => b.frames.filter((f) => f[0] === 'REQ').length

describe('BoardPool.publish', () => {
  it('reports each relay separately and never throws', async () => {
    const good = await board()
    const strict = await board({ maxFrameBytes: 300 })
    const outcome = await pool().publish([good.url, strict.url, 'ws://127.0.0.1:1'], signed('x'.repeat(400)))
    expect(outcome.accepted).toEqual([good.url])
    expect(outcome.rejected).toEqual(
      expect.arrayContaining([
        { relay: strict.url, reason: 'invalid: event too large' },
        { relay: 'ws://127.0.0.1:1', reason: expect.stringMatching(/^error: /) },
      ]),
    )
  })

  it('asks the guard before writing to each relay and sends nothing it refuses', async () => {
    const first = await board()
    const second = await board()
    let asked = 0
    const outcome = await pool().publish([first.url, second.url], signed('vetado'), () => {
      asked++
      return false
    })
    expect(asked).toBe(2)
    expect(outcome.accepted).toEqual([])
    expect(outcome.rejected.map((r) => r.reason)).toEqual(['error: publish guard refused', 'error: publish guard refused'])
    expect(first.events).toHaveLength(0)
    expect(second.events).toHaveLength(0)
  })

  it('publishes to at most five distinct relays', async () => {
    const boards = await Promise.all(Array.from({ length: 6 }, () => board()))
    const urls = boards.map((b) => b.url)
    const outcome = await pool().publish([urls[0]!, ...urls], signed('hola'))
    expect(outcome.accepted).toHaveLength(5)
    expect(boards[5]!.events).toHaveLength(0)
  })
})

describe('BoardPool.query', () => {
  it('returns stored events once EOSE arrives', async () => {
    const b = await board()
    b.inject(fake(1))
    expect(await pool().query(b.url, { kinds: [1059] })).toEqual({ events: [fake(1)], complete: true, closedReason: null })
  })

  it('is incomplete when the relay closes the query, never answers, or cannot be reached', async () => {
    const closing = await board({ rejectReads: true })
    const silent = await board({ ignoreReads: true })
    const p = pool()
    expect(await p.query(closing.url, {})).toMatchObject({ complete: false, closedReason: 'restricted: reads are disabled' })
    expect(await p.query(silent.url, {}, 200)).toMatchObject({ complete: false, closedReason: 'error: timed out waiting for EOSE' })
    expect(await p.query('ws://127.0.0.1:1', {})).toMatchObject({ complete: false, closedReason: expect.stringMatching(/^error: /) })
  })
})

describe('BoardPool.subscribeLive', () => {
  it('subscribes from two days and ten minutes back and processes prechecked items in order', async () => {
    const b = await board()
    const processed: string[] = []
    const live = pool().subscribeLive<NostrEvent>([b.url], {
      precheck: (raw) => ((raw as NostrEvent).content === 'skip' ? null : (raw as NostrEvent)),
      process: async (e) => {
        processed.push(e.content)
      },
    })
    await until(() => reqCount(b) === 1)
    expect(b.frames.find((f) => f[0] === 'REQ')![2]).toEqual({ kinds: [1059], '#p': [me.publicKey], since: NOW - NOSTR.liveSinceSeconds })
    b.inject(fake(1))
    b.inject({ ...fake(2), content: 'skip' })
    b.inject(fake(3))
    await until(() => processed.length === 2)
    expect(processed).toEqual(['1', '3'])
    await live.close()
  })

  it('holds a flood at the queue limit without losing anything', async () => {
    const b = await board()
    const waiting: boolean[] = []
    let processed = 0
    const total = NOSTR.receiveQueueMax * 2 + 50
    const live = pool({ onPressure: (_relay, w) => waiting.push(w) }).subscribeLive<NostrEvent>([b.url], {
      precheck: (raw) => raw as NostrEvent,
      process: async () => {
        await new Promise((r) => setTimeout(r, 2))
        processed++
      },
    })
    await until(() => reqCount(b) === 1)
    for (let n = 1; n <= total; n++) b.inject(fake(n))
    await until(() => processed === total, 3_000)
    expect(waiting).toContain(true)
    expect(waiting.at(-1)).toBe(false)
    await live.close()
  })

  it('reconnects after the relay drops the connection', async () => {
    const b = await board()
    const processed: string[] = []
    const live = pool().subscribeLive<NostrEvent>([b.url], {
      precheck: (raw) => raw as NostrEvent,
      process: async (e) => {
        processed.push(e.content)
      },
    })
    await until(() => reqCount(b) === 1)
    b.disconnectAll()
    await until(() => reqCount(b) === 2)
    b.inject(fake(9))
    await until(() => processed.includes('9'))
    await live.close()
  })

  it('stops reconnecting once the subscription is closed', async () => {
    const b = await board()
    const live = pool().subscribeLive<NostrEvent>([b.url], { precheck: () => null, process: async () => {} })
    await until(() => reqCount(b) === 1)
    await live.close()
    b.disconnectAll()
    await new Promise((r) => setTimeout(r, 200))
    expect(reqCount(b)).toBe(1)
  })

  it('closes its live subscriptions when the pool itself is closed', async () => {
    const b = await board()
    const p = pool()
    p.subscribeLive<NostrEvent>([b.url], { precheck: () => null, process: async () => {} })
    await until(() => reqCount(b) === 1)
    await p.close()
    await new Promise((r) => setTimeout(r, 200))
    expect(reqCount(b)).toBe(1)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/boards-queue.test.ts packages/core/test/boards-pool.test.ts`
Expected: FAIL — `ReceiveQueue` and `BoardPool` are not exported.

- [ ] **Step 4: Implement the queue**

Create `packages/core/src/boards/receive-queue.ts`:

```ts
export type ReceiveQueueOptions<T> = {
  max: number
  process: (item: T, source: string) => Promise<void>
  onPressure?: (source: string, waiting: boolean) => void
  onError?: (err: unknown, source: string) => void
}

// Step 5 of the receive pipeline: decryption and everything after it happen one item at a time, and
// the queue never holds more than `max` items. A producer that finds it full waits; because the
// board connection awaits this push before reading its next frame, a slow consumer stops the socket
// from reading instead of dropping or buffering without bound.
export class ReceiveQueue<T> {
  private readonly items: Array<{ source: string; item: T }> = []
  private readonly capacityWaiters: Array<() => void> = []
  private readonly idleWaiters: Array<() => void> = []
  private draining = false

  constructor(private readonly options: ReceiveQueueOptions<T>) {}

  get length(): number {
    return this.items.length
  }

  async push(source: string, item: T): Promise<void> {
    if (this.items.length >= this.options.max) {
      this.options.onPressure?.(source, true)
      while (this.items.length >= this.options.max) {
        await new Promise<void>((resolve) => this.capacityWaiters.push(resolve))
      }
      this.options.onPressure?.(source, false)
    }
    this.items.push({ source, item })
    void this.drain()
  }

  idle(): Promise<void> {
    if (!this.draining && this.items.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.items.length > 0) {
        const next = this.items.shift()!
        this.capacityWaiters.shift()?.()
        try {
          await this.options.process(next.item, next.source)
        } catch (err) {
          this.options.onError?.(err, next.source)
        }
      }
    } finally {
      this.draining = false
      for (const resolve of this.idleWaiters.splice(0)) resolve()
    }
  }
}
```

- [ ] **Step 5: Implement the pool**

Create `packages/core/src/boards/pool.ts`:

```ts
import { randomBytes } from 'node:crypto'
import type { NostrEvent } from 'nostr-tools/pure'
import type { Identity } from '../identity'
import { NOSTR, nowSeconds } from '../nostr-constants'
import { BoardConnection, type Filter } from './connection'
import { ReceiveQueue } from './receive-queue'
import type { SocketFactory } from './socket'

export type PoolOptions = {
  identity: Identity
  createSocket?: SocketFactory
  timeoutMs?: number
  reconnectDelaysMs?: readonly number[]
  now?: () => number
  log?: (line: string) => void
  onPressure?: (relay: string, waiting: boolean) => void
}

export type PublishOutcome = { accepted: string[]; rejected: Array<{ relay: string; reason: string }> }
export type QueryResult = { events: unknown[]; complete: boolean; closedReason: string | null }
export type LiveHandlers<T> = { precheck(raw: unknown, relay: string): T | null; process(item: T, relay: string): Promise<void> }

const DEFAULT_RECONNECT_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000]
const newSubscriptionId = () => randomBytes(8).toString('hex')
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

export class BoardPool {
  private readonly connections = new Map<string, BoardConnection>()
  private readonly liveClosers = new Set<() => Promise<void>>()

  constructor(private readonly options: PoolOptions) {}

  private async connection(relay: string): Promise<BoardConnection> {
    let conn = this.connections.get(relay)
    if (!conn) {
      const created = new BoardConnection({
        url: relay,
        identity: this.options.identity,
        createSocket: this.options.createSocket,
        timeoutMs: this.options.timeoutMs,
        log: this.options.log,
      })
      created.on('close', () => {
        if (this.connections.get(relay) === created) this.connections.delete(relay)
      })
      this.connections.set(relay, created)
      conn = created
    }
    try {
      await conn.connect()
    } catch (err) {
      if (this.connections.get(relay) === conn) this.connections.delete(relay)
      throw err
    }
    return conn
  }

  async publish(relays: readonly string[], event: NostrEvent, beforeSend: () => boolean = () => true): Promise<PublishOutcome> {
    const outcome: PublishOutcome = { accepted: [], rejected: [] }
    const targets = [...new Set(relays)].slice(0, NOSTR.maxRelaysPerContact)
    await Promise.all(
      targets.map(async (relay) => {
        try {
          const result = await (await this.connection(relay)).publish(event, beforeSend)
          if (result.ok) outcome.accepted.push(relay)
          else outcome.rejected.push({ relay, reason: result.message })
        } catch (err) {
          outcome.rejected.push({ relay, reason: `error: ${messageOf(err)}` })
        }
      }),
    )
    return outcome
  }

  async query(relay: string, filter: Filter, timeoutMs = this.options.timeoutMs ?? 10_000): Promise<QueryResult> {
    let conn: BoardConnection
    try {
      conn = await this.connection(relay)
    } catch (err) {
      return { events: [], complete: false, closedReason: `error: ${messageOf(err)}` }
    }
    const id = newSubscriptionId()
    const events: unknown[] = []
    return new Promise<QueryResult>((resolve) => {
      let finished = false
      const finish = (result: QueryResult) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        conn.unsubscribe(id)
        resolve(result)
      }
      const timer = setTimeout(() => finish({ events, complete: false, closedReason: 'error: timed out waiting for EOSE' }), timeoutMs)
      conn.subscribe(id, [filter], {
        onEvent: (raw) => {
          events.push(raw)
        },
        onEose: () => finish({ events, complete: true, closedReason: null }),
        onClosed: (reason) => finish({ events, complete: false, closedReason: reason }),
      })
    })
  }

  subscribeLive<T>(relays: readonly string[], handlers: LiveHandlers<T>): { close(): Promise<void> } {
    const delays = this.options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS
    const now = this.options.now ?? nowSeconds
    const wakers = new Set<() => void>()
    let stopped = false
    let signalStop!: () => void
    const stop = new Promise<void>((resolve) => (signalStop = resolve))

    const queue = new ReceiveQueue<T>({
      max: NOSTR.receiveQueueMax,
      process: (item, relay) => handlers.process(item, relay),
      onPressure: (relay, waiting) => this.options.onPressure?.(relay, waiting),
      onError: (err, relay) => this.options.log?.(`${relay}: processing failed: ${messageOf(err)}`),
    })

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer)
          wakers.delete(wake)
          resolve()
        }
        const timer = setTimeout(wake, ms)
        wakers.add(wake)
      })

    const run = async (relay: string) => {
      let attempt = 0
      while (!stopped) {
        try {
          const conn = await this.connection(relay)
          if (stopped) break
          const id = newSubscriptionId()
          const closed = new Promise<string>((resolve) => {
            conn.subscribe(id, [{ kinds: [NOSTR.wrapKind], '#p': [this.options.identity.publicKey], since: now() - NOSTR.liveSinceSeconds }], {
              onEvent: async (raw) => {
                if (stopped) return
                const item = handlers.precheck(raw, relay)
                if (item !== null) await queue.push(relay, item)
              },
              onEose: () => {
                attempt = 0
              },
              onClosed: (reason) => resolve(reason),
            })
          })
          const reason = await Promise.race([closed, stop.then(() => 'stopped')])
          conn.unsubscribe(id)
          if (stopped) break
          this.options.log?.(`${relay}: live subscription closed (${reason})`)
        } catch (err) {
          if (stopped) break
          this.options.log?.(`${relay}: ${messageOf(err)}`)
        }
        await sleep(delays[Math.min(attempt, delays.length - 1)]!)
        attempt++
      }
    }

    const loops = [...new Set(relays)].slice(0, NOSTR.maxRelaysPerContact).map((relay) => run(relay))
    const close = async () => {
      if (!stopped) {
        stopped = true
        signalStop()
        for (const wake of [...wakers]) wake()
      }
      await Promise.all(loops)
      await queue.idle()
      this.liveClosers.delete(close)
    }
    this.liveClosers.add(close)
    return { close }
  }

  async close(): Promise<void> {
    await Promise.all([...this.liveClosers].map((close) => close()))
    for (const conn of this.connections.values()) conn.close()
    this.connections.clear()
  }
}
```

In `packages/core/src/index.ts`, append:

```ts
export * from './boards/receive-queue'
export * from './boards/pool'
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/boards-queue.test.ts packages/core/test/boards-pool.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/boards/receive-queue.ts packages/core/src/boards/pool.ts packages/core/src/index.ts packages/core/test/boards-queue.test.ts packages/core/test/boards-pool.test.ts
git commit -m "feat(core): board pool with parallel publishing, one-shot queries and a bounded live subscription"
```

---

### Task 15: History recovery — nine days, paginated, honest about gaps

**Files:**
- Create: `packages/core/src/boards/history.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/boards-history.test.ts`

**Interfaces:**
- Consumes: `Store`, `openStore` (Task 4); `historyWindows`, `markWindowComplete`, `DAY_SECONDS`, `CursorRole`, `HistoryWindow` (Task 7); `NOSTR` (Task 2); `BoardPool` (Task 14).
- Produces:
  - `type HistoryResult = { windows: number; completed: number; pendingRecent: number; incomplete: number; events: number }` — `pendingRecent`: windows read to exhaustion that are still too recent to mark complete.
  - `recoverHistory(input: { pool: BoardPool; store: Store; relay: string; role: CursorRole; recipientPubkey: string; now: number; handle(raw: unknown): Promise<void>; queryTimeoutMs?: number }): Promise<HistoryResult>` — reads each not-yet-complete window newest first; each raw event is handed to `handle` once per window and **awaited** (the caller's `handle` runs the receive pipeline and persists). **Contract:** if `handle` fails after `precheckWrap` recorded the wrap id, it must call `seen.delete(wrapId)` before rethrowing; the error propagates and that window is never marked complete.
  - Paging rule, per window, with `trusted = max(NOSTR.minTrustedRelayLimit, largest page this relay returned during this call)`:
    1. Request `{ kinds: [1059], '#p': [me], since, until, limit }`. An incomplete query (no `EOSE`) makes the window incomplete. An empty page ends the window.
    2. A page with at least `min(limit, trusted)` events may be truncated. If its oldest event is older than `until`, move `until` to that second (inclusive; the overlap is de-duplicated) and continue. If every event shares the `until` second, escalate the limit 200 → 400 → 800; past 800 the window is incomplete.
    3. A shorter page is not truncated by the relay's limit. Confirm it with a query strictly older than its oldest event; that second look also walks relays that cap below `trusted` when timestamps differ.
  - Accepted limitation (Global Constraints): a relay that caps filter limits below 100, or below the requested limit while delivering extra events before EOSE, can hide same-second ties; a relay that truncates other than newest-first can hide older events. Rulings 16–18 of plan 1 execution: k-th newest cut, page size clamped to the limit, 250 queries per window.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/boards-history.test.ts`:

```ts
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NostrEvent } from 'nostr-tools/pure'
import { afterEach, describe, expect, it } from 'vitest'
import { BoardPool, DAY_SECONDS, historyWindows, openStore, recoverHistory } from '@agentbridge/core'
import { plainSocketFactory, startFakeBoard, type FakeBoard, type FakeBoardOptions } from './support/fake-board'
import { testIdentity } from './support/keys'

const me = testIdentity(9)
const TODAY = 20_000
const NOW = TODAY * DAY_SECONDS + 43_200
const dayStart = (daysAgo: number) => (TODAY - daysAgo) * DAY_SECONDS
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

let counter = 0
const event = (created_at: number): NostrEvent => ({
  id: (++counter).toString(16).padStart(64, '0'),
  pubkey: 'c'.repeat(64),
  created_at,
  kind: 1059,
  tags: [['p', me.publicKey]],
  content: '',
  sig: 'd'.repeat(128),
})

async function setup(options: FakeBoardOptions = {}) {
  const board = await startFakeBoard(options)
  const store = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-history-')), 'home'))
  const pool = new BoardPool({ identity: me, createSocket: plainSocketFactory, timeoutMs: 2_000 })
  cleanups.push(() => board.close(), () => store.close(), () => pool.close())
  const handled: string[] = []
  const recover = (handle = async (raw: unknown) => void handled.push((raw as NostrEvent).id)) =>
    recoverHistory({ pool, store, relay: board.url, role: 'responder', recipientPubkey: me.publicKey, now: NOW, handle })
  const remaining = () => historyWindows(store, { relay: board.url, role: 'responder', now: NOW }).map((w) => w.since)
  return { board, handled, recover, remaining }
}

const reqCount = (board: FakeBoard) => board.frames.filter((f) => f[0] === 'REQ').length

describe('recoverHistory', () => {
  it('reads every event across pages and marks only windows that can no longer change', async () => {
    const { board, handled, recover } = await setup()
    for (let i = 0; i < 450; i++) board.inject(event(dayStart(5) + i * 10))
    for (let i = 0; i < 3; i++) board.inject(event(dayStart(1) + i))
    const result = await recover()
    expect(new Set(handled).size).toBe(453)
    expect(handled).toHaveLength(453)
    expect(result).toEqual({ windows: 10, completed: 7, pendingRecent: 3, incomplete: 0, events: 453 })
  })

  it('escalates same-second pages, and only trusts a short page once the relay has served a bigger one', async () => {
    const { board, handled, recover, remaining } = await setup({ maxLimit: 1_000 })
    for (let i = 0; i < 450; i++) board.inject(event(dayStart(4) + 100))
    for (let i = 0; i < 300; i++) board.inject(event(dayStart(5) + 100))
    const result = await recover()
    expect(result).toMatchObject({ completed: 6, pendingRecent: 3, incomplete: 1 })
    expect(handled).toHaveLength(750)
    expect(remaining()).toContain(dayStart(4))
    expect(remaining()).not.toContain(dayStart(5))
  })

  it('leaves an ambiguous same-second window incomplete instead of guessing', async () => {
    const { board, handled, recover, remaining } = await setup({ maxLimit: 1_000 })
    for (let i = 0; i < 150; i++) board.inject(event(dayStart(5) + 100))
    const result = await recover()
    expect(handled).toHaveLength(150)
    expect(result.incomplete).toBe(1)
    expect(remaining()).toContain(dayStart(5))
  })

  it('walks a relay that caps results below the page size when timestamps differ', async () => {
    const { board, handled, recover } = await setup({ maxLimit: 50 })
    for (let i = 0; i < 120; i++) board.inject(event(dayStart(5) + i * 10))
    const result = await recover()
    expect(handled).toHaveLength(120)
    expect(result.incomplete).toBe(0)
  })

  it('skips completed windows on the next run', async () => {
    const { board, recover } = await setup()
    await recover()
    const before = reqCount(board)
    const second = await recover()
    expect(second.windows).toBe(3)
    expect(reqCount(board) - before).toBe(3)
  })

  it('leaves every window incomplete when the relay refuses to be read', async () => {
    const { recover } = await setup({ rejectReads: true })
    expect(await recover()).toMatchObject({ completed: 0, pendingRecent: 0, incomplete: 10 })
  })

  it('never marks a window complete when handling an event fails', async () => {
    const { board, recover, remaining } = await setup()
    board.inject(event(dayStart(5) + 1))
    await expect(
      recover(async () => {
        throw new Error('disk full')
      }),
    ).rejects.toThrow('disk full')
    expect(remaining()).toContain(dayStart(5))
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/boards-history.test.ts`
Expected: FAIL — `recoverHistory` is not exported.

- [ ] **Step 3: Implement**

Create `packages/core/src/boards/history.ts`:

```ts
import { NOSTR } from '../nostr-constants'
import { historyWindows, markWindowComplete, type CursorRole, type HistoryWindow } from '../store/cursors'
import type { Store } from '../store/db'
import type { BoardPool } from './pool'

export type HistoryResult = { windows: number; completed: number; pendingRecent: number; incomplete: number; events: number }

export type RecoverHistoryInput = {
  pool: BoardPool
  store: Store
  relay: string
  role: CursorRole
  recipientPubkey: string
  now: number
  handle(raw: unknown): Promise<void>
  queryTimeoutMs?: number
}

type Dated = { id: string; created_at: number }
const isDated = (raw: unknown): raw is Dated =>
  typeof (raw as Dated | null)?.id === 'string' && Number.isInteger((raw as Dated | null)?.created_at)

export async function recoverHistory(input: RecoverHistoryInput): Promise<HistoryResult> {
  const windows = historyWindows(input.store, { relay: input.relay, role: input.role, now: input.now })
  const result: HistoryResult = { windows: windows.length, completed: 0, pendingRecent: 0, incomplete: 0, events: 0 }
  const relayStats = { largestPage: 0 }
  for (const window of windows) {
    const readStartedAt = input.now
    if (!(await readWindow(input, window, result, relayStats))) {
      result.incomplete++
      continue
    }
    const marked = markWindowComplete(input.store, { relay: input.relay, role: input.role, since: window.since, readStartedAt, now: input.now })
    if (marked) result.completed++
    else result.pendingRecent++
  }
  return result
}

async function readWindow(
  input: RecoverHistoryInput,
  window: HistoryWindow,
  result: HistoryResult,
  relayStats: { largestPage: number },
): Promise<boolean> {
  const limits = NOSTR.historyPageLimits
  const handled = new Set<string>()
  let until = window.until
  let level = 0
  for (;;) {
    const limit = limits[level]!
    const page = await input.pool.query(
      input.relay,
      { kinds: [NOSTR.wrapKind], '#p': [input.recipientPubkey], since: window.since, until, limit },
      input.queryTimeoutMs,
    )
    if (!page.complete) return false
    const valid = page.events.filter(isDated).filter((e) => e.created_at >= window.since && e.created_at <= until)
    for (const event of valid) {
      if (handled.has(event.id)) continue
      handled.add(event.id)
      await input.handle(event)
      result.events++
    }
    const count = page.events.length
    if (count === 0) return true
    if (valid.length === 0) return false
    const oldest = Math.min(...valid.map((e) => e.created_at))
    const trusted = Math.max(NOSTR.minTrustedRelayLimit, relayStats.largestPage)
    const mayBeTruncated = count >= Math.min(limit, trusted)
    relayStats.largestPage = Math.max(relayStats.largestPage, count)

    if (mayBeTruncated) {
      if (oldest < until) {
        until = oldest
        level = 0
        continue
      }
      if (level + 1 < limits.length) {
        level++
        continue
      }
      return false
    }
    // Not truncated by the relay's limit. Confirm with a strictly older query, which also walks
    // relays that cap below the trusted limit when the timestamps differ.
    if (oldest - 1 < window.since) return true
    until = oldest - 1
    level = 0
  }
}
```

In `packages/core/src/index.ts`, append:

```ts
export * from './boards/history'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/boards-history.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/boards/history.ts packages/core/src/index.ts packages/core/test/boards-history.test.ts
git commit -m "feat(core): paginated nine-day history recovery that only marks windows complete when provable"
```

---

### Task 16: Live check against public relays, bundle smoke test and full verification

**Files:**
- Create: `tests/live/boards.live.test.ts`
- Test: the whole suite, the type-check and both esbuild bundles

**Interfaces:**
- Consumes: everything exported by Tasks 2–15.
- Produces: evidence that the foundations work against real public relays, that `npm test` stays Docker-free and internet-free, and that the CLI and channel bundles still build and start with `nostr-tools`, `ws` and `node:sqlite` now reachable from `@agentbridge/core`.

- [ ] **Step 1: Write the live test**

Create `tests/live/boards.live.test.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { afterAll, describe, expect, it } from 'vitest'
import {
  BoardPool,
  SeenIds,
  createRumor,
  leadingZeroBits,
  nowSeconds,
  openWrap,
  pinnedSocketFactory,
  precheckWrap,
  wrapRumor,
  type Identity,
  type Message,
  type PrecheckedWrap,
} from '@agentbridge/core'

// The relays that accepted and served NIP-59 wraps in the 2026-09-16 spike.
const RELAYS = ['wss://relay.primal.net', 'wss://relay.snort.social', 'wss://relay.nostr.net', 'wss://nostr.oxtr.dev', 'wss://nos.lol']

const newIdentity = (): Identity => {
  const secretKey = generateSecretKey()
  return { secretKey, publicKey: getPublicKey(secretKey) }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('public Nostr relays (live, opt-in)', () => {
  const sender = newIdentity()
  const recipient = newIdentity()
  const log = (line: string) => console.log(`[live] ${line}`)
  const senderPool = new BoardPool({ identity: sender, createSocket: pinnedSocketFactory, log })
  const recipientPool = new BoardPool({ identity: recipient, createSocket: pinnedSocketFactory, log })
  afterAll(async () => {
    await senderPool.close()
    await recipientPool.close()
  })

  const wrapFor = async (message: Message) => wrapRumor(createRumor(message, sender, nowSeconds()), sender, recipient.publicKey, { now: nowSeconds() })

  it('delivers a sealed question to a live subscriber and keeps it retrievable afterwards', async () => {
    const seen = new SeenIds()
    const received: string[] = []
    const live = recipientPool.subscribeLive<PrecheckedWrap>(RELAYS, {
      precheck: (raw) => {
        const pre = precheckWrap(raw, { identity: recipient, now: nowSeconds(), seen })
        return pre.ok ? pre : null
      },
      process: async (item) => {
        const opened = openWrap(item, { identity: recipient, now: nowSeconds(), seen })
        if (opened.ok && opened.message.type === 'question' && opened.senderPubkey === sender.publicKey) received.push(opened.message.questionId)
      },
    })
    await sleep(3_000)

    const questionId = randomUUID()
    const wrap = await wrapFor({ v: 1, type: 'question', questionId, generation: 1, text: 'Prueba en vivo de AgentBridge 0.2' })
    const outcome = await senderPool.publish(RELAYS, wrap)
    log(`publish: ${JSON.stringify(outcome)}`)
    expect(outcome.accepted.length).toBeGreaterThanOrEqual(1)

    for (let i = 0; i < 300 && !received.includes(questionId); i++) await sleep(100)
    await live.close()
    expect(received).toContain(questionId)

    const stored = await Promise.all(
      outcome.accepted.map((relay) =>
        recipientPool.query(relay, { kinds: [1059], '#p': [recipient.publicKey], since: wrap.created_at - 1, until: wrap.created_at + 1, limit: 10 }),
      ),
    )
    const retrievable = stored.filter((r) => r.events.some((e) => (e as { id?: string }).id === wrap.id)).length
    log(`retrievable from ${retrievable}/${outcome.accepted.length} accepting relays`)
    expect(retrievable).toBeGreaterThanOrEqual(1)
  })

  it('reports how the relays treat five quick publishes from one identity', async () => {
    const outcomes = []
    for (let i = 0; i < 5; i++) outcomes.push(await senderPool.publish(RELAYS, await wrapFor({ v: 1, type: 'receipt', questionId: randomUUID() })))
    log(`burst: ${JSON.stringify(outcomes.map((o) => ({ accepted: o.accepted.length, rejected: o.rejected.map((r) => r.reason) })))}`)
    expect(outcomes.every((o) => o.accepted.length >= 1)).toBe(true)
  })

  it('accepts a 22-bit connection request on at least one relay', async () => {
    const wrap = await wrapFor({ v: 1, type: 'connect_request', requestId: randomUUID(), name: 'Prueba', note: 'live', relays: RELAYS })
    expect(leadingZeroBits(wrap.id)).toBeGreaterThanOrEqual(22)
    const outcome = await senderPool.publish(RELAYS, wrap)
    log(`connect_request: ${JSON.stringify(outcome)}`)
    expect(outcome.accepted.length).toBeGreaterThanOrEqual(1)
  })
})
```

- [ ] **Step 2: Confirm the default suite never runs it**

Run: `npx vitest list 2>/dev/null | grep -c live || true`
Expected: `0`.

- [ ] **Step 3: Run the full offline verification**

```bash
npm run typecheck
npm test
```

Expected: type-check clean; every test passes with no Docker container and no network access. If you want to prove the second part, disconnect the machine from the network and run `npm test` again.

- [ ] **Step 4: Prove the bundles still build and start**

```bash
npm run build
node packages/cli/dist/main.js --help | head -3
AGENTBRIDGE_HOME="$(mktemp -d)" node plugins/agentbridge/dist/server.js </dev/null 2>&1 | head -2
npx vitest run packages/channel/test/bundle.test.ts
```

Expected: both bundles build without errors; `--help` prints the Spanish usage; the channel bundle exits reporting the missing configuration exactly as before; the existing bundle test passes.

- [ ] **Step 5: Run the live check (needs internet)**

Run: `npm run test:live`
Expected: 3 tests pass. Copy the `[live]` lines (publish outcome, how many relays kept the wrap, burst rejections, connection request outcome) into the pull request description: they are the measurements the spec lists under "Riesgos" (publishing limits with 5 copies).

- [ ] **Step 6: Commit**

```bash
git add tests/live/boards.live.test.ts
git commit -m "test: opt-in live check of sealed delivery, retrieval and publishing limits on public relays"
```

---

## What plan 2 starts from

- A `Store` with contacts, request records, outbox and cursors, and `Store.tx` that joins outer transactions — so the responder's `revoke` can combine `revokeInbound`, `deleteUnclaimedFor` and the new inbox decisions in one transaction.
- `precheckWrap` / `openWrap` producing authenticated `OpenedMessage`s, fed by `BoardPool.subscribeLive` and `recoverHistory`. Every `process` / `handle` implementation must call `seen.delete(wrapId)` when persistence fails.
- `createRumor` / `wrapRumor` plus `enqueue` → `claimDue({ authorize })` → `BoardPool.publish(relays, wrap, beforeSend)` whose guard runs `stillClaimed` on every write and `reservePublish` on the first → `markPublished` / `markFailed` / `postpone` for everything a device sends. Plan 2's `authorize` checks that the recipient still holds the permission and generation the message was created for.
- Still missing, by design: migrations v2 (inbox questions, attempts, channel lock) and the dispatcher (plan 2); asker questions, `AskerService`, CLI and MCP (plan 3); `setup`, `doctor`, packaging, docs, acceptance, restoring the deleted CLI test coverage and deleting `RelayHttpClient` (plan 4).
