export class SeenIds {
  private readonly ids = new Set<string>()

  constructor(private readonly max = 10_000) {}

  has(id: string): boolean {
    return this.ids.has(id)
  }

  add(id: string): void {
    if (this.ids.has(id)) return
    this.ids.add(id)
    if (this.ids.size > this.max) {
      const oldest = this.ids.values().next().value
      if (oldest !== undefined) this.ids.delete(oldest)
    }
  }

  delete(id: string): void {
    this.ids.delete(id)
  }

  get size(): number {
    return this.ids.size
  }
}
