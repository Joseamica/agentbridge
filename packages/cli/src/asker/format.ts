import { CLI_COMMAND, type Contact, type OutboundQuestion, type OutboundQuestionState } from '@agentbridge/core'

// One short phrase per state. "Recibida" means it reached their computer; "contestada" means they
// answered. The spec asks for exactly that distinction, because the two feel very different to the
// person waiting.
export const QUESTION_STATE_ES: Record<OutboundQuestionState, string> = {
  sending: 'enviándose',
  sent: 'enviada, todavía sin confirmar',
  received: 'recibida por esa persona, sin contestar todavía',
  answered: 'contestada',
  rejected: 'rechazada',
  lost: 'sin respuesta: se acabó el plazo de una semana',
}

export function formatRejectReason(reason: NonNullable<OutboundQuestion['rejectReason']>): string {
  switch (reason) {
    case 'expired':
      return 'la pregunta llegó demasiado tarde (más de 24 horas)'
    case 'limit':
      return 'esa persona ya tenía demasiadas preguntas tuyas en cola'
    case 'unanswered':
      return 'nadie la contestó dentro del plazo'
    case 'stale_generation':
      return 'esa persona retiró el permiso'
  }
}

const who = (options: { contactName?: string }): string => options.contactName ?? 'esa persona'

// Every branch that keeps waiting names the question's full id (never a prefix): a prefix the person
// was never shown cannot be disambiguated later if they retype it (P3).
export function formatQuestion(question: OutboundQuestion, options: { contactName?: string } = {}): string {
  const header = `${question.text ?? '(el texto ya se borró por retención)'}\n→ ${who(options)} · ${QUESTION_STATE_ES[question.state]}`
  switch (question.state) {
    case 'answered': {
      if (!question.answer) return header
      return `${who(options)} contestó:\n\n${question.answer.text}\n\nFuente: ${question.answer.source}\nConfianza: ${question.answer.confidence}`
    }
    case 'rejected':
      return `${header}\nMotivo: ${question.rejectReason ? formatRejectReason(question.rejectReason) : 'sin motivo'}`
    case 'lost':
      return `${header}\nPuedes volver a preguntar cuando quieras.`
    default:
      return `${header}\nConsulta después con: ${CLI_COMMAND} ticket ${question.questionId}`
  }
}

// Third-party text reaches a terminal here: a declared name or a note can carry newlines or ANSI
// escapes that repaint the screen or fake a line of a listing. Length alone does not stop that.
export function forTerminal(text: string, max = 200): string {
  return [...text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')].slice(0, max).join('').trim()
}

export function formatContactLine(contact: Contact): string {
  const name = forTerminal(contact.localName ?? contact.declaredName ?? contact.pubkey.slice(0, 8), 80)
  switch (contact.state) {
    case 'approved':
      return `${name} — puedes preguntarle`
    case 'pending':
      return `${name} — esperando a que acepte tu solicitud`
    case 'rejected':
      return `${name} — no aceptó tu solicitud`
    case 'revoked':
      return `${name} — retiró el permiso`
    case 'requested':
      return `${name} — te pidió permiso a ti`
  }
}

// The same contact means the opposite thing in the other direction: an approved *inbound* contact is
// someone who may ask this person, not someone this person may ask.
export function formatInboundContactLine(contact: Contact): string {
  const name = forTerminal(contact.localName ?? contact.declaredName ?? contact.pubkey.slice(0, 8), 80)
  switch (contact.state) {
    case 'approved':
      return `${name} — puede preguntarte`
    case 'requested':
      return `${name} — te pidió permiso y sigue esperando`
    case 'rejected':
      return `${name} — le dijiste que no`
    case 'revoked':
      return `${name} — le retiraste el permiso`
    case 'pending':
      return `${name} — solicitud en curso`
  }
}
