import { randomUUID } from 'node:crypto'
import {
  Device,
  NOSTR,
  UserFacingError,
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
  publishDue,
  MIN_QUESTION_PREFIX,
  type AskerInboundOutcome,
  type Contact,
  type Identity,
  type OutboundQuestion,
  type PublishReport,
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
  // `name` is for identifying that person to the one running the command; `localName` is the exact,
  // already-slugified string `ask`'s own resolveContact matches against (Fix round 1, M2) — a
  // declared name can carry spaces, accents or characters `ask` would never resolve.
  | { kind: 'already_approved'; pubkey: string; name: string; localName: string }

const CLI_SYNC_MS = 10_000
// Proof of work is CPU, not network: it gets its own budget so it never eats the ten seconds the
// spec gives a short-lived client's sync (see P5b and P5c).
const CONNECT_MINING_MS = 60_000
const WAIT_POLL_MS = 250

const EMPTY_PUBLISH: PublishReport = { published: 0, failed: 0, postponed: 0, lost: 0 }
const EMPTY_REPORT: SyncReport = { history: [], published: EMPTY_PUBLISH, timedOut: false }

function addPublishReports(a: PublishReport, b: PublishReport): PublishReport {
  return { published: a.published + b.published, failed: a.failed + b.failed, postponed: a.postponed + b.postponed, lost: a.lost + b.lost }
}

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
  // Aborted by close(), so a wait that is sitting in its poll loop ends *before* anyone closes the
  // store underneath it — a wait that survived would read SQLite after it was closed.
  private readonly closing = new AbortController()
  private syncing: Promise<SyncReport> = Promise.resolve(EMPTY_REPORT)

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
      // The push half of P1: the moment a relay accepts a wrap, the question that wrap carries stops
      // being `sending`. Without this, a persistent process (the MCP server) would leave its own
      // questions in `sending` until somebody happened to sync.
      onPublished: this.handlePublished,
      onMessage: (opened, outcome) => {
        // A second decision for a question that already ended is the one outcome worth a line: it
        // means the other side sent two. Identifiers only — never the answer's text.
        if (outcome.kind === 'question' && outcome.outcome === 'ignored') {
          this.safeLog(`ignored a late ${outcome.type} for question ${outcome.questionId} from ${opened.senderPubkey.slice(0, 8)}`)
        }
      },
    })
  }

  // Bound once so the same function reference (and the same P1 wiring) serves both the device's own
  // background publisher and the reserved publish pass sync() runs itself (see publishReserved).
  private readonly handlePublished = (): void => {
    markSentQuestions(this.store, this.now())
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
  // Syncs are serialized on `this.syncing`, but a rejected sync must not poison the chain: `.then()`
  // on a rejected promise never runs its callback, so a single failure (a SQLITE_BUSY from three
  // processes sharing one home is enough) would otherwise leave every later sync() returning that
  // same stale rejection forever — and with it, P1's promotion and P8's `lost` sweep dead until the
  // process restarts. `previous` absorbs the rejection so the chain always has something to build on;
  // `run` is the caller's own promise, so a failure is still reported to whoever called sync() this
  // time; `this.syncing` is set from a *derivative* of `run` (never `run` itself) so the field is
  // never left rejected for the next call to inherit, and awaiting it in close() never throws.
  sync(maxMs: number = CLI_SYNC_MS): Promise<SyncReport> {
    if (this.closed) return Promise.resolve(EMPTY_REPORT)
    const previous = this.syncing.catch(() => undefined)
    const run = previous.then(async () => {
      if (this.closed) return EMPTY_REPORT
      // One deadline for the whole sync, not two. The reserved pass, run before Device's own
      // history-then-publish cycle, exists so a relay that never answers history cannot leave a
      // command's own enqueued row unpublished (`Device.runSync` spends `maxMs` on history first, so
      // publishDue's shared signal could otherwise already be spent before its very first round even
      // starts). But giving that pass its own full `maxMs` and then handing device.syncOnce another
      // full `maxMs` let one sync take up to twice what the caller asked for — exactly what the
      // spec's ten seconds are supposed to bound. So the reserved pass spends from `maxMs`, and only
      // what it did not spend goes to device.syncOnce; publishing still cannot be starved, because it
      // goes first. If nothing is left, device.syncOnce still runs — with an already-expired
      // deadline, not skipped — so nothing silently stops happening; wall time, not `this.now()`
      // (which a test can hold still), is what measures the spend, matching how Device's own
      // `setTimeout`-based deadline works.
      // Each pass keeps its own "a row already claimed is always published" rule: the shared
      // deadline bounds when a pass may *start* claiming a new row, not a claim already in flight
      // (docs/known-gaps.md's 0.2 asker section, now updated for two passes instead of one).
      const startedAt = Date.now()
      const { report: reservedReport, timedOut: reservedTimedOut } = await this.publishReserved(maxMs)
      const remainingMs = Math.max(0, maxMs - (Date.now() - startedAt))
      const report = await this.device.syncOnce({ maxMs: remainingMs })
      const now = this.now()
      markSentQuestions(this.store, now)
      expireOutboundQuestions(this.store, now)
      return {
        history: report.history,
        // Either pass timing out is a timeout for the sync as a whole: a caller that only reads
        // device.syncOnce's own flag would silently miss one that happened only in the reserved pass.
        timedOut: reservedTimedOut || report.timedOut,
        published: addPublishReports(reservedReport, report.published),
      }
    })
    this.syncing = run.catch(() => EMPTY_REPORT)
    return run
  }

  // See sync()'s comment. Shares the sync's own `maxMs`-sized deadline (not a second one of its own)
  // so a row this command just enqueued always gets one real attempt this sync — not zero, which is
  // what an already-spent deadline gives it — without doubling the sync's total network-bound time.
  private async publishReserved(maxMs: number): Promise<{ report: PublishReport; timedOut: boolean }> {
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), maxMs)
    try {
      const report = await publishDue({
        store: this.store,
        identity: this.identity,
        pool: this.device.pool,
        now: this.now,
        signal: deadline.signal,
        miningMs: CONNECT_MINING_MS,
        log: this.log,
        onPublished: this.handlePublished,
      })
      return { report, timedOut: deadline.signal.aborted }
    } finally {
      clearTimeout(timer)
    }
  }

  async connect(link: string, note: string): Promise<ConnectOutcome> {
    // decodeLink throws a Spanish UserFacingError for anything that is not one of our links.
    const decoded = decodeLink(link)
    const existing = getContact(this.store, decoded.publicKey, 'outbound')
    if (existing?.state === 'approved') {
      // The declared name is what the other person actually typed (original casing) — good for
      // identifying them, wrong for addressing them: `ask` matches on the slugified localName, which
      // applyApproval always sets once a contact is approved.
      const fallback = decoded.publicKey.slice(0, 8)
      return {
        kind: 'already_approved',
        pubkey: decoded.publicKey,
        name: existing.declaredName ?? existing.localName ?? fallback,
        localName: existing.localName ?? fallback,
      }
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

  // Read by `link` (Task 10 reuses it too): what to hand someone so they can add this person. No
  // network involved — the profile is local settings, not a relay round trip.
  profile(): { name: string | null; relays: string[] } {
    return getProfile(this.store)
  }

  // Whether anything addressed to that person has actually gone out: the outbox row for their
  // pending connect request records the first relay that accepted it. Filtered to that request's own
  // label — a recipient can carry other outbox rows once approved (their questions), and rowid order
  // alone would silently answer about the wrong one once that happens. Used to tell "enviada" from
  // "guardada, pendiente de envío" instead of announcing a send the relays never confirmed.
  wasPublished(recipient: string): boolean {
    const row = this.store.db
      .prepare("SELECT last_published_at FROM outbox WHERE recipient = ? AND label = 'connect_request' ORDER BY rowid DESC LIMIT 1")
      .get(recipient) as { last_published_at: number | null } | undefined
    return row?.last_published_at != null
  }

  async ask(name: string, text: string): Promise<OutboundQuestion> {
    const recipient = this.resolveContact(name)
    // createOutboundQuestion runs this same permission check itself, in Spanish ("Pídeselo con
    // connect y espera a que apruebe"), which is the actionable message for every state that is not
    // approved — including revoked and rejected, where "espera a que apruebe tu solicitud" would be
    // wrong: there is no pending request to wait on. One check, one message, owned by the store.
    const { question } = createOutboundQuestion(this.store, { identity: this.identity, recipient: recipient.pubkey, text, now: this.now() })
    // Nothing is waited on here: the caller's next sync publishes it, and a persistent service has
    // its publisher woken instead.
    this.device.wakePublisher()
    return question
  }

  question(idOrPrefix: string): OutboundQuestion {
    const trimmed = idOrPrefix.trim().toLowerCase()
    // A full id is itself a prefix that matches only its own row, so one lookup covers both an exact
    // id and a shorter prefix — no need to also check every contact's exact id first.
    const matches = findOutboundQuestions(this.store, trimmed)
    if (matches.length === 1) return matches[0]!
    if (matches.length > 1) {
      throw new UserFacingError('Ese identificador coincide con varias preguntas. Escribe más caracteres.')
    }
    throw new UserFacingError(
      `No encuentro ninguna pregunta con ese identificador. Escribe al menos ${MIN_QUESTION_PREFIX} caracteres del que te dio al preguntar.`,
    )
  }

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
      // Both signals end the sleep at once: the caller's own, and the one close() aborts.
      await this.pause(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now())), options.signal, this.closing.signal)
    }
  }

  // A sleep that always clears its timer and detaches its listeners, so a wait can never hold the
  // process open and never outlives the service.
  private pause(ms: number, ...signals: Array<AbortSignal | undefined>): Promise<void> {
    const attached = signals.filter((signal): signal is AbortSignal => signal !== undefined)
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms)
      function done(): void {
        clearTimeout(timer)
        for (const signal of attached) signal.removeEventListener('abort', done)
        resolve()
      }
      for (const signal of attached) signal.addEventListener('abort', done, { once: true })
    })
  }

  // Nothing new starts once this is called, and everything already running is waited for before the
  // caller closes the store underneath it.
  async close(): Promise<void> {
    this.closed = true
    this.closing.abort()
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
    // local_name has no COLLATE NOCASE — it is always slugifyName's lowercase slug — so `ask Ana …`
    // must lowercase here too, the same way the 64-hex branch below already does.
    const byName = findContactByLocalName(this.store, 'outbound', cleaned.toLowerCase())
    if (byName) return byName
    const byKey = /^[0-9a-f]{64}$/.test(cleaned.toLowerCase()) ? getContact(this.store, cleaned.toLowerCase(), 'outbound') : null
    if (byKey) return byKey
    throw new UserFacingError('No tienes ningún contacto con ese nombre. Revisa tu lista con: contacts')
  }
}
