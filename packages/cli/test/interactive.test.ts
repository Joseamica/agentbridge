import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultInteractiveRunner } from '../src/interactive'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

// Drives the parent fixture through a pipe, feeding each line only after the prompt that asks
// for it has been printed. Feeding all three up front would prove nothing: the question is
// precisely whether the child reads the second line instead of the paused parent swallowing it.
function driveHandoff(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(process.execPath, [join(fixtures, 'handoff-parent.mjs')], {
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
    // The whole point: pausing must not mark the interface permanently closed.
    expect(out).toContain('CLOSED=false')
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
