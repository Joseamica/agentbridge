// scripts/measure-pow.mjs — how long a real connection request takes to mine, on one lane and on
// the default lanes. Three samples each, median reported: a single sample of a toy event is not
// comparable to the 16 487 ms plan 1 measured against public relays.
import { defaultMiningWorkers, mineEvent } from '../packages/core/src/envelope/pow.ts'
import { createRumor, wrapRumor } from '../packages/core/src/envelope/seal.ts'
import { NOSTR, nowSeconds } from '../packages/core/src/nostr-constants.ts'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'

const secretKey = generateSecretKey()
const identity = { secretKey, publicKey: getPublicKey(secretKey) }
const recipient = getPublicKey(generateSecretKey())
// The event a connect_request really mines: a sealed, encrypted wrap, not a short string.
const rumor = createRumor(
  { v: 1, type: 'connect_request', requestId: crypto.randomUUID(), name: 'Medición', note: 'x'.repeat(200), relays: ['wss://relay.example.com'] },
  identity,
  nowSeconds(),
)
const wrap = await wrapRumor(rumor, identity, recipient, { now: nowSeconds() })
const unsigned = { pubkey: wrap.pubkey, created_at: wrap.created_at, kind: wrap.kind, tags: [], content: wrap.content }

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
for (const workers of [1, defaultMiningWorkers()]) {
  const samples = []
  for (let i = 0; i < 3; i++) {
    const started = Date.now()
    await mineEvent({ ...unsigned, created_at: unsigned.created_at - i }, NOSTR.powRequestBits, { workers })
    samples.push(Date.now() - started)
  }
  console.log(`[pow] 22 bits with ${workers} worker(s): median ${median(samples)} ms of ${samples.join(', ')}`)
}
