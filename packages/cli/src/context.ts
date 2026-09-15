import { RelayHttpClient, readConfig, type ClientConfig } from '@agentbridge/core'
import { createInterface } from 'node:readline/promises'

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

// A single question-and-answer round trip with whoever is running the CLI. `setup` is the only
// command that needs this today. Kept as a plain function type (not a class or an object with
// a `close()` method) so tests can drive it with a queue of scripted answers without having to
// fake a readline interface.
export type Prompt = (question: string) => Promise<string>

// The real implementation, used only when stdin is an interactive TTY (see main.ts — it passes
// `prompt: undefined` otherwise, which is what lets `setup` detect a non-interactive run without
// ever touching process.stdin.isTTY itself). A single interface is created lazily on first use
// and reused for every later question in the same process — not recreated per call. Opening and
// closing a fresh interface around every single question was tried first and dropped: when more
// than one line is already sitting in stdin's read buffer, `readline/promises`'s `.question()`
// can hand the second buffered line to nobody, because the listener for it is only attached
// once that second `.question()` call is made, one microtask after the first line already
// resolved — by then the interface has moved on. A real person typing one answer at a time into
// a live terminal never fills stdin's buffer ahead of being asked, so this never bit an
// interactive TTY user, but a single long-lived interface is both immune to it and closer to
// Node's own documented usage of `.question()`.
let sharedPromptInterface: ReturnType<typeof createInterface> | null = null

export const readlinePrompt: Prompt = (question) => {
  sharedPromptInterface ??= createInterface({ input: process.stdin, output: process.stdout })
  return sharedPromptInterface.question(question)
}

// An open readline interface keeps stdin referenced, which keeps the process alive even after
// `run()` has resolved and `process.exitCode` is set — the process would otherwise hang instead
// of exiting on its own once an interactive `setup` finishes. main.ts calls this once, after
// `run()` returns, regardless of whether a prompt was ever actually asked (a no-op in that case,
// since `sharedPromptInterface` is still null).
export function closePrompt(): void {
  sharedPromptInterface?.close()
  sharedPromptInterface = null
}

export type CliContext = { home: string; out: Output; env: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; prompt?: Prompt }

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
