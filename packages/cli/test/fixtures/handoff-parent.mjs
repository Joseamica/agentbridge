import { createInterface } from 'node:readline/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const rl = createInterface({ input: process.stdin, output: process.stdout })
let closed = false
rl.on('close', () => {
  closed = true
})

const first = await rl.question('P1: ')
console.log(`PARENT_1=${first}`)

rl.pause()
process.stdin.pause()

const child = join(dirname(fileURLToPath(import.meta.url)), 'handoff-child.mjs')
const code = await new Promise((resolvePromise) => {
  const proc = spawn(process.execPath, [child], { stdio: 'inherit' })
  proc.on('exit', (c) => resolvePromise(c))
})
console.log(`CHILD_EXIT=${code}`)

process.stdin.resume()
rl.resume()
console.log(`CLOSED=${closed}`)

const second = await rl.question('P2: ')
console.log(`PARENT_2=${second}`)
rl.close()
