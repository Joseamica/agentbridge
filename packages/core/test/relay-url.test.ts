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
    'wss://localhost.',
    'wss://foo.localhost.',
    'wss://intranet',
    'not a url',
    `wss://${'a'.repeat(190)}.example.com`,
  ])('rejects %j with a Spanish reason', (input) => {
    const result = checkRelayUrl(input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/tablero/)
  })

  it.each(['wss://localhost.', 'wss://foo.localhost.'])('gives %j the same reason as a plain localhost', (input) => {
    expect(checkRelayUrl(input)).toEqual(checkRelayUrl('wss://localhost'))
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
    'fe80::1', 'ff02::1', '::8.8.8.8', 'fec0::1', '64:ff9b:1::a00:1', '2002:c000:204::1', '2001:0:53aa:64c::1', '2001:2::1',
    '3fff:fff::1', 'not-an-ip',
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
