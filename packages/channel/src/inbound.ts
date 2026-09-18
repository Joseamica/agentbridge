import type { OpenedMessage, ResponderInboundOutcome } from '@agentbridge/core'

export type ResponderMessageActions = {
  wakeDispatcher(): void
  notifyRequests(): void
  log(line: string): void
}

// What the channel does once its device handled a message: wake the dispatcher for a new question, try
// the request notice for a new request, and record identity conflicts, which the spec says to drop and
// log. Log lines carry identifiers only: an entity id (a validated UUID) and a key prefix.
export function responderMessageHandler(actions: ResponderMessageActions): (opened: OpenedMessage, outcome: ResponderInboundOutcome) => void {
  return (opened, outcome) => {
    const sender = opened.senderPubkey.slice(0, 8)
    if (outcome.kind === 'question') {
      if (outcome.outcome.kind === 'queued') actions.wakeDispatcher()
      if (outcome.outcome.kind === 'dropped' && outcome.outcome.reason === 'conflict' && opened.message.type === 'question') {
        actions.log(`dropped a question that reuses question id ${opened.message.questionId} with different content (sender ${sender})`)
      }
      return
    }
    if (outcome.kind === 'request') {
      if (outcome.outcome === 'stored') actions.notifyRequests()
      if (outcome.outcome === 'conflict' && opened.message.type === 'connect_request') {
        actions.log(`dropped a connection request that reuses request id ${opened.message.requestId} with different content (sender ${sender})`)
      }
    }
  }
}
