import { spawn } from 'node:child_process'

// Writes `text` to a command's stdin and reports whether it worked. Everything is a `false`,
// never a throw: a clipboard that does not exist, a tool that is not installed, a Linux box with
// no display server. The caller prints the link either way.
export type ClipboardWriter = (command: string, args: string[], text: string) => Promise<boolean>

export const defaultClipboardWriter: ClipboardWriter = (command, args, text) =>
  new Promise((resolvePromise) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      resolvePromise(ok)
    }
    let child
    try {
      // No `shell: true`, like every other spawn in this codebase: the text being copied is the
      // person's own link, but it reaches the tool through stdin, never through a command line.
      child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] })
    } catch {
      return finish(false)
    }
    child.on('error', () => finish(false))
    child.on('exit', (code) => finish(code === 0))
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
