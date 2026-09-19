import { parseArgs } from 'node:util'
import { CLI_COMMAND, LIMITS } from '@agentbridge/core'
import { formatQuestion } from '../asker/format'
import { withAsker } from '../asker/session'
import { CliError, type CliContext } from '../context'

// Shared by `ask` and `ticket` so a mistyped --wait gives the exact same clean, local Spanish
// message in both commands instead of turning into NaN and failing much later.
function parseWaitSeconds(raw: string | undefined, fallback: number): number {
  const seconds = Number(raw ?? fallback)
  if (!Number.isFinite(seconds) || seconds < 0) throw new CliError('--wait debe ser un número de segundos')
  return seconds
}

const RETRY_NOTE = 'Si esa persona tiene su computadora apagada, la pregunta se reintenta sola cada vez que corres un comando, hasta una semana.'

export async function ask(argv: string[], ctx: CliContext): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { wait: { type: 'string' }, 'no-wait': { type: 'boolean' } },
  })
  const [name, ...words] = positionals
  const text = words.join(' ').trim()
  if (!name || !text) throw new CliError(`Uso: ${CLI_COMMAND} ask <nombre> <pregunta…> [--wait <segundos>|--no-wait]`)
  if (text.length > LIMITS.questionMaxChars) throw new CliError(`La pregunta puede tener como máximo ${LIMITS.questionMaxChars} caracteres.`)
  const waitSeconds = values['no-wait'] ? 0 : parseWaitSeconds(values.wait, 120)

  await withAsker(ctx, async (service) => {
    const question = await service.ask(name, text)
    // The second sync inside withAsker publishes it; sync here too so the identifier we print is
    // already accompanied by a real send attempt when the person chose not to wait.
    await service.sync()
    // What actually happened is in the stored state: `sent` means a relay took it, `sending` means
    // it is saved and still trying. Saying "enviada" either way would be a lie when every relay is
    // down, which is exactly when a person needs the truth.
    const stored = service.question(question.questionId)
    ctx.out.log(
      stored.state === 'sending'
        ? `Pregunta guardada para ${name}, pendiente de envío: ningún tablero la aceptó todavía.`
        : `Pregunta enviada a ${name}.`,
    )
    ctx.out.log(`Identificador: ${question.questionId}`)
    ctx.out.log(RETRY_NOTE)
    if (waitSeconds === 0) {
      ctx.out.log(`Consulta la respuesta con: ${CLI_COMMAND} ticket ${question.questionId} --wait 60`)
      return
    }
    ctx.out.log('')
    const settled = await service.waitForAnswer({ recipient: question.recipient, questionId: question.questionId }, waitSeconds)
    ctx.out.log(formatQuestion(settled, { contactName: name }))
    if (settled.state !== 'answered' && settled.state !== 'rejected' && settled.state !== 'lost') {
      ctx.out.log(`Sigue pendiente. Consulta después con: ${CLI_COMMAND} ticket ${question.questionId} --wait 60`)
    }
  })
}

export async function ticket(argv: string[], ctx: CliContext): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { wait: { type: 'string' } } })
  const id = positionals[0]
  if (!id) throw new CliError(`Uso: ${CLI_COMMAND} ticket <id> [--wait <segundos>]`)
  const waitSeconds = parseWaitSeconds(values.wait, 0)

  await withAsker(ctx, async (service) => {
    const question = service.question(id)
    const settled = waitSeconds > 0 ? await service.waitForAnswer({ recipient: question.recipient, questionId: question.questionId }, waitSeconds) : question
    ctx.out.log(formatQuestion(settled))
  })
}
