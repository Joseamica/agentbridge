import { agentbridgeHome, readConfig } from '@agentbridge/core'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createChannelServer } from './channel'
import { RelayWsClient } from './relay-client'

const log = (message: string) => process.stderr.write(`[agentbridge] ${message}\n`)

const home = agentbridgeHome()
const config = await readConfig(home)
if (!config) {
  log(`no config at ${home}/config.json; enroll this device first with: agentbridge enroll <link>`)
  process.exit(1)
}

const relay = new RelayWsClient({ relayUrl: config.relayUrl, token: config.deviceToken, log })
relay.onConnected((handle) => log(`connected to ${config.relayUrl} as ${handle}`))
// RelayWsClient.stop() now emits its own disconnect event (see relay-client.ts), so this
// fires on a deliberate shutdown too — not only on an unexpected drop. `stopping` is set
// below, before stop() is called, so the message told to the person running this stays true
// either way instead of always claiming a reconnect is coming.
let stopping = false
relay.onDisconnect(() => log(stopping ? 'relay connection closed' : 'relay connection lost; reconnecting'))

const { server } = createChannelServer(relay)
await server.connect(new StdioServerTransport())
relay.start()

const shutdown = () => {
  stopping = true
  relay.stop()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
