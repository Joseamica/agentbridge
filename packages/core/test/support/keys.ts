import { getPublicKey } from 'nostr-tools/pure'
import type { Identity } from '../../src/identity'

// Deterministic, valid secp256k1 secret keys for tests. seed must be 1–255.
export function testIdentity(seed: number): Identity {
  if (!Number.isInteger(seed) || seed < 1 || seed > 255) throw new Error('seed must be an integer from 1 to 255')
  const secretKey = new Uint8Array(32)
  secretKey[0] = 1
  secretKey[31] = seed
  return { secretKey, publicKey: getPublicKey(secretKey) }
}
