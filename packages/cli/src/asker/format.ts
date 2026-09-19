import { CLI_COMMAND, LIMITS, type Contact, type OutboundQuestion, type OutboundQuestionState } from '@agentbridge/core'

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
      return 'le hiciste más preguntas de las que puedes: tienes demasiadas sin resolver con esa persona, o ya llegaste al máximo de hoy'
    case 'unanswered':
      return 'nadie la contestó dentro del plazo'
    case 'stale_generation':
      return 'el permiso con esa persona cambió mientras esta pregunta seguía en camino'
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
      // question.answer.text is the most attacker-controlled string in the product — a crafted
      // answer's own free text, printed straight to a terminal that just showed the person their own
      // question. forTerminalBlock (not forTerminal: an answer is legitimately multi-line prose)
      // keeps that from becoming a repainted line or a forged "Fuente:"/"Confianza:" of its own.
      // .source is short and single-line, so plain forTerminal is enough for it.
      return `${who(options)} contestó:\n\n${forTerminalBlock(question.answer.text)}\n\nFuente: ${forTerminal(question.answer.source)}\nConfianza: ${question.answer.confidence}`
    }
    case 'rejected':
      return `${header}\nMotivo: ${question.rejectReason ? formatRejectReason(question.rejectReason) : 'sin motivo'}`
    case 'lost':
      return `${header}\nPuedes volver a preguntar cuando quieras.`
    default:
      return `${header}\nConsulta después con: ${CLI_COMMAND} ticket ${question.questionId}`
  }
}

// Two families of characters no terminal output of ours may carry raw. C0 (0x00-0x1F) and C1
// (0x7F-0x9F) controls cover ESC — so no CSI or OSC sequence survives — plus CR, LF, backspace runs,
// NUL and DEL. Zero-width characters and bidirectional overrides/isolates have no visible footprint
// of their own, but a declared name built from them can still reorder or hide characters in a
// bidi-aware terminal — the one payoff a contact list offers an attacker.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g
// Same class, minus \t (0x09) and \n (0x0a): forTerminalBlock's text legitimately contains both.
const CONTROL_CHARS_KEEPING_LINES = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
const ZERO_WIDTH_AND_BIDI = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

function stripUnsafeChars(text: string, options: { keepLines?: boolean } = {}): string {
  const controls = options.keepLines ? CONTROL_CHARS_KEEPING_LINES : CONTROL_CHARS
  return text.replace(controls, ' ').replace(ZERO_WIDTH_AND_BIDI, '')
}

// Third-party text reaches a terminal here: a declared name or a note can carry newlines or ANSI
// escapes that repaint the screen or fake a line of a listing. Length alone does not stop that. For a
// short, single-line field only — an answer's own multi-line prose goes through forTerminalBlock
// instead, which keeps the newlines it legitimately contains.
export function forTerminal(text: string, max = 200): string {
  return [...stripUnsafeChars(text)].slice(0, max).join('').trim()
}

// forTerminal's block-safe sibling, for text that legitimately spans multiple lines — an answer's
// prose. Reuses forTerminal's own stripping (stripUnsafeChars), just keeping \n and \t instead of
// turning them into spaces. Line endings are normalized first so a lone CR cannot survive as one (a
// bare CR, with no following LF, is still a cursor-to-column-0 move a terminal will honor). Capped at
// the protocol's own answer limit — the same bound the sender's answer was already validated against
// (packages/core/src/protocol.ts), not a number invented here. Every line is then indented, so a line
// inside the answer can never pose as one of our own output lines: none of ours start with leading
// whitespace.
export function forTerminalBlock(text: string, max: number = LIMITS.answerMaxChars): string {
  const normalized = text.replace(/\r\n?/g, '\n')
  const cleaned = stripUnsafeChars(normalized, { keepLines: true })
  const capped = [...cleaned].slice(0, max).join('')
  return capped
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

// "→" marks every outbound line: the question travels from you to them. formatInboundContactLine's
// "←" marks the opposite direction. "approved" is the pair a person most needs to tell apart at a
// skim ("puedes preguntarle" vs "puede preguntarte" differ by two letters), so the arrow — not the
// verb ending — is what a person actually reads to know which way a contact goes; it is applied to
// every state in both functions so the listing stays one consistent visual system, not just the one
// pair that prompted it.
export function formatContactLine(contact: Contact): string {
  const name = forTerminal(contact.localName ?? contact.declaredName ?? contact.pubkey.slice(0, 8), 80)
  switch (contact.state) {
    case 'approved':
      return `${name} → puedes preguntarle`
    case 'pending':
      return `${name} → esperando a que acepte tu solicitud`
    case 'rejected':
      return `${name} → no aceptó tu solicitud`
    case 'revoked':
      return `${name} → retiró el permiso`
    case 'requested':
      return `${name} → te pidió permiso a ti`
  }
}

// The same contact means the opposite thing in the other direction: an approved *inbound* contact is
// someone who may ask this person, not someone this person may ask.
export function formatInboundContactLine(contact: Contact): string {
  const name = forTerminal(contact.localName ?? contact.declaredName ?? contact.pubkey.slice(0, 8), 80)
  switch (contact.state) {
    case 'approved':
      return `${name} ← puede preguntarte`
    case 'requested':
      return `${name} ← te pidió permiso y sigue esperando`
    case 'rejected':
      return `${name} ← le dijiste que no`
    case 'revoked':
      return `${name} ← le retiraste el permiso`
    case 'pending':
      return `${name} ← solicitud en curso`
  }
}
