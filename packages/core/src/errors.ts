// An error whose message is written for the person using AgentBridge, in Spanish, and is safe to
// print as-is: it never contains keys, decrypted third-party content or shared-folder paths.
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserFacingError'
  }
}
