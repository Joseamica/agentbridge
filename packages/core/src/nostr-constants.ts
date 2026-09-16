const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// Every number the 0.2 protocol fixes (docs/superpowers/specs/2026-09-16-nostr-transport-design.md).
// Durations are in seconds, sizes in bytes.
export const NOSTR = {
  wrapKind: 1059,
  sealKind: 13,
  // Never published: it only exists inside a seal. Deliberately not 14, so a NIP-17 chat app
  // pointed at an AgentBridge key does not render our JSON as a conversation.
  rumorKind: 8059,
  powMessageBits: 16,
  powRequestBits: 22,
  maxWrapBytes: 64 * 1024,
  maxSealBytes: 40 * 1024,
  maxRumorBytes: 28 * 1024,
  maxTextBytes: 16 * 1024,
  futureToleranceSeconds: 10 * MINUTE,
  randomizationSeconds: 2 * DAY,
  wrapExpirationSeconds: 7 * DAY,
  questionTtlSeconds: DAY,
  requestMaxAgeSeconds: 7 * DAY,
  contentRetentionSeconds: 7 * DAY,
  decisionRetentionSeconds: 9 * DAY,
  maxRelaysPerContact: 5,
  maxRelayUrlLength: 200,
  maxPendingRequests: 20,
  rejectedRequestCooldownSeconds: 7 * DAY,
  receiveQueueMax: 200,
  historyDays: 9,
  historyPageLimits: [200, 400, 800],
  claimSeconds: 2 * MINUTE,
  regenerationIntervalSeconds: 10 * MINUTE,
  maxPendingBytesPerRecipient: 1024 * 1024,
  maxPendingBytesPerIdentity: 20 * 1024 * 1024,
  capPostponeSeconds: 10 * MINUTE,
  maxPublishesPerMinute: 60,
  retryFirstHourIntervalSeconds: 5 * MINUTE,
  retryAfterFirstHourIntervalSeconds: 30 * MINUTE,
  retryWindowSeconds: 7 * DAY,
  liveSinceSeconds: 2 * DAY + 10 * MINUTE,
  // History recovery assumes relays honor filter limits of at least this many events. A relay that
  // caps lower can hide same-second ties from history (see Task 15).
  minTrustedRelayLimit: 100,
} as const

export const nowSeconds = (): number => Math.floor(Date.now() / 1000)
