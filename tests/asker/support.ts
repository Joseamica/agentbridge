import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyApproval,
  approveConnection,
  createOutboundRequest,
  getContact,
  listRequests,
  nowSeconds,
  openStore,
  setProfile,
  type Identity,
  type Store,
} from '@agentbridge/core'
import { AskerService } from '../../packages/cli/src/asker/service'
import { allowAnyRelay, plainSocketFactory, seedApprovedContact, type Cleanups, type ResponderHarness } from '../responder/support'

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
