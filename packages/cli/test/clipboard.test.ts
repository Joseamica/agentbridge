import { describe, expect, it } from 'vitest'
import { clipboardCandidates, copyToClipboard, defaultClipboardWriter } from '../src/clipboard'

describe('clipboardCandidates', () => {
  it('uses the tool macOS already ships', () => {
    expect(clipboardCandidates('darwin')).toEqual([{ command: 'pbcopy', args: [] }])
  })

  it('uses the tool Windows already ships', () => {
    expect(clipboardCandidates('win32')).toEqual([{ command: 'clip', args: [] }])
  })

  it('tries Wayland before X11 on Linux', () => {
    expect(clipboardCandidates('linux')).toEqual([
      { command: 'wl-copy', args: [] },
      { command: 'xclip', args: ['-selection', 'clipboard'] },
      { command: 'xsel', args: ['--clipboard', '--input'] },
    ])
  })

  it('has nothing to offer on an unknown platform', () => {
    expect(clipboardCandidates('aix')).toEqual([])
  })
})

describe('copyToClipboard', () => {
  it('stops at the first tool that works', async () => {
    const tried: string[] = []
    const ok = await copyToClipboard('agentbridge:nprofile1abc', {
      platform: 'linux',
      write: async (command) => {
        tried.push(command)
        return command === 'wl-copy'
      },
    })
    expect(ok).toBe(true)
    expect(tried).toEqual(['wl-copy'])
  })

  it('falls through to the next tool when one is missing', async () => {
    const tried: string[] = []
    const ok = await copyToClipboard('x', {
      platform: 'linux',
      write: async (command) => {
        tried.push(command)
        return command === 'xclip'
      },
    })
    expect(ok).toBe(true)
    expect(tried).toEqual(['wl-copy', 'xclip'])
  })

  it('reports failure instead of throwing when no tool is installed', async () => {
    const ok = await copyToClipboard('x', { platform: 'linux', write: async () => false })
    expect(ok).toBe(false)
  })

  it('never throws when the platform has no clipboard tool at all', async () => {
    await expect(copyToClipboard('x', { platform: 'aix' })).resolves.toBe(false)
  })

  it('really writes through a child process stdin', async () => {
    // Proves the writer against a real process rather than a mock: `cat` is on every POSIX
    // machine, and a writer that never actually wrote to stdin would still "succeed" against a
    // fake. Skipped on Windows, where the shape of this check would be a different test.
    if (process.platform === 'win32') return
    await expect(defaultClipboardWriter('cat', [], 'hola')).resolves.toBe(true)
    await expect(defaultClipboardWriter('agentbridge-no-existe-jamas', [], 'hola')).resolves.toBe(false)
  })
})
