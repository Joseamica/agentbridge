import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { QUESTION_CODE_ALPHABET } from './protocol'

export function newSecret(): string {
  return randomBytes(32).toString('base64url')
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

export function newQuestionCode(): string {
  let code = ''
  for (let i = 0; i < 4; i++) code += QUESTION_CODE_ALPHABET[randomInt(QUESTION_CODE_ALPHABET.length)]
  return code
}

export function codeFromUrl(urlOrCode: string): string {
  const trimmed = urlOrCode.trim().replace(/\/+$/, '')
  const last = trimmed.split('/').pop()
  return last ?? trimmed
}

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb) && a.length === b.length
}
