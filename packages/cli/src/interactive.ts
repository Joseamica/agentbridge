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

// The little of `process.stdin` this file touches. Taken as a parameter (see
// `makeInteractiveRunner`) so a test can hand it a fake and watch the order the REAL runner puts
// the terminal in and takes it back — `npm test` has no pseudo-terminal, so `process.stdin.isTTY`
// is false there and the terminal handling would otherwise be untestable entirely.
export type TtyLike = { isTTY?: boolean; isRaw?: boolean; setRawMode(mode: boolean): void }

function setRawMode(stdin: TtyLike, mode: boolean): void {
  if (!stdin.isTTY) return
  try {
    stdin.setRawMode(mode)
  } catch {
    // A terminal we cannot set is still a terminal we must not crash on.
  }
}

// Whole-branch review, Important 3: Ctrl+C used to mean two different things at the two ways into
// this same handoff, and neither of them was what a person means by it.
//
// - From `setup`, a readline interface is already open, which put the tty in RAW mode at
//   construction. Raw means ISIG off: Ctrl+C is not a signal at all, it is the byte 0x03 handed to
//   the child. Verified on a real pty — a child that does not read stdin swallows it and cannot be
//   interrupted AT ALL.
// - From the standalone `responder`, there is no interface, the tty is cooked, and Ctrl+C SIGINTs
//   the whole foreground process group: the child died and so did the CLI, before it could say a
//   word.
//
// Both entries now do the same thing, and it is the second shape made survivable: the tty is put
// into COOKED mode for the duration of the handoff, so Ctrl+C is a real signal (which is what the
// person means — stop what is on screen), and this process ignores that signal while the child
// owns the terminal, so the child takes it and stops while the CLI lives to say what happened.
// That is what makes `runResponder`'s "las que te lleguen mientras tanto se reintentan durante
// siete días" reachable instead of a branch no shape of the real world could enter. In practice
// Claude Code grabs raw mode itself about a second in and handles Ctrl+C on its own from there,
// exiting normally; the window this covers is the startup, which is exactly where the person is
// most likely to change their mind.
//
// Cooking here is NOT the change this file's own history rejected. That one forced cooked on the
// RESTORE, after the child was gone, and broke the flagship flow: with a readline interface open
// and the tty cooked, every later question echoed the typed answer twice (once by the tty driver,
// once by readline) and readline's line editing stopped working. The state captured in `wasRaw` is
// still what gets restored afterwards, which is what keeps that fixed.
export const makeInteractiveRunner =
  (stdin: TtyLike = process.stdin): InteractiveRunner =>
  (command, args, opts) =>
    new Promise((resolvePromise) => {
      // Captured before touching anything: this is the state to return to, not a fixed one.
      // `readline.createInterface` puts a TTY's stdin into raw mode at construction and NEVER
      // takes it back out on pause/resume (verified against a real pty) — so whenever a shared
      // prompt interface exists, raw is the correct state to come BACK to. `false` remains
      // correct for the case this guards against — a crashed child leaving the tty raw while no
      // interface exists to need it.
      const wasRaw = stdin.isTTY ? stdin.isRaw === true : false
      // Cooked for the handoff, so the key the docs tell people to press is a signal again.
      setRawMode(stdin, false)
      // Ignored, not handled: the child is the one that should stop, and Node's default for an
      // unhandled SIGINT is to kill this process — which is precisely how the CLI used to die
      // alongside it with nothing said. Registered for the duration of the handoff only, and
      // removed in `finish`, so Ctrl+C means what it always did everywhere else in the program.
      const ignoreSigint = (): void => {}
      // Attached AFTER the terminal is cooked, never before: while the tty is still raw the
      // kernel delivers no SIGINT at all, so a listener installed first guards nothing — and the
      // instant cooking takes effect, a Ctrl+C would reach this process and kill the CLI out from
      // under the child. Cook first, then guard, and the window between the two states is closed.
      process.on('SIGINT', ignoreSigint)
      // Released BEFORE the spawn, not after: a readline interface that is still flowing competes
      // with the child for every keystroke, and the line the child asked for would be eaten by a
      // parent nobody is talking to.
      pausePrompt()
      let settled = false
      const finish = (result: { code: number | null; spawnFailed: boolean }) => {
        if (settled) return
        settled = true
        process.off('SIGINT', ignoreSigint)
        // Restores the captured state, not a fixed one: a crashed or killed child can leave the
        // terminal raw when it should be cooked, but a parent with an open readline interface
        // needs it RAW to keep working — see the comment on `wasRaw` above.
        setRawMode(stdin, wasRaw)
        resumePrompt()
        resolvePromise(result)
      }
      // No `shell: true`: args reach the child as an argv array, so nothing we pass — a folder
      // with a space, a model id, a path with an apostrophe — can be reinterpreted by a shell.
      // This is also what makes the whole plan work identically on Windows, where the shell is
      // not the one we would have quoted for.
      // Wrapped because `spawn` can throw SYNCHRONOUSLY — a malformed `cwd` or `env` is a
      // TypeError, not an 'error' event — and a throw here would escape past `finish`, leaving
      // this process with the SIGINT listener still installed, the prompt still paused and the
      // terminal still cooked: Ctrl+C dead and no echo, for the rest of the session. Every
      // argument we pass today is validated upstream, so this is unreachable; it is here because
      // the cost of being wrong about that is the person's terminal, and the cost of the guard is
      // three lines. Reported as a spawn failure, the same shape the 'error' event produces.
      try {
        const child = spawn(command, args, { env: opts.env, cwd: opts.cwd, stdio: 'inherit' })
        child.on('error', () => finish({ code: null, spawnFailed: true }))
        child.on('exit', (code) => finish({ code, spawnFailed: false }))
      } catch {
        finish({ code: null, spawnFailed: true })
      }
    })

export const defaultInteractiveRunner: InteractiveRunner = makeInteractiveRunner()
