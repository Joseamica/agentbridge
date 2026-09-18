import { execFile } from 'node:child_process'
import { claimRequestNoticeSlot, describeError, type Store } from '@agentbridge/core'

export const REQUEST_NOTICE_TEXT = 'AgentBridge: tienes solicitudes nuevas'

export type NoticeRunner = (file: string, args: readonly string[]) => Promise<void>

const runWithoutShell: NoticeRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: 5_000 }, (err) => (err ? reject(err) : resolve()))
  })

function commandFor(platform: NodeJS.Platform): { file: string; args: string[] } | null {
  if (platform === 'darwin') return { file: 'osascript', args: ['-e', `display notification "${REQUEST_NOTICE_TEXT}" with title "AgentBridge"`] }
  if (platform === 'linux') return { file: 'notify-send', args: ['AgentBridge', REQUEST_NOTICE_TEXT] }
  return null
}

// Fixed text with no third-party data, arguments passed without a shell, and at most one notice every
// 10 minutes per identity. The slot is claimed in SQLite, so every process on the machine shares it.
export async function notifyNewRequests(input: {
  store: Store
  now: number
  platform?: NodeJS.Platform
  run?: NoticeRunner
  log?: (line: string) => void
}): Promise<boolean> {
  const command = commandFor(input.platform ?? process.platform)
  if (!command) return false
  // Called from a timer: nothing here may throw or reject, a busy database included.
  try {
    // The slot is spent here, before the command below even runs: a machine with no osascript/
    // notify-send (or one that times out) silently loses this notice instead of retrying it. That
    // trade is deliberate — the alternative is a flaky notifier popping up the same notice twice.
    if (!claimRequestNoticeSlot(input.store, input.now)) return false
    await (input.run ?? runWithoutShell)(command.file, command.args)
    return true
  } catch (err) {
    input.log?.(`request notice failed (${describeError(err)})`)
    return false
  }
}
