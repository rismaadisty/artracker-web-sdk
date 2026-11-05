import { safeStorage, type KeyValueStore } from './storage'

const UID_KEY = 'ar_uid'
const TRAITS_KEY = 'ar_traits'
const MAX_ID_LEN = 128

export class UserStore {
  private readonly store: KeyValueStore = safeStorage('local')
  private id: string | undefined
  private traitsValue: Record<string, unknown> | undefined

  constructor() {
    this.id = this.store.get(UID_KEY) ?? undefined
    const raw = this.store.get(TRAITS_KEY)
    if (raw) {
      try {
        this.traitsValue = JSON.parse(raw) as Record<string, unknown>
      } catch {
        this.traitsValue = undefined
      }
    }
  }

  get userId(): string | undefined {
    return this.id
  }

  get traits(): Record<string, unknown> | undefined {
    return this.traitsValue
  }

  identify(userId: string, traits?: Record<string, unknown>): void {
    if (typeof userId !== 'string' || userId === '') return
    this.id = userId.slice(0, MAX_ID_LEN)
    this.store.set(UID_KEY, this.id)
    this.traitsValue = traits
    if (traits) this.store.set(TRAITS_KEY, JSON.stringify(traits))
    else this.store.remove(TRAITS_KEY)
  }

  reset(): void {
    this.id = undefined
    this.traitsValue = undefined
    this.store.remove(UID_KEY)
    this.store.remove(TRAITS_KEY)
  }
}
