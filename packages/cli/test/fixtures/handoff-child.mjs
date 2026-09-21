import { createInterface } from 'node:readline/promises'

const rl = createInterface({ input: process.stdin, output: process.stdout })
const answer = await rl.question('C1: ')
console.log(`CHILD_1=${answer}`)
rl.close()
