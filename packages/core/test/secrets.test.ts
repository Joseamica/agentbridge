import { describe, expect, it } from 'vitest'
import { QUESTION_CODE_ALPHABET, newQuestionCode } from '@agentbridge/core'

describe('secrets', () => {
  it('creates 4-character codes only from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = newQuestionCode()
      expect(code).toHaveLength(4)
      for (const ch of code) expect(QUESTION_CODE_ALPHABET).toContain(ch)
    }
  })
})
