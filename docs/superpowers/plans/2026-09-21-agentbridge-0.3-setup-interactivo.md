# AgentBridge 0.3 — el programa hace la instalación, no la dicta

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** That a person who is not a programmer can go from `npx` to answering questions without copying a single command, on macOS, Linux or Windows.

**Architecture:** `setup` stops printing instructions and starts performing them: it hands the terminal to Claude's login and takes it back, it launches the responder itself, and it copies the person's link to the clipboard. The technical report moves out of the guided flow into `doctor`, where it belongs, and what `setup` says when something is wrong is a sentence a person can act on. `start.sh` — a bash script that cannot run on Windows — is replaced by a real command, `responder`, so every platform works the same way and nothing shell-specific is ever printed.

**Tech Stack:** TypeScript 5.9 strict on Node ≥22.13, npm workspaces, vitest 5, esbuild bundles, `node:sqlite` (WAL), `nostr-tools` 2.25.2, `ws` 8.21.3, MCP SDK.

**Spec:** `docs/superpowers/specs/2026-09-16-nostr-transport-design.md` (revisión 4). This plan changes no protocol and no security boundary; it changes who does the work.

## El problema, en la evidencia

Una persona instaló 0.2.0 en Windows el 2026-09-21. El asistente terminó así:

```
Pendiente:
  - Llave de AgentBridge: la llave está en 666 y debe estar en 0600 · su carpeta está en 666 …
  - Tablero wss://relay.damus.io: aceptó publicar pero no me dejó leer
  - Sesión iniciada en el perfil dedicado: CLAUDE_CONFIG_DIR='C:\…\claude' claude   (usa /login y sal)
  - Arranca el respondedor: 'C:\Users\dagui\.agentbridge-responder\start.sh'
  … siete pendientes en total
Siguiente paso: Llave de AgentBridge: la llave está en 666 y debe estar en 0600 …
```

Tres cosas están mal ahí, y ninguna es un error de programación:

1. **Un asistente guiado que termina con siete pendientes no guió nada.** Y el "siguiente paso" que eligió es el único imposible de cumplir: en Windows no existen los permisos POSIX.
2. **Diecisiete líneas de diagnóstico técnico a media instalación**, dirigidas a alguien que acaba de teclear su nombre. Casi ninguna es accionable por esa persona.
3. **Le pedimos que ejecute lo que el programa puede ejecutar**, en sintaxis de una shell que quizá no usa: `CLAUDE_CONFIG_DIR='…' claude` no corre en PowerShell, y `start.sh` no corre en Windows en absoluto.

El tercero tiene una consecuencia que conviene ver: **arreglar la experiencia arregla casi todo el soporte de Windows**, porque el programa deja de imprimir comandos de shell y empieza a hacer el trabajo.

## Global Constraints

- **Node y dependencias.** Node floor `>=22.13`. Ninguna dependencia de ejecución nueva — ni para el portapapeles ni para nada. `nostr-tools` exactamente `2.25.2` y `ws` exactamente `8.21.3`.
- **Idioma.** El texto que lee una persona es español. Los identificadores, los registros y los nombres y descripciones de herramientas MCP van en inglés.
- **Nada de sintaxis de shell en texto que lee una persona.** Ni `VAR='x' comando`, ni rutas a scripts `.sh`, ni comillas que dependan de la shell. Si hace falta que algo ocurra, lo ejecuta el programa; si hace falta nombrar un comando de AgentBridge, se usa `CLI_COMMAND`.
- **Las tres plataformas.** macOS, Linux y Windows. Ninguna instrucción, ruta o chequeo puede asumir una de ellas. Lo que no aplique en una plataforma no se reporta como falla en ella.
- **Errores.** Ningún mensaje ni registro incluye la llave secreta, contenido descifrado de terceros ni la salida cruda de un subproceso. Las rutas de la carpeta compartida no aparecen en errores ni registros; en la pantalla de quien acaba de teclearlas, sí.
- **La valla no se toca.** La sesión que responde sigue confinada a su carpeta, sin Bash, sin escritura, sin web y sin sub-agentes. Este plan no cambia un solo permiso.
- **Pruebas.** `npm test` no necesita Docker ni internet. `npm run test:live` solo en la tarea de verificación, una vez.
- **Versión 0.3.0.**

## Decisiones de este plan

- **D1 — El asistente ejecuta, no dicta.** Donde hoy imprime un comando para que la persona lo copie, el programa lo corre: el inicio de sesión de Claude (que tiene su propio subcomando, `claude auth login`, y abre el navegador) y el arranque del respondedor. Solo se le pide a la persona lo que de verdad requiere a una persona: escribir su nombre, elegir una carpeta, decidir un permiso y autenticarse en su navegador.
- **D2 — `start.sh` se retira y nace el comando `responder`.** Un script de bash no corre en Windows, y mantener dos scripts equivalentes por plataforma duplica el error. `${CLI_COMMAND} responder` hace lo mismo en los tres sistemas y no necesita que nadie sepa dónde quedó un archivo. Los dos instaladores que existen hoy vuelven a correr `setup`, que es de un minuto.
- **D3 — El diagnóstico sale del asistente.** `setup` corre `doctor` por dentro, pero solo habla si algo **bloquea**, y lo dice en una frase accionable. El reporte línea por línea es de `doctor`, que para eso existe y ahora se nombra al final en una sola línea.
- **D4 — En Windows no se reportan permisos POSIX.** `fs.stat().mode` devuelve `666` siempre; pedir `0600` es pedir lo imposible. En su lugar se revisa lo que sí importa ahí: que la identidad no esté dentro de una carpeta sincronizada a la nube (OneDrive, Dropbox, iCloud), donde la llave secreta se subiría sola.
- **D5 — El enlace se copia al portapapeles**, con las herramientas que ya trae cada sistema (`pbcopy`, `clip`, `wl-copy`/`xclip`). Si no hay ninguna, se imprime y ya: es una comodidad, nunca un requisito.
- **D6 — La terminal se presta, no se cierra.** La interfaz de lectura se pausa antes de ceder la terminal al inicio de sesión y se reanuda después. Cerrarla la marcaría como muerta de forma permanente —es la protección que distingue "la entrada se acabó" de "estoy ocupado"— y el asistente no podría volver a preguntar nada.

---
### Task 1: Prestar la terminal y recuperarla

**Files:**
- Create: `packages/cli/src/interactive.ts`
- Modify: `packages/cli/src/context.ts` (añadir `pausePrompt` y `resumePrompt` junto a `closePrompt`)
- Test: `packages/cli/test/interactive.test.ts`
- Test fixture: `packages/cli/test/fixtures/handoff-parent.mjs`, `packages/cli/test/fixtures/handoff-child.mjs`

**Interfaces:**
- Consumes: `Output` y la interfaz de lectura compartida de `packages/cli/src/context.ts`.
- Produces:
  - `export type InteractiveRunner = (command: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd?: string }) => Promise<{ code: number | null; spawnFailed: boolean }>`
  - `export const defaultInteractiveRunner: InteractiveRunner`
  - `export function pausePrompt(): void` y `export function resumePrompt(): void` en `context.ts`
  Las tareas 2 y 3 dependen de los tres.

**Por qué existe esta tarea.** Todo el plan descansa en una cosa: que el asistente pueda entregarle el
teclado a `claude` y recuperarlo después. La interfaz de lectura que usa `setup` se marca como
**cerrada para siempre** en cuanto su evento `close` se dispara — esa bandera es a propósito, es lo que
distingue "la entrada se acabó" de "estoy ocupado" — así que cerrarla antes de ceder la terminal
dejaría al asistente sin poder volver a preguntar nada. Se pausa, no se cierra.

Comprobado en una terminal real (pseudo-terminal vía `expect`, Node 24): el padre pregunta y recibe
`uno`; pausa; el hijo, lanzado con `stdio: 'inherit'`, hace **su propia** pregunta y recibe `dos`; el
hijo termina; el padre reanuda, la bandera de cerrado sigue en `false`, y el padre pregunta otra vez y
recibe `tres`. Ese es el contrato que esta tarea convierte en código y en prueba.

- [ ] **Step 1: Write the failing test**

Primero los dos fixtures, que son un programa real, no un simulacro. `handoff-parent.mjs`:

```js
import { createInterface } from 'node:readline/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const rl = createInterface({ input: process.stdin, output: process.stdout })
let closed = false
rl.on('close', () => {
  closed = true
})

const first = await rl.question('P1: ')
console.log(`PARENT_1=${first}`)

rl.pause()
process.stdin.pause()

const child = join(dirname(fileURLToPath(import.meta.url)), 'handoff-child.mjs')
const code = await new Promise((resolvePromise) => {
  const proc = spawn(process.execPath, [child], { stdio: 'inherit' })
  proc.on('exit', (c) => resolvePromise(c))
})
console.log(`CHILD_EXIT=${code}`)

process.stdin.resume()
rl.resume()
console.log(`CLOSED=${closed}`)

const second = await rl.question('P2: ')
console.log(`PARENT_2=${second}`)
rl.close()
```

`handoff-child.mjs`:

```js
import { createInterface } from 'node:readline/promises'

const rl = createInterface({ input: process.stdin, output: process.stdout })
const answer = await rl.question('C1: ')
console.log(`CHILD_1=${answer}`)
rl.close()
```

Y la prueba, en `packages/cli/test/interactive.test.ts`:

```ts
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultInteractiveRunner } from '../src/interactive'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

// Drives the parent fixture through a pipe, feeding each line only after the prompt that asks
// for it has been printed. Feeding all three up front would prove nothing: the question is
// precisely whether the child reads the second line instead of the paused parent swallowing it.
function driveHandoff(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(process.execPath, [join(fixtures, 'handoff-parent.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    const sent = new Set<string>()
    proc.stdout.on('data', (d) => {
      out += String(d)
      for (const [needle, line] of [
        ['P1: ', 'uno\n'],
        ['C1: ', 'dos\n'],
        ['P2: ', 'tres\n'],
      ] as const) {
        if (out.includes(needle) && !sent.has(needle)) {
          sent.add(needle)
          proc.stdin.write(line)
        }
      }
    })
    proc.on('error', reject)
    proc.on('exit', () => resolvePromise(out))
  })
}

describe('handing the terminal to a child and taking it back', () => {
  it('lets the child read its own line and leaves the parent able to ask again', async () => {
    const out = await driveHandoff()
    expect(out).toContain('PARENT_1=uno')
    // The line the child asked for reached the CHILD, not the paused parent.
    expect(out).toContain('CHILD_1=dos')
    expect(out).toContain('CHILD_EXIT=0')
    // The whole point: pausing must not mark the interface permanently closed.
    expect(out).toContain('CLOSED=false')
    expect(out).toContain('PARENT_2=tres')
  }, 20_000)
})

describe('defaultInteractiveRunner', () => {
  it('returns the child exit code', async () => {
    const result = await defaultInteractiveRunner(process.execPath, ['-e', 'process.exit(7)'], { env: process.env })
    expect(result).toEqual({ code: 7, spawnFailed: false })
  })

  it('reports a command that does not exist instead of throwing', async () => {
    const result = await defaultInteractiveRunner('agentbridge-no-existe-jamas', [], { env: process.env })
    expect(result.spawnFailed).toBe(true)
    expect(result.code).toBeNull()
  })

  it('runs the child in the requested folder', async () => {
    const result = await defaultInteractiveRunner(process.execPath, ['-e', 'process.exit(process.cwd() === process.env.EXPECTED ? 0 : 1)'], {
      env: { ...process.env, EXPECTED: fixtures },
      cwd: fixtures,
    })
    expect(result.code).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @agentbridge/cli -- interactive`
Expected: FAIL — `Failed to resolve import "../src/interactive"`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/interactive.ts`:

```ts
import { spawn } from 'node:child_process'
import { pausePrompt, resumePrompt } from './context'

// A child that takes over the terminal: its stdin, stdout and stderr ARE ours, so whoever is
// sitting at the keyboard is talking to it directly — no pipe in the middle, no output of ours
// interleaved with its own. This is how `setup` runs Claude's login and the responder itself
// instead of printing a command line and hoping the person pastes it correctly into the right
// shell. `code` is null when the process was killed by a signal (Ctrl+C on the child) or never
// started; `spawnFailed` separates "the binary is not installed" from "it ran and failed",
// because those two need very different sentences in Spanish.
export type InteractiveRunner = (
  command: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd?: string },
) => Promise<{ code: number | null; spawnFailed: boolean }>

export const defaultInteractiveRunner: InteractiveRunner = (command, args, opts) =>
  new Promise((resolvePromise) => {
    // Released BEFORE the spawn, not after: a readline interface that is still flowing competes
    // with the child for every keystroke, and the line the child asked for would be eaten by a
    // parent nobody is talking to.
    pausePrompt()
    let settled = false
    const finish = (result: { code: number | null; spawnFailed: boolean }) => {
      if (settled) return
      settled = true
      // Claude's own interface puts the terminal in raw mode. It restores it on a clean exit,
      // but a crash or a kill can leave it raw — and a raw terminal makes every later question
      // unreadable (no echo, no line editing). Putting it back costs nothing when it was already
      // cooked, and saves the rest of the session when it was not.
      try {
        if (process.stdin.isTTY) process.stdin.setRawMode(false)
      } catch {
        // A terminal we cannot put back is still a terminal we must not crash on.
      }
      resumePrompt()
      resolvePromise(result)
    }
    // No `shell: true`: args reach the child as an argv array, so nothing we pass — a folder
    // with a space, a model id, a path with an apostrophe — can be reinterpreted by a shell.
    // This is also what makes the whole plan work identically on Windows, where the shell is
    // not the one we would have quoted for.
    const child = spawn(command, args, { env: opts.env, cwd: opts.cwd, stdio: 'inherit' })
    child.on('error', () => finish({ code: null, spawnFailed: true }))
    child.on('exit', (code) => finish({ code, spawnFailed: false }))
  })
```

Y en `packages/cli/src/context.ts`, junto a `closePrompt`:

```ts
// Pause and resume, NEVER close, around a child process that takes over the terminal. `close()`
// fires the 'close' event, which sets `promptInterfaceClosed` permanently — that flag is the
// protection that tells "stdin really ended" apart from "we are busy", and tripping it here
// would leave every later question rejecting with PromptEOF even though the person is still
// sitting there. Verified against a real pseudo-terminal: after pause → spawn(stdio:'inherit') →
// resume, the flag is still false and the next `.question()` gets its answer normally.
export function pausePrompt(): void {
  sharedPromptInterface?.pause()
  if (sharedPromptInterface) process.stdin.pause()
}

export function resumePrompt(): void {
  if (sharedPromptInterface) process.stdin.resume()
  sharedPromptInterface?.resume()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @agentbridge/cli -- interactive`
Expected: PASS (5 tests).

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/interactive.ts packages/cli/src/context.ts packages/cli/test/interactive.test.ts packages/cli/test/fixtures/
git commit -m "feat(cli): hand the terminal to a child process and take it back"
```

---
### Task 2: El comando `responder` reemplaza a `start.sh`

**Files:**
- Create: `packages/cli/src/commands/responder.ts`
- Modify: `packages/cli/src/commands/setup-responder.ts` (borrar `startScript`; escribir `responder.json`; cambiar el valor de retorno y los "siguientes pasos")
- Modify: `packages/cli/src/router.ts` (registrar el comando y actualizar `USAGE`)
- Test: `packages/cli/test/responder.test.ts`
- Test: `packages/cli/test/setup-responder.test.ts` (reemplazar las pruebas de `startScript`)

**Interfaces:**
- Consumes: `InteractiveRunner` y `defaultInteractiveRunner` de la tarea 1; `CliError`, `CliContext`, `Output` de `context.ts`; `ALLOWED_EFFORTS` y `SAFE_MODEL_PATTERN` de `setup-responder.ts` (hoy `SAFE_MODEL_PATTERN` es privado: esta tarea lo exporta).
- Produces:
  - `export const RESPONDER_CONFIG_FILE = 'responder.json'`
  - `export type ResponderConfig = { version: 1; shareDir: string; identityHome: string; model: string; effort: string }`
  - `export async function readResponderConfig(profileHome: string): Promise<ResponderConfig>`
  - `export function responderArgs(o: { settingsPath: string; model: string; effort: string }): string[]`
  - `export async function runResponder(o: { profileHome: string; env: NodeJS.ProcessEnv; out: Output; runInteractive: InteractiveRunner }): Promise<number>`
  - `export const responderCommand` — mismo perfil estructural que los demás comandos, `(argv: string[], ctx: CliContext) => Promise<void>`, escrito así y **sin** importar el tipo `Command` de `router.ts`: ese módulo importa los comandos, y el tipo iría de vuelta.
  - `setupResponder` ahora devuelve `{ configPath: string; claudeConfigDir: string; settingsPath: string }` (antes `startScriptPath`). La tarea 5 usa `configPath` y `claudeConfigDir`.

**Por qué existe esta tarea.** `start.sh` es un script de bash. En Windows no corre: la persona que
probó la 0.2.0 recibió `Arranca el respondedor: 'C:\Users\dagui\.agentbridge-responder\start.sh'`, una
instrucción imposible. La alternativa de generar también un `.ps1` y un `.cmd` duplica el mismo error en
tres sintaxis. Lo que el script hace es cuatro cosas —entrar a una carpeta, exportar dos variables y
ejecutar `claude` con sus banderas— y las cuatro las hace mejor un comando nuestro, que además no
necesita que nadie sepa dónde quedó un archivo. Los datos que el script llevaba incrustados pasan a un
`responder.json` de 0600 en el perfil dedicado.

**Ruling (D2).** Las instalaciones que ya existen pierden su `start.sh`. Son dos, de hace un día, y el
arreglo es volver a correr `setup`, que dura un minuto. Mantener el script "por compatibilidad" obligaría
a sostener las dos rutas y a seguir imprimiendo una de ellas en Windows, que es el problema.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/responder.test.ts`:

```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { memoryOutput } from '../src/context'
import { readResponderConfig, responderArgs, runResponder, RESPONDER_CONFIG_FILE } from '../src/commands/responder'

async function profileWith(config: unknown): Promise<string> {
  const profileHome = await mkdtemp(join(tmpdir(), 'ab-responder-'))
  await writeFile(join(profileHome, RESPONDER_CONFIG_FILE), JSON.stringify(config), { mode: 0o600 })
  return profileHome
}

const goodConfig = { version: 1, shareDir: '/tmp/compartido', identityHome: '/tmp/identidad', model: 'sonnet', effort: 'low' }

describe('responder configuration', () => {
  it('reads the config setup wrote', async () => {
    const profileHome = await profileWith(goodConfig)
    await expect(readResponderConfig(profileHome)).resolves.toEqual(goodConfig)
  })

  it('says to run setup when the profile was never prepared', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'ab-responder-'))
    await expect(readResponderConfig(empty)).rejects.toThrow(/agentbridge setup/)
  })

  it('refuses a config with a model that could smuggle arguments', async () => {
    const profileHome = await profileWith({ ...goodConfig, model: 'sonnet --settings /otra/cosa' })
    await expect(readResponderConfig(profileHome)).rejects.toThrow(/no válido/i)
  })

  it('refuses an effort outside the allowed set', async () => {
    const profileHome = await profileWith({ ...goodConfig, effort: 'turbo' })
    await expect(readResponderConfig(profileHome)).rejects.toThrow(/turbo/)
  })

  it('refuses a config from a future version instead of guessing its shape', async () => {
    const profileHome = await profileWith({ ...goodConfig, version: 2 })
    await expect(readResponderConfig(profileHome)).rejects.toThrow(/versión/i)
  })
})

describe('responderArgs', () => {
  it('carries the development channel, the locked settings and the model', () => {
    const args = responderArgs({ settingsPath: '/perfil/settings.json', model: 'sonnet', effort: 'low' })
    expect(args).toEqual([
      '--dangerously-load-development-channels',
      'plugin:agentbridge@agentbridge-local',
      '--permission-mode',
      'dontAsk',
      '--settings',
      '/perfil/settings.json',
      '--model',
      'sonnet',
      '--effort',
      'low',
    ])
  })
})

describe('runResponder', () => {
  it('runs claude in the shared folder with both homes set', async () => {
    const profileHome = await profileWith(goodConfig)
    const out = memoryOutput()
    const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string }[] = []
    const code = await runResponder({
      profileHome,
      env: { PATH: '/usr/bin' },
      out,
      runInteractive: async (command, args, opts) => {
        calls.push({ command, args, env: opts.env, cwd: opts.cwd })
        return { code: 0, spawnFailed: false }
      },
    })
    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe('claude')
    expect(calls[0]?.cwd).toBe('/tmp/compartido')
    // The person's own identity and database — never a second one for the answering side.
    expect(calls[0]?.env.AGENTBRIDGE_HOME).toBe('/tmp/identidad')
    expect(calls[0]?.env.CLAUDE_CONFIG_DIR).toBe(join(profileHome, 'claude'))
    expect(calls[0]?.args).toContain('--dangerously-load-development-channels')
    expect(calls[0]?.args).toContain(join(profileHome, 'settings.json'))
  })

  it('explains in Spanish when claude is not installed', async () => {
    const profileHome = await profileWith(goodConfig)
    const out = memoryOutput()
    await expect(
      runResponder({
        profileHome,
        env: {},
        out,
        runInteractive: async () => ({ code: null, spawnFailed: true }),
      }),
    ).rejects.toThrow(/Claude Code/)
  })

  it('passes a non-zero exit code through without inventing an error', async () => {
    const profileHome = await profileWith(goodConfig)
    const out = memoryOutput()
    const code = await runResponder({
      profileHome,
      env: {},
      out,
      runInteractive: async () => ({ code: 3, spawnFailed: false }),
    })
    expect(code).toBe(3)
  })

  it('treats Ctrl+C as a normal stop, not a failure', async () => {
    const profileHome = await profileWith(goodConfig)
    const out = memoryOutput()
    const code = await runResponder({
      profileHome,
      env: {},
      out,
      runInteractive: async () => ({ code: null, spawnFailed: false }),
    })
    expect(code).toBe(0)
    expect(out.lines.join('\n')).toMatch(/dejaste de contestar|detuviste/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @agentbridge/cli -- responder`
Expected: FAIL — `Failed to resolve import "../src/commands/responder"`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/commands/responder.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { CLI_COMMAND } from '@agentbridge/core'
import { CliError, type CliContext, type Output } from '../context'
import { defaultInteractiveRunner, type InteractiveRunner } from '../interactive'
import { ALLOWED_EFFORTS, SAFE_MODEL_PATTERN } from './setup-responder'

export const RESPONDER_CONFIG_FILE = 'responder.json'

// What `start.sh` used to carry inside a bash script. Kept as data, in the dedicated profile,
// at 0600: the answering session is fenced out of this folder, so nothing it reads can rewrite
// which folder it serves or which settings file locks it down.
export type ResponderConfig = {
  version: 1
  shareDir: string
  identityHome: string
  model: string
  effort: string
}

export async function readResponderConfig(profileHome: string): Promise<ResponderConfig> {
  const path = join(resolve(profileHome), RESPONDER_CONFIG_FILE)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    // Never the underlying error: it carries a path, and this is the single most likely first
    // failure (someone ran `responder` before `setup`). One sentence, one thing to do.
    throw new CliError(`Todavía no está preparado el respondedor en esta computadora. Corre: ${CLI_COMMAND} setup`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new CliError(`El archivo de configuración del respondedor está dañado. Vuelve a correr: ${CLI_COMMAND} setup`)
  }
  const c = parsed as Partial<ResponderConfig>
  if (c.version !== 1) {
    // A newer AgentBridge wrote a shape this build does not know. Guessing at it would run the
    // answering session with the wrong folder or the wrong settings — the two things that must
    // never be wrong.
    throw new CliError(`Ese perfil lo escribió una versión más nueva de AgentBridge. Actualiza AgentBridge o vuelve a correr: ${CLI_COMMAND} setup`)
  }
  if (typeof c.shareDir !== 'string' || !c.shareDir || typeof c.identityHome !== 'string' || !c.identityHome) {
    throw new CliError(`El archivo de configuración del respondedor está incompleto. Vuelve a correr: ${CLI_COMMAND} setup`)
  }
  // Re-validated on the way IN, not only on the way out. setup validates what it writes, but this
  // file sits on disk between runs and reaches `claude` as argv: a model string with a space in it
  // would become two arguments, and `--settings` is one of them.
  if (typeof c.model !== 'string' || !SAFE_MODEL_PATTERN.test(c.model)) {
    throw new CliError(`El modelo guardado no es válido. Vuelve a correr: ${CLI_COMMAND} setup`)
  }
  if (typeof c.effort !== 'string' || !(ALLOWED_EFFORTS as readonly string[]).includes(c.effort)) {
    throw new CliError(`El esfuerzo guardado no es válido: "${String(c.effort)}". Vuelve a correr: ${CLI_COMMAND} setup`)
  }
  return { version: 1, shareDir: c.shareDir, identityHome: c.identityHome, model: c.model, effort: c.effort }
}

export function responderArgs(o: { settingsPath: string; model: string; effort: string }): string[] {
  return [
    '--dangerously-load-development-channels',
    'plugin:agentbridge@agentbridge-local',
    '--permission-mode',
    'dontAsk',
    '--settings',
    o.settingsPath,
    '--model',
    o.model,
    '--effort',
    o.effort,
  ]
}

export async function runResponder(o: {
  profileHome: string
  env: NodeJS.ProcessEnv
  out: Output
  runInteractive: InteractiveRunner
}): Promise<number> {
  const profileHome = resolve(o.profileHome)
  const config = await readResponderConfig(profileHome)
  const env = {
    ...o.env,
    // The person's own identity and database, shared with every command they type — not a second
    // set for the answering side, which would give them two links and two contact lists.
    AGENTBRIDGE_HOME: config.identityHome,
    // Claude's profile, on the other hand, IS dedicated: its own login and its own locked-down
    // settings never touch their everyday Claude Code.
    CLAUDE_CONFIG_DIR: join(profileHome, 'claude'),
  }
  o.out.log('Estás contestando preguntas. Déjalo abierto. Para parar: Ctrl+C.')
  const result = await o.runInteractive('claude', responderArgs({ settingsPath: join(profileHome, 'settings.json'), model: config.model, effort: config.effort }), {
    env,
    cwd: config.shareDir,
  })
  if (result.spawnFailed) {
    throw new CliError('No encontré Claude Code en esta computadora. Instálalo desde claude.com/claude-code y vuelve a intentarlo.')
  }
  if (result.code === null) {
    // Killed by a signal — Ctrl+C, which is exactly how a person stops this. Reporting it as a
    // failure would teach them that stopping is an error.
    o.out.log('Dejaste de contestar preguntas. Las que te lleguen mientras tanto se reintentan durante siete días.')
    return 0
  }
  return result.code
}

export const responderCommand = async (argv: string[], ctx: CliContext): Promise<void> => {
  const { values } = parseArgs({ args: argv, options: { profile: { type: 'string' } }, allowPositionals: false })
  const profileHome = values.profile ? resolve(values.profile) : join(homedir(), '.agentbridge-responder')
  const code = await runResponder({ profileHome, env: ctx.env, out: ctx.out, runInteractive: defaultInteractiveRunner })
  if (code !== 0) throw new CliError(`Claude Code terminó con código ${code}. Si se repite, corre: ${CLI_COMMAND} doctor`)
}
```

En `packages/cli/src/commands/setup-responder.ts`: borra por completo `startScript` y su comentario, y
exporta `SAFE_MODEL_PATTERN` (hoy es privado) para que `responder.ts` valide con el mismo patrón. Donde
se escribía el script:

```ts
  const configPath = join(profileHome, RESPONDER_CONFIG_FILE)
  const config: ResponderConfig = { version: 1, shareDir, identityHome, model, effort }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await chmod(configPath, 0o600)
```

Cambia el tipo de retorno a `{ configPath: string; claudeConfigDir: string; settingsPath: string }` y
devuelve `configPath` en lugar de `startScriptPath`. Los "siguientes pasos" pierden toda sintaxis de
shell:

```ts
    o.out.log('Siguientes pasos:')
    o.out.log(`  1. Inicia sesión una vez en el perfil dedicado:  ${CLI_COMMAND} setup   (lo hace por ti)`)
    o.out.log(`  2. Ponte a contestar:  ${CLI_COMMAND} responder`)
    o.out.log(`  3. Verifica:  ${CLI_COMMAND} doctor`)
```

En los dos mensajes de rechazo de `setup-responder.ts` que hoy dicen "settings.json y start.sh",
cambia el texto a "settings.json y responder.json".

En `packages/cli/src/commands/doctor.ts`, la sonda `looksLikeProfile` reconoce un perfil dedicado por la
presencia de `settings.json` **y** `start.sh`. Ese segundo archivo ya no existe, así que la sonda dejaría
de reconocer el perfil y daría el consejo equivocado ("créala con setup") a alguien que solo confundió
`--home` con `--profile`. Cambia `start.sh` por `RESPONDER_CONFIG_FILE` y actualiza la prueba que la
cubre en `packages/cli/test/doctor.test.ts`.

En `packages/cli/src/router.ts`: importa `responderCommand`, añádelo a `COMMANDS` como `responder`, y en
`USAGE`, bajo "Responder desde esta computadora", pon `${CLI_COMMAND} responder [--profile <carpeta>]`
como primera línea de esa sección.

- [ ] **Step 4: Update the tests that pinned the old script**

En `packages/cli/test/setup-responder.test.ts`, reemplaza cada prueba de `startScript` por su
equivalente sobre `responder.json`: que el archivo se escriba en 0600, que contenga `shareDir`,
`identityHome`, `model` y `effort`, y que `setupResponder` siga rechazando un modelo o un esfuerzo
inválidos antes de escribir nada. Borra los imports de `startScript`.

- [ ] **Step 5: Run the tests**

Run: `npm test -w @agentbridge/cli`
Expected: PASS.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/responder.ts packages/cli/src/commands/setup-responder.ts packages/cli/src/router.ts packages/cli/test/
git commit -m "feat(cli): replace start.sh with a responder command that runs everywhere"
```

---
### Task 3: Copiar el enlace al portapapeles

**Files:**
- Create: `packages/cli/src/clipboard.ts`
- Test: `packages/cli/test/clipboard.test.ts`

**Interfaces:**
- Consumes: nada de tareas anteriores.
- Produces:
  - `export type ClipboardWriter = (command: string, args: string[], text: string) => Promise<boolean>`
  - `export const defaultClipboardWriter: ClipboardWriter`
  - `export function clipboardCandidates(platform: NodeJS.Platform): { command: string; args: string[] }[]`
  - `export async function copyToClipboard(text: string, o?: { platform?: NodeJS.Platform; write?: ClipboardWriter }): Promise<boolean>`
  La tarea 5 usa `copyToClipboard`.

**Por qué existe esta tarea.** El enlace es lo único que la persona tiene que mandarle a alguien, y es
una cadena de más de setenta caracteres que empieza con `agentbridge:nprofile1`. Seleccionarla con el
ratón en una terminal es justo donde se corta o se le pega un espacio. Cada sistema ya trae la
herramienta para copiar; no hace falta una dependencia nueva, y si no hay ninguna el enlace se imprime
igual: esto es una comodidad, nunca un requisito (D5).

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @agentbridge/cli -- clipboard`
Expected: FAIL — `Failed to resolve import "../src/clipboard"`.

- [ ] **Step 3: Write the implementation**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @agentbridge/cli -- clipboard`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/clipboard.ts packages/cli/test/clipboard.test.ts
git commit -m "feat(cli): copy the link to the clipboard with the tools each system already has"
```

---
### Task 4: `doctor` en las tres plataformas, y en un idioma que se entienda

**Files:**
- Modify: `packages/cli/src/commands/doctor.ts`
- Test: `packages/cli/test/doctor.test.ts`

**Interfaces:**
- Consumes: nada de tareas anteriores.
- Produces:
  - `export type Check = { name: string; ok: boolean; detail: string; blocking: boolean }`
  - `export function cloudSyncedPath(path: string): string | null`
  - `runDoctor` acepta `platform?: NodeJS.Platform` (por omisión `process.platform`)
  La tarea 5 lee `blocking` para decidir de qué hablar.

**Por qué existe esta tarea.** Dos defectos distintos, los dos vistos en la misma instalación de Windows.

El primero: `doctor` exigió `0600` en una máquina donde los permisos POSIX no existen. En Windows
`fs.stat().mode` devuelve `666` siempre, en todos los archivos, sin excepción. La llave no estaba mal
guardada; la pregunta no tenía sentido ahí (D4). Y la pregunta que sí importa en Windows nadie la
estaba haciendo: la carpeta de usuario suele estar sincronizada con OneDrive, así que una llave secreta
creada ahí se sube sola a la nube.

El segundo: los diecisiete renglones que `doctor` imprime no distinguen entre "esto te impide contestar"
y "esto conviene saberlo". `setup` los imprimía todos, en orden de aparición, y eligió como "siguiente
paso" el único que era imposible. Una marca de si algo bloquea es lo que permite a la tarea 5 hablar
solo cuando hay algo que hacer.

- [ ] **Step 1: Write the failing test**

Añade a `packages/cli/test/doctor.test.ts`:

```ts
import { cloudSyncedPath } from '../src/commands/doctor'

describe('cloudSyncedPath', () => {
  it('spots OneDrive, which is where a Windows home folder usually lives', () => {
    expect(cloudSyncedPath('C:\\Users\\dani\\OneDrive\\Documentos\\.agentbridge')).toBe('OneDrive')
  })

  it('spots iCloud Drive on macOS', () => {
    expect(cloudSyncedPath('/Users/ana/Library/Mobile Documents/com~apple~CloudDocs/ab')).toBe('iCloud')
  })

  it('spots Dropbox and Google Drive', () => {
    expect(cloudSyncedPath('/home/j/Dropbox/ab')).toBe('Dropbox')
    expect(cloudSyncedPath('/home/j/Google Drive/ab')).toBe('Google Drive')
  })

  it('does not fire on a folder that merely contains the word', () => {
    // "mi-onedrive-notas" is not OneDrive, and a false alarm about a secret key is a sentence
    // that makes a person distrust every other line doctor prints.
    expect(cloudSyncedPath('/home/j/mi-onedrive-notas/ab')).toBeNull()
    expect(cloudSyncedPath('/home/j/proyectos/ab')).toBeNull()
  })
})

describe('doctor on Windows', () => {
  it('does not ask for POSIX permissions that cannot exist there', async () => {
    const home = join(root, 'win')
    await seedIdentity(home)
    await chmod(join(home, 'identity.json'), 0o666)
    const checks = await runDoctor(doctorOptions({ identityHome: home, platform: 'win32' }))
    expect(check(checks, 'Llave de AgentBridge').detail).not.toMatch(/0600|0700|666/)
  })

  it('still asks for them on macOS and Linux', async () => {
    const home = join(root, 'posix')
    await seedIdentity(home)
    await chmod(join(home, 'identity.json'), 0o644)
    const checks = await runDoctor(doctorOptions({ identityHome: home, platform: 'darwin' }))
    const key = check(checks, 'Llave de AgentBridge')
    expect(key.ok).toBe(false)
    expect(key.detail).toMatch(/0600/)
  })

  it('warns about a key in a cloud-synced folder, without blocking', async () => {
    const home = join(root, 'OneDrive', '.agentbridge')
    await seedIdentity(home)
    const checks = await runDoctor(doctorOptions({ identityHome: home, platform: 'win32' }))
    const warning = check(checks, 'Carpeta sincronizada con la nube')
    expect(warning.ok).toBe(false)
    // A key that is already in OneDrive is already uploaded. Telling someone to stop everything
    // does not un-upload it; telling them what happened and how to move it does.
    expect(warning.blocking).toBe(false)
    expect(warning.detail).toMatch(/OneDrive/)
  })

  it('says nothing about the cloud when the folder is an ordinary one', async () => {
    const home = join(root, 'normal')
    await seedIdentity(home)
    const checks = await runDoctor(doctorOptions({ identityHome: home, platform: 'darwin' }))
    expect(checks.find((c) => c.name === 'Carpeta sincronizada con la nube')).toBeUndefined()
  })
})

describe('what blocks and what does not', () => {
  it('marks a missing key as blocking and a single unreachable board as not', async () => {
    const checks = await runDoctor(doctorOptions({ identityHome: join(root, 'vacia'), platform: 'darwin' }))
    expect(check(checks, 'Llave de AgentBridge').blocking).toBe(true)
    for (const c of checks.filter((c) => c.name.startsWith('Tablero '))) expect(c.blocking).toBe(false)
  })
})
```

**Los ayudantes existen ya, con estos nombres exactos** — úsalos en lugar de inventar otros:
`doctorOptions(extra)` arma las opciones de `runDoctor` sobre el tablero falso, `seedIdentity(home)`
crea una identidad y un perfil de prueba, y `check(checks, nombre)` busca un chequeo y falla con un
mensaje útil si no está. Los `runDoctor({ identityHome: home, platform, run })` del código de arriba se
escriben entonces como `runDoctor(doctorOptions({ identityHome: home, platform }))`, con
`await seedIdentity(home)` antes cuando la prueba necesita una identidad válida.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @agentbridge/cli -- doctor`
Expected: FAIL — `cloudSyncedPath` no existe y `runDoctor` no acepta `platform`.

- [ ] **Step 3: Write the implementation**

En `packages/cli/src/commands/doctor.ts`:

```ts
export type Check = {
  name: string
  ok: boolean
  detail: string
  // True when this stops the person from answering questions at all. False for something worth
  // knowing that does not stop anything — one board down out of five, a key sitting in a synced
  // folder. `setup` speaks only about the blocking ones; `doctor` prints every one.
  blocking: boolean
}
```

```ts
// A folder that a sync client uploads on its own. A secret key created inside one is already in
// somebody else's datacenter before anyone thinks to ask. Matched on whole path SEGMENTS, never
// as a substring: a folder called "mi-onedrive-notas" is not OneDrive, and a false alarm about a
// secret key teaches people to ignore the true ones.
const CLOUD_FOLDERS: { label: string; segments: string[] }[] = [
  { label: 'OneDrive', segments: ['onedrive'] },
  { label: 'Dropbox', segments: ['dropbox'] },
  { label: 'Google Drive', segments: ['google drive', 'googledrive', 'my drive'] },
  { label: 'iCloud', segments: ['com~apple~clouddocs'] },
]

export function cloudSyncedPath(path: string): string | null {
  // Both separators, always: this function has to give the same answer about a Windows path when
  // a macOS test asks it, or the Windows behaviour would only ever be exercised on Windows.
  const parts = path.split(/[\\/]+/).map((p) => p.trim().toLowerCase())
  for (const folder of CLOUD_FOLDERS) {
    // `startsWith` on the segment, not on the path: OneDrive's business variant is a real folder
    // called "OneDrive - Contoso", and that one syncs exactly like the personal one.
    if (parts.some((p) => folder.segments.some((s) => p === s || p.startsWith(`${s} -`)))) return folder.label
  }
  return null
}
```

En `identityCheck`, recibe `platform` y salta los dos chequeos de modo cuando es `win32`:

```ts
  const problems: string[] = []
  // Windows has no POSIX permission bits: `stat().mode` reports 666 on every single file, so
  // this check can only ever produce a demand nobody can satisfy. What protects the key there is
  // the user profile's own ACL, which we do not weaken. The real risk on Windows is the folder
  // being synced to the cloud, and that is a separate check.
  if (o.platform !== 'win32') {
    const info = await stat(file).catch(() => null)
    const mode = info ? info.mode & 0o777 : null
    if (mode !== null && mode !== 0o600) problems.push(`la llave está en ${mode.toString(8)} y debe estar en 0600`)
    const homeInfo = await stat(o.identityHome).catch(() => null)
    const homeMode = homeInfo ? homeInfo.mode & 0o777 : null
    if (homeMode !== null && homeMode !== 0o700) problems.push(`su carpeta está en ${homeMode.toString(8)} y debe estar en 0700`)
  }
```

Ajusta el `detail` de éxito para que no prometa `0600` en Windows: cuando `o.platform === 'win32'`,
`'presente'` (más `' y fuera de la carpeta compartida'` si se revisó).

En `runDoctor`, el aviso de nube se añade solo cuando aplica, para que una instalación normal no cargue
con un renglón que siempre dice que todo está bien.

`doctor.ts` tiene además, en la línea del perfil dedicado, su propio consejo en sintaxis de bash:
`Inicia sesión una vez: CLAUDE_CONFIG_DIR='…' claude   (usa /login y sal)`. Es el mismo defecto que este
plan corrige en `setup`, y sobrevive aquí. Cámbialo por una frase que nombre al programa:

```ts
      authDetail = loggedIn ? 'Sesión activa' : `Todavía no has iniciado sesión. Lo hace por ti: ${CLI_COMMAND} setup`
```

Añade una prueba que lo fije: `expect(perfil.detail).not.toMatch(/CLAUDE_CONFIG_DIR=/)`.

Después del chequeo de identidad, añade el aviso de nube:

```ts
  const synced = cloudSyncedPath(o.identityHome)
  if (synced) {
    checks.push({
      name: 'Carpeta sincronizada con la nube',
      ok: false,
      blocking: false,
      detail: `Tu llave está dentro de ${synced}, así que se sube sola a la nube. Muévela a una carpeta que no se sincronice y vuelve a correr ${CLI_COMMAND} setup con esa carpeta.`,
    })
  }
```

Marca cada `Check` existente con `blocking`. Bloquean: la llave, la base de datos, el candado del canal,
la carpeta compartida, el perfil dedicado, la sesión iniciada. No bloquean: cada tablero por separado
(hay cinco, y con uno basta para publicar y leer), el aviso de nube, y las solicitudes pendientes, que
son información, no una falla. Para los tableros, añade un único chequeo agregado que **sí** bloquea
cuando **ninguno** sirve:

```ts
  // One board down out of five is weather. Zero boards working is the difference between
  // reaching someone and not reaching them at all — that one blocks.
  const boardChecks = checks.filter((c) => c.name.startsWith('Tablero '))
  if (boardChecks.length > 0 && boardChecks.every((c) => !c.ok)) {
    checks.push({
      name: 'Tableros públicos',
      ok: false,
      blocking: true,
      detail: 'Ningún tablero te dejó publicar y leer. Revisa tu conexión a internet; si estás en una red del trabajo o de una escuela, puede estar bloqueando las conexiones que AgentBridge usa.',
    })
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @agentbridge/cli -- doctor`
Expected: PASS.

Run: `npm test && npm run typecheck`
Expected: todo verde (otras pruebas construyen `Check` a mano; añádeles `blocking`).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/doctor.ts packages/cli/test/doctor.test.ts
git commit -m "fix(doctor): drop POSIX checks on Windows, warn about cloud-synced keys, mark what blocks"
```

---
### Task 5: `setup` inicia la sesión, arranca el respondedor y calla lo que no bloquea

**Files:**
- Modify: `packages/cli/src/commands/setup.ts`
- Test: `packages/cli/test/setup.test.ts`

**Interfaces:**
- Consumes: `InteractiveRunner` y `defaultInteractiveRunner` de `../interactive` (tarea 1); `runResponder` de `./responder` (tarea 2); `copyToClipboard` de `../clipboard` (tarea 3); el tipo `Check` y su campo `blocking` de `./doctor` (tarea 4).
- Produces:
  - `SetupContext` gana `runInteractive: InteractiveRunner` y `copyLink?: (text: string) => Promise<boolean>`
  - `export async function loginStep(o: { claudeConfigDir: string; env: NodeJS.ProcessEnv; out: Output; prompt: Prompt; run: CommandRunner; runInteractive: InteractiveRunner; alreadyLoggedIn: boolean }): Promise<boolean>`
  - `export function blockers(checks: readonly Check[]): Check[]`

**Por qué existe esta tarea.** Es el defecto que originó el plan. Hoy el asistente termina con una lista
de siete pendientes, dos de ellos comandos de shell que la persona tiene que copiar bien, en la shell
correcta, con las comillas correctas — y uno de ellos era imposible en su sistema. La persona que lo
vivió resumió el resultado en una frase: *"siento que la configuración está cero clara… una persona no
técnica cómo lo usaría?"*.

Lo que cambia no es el texto, es quién hace el trabajo. El inicio de sesión de Claude lo abre el
asistente y espera a que vuelva. El respondedor lo arranca el asistente. El enlace queda en el
portapapeles. Y de los diecisiete renglones de diagnóstico no queda ninguno, salvo que algo **impida**
contestar, en cuyo caso se dice esa cosa y solo esa cosa.

**El antes y el después, en el mismo punto del flujo:**

```
ANTES                                        DESPUÉS
[ok]    Base de datos: …                     Ahora hay que iniciar sesión en Claude. Te abro el
[falta] Llave de AgentBridge: la llave        inicio de sesión — se abre tu navegador. Cuando
        está en 666 y debe estar en 0600 ·    termines, vuelves solo aquí.
        su carpeta está en 666 …             Presiona Enter para abrirlo:
[falta] Tablero wss://relay.damus.io: …       ✓ Listo: la sesión quedó iniciada.
… 14 renglones más …
Pendiente:                                    Tu enlace — ya lo copié al portapapeles:
  - Llave de AgentBridge: la llave está…        agentbridge:nprofile1qqs…
  - Sesión iniciada: CLAUDE_CONFIG_DIR=…      Dáselo a quien quieras que pueda preguntarte.
  - Arranca el respondedor: 'C:\…\start.sh'
  … 4 más …                                   ¿Empiezo a contestar ahora? [s/n]
Siguiente paso: Llave de AgentBridge: …       (el asistente arranca el respondedor)
```

- [ ] **Step 1: Write the failing test**

Añade a `packages/cli/test/setup.test.ts`, siguiendo los ayudantes que el archivo ya usa para armar un
`SetupContext` con `prompt` guionado y directorios temporales:

```ts
describe('the login step', () => {
  it('does nothing and asks nothing when the profile is already logged in', async () => {
    const out = memoryOutput()
    const calls: string[] = []
    const ok = await loginStep({
      claudeConfigDir: '/perfil/claude',
      env: {},
      out,
      prompt: async () => {
        calls.push('asked')
        return ''
      },
      run: async () => ({ code: 0, stdout: '{"loggedIn":true}', stderr: '' }),
      runInteractive: async (command) => {
        calls.push(command)
        return { code: 0, spawnFailed: false }
      },
      alreadyLoggedIn: true,
    })
    expect(ok).toBe(true)
    expect(calls).toEqual([])
  })

  it('opens Claude in the dedicated profile and confirms afterwards', async () => {
    const out = memoryOutput()
    const spawned: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
    const ok = await loginStep({
      claudeConfigDir: '/perfil/claude',
      env: { PATH: '/usr/bin' },
      out,
      prompt: async () => '',
      // The check that runs AFTER the person comes back. `claude auth status --json` exits 0
      // either way, so the verdict is the parsed field — a fake that returned only `code: 0`
      // would let a broken implementation pass.
      run: async () => ({ code: 0, stdout: '{"loggedIn":true}', stderr: '' }),
      runInteractive: async (command, args, opts) => {
        spawned.push({ command, args, env: opts.env })
        return { code: 0, spawnFailed: false }
      },
      alreadyLoggedIn: false,
    })
    expect(ok).toBe(true)
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.command).toBe('claude')
    // The dedicated subcommand, not the whole interface: nothing for the person to type inside.
    expect(spawned[0]?.args).toEqual(['auth', 'login'])
    // The whole point of the dedicated profile: this login must not touch their everyday one.
    expect(spawned[0]?.env.CLAUDE_CONFIG_DIR).toBe('/perfil/claude')
    // Never a shell line for them to paste.
    expect(out.lines.join('\n')).not.toMatch(/CLAUDE_CONFIG_DIR=/)
  })

  it('says plainly that the session is still not started, without blaming them', async () => {
    const out = memoryOutput()
    const ok = await loginStep({
      claudeConfigDir: '/perfil/claude',
      env: {},
      out,
      prompt: async () => '',
      // Exit 0 with loggedIn:false — what really happens when someone opens Claude and closes it
      // without logging in. A test that used a non-zero code here would pass against an
      // implementation that only checks the exit code, which is the bug this pins.
      run: async () => ({ code: 0, stdout: '{"loggedIn":false}', stderr: '' }),
      runInteractive: async () => ({ code: 0, spawnFailed: false }),
      alreadyLoggedIn: false,
    })
    expect(ok).toBe(false)
    expect(out.lines.join('\n')).toMatch(/no quedó iniciada/i)
    expect(out.lines.join('\n')).toContain(`${CLI_COMMAND} setup`)
  })

  it('explains that Claude Code is missing instead of pretending it opened', async () => {
    const out = memoryOutput()
    const ok = await loginStep({
      claudeConfigDir: '/perfil/claude',
      env: {},
      out,
      prompt: async () => '',
      run: async () => ({ code: 0, stdout: '{"loggedIn":false}', stderr: '' }),
      runInteractive: async () => ({ code: null, spawnFailed: true }),
      alreadyLoggedIn: false,
    })
    expect(ok).toBe(false)
    expect(out.lines.join('\n')).toMatch(/claude\.com\/claude-code/)
  })
})

describe('blockers', () => {
  it('keeps only the failing checks that stop the person from answering', () => {
    const checks = [
      { name: 'Base de datos', ok: true, detail: 'ok', blocking: true },
      { name: 'Tablero wss://uno', ok: false, detail: 'no', blocking: false },
      { name: 'Llave de AgentBridge', ok: false, detail: 'falta', blocking: true },
    ]
    expect(blockers(checks).map((c) => c.name)).toEqual(['Llave de AgentBridge'])
  })
})

describe('the guided flow as a whole', () => {
  it('prints no shell syntax and no technical check list when everything works', async () => {
    const ctx = responderSetupContext({ answers: ['Dani', '1', '', '', 'n'] })
    await runSetup(ctx)
    const text = ctx.out.lines.join('\n')
    expect(text).not.toMatch(/CLAUDE_CONFIG_DIR=/)
    expect(text).not.toMatch(/start\.sh/)
    expect(text).not.toMatch(/\[ok\]/)
    expect(text).not.toMatch(/\[falta\]/)
    expect(text).toContain('agentbridge:nprofile1')
    expect(text).toMatch(/portapapeles/)
  })

  it('names the one thing that blocks, and nothing else', async () => {
    // A run where one board is unreachable (not blocking) and the login never happened (blocking).
    const ctx = responderSetupContext({ answers: ['Dani', '1', '', '', 'n'], loggedIn: false })
    await runSetup(ctx)
    const text = ctx.out.lines.join('\n')
    expect(text).toMatch(/no quedó iniciada/i)
    expect(text).not.toMatch(/Tablero wss:/)
  })

  it('starts answering when asked to', async () => {
    const ctx = responderSetupContext({ answers: ['Dani', '1', '', '', 's'] })
    await runSetup(ctx)
    expect(ctx.interactiveCalls.map((c) => c.args.join(' ')).join('\n')).toContain('plugin:agentbridge@agentbridge-local')
  })

  it('does not skip the asking side when the person chose both roles', async () => {
    // The ordering bug this plan nearly shipped: starting the responder from inside the answering
    // branch would return before `connect` and the MCP registration ever ran, and the person would
    // have no way to know what they did not get.
    const ctx = responderSetupContext({ answers: ['Dani', '3', '', '', 'n', 'n', 's'] })
    await runSetup(ctx)
    const text = ctx.out.lines.join('\n')
    expect(text).toMatch(/servidor MCP/i)
    // And the responder still starts, after everything else.
    expect(ctx.interactiveCalls.map((c) => c.args.join(' ')).join('\n')).toContain('plugin:agentbridge@agentbridge-local')
  })

  it('still prints the link when no clipboard tool exists', async () => {
    const ctx = responderSetupContext({ answers: ['Dani', '1', '', '', 'n'], copyLink: async () => false })
    await runSetup(ctx)
    const text = ctx.out.lines.join('\n')
    expect(text).toContain('agentbridge:nprofile1')
    expect(text).not.toMatch(/portapapeles/)
  })
})
```

`responderSetupContext` es un ayudante nuevo en ese mismo archivo de pruebas: arma un `SetupContext`
sobre directorios temporales, con `run` simulando `claude` (según `loggedIn`), `runInteractive`
registrando llamadas en `ctx.interactiveCalls`, y `copyLink` devolviendo `true` por omisión.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @agentbridge/cli -- setup`
Expected: FAIL — `loginStep` y `blockers` no existen.

- [ ] **Step 3: Write the implementation**

En `packages/cli/src/commands/setup.ts`, añade al `SetupContext`:

```ts
  // How this command hands the terminal over to Claude — for the login, and for the responder
  // itself. Injected like `run` so tests never spawn anything.
  runInteractive: InteractiveRunner
  // Returns false when no clipboard tool exists. Injected so a test does not depend on whether
  // the machine running it happens to have one.
  copyLink?: (text: string) => Promise<boolean>
```

y en `setupCommand`, al construir el contexto: `runInteractive: defaultInteractiveRunner`.

El paso de inicio de sesión, exportado para probarlo por separado:

```ts
// Claude's login is a person typing a password into a browser. We cannot do that for them — but
// we CAN open the right Claude, in the right profile, and be there when they come back. What we
// must never do is what 0.2 did: print `CLAUDE_CONFIG_DIR='…' claude` and leave. That line is
// bash; in PowerShell it is a syntax error, and the person who hit it had no way to know that the
// instruction itself was wrong rather than their typing.
export async function loginStep(o: {
  claudeConfigDir: string
  env: NodeJS.ProcessEnv
  out: Output
  prompt: Prompt
  run: CommandRunner
  runInteractive: InteractiveRunner
  alreadyLoggedIn: boolean
}): Promise<boolean> {
  if (o.alreadyLoggedIn) return true
  const env = { ...o.env, CLAUDE_CONFIG_DIR: o.claudeConfigDir }
  o.out.log('Ahora hay que iniciar sesión en Claude. Uso una cuenta aparte, solo para contestar preguntas:')
  o.out.log('tu Claude de todos los días no se toca.')
  o.out.log('Te abro el inicio de sesión — se va a abrir tu navegador. Cuando termines, vuelves solo aquí.')
  // Enter, not a yes/no: there is no "no" that leads anywhere — without a session there is
  // nothing to answer with. A question with one real answer should not be asked as if it had two.
  await o.prompt('Presiona Enter para abrirlo: ')
  // `claude auth login`, not a bare `claude`. Claude Code ships a dedicated login subcommand that
  // does one thing and exits; opening the whole interface instead would mean teaching the person
  // two slash commands (`/login` to start it, `/exit` to come back) — which is the very habit this
  // plan exists to end. One command, no instructions to remember.
  const opened = await o.runInteractive('claude', ['auth', 'login'], { env })
  if (opened.spawnFailed) {
    o.out.log('No encontré Claude Code en esta computadora. Instálalo desde claude.com/claude-code y vuelve a correr este asistente.')
    return false
  }
  // Asked again afterwards instead of trusting the exit code — and asked the way `doctor`
  // already asks it, which is `--json` plus a parsed `loggedIn` field. The exit code alone is
  // NOT the answer: `claude auth status` exits 0 whether or not there is a session, which is
  // exactly why doctor.ts parses the JSON instead. Claiming a session that does not exist would
  // send someone to start a responder that cannot answer a single question.
  const status = await o
    .run('claude', ['auth', 'status', '--json'], { env, signal: AbortSignal.timeout(15_000) })
    .catch(() => ({ code: 127, stdout: '', stderr: '' }))
  let loggedIn = false
  try {
    loggedIn = (JSON.parse(status.stdout) as { loggedIn?: boolean }).loggedIn === true
  } catch {
    // Unparseable output is not a session. Same reading doctor takes.
  }
  if (loggedIn) {
    o.out.log('Listo: la sesión quedó iniciada.')
    return true
  }
  o.out.log(`La sesión no quedó iniciada. Puedes intentarlo otra vez cuando quieras con: ${CLI_COMMAND} setup`)
  return false
}

// The failing checks that actually stop this person from answering questions. Everything else —
// a board down out of five, a key in a synced folder — belongs to `doctor`, not to the minute
// someone is installing this for the first time.
export function blockers(checks: readonly Check[]): Check[] {
  return checks.filter((c) => !c.ok && c.blocking)
}
```

Sustituye el bloque que hoy va desde `out.log('Verificando con doctor…')` hasta el final de la rama del
respondedor por:

```ts
    const checks = await runDoctor({
      identityHome: ctx.home,
      profileHome,
      shareDir,
      repoDir,
      run: ctx.run,
      createSocket: ctx.createSocket,
      relayPolicy: ctx.relayPolicy,
    })

    const loggedIn = await loginStep({
      claudeConfigDir: setupResult.claudeConfigDir,
      env: ctx.env,
      out,
      prompt,
      run: ctx.run,
      runInteractive: ctx.runInteractive,
      alreadyLoggedIn: checks.some((c) => c.name === 'Sesión iniciada en el perfil dedicado' && c.ok),
    })
    out.log('')

    // Everything that blocks, said once, in the words of whoever wrote the check — and nothing
    // that does not. `doctor` still prints all of it, and the last line of this command says so.
    for (const c of blockers(checks).filter((c) => c.name !== 'Sesión iniciada en el perfil dedicado')) {
      out.log(`Falta algo: ${c.detail}`)
    }

    const copied = await (ctx.copyLink ?? copyToClipboard)(myLink)
    out.log(copied ? 'Tu enlace — ya lo copié al portapapeles:' : 'Tu enlace:')
    out.log(`  ${myLink}`)
    out.log('Dáselo a quien quieras que pueda preguntarte. Cuando te manden una solicitud, la ves con:')
    out.log(`  ${CLI_COMMAND} requests`)
    out.log('')

    done.push('Listo para contestar desde esta computadora.')
    // NOT started here. Starting the responder occupies the terminal until Ctrl+C, and this is
    // section 3 of five: someone who answered "3" (both sides) still has the asking side ahead of
    // them — the link they paste, `connect`, the MCP registration. Starting here would silently
    // skip all of it and they would never know what they did not get. The offer happens after the
    // verdict, as the very last thing this command does.
    canStartResponder = loggedIn && blockers(checks).length === 0
    responderProfileHome = profileHome
    if (!canStartResponder) pending.push(`Cuando esté resuelto, empieza a contestar con: ${CLI_COMMAND} responder`)
```

Declara las dos variables junto a `done` y `pending`, al principio de `runGuidedSetup`:

```ts
  const done: string[] = [`Identidad lista como ${profile.name}.`]
  const pending: string[] = []
  // Filled in by the answering branch; read after the verdict, which is the only place from which
  // starting the responder cannot swallow a step that has not run yet.
  let canStartResponder = false
  let responderProfileHome: string | null = null
```

donde `SUMMARY_BEFORE_START_ES` es una constante del módulo:

```ts
const SUMMARY_BEFORE_START_ES = [
  'Ya quedó. A partir de aquí:',
  `  - Para ver quién te pidió permiso:   ${CLI_COMMAND} requests`,
  `  - Para revisar que todo siga bien:   ${CLI_COMMAND} doctor`,
  `  - Para volver a contestar mañana:    ${CLI_COMMAND} responder`,
].join('\n')
```

En el veredicto final (sección 5), cambia el cierre para que no repita el diagnóstico y para que nombre
a `doctor` una sola vez:

```ts
  out.log('== Resumen ==')
  for (const d of done) out.log(`  ✓ ${d}`)
  if (pending.length > 0) {
    out.log('Te falta:')
    for (const p of pending) out.log(`  - ${p}`)
  }
  out.log('')
  out.log(`Si algo no funciona, esto te dice qué es: ${CLI_COMMAND} doctor`)

  // The last thing, after every branch has run and the verdict has been printed. Offered, not
  // ordered, and only when it can actually work: asking someone to start a responder with no
  // session would hand them a failure as the last thing they see.
  if (canStartResponder && responderProfileHome) {
    const startNow = await askWithRetries(
      prompt,
      out,
      '¿Empiezo a contestar ahora? [s/n]: ',
      parseYesNo,
      'Escribe s (sí) o n (no).',
      `No entendí tu respuesta. Cuando quieras empezar: ${CLI_COMMAND} responder`,
    ).catch(() => false)
    if (!startNow) {
      out.log(`Cuando quieras empezar a contestar: ${CLI_COMMAND} responder`)
      return
    }
    out.log('')
    out.log(SUMMARY_BEFORE_START_ES)
    // Occupies the terminal until Ctrl+C. Nothing may follow it.
    await runResponder({ profileHome: responderProfileHome, env: ctx.env, out, runInteractive: ctx.runInteractive })
  }
```

**La rama de quien pregunta no se toca.** Sus tres pasos —pedir el enlace, `connect`, registrar el
servidor MCP— ya los ejecuta el programa, y el único comando que imprime (`claude mcp add …`) es la
alternativa para cuando el registro automático falla o la persona dice que no. No lleva variables de
entorno ni comillas que dependan de la shell, así que funciona igual en las tres plataformas. Déjala
exactamente como está: cambiarla aquí sería alcance que este plan no pidió.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @agentbridge/cli -- setup`
Expected: PASS.

Run: `npm test && npm run typecheck`
Expected: todo verde.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/setup.ts packages/cli/test/setup.test.ts
git commit -m "feat(setup): run the login and the responder instead of printing commands to paste"
```

---
### Task 6: La documentación describe lo que el programa hace ahora

**Files:**
- Modify: `README.md`
- Modify: `docs/inicio-rapido.md`
- Modify: `docs/runbooks/aceptacion-0.2.md` → renombrar a `docs/runbooks/aceptacion-0.3.md`
- Modify: `CLAUDE.md`
- Modify: `docs/known-gaps.md`
- Test: `tests/acceptance/docs.test.ts`

**Interfaces:**
- Consumes: el comando `responder` (tarea 2) y el flujo nuevo de `setup` (tarea 5).
- Produces: nada que otra tarea consuma.

**Por qué existe esta tarea.** La documentación sigue mandando a la gente a correr `start.sh` y a
exportar `CLAUDE_CONFIG_DIR` a mano. Si eso queda escrito, el problema vuelve por la puerta de atrás:
alguien lee el README en Windows y hace exactamente lo que la 0.2 le hacía hacer. Y lo que reemplaza a
esas líneas no es una instrucción nueva, es su ausencia — el asistente ya lo hace.

**Ruling (D3).** El runbook de aceptación se renombra en vez de patcharse. Su §0 monta el entorno a mano
con el script y las variables; con el flujo nuevo ese montaje ES el flujo, así que media docena de pasos
desaparecen en lugar de reescribirse. El archivo viejo se borra en el mismo commit: dejar los dos
invitaría a seguir el equivocado.

- [ ] **Step 1: Write the failing test**

`tests/acceptance/docs.test.ts` — una prueba que falla si la documentación vuelve a pedir sintaxis de
shell. No es cosmética: es la única red que impide que la próxima edición reintroduzca el defecto que
originó este plan.

```ts
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = new URL('../../', import.meta.url).pathname
// Plans and specs are a record of what was decided when they were written; rewriting history to
// satisfy a lint would destroy the reason they exist. Everything a person is meant to FOLLOW is
// covered.
const DOCS = ['README.md', 'CLAUDE.md', 'docs/inicio-rapido.md', 'docs/known-gaps.md', 'docs/runbooks/aceptacion-0.3.md']

describe('the docs do not ask a person to paste shell', () => {
  it('never mentions start.sh', async () => {
    for (const doc of DOCS) {
      expect(await readFile(join(ROOT, doc), 'utf8'), doc).not.toMatch(/start\.sh/)
    }
  })

  it('never shows an inline environment-variable assignment', async () => {
    // `VAR='x' comando` is bash. It is a syntax error in PowerShell, which is what the person on
    // Windows was handed. If a doc needs something in the environment, the program sets it.
    for (const doc of DOCS) {
      expect(await readFile(join(ROOT, doc), 'utf8'), doc).not.toMatch(/CLAUDE_CONFIG_DIR=\S/)
    }
  })

  it('tells people about the responder command', async () => {
    expect(await readFile(join(ROOT, 'docs/inicio-rapido.md'), 'utf8')).toMatch(/agentbridge responder/)
  })

  it('left no copy of the 0.2 acceptance runbook behind', async () => {
    const runbooks = await readdir(join(ROOT, 'docs/runbooks'))
    expect(runbooks).not.toContain('aceptacion-0.2.md')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- docs`
Expected: FAIL — README, CLAUDE.md, la guía y el runbook 0.2 todavía nombran `start.sh`.

- [ ] **Step 3: Rewrite the docs**

`docs/inicio-rapido.md` — el corazón del cambio. La guía se vuelve corta porque el trabajo se volvió
corto. Escríbela así, en este orden:

1. **Qué necesitas**: Node 22.13 o más nuevo, y Claude Code instalado. Nada más.
2. **Un comando**: `npx -y @joseamica/agentbridge@latest setup`.
3. **Qué te va a preguntar**, en tres viñetas: tu nombre, si vas a contestar o a preguntar, y —si vas a
   contestar— qué carpeta compartes. Explica en una frase qué significa compartir una carpeta: *quien
   tenga tu permiso puede leer todo lo que esté ahí dentro, así que pon copias, nunca tu carpeta de
   trabajo*.
4. **Qué va a hacer solo**: abrir Claude para que inicies sesión, dejar la carpeta lista, copiarte el
   enlace al portapapeles y —si le dices que sí— ponerte a contestar.
5. **Los dos comandos del día a día**: `agentbridge responder` para ponerte a contestar, y
   `agentbridge requests` para ver quién te pidió permiso.
6. **Si algo falla**: `agentbridge doctor`, y qué significan sus renglones.

No incluyas ninguna ruta a un script, ninguna variable de entorno y ninguna diferencia entre sistemas
operativos: si el texto necesita decir "en Windows haz esto otro", el defecto está en el programa, no en
la guía.

`README.md` — en la sección de la máquina que contesta, reemplaza el paso de `start.sh` por
`${CLI_COMMAND} responder`, y en la lista de comandos añade `responder` junto a `setup` y `doctor`.
Quita la mención a exportar `CLAUDE_CONFIG_DIR`: eso ahora lo hace `responder`.

`CLAUDE.md` — quita la línea sobre `start.sh` si la hay y añade, a la lista de anclas que ya tiene:

```
- El respondedor se arranca con `agentbridge responder`, que lee `responder.json` del perfil dedicado.
  No hay script de shell: uno solo funcionaría en dos de las tres plataformas, y esa fue exactamente
  la falla que rompió la primera instalación en Windows.
- Nada de lo que lee una persona puede contener sintaxis de shell (`VAR='x' comando`, rutas a `.sh`).
  Si hace falta que algo ocurra, lo ejecuta el programa. `tests/acceptance/docs.test.ts` lo vigila.
```

`docs/known-gaps.md` — añade lo que este plan deja fuera a propósito:

```
- **El inicio de sesión de Claude lo hace la persona.** El asistente abre la ventana correcta, en el
  perfil correcto, y comprueba después si quedó iniciada; escribir la contraseña es de ella. No hay
  forma de automatizarlo y no debería haberla.
- **El portapapeles puede no existir.** En un Linux sin `wl-copy`, `xclip` ni `xsel`, el enlace se
  imprime y ya. Es una comodidad; nada depende de ella.
- **Windows no se prueba en CI.** Las dos correcciones de esta versión (permisos POSIX y carpetas
  sincronizadas) están probadas inyectando la plataforma, no corriendo en Windows.
```

`docs/runbooks/aceptacion-0.2.md` → `docs/runbooks/aceptacion-0.3.md` con `git mv`. Reescribe §0: ya no
monta nada a mano; ahora es *correr `setup` en las dos máquinas y contestar las preguntas*. Conserva
intactas las ocho comprobaciones de seguridad contra un respondedor vivo y la corrida de 24 horas —
esas no cambian, y son lo único que este proyecto tiene en lugar de un entorno de pruebas. Añade una
comprobación nueva a la lista: **que en ninguna pantalla del flujo aparezca una línea que la persona
tenga que copiar**.

Actualiza también las referencias al runbook en `CLAUDE.md` y en `README.md`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- docs`
Expected: PASS (4 tests).

Run: `npm test`
Expected: todo verde.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md docs/ tests/acceptance/docs.test.ts
git commit -m "docs: describe the flow the program performs, and pin that no doc asks for shell"
```

---
### Task 7: Versión 0.3.0 y un solo comando para publicar

**Files:**
- Modify: `plugins/agentbridge/.claude-plugin/plugin.json` (la versión vive aquí y solo aquí)
- Modify: `package.json` (script `release`)
- Create: `scripts/release.mjs`
- Test: `tests/acceptance/packaging.test.ts`

**Interfaces:**
- Consumes: el comando `responder` (tarea 2), que el paquete tiene que exponer.
- Produces: `npm run release`.

**Por qué existe esta tarea.** La 0.2.1 se publicó a mano, y la secuencia correcta no es evidente: el
`package.json` de la raíz es privado y no tiene versión, así que `npm publish` desde ahí falla con
`Cannot read properties of null (reading 'prerelease')` — un error que no dice nada sobre lo que está
mal. Hay que construir, empacar y publicar **desde `./dist/pack`**. Eso es conocimiento que hoy vive en
la cabeza de una persona y en el historial de una conversación; un script lo vuelve reproducible.

- [ ] **Step 1: Write the failing test**

Añade a `tests/acceptance/packaging.test.ts`:

```ts
it('publishes version 0.3.0', async () => {
  const manifest = JSON.parse(await readFile(join(repoRoot, 'plugins/agentbridge/.claude-plugin/plugin.json'), 'utf8'))
  expect(manifest.version).toBe('0.3.0')
})

it('exposes the responder command from the packaged bundle', () => {
  // The bundle is what a person actually installs. A command that exists only in the workspace
  // sources is a command that does not exist.
  const result = spawnSync(process.execPath, [join(packDir, 'bin/agentbridge.js'), '--help'], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  expect(result.stdout).toMatch(/agentbridge responder/)
})

it('runs the responder command from the packaged bundle without a profile', () => {
  // Exercised end to end because this is the first thing a person types after setup, and the
  // failure it must produce is a Spanish sentence, not a stack trace.
  const result = spawnSync(process.execPath, [join(packDir, 'bin/agentbridge.js'), 'responder', '--profile', join(tmpdir(), 'ab-no-existe-jamas')], {
    encoding: 'utf8',
  })
  expect(result.status).toBe(1)
  expect(result.stderr).toMatch(/agentbridge setup/)
})
```

Ese archivo ya tiene `repoRoot`, `packDir`, `assemble()` y corre el bundle con
`spawnSync(process.execPath, [join(packDir, 'bin/agentbridge.js'), …])`. Usa esos, no inventes un
ayudante nuevo. El binario empacado se llama `bin/agentbridge.js`, no `.mjs`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- packaging`
Expected: FAIL — la versión sigue en `0.2.1` y `responder` no aparece en la ayuda.

- [ ] **Step 3: Bump the version and write the release script**

`plugins/agentbridge/.claude-plugin/plugin.json`: `"version": "0.3.0"`.

`scripts/release.mjs`:

```js
#!/usr/bin/env node
// The publish sequence, so nobody has to remember it. Running `npm publish` from the repository
// root fails with "Cannot read properties of null (reading 'prerelease')" — the root package is
// private and has no version — and that error says nothing about what is actually wrong. What
// gets published is ./dist/pack, and only after the tests pass.
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'

const step = (command, args) => {
  console.log(`\n$ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`\nFalló: ${command} ${args.join(' ')}`)
    process.exit(result.status ?? 1)
  }
}

const manifest = JSON.parse(await readFile(new URL('../plugins/agentbridge/.claude-plugin/plugin.json', import.meta.url), 'utf8'))
const version = manifest.version

step('npm', ['test'])
step('npm', ['run', 'typecheck'])
step('npm', ['run', 'build'])
step('npm', ['run', 'pack'])

console.log(`\nTodo verde. Falta un paso, y es tuyo:\n`)
console.log(`  npm publish ./dist/pack`)
console.log(`\nDespués:\n`)
console.log(`  git tag v${version} && git push origin main --tags`)
console.log(`  gh release create v${version} --title "AgentBridge ${version}" --notes-file <notas>`)
```

**Ruling.** El script **no publica**: se detiene y dice el comando. Publicar en npm es irreversible —
una versión no se puede borrar ni reemplazar — y va firmada con las credenciales de una persona. El
script hace todo lo que sí es reversible y deja el último paso a quien tiene la cuenta.

En `package.json`, añade a `scripts`: `"release": "node scripts/release.mjs"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npm run pack && npm test -- packaging`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/agentbridge/.claude-plugin/plugin.json package.json scripts/release.mjs tests/acceptance/packaging.test.ts
git commit -m "chore: bump to 0.3.0 and add a release script that stops before publishing"
```

---

### Task 8: Verificación de la rama completa

**Files:**
- Test: ninguno nuevo — esta tarea corre lo que existe y comprueba el resultado a mano.

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: el veredicto.

**Por qué existe esta tarea.** Las siete anteriores prueban piezas. Esta prueba la experiencia, que es
lo que el plan promete arreglar, y lo hace de la única forma que vale: corriendo el asistente de
principio a fin como lo correría una persona.

- [ ] **Step 1: La suite completa**

```bash
npm test
npm run typecheck
npm run build
npm run pack
```

Todo verde, sin advertencias nuevas.

- [ ] **Step 2: El asistente, de principio a fin, en una terminal de verdad**

Sobre una identidad desechable, para no tocar la del dueño:

```bash
AGENTBRIDGE_HOME=$(mktemp -d) node dist/pack/bin/agentbridge.js setup --profile "$(mktemp -d)"
```

Contesta las preguntas como lo haría alguien que instala esto por primera vez. Lo que hay que
comprobar, en la pantalla, no en el código:

- No aparece ni una línea que haya que copiar: ni `CLAUDE_CONFIG_DIR=…`, ni una ruta a un `.sh`, ni
  comillas de shell.
- La ventana de inicio de sesión se abre sola y el asistente sigue preguntando cuando vuelves.
- El enlace queda en el portapapeles: pégalo en cualquier lado y compáralo con el impreso.
- Al decir que sí, el respondedor arranca en la misma terminal.
- Ctrl+C lo detiene y no reporta un error.

- [ ] **Step 3: `doctor` con todo apagado y con todo prendido**

```bash
node dist/pack/bin/agentbridge.js doctor
```

Cada renglón se entiende sin saber cómo está hecho el programa, y ninguno pide algo imposible.

- [ ] **Step 4: Los tableros, una vez**

```bash
npm run test:live
```

Una sola corrida, a propósito. Si un tablero falla, anótalo; **no lo reemplaces sin probar publicación
y lectura por separado** — así entró `relay.damus.io`, que aceptaba publicar y no servía lecturas.

- [ ] **Step 5: Lo que no se pudo probar aquí**

Windows no se corre en esta máquina. Deja escrito en el reporte que las dos correcciones de esa
plataforma están probadas inyectando `platform`, y que la comprobación real es la primera instalación
de alguien en Windows.

- [ ] **Step 6: Commit (solo si algo hubo que ajustar)**

```bash
git add -A
git commit -m "fix: adjustments from the end-to-end verification of 0.3.0"
```

---
