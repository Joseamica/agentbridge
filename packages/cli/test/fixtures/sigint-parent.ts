import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { defaultInteractiveRunner } from '../../src/interactive'

// Drives the REAL runner, in its own process group (the test spawns this `detached`), so the test
// can send SIGINT to the whole group the way a terminal does and watch what survives. There is no
// pseudo-terminal in `npm test`, so this cannot exercise the cooked/raw half — but the half that
// decides whether the CLI lives long enough to say anything is signal handling, and that works
// over a pipe exactly as it does over a tty.

const child = join(dirname(fileURLToPath(import.meta.url)), 'sigint-child.mjs')
console.log('PARENT_SPAWNING')
const { code, spawnFailed } = await defaultInteractiveRunner(process.execPath, [child], { env: process.env })
// If this process had taken the group's SIGINT itself — which is what Node does by default, and
// what used to happen here — neither of these lines would ever be printed.
console.log(`CHILD_EXIT=${code} SPAWN_FAILED=${spawnFailed}`)
console.log('PARENT_ALIVE')
// And the ignore is only for the handoff: by now SIGINT must be Node's own default again, or the
// CLI would be unkillable for the rest of its life.
console.log(`SIGINT_LISTENERS=${process.listenerCount('SIGINT')}`)
