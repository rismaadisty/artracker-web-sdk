import { safeStorage, type KeyValueStore } from './storage'

const UID_KEY = 'ar_uid'
const MAX_ID_LEN = 128

export class UserStore {
  private readonly store: KeyValueStore = safeStorage('local')
  private id: string | undefined
  private traitsValue: Record<string, unknown> | undefined

  constructor() {
    this.id = this.store.get(UID_KEY) ?? undefined
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
    // traits hanya di memori: bisa berisi PII (email, nama) dan tidak boleh menyentuh disk tanpa redaksi.
    this.traitsValue = traits
  }

  reset(): void {
    this.id = undefined
    this.traitsValue = undefined
    this.store.remove(UID_KEY)
  }
}
