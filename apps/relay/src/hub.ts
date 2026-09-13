import { EventEmitter } from 'node:events'
import { ClientMessageSchema, LIMITS, newQuestionCode, type ClientMessage, type ServerMessage } from '@agentbridge/core'
import { authenticateToken, type Principal } from './auth'
import { withTx, type Pool } from './db'
import { recordEvent } from './events'

export interface ResponderSocket {
  send(data: string): void
  close(code: number, reason: string): void
}

type OpenAttempt = { attemptId: string; ticketId: string; code: string }

export type HubConnection = {
  socket: ResponderSocket
  principal: Principal | null
  openAttempt: OpenAttempt | null
  authTimer: NodeJS.Timeout | null
  closed: boolean
}

type HubOptions = { authTimeoutMs?: number; attemptTimeoutMs?: number }

export class ResponderHub {
  private readonly conns = new Map<string, HubConnection>()
  private readonly waiters = new EventEmitter()
  private readonly chains = new Map<string, Promise<void>>()

  constructor(
    private readonly pool: Pool,
    private readonly opts: HubOptions = {},
  ) {
    this.waiters.setMaxListeners(0)
  }

  handleOpen(socket: ResponderSocket): HubConnection {
    const conn: HubConnection = { socket, principal: null, openAttempt: null, authTimer: null, closed: false }
    conn.authTimer = setTimeout(
      () => socket.close(4401, 'auth timeout'),
      this.opts.authTimeoutMs ?? LIMITS.authTimeoutMs,
    )
    return conn
  }

  markClosed(conn: HubConnection): void {
    conn.closed = true
  }

  async handleMessage(conn: HubConnection, raw: string): Promise<void> {
    if (conn.closed) return
    let msg: ClientMessage
    try {
      msg = ClientMessageSchema.parse(JSON.parse(raw))
    } catch {
      if (!conn.principal) {
        if (conn.authTimer) clearTimeout(conn.authTimer)
        conn.authTimer = null
        conn.socket.close(4400, 'bad message')
      }
      return
    }

    if (!conn.principal) {
      if (conn.authTimer) clearTimeout(conn.authTimer)
      conn.authTimer = null
      if (msg.type !== 'auth') {
        conn.socket.close(4401, 'auth required')
        return
      }
      const principal = await authenticateToken(this.pool, msg.token)
      if (conn.closed) return
      if (!principal) {
        conn.socket.close(4401, 'invalid token')
        return
      }
      conn.principal = principal
      const previous = this.conns.get(principal.userId)
      this.conns.set(principal.userId, conn)
      if (previous && previous !== conn) previous.socket.close(4000, 'replaced')
      this.send(conn, { type: 'auth_ok', handle: principal.handle })
      await recordEvent(this.pool, { actorUserId: principal.userId, kind: 'responder_connected' })
      await this.pump(principal.userId)
      return
    }

    if (msg.type === 'answer') await this.acceptAnswer(conn, msg)
  }

  async handleClose(conn: HubConnection): Promise<void> {
    conn.closed = true
    if (conn.authTimer) clearTimeout(conn.authTimer)
    const principal = conn.principal
    if (!principal) return
    if (this.conns.get(principal.userId) === conn) this.conns.delete(principal.userId)
    const open = conn.openAttempt
    conn.openAttempt = null
    if (open) await this.requeue(open)
    await this.pump(principal.userId)
  }

  isOnline(userId: string): boolean {
    return this.conns.has(userId)
  }

  pump(responderId: string): Promise<void> {
    const previous = this.chains.get(responderId) ?? Promise.resolve()
    const next = previous
      .then(() => this.dispatchNext(responderId))
      .catch((err: unknown) => console.error('[hub] dispatch failed', err))
    this.chains.set(responderId, next)
    return next
  }

  async closeAttempt(responderId: string, attemptId: string, reason: 'timeout' | 'revoked'): Promise<void> {
    const conn = this.conns.get(responderId)
    if (conn?.openAttempt?.attemptId === attemptId) {
      conn.openAttempt = null
      this.send(conn, { type: 'cancel', attemptId, reason })
    }
    await this.pump(responderId)
  }

  waitForTicket(ticketId: string, timeoutMs: number): { promise: Promise<void>; cancel(): void } {
    let done: () => void = () => {}
    const promise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => done(), Math.max(0, timeoutMs))
      done = () => {
        clearTimeout(timer)
        this.waiters.off(ticketId, done)
        resolve()
      }
      this.waiters.on(ticketId, done)
    })
    return { promise, cancel: () => done() }
  }

  notifyTicket(ticketId: string): void {
    this.waiters.emit(ticketId)
  }

  private send(conn: HubConnection, msg: ServerMessage): void {
    try {
      conn.socket.send(JSON.stringify(msg))
    } catch (err) {
      console.error('[hub] send failed', err)
    }
  }

  private async dispatchNext(responderId: string): Promise<void> {
    const conn = this.conns.get(responderId)
    if (!conn?.principal || conn.openAttempt) return
    const deviceId = conn.principal.deviceId
    const code = newQuestionCode()
    const timeoutSeconds = (this.opts.attemptTimeoutMs ?? LIMITS.attemptTimeoutMs) / 1000

    const dispatched = await withTx(this.pool, async (c) => {
      const r = await c.query<{ id: string; question: string; handle: string; display_name: string }>(
        `select t.id, t.question, u.handle, u.display_name
           from tickets t
           join users u on u.id = t.asker_id
           join grants g on g.id = t.grant_id and g.revoked_at is null
          where t.responder_id = $1 and t.status = 'queued' and t.expires_at > now()
          order by t.created_at
          limit 1
          for update of t skip locked`,
        [responderId],
      )
      const row = r.rows[0]
      if (!row) return null
      const a = await c.query<{ id: string }>(
        `insert into attempts (ticket_id, device_id, code, deadline_at)
         values ($1, $2, $3, now() + make_interval(secs => $4)) returning id`,
        [row.id, deviceId, code, timeoutSeconds],
      )
      const attemptId = a.rows[0]!.id
      await c.query(
        `update tickets set status = 'dispatched', dispatched_at = coalesce(dispatched_at, now()) where id = $1`,
        [row.id],
      )
      await recordEvent(c, { ticketId: row.id, actorUserId: responderId, kind: 'dispatched', detail: { attemptId } })
      return { attemptId, ticketId: row.id, question: row.question, handle: row.handle, displayName: row.display_name }
    })

    if (!dispatched) return
    if (this.conns.get(responderId) !== conn) {
      await this.requeue({ attemptId: dispatched.attemptId, ticketId: dispatched.ticketId, code })
      return
    }
    conn.openAttempt = { attemptId: dispatched.attemptId, ticketId: dispatched.ticketId, code }
    this.send(conn, {
      type: 'question',
      attemptId: dispatched.attemptId,
      code,
      from: { handle: dispatched.handle, displayName: dispatched.displayName },
      question: dispatched.question,
    })
  }

  private async acceptAnswer(conn: HubConnection, msg: Extract<ClientMessage, { type: 'answer' }>): Promise<void> {
    const principal = conn.principal!
    const open = conn.openAttempt
    if (!open || open.attemptId !== msg.attemptId) {
      this.send(conn, { type: 'answer_rejected', attemptId: msg.attemptId, reason: 'not_in_flight' })
      return
    }
    if (open.code !== msg.code) {
      this.send(conn, { type: 'answer_rejected', attemptId: msg.attemptId, reason: 'wrong_code' })
      return
    }
    const stored = await withTx(this.pool, async (c) => {
      const closed = await c.query(
        `update attempts set closed_at = now(), outcome = 'answered' where id = $1 and closed_at is null`,
        [open.attemptId],
      )
      if (closed.rowCount === 0) return false
      const t = await c.query<{ created_at: Date }>(
        `update tickets
            set status = 'answered', answer = $2, answer_source = $3, answer_confidence = $4, answered_at = now()
          where id = $1 and status = 'dispatched'
          returning created_at`,
        [open.ticketId, msg.text, msg.source, msg.confidence],
      )
      if (t.rowCount === 0) return false
      await recordEvent(c, {
        ticketId: open.ticketId,
        actorUserId: principal.userId,
        kind: 'answered',
        detail: { attemptId: open.attemptId, confidence: msg.confidence, latencyMs: Date.now() - t.rows[0]!.created_at.getTime() },
      })
      return true
    })
    conn.openAttempt = null
    if (stored) {
      this.send(conn, { type: 'answer_accepted', attemptId: msg.attemptId })
      this.notifyTicket(open.ticketId)
    } else {
      this.send(conn, { type: 'answer_rejected', attemptId: msg.attemptId, reason: 'not_in_flight' })
    }
    await this.pump(principal.userId)
  }

  private async requeue(open: OpenAttempt): Promise<void> {
    await withTx(this.pool, async (c) => {
      const r = await c.query(
        `update attempts set closed_at = now(), outcome = 'disconnected' where id = $1 and closed_at is null`,
        [open.attemptId],
      )
      if (r.rowCount === 0) return
      await c.query(`update tickets set status = 'queued' where id = $1 and status = 'dispatched'`, [open.ticketId])
      await recordEvent(c, { ticketId: open.ticketId, kind: 'requeued', detail: { attemptId: open.attemptId } })
    })
  }
}
