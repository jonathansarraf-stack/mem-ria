/**
 * Memory Pruner
 *
 * Scans memory_index and marks/archives low-value entries:
 *   1. Body too short (< minBodyLength) with no entity
 *   2. Noise patterns: "ok", "valeu", emoji-only, etc.
 *   3. Stale entries not updated in > staleAfterDays AND zero mentions
 *
 * Default mode: dry-run (mark without deleting). Use apply() to confirm.
 * Salience protection: entries above salienceProtect threshold are never pruned.
 * Protected kinds (e.g. 'decision') are always skipped.
 *
 * Port of reference/02-jarvis/pruner.js
 */

import type { MemRia, MemoryEntry } from '@mem-ria/core'
import type Database from 'better-sqlite3'

const DEFAULT_NOISE_PATTERNS: RegExp[] = [
  /^(ok|valeu|vlw|blz|beleza|tá|ta|sim|n[aã]o|kkk+|rsrs|haha|uhul)\s*[!.?]*$/i,
  /^[\p{Emoji}\s]+$/u,
]

export interface PrunerConfig {
  noisePatterns?: RegExp[]
  minBodyLength?: number // default 20
  staleAfterDays?: number // default 180
  salienceProtect?: number // default 3.0
  protectedKinds?: string[] // default ['decision']
  dryRunByDefault?: boolean // default true
}

export interface PruneCandidate {
  id: string
  source: string
  title?: string
  reason: string
  salience: number
}

interface ProtectedEntry {
  id: string
  title?: string
  salience: number
  would_be: string
}

export interface PruneReport {
  total: number
  by_reason: Record<string, number>
  sample: PruneCandidate[]
  protected_by_salience: {
    count: number
    sample: Array<unknown>
  }
}

export interface Pruner {
  analyze(scope?: string): PruneCandidate[]
  mark(candidates: PruneCandidate[]): number
  apply(): number
  unmarkAll(): number
  report(scope?: string): PruneReport
  isNoise(text: string): boolean
}

export function createPruner(mem: MemRia, config?: PrunerConfig): Pruner {
  const db = mem.store.raw() as Database.Database

  const noisePatterns = config?.noisePatterns ?? DEFAULT_NOISE_PATTERNS
  const minBodyLength = config?.minBodyLength ?? 20
  const staleAfterDays = config?.staleAfterDays ?? 180
  const salienceProtect = config?.salienceProtect ?? 3.0
  const protectedKinds = config?.protectedKinds ?? ['decision']

  // Ensure archive columns exist
  try {
    const cols = db.prepare(`PRAGMA table_info(memory_index)`).all() as Array<{
      name: string
    }>
    if (!cols.some((c) => c.name === 'should_archive')) {
      db.exec(
        `ALTER TABLE memory_index ADD COLUMN should_archive INTEGER DEFAULT 0`
      )
    }
    if (!cols.some((c) => c.name === 'archive_reason')) {
      db.exec(`ALTER TABLE memory_index ADD COLUMN archive_reason TEXT`)
    }
  } catch {
    /* columns may already exist */
  }

  function isNoise(text: string): boolean {
    if (!text) return true
    const t = text.trim()
    if (t.length < 5) return true
    return noisePatterns.some((re) => re.test(t))
  }

  // Store last protected entries for report()
  let lastProtected: ProtectedEntry[] = []

  function analyze(scope?: string): PruneCandidate[] {
    const candidates: PruneCandidate[] = []
    const protectedBySalience: ProtectedEntry[] = []

    const whereClause = scope ? `WHERE scope = ?` : ''
    const args = scope ? [scope] : []

    const all = db
      .prepare(
        `SELECT id, source, title, body, kind, entity, updated, should_archive,
                COALESCE(salience, 0) AS salience, scope
         FROM memory_index ${whereClause}`
      )
      .all(...args) as Array<{
      id: string
      source: string
      title: string | null
      body: string | null
      kind: string
      entity: string | null
      updated: number
      should_archive: number
      salience: number
      scope: string
    }>

    const staleCutoff = Date.now() - staleAfterDays * 24 * 60 * 60 * 1000

    for (const m of all) {
      // Skip already-marked entries
      if (m.should_archive) continue

      // Skip protected kinds
      if (protectedKinds.includes(m.kind)) continue

      let reason: string | null = null
      const bodyLen = (m.body ?? '').length

      // 1. Body too short with no entity
      if (bodyLen < minBodyLength && !m.entity) {
        reason = 'body_too_short'
      }
      // 2. Noise pattern in title with short body
      else if (isNoise(m.title ?? '') && bodyLen < 30) {
        reason = 'noise_pattern'
      }
      // 3. Stale and unreferenced
      else if (m.updated < staleCutoff) {
        try {
          const row = db
            .prepare(
              `SELECT COUNT(*) AS n FROM mentions WHERE memory_id = ?`
            )
            .get(m.id) as { n: number }
          if (row.n === 0) reason = 'stale_unreferenced'
        } catch {
          // mentions table may not exist — treat as unreferenced
          reason = 'stale_unreferenced'
        }
      }

      if (reason) {
        // Salience protection: high-salience entries are never candidates
        if (m.salience >= salienceProtect) {
          protectedBySalience.push({
            id: m.id,
            title: m.title?.slice(0, 60),
            salience: m.salience,
            would_be: reason,
          })
          continue
        }

        candidates.push({
          id: m.id,
          source: m.source,
          title: m.title?.slice(0, 80),
          reason,
          salience: m.salience,
        })
      }
    }

    // Stash for report()
    lastProtected = protectedBySalience

    return candidates
  }

  function mark(candidates: PruneCandidate[]): number {
    const upd = db.prepare(
      `UPDATE memory_index SET should_archive = 1, archive_reason = ? WHERE id = ?`
    )
    const tx = db.transaction((list: PruneCandidate[]) => {
      for (const c of list) upd.run(c.reason, c.id)
    })
    tx(candidates)
    return candidates.length
  }

  function apply(): number {
    // Hard delete marked entries. FK cascades remove mentions/embeddings.
    const result = db
      .prepare(`DELETE FROM memory_index WHERE should_archive = 1`)
      .run()
    return result.changes
  }

  function unmarkAll(): number {
    return db
      .prepare(
        `UPDATE memory_index SET should_archive = 0, archive_reason = NULL`
      )
      .run().changes
  }

  function report(scope?: string): PruneReport {
    const cands = analyze(scope)
    const byReason: Record<string, number> = {}
    for (const c of cands) {
      byReason[c.reason] = (byReason[c.reason] ?? 0) + 1
    }
    return {
      total: cands.length,
      by_reason: byReason,
      sample: cands.slice(0, 10),
      protected_by_salience: {
        count: lastProtected.length,
        sample: lastProtected.slice(0, 10),
      },
    }
  }

  return {
    analyze,
    mark,
    apply,
    unmarkAll,
    report,
    isNoise,
  }
}
