import { createInterface } from 'node:readline/promises'
import { setTimeout as delay } from 'node:timers/promises'

// Printed BEFORE anything reads stdin, followed by a fixed pause: while asleep here, this
// process holds no read handle on the inherited fd at all, so the line the driving test writes
// right after seeing this marker can only be picked up by whichever OTHER process is still
// reading — the parent, if `defaultInteractiveRunner` failed to pause it. Without this gap, the
// line landed in a genuine race between this process's own readline and the still-flowing
// parent's; measured at 4 timeouts out of 8 runs with pause/resume gutted, i.e. a coin flip, not
// a test. See interactive.test.ts.
console.log('CHILD_READY')
await delay(250)

const rl = createInterface({ input: process.stdin, output: process.stdout })
const answer = await rl.question('C1: ')
console.log(`CHILD_1=${answer}`)
rl.close()
