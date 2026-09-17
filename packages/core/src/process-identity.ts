import { execFileSync } from 'node:child_process'

export type ProcessIdentity = { pid: number; start: string }
export type ProcessCommandRunner = (file: string, args: readonly string[]) => string

const UNVERIFIABLE = 'unverifiable'

// `ps` prints start times in the reader's time zone and locale. Two processes started with different
// TZ or LANG would read different strings for the same process and wrongly call a live owner dead, so
// every reader asks for the same fixed representation.
const runCommand: ProcessCommandRunner = (file, args) =>
  execFileSync(file, [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2_000,
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' },
  })

// The start time `ps` reports for a process, as an opaque string. With the PID it names exactly one
// process: a PID the system later reuses belongs to a process with a different start time.
export function processStartTime(pid: number, run: ProcessCommandRunner = runCommand): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const out = run('ps', ['-o', 'lstart=', '-p', String(pid)]).trim().replace(/\s+/g, ' ')
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

export function currentProcess(run: ProcessCommandRunner = runCommand): ProcessIdentity {
  return { pid: process.pid, start: processStartTime(process.pid, run) ?? UNVERIFIABLE }
}

// True when that exact process may still be running. Anything that cannot be verified counts as
// running: a second channel refuses to start rather than take the lock from a live owner.
export function isProcessAlive(holder: ProcessIdentity, run: ProcessCommandRunner = runCommand): boolean {
  if (!Number.isInteger(holder.pid) || holder.pid <= 0) return false
  try {
    process.kill(holder.pid, 0)
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false
  }
  if (holder.start === UNVERIFIABLE) return true
  const start = processStartTime(holder.pid, run)
  return start === null ? true : start === holder.start
}
