// An error whose message is written for the person using AgentBridge, in Spanish, and is safe to
// print as-is: it never contains keys, decrypted third-party content or shared-folder paths.
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserFacingError'
  }
}

// For logs and tool results about unexpected failures. Messages from SQLite, zod or a message handler
// can carry decrypted third-party content, keys or file paths, so only the error's type and a short
// error code are reported. A UserFacingError was written to be shown and keeps its message.
export function describeError(err: unknown): string {
  if (err instanceof UserFacingError) return err.message
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(code) ? `${err.name} (${code})` : err.name
  }
  return 'non-error value thrown'
}
