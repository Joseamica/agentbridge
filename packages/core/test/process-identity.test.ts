import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { currentProcess, isProcessAlive, processStartTime, type ProcessCommandRunner } from '@agentbridge/core'

const run = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, '../../..')

const failingRunner: ProcessCommandRunner = () => {
  throw new Error('ps not available')
}

describe('process identity', () => {
  it('names this process by PID and start time', () => {
    const self = currentProcess()
    expect(self.pid).toBe(process.pid)
    expect(self.start).not.toBe('unverifiable')
    expect(self.start).toBe(processStartTime(process.pid))
    expect(isProcessAlive(self)).toBe(true)
  })

  it('reads the same start time whatever time zone or locale the reading process uses', async () => {
    const script = `import { processStartTime } from ${JSON.stringify(join(repoRoot, 'packages/core/src/process-identity.ts'))}
console.log(processStartTime(${process.pid}))`
    const { stdout } = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: repoRoot,
      env: { ...process.env, TZ: 'Asia/Tokyo', LC_ALL: 'ja_JP.UTF-8', LANG: 'ja_JP.UTF-8' },
    })
    expect(stdout.trim()).toBe(processStartTime(process.pid))
  })

  it('treats a PID now used by a different process start as gone', () => {
    expect(isProcessAlive({ pid: process.pid, start: 'Mon Jan 1 00:00:00 2001' })).toBe(false)
  })

  it('treats a finished process as gone', async () => {
    const child = execFile(process.execPath, ['-e', ''])
    const pid = child.pid!
    await new Promise((resolve) => child.once('exit', resolve))
    expect(isProcessAlive({ pid, start: 'whatever' })).toBe(false)
  })

  it('assumes a running process is alive when its start time cannot be verified', () => {
    expect(isProcessAlive({ pid: process.pid, start: 'unverifiable' })).toBe(true)
    expect(isProcessAlive({ pid: process.pid, start: 'Mon Jan 1 00:00:00 2001' }, failingRunner)).toBe(true)
    expect(currentProcess(failingRunner)).toEqual({ pid: process.pid, start: 'unverifiable' })
  })

  it('never probes non-positive PIDs', () => {
    expect(isProcessAlive({ pid: 0, start: '' })).toBe(false)
    expect(isProcessAlive({ pid: -1, start: '' })).toBe(false)
    expect(processStartTime(0)).toBeNull()
  })
})
