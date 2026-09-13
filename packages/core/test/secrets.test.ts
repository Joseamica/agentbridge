import { describe, expect, it } from 'vitest'
import {
  QUESTION_CODE_ALPHABET,
  codeFromUrl,
  hashSecret,
  newQuestionCode,
  newSecret,
  safeEqual,
} from '@agentbridge/core'

describe('secrets', () => {
  it('creates distinct base64url secrets of 43 characters', () => {
    const a = newSecret()
    const b = newSecret()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(b)
  })

  it('hashes deterministically to sha256 hex and never returns the input', () => {
    const s = newSecret()
    expect(hashSecret(s)).toBe(hashSecret(s))
    expect(hashSecret(s)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashSecret(s)).not.toContain(s)
  })

  it('creates 4-character codes only from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = newQuestionCode()
      expect(code).toHaveLength(4)
      for (const ch of code) expect(QUESTION_CODE_ALPHABET).toContain(ch)
    }
  })

  it('extracts the code from a link or accepts a bare code', () => {
    expect(codeFromUrl('https://relay.example.com/e/abc_DEF-123')).toBe('abc_DEF-123')
    expect(codeFromUrl('https://relay.example.com/c/xyz/')).toBe('xyz')
    expect(codeFromUrl('abc123')).toBe('abc123')
  })

  it('compares strings in constant time and handles different lengths', () => {
    expect(safeEqual('same', 'same')).toBe(true)
    expect(safeEqual('same', 'diff')).toBe(false)
    expect(safeEqual('short', 'longer')).toBe(false)
  })
})
