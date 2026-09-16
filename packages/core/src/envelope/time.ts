import { NOSTR } from '../nostr-constants'

export const isFutureDated = (createdAt: number, now: number): boolean => createdAt > now + NOSTR.futureToleranceSeconds

// The sender cannot pick an expiry: it is derived from the rumor's own date, which is never allowed
// in the future and is reused unchanged by every retry.
export const questionExpiresAt = (rumorCreatedAt: number): number => rumorCreatedAt + NOSTR.questionTtlSeconds

export const isQuestionExpired = (rumorCreatedAt: number, now: number): boolean => now >= questionExpiresAt(rumorCreatedAt)

export const isRequestTooOld = (rumorCreatedAt: number, now: number): boolean => now - rumorCreatedAt > NOSTR.requestMaxAgeSeconds
