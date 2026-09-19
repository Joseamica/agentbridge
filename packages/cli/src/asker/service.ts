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
  // Aborted by close(), so a wait that is sitting in its poll loop ends *before* anyone closes the
  // store underneath it — a wait that survived would read SQLite after it was closed.
  private readonly closing = new AbortController()
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
      // The push half of P1: the moment a relay accepts a wrap, the question that wrap carries stops
      // being `sending`. Without this, a persistent process (the MCP server) would leave its own
      // questions in `sending` until somebody happened to sync.
      onPublished: () => {
        markSentQuestions(options.store, (options.now ?? nowSeconds)())
      },
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
      // The declared name is what the other person actually typed (original casing); localName is
      // only the lowercase slug used for addressing (`ask ana ...`) and would read oddly here.
      return { kind: 'already_approved', pubkey: decoded.publicKey, name: existing.declaredName ?? existing.localName ?? decoded.publicKey.slice(0, 8) }
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
    const byName = findContactByLocalName(this.store, 'outbound', cleaned)
    if (byName) return byName
    const byKey = /^[0-9a-f]{64}$/.test(cleaned.toLowerCase()) ? getContact(this.store, cleaned.toLowerCase(), 'outbound') : null
    if (byKey) return byKey
    throw new UserFacingError('No tienes ningún contacto con ese nombre. Revisa tu lista con: contacts')
  }
}
