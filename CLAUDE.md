# AgentBridge

Relay + Claude Code channel plugin + CLI that lets one person ask another person's agent a question.

- Runbook (Spanish, step by step): docs/runbooks/m1-acceptance.md
- Known gaps and deliberate deferrals: docs/known-gaps.md
- `npm test` needs neither Docker nor internet. `npm run test:live` is the only suite that talks to
  public Nostr relays; run it on purpose, never in a loop.
- User-facing text is Spanish; identifiers, logs and model instructions are English.
- The Spanish error translator lives in `packages/cli/src/spanish-errors.ts`. Use it rather than
  hand-rolling another one — the same English leak appeared three times before it was consolidated.
- `permissions.blockReadsOutsideWorkingDirectories` must stay nested inside `permissions`.
  A copy at the top level of a settings file is accepted by Claude Code and silently ignored.
