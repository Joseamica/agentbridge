import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type ClientConfig = {
  relayUrl: string
  deviceToken: string
  handle: string
  displayName: string
}

export function agentbridgeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTBRIDGE_HOME ?? join(homedir(), '.agentbridge')
}

export async function readConfig(home: string = agentbridgeHome()): Promise<ClientConfig | null> {
  try {
    return JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as ClientConfig
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function writeConfig(config: ClientConfig, home: string = agentbridgeHome()): Promise<string> {
  await mkdir(home, { recursive: true, mode: 0o700 })
  await chmod(home, 0o700)
  const file = join(home, 'config.json')
  await writeFile(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  await chmod(file, 0o600)
  return file
}
