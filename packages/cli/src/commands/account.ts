import { RelayHttpClient, codeFromUrl, writeConfig } from '@agentbridge/core'
import { hostname } from 'node:os'
import { parseArgs } from 'node:util'
import { CliError, clientFor, requireConfig, tryReadConfig, type CliContext } from '../context'

// A relay URL missing its scheme (e.g. "127.0.0.1:8099" or "not-a-url") makes fetch throw
// "Failed to parse URL from ..." at request-construction time, before any network attempt —
// a different failure than a well-formed URL that just isn't reachable, and it deserves its
// own Spanish message ("you typed it wrong" vs. "it is not running").
function requireRelayUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new CliError(`La URL del relay no es válida: "${value}". Debe tener la forma http://host:puerto o https://host`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CliError(`La URL del relay no es válida: "${value}". Debe tener la forma http://host:puerto o https://host`)
  }
  return value
}

export async function adminEnrollLink(argv: string[], ctx: CliContext): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      handle: { type: 'string' },
      name: { type: 'string' },
      relay: { type: 'string' },
      'admin-token': { type: 'string' },
    },
  })
  const relayUrl = values.relay ?? ctx.env.AGENTBRIDGE_RELAY_URL
  const adminToken = values['admin-token'] ?? ctx.env.AGENTBRIDGE_ADMIN_TOKEN
  if (!values.handle || !values.name || !relayUrl || !adminToken) {
    throw new CliError('Uso: agentbridge admin enroll-link --handle <h> --name <nombre> --relay <url> --admin-token <token>')
  }
  requireRelayUrl(relayUrl)
  const client = new RelayHttpClient({ relayUrl, fetchImpl: ctx.fetchImpl })
  const { enrollUrl, expiresAt } = await client.adminCreateEnrollment(adminToken, values.handle, values.name)
  ctx.out.log(`Enlace de alta para ${values.name} (@${values.handle}). Sirve una sola vez y caduca ${expiresAt}.`)
  ctx.out.log(`Esa persona debe ejecutar:\n  agentbridge enroll ${enrollUrl}`)
}

export async function enroll(argv: string[], ctx: CliContext): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { device: { type: 'string' } } })
  const link = positionals[0]
  if (!link) throw new CliError('Uso: agentbridge enroll <enlace> [--device <nombre>]')
  const existing = await tryReadConfig(ctx)
  if (existing) {
    throw new CliError(`Este dispositivo ya está dado de alta como @${existing.handle} en ${ctx.home}. Para otra identidad usa AGENTBRIDGE_HOME con otra carpeta.`)
  }
  let relayUrl: string
  try {
    relayUrl = new URL(link).origin
  } catch {
    throw new CliError('El enlace de alta no es una URL válida')
  }
  const client = new RelayHttpClient({ relayUrl, fetchImpl: ctx.fetchImpl })
  const res = await client.enroll(codeFromUrl(link), values.device ?? hostname())
  const file = await writeConfig({ relayUrl, deviceToken: res.deviceToken, handle: res.handle, displayName: res.displayName }, ctx.home)
  ctx.out.log(`Listo: este dispositivo es ${res.displayName} (@${res.handle}). Credencial guardada en ${file}`)
}

export async function whoami(_argv: string[], ctx: CliContext): Promise<void> {
  const config = await requireConfig(ctx)
  const me = await clientFor(ctx, config).me()
  ctx.out.log(`${me.displayName} (@${me.handle}) en ${config.relayUrl}`)
}

export async function invite(_argv: string[], ctx: CliContext): Promise<void> {
  const config = await requireConfig(ctx)
  const { acceptUrl, expiresAt } = await clientFor(ctx, config).createInvite()
  ctx.out.log(`Mándale esto a la persona que quieres que te pueda preguntar. Sirve una sola vez y caduca ${expiresAt}:`)
  ctx.out.log(`  agentbridge accept ${acceptUrl}`)
}

export async function accept(argv: string[], ctx: CliContext): Promise<void> {
  const link = argv[0]
  if (!link) throw new CliError('Uso: agentbridge accept <enlace>')
  const config = await requireConfig(ctx)
  const { responder } = await clientFor(ctx, config).acceptInvite(codeFromUrl(link))
  ctx.out.log(`Ya puedes preguntarle a ${responder.displayName} (@${responder.handle}).`)
}

export async function contacts(_argv: string[], ctx: CliContext): Promise<void> {
  const config = await requireConfig(ctx)
  const view = await clientFor(ctx, config).contacts()
  ctx.out.log('Puedes preguntarle a:')
  if (view.canAsk.length === 0) ctx.out.log('  Nadie te ha dado permiso todavía.')
  for (const c of view.canAsk) ctx.out.log(`  @${c.handle} (${c.displayName}) ${c.online ? 'en línea' : 'desconectado'}`)
  ctx.out.log('Te pueden preguntar:')
  if (view.canAskMe.length === 0) ctx.out.log('  Nadie todavía.')
  for (const c of view.canAskMe) ctx.out.log(`  @${c.handle} (${c.displayName})`)
}

export async function revoke(argv: string[], ctx: CliContext): Promise<void> {
  const handle = argv[0]?.replace(/^@/, '')
  if (!handle) throw new CliError('Uso: agentbridge revoke <handle>')
  const config = await requireConfig(ctx)
  await clientFor(ctx, config).revoke(handle)
  ctx.out.log(`@${handle} ya no puede preguntarte. Sus preguntas pendientes se cancelaron.`)
}
