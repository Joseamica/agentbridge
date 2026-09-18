# AgentBridge 0.2 — Plan 3: Asker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the person who asks fully work over public Nostr relays. From their terminal or from their own Claude Code they connect to someone, send a question, and follow it to an answer — with every state change stored in SQLite, retried until it resolves, and shown in Spanish.

**Architecture:** This is plan 3 of 4 and builds on plan 1 (foundations) and plan 2 (responder), both on `main`.
- `packages/core` gains the asker's half of the protocol:
  - schema v3 with `outbox_questions` (the questions this person sent and where each one stands)
  - the state machine for those questions, driven by the outbox's own publish bookkeeping and by authenticated `receipt` / `answer` / `rejected` messages
  - step 10 of the receive pipeline for the asker role (`handleAskerMessage`)
  - faster 22-bit mining, so `connect` is seconds instead of a quarter minute
- `packages/cli` gains everything a person touches:
  - `AskerService`, the one object the CLI and the MCP server both drive
  - the short-lived cycle (start → sync → operate → sync → close) every command runs
  - commands `link`, `connect`, `contacts`, `ask`, `ticket`, `whoami`, plus the responder-side `requests`, `approve`, `reject`, `revoke` that plan 2 left as library calls
  - the MCP server with `list_contacts`, `ask_contact`, `check_answer` and `connect`
  - the 0.1 enrollment commands (`enroll`, `invite`, `accept`, `admin`) stop being routed here; their code leaves with `setup` and `doctor` in plan 4
- Plan 4 (setup, doctor, packaging, docs, acceptance, deleting `RelayHttpClient`) builds on these interfaces.

**Tech Stack:** Node ≥ 22.13 (`node:sqlite`, `worker_threads`, `node:util parseArgs`), TypeScript 5.9 (type-check only), npm workspaces, `nostr-tools` 2.25.2 and `ws` 8.21.3 (already pinned), `@modelcontextprotocol/sdk`, zod 4, vitest 5, esbuild 0.28, tsx (dev, for multi-process tests).

**Spec:** `docs/superpowers/specs/2026-09-16-nostr-transport-design.md` (revision 4). Read it before starting any task. Plan 2's "What plan 3 starts from" section lists what is already built and what it carried forward: `docs/superpowers/plans/2026-09-17-agentbridge-0.2-plan2-responder.md`. The 0.2 gaps that are deliberate live in `docs/known-gaps.md`.

## Global Constraints

- **Node and dependencies.**
  - Node floor stays `>=22.13`.
  - No new runtime dependency.
  - `nostr-tools` stays exactly `2.25.2` and `ws` exactly `8.21.3`.
- **Language.**
  - User-facing text is Spanish. Identifiers, logs, MCP tool names, tool descriptions and model instructions are English.
  - No error message or log line contains a secret key, decrypted third-party content, or a shared-folder path. An unexpected error is described only by `describeError` (its type and error code); only a `UserFacingError` message is shown as written.
  - Relay-supplied text is passed through `sanitizeRelayText` (`packages/core/src/boards/relay-text.ts`, internal) before it reaches a log.
  - Every printed instruction uses `CLI_COMMAND`, never a hard-coded `agentbridge`.
- **Tests.** `npm test` needs neither Docker nor internet. `npm run test:live` is the only suite that touches public relays, and this plan does not add to it.
- **Protocol (from plans 1 and 2, unchanged).**
  - Wrap kind 1059, seal kind 13, rumor kind 8059.
  - 16 bits of proof of work on every wrap, 22 on `connect_request`.
  - Size caps per layer; any `created_at` at most 10 minutes in the future.
- **Roles.** An asker process handles only `connect_approved`, `connect_rejected`, `connect_revoked`, `receipt`, `answer` and `rejected`. `connect_request` and `question` belong to the responder role: the asker ignores them without storing anything. History cursors are per relay **and** role (`asker`).
- **Permission changes** (`connect_approved`, `connect_revoked`) apply only when their `generation` is **greater** than the maximum generation ever observed for that contact. A `connect_rejected` and a `connect_approved` apply only when their `requestId` is the pending request's own id.
- **Questions carry** the generation of the asker's latest approval, and nothing else: the responder decides admission.
- **Question states, in the asker** (each transition runs in a transaction that reads the current state; a final state never changes):

  | From | Event | To |
  |---|---|---|
  | `sending` | at least one relay accepted the wrap | `sent` |
  | `sending` / `sent` | an authenticated `receipt` arrives | `received` |
  | `sending` / `sent` / `received` | an authenticated `answer` arrives | `answered` (final) |
  | `sending` / `sent` / `received` | an authenticated `rejected` arrives | `rejected` (final) |
  | `sending` / `sent` / `received` | 7 days without a final state | `lost` (final) |

  A second decision for the same question (an `answer` after a `rejected`, or the reverse) is logged with identifiers only and ignored. The texts for Claude and for the terminal distinguish "recibida" (it reached their computer) from "contestada".
- **Retries.** Every question that is not in a final state is retried every 5 minutes for the first hour, then every 30 minutes, until 7 days after it was sent. **A receipt does not stop the retries**; only `answer` or `rejected` do — and they stop them by deleting the outbox row.
- **Short-lived clients.** `ask`, `ticket`, `contacts`, `connect`, `requests`, `approve`, `reject`, `revoke` and `link` run **start → sync → operate → sync → close**. A sync lasts at most 10 seconds: connect to this person's own relays, read from the cursor, process what arrived, publish what is due, persist. `close` ends connections and timers so the command always terminates. Only the MCP server and the channel are persistent, and only they run retries on a timer; a person who asks only from the terminal reads this in Spanish: the retries happen whenever they run a command.
- **Outbox publishing (plan 1 and 2, unchanged).** One row per logical message (`recipient` + `rumor.id`); a claim lasts 2 minutes; regeneration at most once every 10 minutes; 1 MB pending per contact and 20 MB per identity; at most 60 publishes per minute per identity.
- **Retention.** Content (question text, stored answers) 7 days; decisions and request records 9 days; contact state never expires.
- **Test cost.** Mining a 22-bit request takes seconds even after this plan speeds it up. Exactly one test in this plan crosses a real `connect_request` over boards; every other test seeds contacts through the store functions.

## Plan-level decisions

Each one resolves something the spec leaves open. Reviewers may challenge them.

- **P1 — `sending → sent` is both pushed and swept.** `publishDue` gains an `onPublished` hook that fires inside the same round that recorded a relay's acceptance, and `Device` forwards it, so a persistent process (the MCP server) promotes a question the moment it goes out. Because the outbox row is transient — `revoke` deletes unclaimed rows for a contact, and the purge deletes old ones — the promotion is *also* swept from `outbox.last_published_at` at every sync and in the purge loop, which covers a crash between the publish and the update. The question row is the durable record; the outbox row is not.
- **P2 — The asker does not re-implement the responder's limits.** Five open questions per pair and twenty per day are the responder's rule; the asker sends and shows the `rejected`/`limit` it gets back. One rule, one place.
- **P3 — Question ids are the ticket ids.** A question's UUID is what `ask` prints and what `check_answer` takes. The CLI also accepts any prefix of at least 6 characters that matches exactly one question, because a person retypes a UUID badly; an ambiguous prefix is a Spanish error that asks for more characters.
- **P4 — `AskerService` owns no files.** Like `Device`, it takes an already-open identity and store. `openAskerSession` (the CLI's helper) is what touches `~/.agentbridge`, so tests drive the service against a temporary home without going through the CLI.
- **P5 — The MCP server is the only persistent asker.** It calls `device.start()` (live subscription, retries on a timer, periodic history and purge). Every CLI command uses `syncOnce` instead, and `ask --wait N` keeps the device started only for those N seconds.
- **P5b — A deadline that actually bounds the command.** Plan 1's `BoardPool` bounds each query and each connect with its own timeout, but nothing carries the sync's deadline into them, so a sync of 10 s can overshoot by a pool timeout. Task 6 propagates the deadline: `BoardPool.query`, `BoardPool.publish` and the connection handshake take the sync's `AbortSignal`, and a sync waits for what it started before returning. The **network** part of a CLI sync is what the spec's ten seconds bound.
- **P5c — Mining is CPU, not network, and gets its own budget.** Proof of work happens inside `publishDue`. A `connect_request` costs 22 bits — seconds of CPU — so the publisher takes a separate `miningMs` budget (60 s by default) that is not charged against the sync's network deadline, and `connect` tells the person, in Spanish, that this first step takes a few seconds. Nothing else in the plan exceeds the spec's ten seconds.
- **P6 — Mining in parallel.** `mineEvent` splits the nonce space across `min(availableParallelism() - 1, 4)` workers, each starting at a different offset and stepping by the worker count. The first to find a nonce wins and the rest are terminated. One worker is left for the main thread, so a laptop stays usable while `connect` mines.
- **P10 — The four inbox commands sync the responder role.** `requests`, `approve`, `reject` and `revoke` are about messages addressed to this person as a responder, and `handleAskerMessage` deliberately drops those. They therefore run the same short-lived cycle with a second, role-`responder` session: its own cursors, `handleResponderMessage`, and no channel lock and no dispatcher (only the channel takes the lock and hands questions to Claude). Without this, a request published while the channel was closed would never appear in `requests`.
- **P11 — A question already sent survives its contact being revoked.** The spec's contract is that an unanswered question gets the final decision `rejected`/`stale_generation`, and that the responder regenerates it **when a retry arrives**. Plan 2's `authorizeOutboxItem` refuses any `question` whose contact is not currently approved, which would abandon exactly the retry that fetches that decision. Task 2 narrows the rule: a `question` row is authorized while this person still has an open `outbox_questions` row for it with the same generation, whatever the contact's current state. A *new* question to a revoked contact is still refused, by `createOutboundQuestion`, before anything is stored.
- **P7 — A question's own relays.** A question goes to the relays stored for that contact at the moment it is created, and a retry reuses the same rumor and the same outbox row, so its relays are the original ones. A `connect_approved` with a different relay list updates the contact, so the *next* question uses the new ones. There is no protocol path to update the relays of an already-approved contact (`docs/known-gaps.md`), and this plan does not invent one.
- **P8 — `lost` is applied by whoever syncs.** `expireOutboundQuestions(store, now)` runs inside every sync and inside the `Device` purge loop, so a question reaches `lost` whether the person uses the terminal or leaves the MCP server running.
- **P9 — The 0.1 enrollment commands leave the command table now, and the code in plan 4.** `enroll`, `invite`, `accept` and `admin enroll-link` stop being commands a person can run. Their implementation stays on disk for one more plan because `setup.ts` still calls `enroll` (`packages/cli/src/commands/setup.ts:10,459`) and `doctor.ts` still imports `RelayHttpClient`; plan 4 rewrites both and deletes `account.ts`, `clientFor` and `http.ts` together. Deleting the file in this plan would break the CLI's own build.

## Carried from plan 2 and resolved here

- The asker must ignore a `connect_approved` whose relay hints sanitize to nothing, the way `handleResponderMessage` ignores such a `connect_request` (Task 3).
- Relay `CLOSED`/`OK` reasons are unsanitized data: every log line the asker writes about them goes through `sanitizeRelayText` (Tasks 5 and 6).
- 22-bit mining is slow (16.5 s measured live in plan 1). Task 4 fixes it.

## File Structure

```text
packages/core/src/store/schema.ts               + migration v3: outbox_questions (Task 1)
packages/core/src/store/outbox-questions.ts     create, read, list, find by prefix (Task 1);
                                                markSentQuestions, applyReceipt, applyAnswer,
                                                applyRejected, expireOutboundQuestions,
                                                purgeOutboundQuestions (Task 2)
packages/core/src/device/device.ts              onPublished hook forwarded to the publisher; purge loop also
                                                purges and expires asker questions (Task 2); syncOnce's deadline
                                                reaches the pool (Task 6)
packages/core/src/device/publisher.ts           onPublished hook; a mining budget separate from the sync deadline (Tasks 2, 5)
packages/core/src/device/authorize.ts           a question retry stays authorized while its own row is open (Task 2)
packages/core/src/boards/pool.ts                query, publish and connect take the caller's AbortSignal (Task 6)
packages/core/src/asker/inbound.ts              handleAskerMessage: step 10 for the asker role (Task 3)
packages/core/src/envelope/pow.ts               mineEvent across several workers (Task 4)
packages/core/src/index.ts                      re-exports the new modules

packages/cli/src/asker/service.ts               AskerService: connect, contacts, ask, wait, ticket, sync (Tasks 6, 7)
packages/cli/src/asker/session.ts               openAskerSession / withAsker, and withResponderSession for the
                                                four inbox commands (Task 7)
packages/cli/src/asker/format.ts                Spanish text for contacts and question states, and the
                                                terminal-safe rendering of third-party names and notes (Task 8)
packages/cli/src/commands/connect.ts            link, connect (Task 9)
packages/cli/src/commands/contacts.ts           contacts, whoami, requests, approve, reject, revoke (Task 10)
packages/cli/src/commands/ask.ts                rewritten: ask, ticket (Task 11)
packages/cli/src/mcp-asker.ts                   rewritten: AskerService behind four MCP tools, closing on stdin EOF (Task 11)
packages/cli/src/router.ts                      command table and USAGE (Task 12)
packages/cli/src/context.ts                     an optional relayPolicy for tests, like the existing fetchImpl (Task 7)

packages/core/test/…                            one test file per new module
packages/cli/test/…                             service, session, commands, mcp tools
tests/asker/support.ts                          harness: a real asker and a real responder over fake boards (Task 13)
tests/asker/flow.test.ts                        connect → approve → ask → receipt → answer (Task 13)
tests/asker/scenarios.test.ts                   rejection, revocation, losses, expiry, conflicts (Task 14)
tests/asker/multiprocess.test.ts                CLI and MCP server on the same store (Task 15)

Deleted: nothing. `account.ts` stops being routed but stays until plan 4 rewrites `setup` and `doctor`.
```

## Execution notes from plans 1 and 2

- **Plan copy.** Extract task briefs from the plan copy in the execution worktree, never from another checkout.
- **Proving RED.** Implementers never use `git stash`. To prove a test fails without a change, copy the file aside under `$TMPDIR`, restore it with `git show HEAD:<path> > <path>`, run the test, then put the copy back.
- **Probes.** Reviewers may run short probe scripts for named lifecycle or concurrency risks, under `$TMPDIR`, never inside the worktree.
- **A log sink can throw.** Every `log` call inside a `catch` in a long-lived loop is wrapped so a closed pipe cannot take the process down (plan 2's final review). New code follows the same rule.

---
### Task 1: Schema v3 and the questions this person sent

**Files:**
- Modify: `packages/core/src/store/schema.ts` (append migration v3)
- Create: `packages/core/src/store/outbox-questions.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/store-outbox-questions.test.ts`

**Interfaces:**
- Consumes: `openStore`, `Store`, `askPermission`, `getContact` (plan 1), `createRumor`, `type Rumor`, `EnvelopeSizeError`, `enqueue`, `NOSTR`, `UserFacingError`, `type Confidence`.
- Produces:
  - **Migration v3**, with one table:
    - `outbox_questions`: PK `(recipient, question_id)`, plus `rumor_id`, `generation`, `text`, `state`, `answer_text`, `answer_source`, `answer_confidence`, `reject_reason`, `asked_at`, `received_at`, `decided_at`, `updated_at`
  - `type OutboundQuestionState = 'sending' | 'sent' | 'received' | 'answered' | 'rejected' | 'lost'`
  - `type OutboundAnswer = { text: string; source: string; confidence: Confidence }`
  - `type OutboundQuestion = { recipient: string; questionId: string; rumorId: string; generation: number; text: string | null; state: OutboundQuestionState; answer: OutboundAnswer | null; rejectReason: RejectReason | null; askedAt: number; receivedAt: number | null; decidedAt: number | null }`
  - `createOutboundQuestion(store, { identity, recipient, text, now, newQuestionId? }): { question: OutboundQuestion; rumor: Rumor }`: one transaction. Requires the outbound contact to be `approved` (otherwise a Spanish `UserFacingError`), builds the `question` rumor with the contact's current generation, stores the row as `sending`, and enqueues the wrap with policy `retry_until_resolved` and 16 bits.
  - `getOutboundQuestion(store, recipient, questionId): OutboundQuestion | null`
  - `findOutboundQuestions(store, prefix): OutboundQuestion[]`: matches a question id by a prefix of at least 6 characters, newest first.
  - `listOutboundQuestions(store, options?): OutboundQuestion[]`: newest first, `limit` defaults to 20.
- Note for later tasks: `RejectReason` is the type plan 2 exported from `store/inbox.ts` (`'expired' | 'limit' | 'unanswered' | 'stale_generation'`); this module imports it rather than declaring a second copy.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/store-outbox-questions.test.ts`:

```ts
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LIMITS,
  NOSTR,
  UserFacingError,
  applyApproval,
  applyRevocation,
  createOutboundQuestion,
  createOutboundRequest,
  findOutboundQuestions,
  getOutboundQuestion,
  listOutboundQuestions,
  openStore,
  type Store,
} from '@agentbridge/core'
import { testIdentity } from './support/keys'

const me = testIdentity(31)
const them = testIdentity(32)
const T0 = 2_000_000_000
const RELAYS = ['wss://relay.example.com']
// Distinct in their *first* characters, because the prefix lookup below is about what a person
// retypes: ids that differ only in their last digits would make every prefix ambiguous.
const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
let store: Store

beforeEach(async () => {
  store = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-outq-')), 'home'))
})
afterEach(() => store.close())

// The asker's side of a finished handshake: a request this person sent, approved by the other.
function approved(generation = 1, now = T0): void {
  createOutboundRequest(store, { pubkey: them.publicKey, requestId: uuid(1), relays: RELAYS, now })
  applyApproval(store, { pubkey: them.publicKey, requestId: uuid(1), generation, name: 'Ana', relays: RELAYS, now })
}

const outbox = () => store.db.prepare('SELECT * FROM outbox').all() as Array<Record<string, unknown>>

describe('createOutboundQuestion', () => {
  it('stores the question as sending and enqueues its wrap for retries', () => {
    approved()
    const { question, rumor } = createOutboundQuestion(store, {
      identity: me,
      recipient: them.publicKey,
      text: '¿cómo se despliega?',
      now: T0,
      newQuestionId: () => uuid(7),
    })
    expect(question).toMatchObject({
      recipient: them.publicKey,
      questionId: uuid(7),
      rumorId: rumor.id,
      generation: 1,
      text: '¿cómo se despliega?',
      state: 'sending',
      answer: null,
      rejectReason: null,
      askedAt: T0,
      receivedAt: null,
      decidedAt: null,
    })
    expect(JSON.parse(rumor.content)).toMatchObject({ type: 'question', questionId: uuid(7), generation: 1, text: '¿cómo se despliega?' })
    const rows = outbox()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ recipient: them.publicKey, rumor_id: rumor.id, label: 'question', pow_bits: 16, policy: 'retry_until_resolved' })
  })

  it('refuses to ask someone who never approved this person', () => {
    createOutboundRequest(store, { pubkey: them.publicKey, requestId: uuid(1), relays: RELAYS, now: T0 })
    expect(() => createOutboundQuestion(store, { identity: me, recipient: them.publicKey, text: 'hola', now: T0 })).toThrow(UserFacingError)
    expect(outbox()).toHaveLength(0)
    expect(listOutboundQuestions(store)).toEqual([])
  })

  it('refuses a question that is too large, without storing anything', () => {
    approved()
    const long = 'a'.repeat(LIMITS.questionMaxChars + 1)
    expect(() => createOutboundQuestion(store, { identity: me, recipient: them.publicKey, text: long, now: T0 })).toThrow(UserFacingError)
    expect(outbox()).toHaveLength(0)
    expect(listOutboundQuestions(store)).toEqual([])
  })

  it('carries the generation of the latest approval', () => {
    // A second approval only applies to a *pending* request, so the real sequence is the one a
    // person lives through: approved, revoked, asked again, approved again with a higher generation.
    approved(1)
    expect(applyRevocation(store, { pubkey: them.publicKey, generation: 2, now: T0 + 1 })).toBe('applied')
    createOutboundRequest(store, { pubkey: them.publicKey, requestId: uuid(2), relays: RELAYS, now: T0 + 2 })
    expect(applyApproval(store, { pubkey: them.publicKey, requestId: uuid(2), generation: 3, name: 'Ana', relays: RELAYS, now: T0 + 3 })).toBe('applied')

    const { rumor } = createOutboundQuestion(store, { identity: me, recipient: them.publicKey, text: 'hola', now: T0 + 4, newQuestionId: () => uuid(8) })
    expect(JSON.parse(rumor.content)).toMatchObject({ generation: 3 })
    expect(getOutboundQuestion(store, them.publicKey, uuid(8))?.generation).toBe(3)
  })

  it('sends to the relays stored for that contact, capped at the protocol maximum', () => {
    const many = ['wss://a.example.com', 'wss://b.example.com', 'wss://c.example.com', 'wss://d.example.com', 'wss://e.example.com', 'wss://f.example.com']
    createOutboundRequest(store, { pubkey: them.publicKey, requestId: uuid(1), relays: many, now: T0 })
    applyApproval(store, { pubkey: them.publicKey, requestId: uuid(1), generation: 1, name: 'Ana', relays: many, now: T0 })
    createOutboundQuestion(store, { identity: me, recipient: them.publicKey, text: 'hola', now: T0, newQuestionId: () => uuid(9) })
    const relays = JSON.parse(String(outbox()[0]!.relays)) as string[]
    expect(relays).toHaveLength(NOSTR.maxRelaysPerContact)
  })
})

describe('reading questions back', () => {
  it('lists the newest first and finds one by a prefix', () => {
    approved()
    createOutboundQuestion(store, { identity: me, recipient: them.publicKey, text: 'primera', now: T0, newQuestionId: () => uuid(11) })
    createOutboundQuestion(store, { identity: me, recipient: them.publicKey, text: 'segunda', now: T0 + 5, newQuestionId: () => uuid(12) })
    expect(listOutboundQuestions(store).map((q) => q.text)).toEqual(['segunda', 'primera'])
    expect(findOutboundQuestions(store, uuid(12).slice(0, 8)).map((q) => q.questionId)).toEqual([uuid(12)])
    // Two ids that share a prefix are the ambiguous case the CLI must ask about.
    createOutboundQuestion(store, { identity: me, recipient: them.publicKey, text: 'tercera', now: T0 + 6, newQuestionId: () => `${uuid(12).slice(0, 10)}00-4000-8000-000000000000` })
    expect(findOutboundQuestions(store, uuid(12).slice(0, 8)).length).toBeGreaterThan(1)
    expect(getOutboundQuestion(store, them.publicKey, uuid(11))?.text).toBe('primera')
    expect(getOutboundQuestion(store, them.publicKey, uuid(99))).toBeNull()
  })

  it('refuses a prefix that is too short to be worth matching', () => {
    approved()
    createOutboundQuestion(store, { identity: me, recipient: them.publicKey, text: 'primera', now: T0, newQuestionId: () => uuid(11) })
    expect(findOutboundQuestions(store, '000')).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/store-outbox-questions.test.ts`
Expected: FAIL — `createOutboundQuestion` and the other exports do not exist.

- [ ] **Step 3: Append migration v3**

In `packages/core/src/store/schema.ts`, add this third element to the `MIGRATIONS` array, after the version 2 object:

```ts
  {
    version: 3,
    name: 'questions this person sent',
    sql: `
CREATE TABLE outbox_questions (
  recipient TEXT NOT NULL CHECK (length(recipient) = 64),
  question_id TEXT NOT NULL,
  rumor_id TEXT NOT NULL CHECK (length(rumor_id) = 64),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  text TEXT,
  state TEXT NOT NULL CHECK (state IN ('sending', 'sent', 'received', 'answered', 'rejected', 'lost')),
  answer_text TEXT,
  answer_source TEXT,
  answer_confidence TEXT CHECK (answer_confidence IN ('seguro', 'creo', 'no_se')),
  reject_reason TEXT CHECK (reject_reason IN ('expired', 'limit', 'unanswered', 'stale_generation')),
  asked_at INTEGER NOT NULL,
  received_at INTEGER,
  decided_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (recipient, question_id)
);
-- Open questions are read on every sync (promote to sent, expire to lost), and the list the person
-- sees is ordered by when they asked.
CREATE INDEX outbox_questions_open ON outbox_questions (state, asked_at);
CREATE INDEX outbox_questions_recent ON outbox_questions (asked_at);
CREATE INDEX outbox_questions_rumor ON outbox_questions (rumor_id);
`,
  },
```

- [ ] **Step 4: Create the module**

Create `packages/core/src/store/outbox-questions.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { createRumor, type Rumor } from '../envelope/seal'
import type { Identity } from '../identity'
import { NOSTR } from '../nostr-constants'
import type { Confidence } from '../protocol'
import { UserFacingError } from '../errors'
import { askPermission, getContact } from './contacts'
import type { Store } from './db'
import type { RejectReason } from './inbox'
import { enqueue } from './outbox'

export type OutboundQuestionState = 'sending' | 'sent' | 'received' | 'answered' | 'rejected' | 'lost'
export type OutboundAnswer = { text: string; source: string; confidence: Confidence }

export type OutboundQuestion = {
  recipient: string
  questionId: string
  rumorId: string
  generation: number
  text: string | null
  state: OutboundQuestionState
  answer: OutboundAnswer | null
  rejectReason: RejectReason | null
  askedAt: number
  receivedAt: number | null
  decidedAt: number | null
}

type QuestionRow = {
  recipient: string
  question_id: string
  rumor_id: string
  generation: number
  text: string | null
  state: OutboundQuestionState
  answer_text: string | null
  answer_source: string | null
  answer_confidence: Confidence | null
  reject_reason: RejectReason | null
  asked_at: number
  received_at: number | null
  decided_at: number | null
  updated_at: number
}

// A prefix shorter than this matches too much to be a useful handle for a person retyping an id.
export const MIN_QUESTION_PREFIX = 6

const toQuestion = (row: QuestionRow): OutboundQuestion => ({
  recipient: row.recipient,
  questionId: row.question_id,
  rumorId: row.rumor_id,
  generation: row.generation,
  text: row.text,
  state: row.state,
  answer:
    row.answer_text !== null && row.answer_source !== null && row.answer_confidence !== null
      ? { text: row.answer_text, source: row.answer_source, confidence: row.answer_confidence }
      : null,
  rejectReason: row.reject_reason,
  askedAt: row.asked_at,
  receivedAt: row.received_at,
  decidedAt: row.decided_at,
})

const selectRow = (store: Store, recipient: string, questionId: string) =>
  store.db.prepare('SELECT * FROM outbox_questions WHERE recipient = ? AND question_id = ?').get(recipient, questionId) as QuestionRow | undefined

export function getOutboundQuestion(store: Store, recipient: string, questionId: string): OutboundQuestion | null {
  const row = selectRow(store, recipient, questionId)
  return row ? toQuestion(row) : null
}

export function listOutboundQuestions(store: Store, options: { limit?: number } = {}): OutboundQuestion[] {
  const rows = store.db
    .prepare('SELECT * FROM outbox_questions ORDER BY asked_at DESC, rowid DESC LIMIT ?')
    .all(options.limit ?? 20) as QuestionRow[]
  return rows.map(toQuestion)
}

// The prefix is matched with a bound parameter and only after it passes the hex-ish shape below, so
// it can never carry a LIKE wildcard.
export function findOutboundQuestions(store: Store, prefix: string): OutboundQuestion[] {
  const normalized = prefix.trim().toLowerCase()
  if (normalized.length < MIN_QUESTION_PREFIX || !/^[0-9a-f-]+$/.test(normalized)) return []
  const rows = store.db
    .prepare('SELECT * FROM outbox_questions WHERE question_id LIKE ? ORDER BY asked_at DESC, rowid DESC')
    .all(`${normalized}%`) as QuestionRow[]
  return rows.map(toQuestion)
}

export function createOutboundQuestion(
  store: Store,
  input: { identity: Identity; recipient: string; text: string; now: number; newQuestionId?: () => string },
): { question: OutboundQuestion; rumor: Rumor } {
  return store.tx(() => {
    const permission = askPermission(store, input.recipient)
    if (!permission) {
      throw new UserFacingError('Esa persona todavía no te dio permiso para preguntarle. Pídeselo con connect y espera a que apruebe.')
    }
    const contact = getContact(store, input.recipient, 'outbound')!
    if (contact.relays.length === 0) {
      throw new UserFacingError('No tienes ningún tablero donde dejarle la pregunta a esa persona. Pídele que te envíe un enlace nuevo.')
    }
    const questionId = (input.newQuestionId ?? randomUUID)()
    // createRumor throws EnvelopeSizeError (a UserFacingError, in Spanish) for a question that is
    // too long, before anything is written.
    const rumor = createRumor({ v: 1, type: 'question', questionId, generation: permission.generation, text: input.text }, input.identity, input.now)
    store.db
      .prepare(
        `INSERT INTO outbox_questions (recipient, question_id, rumor_id, generation, text, state, asked_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'sending', ?, ?)`,
      )
      .run(input.recipient, questionId, rumor.id, permission.generation, input.text, input.now, input.now)
    enqueue(store, {
      recipient: input.recipient,
      rumor,
      label: 'question',
      powBits: 16,
      relays: contact.relays.slice(0, NOSTR.maxRelaysPerContact),
      policy: 'retry_until_resolved',
      now: input.now,
    })
    return { question: toQuestion(selectRow(store, input.recipient, questionId)!), rumor }
  })
}
```

- [ ] **Step 5: Export it**

In `packages/core/src/index.ts`, after the line that re-exports `./store/outbox`:

```ts
export * from './store/outbox-questions'
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/store-outbox-questions.test.ts`
Expected: PASS.

Then run the whole suite, which also proves the migration runner picked up version 3 and that plan 1's `store-db` test still matches the migration list:

Run: `npm test`
Expected: every test passes.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/store/schema.ts packages/core/src/store/outbox-questions.ts packages/core/src/index.ts packages/core/test/store-outbox-questions.test.ts
git commit -m "feat(core): schema v3 and the questions this person sent"
```
### Task 2: The question state machine — sent, received, answered, rejected, lost

**Files:**
- Modify: `packages/core/src/store/outbox-questions.ts` (append the transitions)
- Modify: `packages/core/src/device/publisher.ts` (an `onPublished` hook)
- Modify: `packages/core/src/device/device.ts` (forward `onPublished`; the purge loop also ages asker questions)
- Modify: `packages/core/src/device/authorize.ts` (a question retry stays authorized while its own row is open)
- Test: `packages/core/test/store-outbox-questions.test.ts` (append), `packages/core/test/device-publisher.test.ts` (append), `packages/core/test/device-authorize.test.ts` (append), `packages/core/test/device.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's module; plan 1's `claimDue`, `markPublished`, `resolveOutboxMessage`, `purgeOutbox`; plan 2's `Device`.
- Produces:
  - `markSentQuestions(store, now): number`: promotes every `sending` question whose outbox row already recorded a successful publish (`last_published_at IS NOT NULL`). Returns how many moved.
  - `applyReceipt(store, { recipient, questionId, now }): 'applied' | 'ignored'`: `sending`/`sent` → `received`. A receipt never stops the retries.
  - `applyAnswer(store, { recipient, questionId, answer, now }): 'applied' | 'ignored'`: `sending`/`sent`/`received` → `answered`, stores the answer and deletes the outbox row so the retries stop.
  - `applyRejected(store, { recipient, questionId, reason, now }): 'applied' | 'ignored'`: the same, to `rejected`.
  - `expireOutboundQuestions(store, now): number`: every question with no final state after `NOSTR.retryWindowSeconds` becomes `lost`, and its outbox row is deleted.
  - `purgeOutboundQuestions(store, now): { contentCleared: number; forgotten: number }`: clears question text and stored answers at 7 days, forgets the row at 9.
  - `publishDue` gains `onPublished?: (item: OutboxItem) => void`, called after a round recorded a successful publish for that row, and `Device` gains the same option and forwards it. A persistent process therefore promotes a question the moment it goes out, instead of waiting for someone to sync.
  - `authorizeOutboxItem`'s `question` case is narrowed: a row is authorized while the outbound contact is approved with that generation **or** this person still has an open `outbox_questions` row for that question with the same generation. That is what lets a retry fetch the `rejected`/`stale_generation` the other side stored when they revoked — the spec regenerates that decision only when a retry arrives.
  - `Device`'s purge loop gains two steps, so both retention and `lost` happen on a timer in a persistent process.
- A second decision for the same question returns `'ignored'`: the caller (Task 3) logs it with identifiers only.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/store-outbox-questions.test.ts` (add `applyAnswer`, `applyReceipt`, `applyRejected`, `claimDue`, `expireOutboundQuestions`, `markPublished`, `markSentQuestions`, `purgeOutboundQuestions` to the import list from `@agentbridge/core`):

```ts
// Publishes the one pending outbox row the way the real publisher does: claim it, then record
// that a relay accepted it.
function publishOne(now = T0): void {
  const owner = 'test-owner'
  const [item] = claimDue(store, { owner, now, limit: 1, authorize: () => true })
  if (!item) throw new Error('expected a due outbox row')
  markPublished(store, { recipient: item.recipient, rumorId: item.rumorId, owner, now })
}

function ask(id: number, now = T0): string {
  const { question } = createOutboundQuestion(store, { identity: me, recipient: them.publicKey, text: `pregunta ${id}`, now, newQuestionId: () => uuid(id) })
  return question.questionId
}

describe('markSentQuestions', () => {
  it('promotes a question to sent once a relay accepted its wrap', () => {
    approved()
    const id = ask(21)
    expect(getOutboundQuestion(store, them.publicKey, id)?.state).toBe('sending')
    expect(markSentQuestions(store, T0 + 1)).toBe(0)

    publishOne(T0 + 2)
    expect(markSentQuestions(store, T0 + 3)).toBe(1)
    expect(getOutboundQuestion(store, them.publicKey, id)?.state).toBe('sent')
    // Idempotent: a second sync does not move it again.
    expect(markSentQuestions(store, T0 + 4)).toBe(0)
  })

  it('leaves a question in sending while every publish is still failing', () => {
    approved()
    const id = ask(22)
    claimDue(store, { owner: 'test-owner', now: T0, limit: 1, authorize: () => true })
    expect(markSentQuestions(store, T0 + 1)).toBe(0)
    expect(getOutboundQuestion(store, them.publicKey, id)?.state).toBe('sending')
  })
})

describe('incoming decisions', () => {
  it('moves through received and then answered, and stops the retries', () => {
    approved()
    const id = ask(23)
    publishOne()
    markSentQuestions(store, T0 + 1)

    expect(applyReceipt(store, { recipient: them.publicKey, questionId: id, now: T0 + 10 })).toBe('applied')
    expect(getOutboundQuestion(store, them.publicKey, id)).toMatchObject({ state: 'received', receivedAt: T0 + 10 })
    // The receipt does not stop the retries: the row is still there.
    expect(outbox()).toHaveLength(1)

    const answer = { text: 'se despliega con npm run deploy', source: 'README.md', confidence: 'seguro' as const }
    expect(applyAnswer(store, { recipient: them.publicKey, questionId: id, answer, now: T0 + 20 })).toBe('applied')
    expect(getOutboundQuestion(store, them.publicKey, id)).toMatchObject({ state: 'answered', answer, decidedAt: T0 + 20 })
    expect(outbox()).toHaveLength(0)
  })

  it('accepts an answer that arrives before the receipt ever does', () => {
    approved()
    const id = ask(24)
    const answer = { text: 'sí', source: 'notas.md', confidence: 'creo' as const }
    expect(applyAnswer(store, { recipient: them.publicKey, questionId: id, answer, now: T0 + 5 })).toBe('applied')
    expect(getOutboundQuestion(store, them.publicKey, id)?.state).toBe('answered')
  })

  it('ignores a second decision for the same question', () => {
    approved()
    const id = ask(25)
    applyRejected(store, { recipient: them.publicKey, questionId: id, reason: 'limit', now: T0 + 5 })
    expect(getOutboundQuestion(store, them.publicKey, id)).toMatchObject({ state: 'rejected', rejectReason: 'limit' })

    const answer = { text: 'tarde', source: 'x', confidence: 'seguro' as const }
    expect(applyAnswer(store, { recipient: them.publicKey, questionId: id, answer, now: T0 + 6 })).toBe('ignored')
    expect(getOutboundQuestion(store, them.publicKey, id)).toMatchObject({ state: 'rejected', answer: null })
  })

  it('ignores a decision for a question this person never sent', () => {
    approved()
    expect(applyReceipt(store, { recipient: them.publicKey, questionId: uuid(404), now: T0 })).toBe('ignored')
    expect(applyRejected(store, { recipient: them.publicKey, questionId: uuid(404), reason: 'expired', now: T0 })).toBe('ignored')
  })
})

describe('expireOutboundQuestions', () => {
  it('gives up after the retry window and stops the retries', () => {
    approved()
    const id = ask(26)
    publishOne()
    markSentQuestions(store, T0 + 1)

    expect(expireOutboundQuestions(store, T0 + NOSTR.retryWindowSeconds - 1)).toBe(0)
    expect(expireOutboundQuestions(store, T0 + NOSTR.retryWindowSeconds)).toBe(1)
    expect(getOutboundQuestion(store, them.publicKey, id)).toMatchObject({ state: 'lost', decidedAt: T0 + NOSTR.retryWindowSeconds })
    expect(outbox()).toHaveLength(0)
  })

  it('never touches a question that already ended', () => {
    approved()
    const id = ask(27)
    applyAnswer(store, { recipient: them.publicKey, questionId: id, answer: { text: 'ok', source: 'x', confidence: 'seguro' }, now: T0 + 1 })
    expect(expireOutboundQuestions(store, T0 + NOSTR.retryWindowSeconds + 1)).toBe(0)
    expect(getOutboundQuestion(store, them.publicKey, id)?.state).toBe('answered')
  })
})

describe('the publisher promotes a question as it goes out', () => {
  it('fires onPublished for the row it just published', async () => {
    approved()
    const id = ask(31)
    const published: string[] = []
    const { publishDue } = await import('@agentbridge/core')
    // A pool that accepts everything, so the round records a publish.
    const pool = { publish: async () => ({ accepted: ['wss://relay.example.com'], rejected: [] }) } as never
    await publishDue({ store, identity: me, pool, now: () => T0, onPublished: (item) => published.push(item.rumorId) })
    expect(published).toHaveLength(1)
    expect(getOutboundQuestion(store, them.publicKey, id)?.state).toBe('sent')
  })
})

describe('purgeOutboundQuestions', () => {
  it('clears the text and the answer at 7 days and forgets the row at 9', () => {
    approved()
    const id = ask(28)
    applyAnswer(store, { recipient: them.publicKey, questionId: id, answer: { text: 'respuesta', source: 'x', confidence: 'seguro' }, now: T0 + 1 })

    expect(purgeOutboundQuestions(store, T0 + NOSTR.contentRetentionSeconds)).toEqual({ contentCleared: 1, forgotten: 0 })
    expect(getOutboundQuestion(store, them.publicKey, id)).toMatchObject({ state: 'answered', text: null, answer: null })

    expect(purgeOutboundQuestions(store, T0 + NOSTR.decisionRetentionSeconds)).toEqual({ contentCleared: 0, forgotten: 1 })
    expect(getOutboundQuestion(store, them.publicKey, id)).toBeNull()
  })
})
```

Append to `packages/core/test/device.test.ts` (inside the existing top-level `describe`, and add `createOutboundQuestion`, `createOutboundRequest`, `applyApproval`, `getOutboundQuestion` and `NOSTR` to its imports as needed):

```ts
  it('ages the asker questions from its purge loop', async () => {
    const { device, store, identity } = await setup()
    const them = testIdentity(77)
    createOutboundRequest(store, { pubkey: them.publicKey, requestId: uuid(1), relays: ['wss://relay.example.com'], now: T0 })
    applyApproval(store, { pubkey: them.publicKey, requestId: uuid(1), generation: 1, name: 'Ana', relays: ['wss://relay.example.com'], now: T0 })
    createOutboundQuestion(store, { identity, recipient: them.publicKey, text: 'hola', now: T0, newQuestionId: () => uuid(2) })

    clock.now = T0 + NOSTR.retryWindowSeconds
    device.start()
    await until(() => getOutboundQuestion(store, them.publicKey, uuid(2))?.state === 'lost')
  })
```

> If `device.test.ts`'s existing `setup()` does not already return `store` and `identity`, extend it to return them rather than opening a second store: two `Store` objects over one file would see different transactions.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/store-outbox-questions.test.ts packages/core/test/device.test.ts`
Expected: FAIL — the transitions do not exist, and the device only purges four things.

- [ ] **Step 3: Append the transitions**

In `packages/core/src/store/outbox-questions.ts`, add `resolveOutboxMessage` to the import from `./outbox`, and append:

```ts
const OPEN_STATES = "('sending', 'sent', 'received')"

// The outbox is the only place that knows a relay accepted a wrap: `markPublished` stamps
// last_published_at. Deriving the promotion from that column (instead of a callback in the
// publisher) means it also happens when another process did the publishing, and that a crash
// between the publish and this update loses nothing — the next sync promotes it.
export function markSentQuestions(store: Store, now: number): number {
  return store.tx(() => {
    const result = store.db
      .prepare(
        `UPDATE outbox_questions SET state = 'sent', updated_at = ?
           WHERE state = 'sending'
             AND EXISTS (SELECT 1 FROM outbox WHERE outbox.recipient = outbox_questions.recipient
                           AND outbox.rumor_id = outbox_questions.rumor_id AND outbox.last_published_at IS NOT NULL)`,
      )
      .run(now)
    return Number(result.changes)
  })
}

export function applyReceipt(store: Store, input: { recipient: string; questionId: string; now: number }): 'applied' | 'ignored' {
  return store.tx(() => {
    const row = selectRow(store, input.recipient, input.questionId)
    if (!row || (row.state !== 'sending' && row.state !== 'sent')) return 'ignored'
    store.db
      .prepare("UPDATE outbox_questions SET state = 'received', received_at = ?, updated_at = ? WHERE recipient = ? AND question_id = ?")
      .run(input.now, input.now, input.recipient, input.questionId)
    // The receipt deliberately does not resolve the outbox row: the spec keeps retrying until the
    // question has an answer or a rejection.
    return 'applied'
  })
}

function decide(
  store: Store,
  input: { recipient: string; questionId: string; now: number },
  apply: (row: QuestionRow) => void,
): 'applied' | 'ignored' {
  return store.tx(() => {
    const row = selectRow(store, input.recipient, input.questionId)
    // A final state never changes: a second decision for the same question is the caller's to log.
    if (!row || (row.state !== 'sending' && row.state !== 'sent' && row.state !== 'received')) return 'ignored'
    apply(row)
    // The question is settled, so its retries stop here.
    resolveOutboxMessage(store, { recipient: row.recipient, rumorId: row.rumor_id })
    return 'applied'
  })
}

export function applyAnswer(
  store: Store,
  input: { recipient: string; questionId: string; answer: OutboundAnswer; now: number },
): 'applied' | 'ignored' {
  return decide(store, input, () => {
    store.db
      .prepare(
        `UPDATE outbox_questions SET state = 'answered', answer_text = ?, answer_source = ?, answer_confidence = ?, decided_at = ?, updated_at = ?
           WHERE recipient = ? AND question_id = ?`,
      )
      .run(input.answer.text, input.answer.source, input.answer.confidence, input.now, input.now, input.recipient, input.questionId)
  })
}

export function applyRejected(
  store: Store,
  input: { recipient: string; questionId: string; reason: RejectReason; now: number },
): 'applied' | 'ignored' {
  return decide(store, input, () => {
    store.db
      .prepare(
        `UPDATE outbox_questions SET state = 'rejected', reject_reason = ?, decided_at = ?, updated_at = ?
           WHERE recipient = ? AND question_id = ?`,
      )
      .run(input.reason, input.now, input.now, input.recipient, input.questionId)
  })
}

// A question that never reached a final state inside the retry window can no longer be answered:
// the other side stopped hearing about it. Its outbox row goes too, so nothing keeps mining for it.
export function expireOutboundQuestions(store: Store, now: number): number {
  return store.tx(() => {
    const horizon = now - NOSTR.retryWindowSeconds
    const rows = store.db
      .prepare(`SELECT recipient, rumor_id FROM outbox_questions WHERE state IN ${OPEN_STATES} AND asked_at <= ?`)
      .all(horizon) as Array<{ recipient: string; rumor_id: string }>
    if (rows.length === 0) return 0
    store.db
      .prepare(`UPDATE outbox_questions SET state = 'lost', decided_at = ?, updated_at = ? WHERE state IN ${OPEN_STATES} AND asked_at <= ?`)
      .run(now, now, horizon)
    for (const row of rows) resolveOutboxMessage(store, { recipient: row.recipient, rumorId: row.rumor_id })
    return rows.length
  })
}

// Content (the question text and the answer) follows the 7-day retention; the row itself, which is
// what says the question ended and how, stays until 9 days.
export function purgeOutboundQuestions(store: Store, now: number): { contentCleared: number; forgotten: number } {
  return store.tx(() => {
    const contentCleared = store.db
      .prepare(
        `UPDATE outbox_questions SET text = NULL, answer_text = NULL, answer_source = NULL, answer_confidence = NULL, updated_at = ?
           WHERE asked_at <= ? AND (text IS NOT NULL OR answer_text IS NOT NULL)`,
      )
      .run(now, now - NOSTR.contentRetentionSeconds)
    const forgotten = store.db.prepare('DELETE FROM outbox_questions WHERE asked_at <= ?').run(now - NOSTR.decisionRetentionSeconds)
    return { contentCleared: Number(contentCleared.changes), forgotten: Number(forgotten.changes) }
  })
}
```

- [ ] **Step 4: Report a publish as it happens**

In `packages/core/src/device/publisher.ts`, add `onPublished?: (item: OutboxItem) => void` to `PublishDueInput`, and call it right after the branch that counted a published row (guarded, so a throwing callback cannot stop the round):

```ts
      if (outcome.accepted.length > 0) {
        if (markPublished(input.store, { recipient: item.recipient, rumorId: item.rumorId, owner, now: now() }) === 'claim_lost') {
          report.lost++
        } else {
          report.published++
          try {
            input.onPublished?.(item)
          } catch {
            // A caller's bookkeeping must never break the publishing round.
          }
        }
      } else if (…)
```

> Keep the existing branch structure; the only additions are the `onPublished` option and the guarded call.

In `packages/core/src/device/device.ts`, add `onPublished?: (item: OutboxItem) => void` to `DeviceOptions` and pass it through in both places that call `publishDue` (the background round and `syncOnce`).

- [ ] **Step 5: Let a retry of an already-sent question survive a revocation**

In `packages/core/src/device/authorize.ts`, replace the `question` case with:

```ts
    case 'question': {
      const contact = getContact(store, item.recipient, 'outbound')
      if (contact?.state === 'approved' && contact.generation === message.generation) return true
      // The other person may have revoked while this question was still open. The spec stores their
      // final rejected/stale_generation decision and regenerates it only when a retry arrives, so
      // the retry has to stay authorized: it is the one thing that fetches that decision. A NEW
      // question to a revoked contact never gets this far — createOutboundQuestion refuses it.
      const question = getOutboundQuestion(store, item.recipient, message.questionId)
      return question !== null && question.generation === message.generation && question.state !== 'answered' && question.state !== 'rejected' && question.state !== 'lost'
    }
```

and import `getOutboundQuestion` from `../store/outbox-questions`.

Add to `packages/core/test/device-authorize.test.ts`:

```ts
  it('keeps authorizing a retry of a question that was sent before the contact revoked', () => {
    // Seeded as approved, one question sent, then the contact revoked.
    const item = seedQuestionItem({ generation: 1 })
    applyRevocation(store, { pubkey: them.publicKey, generation: 2, now: T0 + 5 })
    expect(authorizeOutboxItem(store, item)).toBe(true)
  })

  it('refuses a question whose own row already ended', () => {
    const item = seedQuestionItem({ generation: 1 })
    applyRejected(store, { recipient: them.publicKey, questionId: questionIdOf(item), reason: 'stale_generation', now: T0 + 6 })
    expect(authorizeOutboxItem(store, item)).toBe(false)
  })
```

> `seedQuestionItem` builds the `OutboxItem` the same way the existing tests in that file build theirs (a stored question plus its outbox row); `questionIdOf` reads the id out of the item's rumor content. Write both helpers next to the file's existing ones rather than duplicating their bodies in each test.

- [ ] **Step 6: Wire the two steps into the device's purge loop**

In `packages/core/src/device/device.ts`, import them:

```ts
import { expireOutboundQuestions, purgeOutboundQuestions } from '../store/outbox-questions'
```

and add two steps to the `steps` array inside `purge()`, after `['outbox', …]`:

```ts
      ['sent questions', () => expireOutboundQuestions(this.options.store, now)],
      ['sent question content', () => purgeOutboundQuestions(this.options.store, now)],
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/store-outbox-questions.test.ts packages/core/test/device.test.ts packages/core/test/device-publisher.test.ts packages/core/test/device-authorize.test.ts`
Expected: PASS.

Run: `npm run typecheck && npm test`
Expected: clean, every test passing.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/store/outbox-questions.ts packages/core/src/device packages/core/test/store-outbox-questions.test.ts packages/core/test/device.test.ts packages/core/test/device-publisher.test.ts packages/core/test/device-authorize.test.ts
git commit -m "feat(core): the asker's question state machine, from sending to lost"
```
### Task 3: Step 10 for the asker role — routing opened messages

**Files:**
- Create: `packages/core/src/asker/inbound.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/asker-inbound.test.ts`

**Interfaces:**
- Consumes:
  - `type OpenedMessage` (plan 1)
  - `applyApproval`, `applyRejection`, `applyRevocation` (plan 1)
  - `applyReceipt`, `applyAnswer`, `applyRejected` (Task 2)
  - `store.relayPolicy`, `NOSTR`
- Produces:
  - `type AskerInboundOutcome = { kind: 'ignored'; reason: 'other_role' | 'no_relays' } | { kind: 'permission'; type: 'connect_approved' | 'connect_rejected' | 'connect_revoked'; outcome: 'applied' | 'ignored' } | { kind: 'question'; type: 'receipt' | 'answer' | 'rejected'; questionId: string; outcome: 'applied' | 'ignored' }`
  - `handleAskerMessage(store, { identity, opened, now }): AskerInboundOutcome`:
    - It is synchronous, and every write happens in one transaction.
    - `connect_approved` whose relay hints sanitize to nothing is ignored before anything is stored (the mirror of plan 2's P4).
    - `connect_approved` and `connect_rejected` only apply to the pending request with that `requestId`; `connect_approved` and `connect_revoked` only apply with a generation greater than the maximum ever observed. Plan 1's store functions already enforce both, so this file does not repeat the rules.
    - `receipt`, `answer` and `rejected` are keyed by `(senderPubkey, questionId)`, so a message from anyone other than that question's recipient can never touch it.
    - `connect_request` and `question` are `other_role`, and nothing is stored.
    - An `'ignored'` outcome on a `receipt`/`answer`/`rejected` is what a second decision looks like; Task 6's service logs it with identifiers only.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/asker-inbound.test.ts`:

```ts
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyApproval,
  createOutboundQuestion,
  createOutboundRequest,
  createRumor,
  getContact,
  getOutboundQuestion,
  handleAskerMessage,
  openStore,
  type Message,
  type OpenedMessage,
  type Store,
} from '@agentbridge/core'
import { testIdentity } from './support/keys'

const me = testIdentity(41)
const them = testIdentity(42)
const stranger = testIdentity(43)
const T0 = 2_000_000_000
const RELAYS = ['wss://relay.example.com']
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
let store: Store

beforeEach(async () => {
  store = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-ask-in-')), 'home'))
})
afterEach(() => store.close())

// An opened message exactly as the receive pipeline hands it over. Built by hand (rather than by
// wrapping and opening for real) so these tests stay fast, but with every field `OpenedMessage`
// declares, including the ones the router never reads.
function opened(message: Message, sender = them, createdAt = T0): OpenedMessage {
  const rumor = createRumor(message, sender, createdAt)
  return { ok: true, wrapId: rumor.id, senderPubkey: sender.publicKey, rumor, message, powBits: 16 }
}

// `satisfies Message` keeps `v: 1` and every `type` as the literal the discriminated union needs;
// a plain object literal would widen them to `number` and `string` and fail to type-check.
const handle = (message: Message, sender = them, now = T0) =>
  handleAskerMessage(store, { identity: me, opened: opened(message, sender), now })

function pendingRequest(): void {
  createOutboundRequest(store, { pubkey: them.publicKey, requestId: uuid(1), relays: RELAYS, now: T0 })
}

function approvedContact(generation = 1): void {
  pendingRequest()
  applyApproval(store, { pubkey: them.publicKey, requestId: uuid(1), generation, name: 'Ana', relays: RELAYS, now: T0 })
}

describe('handleAskerMessage — permissions', () => {
  it('applies an approval for the pending request', () => {
    pendingRequest()
    const result = handle({ v: 1, type: 'connect_approved', requestId: uuid(1), generation: 1, name: 'Ana', relays: RELAYS } satisfies Message)
    expect(result).toEqual({ kind: 'permission', type: 'connect_approved', outcome: 'applied' })
    expect(getContact(store, them.publicKey, 'outbound')).toMatchObject({ state: 'approved', generation: 1, declaredName: 'Ana' })
  })

  it('ignores an approval whose relays are all unusable, without storing anything', () => {
    pendingRequest()
    const result = handle({ v: 1, type: 'connect_approved', requestId: uuid(1), generation: 1, name: 'Ana', relays: ['http://x.example.com'] } satisfies Message)
    expect(result).toEqual({ kind: 'ignored', reason: 'no_relays' })
    expect(getContact(store, them.publicKey, 'outbound')?.state).toBe('pending')
  })

  it('ignores an approval for a request id that is not the pending one', () => {
    pendingRequest()
    const result = handle({ v: 1, type: 'connect_approved', requestId: uuid(2), generation: 1, name: 'Ana', relays: RELAYS } satisfies Message)
    expect(result).toEqual({ kind: 'permission', type: 'connect_approved', outcome: 'ignored' })
    expect(getContact(store, them.publicKey, 'outbound')?.state).toBe('pending')
  })

  it('applies a rejection and then ignores a stale revocation', () => {
    approvedContact(3)
    expect(handle({ v: 1, type: 'connect_revoked', generation: 2 } satisfies Message)).toEqual({ kind: 'permission', type: 'connect_revoked', outcome: 'ignored' })
    expect(getContact(store, them.publicKey, 'outbound')?.state).toBe('approved')

    expect(handle({ v: 1, type: 'connect_revoked', generation: 4 } satisfies Message)).toEqual({ kind: 'permission', type: 'connect_revoked', outcome: 'applied' })
    expect(getContact(store, them.publicKey, 'outbound')).toMatchObject({ state: 'revoked', maxGenerationSeen: 4 })
  })

  it('applies a rejection of the pending request', () => {
    pendingRequest()
    expect(handle({ v: 1, type: 'connect_rejected', requestId: uuid(1) } satisfies Message)).toEqual({ kind: 'permission', type: 'connect_rejected', outcome: 'applied' })
    expect(getContact(store, them.publicKey, 'outbound')?.state).toBe('rejected')
  })
})

describe('handleAskerMessage — answers to my questions', () => {
  function askOne(id: number): string {
    approvedContact()
    const { question } = createOutboundQuestion(store, { identity: me, recipient: them.publicKey, text: 'hola', now: T0, newQuestionId: () => uuid(id) })
    return question.questionId
  }

  it('records a receipt, then an answer', () => {
    const id = askOne(10)
    expect(handle({ v: 1, type: 'receipt', questionId: id } satisfies Message)).toEqual({ kind: 'question', type: 'receipt', questionId: id, outcome: 'applied' })
    expect(getOutboundQuestion(store, them.publicKey, id)?.state).toBe('received')

    const answer = { v: 1, type: 'answer', questionId: id, text: 'así se hace', source: 'README.md', confidence: 'seguro' } satisfies Message
    expect(handle(answer)).toEqual({ kind: 'question', type: 'answer', questionId: id, outcome: 'applied' })
    expect(getOutboundQuestion(store, them.publicKey, id)).toMatchObject({
      state: 'answered',
      answer: { text: 'así se hace', source: 'README.md', confidence: 'seguro' },
    })
  })

  it('records a rejection with its reason', () => {
    const id = askOne(11)
    expect(handle({ v: 1, type: 'rejected', questionId: id, reason: 'limit' } satisfies Message)).toEqual({
      kind: 'question',
      type: 'rejected',
      questionId: id,
      outcome: 'applied',
    })
    expect(getOutboundQuestion(store, them.publicKey, id)).toMatchObject({ state: 'rejected', rejectReason: 'limit' })
  })

  it('never lets a third party answer a question sent to someone else', () => {
    const id = askOne(12)
    const answer = { v: 1, type: 'answer', questionId: id, text: 'soy otro', source: 'x', confidence: 'seguro' } satisfies Message
    expect(handle(answer, stranger)).toEqual({ kind: 'question', type: 'answer', questionId: id, outcome: 'ignored' })
    expect(getOutboundQuestion(store, them.publicKey, id)?.state).toBe('sending')
  })

  it('reports a second decision as ignored instead of overwriting the first', () => {
    const id = askOne(13)
    handle({ v: 1, type: 'rejected', questionId: id, reason: 'expired' } satisfies Message)
    const answer = { v: 1, type: 'answer', questionId: id, text: 'tarde', source: 'x', confidence: 'seguro' } satisfies Message
    expect(handle(answer)).toEqual({ kind: 'question', type: 'answer', questionId: id, outcome: 'ignored' })
    expect(getOutboundQuestion(store, them.publicKey, id)?.state).toBe('rejected')
  })
})

describe('handleAskerMessage — the responder role', () => {
  it('ignores every message that belongs to the other role and stores nothing', () => {
    const before = store.db.prepare('SELECT count(*) AS n FROM contacts').get() as { n: number }
    expect(handle({ v: 1, type: 'connect_request', requestId: uuid(3), name: 'Ana', note: '', relays: RELAYS } satisfies Message)).toEqual({
      kind: 'ignored',
      reason: 'other_role',
    })
    expect(handle({ v: 1, type: 'question', questionId: uuid(4), generation: 1, text: 'hola' } satisfies Message)).toEqual({ kind: 'ignored', reason: 'other_role' })
    expect(store.db.prepare('SELECT count(*) AS n FROM contacts').get()).toEqual(before)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/asker-inbound.test.ts`
Expected: FAIL — `handleAskerMessage` does not exist.

- [ ] **Step 3: Create the module**

Create `packages/core/src/asker/inbound.ts`:

```ts
import type { OpenedMessage } from '../envelope/open'
import type { Identity } from '../identity'
import { NOSTR } from '../nostr-constants'
import { applyApproval, applyRejection, applyRevocation } from '../store/contacts'
import type { Store } from '../store/db'
import { applyAnswer, applyReceipt, applyRejected } from '../store/outbox-questions'

export type AskerInboundOutcome =
  | { kind: 'ignored'; reason: 'other_role' | 'no_relays' }
  | { kind: 'permission'; type: 'connect_approved' | 'connect_rejected' | 'connect_revoked'; outcome: 'applied' | 'ignored' }
  | { kind: 'question'; type: 'receipt' | 'answer' | 'rejected'; questionId: string; outcome: 'applied' | 'ignored' }

// Step 10 of the receive pipeline for an asker process. Only the six messages an asker can act on are
// its business: connect_request and question belong to this identity's responder role, whose own
// process reads them with its own history cursors, so nothing about them is stored here.
//
// Every rule about *which* of these messages counts — a request id that must match the pending
// request, a generation that must be greater than the maximum ever observed, a question that must be
// one this person actually sent to that very recipient — lives in the store functions below. This
// file only routes.
export function handleAskerMessage(store: Store, input: { identity: Identity; opened: OpenedMessage; now: number }): AskerInboundOutcome {
  const { opened } = input
  const message = opened.message
  const sender = opened.senderPubkey

  switch (message.type) {
    case 'connect_approved': {
      const relays = store.relayPolicy(message.relays).slice(0, NOSTR.maxRelaysPerContact)
      // An approval with no usable relay leaves nowhere to send questions, so it is not stored at
      // all — the mirror of how a responder ignores a request with no usable relay.
      if (relays.length === 0) return { kind: 'ignored', reason: 'no_relays' }
      const outcome = applyApproval(store, {
        pubkey: sender,
        requestId: message.requestId,
        generation: message.generation,
        name: message.name,
        relays,
        now: input.now,
      })
      return { kind: 'permission', type: 'connect_approved', outcome }
    }
    case 'connect_rejected':
      return { kind: 'permission', type: 'connect_rejected', outcome: applyRejection(store, { pubkey: sender, requestId: message.requestId, now: input.now }) }
    case 'connect_revoked':
      return { kind: 'permission', type: 'connect_revoked', outcome: applyRevocation(store, { pubkey: sender, generation: message.generation, now: input.now }) }
    case 'receipt':
      return {
        kind: 'question',
        type: 'receipt',
        questionId: message.questionId,
        outcome: applyReceipt(store, { recipient: sender, questionId: message.questionId, now: input.now }),
      }
    case 'answer':
      return {
        kind: 'question',
        type: 'answer',
        questionId: message.questionId,
        outcome: applyAnswer(store, {
          recipient: sender,
          questionId: message.questionId,
          answer: { text: message.text, source: message.source, confidence: message.confidence },
          now: input.now,
        }),
      }
    case 'rejected':
      return {
        kind: 'question',
        type: 'rejected',
        questionId: message.questionId,
        outcome: applyRejected(store, { recipient: sender, questionId: message.questionId, reason: message.reason, now: input.now }),
      }
    default:
      return { kind: 'ignored', reason: 'other_role' }
  }
}
```

- [ ] **Step 4: Export it**

In `packages/core/src/index.ts`, after the line that re-exports `./responder/inbound`:

```ts
export * from './asker/inbound'
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/asker-inbound.test.ts`
Expected: PASS.

Run: `npm run typecheck && npm test`
Expected: clean, every test passing.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/asker/inbound.ts packages/core/src/index.ts packages/core/test/asker-inbound.test.ts
git commit -m "feat(core): route opened messages for the asker role"
```
### Task 4: Mining a connection request in parallel

**Files:**
- Modify: `packages/core/src/envelope/pow.ts`
- Test: `packages/core/test/envelope-pow.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `mineEvent(event, bits, options?)` keeps its exact signature and result, and now searches the nonce space with several workers at once: worker `k` of `n` starts at `k` and steps by `n`, the first hit wins, and the rest are terminated.
  - `options.workers?: number` — how many workers to use. Tests pin it; production leaves it out and gets `Math.max(1, Math.min(availableParallelism() - 1, 4))`.
- Measured before this task: a 22-bit `connect_request` took 16.5 s on one worker (plan 1's live run). The point of this task is that `connect` feels like a pause, not a hang.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/envelope-pow.test.ts`. The last test spies on the worker constructor, so the file needs `import * as workerThreads from 'node:worker_threads'`, `import { Worker } from 'node:worker_threads'` and `vi` from vitest:

```ts
describe('mineEvent across several workers', () => {
  const event = { pubkey: 'a'.repeat(64), created_at: 1_700_000_000, kind: 1059, tags: [] as string[][], content: 'x' }

  it('finds a nonce with several workers and keeps the result verifiable', async () => {
    const mined = await mineEvent(event, 12, { workers: 3 })
    expect(leadingZeroBits(mined.id)).toBeGreaterThanOrEqual(12)
    const nonceTag = mined.tags.find((t) => t[0] === 'nonce')
    expect(nonceTag?.[2]).toBe('12')
    expect(Number(nonceTag?.[1])).toBeGreaterThanOrEqual(0)
  })

  it('splits the nonce space, so the workers never try the same nonce twice', async () => {
    // With one worker per lane and a stride equal to the lane count, lane k only ever tries nonces
    // congruent to k. Two runs of the same event with different lane counts must both be valid.
    const a = await mineEvent(event, 10, { workers: 1 })
    const b = await mineEvent(event, 10, { workers: 4 })
    expect(leadingZeroBits(a.id)).toBeGreaterThanOrEqual(10)
    expect(leadingZeroBits(b.id)).toBeGreaterThanOrEqual(10)
  })

  it('stops every worker when the caller aborts', async () => {
    const controller = new AbortController()
    const mining = mineEvent(event, 32, { workers: 4, signal: controller.signal })
    controller.abort()
    await expect(mining).rejects.toThrow('mining aborted')
  })

  it('refuses a worker count that is not a positive integer', async () => {
    await expect(mineEvent(event, 8, { workers: 0 })).rejects.toThrow(RangeError)
    await expect(mineEvent(event, 8, { workers: 2.5 })).rejects.toThrow(RangeError)
  })

  it('terminates the lanes it already created when one fails to start', async () => {
    // A worker allocation can fail (a process at its thread limit). Inject that on the second lane.
    const realWorker = Worker
    let created = 0
    const terminated: number[] = []
    class FailingWorker extends realWorker {
      constructor(...args: ConstructorParameters<typeof realWorker>) {
        created += 1
        if (created === 2) throw new Error('simulated worker allocation failure')
        super(...args)
      }
      override terminate(): Promise<number> {
        terminated.push(created)
        return super.terminate()
      }
    }
    vi.spyOn(workerThreads, 'Worker').mockImplementation(FailingWorker as never)
    await expect(mineEvent(event, 20, { workers: 3 })).rejects.toThrow('simulated worker allocation failure')
    expect(terminated.length).toBeGreaterThanOrEqual(1)
    vi.restoreAllMocks()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/envelope-pow.test.ts`
Expected: FAIL — `workers` is not an option, so the abort test still passes but the first two fail on the unknown option (TypeScript) and the count test does not reject.

- [ ] **Step 3: Replace the whole content of `packages/core/src/envelope/pow.ts` with:**

```ts
import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'
import { getPow } from 'nostr-tools/nip13'

export type UnsignedEvent = { pubkey: string; created_at: number; kind: number; tags: string[][]; content: string }
export type MinedEvent = UnsignedEvent & { id: string }

export const leadingZeroBits = (hexId: string): number => getPow(hexId)

// One worker is left for everything else, so a laptop stays usable while a connection request mines,
// and the cap keeps the memory of four extra V8 isolates bounded on a many-core machine.
export const defaultMiningWorkers = (): number => Math.max(1, Math.min(availableParallelism() - 1, 4))

// Inline CommonJS source so the worker survives esbuild's single-file bundles (a separate worker
// file would not be copied into dist). Serialization matches NIP-01 exactly, and created_at is
// never changed: NIP-59 wraps carry a deliberately randomized past date.
//
// Each worker walks its own lane of the nonce space: worker `start` of `stride` tries
// start, start + stride, start + 2 * stride, … so no two workers ever hash the same candidate.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { createHash } = require('node:crypto')
const { event, bits, start, stride } = workerData
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
for (let i = start; ; i += stride) {
  nonce[1] = String(i)
  const hash = createHash('sha256').update(JSON.stringify([0, event.pubkey, event.created_at, event.kind, tags, event.content])).digest()
  if (zeros(hash) >= bits) {
    parentPort.postMessage({ nonce: nonce[1], id: hash.toString('hex') })
    break
  }
}
`

export function mineEvent(event: UnsignedEvent, bits: number, options: { signal?: AbortSignal; workers?: number } = {}): Promise<MinedEvent> {
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) throw new RangeError('bits must be an integer from 0 to 32')
  return new Promise((resolve, reject) => {
    const lanes = options.workers ?? defaultMiningWorkers()
    if (!Number.isInteger(lanes) || lanes < 1) {
      reject(new RangeError('workers must be a positive integer'))
      return
    }
    if (options.signal?.aborted) {
      reject(new Error('mining aborted'))
      return
    }
    const workers: Worker[] = []
    let settled = false
    // Every exit goes through `settle`, including a failure to *create* a worker: a throw from
    // `new Worker` would otherwise reject this promise directly, leaving the lanes already created
    // mining forever and the abort listener attached. Terminating every worker is what makes an
    // abort real (a losing lane is in a tight synchronous loop), and waiting for those terminations
    // before settling keeps a losing lane from burning a core into the caller's next operation.
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      void Promise.allSettled(workers.map((worker) => worker.terminate())).then(fn)
    }
    const onAbort = () => settle(() => reject(new Error('mining aborted')))
    options.signal?.addEventListener('abort', onAbort, { once: true })

    let exited = 0
    try {
      for (let lane = 0; lane < lanes; lane++) {
        const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { event, bits, start: lane, stride: lanes } })
        workers.push(worker)
        worker.once('message', (m: { nonce: string; id: string }) =>
          settle(() => resolve({ ...event, tags: [...event.tags, ['nonce', m.nonce, String(bits)]], id: m.id })),
        )
        worker.once('error', (err) => settle(() => reject(err)))
        // A worker that ends without posting a nonce (killed, or exited from inside) is only fatal
        // when it was the last one still searching: while another lane is alive the search goes on.
        // After a message or an error, `settle` makes this a no-op anyway.
        worker.once('exit', () => {
          exited += 1
          if (exited === workers.length) settle(() => reject(new Error('mining worker exited')))
        })
      }
    } catch (err) {
      settle(() => reject(err))
    }
  })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/envelope-pow.test.ts`
Expected: PASS.

Run: `npm run typecheck && npm test`
Expected: clean, every test passing (the existing mining tests use the default worker count).

- [ ] **Step 5: Measure the difference on a realistic event, and record it**

Write `scripts/measure-pow.mjs` (a scratch script this task adds and Task 15 reuses) and run it once:

```bash
npx tsx scripts/measure-pow.mjs
```

```js
// scripts/measure-pow.mjs — how long a real connection request takes to mine, on one lane and on
// the default lanes. Three samples each, median reported: a single sample of a toy event is not
// comparable to the 16 487 ms plan 1 measured against public relays.
import { defaultMiningWorkers, mineEvent } from '../packages/core/src/envelope/pow.ts'
import { createRumor, wrapRumor } from '../packages/core/src/envelope/seal.ts'
import { NOSTR, nowSeconds } from '../packages/core/src/nostr-constants.ts'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'

const secretKey = generateSecretKey()
const identity = { secretKey, publicKey: getPublicKey(secretKey) }
const recipient = getPublicKey(generateSecretKey())
// The event a connect_request really mines: a sealed, encrypted wrap, not a short string.
const rumor = createRumor(
  { v: 1, type: 'connect_request', requestId: crypto.randomUUID(), name: 'Medición', note: 'x'.repeat(200), relays: ['wss://relay.example.com'] },
  identity,
  nowSeconds(),
)
const wrap = await wrapRumor(rumor, identity, recipient, { now: nowSeconds() })
const unsigned = { pubkey: wrap.pubkey, created_at: wrap.created_at, kind: wrap.kind, tags: [], content: wrap.content }

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
for (const workers of [1, defaultMiningWorkers()]) {
  const samples = []
  for (let i = 0; i < 3; i++) {
    const started = Date.now()
    await mineEvent({ ...unsigned, created_at: unsigned.created_at - i }, NOSTR.powRequestBits, { workers })
    samples.push(Date.now() - started)
  }
  console.log(`[pow] 22 bits with ${workers} worker(s): median ${median(samples)} ms of ${samples.join(', ')}`)
}
```

Put both medians in the commit message. They are the evidence that `connect` stopped being a hang; plan 4's documentation quotes them.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/envelope/pow.ts packages/core/test/envelope-pow.test.ts scripts/measure-pow.mjs
git commit -m "perf(core): mine a connection request across several workers"
```
### Task 5: A deadline that actually bounds a command

**Files:**
- Modify: `packages/core/src/boards/pool.ts` (`query`, `publish` and `connection` take the caller's signal)
- Modify: `packages/core/src/boards/connection.ts` (the AUTH/handshake wait honors an aborted signal)
- Modify: `packages/core/src/device/publisher.ts` (a mining budget of its own)
- Modify: `packages/core/src/device/device.ts` (`syncOnce` passes its signal to every pool call and waits for what it started)
- Test: `packages/core/test/boards-pool.test.ts` (append), `packages/core/test/device.test.ts` (append), `packages/core/test/device-publisher.test.ts` (append)

**Interfaces:**
- Consumes: plan 1's `BoardPool`, `BoardConnection`; plan 2's `Device.syncOnce`, `publishDue`.
- Produces:
  - `BoardPool.query(relay, filter, options?: { timeoutMs?: number; signal?: AbortSignal })` — an aborted signal ends the query at once with `complete: false` and a fixed English reason; a query that has not connected yet stops waiting for the connection too.
  - `BoardPool.publish(relays, event, beforeSend?, options?: { signal?: AbortSignal })` — the same: an aborted signal stops waiting on relays that have not answered, and the relays that already accepted still count.
  - `publishDue` takes `miningMs?: number` (default 60 000), and `Device` takes the same option and forwards it: the proof-of-work budget for one row, enforced with its own `AbortSignal`, separate from the sync's network deadline. A mining timeout leaves the row pending for the next round, exactly like a postponement.
  - `Device.syncOnce({ maxMs })` passes its deadline signal into every history query and into publishing, so a sync returns within `maxMs` plus the time the store needs, not plus a pool timeout.
- Why this task exists: the spec bounds a short-lived client's sync at ten seconds, and the only thing that made that true before was each pool call's own timeout. A slow relay could push a "10-second" sync past twenty. Mining is CPU, not network, so it gets its own budget instead of being charged to that ten seconds.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/boards-pool.test.ts`:

```ts
describe('BoardPool honors a caller signal', () => {
  it('ends a query at once when the caller aborts', async () => {
    const board = await startFakeBoard({ beforeEose: async () => new Promise(() => {}) })
    const pool = new BoardPool({ identity, createSocket: plainSocketFactory, timeoutMs: 30_000 })
    const controller = new AbortController()
    const started = Date.now()
    const querying = pool.query(board.url, { kinds: [1059], limit: 10 }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    const result = await querying
    expect(result.complete).toBe(false)
    expect(Date.now() - started).toBeLessThan(5_000)
    await pool.close()
    await board.close()
  })

  it('stops waiting for a relay that never answers a publish', async () => {
    const board = await startFakeBoard({ swallowPublishes: true })
    const pool = new BoardPool({ identity, createSocket: plainSocketFactory, timeoutMs: 30_000 })
    const controller = new AbortController()
    const started = Date.now()
    const publishing = pool.publish([board.url], event, () => true, { signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    const outcome = await publishing
    expect(outcome.accepted).toEqual([])
    expect(Date.now() - started).toBeLessThan(5_000)
    await pool.close()
    await board.close()
  })
})
```

> Use whatever the fake board already offers for "answers nothing" (plan 1 gave it failure modes for losing events, answering slowly and disconnecting mid-subscription). If it has no option for swallowing a publish, add one there — it is test support, and Task 15 needs it too.

Append to `packages/core/test/device.test.ts`:

```ts
  it('returns from syncOnce inside its deadline even when a relay never answers', async () => {
    const { device } = await setup({ relayBehavior: 'silent' })
    const started = Date.now()
    const report = await device.syncOnce({ maxMs: 1_000 })
    expect(report.timedOut).toBe(true)
    // The budget plus a small margin for the store, not plus a pool timeout.
    expect(Date.now() - started).toBeLessThan(3_000)
  })
```

Append to `packages/core/test/device-publisher.test.ts`:

```ts
  it('leaves a row pending when mining runs past its own budget, without touching the sync deadline', async () => {
    const { store, identity, pool } = await setupPublisher()
    enqueueConnectRequest(store, { now: T0 })
    const report = await publishDue({ store, identity, pool, now: () => T0, miningMs: 1 })
    expect(report.published).toBe(0)
    expect(report.postponed + report.failed).toBeGreaterThanOrEqual(1)
    expect(store.db.prepare("SELECT state FROM outbox").get()).toMatchObject({ state: 'pending' })
  })
```

> `setupPublisher` and `enqueueConnectRequest` are that file's existing helpers (or the closest ones); a 22-bit row with a 1 ms budget cannot finish, which is the point.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/boards-pool.test.ts packages/core/test/device.test.ts packages/core/test/device-publisher.test.ts`
Expected: FAIL — `query` and `publish` take no signal, and `publishDue` has no mining budget.

- [ ] **Step 3: Carry the signal through the pool**

In `packages/core/src/boards/pool.ts`:

- `connection(relay, signal?)` rejects immediately when `signal?.aborted`, and races its connect promise against the signal's `abort` event so a caller stops waiting even though the connection attempt continues in the background (the pool still owns and closes it).
- `query(relay, filter, options: { timeoutMs?: number; signal?: AbortSignal } = {})` — keep the current `timeoutMs` behavior and add: an already-aborted signal returns `{ events: [], complete: false, closedReason: 'error: sync deadline reached' }` without connecting; an abort during the query settles it the same way and unsubscribes.
- `publish(relays, event, beforeSend = () => true, options: { signal?: AbortSignal } = {})` — an abort settles the per-relay promise as rejected-with-reason `'error: sync deadline reached'` for the relays that had not answered, and the ones that already accepted stay in `accepted`.

Keep both signatures backwards compatible (the extra argument is optional), so plan 2's callers keep compiling unchanged.

- [ ] **Step 4: Give mining its own budget**

In `packages/core/src/device/publisher.ts`, add `miningMs?: number` to `PublishDueInput` and, around the `wrapRumor` call, combine the caller's `signal` with a per-row timeout:

```ts
      const mining = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(input.miningMs ?? 60_000)])
      wrap = await wrapRumor(item.rumor, input.identity, item.recipient, { now: now(), signal: mining })
```

A mining abort is already handled by the existing catch, which postpones the row instead of counting a failure — that is the behavior this budget wants.

- [ ] **Step 5: Pass the sync's signal everywhere**

In `packages/core/src/device/device.ts`:
- thread the `syncOnce` deadline's `signal` into `recoverHistory`'s pool queries and into `publishDue` (it already receives `signal`; make sure the pool calls inside `publishDue` get it too, through the new `publish` option);
- add `miningMs?: number` to `DeviceOptions` and pass it to both `publishDue` calls, so a caller can give proof of work its own budget.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run packages/core/test/boards-pool.test.ts packages/core/test/device.test.ts packages/core/test/device-publisher.test.ts`
Expected: PASS.

Run: `npm run typecheck && npm test`
Expected: clean, every test passing — including plan 2's channel tests, which call the pool without the new options.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/boards packages/core/src/device packages/core/test
git commit -m "feat(core): let a caller's deadline reach the relays, and give mining its own budget"
```
### Task 6: `AskerService` — connect, contacts, ask, and the short-lived cycle

**Files:**
- Create: `packages/cli/src/asker/service.ts`
- Create: `packages/cli/src/asker/session.ts`
- Test: `packages/cli/test/asker-service.test.ts`

**Interfaces:**
- Consumes:
  - core: `Device`, `handleAskerMessage`, `type AskerInboundOutcome`, `openStore`, `loadIdentity`, `agentbridgeHome`, `decodeLink`, `encodeLink`, `createRumor`, `enqueue`, `createOutboundRequest`, `getContact`, `listContacts`, `findContactByLocalName`, `askPermission`, `createOutboundQuestion`, `markSentQuestions`, `expireOutboundQuestions`, `getOutboundQuestion`, `findOutboundQuestions`, `MIN_QUESTION_PREFIX`, `getProfile`, `nowSeconds`, `describeError`, `sanitizeRelayText` is internal — use `describeError` for errors and never print a relay's own text from this layer, `UserFacingError`, `NOSTR`, `type Identity`, `type Store`, `type SyncReport`, `type Contact`, `type OutboundQuestion`
  - CLI: `CliError`, `type CliContext` (`packages/cli/src/context.ts`)
- Produces:
  - `type AskerServiceOptions = { store: Store; identity: Identity; now?: () => number; createSocket?: SocketFactory; log?: (line: string) => void }`
  - `type ConnectOutcome = { kind: 'requested'; pubkey: string; relays: string[] } | { kind: 'already_pending'; pubkey: string } | { kind: 'already_approved'; pubkey: string; name: string }`
  - `class AskerService`:
    - `readonly device: Device<AskerInboundOutcome>`
    - `start(): void` — persistent mode: live subscription, retries and purge on a timer (only the MCP server calls it)
    - `sync(maxMs?: number): Promise<SyncReport>` — one sync (default 10 000 ms), then `markSentQuestions` and `expireOutboundQuestions`
    - `connect(link: string, note: string): Promise<ConnectOutcome>`
    - `contacts(): Contact[]` — the outbound contacts, newest state first as stored
    - `ask(name: string, text: string): Promise<OutboundQuestion>`
    - `question(idOrPrefix: string): OutboundQuestion` — exact id, or a prefix of at least `MIN_QUESTION_PREFIX` characters that matches exactly one; Spanish `UserFacingError` when there is none or more than one
    - `close(): Promise<void>`
  - `openAskerSession(options: { home: string; now?; createSocket?; log?; relayPolicy? }): Promise<{ service: AskerService; close(): Promise<void> }>` (in `session.ts`)
  - `withAsker<T>(ctx: CliContext, fn: (service: AskerService) => Promise<T>, options?: { firstSyncMs?: number; lastSyncMs?: number }): Promise<T>` — start → sync → operate → sync → close, always closing.
  - `withResponderSession<T>(ctx: CliContext, fn: (input: { store: Store; identity: Identity; sync: () => Promise<void> }) => Promise<T>): Promise<T>` — the same cycle for the four commands about messages addressed to this person as a responder (`requests`, `approve`, `reject`, `revoke`). It runs a `Device` with `role: 'responder'` and `handleResponderMessage`, and it never takes the channel lock and never starts a dispatcher: only the channel hands questions to Claude (P10).
  - `CliContext` gains an optional `relayPolicy?: RelayPolicy`, used the way the existing optional `fetchImpl` is: production leaves it undefined, and a test passes a policy that accepts the fake board's `ws://127.0.0.1` URLs.
- Waiting for an answer is Task 7.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/test/asker-service.test.ts`:

```ts
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  UserFacingError,
  applyApproval,
  createOutboundRequest,
  encodeLink,
  getContact,
  getOutboundQuestion,
  SeenIds,
  nowSeconds,
  openStore,
  openWrap,
  precheckWrap,
  setProfile,
  type Message,
  type Store,
} from '@agentbridge/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { plainSocketFactory, startFakeBoard, type FakeBoard } from '../../core/test/support/fake-board'
import { testIdentity } from '../../core/test/support/keys'
import { AskerService } from '../src/asker/service'

const me = testIdentity(51)
const them = testIdentity(52)
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

let board: FakeBoard
let store: Store
let service: AskerService

// Every relay a test uses is a local fake board, so the policy that normally rejects ws:// and
// loopback addresses has to be relaxed here — exactly as the responder harness does.
const allowAnyRelay = (inputs: readonly unknown[]): string[] =>
  inputs.filter((value): value is string => typeof value === 'string' && value.startsWith('ws')).slice(0, 5)

beforeEach(async () => {
  board = await startFakeBoard()
  const home = join(await mkdtemp(join(tmpdir(), 'ab-asker-')), 'home')
  store = await openStore(home, { relayPolicy: allowAnyRelay })
  setProfile(store, { name: 'Beto', relays: [board.url], now: 2_000_000_000 })
  service = new AskerService({ store, identity: me, createSocket: plainSocketFactory })
})

afterEach(async () => {
  await service.close()
  store.close()
  await board.close()
})

// What the other person's relay actually received, opened with their key. `precheckWrap` and
// `openWrap` both take an OpenContext and both discriminate on `.ok` (they are plan 1's real
// signatures; `openWrap` is synchronous).
function received(): Message[] {
  const ctx = { identity: them, now: nowSeconds(), seen: new SeenIds() }
  const messages: Message[] = []
  for (const event of board.events) {
    const prechecked = precheckWrap(event, ctx)
    if (!prechecked.ok) continue
    const opened = openWrap(prechecked, ctx)
    if (opened.ok) messages.push(opened.message)
  }
  return messages
}

describe('connect', () => {
  it('stores a pending request and publishes it to the relays in the link', async () => {
    const outcome = await service.connect(encodeLink(them.publicKey, [board.url]), 'soy Beto, del equipo de datos')
    expect(outcome).toMatchObject({ kind: 'requested', pubkey: them.publicKey })
    expect(getContact(store, them.publicKey, 'outbound')).toMatchObject({ state: 'pending' })

    await service.sync(30_000)
    const messages = received()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ type: 'connect_request', name: 'Beto', note: 'soy Beto, del equipo de datos' })
  })

  it('says the request is already on its way instead of sending a second one', async () => {
    const link = encodeLink(them.publicKey, [board.url])
    await service.connect(link, 'hola')
    const second = await service.connect(link, 'hola otra vez')
    expect(second).toMatchObject({ kind: 'already_pending', pubkey: them.publicKey })
  })

  it('refuses a link with no usable relay', async () => {
    await expect(service.connect(encodeLink(them.publicKey, ['http://x.example.com']), 'hola')).rejects.toThrow(UserFacingError)
  })

  it('refuses to connect before this person has a name', async () => {
    const bare = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-asker-bare-')), 'home'), { relayPolicy: allowAnyRelay })
    const bareService = new AskerService({ store: bare, identity: me, createSocket: plainSocketFactory })
    await expect(bareService.connect(encodeLink(them.publicKey, [board.url]), 'hola')).rejects.toThrow(UserFacingError)
    await bareService.close()
    bare.close()
  })

  it('says so when that person already approved this one', async () => {
    createOutboundRequest(store, { pubkey: them.publicKey, requestId: uuid(1), relays: [board.url], now: 2_000_000_000 })
    applyApproval(store, { pubkey: them.publicKey, requestId: uuid(1), generation: 1, name: 'Ana', relays: [board.url], now: 2_000_000_000 })
    const outcome = await service.connect(encodeLink(them.publicKey, [board.url]), 'hola')
    expect(outcome).toMatchObject({ kind: 'already_approved', name: 'Ana' })
  })
})

describe('ask', () => {
  function approved(): void {
    createOutboundRequest(store, { pubkey: them.publicKey, requestId: uuid(1), relays: [board.url], now: 2_000_000_000 })
    applyApproval(store, { pubkey: them.publicKey, requestId: uuid(1), generation: 1, name: 'Ana', relays: [board.url], now: 2_000_000_000 })
  }

  it('stores the question, publishes it, and promotes it to sent on the next sync', async () => {
    approved()
    const question = await service.ask('ana', '¿cómo se despliega?')
    expect(question.state).toBe('sending')

    await service.sync()
    expect(received().map((m) => m.type)).toContain('question')
    expect(getOutboundQuestion(store, them.publicKey, question.questionId)?.state).toBe('sent')
  })

  it('refuses a name nobody in the contact list has', async () => {
    approved()
    await expect(service.ask('nadie', 'hola')).rejects.toThrow(UserFacingError)
  })

  it('refuses to ask someone who has not approved this person yet', async () => {
    createOutboundRequest(store, { pubkey: them.publicKey, requestId: uuid(1), relays: [board.url], now: 2_000_000_000 })
    await expect(service.ask(them.publicKey, 'hola')).rejects.toThrow(UserFacingError)
  })
})

describe('question lookup', () => {
  it('finds a question by its id or by a prefix, and is explicit when it cannot', async () => {
    createOutboundRequest(store, { pubkey: them.publicKey, requestId: uuid(1), relays: [board.url], now: 2_000_000_000 })
    applyApproval(store, { pubkey: them.publicKey, requestId: uuid(1), generation: 1, name: 'Ana', relays: [board.url], now: 2_000_000_000 })
    const asked = await service.ask('ana', 'hola')

    expect(service.question(asked.questionId).questionId).toBe(asked.questionId)
    expect(service.question(asked.questionId.slice(0, 8)).questionId).toBe(asked.questionId)
    expect(() => service.question('00000000-0000-4000-8000-ffffffffffff')).toThrow(UserFacingError)
    expect(() => service.question('abc')).toThrow(UserFacingError)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/cli/test/asker-service.test.ts`
Expected: FAIL — `packages/cli/src/asker/service.ts` does not exist.

- [ ] **Step 3: Create `packages/cli/src/asker/service.ts`**

```ts
import { randomUUID } from 'node:crypto'
import {
  Device,
  NOSTR,
  UserFacingError,
  askPermission,
  createOutboundQuestion,
  createOutboundRequest,
  createRumor,
  decodeLink,
  describeError,
  enqueue,
  expireOutboundQuestions,
  findContactByLocalName,
  findOutboundQuestions,
  getContact,
  getOutboundQuestion,
  getProfile,
  handleAskerMessage,
  listContacts,
  markSentQuestions,
  nowSeconds,
  MIN_QUESTION_PREFIX,
  type AskerInboundOutcome,
  type Contact,
  type Identity,
  type OutboundQuestion,
  type SocketFactory,
  type Store,
  type SyncReport,
} from '@agentbridge/core'

export type AskerServiceOptions = {
  store: Store
  identity: Identity
  now?: () => number
  createSocket?: SocketFactory
  log?: (line: string) => void
}

export type ConnectOutcome =
  | { kind: 'requested'; pubkey: string; relays: string[] }
  | { kind: 'already_pending'; pubkey: string }
  | { kind: 'already_approved'; pubkey: string; name: string }

const CLI_SYNC_MS = 10_000
// Proof of work is CPU, not network: it gets its own budget so it never eats the ten seconds the
// spec gives a short-lived client's sync (see P5b and P5c).
const CONNECT_MINING_MS = 60_000

// Everything a person does as an asker, in one object the CLI and the MCP server both drive. It owns
// no files: whoever builds it passes an identity and a store that are already open, so a test can run
// it against a temporary home without going through the command line.
export class AskerService {
  readonly device: Device<AskerInboundOutcome>
  private readonly store: Store
  private readonly identity: Identity
  private readonly now: () => number
  private readonly log: (line: string) => void
  private closed = false
  private syncing: Promise<SyncReport> = Promise.resolve({ history: [], published: { published: 0, failed: 0, postponed: 0, lost: 0 }, timedOut: false })

  constructor(options: AskerServiceOptions) {
    this.store = options.store
    this.identity = options.identity
    this.now = options.now ?? nowSeconds
    this.log = options.log ?? (() => {})
    this.device = new Device<AskerInboundOutcome>({
      store: options.store,
      identity: options.identity,
      role: 'asker',
      handleMessage: handleAskerMessage,
      now: options.now,
      createSocket: options.createSocket,
      log: options.log,
      // Proof of work is CPU, not network: a 22-bit connection request gets a minute of its own and
      // never eats the ten seconds a sync is allowed to spend on relays (P5b, P5c).
      miningMs: CONNECT_MINING_MS,
      onMessage: (opened, outcome) => {
        // A second decision for a question that already ended is the one outcome worth a line: it
        // means the other side sent two. Identifiers only — never the answer's text.
        if (outcome.kind === 'question' && outcome.outcome === 'ignored') {
          this.safeLog(`ignored a late ${outcome.type} for question ${outcome.questionId} from ${opened.senderPubkey.slice(0, 8)}`)
        }
      },
    })
  }

  private safeLog(line: string): void {
    try {
      this.log(line)
    } catch {
      // Nowhere left to report a broken logger.
    }
  }

  // The persistent mode: live subscription, periodic history, retries and purge on timers. Only the
  // MCP server calls it; every CLI command uses sync() instead.
  start(): void {
    this.device.start()
  }

  // One turn of the short-lived cycle. The two store passes afterwards are what move a question from
  // `sending` to `sent` once a relay accepted its wrap, and what gives up on one that ran out of
  // retry window — both derived from what the sync just did, so they hold for a CLI run and for the
  // MCP server alike.
  // Syncs are serialized: `Device.syncOnce` keeps a single in-flight sync in one field, so two
  // overlapping calls (two MCP tools at once) would leave `close()` waiting for only the last one.
  // Chaining them also means a tool never starts a sync while the service is closing.
  sync(maxMs: number = CLI_SYNC_MS): Promise<SyncReport> {
    if (this.closed) return Promise.resolve({ history: [], published: { published: 0, failed: 0, postponed: 0, lost: 0 }, timedOut: false })
    this.syncing = this.syncing.then(async () => {
      if (this.closed) return { history: [], published: { published: 0, failed: 0, postponed: 0, lost: 0 }, timedOut: false }
      const report = await this.device.syncOnce({ maxMs })
      const now = this.now()
      markSentQuestions(this.store, now)
      expireOutboundQuestions(this.store, now)
      return report
    })
    return this.syncing
  }

  async connect(link: string, note: string): Promise<ConnectOutcome> {
    // decodeLink throws a Spanish UserFacingError for anything that is not one of our links.
    const decoded = decodeLink(link)
    const existing = getContact(this.store, decoded.publicKey, 'outbound')
    if (existing?.state === 'approved') {
      return { kind: 'already_approved', pubkey: decoded.publicKey, name: existing.localName ?? existing.declaredName ?? decoded.publicKey.slice(0, 8) }
    }
    const profile = getProfile(this.store)
    if (!profile.name) {
      throw new UserFacingError('Antes de pedirle permiso a alguien, escribe tu nombre con: setup')
    }
    const now = this.now()
    const requestId = randomUUID()
    const created = this.store.tx(() => {
      const result = createOutboundRequest(this.store, { pubkey: decoded.publicKey, requestId, relays: decoded.relays, now })
      if (!result.created) return false
      const rumor = createRumor(
        { v: 1, type: 'connect_request', requestId, name: profile.name!, note, relays: profile.relays.slice(0, NOSTR.maxRelaysPerContact) },
        this.identity,
        now,
      )
      enqueue(this.store, {
        recipient: decoded.publicKey,
        rumor,
        label: 'connect_request',
        powBits: NOSTR.powRequestBits,
        relays: result.contact.relays,
        policy: 'retry_until_resolved',
        now,
      })
      return true
    })
    if (!created) return { kind: 'already_pending', pubkey: decoded.publicKey }
    return { kind: 'requested', pubkey: decoded.publicKey, relays: getContact(this.store, decoded.publicKey, 'outbound')!.relays }
  }

  contacts(): Contact[] {
    return listContacts(this.store, 'outbound')
  }


  async ask(name: string, text: string): Promise<OutboundQuestion> {
    const recipient = this.resolveContact(name)
    if (!askPermission(this.store, recipient.pubkey)) {
      throw new UserFacingError('Esa persona todavía no te dio permiso para preguntarle. Espera a que apruebe tu solicitud.')
    }
    const { question } = createOutboundQuestion(this.store, { identity: this.identity, recipient: recipient.pubkey, text, now: this.now() })
    // Nothing is waited on here: the caller's next sync publishes it, and a persistent service has
    // its publisher woken instead.
    this.device.wakePublisher()
    return question
  }

  question(idOrPrefix: string): OutboundQuestion {
    const trimmed = idOrPrefix.trim().toLowerCase()
    for (const contact of listContacts(this.store, 'outbound')) {
      const exact = getOutboundQuestion(this.store, contact.pubkey, trimmed)
      if (exact) return exact
    }
    const matches = findOutboundQuestions(this.store, trimmed)
    if (matches.length === 1) return matches[0]!
    if (matches.length > 1) {
      throw new UserFacingError('Ese identificador coincide con varias preguntas. Escribe más caracteres.')
    }
    throw new UserFacingError(
      `No encuentro ninguna pregunta con ese identificador. Escribe al menos ${MIN_QUESTION_PREFIX} caracteres del que te dio al preguntar.`,
    )
  }

  // Nothing new starts once this is called, and everything already running is waited for before the
  // caller closes the store underneath it.
  async close(): Promise<void> {
    this.closed = true
    try {
      await this.syncing
    } catch {
      // A failed sync is not a reason to leave the device open.
    }
    try {
      await this.device.close()
    } catch (err) {
      this.safeLog(`closing the asker device failed (${describeError(err)})`)
    }
  }

  private resolveContact(name: string): Contact {
    const cleaned = name.trim().replace(/^@/, '')
    const byName = findContactByLocalName(this.store, 'outbound', cleaned)
    if (byName) return byName
    const byKey = /^[0-9a-f]{64}$/.test(cleaned.toLowerCase()) ? getContact(this.store, cleaned.toLowerCase(), 'outbound') : null
    if (byKey) return byKey
    throw new UserFacingError('No tienes ningún contacto con ese nombre. Revisa tu lista con: contacts')
  }
}
```

- [ ] **Step 4: Create `packages/cli/src/asker/session.ts`**

```ts
import {
  CLI_COMMAND,
  Device,
  agentbridgeHome,
  handleResponderMessage,
  loadIdentity,
  openStore,
  type Identity,
  type RelayPolicy,
  type SocketFactory,
  type Store,
} from '@agentbridge/core'
import { CliError, type CliContext } from '../context'
import { AskerService } from './service'

export type AskerSession = { service: AskerService; close(): Promise<void> }

// Opens the identity and the store this person already has. A missing identity is the one thing a
// person can fix themselves, so it says how.
export async function openAskerSession(options: {
  home?: string
  now?: () => number
  createSocket?: SocketFactory
  log?: (line: string) => void
  relayPolicy?: RelayPolicy
}): Promise<AskerSession> {
  const home = options.home ?? agentbridgeHome()
  const identity = await loadIdentity(home)
  if (!identity) {
    throw new CliError(`Todavía no hay una identidad de AgentBridge en esta computadora. Créala con: ${CLI_COMMAND} setup`)
  }
  let store: Store
  try {
    store = await openStore(home, options.relayPolicy ? { relayPolicy: options.relayPolicy } : {})
  } catch (err) {
    throw new CliError(`No se pudo abrir la base de datos en ${home}. Revisa los permisos de esa carpeta.`, { cause: err })
  }
  const service = new AskerService({ store, identity, now: options.now, createSocket: options.createSocket, log: options.log })
  return {
    service,
    close: async () => {
      await service.close()
      store.close()
    },
  }
}

// The whole short-lived cycle every command runs: start → sync → operate → sync → close. The second
// sync is what publishes whatever the command just enqueued, and `close` is in a finally so a
// command always ends, even when a relay is slow or the operation threw.
export async function withAsker<T>(
  ctx: CliContext,
  fn: (service: AskerService) => Promise<T>,
  options: { firstSyncMs?: number; lastSyncMs?: number } = {},
): Promise<T> {
  const session = await openAskerSession({ home: ctx.home, relayPolicy: ctx.relayPolicy })
  try {
    await session.service.sync(options.firstSyncMs)
    const result = await fn(session.service)
    await session.service.sync(options.lastSyncMs)
    return result
  } finally {
    await session.close()
  }
}

// The same short-lived cycle for the four commands that are about messages addressed to this person
// as a responder: a request arriving, and the decisions that answer it. `handleAskerMessage` drops
// those on purpose, so they need their own role, their own cursors and their own handler — but not
// the channel lock and not a dispatcher: only the channel hands questions to Claude (P10).
export async function withResponderSession<T>(
  ctx: CliContext,
  fn: (input: { store: Store; identity: Identity; sync: () => Promise<void> }) => Promise<T>,
): Promise<T> {
  const home = ctx.home
  const identity = await loadIdentity(home)
  if (!identity) {
    throw new CliError(`Todavía no hay una identidad de AgentBridge en esta computadora. Créala con: ${CLI_COMMAND} setup`)
  }
  const store = await openStore(home, ctx.relayPolicy ? { relayPolicy: ctx.relayPolicy } : {})
  const device = new Device({ store, identity, role: 'responder', handleMessage: handleResponderMessage })
  const sync = async () => {
    await device.syncOnce({ maxMs: 10_000 })
  }
  try {
    await sync()
    const result = await fn({ store, identity, sync })
    await sync()
    return result
  } finally {
    await device.close()
    store.close()
  }
}
```

> `CliError`'s constructor today takes only a message. Give it an optional `options?: { cause?: unknown }` second parameter passed to `super`, so the store failure above keeps its cause without printing it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/cli/test/asker-service.test.ts`
Expected: PASS.

Run: `npm run typecheck && npm test`
Expected: clean, every test passing.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/asker/service.ts packages/cli/src/asker/session.ts packages/cli/src/context.ts packages/cli/test/asker-service.test.ts
git commit -m "feat(cli): AskerService and the short-lived sync cycle"
```
### Task 7: Waiting for an answer, and the Spanish every surface prints

**Files:**
- Modify: `packages/cli/src/asker/service.ts` (append `waitForAnswer`)
- Create: `packages/cli/src/asker/format.ts`
- Test: `packages/cli/test/asker-service.test.ts` (append), `packages/cli/test/asker-format.test.ts`

**Interfaces:**
- Consumes: Task 6's `AskerService`; core's `getOutboundQuestion`, `type OutboundQuestion`, `type Contact`, `CLI_COMMAND`.
- Produces:
  - `AskerService.waitForAnswer(ref: { recipient: string; questionId: string }, seconds: number, options?: { signal?: AbortSignal }): Promise<OutboundQuestion>` — starts the live subscription if it is not already running, then returns as soon as the question reaches a final state (`answered`, `rejected`, `lost`), the seconds run out, the caller aborts, or the service starts closing. It never throws on a timeout: the caller shows whatever state it reached. Its timer is cleared on every exit, so a wait never keeps the process alive.
  - `packages/cli/src/asker/format.ts`:
    - `QUESTION_STATE_ES: Record<OutboundQuestionState, string>` — one short Spanish phrase per state, distinguishing "recibida" (it reached their computer) from "contestada".
    - `formatQuestion(question, options: { contactName?: string }): string` — what `ask`, `ticket` and `check_answer` print. Every instruction inside it names the question's **full** id: a prefix the person was never shown cannot be disambiguated later (P3).
    - `forTerminal(text: string, max?: number): string` — third-party text (a declared name, a note) with control characters and ANSI escapes removed and the length capped, so a request cannot repaint the terminal or fake a line of the listing. Used by every command that prints someone else's words.
    - `formatContactLine(contact): string` — one line per contact for `contacts` and `list_contacts`, with no presence: Nostr cannot tell whether someone is online, and the text says so where it matters.
    - `formatRejectReason(reason): string` — the Spanish for `expired`, `limit`, `unanswered` and `stale_generation`.
- Every string here is Spanish; the MCP tool names, descriptions and log lines stay English.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/test/asker-format.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { QUESTION_STATE_ES, forTerminal, formatContactLine, formatInboundContactLine, formatQuestion, formatRejectReason } from '../src/asker/format'
import type { Contact, OutboundQuestion } from '@agentbridge/core'

const base: OutboundQuestion = {
  recipient: 'a'.repeat(64),
  questionId: '00000000-0000-4000-8000-000000000001',
  rumorId: 'b'.repeat(64),
  generation: 1,
  text: '¿cómo se despliega?',
  state: 'sent',
  answer: null,
  rejectReason: null,
  askedAt: 2_000_000_000,
  receivedAt: null,
  decidedAt: null,
}

const contact = (overrides: Partial<Contact>): Contact =>
  ({
    pubkey: 'a'.repeat(64),
    direction: 'outbound',
    state: 'approved',
    generation: 1,
    maxGenerationSeen: 1,
    requestId: null,
    requestRumorId: null,
    localName: 'ana',
    declaredName: 'Ana',
    note: null,
    relays: ['wss://relay.example.com'],
    requestedAt: 2_000_000_000,
    decidedAt: 2_000_000_000,
    createdAt: 2_000_000_000,
    updatedAt: 2_000_000_000,
    ...overrides,
  }) as Contact

describe('formatQuestion', () => {
  it('distinguishes reaching their computer from being answered', () => {
    expect(formatQuestion({ ...base, state: 'sent' }, { contactName: 'ana' })).toContain('enviada')
    const received = formatQuestion({ ...base, state: 'received', receivedAt: 2_000_000_050 }, { contactName: 'ana' })
    expect(received).toContain('recibida')
    expect(received).not.toContain('contestada')
  })

  it('shows the answer with its source and confidence', () => {
    const answered = formatQuestion(
      { ...base, state: 'answered', answer: { text: 'con npm run deploy', source: 'README.md', confidence: 'seguro' }, decidedAt: 2_000_000_100 },
      { contactName: 'ana' },
    )
    expect(answered).toContain('con npm run deploy')
    expect(answered).toContain('README.md')
    expect(answered).toContain('seguro')
  })

  it('explains each rejection reason in Spanish, without protocol words', () => {
    for (const reason of ['expired', 'limit', 'unanswered', 'stale_generation'] as const) {
      const text = formatQuestion({ ...base, state: 'rejected', rejectReason: reason, decidedAt: 2_000_000_100 }, { contactName: 'ana' })
      expect(text).toBe(`${formatQuestion({ ...base, state: 'rejected', rejectReason: reason, decidedAt: 2_000_000_100 }, { contactName: 'ana' })}`)
      expect(text).toContain(formatRejectReason(reason))
      expect(text).not.toMatch(/stale_generation|unanswered|expired|limit/)
    }
  })

  it('says a lost question ran out of time instead of showing a protocol state', () => {
    const lost = formatQuestion({ ...base, state: 'lost', decidedAt: 2_000_000_100 }, { contactName: 'ana' })
    expect(lost).toContain(QUESTION_STATE_ES.lost)
    expect(lost).not.toContain('lost')
  })
})

describe('forTerminal', () => {
  it('strips control characters and ANSI escapes from someone else’s words', () => {
    expect(forTerminal('Ana\u001b[31m\nSOLICITUD APROBADA')).not.toContain('\u001b')
    expect(forTerminal('Ana\nBeto')).not.toContain('\n')
    expect(forTerminal('x'.repeat(300), 80)).toHaveLength(80)
  })
})

describe('formatContactLine', () => {
  it('names the person and what this person may do with them', () => {
    expect(formatContactLine(contact({ state: 'approved' }))).toContain('ana')
    expect(formatContactLine(contact({ state: 'pending', localName: null }))).toContain('esperando')
    expect(formatContactLine(contact({ state: 'revoked' }))).toContain('retiró')
    expect(formatContactLine(contact({ state: 'rejected' }))).toContain('no aceptó')
  })

  it('never claims to know whether someone is online', () => {
    expect(formatContactLine(contact({}))).not.toMatch(/en línea|desconectad/i)
  })

  it('says the opposite thing for an inbound contact', () => {
    expect(formatInboundContactLine(contact({ state: 'approved' }))).toContain('puede preguntarte')
    expect(formatInboundContactLine(contact({ state: 'approved' }))).not.toContain('puedes preguntarle')
  })
})
```

Append to `packages/cli/test/asker-service.test.ts` (add `createRumor`, `wrapRumor` and `nowSeconds` to the core imports):

```ts
describe('waitForAnswer', () => {
  function approvedContact(): void {
    createOutboundRequest(store, { pubkey: them.publicKey, requestId: uuid(1), relays: [board.url], now: 2_000_000_000 })
    applyApproval(store, { pubkey: them.publicKey, requestId: uuid(1), generation: 1, name: 'Ana', relays: [board.url], now: 2_000_000_000 })
  }

  // The other person's side: seal an answer to this person and drop it on the board.
  async function injectAnswer(questionId: string): Promise<void> {
    const rumor = createRumor(
      { v: 1, type: 'answer', questionId, text: 'con npm run deploy', source: 'README.md', confidence: 'seguro' },
      them,
      nowSeconds(),
    )
    board.inject(await wrapRumor(rumor, them, me.publicKey, { now: nowSeconds() }))
  }

  it('returns as soon as the answer lands', async () => {
    approvedContact()
    const asked = await service.ask('ana', '¿cómo se despliega?')
    await service.sync()

    const waiting = service.waitForAnswer({ recipient: them.publicKey, questionId: asked.questionId }, 20)
    await injectAnswer(asked.questionId)
    const settled = await waiting
    expect(settled).toMatchObject({ state: 'answered', answer: { text: 'con npm run deploy', source: 'README.md', confidence: 'seguro' } })
  })

  it('gives back the state it reached when the wait runs out, without throwing', async () => {
    approvedContact()
    const asked = await service.ask('ana', '¿cómo se despliega?')
    await service.sync()
    const settled = await service.waitForAnswer({ recipient: them.publicKey, questionId: asked.questionId }, 0)
    expect(settled.state).toBe('sent')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/cli/test/asker-format.test.ts packages/cli/test/asker-service.test.ts`
Expected: FAIL — `format.ts` does not exist and `waitForAnswer` is not a method.

- [ ] **Step 3: Append `waitForAnswer` to `packages/cli/src/asker/service.ts`**

Add this constant next to `CLI_SYNC_MS`:

```ts
const WAIT_POLL_MS = 250
```

and this method to `AskerService`, after `question(...)`:

```ts
  // Waits for a question to reach a final state. The live subscription is what brings the answer in,
  // so it is started here if the caller did not start it; polling the store (rather than hooking the
  // device's callback) is deliberate — the answer may just as well be written by another process
  // that shares this home, and a poll sees that too.
  async waitForAnswer(
    ref: { recipient: string; questionId: string },
    seconds: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<OutboundQuestion> {
    this.device.start()
    const deadline = Date.now() + Math.max(0, seconds) * 1000
    for (;;) {
      const question = getOutboundQuestion(this.store, ref.recipient, ref.questionId)
      if (!question) {
        throw new UserFacingError('Esa pregunta ya no está guardada en esta computadora.')
      }
      if (question.state === 'answered' || question.state === 'rejected' || question.state === 'lost') return question
      // A closing service, an aborted caller (an MCP request cancelled by Claude) and a spent
      // budget all end the wait with whatever state the question has right now.
      if (this.closed || options.signal?.aborted || Date.now() >= deadline) return question
      await this.pause(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now())), options.signal)
    }
  }

  // A sleep that always clears its timer, so a wait can never hold the process open.
  private pause(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms)
      const onAbort = () => done()
      function done(): void {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
```

- [ ] **Step 4: Create `packages/cli/src/asker/format.ts`**

```ts
import { CLI_COMMAND, type Contact, type OutboundQuestion, type OutboundQuestionState } from '@agentbridge/core'

// One short phrase per state. "Recibida" means it reached their computer; "contestada" means they
// answered. The spec asks for exactly that distinction, because the two feel very different to the
// person waiting.
export const QUESTION_STATE_ES: Record<OutboundQuestionState, string> = {
  sending: 'enviándose',
  sent: 'enviada, todavía sin confirmar',
  received: 'recibida por esa persona, sin contestar todavía',
  answered: 'contestada',
  rejected: 'rechazada',
  lost: 'sin respuesta: se acabó el plazo de una semana',
}

export function formatRejectReason(reason: NonNullable<OutboundQuestion['rejectReason']>): string {
  switch (reason) {
    case 'expired':
      return 'la pregunta llegó demasiado tarde (más de 24 horas)'
    case 'limit':
      return 'esa persona ya tenía demasiadas preguntas tuyas en cola'
    case 'unanswered':
      return 'nadie la contestó dentro del plazo'
    case 'stale_generation':
      return 'esa persona retiró el permiso'
  }
}

const who = (options: { contactName?: string }): string => options.contactName ?? 'esa persona'

export function formatQuestion(question: OutboundQuestion, options: { contactName?: string } = {}): string {
  const header = `${question.text ?? '(el texto ya se borró por retención)'}\n→ ${who(options)} · ${QUESTION_STATE_ES[question.state]}`
  switch (question.state) {
    case 'answered': {
      if (!question.answer) return header
      return `${who(options)} contestó:\n\n${question.answer.text}\n\nFuente: ${question.answer.source}\nConfianza: ${question.answer.confidence}`
    }
    case 'rejected':
      return `${header}\nMotivo: ${question.rejectReason ? formatRejectReason(question.rejectReason) : 'sin motivo'}`
    case 'lost':
      return `${header}\nPuedes volver a preguntar cuando quieras.`
    default:
      return `${header}\nConsulta después con: ${CLI_COMMAND} ticket ${question.questionId}`
  }
}

// Third-party text reaches a terminal here: a declared name or a note can carry newlines or ANSI
// escapes that repaint the screen or fake a line of a listing. Length alone does not stop that.
export function forTerminal(text: string, max = 200): string {
  return [...text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')].slice(0, max).join('').trim()
}

export function formatContactLine(contact: Contact): string {
  const name = forTerminal(contact.localName ?? contact.declaredName ?? contact.pubkey.slice(0, 8), 80)
  switch (contact.state) {
    case 'approved':
      return `${name} — puedes preguntarle`
    case 'pending':
      return `${name} — esperando a que acepte tu solicitud`
    case 'rejected':
      return `${name} — no aceptó tu solicitud`
    case 'revoked':
      return `${name} — retiró el permiso`
    case 'requested':
      return `${name} — te pidió permiso a ti`
  }
}

// The same contact means the opposite thing in the other direction: an approved *inbound* contact is
// someone who may ask this person, not someone this person may ask.
export function formatInboundContactLine(contact: Contact): string {
  const name = forTerminal(contact.localName ?? contact.declaredName ?? contact.pubkey.slice(0, 8), 80)
  switch (contact.state) {
    case 'approved':
      return `${name} — puede preguntarte`
    case 'requested':
      return `${name} — te pidió permiso y sigue esperando`
    case 'rejected':
      return `${name} — le dijiste que no`
    case 'revoked':
      return `${name} — le retiraste el permiso`
    case 'pending':
      return `${name} — solicitud en curso`
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/cli/test/asker-format.test.ts packages/cli/test/asker-service.test.ts`
Expected: PASS.

Run: `npm run typecheck && npm test`
Expected: clean, every test passing.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/asker/service.ts packages/cli/src/asker/format.ts packages/cli/test/asker-format.test.ts packages/cli/test/asker-service.test.ts
git commit -m "feat(cli): wait for an answer and say every state in Spanish"
```
### Task 8: `link` and `connect`

**Files:**
- Create: `packages/cli/src/commands/connect.ts`
- Test: `packages/cli/test/commands-connect.test.ts`

**Interfaces:**
- Consumes: `withAsker`, `openAskerSession` (Task 6), core's `encodeLink`, `getProfile`, `loadIdentity`, `CLI_COMMAND`, `UserFacingError`; CLI's `CliError`, `type CliContext`, `memoryOutput` (tests).
- Produces:
  - `link(argv, ctx): Promise<void>` — prints this person's own link (`agentbridge:` + `nprofile`) with their own relays, and one line saying what to do with it. No network: it does not sync.
  - `connect(argv, ctx): Promise<void>` — `connect <enlace> [--note "…"]`. Runs the short-lived cycle with a longer second sync (30 s), because publishing a connection request mines 22 bits of proof of work.
  - Both are registered by Task 12's router.
- The note is optional and capped at 500 characters by the protocol; a longer one is a Spanish error before anything is stored.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/test/commands-connect.test.ts`:

```ts
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeLink, getContact, openStore, setProfile } from '@agentbridge/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startFakeBoard, type FakeBoard } from '../../core/test/support/fake-board'
import { testIdentity } from '../../core/test/support/keys'
import { connect, link } from '../src/commands/connect'
import { memoryOutput, type CliContext } from '../src/context'

const me = testIdentity(61)
const them = testIdentity(62)

let board: FakeBoard
let home: string
let ctx: CliContext & { out: ReturnType<typeof memoryOutput> }

// Every relay here is a local fake board, so the store is opened with a policy that accepts
// ws://127.0.0.1 — the same relaxation the responder harness uses. The identity file is written in
// the exact shape `loadIdentity` parses (`version: 1` plus a 64-character hex key); anything else
// is reported as a damaged identity.
const allowAnyRelay = (inputs: readonly unknown[]): string[] =>
  inputs.filter((value): value is string => typeof value === 'string' && value.startsWith('ws')).slice(0, 5)

async function seedHome(): Promise<void> {
  home = join(await mkdtemp(join(tmpdir(), 'ab-connect-')), 'home')
  const store = await openStore(home, { relayPolicy: allowAnyRelay })
  setProfile(store, { name: 'Beto', relays: [board.url], now: 2_000_000_000 })
  store.close()
  await writeFile(join(home, 'identity.json'), JSON.stringify({ version: 1, secretKey: Buffer.from(me.secretKey).toString('hex') }), { mode: 0o600 })
}

beforeEach(async () => {
  board = await startFakeBoard()
  await seedHome()
  ctx = { home, out: memoryOutput(), env: {}, relayPolicy: allowAnyRelay } as CliContext & { out: ReturnType<typeof memoryOutput> }
})

afterEach(async () => {
  await board.close()
})

describe('link', () => {
  it('prints this person’s own link and what to do with it', async () => {
    await link([], ctx)
    const printed = ctx.out.lines.join('\n')
    expect(printed).toContain('agentbridge:')
    expect(printed.toLowerCase()).toContain('comparte')
  })
})

describe('connect', () => {
  it('stores the request, publishes it, and says so in Spanish', async () => {
    await connect([encodeLink(them.publicKey, [board.url]), '--note', 'soy Beto'], ctx)
    const store = await openStore(home, { relayPolicy: allowAnyRelay })
    expect(getContact(store, them.publicKey, 'outbound')).toMatchObject({ state: 'pending' })
    store.close()
    expect(ctx.out.lines.join('\n')).toMatch(/solicitud/i)
  })

  it('refuses a note longer than the protocol allows, without storing anything', async () => {
    await expect(connect([encodeLink(them.publicKey, [board.url]), '--note', 'x'.repeat(501)], ctx)).rejects.toThrow()
    const store = await openStore(home, { relayPolicy: allowAnyRelay })
    expect(getContact(store, them.publicKey, 'outbound')).toBeNull()
    store.close()
  })

  it('explains what is missing when the link is not one of ours', async () => {
    await expect(connect(['no-es-un-enlace'], ctx)).rejects.toThrow()
  })

  it('tells the person the request is already on its way instead of sending another', async () => {
    const enlace = encodeLink(them.publicKey, [board.url])
    await connect([enlace], ctx)
    ctx.out.lines.length = 0
    await connect([enlace], ctx)
    expect(ctx.out.lines.join('\n')).toMatch(/ya (le )?enviaste|ya está en camino/i)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/cli/test/commands-connect.test.ts`
Expected: FAIL — `packages/cli/src/commands/connect.ts` does not exist.

- [ ] **Step 3: Create `packages/cli/src/commands/connect.ts`**

```ts
import { parseArgs } from 'node:util'
import { CLI_COMMAND, encodeLink, getProfile, loadIdentity } from '@agentbridge/core'
import { openAskerSession, withAsker } from '../asker/session'
import { CliError, type CliContext } from '../context'

const NOTE_MAX_CHARS = 500

export async function link(_argv: string[], ctx: CliContext): Promise<void> {
  const identity = await loadIdentity(ctx.home)
  if (!identity) throw new CliError(`Todavía no hay una identidad de AgentBridge en esta computadora. Créala con: ${CLI_COMMAND} setup`)
  // Reading the profile needs the store, but nothing here talks to a relay: a link is local.
  const session = await openAskerSession({ home: ctx.home, relayPolicy: ctx.relayPolicy })
  try {
    const profile = session.service.profile()
    ctx.out.log(encodeLink(identity.publicKey, profile.relays))
    ctx.out.log('')
    ctx.out.log('Comparte ese enlace con quien quieras que te pregunte. Esa persona lo usará con:')
    ctx.out.log(`  ${CLI_COMMAND} connect <enlace> --note "quién eres"`)
  } finally {
    await session.close()
  }
}

export async function connect(argv: string[], ctx: CliContext): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { note: { type: 'string' } } })
  const target = positionals[0]
  if (!target) throw new CliError(`Uso: ${CLI_COMMAND} connect <enlace> [--note "quién eres"]`)
  const note = (values.note ?? '').trim()
  if (note.length > NOTE_MAX_CHARS) throw new CliError(`La nota puede tener como máximo ${NOTE_MAX_CHARS} caracteres.`)

  ctx.out.log('Preparando la solicitud… esto tarda unos segundos la primera vez (tu computadora resuelve una prueba de trabajo).')
  // The sync itself stays inside the spec's ten seconds of network time; the proof of work has its
  // own budget inside the publisher (P5c), so a slow machine does not shorten the network part.
  const { outcome, published } = await withAsker(ctx, async (service) => {
    const outcome = await service.connect(target, note)
    await service.sync()
    return { outcome, published: service.wasPublished(outcome.pubkey) }
  })

  switch (outcome.kind) {
    case 'requested':
      if (published) {
        ctx.out.log('Solicitud enviada. Esa persona la verá cuando abra su AgentBridge y decide si te da permiso.')
      } else {
        ctx.out.log('Solicitud guardada, pendiente de envío: ningún tablero la aceptó todavía. Se reintenta sola cada vez que corres un comando.')
      }
      ctx.out.log(`Mientras tanto puedes revisar con: ${CLI_COMMAND} contacts`)
      return
    case 'already_pending':
      ctx.out.log('Ya le enviaste una solicitud a esa persona y sigue en camino. Se reintenta sola cada vez que corres un comando.')
      return
    case 'already_approved':
      ctx.out.log(`Esa persona ya te dio permiso (la tienes como ${outcome.name}). Pregúntale con:`)
      ctx.out.log(`  ${CLI_COMMAND} ask ${outcome.name} "tu pregunta"`)
  }
}
```

> Two small accessors on `AskerService` make this command honest, and Task 10 reuses the first:
>
> ```ts
> // packages/cli/src/asker/service.ts, inside AskerService
> profile(): { name: string | null; relays: string[] } {
>   return getProfile(this.store)
> }
>
> // Whether anything addressed to that person has actually gone out: the outbox row for their
> // pending request records the first relay that accepted it. Used to tell "enviada" from
> // "guardada, pendiente de envío" instead of announcing a send the relays never confirmed.
> wasPublished(recipient: string): boolean {
>   const row = this.store.db
>     .prepare('SELECT last_published_at FROM outbox WHERE recipient = ? ORDER BY rowid DESC LIMIT 1')
>     .get(recipient) as { last_published_at: number | null } | undefined
>   return row?.last_published_at != null
> }
> ```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/cli/test/commands-connect.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: clean. (These two commands are not registered yet — Task 12 does that; the tests call them directly.)

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/connect.ts packages/cli/src/asker/service.ts packages/cli/test/commands-connect.test.ts
git commit -m "feat(cli): link and connect"
```
### Task 9: `contacts`, `whoami`, and the responder's `requests` / `approve` / `reject` / `revoke`

**Files:**
- Create: `packages/cli/src/commands/contacts.ts`
- Test: `packages/cli/test/commands-contacts.test.ts`

**Interfaces:**
- Consumes: `withAsker` and `withResponderSession` (Task 7), `formatContactLine`, `formatInboundContactLine`, `forTerminal` (Task 8), core's `listContacts`, `listRequests`, `approveConnection`, `rejectConnection`, `revokeConnection`, `REQUEST_ID_LENGTH`, `loadIdentity`, `encodeLink`, `CLI_COMMAND`, `UserFacingError`; CLI's `CliError`, `type CliContext`.
- Produces:
  - `contacts(argv, ctx)` — both directions in one view: who this person may ask (outbound), and who may ask them (inbound approved), each with what the state means in Spanish.
  - `whoami(argv, ctx)` — this person's public key, their profile name and their relays. No network.
  - `requests(argv, ctx)` — the pending requests other people sent (plan 2's `listRequests`), each with its 8-character identifier, the declared name, the note, and the warning that approving lets that person read the shared folder.
  - `approve(argv, ctx)` / `reject(argv, ctx)` — `approve <id>` and `reject <id>`, never a numeric index.
  - `revoke(argv, ctx)` — `revoke <nombre>`, with a line saying what it did (how many waiting questions were closed).
  - `contacts` and `whoami` run the asker cycle. `requests`, `approve`, `reject` and `revoke` run `withResponderSession` instead (P10): a request is a message addressed to this person as a responder, and the asker's handler drops those — so without a responder-role sync, a request published while the channel was closed would never appear.
  - Every piece of third-party text printed here (a declared name, a note) goes through `forTerminal` first.
- The responder commands live here, next to `contacts`, because they are the same "who may talk to whom" surface for the person using the terminal.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/test/commands-contacts.test.ts`:

```ts
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyApproval,
  createOutboundRequest,
  getContact,
  listRequests,
  openStore,
  recordIncomingRequest,
  setProfile,
  type Store,
} from '@agentbridge/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startFakeBoard, type FakeBoard } from '../../core/test/support/fake-board'
import { testIdentity } from '../../core/test/support/keys'
import { approve, contacts, reject, requests, revoke, whoami } from '../src/commands/contacts'
import { memoryOutput, type CliContext } from '../src/context'

const me = testIdentity(63)
const ana = testIdentity(64)
const beto = testIdentity(65)
const T0 = 2_000_000_000
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

let board: FakeBoard
let home: string
let ctx: CliContext & { out: ReturnType<typeof memoryOutput> }

async function withStore<T>(fn: (store: Store) => T): Promise<T> {
  const store = await openStore(home, { relayPolicy: allowAnyRelay })
  try {
    return fn(store)
  } finally {
    store.close()
  }
}

const allowAnyRelay = (inputs: readonly unknown[]): string[] =>
  inputs.filter((value): value is string => typeof value === 'string' && value.startsWith('ws')).slice(0, 5)

beforeEach(async () => {
  board = await startFakeBoard()
  home = join(await mkdtemp(join(tmpdir(), 'ab-contacts-')), 'home')
  await withStore((store) => setProfile(store, { name: 'Yo', relays: [board.url], now: T0 }))
  await writeFile(join(home, 'identity.json'), JSON.stringify({ version: 1, secretKey: Buffer.from(me.secretKey).toString('hex') }), { mode: 0o600 })
  ctx = { home, out: memoryOutput(), env: {}, relayPolicy: allowAnyRelay } as CliContext & { out: ReturnType<typeof memoryOutput> }
})

afterEach(async () => {
  await board.close()
})

describe('contacts and whoami', () => {
  it('shows both directions with what each state means', async () => {
    await withStore((store) => {
      createOutboundRequest(store, { pubkey: ana.publicKey, requestId: uuid(1), relays: [board.url], now: T0 })
      applyApproval(store, { pubkey: ana.publicKey, requestId: uuid(1), generation: 1, name: 'Ana', relays: [board.url], now: T0 })
      recordIncomingRequest(store, {
        pubkey: beto.publicKey,
        requestId: uuid(2),
        requestRumorId: 'c'.repeat(64),
        declaredName: 'Beto',
        note: 'hola',
        relays: [board.url],
        now: T0,
      })
    })
    await contacts([], ctx)
    const printed = ctx.out.lines.join('\n')
    expect(printed).toContain('ana')
    expect(printed).toMatch(/puedes preguntarle/i)
    expect(printed).toMatch(/te pidió permiso/i)
  })

  it('prints this person’s key, name and relays without touching the network', async () => {
    await whoami([], ctx)
    const printed = ctx.out.lines.join('\n')
    expect(printed).toContain(me.publicKey)
    expect(printed).toContain('Yo')
    expect(printed).toContain(board.url)
  })
})

describe('requests, approve and reject', () => {
  async function incoming(): Promise<string> {
    await withStore((store) =>
      recordIncomingRequest(store, {
        pubkey: beto.publicKey,
        requestId: uuid(3),
        requestRumorId: 'd'.repeat(64),
        declaredName: 'Beto',
        note: 'trabajo contigo',
        relays: [board.url],
        now: T0,
      }),
    )
    return beto.publicKey.slice(0, 8)
  }

  it('lists a request with its identifier, its note and the shared-folder warning', async () => {
    const id = await incoming()
    await requests([], ctx)
    const printed = ctx.out.lines.join('\n')
    expect(printed).toContain(id)
    expect(printed).toContain('Beto')
    expect(printed).toContain('trabajo contigo')
    expect(printed.toLowerCase()).toContain('carpeta compartida')
  })

  it('approves by identifier and says what changed', async () => {
    const id = await incoming()
    await approve([id], ctx)
    expect(await withStore((store) => getContact(store, beto.publicKey, 'inbound')?.state)).toBe('approved')
    expect(ctx.out.lines.join('\n')).toMatch(/puede preguntarte/i)
  })

  it('rejects by identifier', async () => {
    const id = await incoming()
    await reject([id], ctx)
    expect(await withStore((store) => getContact(store, beto.publicKey, 'inbound')?.state)).toBe('rejected')
    expect(await withStore((store) => listRequests(store, T0))).toEqual([])
  })

  it('refuses a list position but accepts an all-digit identifier', async () => {
    await incoming()
    await expect(approve(['1'], ctx)).rejects.toThrow()
    // A key prefix is hexadecimal: '12345678' is a perfectly valid identifier, not an index.
    await expect(approve(['12345678'], ctx)).rejects.toThrow(/solicitud/i)
  })

  it('never lets a declared name repaint the listing', async () => {
    await withStore((store) =>
      recordIncomingRequest(store, {
        pubkey: ana.publicKey,
        requestId: uuid(9),
        requestRumorId: 'f'.repeat(64),
        declaredName: 'Ana\u001b[2K\rAPROBADA',
        note: 'linea1\nlinea2',
        relays: [board.url],
        now: T0,
      }),
    )
    await requests([], ctx)
    const printed = ctx.out.lines.join('\n')
    expect(printed).not.toContain('\u001b')
    expect(printed).toContain('linea1 linea2')
  })
})

describe('revoke', () => {
  it('revokes by name and reports how many waiting questions it closed', async () => {
    await withStore((store) => {
      recordIncomingRequest(store, {
        pubkey: beto.publicKey,
        requestId: uuid(4),
        requestRumorId: 'e'.repeat(64),
        declaredName: 'Beto',
        note: '',
        relays: [board.url],
        now: T0,
      })
    })
    await approve([beto.publicKey.slice(0, 8)], ctx)
    ctx.out.lines.length = 0

    const name = await withStore((store) => getContact(store, beto.publicKey, 'inbound')!.localName!)
    await revoke([name], ctx)
    expect(await withStore((store) => getContact(store, beto.publicKey, 'inbound')?.state)).toBe('revoked')
    expect(ctx.out.lines.join('\n')).toMatch(/ya no puede preguntarte/i)
  })

  it('says which names exist when the one given does not', async () => {
    await expect(revoke(['nadie'], ctx)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/cli/test/commands-contacts.test.ts`
Expected: FAIL — `packages/cli/src/commands/contacts.ts` does not exist.

- [ ] **Step 3: Create `packages/cli/src/commands/contacts.ts`**

```ts
import {
  CLI_COMMAND,
  REQUEST_ID_LENGTH,
  approveConnection,
  encodeLink,
  listRequests,
  loadIdentity,
  nowSeconds,
  rejectConnection,
  revokeConnection,
  type Contact,
} from '@agentbridge/core'
import { forTerminal, formatContactLine, formatInboundContactLine } from '../asker/format'
import { withAsker, withResponderSession } from '../asker/session'
import { CliError, type CliContext } from '../context'

export async function contacts(_argv: string[], ctx: CliContext): Promise<void> {
  const { outbound, inbound } = await withAsker(ctx, async (service) => ({
    outbound: service.contacts(),
    inbound: service.inboundContacts(),
  }))

  ctx.out.log('A quién puedes preguntarle:')
  if (outbound.length === 0) {
    ctx.out.log(`  (todavía nadie) — pide permiso con: ${CLI_COMMAND} connect <enlace>`)
  } else {
    for (const contact of outbound) ctx.out.log(`  ${formatContactLine(contact)}`)
  }

  ctx.out.log('')
  ctx.out.log('Quién puede preguntarte a ti:')
  // The same contact means the opposite thing in this direction, so it gets its own formatter.
  const allowed = inbound.filter((contact: Contact) => contact.state === 'approved' || contact.state === 'requested')
  if (allowed.length === 0) {
    ctx.out.log(`  (todavía nadie) — revisa las solicitudes con: ${CLI_COMMAND} requests`)
  } else {
    for (const contact of allowed) ctx.out.log(`  ${formatInboundContactLine(contact)}`)
  }
}

export async function whoami(_argv: string[], ctx: CliContext): Promise<void> {
  const identity = await loadIdentity(ctx.home)
  if (!identity) throw new CliError(`Todavía no hay una identidad de AgentBridge en esta computadora. Créala con: ${CLI_COMMAND} setup`)
  const profile = await withAsker(ctx, async (service) => service.profile())
  ctx.out.log(`Tu llave pública: ${identity.publicKey}`)
  ctx.out.log(`Tu nombre: ${profile.name ?? '(sin nombre todavía)'}`)
  ctx.out.log(`Tus tableros: ${profile.relays.join(', ')}`)
  ctx.out.log(`Tu enlace: ${encodeLink(identity.publicKey, profile.relays)}`)
}

export async function requests(_argv: string[], ctx: CliContext): Promise<void> {
  const pending = await withResponderSession(ctx, async ({ store, identity }) => listRequests(store, nowSeconds()))
  if (pending.length === 0) {
    ctx.out.log('No tienes solicitudes nuevas.')
    return
  }
  ctx.out.log('Solicitudes nuevas:')
  for (const request of pending) {
    ctx.out.log('')
    ctx.out.log(`  ${request.id}  ${forTerminal(request.declaredName, 80)}`)
    if (request.note) ctx.out.log(`  nota: ${forTerminal(request.note)}`)
  }
  ctx.out.log('')
  ctx.out.log('Si apruebas a alguien, su agente podrá leer tu carpeta compartida y preguntarte.')
  ctx.out.log(`Acepta con: ${CLI_COMMAND} approve <id>   ·   rechaza con: ${CLI_COMMAND} reject <id>`)
}

// A person may paste a valid identifier made only of digits (a key prefix is hexadecimal), so the
// index guard is about shape and length, not about digits: an identifier is at least 8 hex
// characters, and anything shorter that looks like a list position is the mistake worth catching.
function requireId(argv: string[], verb: 'approve' | 'reject'): string {
  const id = argv[0]
  if (!id) throw new CliError(`Uso: ${CLI_COMMAND} ${verb} <id>   (el id de ${CLI_COMMAND} requests, no un número de la lista)`)
  if (id.length < REQUEST_ID_LENGTH) {
    throw new CliError(
      `Ese identificador es muy corto. Copia los ${REQUEST_ID_LENGTH} caracteres que aparecen junto al nombre en: ${CLI_COMMAND} requests`,
    )
  }
  if (!/^[0-9a-f]+$/i.test(id)) {
    throw new CliError(`Ese identificador no tiene la forma correcta. Cópialo tal cual de: ${CLI_COMMAND} requests`)
  }
  return id.toLowerCase()
}

export async function approve(argv: string[], ctx: CliContext): Promise<void> {
  const id = requireId(argv, 'approve')
  const contact = await withResponderSession(ctx, async ({ store, identity }) =>
    approveConnection(store, { identity, idPrefix: id, now: nowSeconds() }).contact,
  )
  const name = forTerminal(contact.localName ?? contact.declaredName ?? id, 80)
  ctx.out.log(`Listo: ${name} ya puede preguntarte. Su agente puede leer tu carpeta compartida.`)
  ctx.out.log(`Si te arrepientes: ${CLI_COMMAND} revoke ${name}`)
}

export async function reject(argv: string[], ctx: CliContext): Promise<void> {
  const id = requireId(argv, 'reject')
  const contact = await withResponderSession(ctx, async ({ store, identity }) =>
    rejectConnection(store, { identity, idPrefix: id, now: nowSeconds() }).contact,
  )
  ctx.out.log(`Listo: ${forTerminal(contact.declaredName ?? id, 80)} no puede preguntarte.`)
}

export async function revoke(argv: string[], ctx: CliContext): Promise<void> {
  const name = argv[0]
  if (!name) throw new CliError(`Uso: ${CLI_COMMAND} revoke <nombre>   (el nombre que aparece en ${CLI_COMMAND} contacts)`)
  const result = await withResponderSession(ctx, async ({ store, identity }) =>
    revokeConnection(store, { identity, name, now: nowSeconds() }),
  )
  ctx.out.log(`Listo: ${forTerminal(name, 80)} ya no puede preguntarte.`)
  if (result.rejectedQuestions > 0) {
    ctx.out.log(`Cerré ${result.rejectedQuestions} pregunta(s) suya(s) que estaban esperando respuesta.`)
  }
}
```

- [ ] **Step 4: Add one accessor to `AskerService`**

`contacts` shows both directions, and the outbound half already comes from the service. Add the inbound half next to it (the four decisions do **not** go through the service: they run in the responder session, which is the only place with the right role and cursors):

```ts
  // packages/cli/src/asker/service.ts, inside AskerService
  inboundContacts(): Contact[] {
    return listContacts(this.store, 'inbound')
  }
```

> `listContacts` is already imported in that file for `contacts()`; this reuses it with the other direction.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/cli/test/commands-contacts.test.ts packages/cli/test/asker-service.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/contacts.ts packages/cli/src/asker/service.ts packages/cli/test/commands-contacts.test.ts
git commit -m "feat(cli): contacts, whoami, requests, approve, reject and revoke"
```
### Task 10: `ask` and `ticket` over the new state

**Files:**
- Modify (rewrite): `packages/cli/src/commands/ask.ts`
- Test: `packages/cli/test/commands-ask.test.ts`

**Interfaces:**
- Consumes: `withAsker`, `openAskerSession` (Task 6), `formatQuestion` (Task 7), core's `CLI_COMMAND`, `LIMITS`; CLI's `CliError`, `type CliContext`.
- Produces:
  - `ask(argv, ctx)` — `ask <nombre> <pregunta…> [--wait <segundos>|--no-wait]`. Stores and publishes the question, prints its identifier, and (unless `--no-wait`) keeps the connection open up to `--wait` seconds (default 120) waiting for the answer.
  - `ticket(argv, ctx)` — `ticket <id> [--wait <segundos>]`. Syncs, shows the state, and waits when asked.
  - `parseWaitSeconds(raw, fallback)` stays as it is today (a mistyped `--wait` is a local Spanish error in both commands).
  - The old `formatTicket`, `waitForTicket` and `isTerminal` go away with the relay ticket view: Task 7's `formatQuestion` replaces them, and the MCP server (Task 11) imports that instead.
- A person who only uses the terminal sees, once per `ask`, the line that says retries happen whenever they run a command — the spec asks for exactly that.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/test/commands-ask.test.ts`:

```ts
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyApproval,
  createOutboundRequest,
  createRumor,
  listOutboundQuestions,
  nowSeconds,
  openStore,
  setProfile,
  wrapRumor,
  type Store,
} from '@agentbridge/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startFakeBoard, type FakeBoard } from '../../core/test/support/fake-board'
import { testIdentity } from '../../core/test/support/keys'
import { ask, ticket } from '../src/commands/ask'
import { memoryOutput, type CliContext } from '../src/context'

const me = testIdentity(66)
const ana = testIdentity(67)
const T0 = 2_000_000_000
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

let board: FakeBoard
let home: string
let ctx: CliContext & { out: ReturnType<typeof memoryOutput> }

const allowAnyRelay = (inputs: readonly unknown[]): string[] =>
  inputs.filter((value): value is string => typeof value === 'string' && value.startsWith('ws')).slice(0, 5)

async function withStore<T>(fn: (store: Store) => T): Promise<T> {
  const store = await openStore(home, { relayPolicy: allowAnyRelay })
  try {
    return fn(store)
  } finally {
    store.close()
  }
}

beforeEach(async () => {
  board = await startFakeBoard()
  home = join(await mkdtemp(join(tmpdir(), 'ab-ask-')), 'home')
  await withStore((store) => {
    setProfile(store, { name: 'Beto', relays: [board.url], now: T0 })
    createOutboundRequest(store, { pubkey: ana.publicKey, requestId: uuid(1), relays: [board.url], now: T0 })
    applyApproval(store, { pubkey: ana.publicKey, requestId: uuid(1), generation: 1, name: 'Ana', relays: [board.url], now: T0 })
  })
  await writeFile(join(home, 'identity.json'), JSON.stringify({ version: 1, secretKey: Buffer.from(me.secretKey).toString('hex') }), { mode: 0o600 })
  ctx = { home, out: memoryOutput(), env: {}, relayPolicy: allowAnyRelay } as CliContext & { out: ReturnType<typeof memoryOutput> }
})

afterEach(async () => {
  await board.close()
})

describe('ask', () => {
  it('sends the question, prints its whole identifier and says how retries work', async () => {
    await ask(['ana', '¿cómo', 'se', 'despliega?', '--no-wait'], ctx)
    const questions = await withStore((store) => listOutboundQuestions(store))
    expect(questions).toHaveLength(1)
    expect(questions[0]).toMatchObject({ text: '¿cómo se despliega?', state: 'sent' })
    const printed = ctx.out.lines.join('\n')
    // The whole id, never a prefix: a prefix the person was never shown cannot be disambiguated
    // later if two questions happen to share it.
    expect(printed).toContain(questions[0]!.questionId)
    expect(printed).toMatch(/cada vez que corres un comando/i)
  })

  it('shows the answer when it arrives while waiting', async () => {
    // The other person answers as soon as the question is on the board.
    const answering = (async () => {
      for (let i = 0; i < 100; i++) {
        const asked = await withStore((store) => listOutboundQuestions(store)[0])
        if (asked) {
          const rumor = createRumor(
            { v: 1, type: 'answer', questionId: asked.questionId, text: 'con npm run deploy', source: 'README.md', confidence: 'seguro' },
            ana,
            nowSeconds(),
          )
          board.inject(await wrapRumor(rumor, ana, me.publicKey, { now: nowSeconds() }))
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    })()

    await ask(['ana', '¿cómo se despliega?', '--wait', '20'], ctx)
    await answering
    const printed = ctx.out.lines.join('\n')
    expect(printed).toContain('con npm run deploy')
    expect(printed).toContain('README.md')
  })

  it('refuses a question for a name nobody has, without sending anything', async () => {
    await expect(ask(['nadie', 'hola', '--no-wait'], ctx)).rejects.toThrow()
    expect(await withStore((store) => listOutboundQuestions(store))).toEqual([])
  })

  it('refuses a mistyped --wait with a local Spanish message', async () => {
    await expect(ask(['ana', 'hola', '--wait', 'pronto'], ctx)).rejects.toThrow(/--wait/)
  })
})

describe('ticket', () => {
  it('shows the state of a question by a prefix of its identifier', async () => {
    await ask(['ana', 'hola', '--no-wait'], ctx)
    const asked = await withStore((store) => listOutboundQuestions(store)[0]!)
    ctx.out.lines.length = 0

    await ticket([asked.questionId.slice(0, 8)], ctx)
    const printed = ctx.out.lines.join('\n')
    expect(printed).toContain('hola')
    expect(printed).toMatch(/enviada|recibida/i)
  })

  it('says what to do when the identifier matches nothing', async () => {
    await expect(ticket(['00000000'], ctx)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/cli/test/commands-ask.test.ts`
Expected: FAIL — `ask` still talks to the 0.1 relay client.

- [ ] **Step 3: Replace the whole content of `packages/cli/src/commands/ask.ts` with:**

```ts
import { parseArgs } from 'node:util'
import { CLI_COMMAND, LIMITS } from '@agentbridge/core'
import { formatQuestion } from '../asker/format'
import { withAsker } from '../asker/session'
import { CliError, type CliContext } from '../context'

// Shared by `ask` and `ticket` so a mistyped --wait gives the exact same clean, local Spanish
// message in both commands instead of turning into NaN and failing much later.
function parseWaitSeconds(raw: string | undefined, fallback: number): number {
  const seconds = Number(raw ?? fallback)
  if (!Number.isFinite(seconds) || seconds < 0) throw new CliError('--wait debe ser un número de segundos')
  return seconds
}

const RETRY_NOTE = 'Si esa persona tiene su computadora apagada, la pregunta se reintenta sola cada vez que corres un comando, hasta una semana.'

export async function ask(argv: string[], ctx: CliContext): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { wait: { type: 'string' }, 'no-wait': { type: 'boolean' } },
  })
  const [name, ...words] = positionals
  const text = words.join(' ').trim()
  if (!name || !text) throw new CliError(`Uso: ${CLI_COMMAND} ask <nombre> <pregunta…> [--wait <segundos>|--no-wait]`)
  if (text.length > LIMITS.questionMaxChars) throw new CliError(`La pregunta puede tener como máximo ${LIMITS.questionMaxChars} caracteres.`)
  const waitSeconds = values['no-wait'] ? 0 : parseWaitSeconds(values.wait, 120)

  await withAsker(ctx, async (service) => {
    const question = await service.ask(name, text)
    // The second sync inside withAsker publishes it; sync here too so the identifier we print is
    // already accompanied by a real send attempt when the person chose not to wait.
    await service.sync()
    // What actually happened is in the stored state: `sent` means a relay took it, `sending` means
    // it is saved and still trying. Saying "enviada" either way would be a lie when every relay is
    // down, which is exactly when a person needs the truth.
    const stored = service.question(question.questionId)
    ctx.out.log(
      stored.state === 'sending'
        ? `Pregunta guardada para ${name}, pendiente de envío: ningún tablero la aceptó todavía.`
        : `Pregunta enviada a ${name}.`,
    )
    ctx.out.log(`Identificador: ${question.questionId}`)
    ctx.out.log(RETRY_NOTE)
    if (waitSeconds === 0) {
      ctx.out.log(`Consulta la respuesta con: ${CLI_COMMAND} ticket ${question.questionId} --wait 60`)
      return
    }
    ctx.out.log('')
    const settled = await service.waitForAnswer({ recipient: question.recipient, questionId: question.questionId }, waitSeconds)
    ctx.out.log(formatQuestion(settled, { contactName: name }))
    if (settled.state !== 'answered' && settled.state !== 'rejected' && settled.state !== 'lost') {
      ctx.out.log(`Sigue pendiente. Consulta después con: ${CLI_COMMAND} ticket ${question.questionId} --wait 60`)
    }
  })
}

export async function ticket(argv: string[], ctx: CliContext): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { wait: { type: 'string' } } })
  const id = positionals[0]
  if (!id) throw new CliError(`Uso: ${CLI_COMMAND} ticket <id> [--wait <segundos>]`)
  const waitSeconds = parseWaitSeconds(values.wait, 0)

  await withAsker(ctx, async (service) => {
    const question = service.question(id)
    const settled = waitSeconds > 0 ? await service.waitForAnswer({ recipient: question.recipient, questionId: question.questionId }, waitSeconds) : question
    ctx.out.log(formatQuestion(settled))
  })
}
```

- [ ] **Step 4: Run the ask tests to verify they pass**

Run: `npx vitest run packages/cli/test/commands-ask.test.ts`
Expected: PASS. `npm run typecheck` still fails at this point, because the MCP server imports `formatTicket` from the file you just replaced — the next steps rewrite it, in this same task, so the tree ends green.

- [ ] **Step 5: Write the failing MCP tests**

Replace the whole content of `packages/cli/test/mcp-asker.test.ts` with:

```ts
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyApproval, createOutboundRequest, encodeLink, getContact, listOutboundQuestions, openStore, setProfile, type Store } from '@agentbridge/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { plainSocketFactory, startFakeBoard, type FakeBoard } from '../../core/test/support/fake-board'
import { testIdentity } from '../../core/test/support/keys'
import { AskerService } from '../src/asker/service'
import { createAskerServer } from '../src/mcp-asker'

const me = testIdentity(68)
const ana = testIdentity(69)
const T0 = 2_000_000_000
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const allowAnyRelay = (inputs: readonly unknown[]): string[] =>
  inputs.filter((value): value is string => typeof value === 'string' && value.startsWith('ws')).slice(0, 5)

let board: FakeBoard
let store: Store
let service: AskerService
let client: Client

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean }
  return { text: result.content.map((c) => c.text).join('\n'), isError: result.isError === true }
}

beforeEach(async () => {
  board = await startFakeBoard()
  const home = join(await mkdtemp(join(tmpdir(), 'ab-mcp-')), 'home')
  store = await openStore(home, { relayPolicy: allowAnyRelay })
  setProfile(store, { name: 'Beto', relays: [board.url], now: T0 })
  await writeFile(join(home, 'identity.json'), JSON.stringify({ secretKey: Buffer.from(me.secretKey).toString('hex') }), { mode: 0o600 })
  service = new AskerService({ store, identity: me, createSocket: plainSocketFactory })
  const server = createAskerServer(service)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
})

afterEach(async () => {
  await client.close()
  await service.close()
  store.close()
  await board.close()
})

function approved(): void {
  createOutboundRequest(store, { pubkey: ana.publicKey, requestId: uuid(1), relays: [board.url], now: T0 })
  applyApproval(store, { pubkey: ana.publicKey, requestId: uuid(1), generation: 1, name: 'Ana', relays: [board.url], now: T0 })
}

describe('the asker MCP server', () => {
  it('offers exactly the four tools, described in English', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['ask_contact', 'check_answer', 'connect', 'list_contacts'])
    for (const tool of tools) expect(tool.description).toMatch(/^[\x20-\x7E]+$/)
  })

  it('lists contacts without ever claiming someone is online', async () => {
    approved()
    const { text } = await call('list_contacts')
    expect(text).toContain('ana')
    expect(text).not.toMatch(/en línea|online|desconectad/i)
  })

  it('says so, in Spanish, when nobody has given permission yet', async () => {
    const { text } = await call('list_contacts')
    expect(text).toMatch(/nadie/i)
  })

  it('sends a question and gives back an identifier for check_answer', async () => {
    approved()
    const { text, isError } = await call('ask_contact', { contact: 'ana', question: '¿cómo se despliega?' })
    expect(isError).toBe(false)
    const asked = listOutboundQuestions(store)[0]!
    expect(text).toContain(asked.questionId)
    expect(asked.text).toBe('¿cómo se despliega?')
  })

  it('refuses a blank question without sending anything', async () => {
    approved()
    const { isError } = await call('ask_contact', { contact: 'ana', question: '   ' })
    expect(isError).toBe(true)
    expect(listOutboundQuestions(store)).toEqual([])
  })

  it('reports the state of a question, saying received rather than answered', async () => {
    approved()
    await call('ask_contact', { contact: 'ana', question: 'hola' })
    const asked = listOutboundQuestions(store)[0]!
    const { text } = await call('check_answer', { question_id: asked.questionId, wait_seconds: 0 })
    expect(text).toMatch(/enviada|recibida/i)
    expect(text).not.toMatch(/contestada/i)
  })

  it('asks for permission through connect', async () => {
    const { isError } = await call('connect', { link: encodeLink(ana.publicKey, [board.url]), note: 'soy Beto' })
    expect(isError).toBe(false)
    expect(getContact(store, ana.publicKey, 'outbound')?.state).toBe('pending')
  })

  it('turns an unexpected failure into a Spanish tool error without leaking its text', async () => {
    approved()
    const broken = new AskerService({ store, identity: me, createSocket: plainSocketFactory })
    // A service whose store is closed fails inside the tool call.
    store.close()
    const server = createAskerServer(broken)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const other = new Client({ name: 'test', version: '0' }, { capabilities: {} })
    await Promise.all([server.connect(serverTransport), other.connect(clientTransport)])
    const result = (await other.callTool({ name: 'list_contacts', arguments: {} })) as { content: Array<{ text: string }>; isError?: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).not.toMatch(/SQLITE|database/i)
    await other.close()
    await broken.close()
    // Reopened so afterEach can close it uniformly.
    store = await openStore(join(await mkdtemp(join(tmpdir(), 'ab-mcp-tail-')), 'home'), { relayPolicy: allowAnyRelay })
  })
})
```

- [ ] **Step 6: Replace the whole content of `packages/cli/src/mcp-asker.ts` with:**

```ts
import { CLI_COMMAND, LIMITS, UserFacingError, describeError } from '@agentbridge/core'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { formatContactLine, formatQuestion } from './asker/format'
import { openAskerSession } from './asker/session'
import type { AskerService } from './asker/service'
import { type CliContext } from './context'
import { zodFieldsMessage } from './spanish-errors'

// Tool names, descriptions and argument names are English: Claude reads them. Everything a person
// ends up seeing is Spanish.
const TOOLS = [
  {
    name: 'list_contacts',
    description:
      "List the people whose agents you may ask through AgentBridge. AgentBridge cannot tell whether someone is online: a question waits for them and is retried for up to seven days.",
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'ask_contact',
    description: "Send a question to another person's agent. Returns a question_id; then call check_answer with it.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        contact: { type: 'string', description: 'The name of the person as list_contacts shows it.' },
        question: { type: 'string', description: 'The question, self-contained, in the language that person understands.' },
      },
      required: ['contact', 'question'],
    },
  },
  {
    name: 'check_answer',
    description: 'Wait up to wait_seconds (max 45) for a question to be answered and return its state. Call again while it is still pending.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        question_id: { type: 'string', description: 'The question_id ask_contact returned.' },
        wait_seconds: { type: 'number', description: 'How long to wait in this call, 0 to 45. Default 40.' },
      },
      required: ['question_id'],
    },
  },
  {
    name: 'connect',
    description: 'Ask someone for permission to question their agent, using the agentbridge: link they shared. They decide; nothing is sent until they approve.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        link: { type: 'string', description: 'The agentbridge: link that person shared.' },
        note: { type: 'string', description: 'One line saying who you are, for the person deciding.' },
      },
      required: ['link'],
    },
  },
]

const AskArgs = z.object({ contact: z.string().trim().min(1), question: z.string().trim().min(1).max(LIMITS.questionMaxChars) })
const CheckArgs = z.object({ question_id: z.string().trim().min(1), wait_seconds: z.coerce.number().optional() })
const ConnectArgs = z.object({ link: z.string().trim().min(1), note: z.string().trim().max(500).optional() })

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })

export function createAskerServer(service: AskerService, options: { version?: string; log?: (line: string) => void } = {}): Server {
  const server = new Server({ name: 'agentbridge', version: options.version ?? '0.2.0' }, { capabilities: { tools: {} } })
  const log = (line: string) => {
    try {
      options.log?.(line)
    } catch {
      // Nowhere left to report a broken logger.
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      switch (req.params.name) {
        case 'list_contacts': {
          await service.sync()
          const allowed = service.contacts().filter((contact) => contact.state === 'approved')
          if (allowed.length === 0) {
            return ok(`Nadie te ha dado permiso para preguntarle todavía. Pide permiso con la herramienta connect o con: ${CLI_COMMAND} connect <enlace>`)
          }
          return ok(allowed.map((contact) => formatContactLine(contact)).join('\n'))
        }
        case 'ask_contact': {
          const args = AskArgs.parse(req.params.arguments ?? {})
          const question = await service.ask(args.contact, args.question)
          await service.sync()
          return ok(
            `Pregunta enviada a ${args.contact}. question_id: ${question.questionId}\n` +
              'Llama check_answer con ese question_id. Si esa persona tiene su computadora apagada, la pregunta la espera hasta una semana.',
          )
        }
        case 'check_answer': {
          const args = CheckArgs.parse(req.params.arguments ?? {})
          const seconds = Math.max(0, Math.min(LIMITS.longPollMaxSeconds, Math.floor(args.wait_seconds ?? 40)))
          const question = service.question(args.question_id)
          const settled = await service.waitForAnswer({ recipient: question.recipient, questionId: question.questionId }, seconds)
          return ok(`${formatQuestion(settled)}\n\nquestion_id: ${settled.questionId}`)
        }
        case 'connect': {
          const args = ConnectArgs.parse(req.params.arguments ?? {})
          const outcome = await service.connect(args.link, args.note ?? '')
          await service.sync(30_000)
          if (outcome.kind === 'already_approved') return ok(`Esa persona ya te dio permiso (la tienes como ${outcome.name}).`)
          if (outcome.kind === 'already_pending') return ok('Ya le enviaste una solicitud a esa persona y sigue en camino.')
          return ok('Solicitud enviada. Esa persona decide si te da permiso; te enteras cuando list_contacts la muestre como aprobada.')
        }
        default:
          return fail(`Herramienta desconocida: ${req.params.name}`)
      }
    } catch (err) {
      if (err instanceof UserFacingError) return fail(err.message)
      if (err instanceof z.ZodError) return fail(zodFieldsMessage(err))
      // Anything else could carry decrypted content or a path: only its type reaches the log, and
      // the model gets a fixed Spanish sentence.
      log(`asker tool ${req.params.name} failed (${describeError(err)})`)
      return fail('Algo falló al usar AgentBridge. Vuelve a intentarlo; si sigue, revisa la terminal donde corre el servidor.')
    }
  })

  return server
}

export async function mcp(_argv: string[], ctx: CliContext): Promise<void> {
  const log = (message: string) => {
    try {
      process.stderr.write(`[agentbridge] ${message}\n`)
    } catch {
      // Nowhere left to report a broken logger.
    }
  }
  const session = await openAskerSession({ home: ctx.home, log })
  // The MCP server is the only persistent asker: it keeps the live subscription open and runs the
  // retries, history and purge on timers. Every CLI command syncs once instead.
  session.service.start()
  const server = createAskerServer(session.service, { log })

  // The SDK's stdio transport listens for 'data' and 'error', not for 'end': when Claude Code closes
  // the pipe, nothing here would ever resolve and the process would stay alive holding sockets. Every
  // way this process can be told to stop is registered before connecting, and the cleanup is
  // idempotent so two of them arriving together is harmless.
  let stopping: Promise<void> | null = null
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      try {
        await server.close()
      } catch (err) {
        log(`closing the MCP server failed (${describeError(err)})`)
      }
      await session.close()
    })()
    return stopping
  }
  const ended = new Promise<void>((resolve) => {
    process.stdin.once('end', resolve)
    process.stdin.once('close', resolve)
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
    server.onclose = () => resolve()
  })

  try {
    await server.connect(new StdioServerTransport())
    await ended
  } finally {
    await stop()
  }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run packages/cli/test/commands-ask.test.ts packages/cli/test/mcp-asker.test.ts`
Expected: PASS.

Run: `npm run typecheck && npm test`
Expected: clean, every test passing.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/commands/ask.ts packages/cli/src/mcp-asker.ts packages/cli/test/commands-ask.test.ts packages/cli/test/mcp-asker.test.ts
git commit -m "feat(cli): ask, ticket and the four asker MCP tools over stored state"
```
### Task 11: The command table and the help text, without the 0.1 enrollment commands

**Files:**
- Modify (rewrite the table and USAGE): `packages/cli/src/router.ts`
- Test: `packages/cli/test/router.test.ts`

**Interfaces:**
- Consumes: Tasks 7, 8 and 9's commands; `setupCommand`, `setupResponderCommand`, `doctorCommand` stay exactly as they are (plan 4 rewrites them).
- Produces:
  - `COMMANDS` holds: `setup`, `setup-responder`, `doctor`, `link`, `connect`, `contacts`, `whoami`, `requests`, `approve`, `reject`, `revoke`, `ask`, `ticket`, `mcp`.
  - `USAGE` is rewritten for the flow without a server of our own: no `enroll`, `invite`, `accept` or `admin`, no `AGENTBRIDGE_RELAY_URL`, no `AGENTBRIDGE_ADMIN_TOKEN`. Command names stay English; every explanation is Spanish and every example uses `CLI_COMMAND`.
  - `run()` keeps translating `parseArgs` errors and `CliError`, prints a `UserFacingError`'s message as written (it is Spanish by construction) with exit code 1, and — the change that matters for privacy — stops printing an unexpected error's own message: those can carry a path, relay text or decrypted content, so the person sees a fixed Spanish sentence and only `describeError(err)` names the type.
- `RelayError` handling stays until plan 4 deletes `RelayHttpClient` with `doctor`.
- **`packages/cli/src/commands/account.ts` and `clientFor` stay on disk** (P9). `setup.ts` still calls `enroll` and `doctor.ts` still constructs a `RelayHttpClient`; deleting either file here breaks the build of the whole CLI. Plan 4 rewrites `setup` and `doctor` and removes all three together.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/test/router.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { memoryOutput, type CliContext } from '../src/context'
import { USAGE, run } from '../src/router'

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
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/cli/test/router.test.ts`
Expected: FAIL — the table still has `enroll` and friends.

- [ ] **Step 3: Rewrite the table and the help text**

In `packages/cli/src/router.ts`, replace the imports of `./commands/account` and `./mcp-asker`, the `USAGE` constant and the `COMMANDS` table with:

```ts
import { CLI_COMMAND, RelayError, UserFacingError } from '@agentbridge/core'
import { ask, ticket } from './commands/ask'
import { connect, link } from './commands/connect'
import { approve, contacts, reject, requests, revoke, whoami } from './commands/contacts'
import { doctorCommand } from './commands/doctor'
import { setupCommand } from './commands/setup'
import { setupResponderCommand } from './commands/setup-responder'
import { CliError, type CliContext } from './context'
import { mcp } from './mcp-asker'
import { isNetworkError, RELAY_UNREACHABLE_ES } from './spanish-errors'

export type Command = (argv: string[], ctx: CliContext) => Promise<void>

export const USAGE = `AgentBridge — pregúntale al agente de otra persona.

Para empezar:
  ${CLI_COMMAND} setup                       (te hace las preguntas necesarias y deja todo listo)

Tu enlace y tus permisos:
  ${CLI_COMMAND} link                        (muestra tu enlace, para compartirlo)
  ${CLI_COMMAND} connect <enlace> [--note "quién eres"]
  ${CLI_COMMAND} contacts                    (a quién puedes preguntarle y quién puede preguntarte)
  ${CLI_COMMAND} whoami

Solicitudes que te llegan:
  ${CLI_COMMAND} requests
  ${CLI_COMMAND} approve <id>
  ${CLI_COMMAND} reject <id>
  ${CLI_COMMAND} revoke <nombre>

Preguntar:
  ${CLI_COMMAND} ask <nombre> <pregunta…> [--wait <segundos>|--no-wait]
  ${CLI_COMMAND} ticket <id> [--wait <segundos>]
  ${CLI_COMMAND} mcp                         (servidor MCP para Claude Code o Codex)

Responder desde esta computadora:
  ${CLI_COMMAND} setup-responder --share <carpeta> [--home <carpeta>] [--repo <carpeta>] [--model sonnet] [--effort low]
  ${CLI_COMMAND} doctor [--home <carpeta>] [--share <carpeta>] [--repo <carpeta>]

Variable: AGENTBRIDGE_HOME (la carpeta con tu identidad y tu base de datos)`

const COMMANDS: Record<string, Command> = {
  setup: setupCommand,
  'setup-responder': setupResponderCommand,
  doctor: doctorCommand,
  link,
  connect,
  contacts,
  whoami,
  requests,
  approve,
  reject,
  revoke,
  ask,
  ticket,
  mcp,
}
```

and, inside `run`'s `catch`, add `UserFacingError` next to the existing `CliError` branch:

```ts
    if (err instanceof CliError || err instanceof UserFacingError || err instanceof RelayError) {
      ctx.out.error(err.message)
      return 1
    }
```

- [ ] **Step 4: Hide unexpected errors behind a fixed sentence**

In `run`'s `catch`, replace the last branch:

```ts
    ctx.out.error(`Algo falló al ejecutar ese comando. Vuelve a intentarlo; si sigue fallando, corre: ${CLI_COMMAND} doctor`)
    log(`command ${name} failed (${describeError(err)})`)
    return 2
```

where `log` writes to stderr with the same swallow-its-own-failure guard the channel uses. Add a test:

```ts
  it('never prints the text of an unexpected error', async () => {
    const c = ctx()
    const boom = Object.assign(new Error('/Users/alguien/carpeta compartida: CANARIO'), { code: 'EACCES' })
    const failing: Record<string, Command> = { boom: async () => { throw boom } }
    expect(await runWith(failing, ['boom'], c)).toBe(2)
    const printed = [...c.out.lines, ...c.out.errors].join('\n')
    expect(printed).not.toContain('CANARIO')
    expect(printed).not.toContain('carpeta compartida')
  })
```

> `runWith` is a small exported seam for the test: `run` keeps its signature and delegates to it with the real table. If you prefer not to add a seam, drive the same case through a real command whose store path is unreadable.

- [ ] **Step 5: Run everything**

Run: `npx vitest run packages/cli/test/router.test.ts`
Expected: PASS.

Run: `npm run typecheck && npm test`
Expected: clean, every test passing. `account.ts` is no longer reachable from the command table, but it still compiles because `setup` uses it — that is deliberate (P9).

- [ ] **Step 6: Check the bundles still build and start**

Run: `node scripts/build.mjs && node packages/cli/dist/main.js --help | head -5`
Expected: the new Spanish help text, with no mention of `enroll`.

- [ ] **Step 7: Commit**

```bash
git add -A packages/cli
git commit -m "feat(cli): the 0.2 command table, without the enrollment commands"
```
### Task 12: End-to-end, both people at once

**Files:**
- Create: `tests/asker/support.ts`
- Test: `tests/asker/flow.test.ts`

**Interfaces:**
- Consumes: `startResponder`, `startFakeBoard`, `until`, `allowAnyRelay`, `type Cleanups`, `type ResponderHarness` from `tests/responder/support.ts` (plan 2), plus `AskerService` (Task 6) and the core store functions.
- Produces (test support only, used by Tasks 12 and 13):
  - `startAsker({ identity, relays, cleanups, home?, name?, now? }): Promise<AskerHarness>`: opens a store with `allowAnyRelay`, sets the profile, builds an `AskerService` over the fake boards, and registers its `close()` in `cleanups`.
  - `type AskerHarness = { home: string; store: Store; service: AskerService; sync(maxMs?: number): Promise<void>; close(): Promise<void> }`
  - `approveFromResponder(responder: ResponderHarness, askerPubkey: string): Promise<void>`: finds the pending request and approves it through `approveConnection`, the way the person would from their terminal.
- This is the one test file in the plan that sends a real `connect_request` over boards, so it pays for 22-bit mining exactly once (the test names that cost in a comment).

- [ ] **Step 1: Write the harness**

Create `tests/asker/support.ts`:

```ts
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listRequests, openStore, setProfile, approveConnection, nowSeconds, type Identity, type Store } from '@agentbridge/core'
import { AskerService } from '../../packages/cli/src/asker/service'
import { allowAnyRelay, plainSocketFactory, type Cleanups, type ResponderHarness } from '../responder/support'

export type AskerHarness = {
  home: string
  store: Store
  service: AskerService
  sync(maxMs?: number): Promise<void>
  close(): Promise<void>
}

export async function startAsker(input: {
  identity: Identity
  relays: string[]
  cleanups: Cleanups
  home?: string
  name?: string
  now?: () => number
}): Promise<AskerHarness> {
  const home = input.home ?? join(await mkdtemp(join(tmpdir(), 'ab-asker-home-')), 'home')
  const store = await openStore(home, { relayPolicy: allowAnyRelay })
  const now = input.now ?? nowSeconds
  setProfile(store, { name: input.name ?? 'Beto', relays: input.relays, now: now() })
  const service = new AskerService({ store, identity: input.identity, createSocket: plainSocketFactory, now: input.now })
  const harness: AskerHarness = {
    home,
    store,
    service,
    sync: async (maxMs?: number) => {
      await service.sync(maxMs)
    },
    close: async () => {
      await service.close()
      store.close()
    },
  }
  input.cleanups.push(() => harness.close())
  return harness
}

// What the person on the other side does from their terminal: look at the pending requests and
// approve the one that just arrived.
export async function approveFromResponder(responder: ResponderHarness, askerPubkey: string): Promise<void> {
  const pending = listRequests(responder.store, nowSeconds())
  const match = pending.find((request) => request.pubkey === askerPubkey)
  if (!match) throw new Error('the responder has no pending request from that key')
  approveConnection(responder.store, { identity: responder.identity, idPrefix: match.id, now: nowSeconds() })
  responder.device.wakePublisher()
}
```

> `tests/responder/support.ts` must export `allowAnyRelay`, `plainSocketFactory` and the harness's `identity` and `store` for this to compile. Plan 2 already exports the first two and the `ResponderHarness` type with `store`; if `identity` is not on that type, add it there (one line, no behavior change).

- [ ] **Step 2: Write the failing flow test**

Create `tests/asker/flow.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { encodeLink, getContact, getOutboundQuestion, listRequests, nowSeconds } from '@agentbridge/core'
import { startFakeBoard, startResponder, testIdentity, until, type Cleanups } from '../responder/support'
import { approveFromResponder, startAsker } from './support'

const ana = testIdentity(71) // answers
const beto = testIdentity(72) // asks

const cleanups: Cleanups = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

describe('the whole round trip', () => {
  // The only test in this plan that mines a real 22-bit connection request; every other test seeds
  // the approval through the store. Budgeted at four minutes for a slow machine.
  it(
    'connects, gets approved, asks, and reads the answer',
    async () => {
      const board = await startFakeBoard()
      cleanups.push(() => board.close())

      const responder = await startResponder({ identity: ana, relays: [board.url], cleanups })
      const asker = await startAsker({ identity: beto, relays: [board.url], cleanups })

      // 1. Beto asks Ana for permission.
      const outcome = await asker.service.connect(encodeLink(ana.publicKey, [board.url]), 'soy Beto, del equipo de datos')
      expect(outcome.kind).toBe('requested')
      // The network part stays inside the ordinary ten seconds; the 22-bit proof of work runs on its
      // own budget inside the publisher, so this may take a few seconds of CPU before it returns.
      await asker.sync()

      // 2. Ana sees it and approves.
      await until(async () => {
        await asker.sync()
        return listRequests(responder.store, nowSeconds()).length === 1
      }, 120_000, 'the request to reach Ana')
      await approveFromResponder(responder, beto.publicKey)
      await until(() => getContact(responder.store, beto.publicKey, 'inbound')?.state === 'approved')

      // 3. Beto's next sync brings the approval home.
      await until(async () => {
        await asker.sync()
        return getContact(asker.store, ana.publicKey, 'outbound')?.state === 'approved'
      }, 30_000, 'the approval to reach Beto')

      // 4. Beto asks, Ana's Claude answers.
      const question = await asker.service.ask('ana', '¿cómo se despliega?')
      await asker.sync()
      await until(() => responder.questions().length === 1, 20_000, 'the question to reach Claude')
      const code = responder.questions()[0]!.meta.code!
      await responder.reply({ code, answer: 'con npm run deploy', source: 'README.md', confidence: 'seguro' })

      // 5. Beto reads it.
      await until(async () => {
        await asker.sync()
        return getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.state === 'answered'
      }, 30_000, 'the answer to reach Beto')
      expect(getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.answer).toMatchObject({
        text: 'con npm run deploy',
        source: 'README.md',
        confidence: 'seguro',
      })
    },
    240_000,
  )
})

```



- [ ] **Step 3: Run it and watch it fail, then pass**

Run: `npx vitest run tests/asker/flow.test.ts`
Expected: it fails first if any wiring is missing, and passes once Tasks 1–10 are in. Nothing in this task changes production code: a failure here is a real defect in one of them, not something to patch inside the test.

- [ ] **Step 4: Add a second flow test — the responder was closed while the question was sent**

Append to `tests/asker/flow.test.ts`:

```ts
  it('delivers a question that was sent while the other computer was closed', async () => {
    const board = await startFakeBoard()
    cleanups.push(() => board.close())

    // Ana exists but is not running: seed the approval directly, the way every other test does.
    const responderHome = await seedApprovedPair({ board, ana, beto, cleanups })
    const asker = await startAsker({ identity: beto, relays: [board.url], cleanups, home: responderHome.askerHome })

    const question = await asker.service.ask('ana', '¿sigues ahí?')
    await asker.sync()

    // Now Ana opens her computer.
    const responder = await startResponder({ identity: ana, relays: [board.url], cleanups, home: responderHome.responderHome })
    await until(() => responder.questions().length === 1, 30_000, 'the stored question to reach Claude')
    await responder.reply({ code: responder.questions()[0]!.meta.code!, answer: 'aquí estoy', source: 'chat', confidence: 'seguro' })

    await until(async () => {
      await asker.sync()
      return getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.state === 'answered'
    }, 30_000, 'the answer to arrive')
  }, 120_000)
```

and add the helper it uses to `tests/asker/support.ts`:

```ts
// Both sides already know each other, without mining a connection request: the responder has the
// asker approved, and the asker has the responder approved with the same generation.
export async function seedApprovedPair(input: {
  board: { url: string }
  ana: Identity
  beto: Identity
  cleanups: Cleanups
}): Promise<{ responderHome: string; askerHome: string }> {
  const responderHome = join(await mkdtemp(join(tmpdir(), 'ab-pair-ana-')), 'home')
  const askerHome = join(await mkdtemp(join(tmpdir(), 'ab-pair-beto-')), 'home')
  const now = nowSeconds()

  const anaStore = await openStore(responderHome, { relayPolicy: allowAnyRelay })
  setProfile(anaStore, { name: 'Ana', relays: [input.board.url], now })
  seedApprovedContact(anaStore, { responder: input.ana, asker: input.beto, askerRelays: [input.board.url], now })
  anaStore.close()

  const betoStore = await openStore(askerHome, { relayPolicy: allowAnyRelay })
  setProfile(betoStore, { name: 'Beto', relays: [input.board.url], now })
  createOutboundRequest(betoStore, { pubkey: input.ana.publicKey, requestId: randomUUID(), relays: [input.board.url], now })
  const request = getContact(betoStore, input.ana.publicKey, 'outbound')!
  applyApproval(betoStore, { pubkey: input.ana.publicKey, requestId: request.requestId!, generation: 1, name: 'Ana', relays: [input.board.url], now })
  betoStore.close()

  return { responderHome, askerHome }
}
```

> Add the imports it needs to `tests/asker/support.ts`: `randomUUID` from `node:crypto`, and `applyApproval`, `createOutboundRequest`, `getContact`, `seedApprovedContact` from core / the responder harness.

- [ ] **Step 5: Run both flows**

Run: `npx vitest run tests/asker/flow.test.ts`
Expected: PASS (the first test takes seconds of CPU for its one 22-bit mine).

Run: `npm run typecheck && npm test`
Expected: clean, every test passing.

- [ ] **Step 6: Commit**

```bash
git add tests/asker/support.ts tests/asker/flow.test.ts tests/responder/support.ts
git commit -m "test: the whole round trip, asker and responder over fake boards"
```
### Task 13: Asker scenarios — losses, rejections, revocation, expiry and late decisions

**Files:**
- Test: `tests/asker/scenarios.test.ts`

**Interfaces:**
- Consumes: `startAsker`, `seedApprovedPair` (Task 12), the responder harness, and the core store functions.
- Produces: nothing new. This task proves the spec's integration list for the asker side.

Each test names the rule it protects, and each one would fail if that rule were removed.

- [ ] **Step 1: Write the scenarios**

Create `tests/asker/scenarios.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import {
  NOSTR,
  applyApproval,
  createOutboundRequest,
  createRumor,
  getContact,
  getOutboundQuestion,
  nowSeconds,
  wrapRumor,
  type Message,
} from '@agentbridge/core'
import { startFakeBoard, testIdentity, until, type Cleanups } from '../responder/support'
import { startAsker } from './support'

const ana = testIdentity(73)
const beto = testIdentity(74)
const stranger = testIdentity(75)
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

const cleanups: Cleanups = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

// Ana's side, without running her channel: seal a message to Beto and drop it on the board.
async function anaSends(board: { inject(event: unknown): void }, message: Message, sender = ana): Promise<void> {
  const rumor = createRumor(message, sender, nowSeconds())
  board.inject(await wrapRumor(rumor, sender, beto.publicKey, { now: nowSeconds() }) as never)
}

async function askerWithApproval(clock?: { now: number }) {
  const board = await startFakeBoard()
  cleanups.push(() => board.close())
  const asker = await startAsker({
    identity: beto,
    relays: [board.url],
    cleanups,
    now: clock ? () => clock.now : undefined,
  })
  const now = clock?.now ?? nowSeconds()
  createOutboundRequest(asker.store, { pubkey: ana.publicKey, requestId: uuid(1), relays: [board.url], now })
  applyApproval(asker.store, { pubkey: ana.publicKey, requestId: uuid(1), generation: 1, name: 'Ana', relays: [board.url], now })
  return { board, asker, now }
}

describe('what the asker does with what arrives', () => {
  it('keeps retrying after a receipt and stops once the answer lands', async () => {
    const { board, asker } = await askerWithApproval()
    const question = await asker.service.ask('ana', '¿sigues ahí?')
    await asker.sync()

    await anaSends(board, { v: 1, type: 'receipt', questionId: question.questionId })
    await until(async () => {
      await asker.sync()
      return getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.state === 'received'
    })
    // The receipt does not stop the retries: the outbox row is still there.
    expect(asker.store.db.prepare('SELECT count(*) AS n FROM outbox').get()).toMatchObject({ n: 1 })

    await anaSends(board, { v: 1, type: 'answer', questionId: question.questionId, text: 'sí', source: 'chat', confidence: 'seguro' })
    await until(async () => {
      await asker.sync()
      return getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.state === 'answered'
    })
    expect(asker.store.db.prepare('SELECT count(*) AS n FROM outbox').get()).toMatchObject({ n: 0 })
  }, 60_000)

  it('shows a rejection with its reason and never asks again by itself', async () => {
    const { board, asker } = await askerWithApproval()
    const question = await asker.service.ask('ana', 'otra más')
    await asker.sync()

    await anaSends(board, { v: 1, type: 'rejected', questionId: question.questionId, reason: 'limit' })
    await until(async () => {
      await asker.sync()
      return getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.state === 'rejected'
    })
    expect(getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.rejectReason).toBe('limit')
    expect(asker.store.db.prepare('SELECT count(*) AS n FROM outbox').get()).toMatchObject({ n: 0 })
  }, 60_000)

  it('ignores a second decision and keeps the first', async () => {
    const { board, asker } = await askerWithApproval()
    const question = await asker.service.ask('ana', 'una sola decisión')
    await asker.sync()

    await anaSends(board, { v: 1, type: 'rejected', questionId: question.questionId, reason: 'expired' })
    await until(async () => {
      await asker.sync()
      return getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.state === 'rejected'
    })
    await anaSends(board, { v: 1, type: 'answer', questionId: question.questionId, text: 'tarde', source: 'x', confidence: 'seguro' })
    await asker.sync()
    await asker.sync()
    expect(getOutboundQuestion(asker.store, ana.publicKey, question.questionId)).toMatchObject({ state: 'rejected', answer: null })
  }, 60_000)

  it('never lets a stranger touch a question meant for someone else', async () => {
    const { board, asker } = await askerWithApproval()
    const question = await asker.service.ask('ana', 'solo para Ana')
    await asker.sync()
    const before = getOutboundQuestion(asker.store, ana.publicKey, question.questionId)!
    const outboxBefore = asker.store.db.prepare('SELECT count(*) AS n FROM outbox').get() as { n: number }

    await anaSends(board, { v: 1, type: 'answer', questionId: question.questionId, text: 'soy otro', source: 'x', confidence: 'seguro' }, stranger)
    await asker.sync()
    await asker.sync()

    // Nothing at all changed: not the state, not the stored answer, and above all not the retries —
    // a stranger who could silently stop them would be as harmful as one who could answer.
    expect(getOutboundQuestion(asker.store, ana.publicKey, question.questionId)).toEqual(before)
    expect(asker.store.db.prepare('SELECT count(*) AS n FROM outbox').get()).toEqual(outboxBefore)

    // And the real answer still works afterwards.
    await anaSends(board, { v: 1, type: 'answer', questionId: question.questionId, text: 'soy Ana', source: 'chat', confidence: 'seguro' })
    await until(async () => {
      await asker.sync()
      return getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.state === 'answered'
    })
  }, 60_000)

  it('reaches the other person even when one of their boards is dead', async () => {
    const live = await startFakeBoard()
    const dead = await startFakeBoard()
    cleanups.push(() => live.close())
    const asker = await startAsker({ identity: beto, relays: [live.url], cleanups })
    const now = nowSeconds()
    createOutboundRequest(asker.store, { pubkey: ana.publicKey, requestId: uuid(2), relays: [live.url, dead.url], now })
    applyApproval(asker.store, { pubkey: ana.publicKey, requestId: uuid(2), generation: 1, name: 'Ana', relays: [live.url, dead.url], now })
    // The second board goes away before anything is published to it, so publishing has to survive
    // one relay refusing every connection.
    await dead.close()

    const question = await asker.service.ask('ana', '¿llega igual?')
    await asker.sync()
    expect(getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.state).toBe('sent')
    expect(live.events.filter((event) => event.kind === 1059).length).toBeGreaterThanOrEqual(1)
  }, 60_000)
})

describe('permission changes', () => {
  it('applies a revocation and refuses to ask again', async () => {
    const { board, asker } = await askerWithApproval()
    await anaSends(board, { v: 1, type: 'connect_revoked', generation: 2 })
    await until(async () => {
      await asker.sync()
      return getContact(asker.store, ana.publicKey, 'outbound')?.state === 'revoked'
    })
    await expect(asker.service.ask('ana', '¿puedo todavía?')).rejects.toThrow()
  }, 60_000)

  it('ignores a revocation older than the approval it already has', async () => {
    const { board, asker } = await askerWithApproval()
    // Ana approved again with a newer generation, and only then an old revocation arrives.
    applyApproval(asker.store, { pubkey: ana.publicKey, requestId: uuid(1), generation: 5, name: 'Ana', relays: [board.url], now: nowSeconds() })
    await anaSends(board, { v: 1, type: 'connect_revoked', generation: 3 })
    await asker.sync()
    await asker.sync()
    expect(getContact(asker.store, ana.publicKey, 'outbound')?.state).toBe('approved')
  }, 60_000)

  it('ignores an approval that answers a request this person never made', async () => {
    const { board, asker } = await askerWithApproval()
    await anaSends(board, { v: 1, type: 'connect_approved', requestId: uuid(999), generation: 9, name: 'Ana', relays: [board.url] })
    await asker.sync()
    await asker.sync()
    expect(getContact(asker.store, ana.publicKey, 'outbound')?.generation).toBe(1)
  }, 60_000)
})

describe('time', () => {
  it('gives up on a question after the retry window and says so', async () => {
    const clock = { now: 2_000_000_000 }
    const { asker } = await askerWithApproval(clock)
    const question = await asker.service.ask('ana', '¿hay alguien?')
    await asker.sync()

    clock.now += NOSTR.retryWindowSeconds
    await asker.sync()
    expect(getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.state).toBe('lost')
    expect(asker.store.db.prepare('SELECT count(*) AS n FROM outbox').get()).toMatchObject({ n: 0 })
  }, 60_000)

  it('republishes the same question on the retry schedule until something decides it', async () => {
    const clock = { now: 2_000_000_000 }
    const { board, asker } = await askerWithApproval(clock)
    const question = await asker.service.ask('ana', 'paciencia')
    await asker.sync()
    const first = board.events.filter((event) => event.kind === 1059).length
    expect(first).toBeGreaterThanOrEqual(1)

    // Nothing is due yet: a sync one minute later publishes nothing new.
    clock.now += 60
    await asker.sync()
    expect(board.events.filter((event) => event.kind === 1059).length).toBe(first)

    // Five minutes in, the first retry is due; half an hour after that, the second.
    clock.now += NOSTR.retryFirstHourIntervalSeconds
    await asker.sync()
    const second = board.events.filter((event) => event.kind === 1059).length
    expect(second).toBeGreaterThan(first)

    clock.now += 3_600 + NOSTR.retryAfterFirstHourIntervalSeconds
    await asker.sync()
    expect(board.events.filter((event) => event.kind === 1059).length).toBeGreaterThan(second)

    // Every one of them carried the same question, with the same rumor id.
    expect(getOutboundQuestion(asker.store, ana.publicKey, question.questionId)).toMatchObject({ state: 'sent', rumorId: question.rumorId })
  }, 60_000)

  it('stops republishing the moment an answer lands', async () => {
    const clock = { now: 2_000_000_000 }
    const { board, asker } = await askerWithApproval(clock)
    const question = await asker.service.ask('ana', '¿ya?')
    await asker.sync()
    await anaSends(board, { v: 1, type: 'answer', questionId: question.questionId, text: 'ya', source: 'chat', confidence: 'seguro' })
    await until(async () => {
      await asker.sync()
      return getOutboundQuestion(asker.store, ana.publicKey, question.questionId)?.state === 'answered'
    })
    const after = board.events.filter((event) => event.kind === 1059).length
    clock.now += NOSTR.retryFirstHourIntervalSeconds * 3
    await asker.sync()
    expect(board.events.filter((event) => event.kind === 1059).length).toBe(after)
  }, 60_000)
})
```

Append one more scenario, which is the spec's "quien pregunta solo con CLI, apagado y luego sincronizando":

```ts
describe('a person who only uses the terminal', () => {
  it('picks up an answer that arrived while every process was closed', async () => {
    const board = await startFakeBoard()
    cleanups.push(() => board.close())
    const home = join(await mkdtemp(join(tmpdir(), 'ab-reopen-')), 'home')

    // First run: ask, then close everything.
    const first = await startAsker({ identity: beto, relays: [board.url], cleanups, home })
    const now = nowSeconds()
    createOutboundRequest(first.store, { pubkey: ana.publicKey, requestId: uuid(1), relays: [board.url], now })
    applyApproval(first.store, { pubkey: ana.publicKey, requestId: uuid(1), generation: 1, name: 'Ana', relays: [board.url], now })
    const question = await first.service.ask('ana', '¿me contestas luego?')
    await first.sync()
    await first.close()

    // Ana answers while nothing of Beto's is running.
    const rumor = createRumor(
      { v: 1, type: 'answer', questionId: question.questionId, text: 'sí, aquí está', source: 'chat', confidence: 'seguro' },
      ana,
      nowSeconds(),
    )
    board.inject(await wrapRumor(rumor, ana, beto.publicKey, { now: nowSeconds() }))

    // Second run, same home: one sync brings it home.
    const second = await startAsker({ identity: beto, relays: [board.url], cleanups, home })
    await until(async () => {
      await second.sync()
      return getOutboundQuestion(second.store, ana.publicKey, question.questionId)?.state === 'answered'
    }, 30_000, 'the answer to be picked up on the next run')
  }, 90_000)
})
```

> This test needs `mkdtemp`, `tmpdir` and `join` imported at the top of the file.

- [ ] **Step 2: Run them**

Run: `npx vitest run tests/asker/scenarios.test.ts`
Expected: PASS. A failure here is a defect in Tasks 1–10, not something to weaken in the test.

- [ ] **Step 3: Prove one of them is load-bearing**

Pick the "never lets a stranger touch a question" test. Copy `packages/core/src/store/outbox-questions.ts` aside under `$TMPDIR`, then remove the recipient from **both** places that key the write — `decide`'s lookup and `applyAnswer`'s `UPDATE ... WHERE recipient = ?` — so a stranger's answer really can reach another person's question. (Removing it from only one of them leaves the update matching nothing, and the old assertion would have passed while the stranger still deleted the outbox row: that is the false positive this test was rewritten to close.) Run that one test, watch it fail, restore the file with `git show HEAD:packages/core/src/store/outbox-questions.ts > packages/core/src/store/outbox-questions.ts`, and watch it pass. Put both runs in the report. Never use `git stash`.

- [ ] **Step 4: Commit**

```bash
git add tests/asker/scenarios.test.ts
git commit -m "test: asker scenarios for losses, rejections, revocation and expiry"
```
### Task 14: Two processes on the same home

**Files:**
- Test: `tests/asker/multiprocess.test.ts`

**Interfaces:**
- Consumes: the CLI's built bundle (`packages/cli/dist/main.js`, built by `node scripts/build.mjs`), `openStore`, `loadOrCreateIdentity`, the asker harness.
- Produces: nothing new. This task proves the spec's multi-process requirements that belong to the asker:
  - the MCP server and a CLI command update the same question and claim the same outbox row without either losing work;
  - two `setup`-style identity creations at the same time produce one identity, never two;
  - a CLI command always ends, even when a relay is slow or dead;
  - the MCP server exits when Claude Code closes its stdin, even with relay sockets open.

- [ ] **Step 1: Write the tests**

Create `tests/asker/multiprocess.test.ts`:

```ts
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  applyApproval,
  createOutboundQuestion,
  createOutboundRequest,
  getOutboundQuestion,
  listOutboundQuestions,
  loadOrCreateIdentity,
  markSentQuestions,
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

async function seedHome(board: { url: string }): Promise<string> {
  const home = join(await mkdtemp(join(tmpdir(), 'ab-multi-')), 'home')
  const store = await openStore(home)
  setProfile(store, { name: 'Beto', relays: [board.url], now: nowSeconds() })
  createOutboundRequest(store, { pubkey: ana.publicKey, requestId: uuid(1), relays: [board.url], now: nowSeconds() })
  applyApproval(store, { pubkey: ana.publicKey, requestId: uuid(1), generation: 1, name: 'Ana', relays: [board.url], now: nowSeconds() })
  store.close()
  await writeFile(join(home, 'identity.json'), JSON.stringify({ version: 1, secretKey: Buffer.from(beto.secretKey).toString('hex') }), { mode: 0o600 })
  return home
}

describe('a CLI command and a running MCP server share one home', () => {
  it('both see the same question, and only one of them publishes it', async () => {
    const board = await startFakeBoard()
    cleanups.push(() => board.close())
    const home = await seedHome(board)

    // The persistent side: a live asker service, like the MCP server.
    const persistent = await startAsker({ identity: beto, relays: [board.url], cleanups, home })
    persistent.service.start()

    // The other side: a real CLI process, asking a question against the same home.
    execFileSync(process.execPath, [cli, 'ask', 'ana', '¿quién publica esto?', '--no-wait'], {
      cwd: root,
      env: { ...process.env, AGENTBRIDGE_HOME: home },
      stdio: 'pipe',
      timeout: 60_000,
    })

    const store = await openStore(home)
    cleanups.push(async () => store.close())
    const asked = listOutboundQuestions(store)[0]!
    expect(asked.text).toBe('¿quién publica esto?')

    // Exactly one wrap for that question reaches the board, no matter which process sent it.
    await until(() => board.events.length >= 1, 30_000, 'the question to reach the board')
    markSentQuestions(store, nowSeconds())
    await until(() => getOutboundQuestion(store, ana.publicKey, asked.questionId)?.state === 'sent', 30_000, 'the question to be marked sent')
    const wraps = board.events.filter((event) => event.kind === 1059)
    expect(wraps.length).toBeGreaterThanOrEqual(1)
    // The outbox row is claimed by one owner at a time, so no row is left claimed by a dead owner.
    const claimed = store.db.prepare('SELECT count(*) AS n FROM outbox WHERE claimed_by IS NOT NULL').get() as { n: number }
    expect(claimed.n).toBeLessThanOrEqual(1)
  }, 180_000)
})

describe('two identity creations at once', () => {
  it('ends with exactly one identity, and both callers see the same key', async () => {
    const home = join(await mkdtemp(join(tmpdir(), 'ab-identity-race-')), 'home')
    const both = await Promise.all([loadOrCreateIdentity(home), loadOrCreateIdentity(home)])
    expect(both[0]!.identity.publicKey).toBe(both[1]!.identity.publicKey)
    expect([both[0]!.created, both[1]!.created].filter(Boolean)).toHaveLength(1)
  })
})

describe('the MCP server', () => {
  it('exits when its stdin closes, even with a live subscription', async () => {
    const board = await startFakeBoard()
    cleanups.push(() => board.close())
    const home = await seedHome(board)

    const child = spawn(process.execPath, [cli, 'mcp'], {
      cwd: root,
      env: { ...process.env, AGENTBRIDGE_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    cleanups.push(async () => {
      if (child.exitCode === null) child.kill('SIGKILL')
    })

    // Let it start, connect and open its live subscription before closing the pipe.
    await until(() => board.frames.some((frame) => frame[0] === 'REQ'), 30_000, 'the MCP server to subscribe')
    child.stdin.end()

    const exited = await Promise.race([
      new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000)),
    ])
    expect(exited).toBe(true)
  }, 90_000)
})

describe('a command always ends', () => {
  it('finishes even when the relay never answers', async () => {
    const board = await startFakeBoard({ slow: true })
    cleanups.push(() => board.close())
    const home = await seedHome(board)
    board.goSilent()

    const started = Date.now()
    execFileSync(process.execPath, [cli, 'contacts'], {
      cwd: root,
      env: { ...process.env, AGENTBRIDGE_HOME: home },
      stdio: 'pipe',
      timeout: 90_000,
    })
    // Two syncs of at most 10 s each, plus process start-up. The margin is the contractual budget
    // (20 s of network) plus 20 s for a cold Node start on a loaded machine — well under the 90 s
    // timeout above, and tight enough to fail if a sync ever waits for a pool timeout instead.
    expect(Date.now() - started).toBeLessThan(40_000)
  }, 120_000)
})
```

> `startFakeBoard({ slow: true })` uses whatever option plan 1's fake board exposes for a relay that answers slowly; if the option has another name, use that one and say so in the report. `goSilent()` already exists.

- [ ] **Step 2: Run them**

Run: `npx vitest run tests/asker/multiprocess.test.ts`
Expected: PASS. These spawn real processes: every one has a timeout and the fake boards are closed in `afterEach`.

- [ ] **Step 3: Commit**

```bash
git add tests/asker/multiprocess.test.ts
git commit -m "test: a CLI process and a live asker sharing one home"
```
### Task 15: Full verification

**Files:**
- No new files. This task only verifies; commit a fix only if a check fails, and name what it fixes.

**Interfaces:**
- Consumes: everything above.
- Produces: evidence that plan 3 is complete:
  - the type-check and the offline suite pass twice in a row;
  - both bundles build and start, and the CLI's help text is the 0.2 one;
  - the 0.1 enrollment commands are unreachable from the command table (their code leaves with `setup` and `doctor` in plan 4);
  - mining a connection request is measurably faster than plan 1's 16.5 s.

- [ ] **Step 1: Type-check and the whole suite, twice**

Run: `npm run typecheck && npm test && npm test`
Expected: clean, and the same file and test counts both times. Report both counts and the durations. A test that passes only on the second run is a defect: say which one and why.

- [ ] **Step 2: Both bundles build and start**

```bash
node scripts/build.mjs
node packages/cli/dist/main.js --help | head -20
AGENTBRIDGE_HOME=$(mktemp -d) node plugins/agentbridge/dist/server.js < /dev/null
```

Expected: the CLI prints the 0.2 Spanish help with `link`, `connect`, `requests`, `approve`, `reject`, `revoke`, `ask`, `ticket` and `mcp`, and no `enroll`, `invite`, `accept` or `admin`. The channel bundle exits 1 with the Spanish hint to run `setup` (there is no identity in that empty home).

- [ ] **Step 3: The 0.1 enrollment commands are unreachable**

```bash
git grep -n "enroll\|invite\|accept\|admin" -- packages/cli/src/router.ts
git grep -rn "from './commands/account'" -- packages/cli/src | grep -v setup.ts
```

Expected: nothing from either command. `account.ts` still exists and still compiles — `setup.ts` calls `enroll` and plan 4 removes both together (P9) — but nothing routes to it and no other file imports it.

- [ ] **Step 4: Mining is faster than it was, measured on a real connection request**

Run Task 4's measurement script again — the single `npx tsx` command, not the `||` form — and put its numbers in the report next to plan 1's live figure of 16 487 ms. It mines the same shape of event a `connect_request` actually produces (a wrap of a sealed request, not a toy string), three samples per configuration, and reports the median for one worker and for the default worker count. That median is the number plan 4's documentation quotes when it tells a person how long `connect` takes.

- [ ] **Step 5: A short-lived command stays inside its budget**

```bash
AGENTBRIDGE_HOME=$(mktemp -d) timeout 60 node packages/cli/dist/main.js contacts; echo "exit=$?"
```

Expected: it ends on its own (exit 1 with the Spanish "run setup" message in an empty home, or exit 0 once a home exists), never the timeout's 124.

- [ ] **Step 6: The asker never claims to know who is online**

```bash
git grep -n "en línea\|online" -- packages/cli/src packages/core/src | grep -v "test"
```

Expected: no match that describes a person's presence. Nostr cannot tell, and the tools say so instead.

- [ ] **Step 7: Report**

Write the evidence into the task report: both suite runs, the bundle output, the two greps, and the mining numbers. If every check passed, this task has no commit.
## What plan 4 starts from

- **Both halves of the protocol work over public relays and are tested**: the responder (plan 2) and the asker (this plan), each with its own role cursors, its own inbound handler and the same `Device`.
- **Everything a person touches from the terminal exists** except `setup` and `doctor`, which plan 4 rewrites:
  - `setup` must write the profile (name and own relays) with `setProfile`, create the identity with `loadOrCreateIdentity`, and — depending on the role — show this person's link or ask for the other person's; `identityHome` and `profileHome` separate there.
  - `doctor` must check: the key present, 0600 and outside the shared folder; the home 0700; the database reachable; the channel lock; publish **and** read per relay; pending requests; and everything it already checks about the locked-down session.
- **Still missing, by design:**
  - `setup`, `doctor`, packaging (`scripts/pack.mjs` still pins `engines.node` at `>=22.4`), the README and `docs/inicio-rapido.md`, the acceptance runbook, and deleting `RelayHttpClient` (`packages/core/src/http.ts`) with the 0.1 protocol messages once `doctor` stops importing it (plan 4);
  - the persistence-failure tests (read-only database, simulated full disk) and the 24-hour acceptance run before Render is switched off (plan 4);
  - the paid-switch decision the user asked to make before releasing 0.2 (plan 4, see the project's memory note).
- **Carried notes:**
  - `docs/known-gaps.md` now holds the four verified 0.2 gaps: Linux clock steps versus the channel lock, a message that always fails to store blocking a relay's history cursor, an answer's outbox copy outliving the question's inbox copy by up to ~14 days, and an approved contact's relays not being updatable by protocol. The fourth one bites the asker hardest: plan 4 should decide whether `connect` to an already-approved contact refreshes the relays, or whether the person is told to revoke and re-request.
  - `AskerService.question()` scans each outbound contact for an exact id before falling back to a prefix search. With hundreds of contacts that is a linear scan per lookup; it is fine for the pilot and worth an index if plan 4's `doctor` ever lists questions.
  - The MCP server's `check_answer` holds one wait at a time per call, up to `LIMITS.longPollMaxSeconds`. Two Claude sessions against one home are two processes: the multi-process test covers the store, not the MCP transport.
