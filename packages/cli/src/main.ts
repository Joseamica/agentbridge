import { agentbridgeHome } from '@agentbridge/core'
import { closePrompt, consoleOutput, readlinePrompt } from './context'
import { run } from './router'

// `prompt` is only wired up when stdin is a real interactive TTY. `setup` is the one command
// that needs it; when it is undefined, `setup` reports (in Spanish) that it needs an
// interactive terminal instead of trying to read from stdin and hanging.
process.exitCode = await run(process.argv.slice(2), {
  home: agentbridgeHome(),
  out: consoleOutput,
  env: process.env,
  prompt: process.stdin.isTTY ? readlinePrompt : undefined,
})
// Closes the readline interface opened lazily by readlinePrompt, if `setup` ever asked
// anything — otherwise this process would hang open on stdin instead of exiting.
closePrompt()
