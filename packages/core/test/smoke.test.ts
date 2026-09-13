import { describe, expect, it } from 'vitest'
import { PACKAGE_NAME } from '@agentbridge/core'

describe('workspace wiring', () => {
  it('resolves @agentbridge/core from another workspace path', () => {
    expect(PACKAGE_NAME).toBe('@agentbridge/core')
  })
})
