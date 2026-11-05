export interface Breadcrumb {
  type: string
  at: number
  data: Record<string, unknown>
}

/** Ring buffer breadcrumb: tidak dikirim sebagai item sendiri, hanya dilampirkan pada error dan session_end. */
export class BreadcrumbBuffer {
  private items: Breadcrumb[] = []

  constructor(private readonly limit: number) {}

  add(b: Breadcrumb): void {
    this.items.push(b)
    if (this.items.length > this.limit) this.items.shift()
  }

  snapshot(): Breadcrumb[] {
    return this.items.slice()
  }
}
