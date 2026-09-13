import { describe, expect, it } from 'vitest'
import { RelayError, RelayHttpClient } from '@agentbridge/core'

type Call = { url: string; init: RequestInit }

function fakeFetch(status: number, body: unknown, calls: Call[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

function fakeFetchRaw(status: number, body: string, calls: Call[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(body, { status, headers: { 'content-type': 'text/plain' } })
  }) as typeof fetch
}

describe('RelayHttpClient', () => {
  it('sends the bearer token and JSON body when asking', async () => {
    const calls: Call[] = []
    const client = new RelayHttpClient({
      relayUrl: 'https://r.example.com/',
      token: 'tok',
      fetchImpl: fakeFetch(201, { ticketId: '3b241101-e2bb-4255-8caf-4136c566a962', status: 'queued' }, calls),
    })
    const res = await client.ask('dev', '¿hola?')
    expect(res.status).toBe('queued')
    expect(calls[0]!.url).toBe('https://r.example.com/v1/tickets')
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ to: 'dev', question: '¿hola?' })
  })

  it('caps the long-poll wait at 45 seconds', async () => {
    const calls: Call[] = []
    const view = {
      ticketId: '3b241101-e2bb-4255-8caf-4136c566a962', status: 'queued', to: 'dev', question: 'q',
      answer: null, source: null, confidence: null, createdAt: '2026-09-12T00:00:00.000Z', answeredAt: null, latencyMs: null,
    }
    const client = new RelayHttpClient({ relayUrl: 'https://r.example.com', token: 't', fetchImpl: fakeFetch(200, view, calls) })
    await client.ticket(view.ticketId, 120)
    expect(calls[0]!.url).toBe(`https://r.example.com/v1/tickets/${view.ticketId}?wait=45`)
  })

  it('turns relay error bodies into RelayError with status and code', async () => {
    const client = new RelayHttpClient({
      relayUrl: 'https://r.example.com',
      token: 't',
      fetchImpl: fakeFetch(403, { error: { code: 'not_allowed', message: 'No tienes permiso' } }, []),
    })
    const err = await client.ask('dev', 'q').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RelayError)
    expect((err as RelayError).status).toBe(403)
    expect((err as RelayError).code).toBe('not_allowed')
  })

  it('rejects non-JSON error response with RelayError', async () => {
    const client = new RelayHttpClient({
      relayUrl: 'https://r.example.com',
      token: 't',
      fetchImpl: fakeFetchRaw(502, '<html>Bad Gateway</html>', []),
    })
    const err = await client.ask('dev', 'q').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RelayError)
    expect((err as RelayError).status).toBe(502)
    expect((err as RelayError).code).toBe('http_error')
  })

  it('rejects non-JSON successful response with invalid_response RelayError', async () => {
    const client = new RelayHttpClient({
      relayUrl: 'https://r.example.com',
      token: 't',
      fetchImpl: fakeFetchRaw(200, 'not json', []),
    })
    const err = await client.ask('dev', 'q').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RelayError)
    expect((err as RelayError).status).toBe(200)
    expect((err as RelayError).code).toBe('invalid_response')
  })

  it('health and enroll never send authorization header even with token', async () => {
    const calls: Call[] = []
    const client = new RelayHttpClient({
      relayUrl: 'https://r.example.com',
      token: 'tok',
      fetchImpl: fakeFetch(200, { handle: 'dev', displayName: 'Developer' }, calls),
    })
    await client.health()
    const healthCall = calls[0]
    expect((healthCall!.init.headers as Record<string, string> | undefined)?.authorization).toBeUndefined()

    calls.length = 0
    const enrollFetch = fakeFetch(200, { deviceToken: 'dt', handle: 'dev', displayName: 'Developer' }, calls)
    const enrollClient = new RelayHttpClient({ relayUrl: 'https://r.example.com', token: 'tok', fetchImpl: enrollFetch })
    await enrollClient.enroll('CODE1234', 'mac')
    const enrollCall = calls[0]
    expect((enrollCall!.init.headers as Record<string, string> | undefined)?.authorization).toBeUndefined()
  })
})
