import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultInteractiveRunner } from '../src/interactive'

const testDir = dirname(fileURLToPath(import.meta.url))
const fixtures = join(testDir, 'fixtures')
// packages/cli/test -> packages/cli -> packages -> repo root. Resolved from this file's own
// location rather than `process.cwd()`, so the test behaves the same no matter where `npm test`
// is invoked from.
const tsxBin = join(testDir, '..', '..', '..', 'node_modules', '.bin', 'tsx')

// Drives the REAL parent fixture (handoff-parent.ts, which calls `readlinePrompt` and
// `defaultInteractiveRunner` directly — not a standalone reimplementation of pause/spawn/resume)
// through a pipe, feeding each line only after the prompt that asks for it has been printed.
// Feeding all three up front would prove nothing: the question is precisely whether the child
// reads the second line instead of the paused parent swallowing it. Run through `tsx`, not
// `node`, because the fixture imports straight from `../../src`, the way the CLI's own commands
// do — that is what makes this test exercise `defaultInteractiveRunner` itself instead of only
// the technique it is built on.
function driveHandoff(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(process.execPath, [tsxBin, join(fixtures, 'handoff-parent.ts')], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    const sent = new Set<string>()
    proc.stdout.on('data', (d) => {
      out += String(d)
      for (const [needle, line] of [
        ['P1: ', 'uno\n'],
        ['C1: ', 'dos\n'],
        ['P2: ', 'tres\n'],
      ] as const) {
        if (out.includes(needle) && !sent.has(needle)) {
          sent.add(needle)
          proc.stdin.write(line)
        }
      }
    })
    proc.on('error', reject)
    proc.on('exit', () => resolvePromise(out))
  })
}

describe('handing the terminal to a child and taking it back', () => {
  it('lets the child read its own line and leaves the parent able to ask again', async () => {
    const out = await driveHandoff()
    expect(out).toContain('PARENT_1=uno')
    // The line the child asked for reached the CHILD, not the paused parent.
    expect(out).toContain('CHILD_1=dos')
    expect(out).toContain('CHILD_EXIT=0')
    // The whole point: a second `readlinePrompt` after the handoff must get its answer, not
    // reject with PromptEOF — which is what pausing tripping the shared interface's
    // permanent-close flag would look like.
    expect(out).not.toContain('PARENT_2_ERROR')
    expect(out).toContain('PARENT_2=tres')
  }, 20_000)
})

describe('defaultInteractiveRunner', () => {
  it('returns the child exit code', async () => {
    const result = await defaultInteractiveRunner(process.execPath, ['-e', 'process.exit(7)'], { env: process.env })
    expect(result).toEqual({ code: 7, spawnFailed: false })
  })

  it('reports a command that does not exist instead of throwing', async () => {
    const result = await defaultInteractiveRunner('agentbridge-no-existe-jamas', [], { env: process.env })
    expect(result.spawnFailed).toBe(true)
    expect(result.code).toBeNull()
  })

  it('runs the child in the requested folder', async () => {
    const result = await defaultInteractiveRunner(process.execPath, ['-e', 'process.exit(process.cwd() === process.env.EXPECTED ? 0 : 1)'], {
      env: { ...process.env, EXPECTED: fixtures },
      cwd: fixtures,
    })
    expect(result.code).toBe(0)
  })
})
