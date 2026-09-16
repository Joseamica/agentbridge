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
