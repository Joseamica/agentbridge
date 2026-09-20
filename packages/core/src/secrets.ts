import { randomInt } from 'node:crypto'
import { QUESTION_CODE_ALPHABET } from './protocol'

// The four-character code the reply tool asks for, so an answer cannot be attached to the wrong
// question by mistake. The rest of this file — device secrets, their hashes, constant-time
// comparison and the enrollment-code parser — belonged to the 0.1 relay and went with it.
export function newQuestionCode(): string {
  let code = ''
  for (let i = 0; i < 4; i++) code += QUESTION_CODE_ALPHABET[randomInt(QUESTION_CODE_ALPHABET.length)]
  return code
}
