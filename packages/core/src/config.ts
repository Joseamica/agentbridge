import { homedir } from 'node:os'
import { join } from 'node:path'

// The single folder that holds this person's key and database. Everything else about the 0.1
// relay credential (config.json, the device token, the handle) went away with the relay itself.
export function agentbridgeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTBRIDGE_HOME ?? join(homedir(), '.agentbridge')
}
