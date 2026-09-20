# AgentBridge

Claude Code channel plugin + CLI that lets one person ask another person's agent a question, over
public Nostr boards. No server of ours: no relay, no account, nothing to host.

- Runbook (Spanish, step by step): docs/runbooks/aceptacion-0.2.md
- Known gaps and deliberate deferrals: docs/known-gaps.md
- `npm test` needs no internet. `npm run test:live` is the only suite that talks to public Nostr
  boards; run it on purpose, never in a loop.
- User-facing text is Spanish; identifiers, logs and model instructions are English.
- The Spanish error translator lives in `packages/cli/src/spanish-errors.ts`. Use it rather than
  hand-rolling another one — the same English leak appeared three times before it was consolidated.
- `permissions.blockReadsOutsideWorkingDirectories` must stay nested inside `permissions`.
  A copy at the top level of a settings file is accepted by Claude Code and silently ignored.
- Every printed instruction uses `CLI_COMMAND` (`packages/core/src/published.ts`) — never a
  hand-typed `agentbridge` or a bare command name.
- Another person's text — a declared name, a note, an answer — goes through `forTerminal` (short
  fields) or `forTerminalBlock` (multi-line prose) before it reaches a terminal.
- `~/.agentbridge` (or `$AGENTBRIDGE_HOME`) holds identity and state — the key and the SQLite
  database — for every role. The responder's dedicated Claude Code profile (`~/.agentbridge-responder`
  by default, or `--profile`) holds only Claude's own files: `settings.json`, `start.sh`,
  `CLAUDE_CONFIG_DIR`. Never identity, never the database.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
