/**
 * Salience Tagger — "amígdala de memória"
 *
 * Computes an importance weight per entry based on 7 signals:
 *   1. Query frequency       — how many times retrieved in last 30d
 *   2. Mention velocity      — entity cited in recent entries
 *   3. Explicit tags         — important/decision/pinned/urgent/family
 *   4. Kind-based priors     — decision/person/project weigh more
 *   5. Boost-source surfacing — entries cited by configurable sources
 *   6. Boost-kind mention    — entries cited by configurable kinds
 *   7. Canonical entity      — entity has curated aliases
 *
 * Result goes to memory_index.salience, used by:
 *   - search ranking (boost for relevant entries)
 *   - pruner (protection — never archive salience > threshold)
 *
 * Port of reference/02-jarvis/salience.js
 */

import type { MemRia, MemoryEntry } from '@mem-ria/core'
import type Database from 'better-sqlite3'

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

const DEFAULT_KIND_WEIGHTS: Record<string, number> = {
  decision: 2.5,
  person: 2.0,
  project: 1.8,
  journal: 1.0,
  fact: 1.0,
  preference: 1.0,
  note: 0.7,
  doc: 0.5,
}

const DEFAULT_IMPORTANT_TAGS = [
  'importante',
  'decision',
  'pinned',
  'urgent',
  'family',
  'decisao',
  'critico',
]

export interface SalienceConfig {
  kindWeights?: Record<string, number>
  importantTags?: string[]
  protectThreshold?: number // default 3.0
  boostSources?: string[] // generalized signal 5 (was 'eon_strategic')
  boostKinds?: string[] // generalized signal 6 (was 'vault' + tag 'diario')
}

export interface SalienceDistribution {
  buckets: Array<{ bucket: string; n: number }>
  top: Array<{ source: string; title: string; salience: number }>
}

export interface Salience {
  computeSalience(entry: MemoryEntry): number
  recomputeAll(scope?: string): number
  logAccess(memoryIds: string[], context?: string): number
  distribution(scope?: string): SalienceDistribution
  pruneAccessLog(maxDays?: number): number
}

export function createSalience(mem: MemRia, config?: SalienceConfig): Salience {
  const db = mem.store.raw() as Database.Database

  const kindWeights = config?.kindWeights ?? DEFAULT_KIND_WEIGHTS
  const importantTags = config?.importantTags ?? DEFAULT_IMPORTANT_TAGS
  const boostSources = config?.boostSources ?? []
  const boostKinds = config?.boostKinds ?? []

  function computeSalience(entry: MemoryEntry): number {
    let score = 0
    const cutoff = Date.now() - THIRTY_DAYS_MS

    // 1. Query frequency — recent access
    try {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM memory_access_log WHERE memory_id = ? AND accessed_at > ?`
        )
        .get(entry.id, cutoff) as { n: number }
      score += Math.log(1 + row.n) * 2.0
    } catch {
      /* table may not exist yet */
    }

    // 2. Mention velocity — entity cited in recent entries
    if (entry.entity) {
      try {
        const row = db
          .prepare(
            `SELECT COUNT(*) AS n FROM memory_index WHERE entity = ? AND created > ?`
          )
          .get(entry.entity, cutoff) as { n: number }
        score += Math.log(1 + row.n) * 1.5
      } catch {
        /* ignore */
      }
    }

    // 3. Explicit importance tags
    let tags: string[] = []
    try {
      tags = Array.isArray(entry.tags) ? entry.tags : typeof entry.tags === 'string' ? JSON.parse(entry.tags as string) : []
      if (!Array.isArray(tags)) tags = []
    } catch { tags = [] }
    {
      const importantCount = tags.filter((t) => {
        const lower = String(t).toLowerCase()
        return importantTags.some((it) => lower.includes(it))
      }).length
      score += importantCount * 3.0
    }

    // 4. Kind-based prior
    score += kindWeights[entry.kind] ?? 0.5

    // 5. Boost-source surfacing (generalized from eon_strategic)
    if (entry.title && boostSources.length > 0) {
      const titleSnippet = entry.title.slice(0, 60)
      for (const src of boostSources) {
        try {
          const row = db
            .prepare(
              `SELECT COUNT(*) AS n FROM memory_index
               WHERE source = ?
                 AND (body LIKE ? OR title LIKE ?)
                 AND created > ?`
            )
            .get(src, `%${titleSnippet}%`, `%${titleSnippet}%`, cutoff) as {
            n: number
          }
          score += row.n * 2.5
        } catch {
          /* ignore */
        }
      }
    }

    // 6. Boost-kind mention (generalized from vault/diario)
    if (entry.title && boostKinds.length > 0) {
      const titleSnippet = entry.title.slice(0, 60)
      for (const kind of boostKinds) {
        try {
          const row = db
            .prepare(
              `SELECT COUNT(*) AS n FROM memory_index
               WHERE kind = ?
                 AND body LIKE ?
                 AND updated > ?`
            )
            .get(kind, `%${titleSnippet}%`, cutoff) as { n: number }
          score += row.n * 2.0
        } catch {
          /* ignore */
        }
      }
    }

    // 7. Canonical entity — entity has curated aliases
    if (entry.entity) {
      try {
        const isCanonical = db
          .prepare(
            `SELECT 1 FROM entities WHERE canonical_name = ? OR aliases LIKE ?`
          )
          .get(entry.entity, `%"${entry.entity}"%`)
        if (isCanonical) score += 1.0
      } catch {
        /* ignore */
      }
    }

    return score
  }

  function recomputeAll(scope?: string): number {
    const query = scope
      ? `SELECT id, entity, tags, kind, title, source, scope, body, created, updated, content_hash AS contentHash, salience, salience_updated AS salienceUpdated, should_archive AS shouldArchive, archive_reason AS archiveReason FROM memory_index WHERE scope = ?`
      : `SELECT id, entity, tags, kind, title, source, scope, body, created, updated, content_hash AS contentHash, salience, salience_updated AS salienceUpdated, should_archive AS shouldArchive, archive_reason AS archiveReason FROM memory_index`

    const entries = scope
      ? (db.prepare(query).all(scope) as MemoryEntry[])
      : (db.prepare(query).all() as MemoryEntry[])

    const upd = db.prepare(
      `UPDATE memory_index SET salience = ?, salience_updated = ? WHERE id = ?`
    )
    const now = Date.now()

    const tx = db.transaction(() => {
      for (const e of entries) {
        // Parse tags from JSON string if needed
        if (typeof e.tags === 'string') {
          try {
            e.tags = JSON.parse(e.tags as unknown as string)
          } catch {
            e.tags = []
          }
        }
        const s = computeSalience(e)
        upd.run(s, now, e.id)
      }
    })
    tx()

    return entries.length
  }

  function logAccess(memoryIds: string[], context?: string): number {
    if (!Array.isArray(memoryIds) || memoryIds.length === 0) return 0

    const ins = db.prepare(
      `INSERT OR IGNORE INTO memory_access_log (memory_id, accessed_at, context) VALUES (?, ?, ?)`
    )
    const now = Date.now()
    let count = 0

    const tx = db.transaction(() => {
      for (const id of memoryIds) {
        if (id) {
          ins.run(id, now, context ?? 'unknown')
          count++
        }
      }
    })
    tx()

    return count
  }

  function distribution(scope?: string): SalienceDistribution {
    const whereClause = scope ? `WHERE scope = ?` : ''
    const args = scope ? [scope] : []

    const buckets = db
      .prepare(
        `SELECT
          CASE
            WHEN salience < 1 THEN '0. low (<1)'
            WHEN salience < 2 THEN '1. med-low (1-2)'
            WHEN salience < 3 THEN '2. med (2-3)'
            WHEN salience < 5 THEN '3. high (3-5)'
            ELSE '4. very_high (5+)'
          END AS bucket,
          COUNT(*) AS n
        FROM memory_index ${whereClause}
        GROUP BY bucket
        ORDER BY bucket`
      )
      .all(...args) as Array<{ bucket: string; n: number }>

    const top = db
      .prepare(
        `SELECT source, title, salience FROM memory_index ${whereClause}
         ORDER BY salience DESC LIMIT 10`
      )
      .all(...args) as Array<{ source: string; title: string; salience: number }>

    return { buckets, top }
  }

  function pruneAccessLog(maxDays = 90): number {
    const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000
    return db
      .prepare(`DELETE FROM memory_access_log WHERE accessed_at < ?`)
      .run(cutoff).changes
  }

  return {
    computeSalience,
    recomputeAll,
    logAccess,
    distribution,
    pruneAccessLog,
  }
}
