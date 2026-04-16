import type { MemRia } from '@mem-ria/core'
import type { EmbeddingAdapter } from './embeddings-adapter.js'
import type Database from 'better-sqlite3'

export interface EmbeddingsConfig {
  adapter: EmbeddingAdapter
  batchSize?: number // default 50
}

export interface Embeddings {
  embedNew(
    scope?: string,
  ): Promise<{ embedded: number; skipped: number }>
  semanticSearch(
    queryVec: number[],
    opts?: { limit?: number; minScore?: number; scope?: string },
  ): Array<{ id: string; title: string; body: string; cosineScore: number }>
  stats(): { total: number; embedded: number; coverage: number }
}

function vecToBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer)
}

function blobToVec(blob: Buffer): number[] {
  const ab = blob.buffer.slice(
    blob.byteOffset,
    blob.byteOffset + blob.byteLength,
  )
  return Array.from(new Float32Array(ab))
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

export function createEmbeddings(
  mem: MemRia,
  config: EmbeddingsConfig,
): Embeddings {
  const batchSize = config.batchSize ?? 50
  const adapter = config.adapter
  const db = mem.store.raw() as Database.Database

  return {
    async embedNew(scope) {
      // Find entries without embeddings
      const scopeClause = scope ? 'AND m.scope = ?' : ''
      const params: unknown[] = scope ? [scope] : []

      const entries = db
        .prepare(
          `
        SELECT m.id, m.title, m.body
        FROM memory_index m
        LEFT JOIN memory_embeddings e ON m.id = e.memory_id
        WHERE e.memory_id IS NULL ${scopeClause}
      `,
        )
        .all(...params) as Array<{
        id: string
        title: string
        body: string
      }>

      if (!entries.length) return { embedded: 0, skipped: 0 }

      const insert = db.prepare(
        `INSERT OR REPLACE INTO memory_embeddings (memory_id, model, dim, vec, created)
         VALUES (?, ?, ?, ?, ?)`,
      )

      let embedded = 0
      let skipped = 0

      for (let i = 0; i < entries.length; i += batchSize) {
        const batch = entries.slice(i, i + batchSize)

        for (const entry of batch) {
          const text =
            `${entry.title || ''}\n\n${(entry.body || '').slice(0, 6000)}`.trim()

          if (!text || text.length < 10) {
            skipped++
            continue
          }

          try {
            const vec = await adapter.embed(text)

            if (!vec || vec.length !== adapter.dimensions) {
              skipped++
              continue
            }

            insert.run(
              entry.id,
              adapter.model,
              adapter.dimensions,
              vecToBlob(vec),
              Date.now(),
            )
            embedded++
          } catch {
            skipped++
          }
        }
      }

      return { embedded, skipped }
    },

    semanticSearch(queryVec, opts) {
      const limit = opts?.limit ?? 10
      const minScore = opts?.minScore ?? 0.3
      const scope = opts?.scope

      const scopeClause = scope ? 'AND m.scope = ?' : ''
      const params: unknown[] = scope ? [scope] : []

      const rows = db
        .prepare(
          `
        SELECT e.memory_id, e.vec, m.title, m.body
        FROM memory_embeddings e
        JOIN memory_index m ON m.id = e.memory_id
        WHERE 1=1 ${scopeClause}
      `,
        )
        .all(...params) as Array<{
        memory_id: string
        vec: Buffer
        title: string
        body: string
      }>

      const scored: Array<{
        id: string
        title: string
        body: string
        cosineScore: number
      }> = []

      for (const row of rows) {
        const vec = blobToVec(row.vec)
        const sim = cosine(queryVec, vec)

        if (sim >= minScore) {
          scored.push({
            id: row.memory_id,
            title: row.title,
            body: row.body?.slice(0, 500) ?? '',
            cosineScore: sim,
          })
        }
      }

      scored.sort((a, b) => b.cosineScore - a.cosineScore)
      return scored.slice(0, limit)
    },

    stats() {
      const total = (
        db.prepare('SELECT COUNT(*) AS n FROM memory_index').get() as {
          n: number
        }
      ).n

      const embedded = (
        db.prepare('SELECT COUNT(*) AS n FROM memory_embeddings').get() as {
          n: number
        }
      ).n

      return {
        total,
        embedded,
        coverage: total === 0 ? 0 : embedded / total,
      }
    },
  }
}
