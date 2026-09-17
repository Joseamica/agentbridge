import { describe, expect, it } from 'vitest'
import { UserFacingError, describeError } from '@agentbridge/core'

describe('describeError', () => {
  it('keeps a message written for people', () => {
    expect(describeError(new UserFacingError('No hay ninguna solicitud con ese identificador.'))).toBe('No hay ninguna solicitud con ese identificador.')
  })

  it('reports only the type and code of anything else, never its message', () => {
    const sqlite = Object.assign(new Error('UNIQUE constraint failed near PRIVATE_DECRYPTED_CANARY'), { code: 'ERR_SQLITE_ERROR' })
    expect(describeError(sqlite)).toBe('Error (ERR_SQLITE_ERROR)')
    expect(describeError(new TypeError('secret key 0123abcd'))).toBe('TypeError')
    expect(describeError(Object.assign(new Error('x'), { code: 'not a code; PRIVATE' }))).toBe('Error')
    expect(describeError('PRIVATE_DECRYPTED_CANARY')).toBe('non-error value thrown')
  })
})
