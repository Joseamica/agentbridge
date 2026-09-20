import { describe, expect, it } from 'vitest'
import { HandleSchema } from '@agentbridge/core'

describe('protocol', () => {
  it('accepts valid handles and rejects unsafe ones', () => {
    expect(HandleSchema.safeParse('amieva').success).toBe(true)
    expect(HandleSchema.safeParse('dev-ejemplo').success).toBe(true)
    expect(HandleSchema.safeParse('A').success).toBe(false)
    expect(HandleSchema.safeParse('-bad').success).toBe(false)
    expect(HandleSchema.safeParse('has space').success).toBe(false)
  })
})
