// @mem-ria/core — Memory storage and CRUD

export { MemRia, createMemory } from './memory.js'
export { createSQLiteStore, parseTemporalFilter, decayScore } from './store/sqlite.js'
export { createPostgresStore } from './store/postgres.js'

export type {
  MemoryEntry,
  MemoryKind,
  UpsertInput,
  SearchResult,
  SearchOptions,
  BridgeOptions,
  Stats,
  MemRiaConfig,
  StorageAdapter,
  EntityRecord,
  MentionRecord,
  AccessLogEntry,
} from './types.js'
