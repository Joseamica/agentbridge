import { spawn } from 'node:child_process'

// Writes `text` to a command's stdin and reports whether it worked. Everything is a `false`,
// never a throw: a clipboard that does not exist, a tool that is not installed, a Linux box with
// no display server. The caller prints the link either way.
export type ClipboardWriter = (command: string, args: string[], text: string) => Promise<boolean>

export const defaultClipboardWriter: ClipboardWriter = (command, args, text) =>
  new Promise((resolvePromise) => {
    let settled = false
    let aborted = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      resolvePromise(ok)
    }
    let child
    try {
      // No `shell: true`, like every other spawn in this codebase: the text being copied is the
      // person's own link, but it reaches the tool through stdin, never through a command line.
      // Bounded the same way `defaultRunner` (setup-responder.ts) bounds its own spawn: Node's
      // own kill-on-abort, not a `Promise.race` layered on top that would leave the real child —
      // and our stdin pipe — alive underneath a promise that has already resolved. A bound
      // matters more here than it looks: `pbcopy` and `clip` read stdin and exit, but `xclip` and
      // `wl-copy` fork to keep owning the X/Wayland selection after the copy, so their process
      // lifetime is not "read stdin, exit" at all. Without a deadline, a tool that never settles
      // hangs `copyToClipboard` — and therefore `setup` — forever on its very last step. Three
      // seconds is generous for a program whose entire job is to read one line.
      child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], signal: AbortSignal.timeout(3000) })
    } catch {
      return finish(false)
    }
    child.on('error', (err) => {
      const isAbort = (err as NodeJS.ErrnoException).code === 'ABORT_ERR' || err.name === 'AbortError'
      // As in defaultRunner: once the child has a real pid, defer to `close` — which only fires
      // once the killed process is truly gone — instead of resolving here and racing a stdin
      // pipe that may still be technically open underneath it.
      if (isAbort && child.pid !== undefined) {
        aborted = true
        return
      }
      finish(false)
    })
    child.on('close', (code) => finish(aborted ? false : code === 0))
    child.stdin.on('error', () => finish(false))
    child.stdin.end(text)
  })

// Only tools the system already ships, or that a person on that desktop already has. No new
// dependency, and nothing downloaded: a setup flow is the worst possible moment to ask someone
// to install something so that a convenience can work.
export function clipboardCandidates(platform: NodeJS.Platform): { command: string; args: string[] }[] {
  if (platform === 'darwin') return [{ command: 'pbcopy', args: [] }]
  if (platform === 'win32') return [{ command: 'clip', args: [] }]
  if (platform === 'linux') {
    return [
      // Wayland first: on a Wayland session xclip and xsel either fail or write to a clipboard
      // nothing reads.
      { command: 'wl-copy', args: [] },
      { command: 'xclip', args: ['-selection', 'clipboard'] },
      { command: 'xsel', args: ['--clipboard', '--input'] },
    ]
  }
  return []
}

export async function copyToClipboard(text: string, o?: { platform?: NodeJS.Platform; write?: ClipboardWriter }): Promise<boolean> {
  const write = o?.write ?? defaultClipboardWriter
  for (const candidate of clipboardCandidates(o?.platform ?? process.platform)) {
    if (await write(candidate.command, candidate.args, text)) return true
  }
  return false
}
