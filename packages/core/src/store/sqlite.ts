// @mem-ria/core — SQLite storage adapter
// Ported from /root/jarvis/memory/unified.js

import Database from 'better-sqlite3'
import crypto from 'node:crypto'
import type {
  StorageAdapter,
  MemoryEntry,
  UpsertInput,
  SearchResult,
  SearchOptions,
  BridgeOptions,
  Stats,
} from '../types.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_index (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_id TEXT,
  title TEXT,
  body TEXT,
  kind TEXT,
  tags TEXT,
  entity TEXT,
  scope TEXT DEFAULT 'global',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  last_indexed INTEGER NOT NULL,
  content_hash TEXT,
  salience REAL DEFAULT 0,
  salience_updated INTEGER,
  should_archive INTEGER DEFAULT 0,
  archive_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_mem_source ON memory_index(source, source_id);
CREATE INDEX IF NOT EXISTS idx_mem_entity ON memory_index(entity);
CREATE INDEX IF NOT EXISTS idx_mem_updated ON memory_index(updated DESC);
CREATE INDEX IF NOT EXISTS idx_mem_hash ON memory_index(content_hash);
CREATE INDEX IF NOT EXISTS idx_mem_scope ON memory_index(scope);
CREATE INDEX IF NOT EXISTS idx_mem_salience ON memory_index(salience DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  title, body, tags, entity,
  content='memory_index', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory_index BEGIN
  INSERT INTO memory_fts(rowid, title, body, tags, entity)
  VALUES (new.rowid, new.title, new.body, COALESCE(new.tags, ''), COALESCE(new.entity, ''));
END;
CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory_index BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, body, tags, entity)
  VALUES ('delete', old.rowid, old.title, old.body, COALESCE(old.tags, ''), COALESCE(old.entity, ''));
END;
CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE ON memory_index BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, body, tags, entity)
  VALUES ('delete', old.rowid, old.title, old.body, COALESCE(old.tags, ''), COALESCE(old.entity, ''));
  INSERT INTO memory_fts(rowid, title, body, tags, entity)
  VALUES (new.rowid, new.title, new.body, COALESCE(new.tags, ''), COALESCE(new.entity, ''));
END;

CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  created INTEGER NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memory_index(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL UNIQUE,
  type TEXT,
  aliases TEXT,
  file_path TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);

CREATE TABLE IF NOT EXISTS mentions (
  entity_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,
  created INTEGER NOT NULL,
  PRIMARY KEY (entity_id, memory_id),
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
  FOREIGN KEY (memory_id) REFERENCES memory_index(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mentions_memory ON mentions(memory_id);

CREATE TABLE IF NOT EXISTS memory_access_log (
  memory_id TEXT NOT NULL,
  accessed_at INTEGER NOT NULL,
  context TEXT
);
CREATE INDEX IF NOT EXISTS idx_access_log_memory ON memory_access_log(memory_id);
CREATE INDEX IF NOT EXISTS idx_access_log_at ON memory_access_log(accessed_at);

CREATE TABLE IF NOT EXISTS source_registry (
  source TEXT PRIMARY KEY,
  last_scan INTEGER,
  items_indexed INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS proactive_fired (
  event_id TEXT NOT NULL,
  scope TEXT DEFAULT 'global',
  fired_at INTEGER NOT NULL,
  briefing TEXT
);
CREATE INDEX IF NOT EXISTS idx_proactive_scope ON proactive_fired(scope);
`

// --- Helpers ---
const sha256 = (s: string): string =>
  crypto.createHash('sha256').update(s).digest('hex')

const newId = (prefix = 'm'): string =>
  prefix + '_' + crypto.randomBytes(8).toString('hex')

// --- Temporal parsing (bilingual EN + PT-BR) ---
export function parseTemporalFilter(query: string): {
  from: number | null
  label: string | null
  cleaned: string
} {
  const q = query.toLowerCase()
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  let from: number | null = null
  let label: string | null = null
  let cleaned = query

  // PT-BR
  if (/\b(hoje|today)\b/.test(q)) {
    from = now - day; label = 'hoje'
    cleaned = cleaned.replace(/\b(hoje|today)\b/gi, '').trim()
  } else if (/\b(ontem|yesterday)\b/.test(q)) {
    from = now - 2 * day; label = 'ontem'
    cleaned = cleaned.replace(/\b(ontem|yesterday)\b/gi, '').trim()
  } else if (/\b(essa semana|esta semana|this week)\b/.test(q)) {
    from = now - 7 * day; label = 'esta semana'
    cleaned = cleaned.replace(/\b(essa|esta) semana\b/gi, '').replace(/\bthis week\b/gi, '').trim()
  } else if (/(ultimo|último)\s+m[eê]s/i.test(q) || /(esse|este)\s+m[eê]s/i.test(q) || /last month|this month/i.test(q)) {
    from = now - 30 * day; label = 'último mês'
    cleaned = cleaned.replace(/(último|ultimo|esse|este)\s+m[eê]s/gi, '').replace(/(last|this)\s+month/gi, '').trim()
  }

  return { from, label, cleaned }
}

// --- Decay scoring ---
export function decayScore(updated: number): number {
  const days = Math.max(0, (Date.now() - updated) / (24 * 60 * 60 * 1000))
  return 1 / (1 + days / 90) // half-life ~90 days
}

// --- Row to MemoryEntry ---
function rowToEntry(r: Record<string, unknown>): MemoryEntry {
  return {
    id: r.id as string,
    source: r.source as string,
    sourceId: (r.source_id as string) || undefined,
    title: r.title as string,
    body: r.body as string,
    kind: (r.kind as MemoryEntry['kind']) || 'note',
    tags: r.tags ? (() => { try { const parsed = JSON.parse(r.tags as string); return Array.isArray(parsed) ? parsed : []; } catch { return []; } })() : [],
    entity: (r.entity as string) || undefined,
    scope: (r.scope as string) || 'global',
    created: r.created as number,
    updated: r.updated as number,
    contentHash: r.content_hash as string,
    salience: (r.salience as number) || 0,
    salienceUpdated: (r.salience_updated as number) || undefined,
    shouldArchive: !!(r.should_archive as number),
    archiveReason: (r.archive_reason as string) || undefined,
  }
}

export function createSQLiteStore(dbPath: string): StorageAdapter {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)

  function upsert(entry: UpsertInput): string {
    const hash = sha256(`${entry.title}|${entry.body}`.slice(0, 2000))
    const ts = Date.now()
    const scope = entry.scope || 'global'
    const kind = entry.kind || 'note'
    const tags = JSON.stringify(entry.tags || [])

    // Check existing by source + source_id
    if (entry.sourceId) {
      const existing = db
        .prepare('SELECT id, content_hash FROM memory_index WHERE source = ? AND source_id = ?')
        .get(entry.source, entry.sourceId) as { id: string; content_hash: string } | undefined
      if (existing) {
        if (existing.content_hash === hash) {
          db.prepare('UPDATE memory_index SET last_indexed = ? WHERE id = ?').run(ts, existing.id)
          return existing.id
        }
        db.prepare(
          'UPDATE memory_index SET title = ?, body = ?, kind = ?, tags = ?, entity = ?, scope = ?, updated = ?, last_indexed = ?, content_hash = ? WHERE id = ?'
        ).run(entry.title, entry.body, kind, tags, entry.entity || null, scope, entry.updated || ts, ts, hash, existing.id)
        return existing.id
      }
    }

    // Cross-source dedup by content hash
    const hashDup = db
      .prepare('SELECT id FROM memory_index WHERE content_hash = ? LIMIT 1')
      .get(hash) as { id: string } | undefined
    if (hashDup) return hashDup.id

    const id = newId()
    db.prepare(
      'INSERT INTO memory_index (id, source, source_id, title, body, kind, tags, entity, scope, created, updated, last_indexed, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id, entry.source, entry.sourceId || null, entry.title, entry.body,
      kind, tags, entry.entity || null, scope,
      entry.created || ts, entry.updated || ts, ts, hash
    )
    return id
  }

  function search(query: string, opts: SearchOptions = {}): SearchResult[] {
    if (!query || !query.trim()) return []
    const limit = Math.min(opts.limit || 20, 200)
    const { from, label, cleaned } = parseTemporalFilter(query)
    const effectiveQuery = cleaned || query
    if (!effectiveQuery.trim()) return []

    const safe = effectiveQuery.replace(/"/g, '""')
    const match = `"${safe}"*`
    const args: unknown[] = [match]

    let sql = `
      SELECT m.*, snippet(memory_fts, 1, '<mark>', '</mark>', '…', 12) AS snippet, bm25(memory_fts) AS rank
      FROM memory_fts
      JOIN memory_index m ON m.rowid = memory_fts.rowid
      WHERE memory_fts MATCH ?
    `

    if (opts.source) { sql += ' AND m.source = ?'; args.push(opts.source) }
    if (from) { sql += ' AND m.updated >= ?'; args.push(from) }

    // Scope cascade: show entries from requested scope + global
    if (opts.scope && opts.scope !== 'global') {
      sql += ' AND (m.scope = ? OR m.scope = ?)'
      args.push(opts.scope, 'global')
    }

    sql += ' ORDER BY rank LIMIT ?'
    args.push(limit * 2) // fetch more for re-ranking

    try {
      const rows = db.prepare(sql).all(...args) as Record<string, unknown>[]
      const scored = rows.map((r) => {
        const decay = decayScore(r.updated as number)
        const salience = Math.max(0, (r.salience as number) || 0)
        const salienceBoost = 1 + Math.log(1 + salience)
        return {
          ...rowToEntry(r),
          snippet: r.snippet as string,
          rank: r.rank as number,
          finalScore: (-(r.rank as number)) * (0.3 + 0.7 * decay) * salienceBoost,
          temporalLabel: label || undefined,
          semantic: false,
        } satisfies SearchResult
      })
      scored.sort((a, b) => b.finalScore - a.finalScore)
      return scored.slice(0, limit)
    } catch (e) {
      console.warn('[mem-ria] search error:', e)
      return []
    }
  }

  function byEntity(name: string, scope?: string): MemoryEntry[] {
    const escapedName = name.replace(/%/g, '\\%').replace(/_/g, '\\_')
    let sql = 'SELECT * FROM memory_index WHERE (entity = ? OR entity LIKE ? ESCAPE \'\\\') '
    const args: unknown[] = [name, '%' + escapedName + '%']
    if (scope) {
      sql += 'AND (scope = ? OR scope = ?) '
      args.push(scope, 'global')
    }
    sql += 'ORDER BY updated DESC LIMIT 50'
    return (db.prepare(sql).all(...args) as Record<string, unknown>[]).map(rowToEntry)
  }

  function get(id: string): MemoryEntry | null {
    const row = db.prepare('SELECT * FROM memory_index WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? rowToEntry(row) : null
  }

  function del(id: string): void {
    db.prepare('DELETE FROM memory_index WHERE id = ?').run(id)
  }

  function bridge(entryId: string, opts: BridgeOptions): string {
    const original = get(entryId)
    if (!original) throw new Error(`Entry ${entryId} not found`)
    if (original.scope !== opts.from) throw new Error(`Entry scope '${original.scope}' does not match from '${opts.from}'`)

    // Bridge creates a copy in the target scope — must bypass content hash dedup
    // by appending scope to body before hashing
    const bridgeBody = original.body + `\n[bridged from ${opts.from}]`
    const id = newId()
    const hash = sha256(`${original.title}|${bridgeBody}`.slice(0, 2000))
    const ts = Date.now()
    const tags = JSON.stringify([...original.tags, 'bridged'])
    db.prepare(
      'INSERT INTO memory_index (id, source, source_id, title, body, kind, tags, entity, scope, created, updated, last_indexed, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      id, original.source, `bridge:${original.id}:${opts.to}`,
      original.title, original.body, original.kind, tags,
      original.entity || null, opts.to,
      original.created, original.updated, ts, hash
    )
    return id
  }

  function stats(scope?: string): Stats {
    const where = scope ? 'WHERE scope = ? OR scope = ?' : ''
    const args = scope ? [scope, 'global'] : []

    const total = (db.prepare(`SELECT COUNT(*) AS n FROM memory_index ${where}`).get(...args) as { n: number }).n
    const bySource = Object.fromEntries(
      (db.prepare(`SELECT source, COUNT(*) AS n FROM memory_index ${where} GROUP BY source`).all(...args) as Array<{ source: string; n: number }>)
        .map((r) => [r.source, r.n])
    )
    const byKind = Object.fromEntries(
      (db.prepare(`SELECT kind, COUNT(*) AS n FROM memory_index ${where} GROUP BY kind`).all(...args) as Array<{ kind: string; n: number }>)
        .map((r) => [r.kind, r.n])
    )
    const byScope = Object.fromEntries(
      (db.prepare('SELECT scope, COUNT(*) AS n FROM memory_index GROUP BY scope').all() as Array<{ scope: string; n: number }>)
        .map((r) => [r.scope, r.n])
    )
    return { total, bySource, byKind, byScope }
  }

  return {
    upsert,
    search,
    byEntity,
    get,
    delete: del,
    bridge,
    stats,
    raw: () => db,
    close: () => db.close(),
  }
}
