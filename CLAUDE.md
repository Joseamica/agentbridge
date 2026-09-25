# AgentBridge

Claude Code channel plugin + CLI that lets one person ask another person's agent a question, over
public Nostr boards. No server of ours: no relay, no account, nothing to host.

- Runbook (Spanish, step by step): docs/runbooks/aceptacion-0.4.md
- Known gaps and deliberate deferrals: docs/known-gaps.md
- `npm test` needs no internet. `npm run test:live` is the only suite that talks to public Nostr
  boards; run it on purpose, never in a loop.
- User-facing text is Spanish; identifiers, logs and model instructions are English.
- The Spanish error translator lives in `packages/cli/src/spanish-errors.ts`. Use it rather than
  hand-rolling another one — the same English leak appeared three times before it was consolidated.
- `permissions.blockReadsOutsideWorkingDirectories` must stay nested inside `permissions`.
  A copy at the top level of a settings file is accepted by Claude Code and silently ignored.
  It never turns off: the wider scopes (several folders, the whole personal folder) add
  `additionalDirectories`, they do not remove the fence.
- Every deny rule that must hold outside the working directory is anchored — `~/…` for the home,
  `//<absolute path>/…` for an extra folder. Never write an unanchored `**/…` rule for a wider
  scope: it is relative to the working directory, so outside it it looks like protection and covers
  nothing (on Claude Code 2.1.282, `Read(**/.env)` let a direct read of `~/proj/.env` through with
  the home added; `Read(~/**/.env)` stopped it). The caja fuerte is `CAJA_FUERTE_HOME` plus
  `cajaFuerteFor()` in `packages/cli/src/commands/setup-responder.ts`; it is fixed in code, and user
  text calls it "los lugares más conocidos" and never promises it closes every secret.
- Claude Code behaviours the scopes rest on were verified on 2.1.282
  (`.superpowers/sdd/2026-09-25-agentbridge-0.4-alcance/verificaciones.md`). A new assumption about
  Claude Code gets its own probe against the real binary — with a positive control, since "not
  loaded" proves nothing unless the same probe can say "loaded" — and section 8 of the runbook.
- `.agentbridge-scope.md` in the shared folder belongs to AgentBridge: rewritten from the scope on
  every setup and imported by the persona `CLAUDE.md` with `@.agentbridge-scope.md`. A `CLAUDE.md`
  the owner edited is never touched; setup gives them the one line to add instead. `settings.json`
  in the dedicated profile is likewise rewritten on every setup, and `responder` refuses to start
  when it does not match the saved scope exactly.
- Every printed instruction uses `CLI_COMMAND` (`packages/core/src/published.ts`) — never a
  hand-typed `agentbridge` or a bare command name.
- Another person's text — a declared name, a note, an answer — goes through `forTerminal` (short
  fields) or `forTerminalBlock` (multi-line prose) before it reaches a terminal.
- `~/.agentbridge` (or `$AGENTBRIDGE_HOME`) holds identity and state — the key and the SQLite
  database — for every role. The responder's dedicated Claude Code profile (`~/.agentbridge-responder`
  by default, or `--profile`) holds only Claude's own files: `settings.json`, `responder.json`,
  and its `claude` directory (the one `CLAUDE_CONFIG_DIR` points at). Never identity, never the
  database.
- The responder is started by `npx -y @joseamica/agentbridge@latest responder`, which reads
  `responder.json` from the dedicated profile. There is no shell script: one would work on two of
  the three platforms, and that was exactly the failure that broke the first Windows install.
- Nothing a person reads may contain shell syntax — no `VAR='x' command`, no path to a `.sh`, no
  quoting that depends on which shell they have. If something needs to happen, the program does it.
  `tests/acceptance/docs.test.ts` watches the docs; keep it passing.

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
