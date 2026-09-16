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
