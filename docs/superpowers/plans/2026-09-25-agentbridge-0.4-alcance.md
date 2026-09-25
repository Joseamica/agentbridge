# AgentBridge 0.4 — quien contesta elige qué puede ver su agente

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The person who answers chooses the answering agent's reach — one folder (today), several folders, or their whole personal folder — and in every mode a fixed "caja fuerte" of secrets stays unreadable.

**Architecture:** The scope is data: a `scope` field in `responder.json`. One pure function turns a scope into the exact `permissions` block of the dedicated profile's `settings.json` (`additionalDirectories` plus anchored deny rules), and one inspector checks a `settings.json` against the scope it is supposed to enforce. `setup` asks the question, `setupResponder` always writes the settings the scope requires, `responder` refuses to start when the file on disk does not match the scope, and `doctor` reports the same verdict. The fence (`permissions.blockReadsOutsideWorkingDirectories`) never turns off — the wider modes widen the set of working directories, they do not remove the wall.

**Tech Stack:** TypeScript 5.9 strict on Node ≥22.13, npm workspaces, vitest 5, esbuild bundles. No new dependencies.

**Spec:** this plan is its own spec. The design was approved by the owner on 2026-09-25: three modes, one choice for all contacts (not per contact), and a **fixed** caja fuerte that the person cannot open. Every Claude Code behaviour the design rests on was verified against the real binary (2.1.282) before writing — see `.superpowers/sdd/2026-09-25-agentbridge-0.4-alcance/verificaciones.md`, summarised below.

## What the design rests on — verified, not assumed

| Verified on Claude Code 2.1.282 | Consequence |
|---|---|
| `permissions.additionalDirectories` adds readable directories **and the fence stays on** for everything else (`/private/etc/hosts` still refused with home added). | Modes 2 and 3 are `additionalDirectories`, never turning the fence off. |
| An anchored deny inside an allowed directory holds: `Read(//<abs>/extra/secret/**)` and `Read(~/.x/**)` both refuse. | The caja fuerte works inside a directory the agent can otherwise read. |
| Grep and Glob respect those denies, **including when they recurse from an allowed ancestor** — they silently skip the denied folder. | A search from `~` does not leak the caja fuerte. |
| A `CLAUDE.md` or `.claude/settings.json` inside an additional directory is **not loaded**. | Wider modes do not let a folder inject instructions or permissions. |
| **`Read(**/.env)` is relative to the working directory.** With home added, a direct `Read` of `~/proj/.env` **succeeded** and returned its content. `Read(~/**/.env)` refused it, including `sub/.env.production`. | **Every rule that must hold outside the working directory has to be anchored** — `~/…` for home mode, `//<absolute path>/…` per extra folder. An unanchored rule looks like protection and covers nothing. This is the single most important fact in this plan. |

**Not verified:** how an absolute path is anchored on Windows. Mode 3 uses `~` and avoids it; mode 2 depends on it. Task 1 decides how to handle that.

## The three modes

```
1) Una carpeta          cwd = shared folder                       (today, the default)
2) Varias carpetas      cwd = first folder; additionalDirectories = the rest
3) Tu carpeta personal  cwd = the dedicated shared folder (holds the persona CLAUDE.md);
                        additionalDirectories = [home]; caja fuerte denied
```

In mode 3 the working directory stays a dedicated folder, never the home itself: the persona `CLAUDE.md` is written into the working directory, and a `CLAUDE.md` in the home would change how the owner's own everyday Claude behaves.

## The caja fuerte

Always denied in modes 2 and 3, as `Read(...)` rules, anchored. Mode 1 keeps today's rules (its only readable directory is the working directory, where the unanchored `**/.env` does hold).

**Anchored to real absolute paths, whatever the mode:**
- the identity home (`AGENTBRIDGE_HOME` — the key and the database), whatever its location
- the dedicated profile (`settings.json`, `responder.json`, Claude's own login for this profile)

**Mode 3 (home), anchored with `~`:**
- `~/.claude/**` and `~/.claude.json` — the owner's everyday Claude: credentials and every conversation
- `~/.ssh/**`, `~/.gnupg/**`, `~/.aws/**`, `~/.azure/**`, `~/.config/gcloud/**`, `~/.kube/**`, `~/.docker/**`
- `~/.config/gh/**`, `~/.npmrc`, `~/.pypirc`, `~/.netrc`, `~/.git-credentials`
- `~/Library/Keychains/**`, `~/Library/Cookies/**`, `~/Library/Application Support/Google/Chrome/**`, `~/Library/Application Support/Firefox/**`, `~/Library/Safari/**` (macOS)
- `~/.mozilla/**`, `~/.config/google-chrome/**`, `~/.config/chromium/**`, `~/.local/share/keyrings/**` (Linux)
- `~/AppData/**` (Windows: application state, credentials and browser profiles live there, documents do not)
- `~/**/.env`, `~/**/.env.*`, `~/**/*.pem`, `~/**/*.key`, `~/**/*.p12`, `~/**/*.pfx`

**Mode 2 (several folders), for every extra folder `F`:** `Read(//F/**/.env)`, `Read(//F/**/.env.*)`, `Read(//F/**/*.pem)`, `Read(//F/**/*.key)`, `Read(//F/**/*.p12)`, `Read(//F/**/*.pfx)`. The existing danger gate (`assessShareDir`) still runs on every chosen folder, so a folder with a `.git`, credential-named files or escaping symlinks is flagged before it is accepted.

The list is fixed in code. The owner chose, explicitly, that nobody — including themselves — can open the caja fuerte through `setup`.

## Global Constraints

- **Node** `>=22.13`. **No new runtime dependencies.** `nostr-tools` exactly `2.25.2`, `ws` exactly `8.21.3`.
- **Language.** What a person reads is Spanish; identifiers, comments, logs and model instructions are English.
- **No shell syntax in text a person reads.** Printed commands go through `CLI_COMMAND` (`npx -y @joseamica/agentbridge@latest`). `tests/acceptance/docs.test.ts` guards the docs.
- **Three platforms.** macOS, Linux, Windows. Never `shell: true`.
- **The fence never turns off.** `permissions.blockReadsOutsideWorkingDirectories: true`, nested **inside** `permissions`, in every mode. A copy at the top level is silently ignored by Claude Code.
- **No secrets in errors or logs**: no key, no decrypted content, no raw subprocess output. Folder paths may appear on the screen of the person who chose them; never in logs.
- **Tests** need neither Docker nor internet, and **never write into the real `$HOME`** (an earlier task accidentally created `~/AgentBridge/compartido`). The real-binary checks are a manual runbook step, not part of `npm test`.
- **Test commands:** `npm test -- <pattern>` from the repository root. `npm test -w @agentbridge/cli` does nothing — no workspace has its own `test` script.
- **The standing rule of this project:** for every assertion that guards a behaviour, break the behaviour, watch the test fail, restore it. Commit before breaking — `git checkout <path>` as a restore step discards uncommitted work, and it has done so twice.
- **Version 0.4.0.**

## Decisions

- **D1 — One choice for all contacts.** Per-contact scope needs one answering agent per contact; out of scope, recorded in `known-gaps.md`.
- **D2 — `setupResponder` always writes `settings.json`.** Today it refuses to touch an existing file. That makes switching modes silently wrong in the dangerous direction: going from mode 3 back to mode 1 would leave `additionalDirectories: [home]` in place. The file is generated and owned by AgentBridge; it is rewritten every time and the person is told when it changed.
- **D3 — The inspector checks the settings against the scope, exactly.** Missing deny rules are a problem; so is an `additionalDirectories` entry the scope does not call for. `responder` refuses to start on any problem; `doctor` reports it as blocking and `security`.
- **D4 — `responder.json` gains `scope` and becomes version 2.** A version-1 file (every 0.3 install) reads as mode 1, so existing installs keep working without re-running `setup`.
- **D5 — Mode 3 needs a typed confirmation**, the same `CONFIRMAR` pattern the danger gate uses, after one short explanation of what the agent will and will not see.

---

### Task 1: The scope, the settings it requires, and the inspector

**Files:**
- Modify: `packages/cli/src/commands/responder-config.ts` — `ResponderScope`, version 2
- Modify: `packages/cli/src/commands/setup-responder.ts` — `responderSettings(scope, paths)`, `inspectResponderSettings(profileHome, scope, paths)`, always write `settings.json` (D2)
- Modify: `packages/cli/src/commands/responder.ts` — `readResponderConfig` accepts versions 1 and 2
- Test: `packages/cli/test/responder-scope.test.ts`, plus updates to `setup-responder.test.ts` and `responder.test.ts`

**Interfaces produced (later tasks use these names):**

```ts
export type ResponderScope =
  | { kind: 'folder' }
  | { kind: 'folders'; extra: string[] }   // absolute, resolved, non-empty
  | { kind: 'home' }

export type ResponderConfig = {
  version: 2
  shareDir: string
  identityHome: string
  model: string
  effort: string
  scope: ResponderScope
}

export const CAJA_FUERTE_HOME: readonly string[]         // the mode-3 `~/…` rules, exactly as listed above
export function cajaFuerteFor(scope: ResponderScope, o: { identityHome: string; profileHome: string }): string[]
export function responderSettings(scope: ResponderScope, o: { identityHome: string; profileHome: string; home: string }): SettingsFile
export async function inspectResponderSettings(
  profileHome: string,
  scope: ResponderScope,
  o: { identityHome: string; home: string },
): Promise<ResponderSettingsReport>   // same report shape as today
```

`home` is injected everywhere instead of calling `os.homedir()` inside the functions, so tests never depend on — or touch — the real home.

**Requirements:**
- `responderSettings({ kind: 'folder' }, …)` produces **exactly** what 0.3 produces today. A test pins it byte for byte against today's output, so mode 1 installs see no change.
- Every rule that must hold outside the working directory is anchored (the V6 finding). A test asserts that no rule generated for modes 2 and 3 other than the unchanged mode-1 base starts with `**`.
- The identity home and the dedicated profile are denied in modes 2 and 3 **whatever their location** — including a custom `AGENTBRIDGE_HOME` or `--profile`.
- An absolute path becomes `//<path>` in a rule. On Windows (`process.platform === 'win32'`, injectable), the anchoring form is unverified: **mode 2 is refused on Windows** with a Spanish sentence saying so and offering modes 1 and 3. Recorded in `known-gaps.md` by task 5. Do not guess a Windows path syntax.
- `readResponderConfig`: version 1 → `scope: { kind: 'folder' }`; version 2 → validate `scope` (known `kind`; `extra` absolute, non-empty, no duplicates, none equal to or inside `shareDir`, none containing the identity home or the profile — reuse `isSameOrWithin`); anything else → refuse, as today.
- `inspectResponderSettings` reports a problem for: missing file, invalid JSON, fence not `true` inside `permissions`, any missing base deny, any missing caja-fuerte rule for the scope, **any `additionalDirectories` entry not required by the scope, or any required one missing**, any `allow` beyond the reply tool.
- `setupResponder` takes the scope, writes `responder.json` version 2 and **always** writes `settings.json` from `responderSettings`. When it replaced a file whose content differed, it says so in one Spanish line.

**Tests to write first** (each one broken on purpose and watched failing):
- mode 1 byte-identical to today's settings
- mode 2 with two extra folders: `additionalDirectories` equals them; each has its six anchored rules; identity and profile denied
- mode 3: `additionalDirectories` is exactly `[home]`; every `CAJA_FUERTE_HOME` rule present; identity and profile denied as absolute paths even when they live outside the default location
- no generated rule outside the mode-1 base is unanchored
- inspector: each problem listed above, one test each, plus a leftover `additionalDirectories: [home]` in a mode-1 profile (the D2 hazard) → problem
- version-1 `responder.json` reads as mode 1; a version-2 file with an `extra` inside `shareDir`, or containing the identity home, is refused
- `setupResponder` over an existing mode-3 `settings.json` with a mode-1 scope rewrites it and says so
- mode 2 refused on `win32`

### Task 2: `setup` asks the question

**Files:** Modify `packages/cli/src/commands/setup.ts`; Test `packages/cli/test/setup.test.ts`.

**Consumes:** `ResponderScope`, `setupResponder(… scope …)` from task 1.

**Requirements:**
- After the shared folder is chosen and accepted, one question:

  ```
  ¿Qué puede ver tu agente cuando alguien te pregunta?
    1) Solo esta carpeta (recomendado)
    2) Esta carpeta y otras que elijas
    3) Toda tu carpeta personal, menos tus secretos
  ```

  Enter = 1.
- **Mode 2**: ask for folders one at a time; an empty answer finishes. Each goes through `assessShareDir` exactly like the main folder — hard refusals refuse *that folder* and ask again (do not end the interview); danger reasons require `CONFIRMAR` for that folder. A folder equal to or inside another chosen one, or containing the identity home or the profile, is refused with its reason. Zero extra folders means mode 1, said plainly. On Windows, option 2 explains it is not available yet and asks again.
- **Mode 3**: a short explanation — what it will read, the caja fuerte in plain words ("tu llave de AgentBridge, tus contraseñas y llaves, tus archivos .env, tu Claude de todos los días"), that system files stay closed, and that anyone you give permission to can ask about any other file in your personal folder — then `CONFIRMAR`. Anything else falls back to mode 1, said plainly.
- Re-running `setup` proposes the current mode as the default, read from `responder.json`, the same way the folder question already proposes the saved folder.
- The summary names the chosen mode in one line.
- Every prompt answer in the tests uses temp paths. The folder questions are never answered with Enter against a default under the real home.

### Task 3: `responder` and `doctor` enforce and report the scope

**Files:** Modify `packages/cli/src/commands/responder.ts`, `packages/cli/src/commands/doctor.ts`; Tests `responder.test.ts`, `doctor.test.ts`.

**Requirements:**
- `runResponder` reads the scope and calls `inspectResponderSettings` with it; any problem → refuse before spawning, as today. In mode 2, every extra folder must still exist and be a directory, checked before spawning with its own sentence (the same reason the shared-folder check exists: `spawn`'s ENOENT is ambiguous).
- The line printed before handing over names the mode.
- `doctor` reads the scope from `responder.json` when a profile is given; reports the mode as information; runs the share checks (`addShareChecks`) on **every** folder in mode 2; reports the inspector's verdict as today (blocking, `security`); in mode 3 adds one informational line listing what the caja fuerte covers.

### Task 4: The persona knows its folders

**Files:** Modify the persona written by `setupResponder` (`RESPONDER_PERSONA` in `setup-responder.ts`); Test `setup-responder.test.ts`.

**Requirements:** the persona `CLAUDE.md` in the working directory tells the model which folders it may answer from (mode 2: the list; mode 3: "the owner's personal folder, except the protected places"), and keeps today's rules: never reveal secrets, never read outside what it was given. English, like every model instruction. It is written only when absent today — keep that, but when the scope changes, write it to a different, AgentBridge-owned file (`.agentbridge-scope.md`) that the persona references, so a person's own edits to `CLAUDE.md` are never overwritten. Decide and justify the mechanism in the report; the constraint is: never silently overwrite the owner's file, never leave the model describing the wrong scope.

### Task 5: Docs, known gaps, version 0.4.0

**Files:** `README.md`, `docs/inicio-rapido.md`, `docs/known-gaps.md`, `docs/runbooks/aceptacion-0.3.md` → `aceptacion-0.4.md` (`git mv`), `CLAUDE.md`, `plugins/agentbridge/.claude-plugin/plugin.json`, `tests/acceptance/packaging.test.ts`, `tests/acceptance/docs.test.ts` (runbook filename).

**Requirements:**
- The guide explains the three modes in plain Spanish with the caja fuerte listed, and says clearly that in mode 3 anyone you approve can ask about any file in your personal folder outside the caja fuerte.
- `known-gaps.md`: one choice for all contacts (D1); mode 2 not on Windows; the caja fuerte is a fixed list and a secret stored somewhere unusual is not in it; the behaviours in the verification table were checked on Claude Code 2.1.282 and a future Claude Code could change them — which is why the runbook re-checks them.
- The runbook gains a section that repeats the verification table against the installed Claude Code, per mode, with disposable probe files and cleanup.
- Update the stale comment in `setup-responder.ts` that says Grep is not covered by Read deny rules (V5 shows it is, for folder rules) — say what was verified and on which version.
- Update the project `CLAUDE.md`: every rule that must hold outside the working directory is anchored; never write an unanchored `**/…` rule for a wider mode.
- Version `0.4.0` in `plugin.json` only; packaging tests follow.

### Task 6: Verification

- `npm test` three times in a row, all green (the suite has shown load-sensitive timeouts before); `npm run typecheck`; `npm run build && npm run pack`.
- Against the **packaged** binary with disposable `AGENTBRIDGE_HOME` and `--profile`: `setup` in each of the three modes, stopping before the login; `doctor` on each; `responder` refusing a hand-broken `settings.json` in each mode, including a leftover `additionalDirectories: [home]` under mode 1.
- Against **real Claude Code**, by hand, the runbook's new section for modes 2 and 3: a probe secret in the caja fuerte is refused by Read, Grep and Glob; a `.env` in an extra folder is refused by Read; a normal file is read; a system file stays blocked. Probe files removed afterwards; the real `$HOME` otherwise untouched.
- `npm run test:live` once.
