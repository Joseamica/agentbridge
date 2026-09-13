import { RelayHttpClient, readConfig, type ClientConfig } from '@agentbridge/core'

export type Output = { log(message: string): void; error(message: string): void }

export const consoleOutput: Output = {
  log: (message) => process.stdout.write(`${message}\n`),
  error: (message) => process.stderr.write(`${message}\n`),
}

export function memoryOutput(): Output & { lines: string[]; errors: string[] } {
  const lines: string[] = []
  const errors: string[] = []
  return { lines, errors, log: (m) => lines.push(m), error: (m) => errors.push(m) }
}

export type CliContext = { home: string; out: Output; env: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }

export class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliError'
  }
}

// readConfig() only turns a missing file into null; a config.json that exists but is not
// valid JSON (or not shaped like a ClientConfig) rethrows the raw parse error. Wrap it here
// so every command sees a Spanish, actionable message instead of a raw parser error — and
// never echo the file's contents, since it holds the device token.
// Takes only `{ home }` (rather than the full CliContext) so callers that only have a home
// directory string — like doctor, which inspects a responder's home, not the caller's own —
// can reuse this instead of hand-rolling their own version that risks leaking file contents.
export async function tryReadConfig(ctx: { home: string }): Promise<ClientConfig | null> {
  try {
    return await readConfig(ctx.home)
  } catch {
    throw new CliError(
      `No se pudo leer la configuración en ${ctx.home}/config.json (el archivo está dañado). Bórralo y vuelve a dar de alta este dispositivo con: agentbridge enroll <enlace>`,
    )
  }
}

export async function requireConfig(ctx: CliContext): Promise<ClientConfig> {
  const config = await tryReadConfig(ctx)
  if (!config) {
    throw new CliError(`Este dispositivo no está dado de alta en ${ctx.home}. Pide un enlace y ejecuta: agentbridge enroll <enlace>`)
  }
  return config
}

export function clientFor(ctx: CliContext, config: ClientConfig): RelayHttpClient {
  return new RelayHttpClient({ relayUrl: config.relayUrl, token: config.deviceToken, fetchImpl: ctx.fetchImpl })
}
