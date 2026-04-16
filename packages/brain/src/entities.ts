/**
 * Entities Layer — canonical name resolution, alias matching, mention detection.
 *
 * Port of Jarvis entities.js, generalized with pluggable EntitySource interface
 * instead of hardcoded vault paths.
 *
 * Biology: the brain's fusiform face area recognizes "who" across different
 * contexts. This module does the same for names, projects, companies, tools.
 */

import { randomBytes } from 'node:crypto'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MemRia, MemoryEntry } from '@mem-ria/core'
import type Database from 'better-sqlite3'

// ── Public types ────────────────────────────────────────────────────────────

export interface EntitySource {
  type: 'person' | 'project' | 'company' | 'tool'
  scan: () => Array<{ name: string; aliases?: string[]; filePath?: string }>
}

export interface EntitiesConfig {
  sources?: EntitySource[]
}

export interface Entities {
  upsertEntity(opts: {
    canonicalName: string
    type: string
    aliases?: string[]
    filePath?: string
  }): string
  scanSources(): number
  findMentions(
    text: string,
  ): Array<{ entityId: string; canonicalName: string; confidence: number }>
  backfillMentions(
    scope?: string,
  ): { processed: number; mentionsCreated: number }
  list(): Array<{
    id: string
    canonicalName: string
    type: string
    aliases: string[]
    mentionCount: number
  }>
  getEntity(
    name: string,
  ): { entity: Record<string, unknown>; memories: MemoryEntry[] } | null
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function newEntityId(): string {
  return 'e_' + randomBytes(6).toString('hex')
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── Built-in scanner ────────────────────────────────────────────────────────

/**
 * Creates an EntitySource that scans a directory of markdown files.
 * Each `.md` file becomes an entity whose canonical name is the filename
 * (minus extension). Aliases include the lowercase canonical name and the
 * first word of the name (if >= 3 chars).
 */
export function markdownDirScanner(
  dir: string,
  type: EntitySource['type'],
): EntitySource {
  return {
    type,
    scan() {
      if (!existsSync(dir)) return []
      const results: Array<{
        name: string
        aliases?: string[]
        filePath?: string
      }> = []
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.md')) continue
        const canonical = file.replace(/\.md$/, '').trim()
        const aliases = new Set<string>([canonical.toLowerCase()])
        const firstWord = canonical.split(/\s+/)[0]
        if (firstWord && firstWord.length >= 3)
          aliases.add(firstWord.toLowerCase())
        results.push({
          name: canonical,
          aliases: [...aliases],
          filePath: join(dir, file),
        })
      }
      return results
    },
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createEntities(mem: MemRia, config?: EntitiesConfig): Entities {
  const db = mem.store.raw() as Database.Database
  const sources = config?.sources ?? []

  // Ensure tables exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      aliases TEXT NOT NULL DEFAULT '[]',
      file_path TEXT,
      created INTEGER NOT NULL,
      updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mentions (
      entity_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1,
      created INTEGER NOT NULL,
      PRIMARY KEY (entity_id, memory_id)
    );
  `)

  // ── upsertEntity ──────────────────────────────────────────────────────

  function upsertEntity(opts: {
    canonicalName: string
    type: string
    aliases?: string[]
    filePath?: string
  }): string {
    const cn = opts.canonicalName.trim()
    const ts = Date.now()
    const existing = db
      .prepare(`SELECT id, aliases FROM entities WHERE canonical_name = ?`)
      .get(cn) as { id: string; aliases: string } | undefined

    if (existing) {
      const prev: string[] = JSON.parse(existing.aliases || '[]')
      const merged = [...new Set([...prev, ...(opts.aliases ?? [])])]
      db.prepare(
        `UPDATE entities SET aliases = ?, type = COALESCE(?, type), file_path = COALESCE(?, file_path), updated = ? WHERE id = ?`,
      ).run(JSON.stringify(merged), opts.type, opts.filePath, ts, existing.id)
      return existing.id
    }

    const id = newEntityId()
    db.prepare(
      `INSERT INTO entities (id, canonical_name, type, aliases, file_path, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      cn,
      opts.type,
      JSON.stringify(opts.aliases ?? []),
      opts.filePath ?? null,
      ts,
      ts,
    )
    return id
  }

  // ── scanSources ───────────────────────────────────────────────────────

  function scanSources(): number {
    let count = 0
    for (const source of sources) {
      for (const item of source.scan()) {
        upsertEntity({
          canonicalName: item.name,
          type: source.type,
          aliases: item.aliases,
          filePath: item.filePath,
        })
        count++
      }
    }
    return count
  }

  // ── findMentions ──────────────────────────────────────────────────────

  function findMentions(
    text: string,
  ): Array<{ entityId: string; canonicalName: string; confidence: number }> {
    if (!text) return []

    const entities = db
      .prepare(`SELECT id, canonical_name, aliases FROM entities`)
      .all() as Array<{ id: string; canonical_name: string; aliases: string }>

    const lower = text.toLowerCase()
    const hits = new Map<
      string,
      { canonicalName: string; count: number }
    >()

    for (const e of entities) {
      const allNames: string[] = [
        e.canonical_name,
        ...(JSON.parse(e.aliases || '[]') as string[]),
      ].map((a) => a.toLowerCase())

      for (const alias of allNames) {
        if (alias.length < 3) continue
        // Word-boundary match
        const re = new RegExp(
          `(?:^|[\\s.,;!?()\\[\\]{}"'\\n-])${escapeRegex(alias)}(?:$|[\\s.,;!?()\\[\\]{}"'\\n-])`,
          'i',
        )
        if (re.test(lower)) {
          const prev = hits.get(e.id)
          if (prev) {
            prev.count++
          } else {
            hits.set(e.id, { canonicalName: e.canonical_name, count: 1 })
          }
          break // one match per entity is enough
        }
      }
    }

    return [...hits.entries()].map(([entityId, { canonicalName, count }]) => ({
      entityId,
      canonicalName,
      confidence: Math.min(1, count / 2),
    }))
  }

  // ── backfillMentions ──────────────────────────────────────────────────

  function backfillMentions(
    scope?: string,
  ): { processed: number; mentionsCreated: number } {
    const entities = db
      .prepare(`SELECT id, canonical_name, aliases FROM entities`)
      .all() as Array<{ id: string; canonical_name: string; aliases: string }>

    if (entities.length === 0) return { processed: 0, mentionsCreated: 0 }

    const whereScope = scope ? `WHERE scope = ?` : ''
    const args = scope ? [scope] : []
    const mems = db
      .prepare(
        `SELECT id, title, body FROM memory_index ${whereScope}`,
      )
      .all(...args) as Array<{ id: string; title: string; body: string }>

    let mentionsCreated = 0
    for (const m of mems) {
      const text = `${m.title || ''} ${m.body || ''}`
      const mentions = findMentions(text)
      for (const mention of mentions) {
        try {
          db.prepare(
            `INSERT INTO mentions (entity_id, memory_id, confidence, created)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(entity_id, memory_id) DO NOTHING`,
          ).run(mention.entityId, m.id, mention.confidence, Date.now())
          mentionsCreated++
        } catch {
          // ignore duplicates
        }
      }
    }
    return { processed: mems.length, mentionsCreated }
  }

  // ── list ──────────────────────────────────────────────────────────────

  function list(): Array<{
    id: string
    canonicalName: string
    type: string
    aliases: string[]
    mentionCount: number
  }> {
    const rows = db
      .prepare(
        `SELECT e.id, e.canonical_name, e.type, e.aliases,
                COUNT(m.memory_id) AS mention_count
         FROM entities e
         LEFT JOIN mentions m ON m.entity_id = e.id
         GROUP BY e.id
         ORDER BY e.canonical_name`,
      )
      .all() as Array<{
      id: string
      canonical_name: string
      type: string
      aliases: string
      mention_count: number
    }>

    return rows.map((r) => ({
      id: r.id,
      canonicalName: r.canonical_name,
      type: r.type,
      aliases: JSON.parse(r.aliases || '[]'),
      mentionCount: r.mention_count,
    }))
  }

  // ── getEntity ─────────────────────────────────────────────────────────

  function getEntity(
    name: string,
  ): { entity: Record<string, unknown>; memories: MemoryEntry[] } | null {
    const lname = name.toLowerCase()
    const entity = db
      .prepare(
        `SELECT * FROM entities
         WHERE LOWER(canonical_name) = ? OR aliases LIKE ?
         LIMIT 1`,
      )
      .get(lname, `%"${lname}"%`) as Record<string, unknown> | undefined

    if (!entity) return null

    const memories = db
      .prepare(
        `SELECT mi.* FROM mentions mn
         JOIN memory_index mi ON mi.id = mn.memory_id
         WHERE mn.entity_id = ?
         ORDER BY mi.updated DESC
         LIMIT 100`,
      )
      .all(entity.id as string) as MemoryEntry[]

    return { entity, memories }
  }

  return {
    upsertEntity,
    scanSources,
    findMentions,
    backfillMentions,
    list,
    getEntity,
  }
}
