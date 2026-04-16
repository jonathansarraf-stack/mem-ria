import type { MemRia, MemoryKind } from '@mem-ria/core'
import type { LLMAdapter } from './llm.js'
import type Database from 'better-sqlite3'

export interface ConsolidatorConfig {
  llm: LLMAdapter
  minFragments?: number // minimum fragments before consolidating, default 3
}

export interface Consolidator {
  consolidateOnce(
    scope?: string,
  ): Promise<{ processed: number; consolidated: number }>
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

const CONSOLIDATION_PROMPT = `You are a memory consolidator. You receive multiple memory fragments about the same entity and must merge them into a single dense, self-contained summary in the same language as the fragments.

Rules:
- Preserve all important facts, decisions, preferences, and relationships
- Remove redundancy and merge overlapping information
- Keep the tone neutral and factual
- Output ONLY the consolidated text, no JSON, no markdown headers
- If fragments contradict each other, prefer the most recent one`

export function createConsolidator(
  mem: MemRia,
  config: ConsolidatorConfig,
): Consolidator {
  const minFragments = config.minFragments ?? 3
  const db = mem.store.raw() as Database.Database

  // Ensure we have a tracking table for consolidation
  db.exec(`
    CREATE TABLE IF NOT EXISTS consolidation_log (
      entity TEXT NOT NULL,
      scope TEXT NOT NULL,
      consolidated_at INTEGER NOT NULL,
      source_ids TEXT NOT NULL,
      result_id TEXT,
      PRIMARY KEY (entity, scope)
    )
  `)

  return {
    async consolidateOnce(scope) {
      const scopeFilter = scope ?? 'global'
      const cutoff = Date.now() - THIRTY_DAYS_MS

      // Find entities with minFragments+ recent entries not yet consolidated
      const candidates = db
        .prepare(
          `
        SELECT entity, COUNT(*) AS cnt, GROUP_CONCAT(id) AS ids
        FROM memory_index
        WHERE entity IS NOT NULL
          AND entity != ''
          AND scope = ?
          AND updated > ?
          AND source != 'consolidated'
        GROUP BY entity
        HAVING cnt >= ?
      `,
        )
        .all(scopeFilter, cutoff, minFragments) as Array<{
        entity: string
        cnt: number
        ids: string
      }>

      let processed = 0
      let consolidated = 0

      for (const candidate of candidates) {
        const entryIds = candidate.ids.split(',')

        // Skip if already consolidated recently (within last 30 days)
        const existing = db
          .prepare(
            `SELECT consolidated_at FROM consolidation_log WHERE entity = ? AND scope = ?`,
          )
          .get(candidate.entity, scopeFilter) as
          | { consolidated_at: number }
          | undefined

        if (existing && existing.consolidated_at > cutoff) {
          continue
        }

        // Fetch full entries
        const placeholders = entryIds.map(() => '?').join(',')
        const entries = db
          .prepare(
            `SELECT id, title, body, kind, updated FROM memory_index WHERE id IN (${placeholders}) ORDER BY updated ASC`,
          )
          .all(...entryIds) as Array<{
          id: string
          title: string
          body: string
          kind: string
          updated: number
        }>

        if (entries.length < minFragments) continue

        processed += entries.length

        // Build transcript for LLM
        const transcript = entries
          .map(
            (e, i) =>
              `[${i + 1}] (${e.kind || 'unknown'}, ${new Date(e.updated).toISOString().slice(0, 10)}) ${e.title}\n${e.body || ''}`,
          )
          .join('\n\n---\n\n')

        const mergedBody = await config.llm.synthesize(
          CONSOLIDATION_PROMPT,
          `Entity: "${candidate.entity}"\n\nFragments:\n\n${transcript}`,
          { maxTokens: 1024 },
        )

        if (!mergedBody.trim()) continue

        // Upsert the consolidated entry using the mem API
        const resultId = mem.upsert({
          source: 'consolidated',
          sourceId: `consolidated:${candidate.entity}:${scopeFilter}`,
          title: `[Consolidated] ${candidate.entity}`,
          body: mergedBody.trim(),
          kind: (entries[0].kind as MemoryKind) || 'fact',
          entity: candidate.entity,
          scope: scopeFilter,
          tags: ['consolidated'],
        })

        // Record in consolidation log
        db.prepare(
          `INSERT OR REPLACE INTO consolidation_log (entity, scope, consolidated_at, source_ids, result_id)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          candidate.entity,
          scopeFilter,
          Date.now(),
          entryIds.join(','),
          resultId,
        )

        consolidated++
      }

      return { processed, consolidated }
    },
  }
}
