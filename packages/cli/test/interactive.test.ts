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
// through a pipe, feeding each line only after the prompt (or marker) that calls for it has
// appeared. Feeding all three up front would prove nothing: the question is precisely whether
// the child reads the second line instead of the paused parent swallowing it. Run through `tsx`,
// not `node`, because the fixture imports straight from `../../src`, the way the CLI's own
// commands do — that is what makes this test exercise `defaultInteractiveRunner` itself instead
// of only the technique it is built on.
//
// The child's line ('dos') is written as soon as `CHILD_READY` appears — BEFORE the child's own
// `C1: ` prompt — not when `C1: ` itself appears. Waiting for `C1: ` was tried first and measured
// dishonest: with `pausePrompt`/`resumePrompt` gutted to no-ops, both the child's own readline
// and the still-flowing parent's readline are simultaneously trying to read the same inherited
// fd, so whichever one issues its read first wins a genuine OS-level race — 4 timeouts out of 8
// runs, a coin flip. `handoff-child.mjs` prints `CHILD_READY` and then deliberately sleeps 250ms
// before creating its own readline interface at all; writing 'dos' the instant that marker shows
// up lands the byte in the pipe while the child provably holds no read handle on it yet. That
// makes a flowing parent the ONLY possible reader: if `defaultInteractiveRunner` paused it
// correctly, nothing reads the byte and the child picks it up once it wakes (test passes, every
// time); if the parent was left flowing, its readline consumes the byte, fires a `line` event
// nobody is listening for, and the child waits forever for a line that already came and went
// (test times out, every time).
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
        ['CHILD_READY', 'dos\n'],
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
