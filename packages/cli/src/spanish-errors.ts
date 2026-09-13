import type { z } from 'zod'

// Node's fetch (undici) always surfaces a network failure (connection refused, DNS
// failure, unreachable host, or the relay simply not running) as a plain
// `TypeError: fetch failed`. This is the single most likely real failure in normal use —
// a relay restart, a DNS hiccup, a typo'd --relay URL — so every place that talks to the
// relay must turn it into this same Spanish, expected message instead of leaking the raw
// English error. Shared by the CLI router (packages/cli/src/router.ts) and the asker MCP
// server (packages/cli/src/mcp-asker.ts); the channel package is a separate workspace and
// is not covered here.
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError && err.message === 'fetch failed'
}

export const RELAY_UNREACHABLE_ES =
  'No se pudo conectar con el relay. Revisa que la URL sea correcta (--relay o AGENTBRIDGE_RELAY_URL) y que el relay esté corriendo.'

// zod's own issue messages are English ("Too big: expected string to have <=4000
// characters", "Invalid input: expected string, received undefined"). Never surface them
// on a user-facing Spanish channel: report only which fields were invalid, never zod's own
// wording — the same shape already used by the channel package's reply tool (Task 12).
export function zodFieldsMessage(err: z.ZodError): string {
  const fields = Array.from(new Set(err.issues.map((i) => (i.path.length ? i.path.join('.') : 'cuerpo'))))
  return `Argumentos inválidos en: ${fields.join(', ')}`
}
