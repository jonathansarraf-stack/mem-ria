// @mem-ria/core — Type definitions

export interface MemoryEntry {
  id: string
  source: string
  sourceId?: string
  title: string
  body: string
  kind: MemoryKind
  tags: string[]
  entity?: string
  scope: string
  created: number
  updated: number
  contentHash: string
  salience: number
  salienceUpdated?: number
  shouldArchive: boolean
  archiveReason?: string
}

export type MemoryKind =
  | 'fact'
  | 'note'
  | 'doc'
  | 'decision'
  | 'journal'
  | 'person'
  | 'project'
  | 'preference'

export interface UpsertInput {
  source: string
  sourceId?: string
  title: string
  body: string
  kind?: MemoryKind
  tags?: string[]
  entity?: string
  scope?: string
  created?: number
  updated?: number
}

export interface SearchResult extends MemoryEntry {
  snippet?: string
  rank: number
  finalScore: number
  temporalLabel?: string
  semantic?: boolean
}

export interface SearchOptions {
  limit?: number
  source?: string
  scope?: string
  noSemantic?: boolean
  noLog?: boolean
  context?: string
}

export interface BridgeOptions {
  from: string
  to: string
}

export interface Stats {
  total: number
  bySource: Record<string, number>
  byKind: Record<string, number>
  byScope: Record<string, number>
}

export interface MemRiaConfig {
  storage: 'sqlite' | 'postgres'
  path?: string
  connectionString?: string
  scope?: string
}

export interface StorageAdapter {
  upsert(entry: UpsertInput): string
  search(query: string, opts: SearchOptions): SearchResult[]
  byEntity(name: string, scope?: string): MemoryEntry[]
  get(id: string): MemoryEntry | null
  delete(id: string): void
  bridge(entryId: string, opts: BridgeOptions): string
  stats(scope?: string): Stats
  raw(): unknown
  close(): void
}

export interface EntityRecord {
  id: string
  canonicalName: string
  type: string
  aliases: string[]
  filePath?: string
  created: number
  updated: number
}

export interface MentionRecord {
  entityId: string
  memoryId: string
  confidence: number
  created: number
}

export interface AccessLogEntry {
  memoryId: string
  accessedAt: number
  context: string
}
