import {
  ContactsViewSchema,
  LIMITS,
  TicketViewSchema,
  type ContactsView,
  type TicketView,
} from './protocol'

export class RelayError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'RelayError'
  }
}

type Options = { relayUrl: string; token?: string; fetchImpl?: typeof fetch }

export class RelayHttpClient {
  private readonly base: string
  private readonly token?: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: Options) {
    this.base = opts.relayUrl.replace(/\/+$/, '')
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  private async request<T>(method: string, path: string, body?: unknown, bearer: string | null | undefined = this.token): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (bearer !== null && bearer !== undefined) headers.authorization = `Bearer ${bearer}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let data: unknown
    try {
      data = text ? (JSON.parse(text) as unknown) : undefined
    } catch {
      if (!res.ok) {
        throw new RelayError(res.status, 'http_error', `HTTP ${res.status}`)
      }
      throw new RelayError(res.status, 'invalid_response', 'Respuesta inválida del relay')
    }
    if (!res.ok) {
      const e = (data as { error?: { code?: string; message?: string } } | undefined)?.error
      throw new RelayError(res.status, e?.code ?? 'http_error', e?.message ?? `HTTP ${res.status}`)
    }
    return data as T
  }

  async health(): Promise<boolean> {
    try {
      await this.request('GET', '/health', undefined, null)
      return true
    } catch {
      return false
    }
  }

  adminCreateEnrollment(adminToken: string, handle: string, displayName: string) {
    return this.request<{ enrollUrl: string; expiresAt: string }>(
      'POST', '/v1/admin/enrollments', { handle, displayName }, adminToken,
    )
  }

  enroll(code: string, deviceName: string) {
    return this.request<{ deviceToken: string; handle: string; displayName: string }>(
      'POST', '/v1/enroll', { code, deviceName }, null,
    )
  }

  me() {
    return this.request<{ handle: string; displayName: string }>('GET', '/v1/me')
  }

  createInvite() {
    return this.request<{ acceptUrl: string; expiresAt: string }>('POST', '/v1/contact-invites', {})
  }

  acceptInvite(code: string) {
    return this.request<{ responder: { handle: string; displayName: string } }>(
      'POST', '/v1/contact-invites/accept', { code },
    )
  }

  async contacts(): Promise<ContactsView> {
    return ContactsViewSchema.parse(await this.request('GET', '/v1/contacts'))
  }

  async revoke(askerHandle: string): Promise<void> {
    await this.request('DELETE', `/v1/grants/${encodeURIComponent(askerHandle)}`)
  }

  ask(to: string, question: string) {
    return this.request<{ ticketId: string; status: 'queued' }>('POST', '/v1/tickets', { to, question })
  }

  async ticket(ticketId: string, waitSeconds = 0): Promise<TicketView> {
    const wait = Math.max(0, Math.min(LIMITS.longPollMaxSeconds, Math.floor(waitSeconds)))
    return TicketViewSchema.parse(
      await this.request('GET', `/v1/tickets/${encodeURIComponent(ticketId)}?wait=${wait}`),
    )
  }
}
