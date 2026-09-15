import { access, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { CliError, PromptEOF, requireConfig, tryReadConfig, type CliContext, type Output, type Prompt } from '../context'
import { resolveComparablePath } from '../fs-paths'
import { enroll } from './account'
import { projectConfigArtifacts, runDoctor } from './doctor'
import { defaultRunner, repoDirFromBundleLocation, setupResponder, type CommandRunner } from './setup-responder'

// The guided flow needs two extra things the plain CliContext does not carry: something to
// drive prompts with (real readline in production, a scripted queue in tests — see
// context.ts's `Prompt` type) and a CommandRunner to hand to setupResponder/doctor and to the
// `claude mcp add` step, so every subprocess spawn in this whole command goes through the same
// injectable seam the rest of the CLI already tests with. `repoDir` and `responderHome` are
// optional overrides: setupCommand fills them from --repo/--home (or the same defaults
// setup-responder and doctor use); tests always pass explicit temp directories so nothing here
// ever touches a real ~/.agentbridge-responder or a real Claude Code checkout.
export type SetupContext = CliContext & {
  prompt: Prompt
  run: CommandRunner
  repoDir?: string
  responderHome?: string
}

export const NON_INTERACTIVE_ES = [
  'agentbridge setup necesita una terminal interactiva para hacerte preguntas, y esta no lo es',
  '(por ejemplo, se está corriendo dentro de un script, con la entrada redirigida, o en CI).',
  '',
  'Corre el equivalente a mano, en este orden:',
  '  agentbridge enroll <tu enlace de alta>',
  '  agentbridge setup-responder --share <carpeta compartida>',
  '  agentbridge doctor --home ~/.agentbridge-responder --share <carpeta compartida>',
  '  agentbridge invite',
  '  claude mcp add agentbridge --scope user -- npx -y agentbridge@latest mcp',
  '',
  'O sigue la guía completa: docs/inicio-rapido.md',
].join('\n')

const SHARE_FOLDER_EXPLANATION_ES = [
  'Antes de pedirte la carpeta que vas a compartir, esto es lo importante:',
  '',
  'Todo lo que haya ahí lo puede leer cualquier persona a la que le des permiso de preguntarte —',
  'incluido un .env o un archivo de llaves, aunque le digas a tu agente que no lo lea. Eso no',
  'depende de que el modelo se porte bien: está impuesto por configuración, y esa configuración',
  'solo protege lo que está DENTRO de la carpeta que elijas. Por eso:',
  '  - Usa una carpeta nueva y vacía, dedicada solo a esto.',
  '  - No la apuntes a tu repositorio de trabajo ni a tu carpeta de usuario.',
  '  - Copia ahí solo lo que de verdad quieras compartir.',
].join('\n')

const ROLE_QUESTION_ES = [
  '¿Qué vas a hacer desde esta computadora?',
  '  1) Contestar preguntas (compartes una carpeta y dejas tu agente corriendo)',
  '  2) Hacer preguntas (le preguntas al agente de otra persona)',
  '  3) Las dos cosas',
  'Escribe 1, 2 o 3: ',
].join('\n')

type Role = 'responder' | 'preguntar' | 'ambas'

function parseRole(raw: string): Role | null {
  const v = raw.trim().toLowerCase()
  if (v === '1' || v === 'responder' || v === 'contestar') return 'responder'
  if (v === '2' || v === 'preguntar' || v === 'ask') return 'preguntar'
  if (v === '3' || v === 'ambas' || v === 'las dos') return 'ambas'
  return null
}

function parseNonEmpty(raw: string): string | null {
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

// Deliberately does not accept "sí", "s" or "y" as alternate spellings of the confirmation
// word: a person has to actually type CONFIRMAR (case- and whitespace-insensitive, per FIX2)
// rather than reflex-answering the way they would a plain yes/no. That property — that it
// cannot be answered on autopilot — is the entire point of gating a dangerous folder behind a
// typed word instead of a y/n prompt, and widening the accepted answers here would erase it.
function parseConfirmation(raw: string): true | null {
  return raw.trim().toLowerCase() === CONFIRM_WORD.toLowerCase() ? true : null
}

function parseYesNo(raw: string): boolean | null {
  const v = raw.trim().toLowerCase()
  if (v === 's' || v === 'si' || v === 'sí' || v === 'y' || v === 'yes') return true
  if (v === 'n' || v === 'no') return false
  return null
}

const MAX_ATTEMPTS = 3

// Every question a person answers in this flow goes through here. On an answer `parse` rejects
// (returns null), it prints what a valid answer looks like and asks the exact same question
// again — up to MAX_ATTEMPTS times total — instead of ending the whole run over one typo, which
// would be worse than the written guide this command replaces (at least that doesn't lose your
// place). Exhausting every attempt still ends in the same Spanish CliError this always threw,
// just after a real chance to correct course instead of on the first miss.
//
// A stream that ends (PromptEOF — real stdin closing or running out, or a test's scripted
// answers running dry) is NEVER treated as a wasted attempt to retry: `prompt` rejects in that
// case, the `await` below throws, and this function does not catch it — it propagates straight
// out uncaught. Retrying an already-closed stream cannot ever produce an answer, so looping on
// it would either spin forever (unbounded) or, even bounded, burn the retry budget under the
// wrong diagnosis ("I didn't understand you" instead of "I have no terminal to ask you in").
// runSetup's own top-level try/catch is what turns a propagated PromptEOF into the same Spanish
// "needs an interactive terminal" message setupCommand already gives when there is no prompt at
// all — see the comment there.
async function askWithRetries<T>(
  prompt: Prompt,
  out: Output,
  question: string,
  parse: (raw: string) => T | null,
  invalidHint: string,
  giveUpMessage: string,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const raw = await prompt(question)
    const parsed = parse(raw)
    if (parsed !== null) return parsed
    if (attempt < MAX_ATTEMPTS) {
      const trimmed = raw.trim()
      out.log(trimmed ? `No entendí "${trimmed}". ${invalidHint}` : `No escribiste nada. ${invalidHint}`)
    }
  }
  throw new CliError(giveUpMessage)
}

// Patterns a fresh, curated share folder should never contain. Matched against bare file
// names in the folder's top level — good enough to catch the common, careless case (a
// `.env` copied in alongside real files) without pretending to be a full secret scanner.
const CREDENTIAL_NAME_PATTERNS = [/^\.env(\..*)?$/, /\.pem$/i, /\.key$/i, /^id_rsa/i, /^credentials/i]

export type ShareDirAssessment = { exists: boolean; isHome: boolean; reasons: string[] }

// Reuses doctor's own project-config detection (projectConfigArtifacts) rather than keeping a
// second list of the same artifact names — see the comment on that export in doctor.ts.
export async function assessShareDir(shareDirRaw: string): Promise<ShareDirAssessment> {
  const shareDir = resolve(shareDirRaw)
  const [shareReal, homeReal] = await Promise.all([resolveComparablePath(shareDir), resolveComparablePath(homedir())])
  const isHome = shareReal === homeReal
  const exists = await access(shareDir)
    .then(() => true)
    .catch(() => false)

  const reasons: string[] = []
  if (exists && !isHome) {
    const entries = await readdir(shareDir).catch(() => [] as string[])
    if (entries.includes('.git')) reasons.push('contiene un repositorio de git (una carpeta .git): parece tu código de trabajo')
    const suspicious = entries.filter((name) => CREDENTIAL_NAME_PATTERNS.some((re) => re.test(name)))
    if (suspicious.length > 0) reasons.push(`tiene archivos que parecen credenciales: ${suspicious.join(', ')}`)
    const projectConfig = await projectConfigArtifacts(shareDir)
    if (projectConfig.length > 0) reasons.push(`ya tiene configuración de proyecto que doctor vigila: ${projectConfig.join(', ')}`)
  }
  return { exists, isHome, reasons }
}

const CONFIRM_WORD = 'CONFIRMAR'

// The public entry point tests and setupCommand call. It's a thin wrapper around
// `runGuidedSetup`: its only job is to turn a `PromptEOF` that escapes the whole flow into the
// same Spanish "needs an interactive terminal" message `setupCommand` already gives when there
// is no prompt at all (see NON_INTERACTIVE_ES) — reached whenever stdin closes or a test's
// scripted answers run out partway through, not just when there was never a prompt to begin
// with. Every other error (a normal CliError from a validation or a give-up message, a relay
// error, …) passes through unchanged.
export async function runSetup(ctx: SetupContext): Promise<void> {
  try {
    await runGuidedSetup(ctx)
  } catch (err) {
    if (err instanceof PromptEOF) {
      throw new CliError(NON_INTERACTIVE_ES)
    }
    throw err
  }
}

async function runGuidedSetup(ctx: SetupContext): Promise<void> {
  const { out, prompt } = ctx

  out.log('AgentBridge — configuración guiada')
  out.log('Te voy a hacer las preguntas necesarias para dejarlo listo. Puedes cancelar con Ctrl+C.')
  out.log('')

  // 1. Identity — reuse enroll's own logic and messages verbatim; never re-derive a device
  // token or re-implement what counts as "already enrolled".
  let config = await tryReadConfig(ctx)
  if (!config) {
    out.log('Esta computadora todavía no está dada de alta.')
    out.log('Pide un enlace de alta a quien opere el relay (o créalo tú con: agentbridge admin enroll-link).')
    const link = await askWithRetries(
      prompt,
      out,
      'Enlace de alta: ',
      parseNonEmpty,
      'Necesito el enlace que te mandaron para darte de alta.',
      'No diste un enlace de alta. Vuelve a correr "agentbridge setup" cuando lo tengas, o da de alta a mano: agentbridge enroll <enlace>',
    )
    await enroll([link], ctx)
    config = await requireConfig(ctx)
  } else {
    out.log(`Esta computadora ya está dada de alta como ${config.displayName} (@${config.handle}) en ${config.relayUrl}.`)
  }
  out.log('')

  // 2. Which side
  const role = await askWithRetries(
    prompt,
    out,
    ROLE_QUESTION_ES,
    parseRole,
    'Escribe 1, 2 o 3.',
    'No pude entender qué ibas a hacer. Vuelve a correr "agentbridge setup" y responde 1, 2 o 3.',
  )
  const willAnswer = role === 'responder' || role === 'ambas'
  const willAsk = role === 'preguntar' || role === 'ambas'
  out.log('')

  const done: string[] = [`Identidad: ${config.displayName} (@${config.handle}) en ${config.relayUrl}.`]
  const pending: string[] = []

  // 3. Answering side
  if (willAnswer) {
    out.log(SHARE_FOLDER_EXPLANATION_ES)
    out.log('')
    const defaultShare = join(homedir(), 'AgentBridge', 'compartido')
    // Not routed through askWithRetries: any non-empty string is a syntactically valid folder
    // path (an empty answer just falls back to the suggested default), so there is no
    // "unrecognized answer" for this one to retry on — whether the path is actually safe to use
    // is a separate question, handled by the confirmation gate right below, which does retry.
    // A stream ending here still surfaces correctly: `prompt` itself rejects with PromptEOF
    // regardless of whether the call is wrapped in askWithRetries, and runSetup's top-level
    // catch handles that uniformly.
    const rawShare = (await prompt(`Carpeta a compartir (Enter para usar ${defaultShare}): `)).trim()
    const shareDir = resolve(rawShare || defaultShare)

    const assessment = await assessShareDir(shareDir)
    if (assessment.isHome) {
      throw new CliError(
        `No puedo usar ${shareDir} como carpeta compartida: es tu carpeta de usuario (home) y dejaría visible todo lo que tienes en la computadora. Vuelve a correr "agentbridge setup" con otra carpeta.`,
      )
    }
    if (assessment.reasons.length > 0) {
      out.log(`Ojo: ${shareDir} se ve peligrosa para compartir —`)
      for (const reason of assessment.reasons) out.log(`  - ${reason}`)
      out.log(
        `Si de verdad quieres usarla de todos modos, escribe exactamente ${CONFIRM_WORD} (mayúsculas o minúsculas da igual). Cualquier otra respuesta cancela.`,
      )
      await askWithRetries(
        prompt,
        out,
        `Escribe ${CONFIRM_WORD} para continuar: `,
        parseConfirmation,
        `Para seguir con esta carpeta, escribe exactamente la palabra ${CONFIRM_WORD} (sin comillas; mayúsculas o minúsculas da igual).`,
        `No escribiste "${CONFIRM_WORD}". No se tocó ${shareDir}. Vuelve a correr "agentbridge setup" con otra carpeta si quieres, o confirma esta de nuevo.`,
      )
    }
    // Never create the folder silently: say so before setupResponder does it.
    out.log(assessment.exists ? `Voy a usar la carpeta que ya existe: ${shareDir}` : `${shareDir} no existe todavía; la voy a crear vacía.`)
    out.log('')

    const repoDir = ctx.repoDir ? resolve(ctx.repoDir) : await repoDirFromBundleLocation(import.meta.url)
    const responderHome = ctx.responderHome ? resolve(ctx.responderHome) : join(homedir(), '.agentbridge-responder')

    const setupResult = await setupResponder({ shareDir, repoDir, home: responderHome, run: ctx.run, out })
    out.log('')
    out.log('Verificando con doctor…')
    const checks = await runDoctor({ home: responderHome, shareDir, repoDir, run: ctx.run, fetchImpl: ctx.fetchImpl })
    for (const c of checks) out.log(`${c.ok ? '[ok]    ' : '[falta] '}${c.name}: ${c.detail}`)
    const loggedIn = checks.some((c) => c.name === 'Sesión iniciada en el perfil dedicado' && c.ok)
    out.log('')

    out.log('Para terminar de dejarlo contestando, en este orden:')
    out.log(`  1. Inicia sesión una vez en el perfil dedicado:  CLAUDE_CONFIG_DIR='${setupResult.claudeConfigDir}' claude   (usa /login y sal)`)
    out.log(`  2. Arráncalo:  ${setupResult.startScriptPath}`)
    out.log('  3. Deja entrar a quien va a preguntarte:  agentbridge invite   (y mándale el enlace que imprime)')
    out.log('')

    if (loggedIn) done.push('Perfil dedicado con sesión iniciada.')
    else pending.push(`Inicia sesión una vez: CLAUDE_CONFIG_DIR='${setupResult.claudeConfigDir}' claude`)
    pending.push(`Arranca el respondedor: ${setupResult.startScriptPath}`)
    pending.push('Invita a quien va a preguntarte: agentbridge invite')
  }

  // 4. Asking side
  if (willAsk) {
    out.log('Para preguntar desde tu propio Claude Code hace falta registrar el servidor MCP de AgentBridge una vez.')
    const wantsMcp = await askWithRetries(
      prompt,
      out,
      '¿Lo registro ahora? [s/n]: ',
      parseYesNo,
      'Escribe s (sí) o n (no).',
      'No entendí tu respuesta. Puedes registrarlo tú cuando quieras con: claude mcp add agentbridge --scope user -- npx -y agentbridge@latest mcp',
    )
    let mcpRegistered = false
    if (wantsMcp) {
      const result = await ctx.run(
        'claude',
        ['mcp', 'add', 'agentbridge', '--scope', 'user', '--', 'npx', '-y', 'agentbridge@latest', 'mcp'],
        { env: ctx.env },
      )
      if (result.code === 0) {
        mcpRegistered = true
        out.log('Listo: el servidor MCP quedó registrado.')
      } else {
        out.log(
          `No pude registrar el servidor MCP automáticamente (${result.stderr || result.stdout || 'sin más detalle'}). Hazlo a mano:`,
        )
        out.log('  claude mcp add agentbridge --scope user -- npx -y agentbridge@latest mcp')
      }
    } else {
      out.log('Está bien. Cuando quieras, corre:')
      out.log('  claude mcp add agentbridge --scope user -- npx -y agentbridge@latest mcp')
    }
    out.log('')
    out.log('Importante: si ya tenías una sesión de Claude Code abierta, ciérrala y ábrela de nuevo — la herramienta nueva')
    out.log('no aparece hasta que reinicias la sesión.')
    out.log('Para preguntar desde la terminal en cualquier momento: agentbridge ask <handle> "<pregunta>"')
    out.log('')

    if (mcpRegistered) {
      done.push('Servidor MCP registrado en Claude Code.')
      pending.push('Reinicia (o abre) tu sesión de Claude Code para que aparezca la herramienta nueva.')
    } else {
      pending.push('Registra el servidor MCP: claude mcp add agentbridge --scope user -- npx -y agentbridge@latest mcp')
    }
  }

  // 5. Verdict
  out.log('== Resumen ==')
  out.log('Listo:')
  for (const d of done) out.log(`  - ${d}`)
  if (pending.length === 0) {
    out.log('Pendiente: nada. Ya puedes usar AgentBridge.')
  } else {
    out.log('Pendiente:')
    for (const p of pending) out.log(`  - ${p}`)
    out.log('')
    out.log(`Siguiente paso: ${pending[0]}`)
  }
}

export async function setupCommand(argv: string[], ctx: CliContext): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { repo: { type: 'string' }, home: { type: 'string' } } })
  if (!ctx.prompt) {
    throw new CliError(NON_INTERACTIVE_ES)
  }
  await runSetup({ ...ctx, prompt: ctx.prompt, run: defaultRunner, repoDir: values.repo, responderHome: values.home })
}
