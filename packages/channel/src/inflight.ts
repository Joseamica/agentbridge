export type ActiveQuestion = {
  attemptId: string
  code: string
  fromHandle: string
  fromName: string
  question: string
}

export type ReplyCheck =
  | { ok: true; question: ActiveQuestion }
  | { ok: false; reason: 'none'; currentCode: null }
  | { ok: false; reason: 'cancelled'; currentCode: string | null }
  | { ok: false; reason: 'wrong_code'; currentCode: string }

const MAX_REMEMBERED = 50

export class InFlight {
  private active: ActiveQuestion | null = null
  private cancelled: string[] = []

  get current(): ActiveQuestion | null {
    return this.active
  }

  start(question: ActiveQuestion): void {
    this.cancelled = this.cancelled.filter((c) => c !== question.code)
    this.active = question
  }

  check(rawCode: string): ReplyCheck {
    const code = rawCode.trim().toUpperCase()
    if (this.active && code === this.active.code) return { ok: true, question: this.active }
    if (this.cancelled.includes(code)) return { ok: false, reason: 'cancelled', currentCode: this.active?.code ?? null }
    if (!this.active) return { ok: false, reason: 'none', currentCode: null }
    return { ok: false, reason: 'wrong_code', currentCode: this.active.code }
  }

  finish(attemptId: string): void {
    if (this.active?.attemptId === attemptId) this.active = null
  }

  cancel(attemptId: string): ActiveQuestion | null {
    if (this.active?.attemptId !== attemptId) return null
    return this.cancelActive()
  }

  cancelActive(): ActiveQuestion | null {
    const question = this.active
    if (!question) return null
    this.active = null
    this.cancelled.push(question.code)
    if (this.cancelled.length > MAX_REMEMBERED) this.cancelled.shift()
    return question
  }
}
