import { randomBytes } from 'node:crypto'
import { chmod, link, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decode, nprofileEncode } from 'nostr-tools/nip19'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { UserFacingError } from './errors'
import { NOSTR } from './nostr-constants'

export const IDENTITY_FILE = 'identity.json'
export const LINK_PREFIX = 'agentbridge:'

export type Identity = { secretKey: Uint8Array; publicKey: string }
export type DecodedLink = { publicKey: string; relays: string[] }

const HEX_64 = /^[0-9a-f]{64}$/

function damaged(file: string): UserFacingError {
  return new UserFacingError(`El archivo de identidad ${file} está dañado y no se puede leer.`)
}

function parseIdentityFile(raw: string, file: string): Identity {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw damaged(file)
  }
  const record = parsed as { version?: unknown; secretKey?: unknown } | null
  if (record?.version !== 1 || typeof record.secretKey !== 'string' || !HEX_64.test(record.secretKey)) throw damaged(file)
  const secretKey = Uint8Array.from(Buffer.from(record.secretKey, 'hex'))
  try {
    return { secretKey, publicKey: getPublicKey(secretKey) }
  } catch {
    throw damaged(file)
  }
}

export async function loadIdentity(home: string): Promise<Identity | null> {
  const file = join(home, IDENTITY_FILE)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  return parseIdentityFile(raw, file)
}

// Windows has no POSIX permission bits — `stat().mode` reports 666/777 there regardless of what
// chmod would do — so this only ever runs on POSIX. It only ever tightens: a mode that already
// has no bits outside `target` (0600 itself, or something stricter like 0400) is left exactly as
// it is, so a person who deliberately locked a file down further never gets it loosened back.
async function tightenIfTooOpen(path: string, target: number): Promise<void> {
  if (process.platform === 'win32') return
  const info = await stat(path).catch(() => null)
  if (!info) return
  const mode = info.mode & 0o777
  if ((mode & ~target) !== 0) await chmod(path, target)
}

// The key is written completely to a private temporary file first and then hard-linked into
// place. link() fails with EEXIST when identity.json already exists, so concurrent creators —
// threads or separate processes — can never leave two identities or a half-written file: the
// loser reads the winner's key.
export async function loadOrCreateIdentity(home: string): Promise<{ identity: Identity; created: boolean }> {
  const existing = await loadIdentity(home)
  if (existing) {
    // An identity created before this repair existed, or loosened by a sync client, a backup
    // restore, or a hand-edit, is tightened on the very next load rather than left to fail
    // `doctor`'s permission check forever. This is what lets that check's own remedy text
    // truthfully say "re-run setup" instead of naming a chmod command we are not allowed to print.
    await tightenIfTooOpen(home, 0o700)
    await tightenIfTooOpen(join(home, IDENTITY_FILE), 0o600)
    return { identity: existing, created: false }
  }
  await mkdir(home, { recursive: true, mode: 0o700 })
  await chmod(home, 0o700)
  const file = join(home, IDENTITY_FILE)
  const secretKey = generateSecretKey()
  const temp = join(home, `.identity-${process.pid}-${randomBytes(6).toString('hex')}.tmp`)
  await writeFile(temp, `${JSON.stringify({ version: 1, secretKey: Buffer.from(secretKey).toString('hex') })}\n`, {
    mode: 0o600,
    flag: 'wx',
  })
  try {
    await chmod(temp, 0o600)
    await link(temp, file)
    return { identity: { secretKey, publicKey: getPublicKey(secretKey) }, created: true }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    const winner = await loadIdentity(home)
    if (!winner) throw err
    return { identity: winner, created: false }
  } finally {
    await unlink(temp).catch(() => {})
  }
}

// A key that is generated, used once and never written anywhere. `doctor`'s board probe addresses
// its test envelope to this instead of to the person's own key, so the envelope is not addressed to
// them, none of their subscriptions fetch it, and nothing they own is written because of a
// diagnostic. Nobody can ever decrypt it: the secret is gone when the process ends.
export function ephemeralIdentity(): Identity {
  const secretKey = generateSecretKey()
  return { secretKey, publicKey: getPublicKey(secretKey) }
}

export function encodeLink(publicKey: string, relays: readonly string[]): string {
  if (!HEX_64.test(publicKey)) throw new Error('encodeLink: publicKey must be 64 lowercase hex characters')
  return `${LINK_PREFIX}${nprofileEncode({ pubkey: publicKey, relays: relays.slice(0, NOSTR.maxRelaysPerContact) })}`
}

// The relays in a link are an unsigned locator written by whoever shared it. They are returned
// as-is; every caller must pass them through sanitizeRelayList before storing or connecting.
export function decodeLink(input: string): DecodedLink {
  const invalid = new UserFacingError(
    'Ese enlace de AgentBridge no es válido. Pide que te lo copien completo: empieza con "agentbridge:nprofile1".',
  )
  const trimmed = input.trim()
  const code = trimmed.startsWith(LINK_PREFIX) ? trimmed.slice(LINK_PREFIX.length) : trimmed
  if (!code.startsWith('nprofile1') || code.length > 2000) throw invalid
  let decoded: ReturnType<typeof decode>
  try {
    decoded = decode(code)
  } catch {
    throw invalid
  }
  if (decoded.type !== 'nprofile' || !HEX_64.test(decoded.data.pubkey)) throw invalid
  return { publicKey: decoded.data.pubkey, relays: [...(decoded.data.relays ?? [])] }
}
