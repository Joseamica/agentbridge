import { describe, expect, it } from 'vitest'
import { InFlight, type ActiveQuestion } from '../src/inflight'

const q = (code: string, attemptId = `att-${code}`): ActiveQuestion => ({
  attemptId,
  code,
  fromHandle: 'amieva',
  fromName: 'Amieva',
  question: '¿Ya quedó?',
})

describe('InFlight', () => {
  it('reports none when nothing is active', () => {
    expect(new InFlight().check('Q7K2')).toEqual({ ok: false, reason: 'none', currentCode: null })
  })

  it('accepts the active code regardless of case and surrounding spaces', () => {
    const f = new InFlight()
    f.start(q('Q7K2'))
    expect(f.check('  q7k2 ')).toEqual({ ok: true, question: q('Q7K2') })
  })

  it('rejects a mistyped code and tells the model the active code', () => {
    const f = new InFlight()
    f.start(q('Q7K2'))
    expect(f.check('Q7KK2')).toEqual({ ok: false, reason: 'wrong_code', currentCode: 'Q7K2' })
  })

  it('rejects a late answer to a cancelled question even when a new one is active', () => {
    const f = new InFlight()
    f.start(q('AAAA'))
    expect(f.cancel('att-AAAA')?.code).toBe('AAAA')
    f.start(q('BBBB'))
    expect(f.check('AAAA')).toEqual({ ok: false, reason: 'cancelled', currentCode: 'BBBB' })
  })

  it('only cancels or finishes the matching attempt', () => {
    const f = new InFlight()
    f.start(q('AAAA'))
    expect(f.cancel('other')).toBeNull()
    f.finish('other')
    expect(f.current?.code).toBe('AAAA')
    f.finish('att-AAAA')
    expect(f.current).toBeNull()
  })

  it('cancelActive marks the active code as cancelled', () => {
    const f = new InFlight()
    f.start(q('AAAA'))
    expect(f.cancelActive()?.code).toBe('AAAA')
    expect(f.check('AAAA')).toEqual({ ok: false, reason: 'cancelled', currentCode: null })
  })

  it('forgets a cancelled code when the relay reuses it for a new question', () => {
    const f = new InFlight()
    f.start(q('AAAA', 'a1'))
    f.cancel('a1')
    f.start(q('AAAA', 'a2'))
    expect(f.check('AAAA')).toMatchObject({ ok: true })
  })
})
