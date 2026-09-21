import { spawn } from 'node:child_process'
import { pausePrompt, resumePrompt } from './context'

// A child that takes over the terminal: its stdin, stdout and stderr ARE ours, so whoever is
// sitting at the keyboard is talking to it directly — no pipe in the middle, no output of ours
// interleaved with its own. This is how `setup` runs Claude's login and the responder itself
// instead of printing a command line and hoping the person pastes it correctly into the right
// shell. `code` is null when the process was killed by a signal (Ctrl+C on the child) or never
// started; `spawnFailed` separates "the binary is not installed" from "it ran and failed",
// because those two need very different sentences in Spanish.
export type InteractiveRunner = (
  command: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd?: string },
) => Promise<{ code: number | null; spawnFailed: boolean }>

export const defaultInteractiveRunner: InteractiveRunner = (command, args, opts) =>
  new Promise((resolvePromise) => {
    // Captured before touching anything: this is the state to return to, not a fixed one.
    // `readline.createInterface` puts a TTY's stdin into raw mode at construction and NEVER
    // takes it back out on pause/resume (verified against a real pty) — so whenever a shared
    // prompt interface exists, raw is the correct state, not cooked. Forcing cooked
    // unconditionally was tried first and broke the flagship flow: after the handoff, every
    // later question echoed the typed answer twice (once by the tty driver, once by readline)
    // and readline's own line editing — backspace, history — stopped working, because the
    // driver was handling the keystrokes instead. `false` remains correct for the case this
    // guards against — a crashed child leaving the tty raw while no interface exists to need it.
    const wasRaw = process.stdin.isTTY ? process.stdin.isRaw === true : false
    // Released BEFORE the spawn, not after: a readline interface that is still flowing competes
    // with the child for every keystroke, and the line the child asked for would be eaten by a
    // parent nobody is talking to.
    pausePrompt()
    let settled = false
    const finish = (result: { code: number | null; spawnFailed: boolean }) => {
      if (settled) return
      settled = true
      // Restores the captured state, not a fixed one: a crashed or killed child can leave the
      // terminal raw when it should be cooked, but a parent with an open readline interface
      // needs it RAW to keep working — see the comment on `wasRaw` above.
      try {
        if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw)
      } catch {
        // A terminal we cannot put back is still a terminal we must not crash on.
      }
      resumePrompt()
      resolvePromise(result)
    }
    // No `shell: true`: args reach the child as an argv array, so nothing we pass — a folder
    // with a space, a model id, a path with an apostrophe — can be reinterpreted by a shell.
    // This is also what makes the whole plan work identically on Windows, where the shell is
    // not the one we would have quoted for.
    const child = spawn(command, args, { env: opts.env, cwd: opts.cwd, stdio: 'inherit' })
    child.on('error', () => finish({ code: null, spawnFailed: true }))
    child.on('exit', (code) => finish({ code, spawnFailed: false }))
  })
