// @mem-ria/core — MemRia main class

import { createSQLiteStore } from './store/sqlite.js'
import { createPostgresStore } from './store/postgres.js'
import { getPlan, LIMITS, type LicenseInfo } from './license.js'
import type {
  MemRiaConfig,
  StorageAdapter,
  UpsertInput,
  SearchResult,
  SearchOptions,
  BridgeOptions,
  MemoryEntry,
  Stats,
} from './types.js'

export class MemRia {
  private _store: StorageAdapter
  private _config: MemRiaConfig
  private _license: LicenseInfo

  constructor(config: MemRiaConfig) {
    this._config = config
    this._license = getPlan()
    if (config.storage === 'postgres') {
      this._store = createPostgresStore(config.connectionString || '')
    } else {
      this._store = createSQLiteStore(config.path || ':memory:')
    }
  }

  upsert(entry: UpsertInput): string {
    const limit = LIMITS[this._license.plan].maxEntries
    const current = this._store.stats(this._config.scope).total
    if (current >= limit) {
      const planName = this._license.plan === 'free' ? 'Free' : this._license.plan.charAt(0).toUpperCase() + this._license.plan.slice(1)
      throw new Error(`${planName} plan limit (${limit} entries). Run \`mem-ria activate <key>\` to unlock.`)
    }
    return this._store.upsert({
      ...entry,
      scope: entry.scope || this._config.scope || 'global',
    })
  }

  checkFeature(feature: keyof typeof LIMITS['free']): boolean {
    return LIMITS[this._license.plan][feature] as boolean
  }

  get license(): LicenseInfo {
    return this._license
  }

  search(query: string, opts?: SearchOptions): SearchResult[] {
    return this._store.search(query, {
      ...opts,
      scope: opts?.scope || this._config.scope,
    })
  }

  byEntity(name: string): MemoryEntry[] {
    return this._store.byEntity(name, this._config.scope)
  }

  get(id: string): MemoryEntry | null {
    return this._store.get(id)
  }

  delete(id: string): void {
    this._store.delete(id)
  }

  bridge(entryId: string, opts: BridgeOptions): string {
    return this._store.bridge(entryId, opts)
  }

  stats(): Stats {
    return this._store.stats(this._config.scope)
  }

  get store(): StorageAdapter {
    return this._store
  }

  close(): void {
    this._store.close()
  }
}

export function createMemory(config: MemRiaConfig): MemRia {
  return new MemRia(config)
}
