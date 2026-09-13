# AgentBridge

Relay + Claude Code channel plugin + CLI that lets one person ask another person's agent a question.

- Runbook (Spanish, step by step): docs/runbooks/m1-acceptance.md
- Known gaps and deliberate deferrals: docs/known-gaps.md
- Tests need Docker Postgres: `npm run db:up`, then `npm test`. They only ever talk to the
  container on port 55432 — never point TEST_DATABASE_URL or DATABASE_URL anywhere else.
- User-facing text is Spanish; identifiers, logs and model instructions are English.
- The Spanish error translator lives in `packages/cli/src/spanish-errors.ts`. Use it rather than
  hand-rolling another one — the same English leak appeared three times before it was consolidated.
- `permissions.blockReadsOutsideWorkingDirectories` must stay nested inside `permissions`.
  A copy at the top level of a settings file is accepted by Claude Code and silently ignored.
