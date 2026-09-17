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
  beforeEose?: (subscriptionId: string, filters: Filter[]) => unknown[]
  // Answer WebSocket pings (default true). The server is built with autoPong off, so this is the
  // only thing that answers them.
  respondToPings?: boolean
}

export type FakeBoard = {
  readonly url: string
  readonly events: NostrEvent[]
  readonly authenticated: Set<string>
  readonly frames: unknown[][]
  options: FakeBoardOptions
  inject(event: NostrEvent): void
  disconnectAll(): void
  // Every session open right now stops sending frames and answering pings, like a half-open socket
  // after sleep or a NAT drop. Sessions opened afterwards behave normally.
  goSilent(): void
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

type Session = { socket: WebSocket; challenge: string; authed: Set<string>; subs: Map<string, Filter[]>; silent: boolean }

export async function startFakeBoard(initial: FakeBoardOptions = {}): Promise<FakeBoard> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false, autoPong: false })
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
    goSilent() {
      for (const s of sessions) s.silent = true
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sessions) s.socket.terminate()
        server.close(() => resolve())
      }),
  }

  const send = (s: Session, frame: unknown[]) => {
    if (!s.silent && s.socket.readyState === WebSocket.OPEN) s.socket.send(JSON.stringify(frame))
  }

  function broadcast(event: NostrEvent) {
    for (const s of sessions) {
      for (const [id, filters] of s.subs) {
        if (filters.some((f) => matches(f, event))) send(s, ['EVENT', id, event])
      }
    }
  }

  server.on('connection', (socket) => {
    const session: Session = { socket, challenge: randomBytes(16).toString('hex'), authed: new Set(), subs: new Map(), silent: false }
    sessions.add(session)
    socket.on('close', () => sessions.delete(session))
    const o = () => board.options
    socket.on('ping', (data) => {
      if (!session.silent && o().respondToPings !== false) socket.pong(data)
    })
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
        // Sent as-is, with no matching and no validation: the test decides what a hostile or
        // racing relay adds before EOSE (e.g. a live event slipping in for the same subscription).
        for (const extra of o().beforeEose?.(id, filters) ?? []) send(session, ['EVENT', id, extra])
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
