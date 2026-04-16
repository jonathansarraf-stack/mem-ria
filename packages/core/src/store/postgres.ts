// @mem-ria/core — Postgres storage adapter (stub)

import type { StorageAdapter } from '../types.js'

export function createPostgresStore(_connectionString: string): StorageAdapter {
  throw new Error(
    'Postgres adapter coming soon. Use SQLite for now: createMemory({ storage: "sqlite", path: "./brain.db" })'
  )
}
