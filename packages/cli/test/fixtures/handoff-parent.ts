import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readlinePrompt, closePrompt } from '../../src/context'
import { defaultInteractiveRunner } from '../../src/interactive'

// Uses the REAL shared prompt interface and the REAL runner under test — not a standalone
// reimplementation of pause/spawn/resume — so this fixture actually exercises `pausePrompt` and
// `resumePrompt` from `../../src/context` and the module state they share with
// `defaultInteractiveRunner`. Runnable directly because `packages/cli/package.json` declares
// `"type": "module"`, which lets `tsx` treat this file as ESM (and top-level await as legal).

const first = await readlinePrompt('P1: ')
console.log(`PARENT_1=${first}`)

const child = join(dirname(fileURLToPath(import.meta.url)), 'handoff-child.mjs')
const { code } = await defaultInteractiveRunner(process.execPath, [child], { env: process.env })
console.log(`CHILD_EXIT=${code}`)

// If pausing had tripped the shared interface's permanent-close flag, this would reject with
// PromptEOF instead of waiting for `tres` — that rejection, not a boolean snapshot of some other
// interface, is the actual failure mode this fixture needs to catch.
try {
  const second = await readlinePrompt('P2: ')
  console.log(`PARENT_2=${second}`)
} catch (err) {
  console.log(`PARENT_2_ERROR=${err instanceof Error ? err.name : String(err)}`)
}

closePrompt()
