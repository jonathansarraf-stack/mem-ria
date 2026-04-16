// @mem-ria/core — MemRia main class

import { createSQLiteStore } from './store/sqlite.js'
import { createPostgresStore } from './store/postgres.js'
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

  constructor(config: MemRiaConfig) {
    this._config = config
    if (config.storage === 'postgres') {
      this._store = createPostgresStore(config.connectionString || '')
    } else {
      this._store = createSQLiteStore(config.path || ':memory:')
    }
  }

  upsert(entry: UpsertInput): string {
    return this._store.upsert({
      ...entry,
      scope: entry.scope || this._config.scope || 'global',
    })
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
