import { UserFacingError } from '../errors'
import type { Store } from './db'

// The five public relays that accepted, served and kept sealed wraps in the 2026-09-16 live check
// — except relay.nostr.net, swapped for relay.damus.io on 2026-09-19 after a direct probe: its
// WebSocket handshake answered HTTP 500 (down, not merely refusing an unknown publisher), while
// relay.damus.io accepted and served a real 16-bit-wrap publish on the same probe. `doctor`
// checks every board here on every run — re-probe before swapping any of these again.
export const DEFAULT_RELAYS: readonly string[] = [
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://relay.damus.io',
  'wss://nostr.oxtr.dev',
  'wss://nos.lol',
]

export type Profile = { name: string | null; relays: string[] }

export const REQUEST_NOTICE_INTERVAL_SECONDS = 600

const NAME_KEY = 'profile.name'
const RELAYS_KEY = 'profile.relays'
const REQUEST_NOTICE_KEY = 'notice.requests_at'
const REQUEST_NOTICE_PENDING_KEY = 'notice.requests_pending'

export function getSetting(store: Store, key: string): string | null {
  const row = store.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(store: Store, key: string, value: string, now: number): void {
  store.tx(() => {
    store.db
      .prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(key, value, now)
  })
}

export function getProfile(store: Store): Profile {
  let stored: unknown[] = []
  const raw = getSetting(store, RELAYS_KEY)
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) stored = parsed
    } catch {
      stored = []
    }
  }
  const relays = store.relayPolicy(stored)
  return { name: getSetting(store, NAME_KEY), relays: relays.length > 0 ? relays : [...DEFAULT_RELAYS] }
}

export function setProfile(store: Store, input: { name?: string; relays?: readonly unknown[]; now: number }): Profile {
  store.tx(() => {
    if (input.name !== undefined) {
      const name = input.name.trim()
      if (name.length === 0 || name.length > 80) throw new UserFacingError('Tu nombre debe tener entre 1 y 80 caracteres.')
      setSetting(store, NAME_KEY, name, input.now)
    }
    if (input.relays !== undefined) {
      const relays = store.relayPolicy(input.relays)
      if (relays.length === 0) {
        throw new UserFacingError('Necesitas al menos un tablero válido: una dirección que empiece con wss://.')
      }
      setSetting(store, RELAYS_KEY, JSON.stringify(relays), input.now)
    }
  })
  return getProfile(store)
}

// Whichever process stores a new request marks a notice as pending, so the channel can show it even
// when a CLI sync stored the request first.
export function markRequestNoticePending(store: Store, now: number): void {
  setSetting(store, REQUEST_NOTICE_PENDING_KEY, '1', now)
}

export function clearRequestNoticePending(store: Store, now: number): void {
  setSetting(store, REQUEST_NOTICE_PENDING_KEY, '0', now)
}

// At most one new-request notification every 10 minutes per identity, and only while one is pending.
// Both live in SQLite, so every process on the machine shares them.
export function claimRequestNoticeSlot(store: Store, now: number): boolean {
  return store.tx(() => {
    if (getSetting(store, REQUEST_NOTICE_PENDING_KEY) !== '1') return false
    const last = Number(getSetting(store, REQUEST_NOTICE_KEY) ?? '0')
    if (Number.isFinite(last) && now - last < REQUEST_NOTICE_INTERVAL_SECONDS) return false
    setSetting(store, REQUEST_NOTICE_KEY, String(now), now)
    clearRequestNoticePending(store, now)
    return true
  })
}
