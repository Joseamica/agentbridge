import { agentbridgeHome } from '@agentbridge/core'
import { consoleOutput } from './context'
import { run } from './router'

process.exitCode = await run(process.argv.slice(2), { home: agentbridgeHome(), out: consoleOutput, env: process.env })
