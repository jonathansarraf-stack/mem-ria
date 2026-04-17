// Cortex Cloud — Brain API endpoints for dashboard
// Loads user's brain.db per-request, queries, returns JSON

import { Hono } from 'hono'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createMemory } from '@mem-ria/core'
import { Brain } from '@mem-ria/brain'
import { requireAuth } from './auth.js'

const BRAINS_DIR = '/data/cortex/brains'

function userBrainPath(userId: string): string {
  return join(BRAINS_DIR, userId, 'brain.db')
}

function withBrain<T>(userId: string, fn: (mem: ReturnType<typeof createMemory>, brain: Brain) => T): T {
  const path = userBrainPath(userId)
  if (!existsSync(path)) {
    throw new Error('NO_BRAIN')
  }
  const mem = createMemory({ storage: 'sqlite', path })
  const brain = new Brain(mem, {})
  try {
    return fn(mem, brain)
  } finally {
    mem.close()
  }
}

function noBrainError(c: any) {
  return c.json({ error: 'No brain.db synced. Run `mem-ria sync` first.' }, 404)
}

export function createBrainApiRoutes(): Hono {
  const api = new Hono()

  api.use('*', requireAuth())

  // GET /stats — memory stats
  api.get('/stats', (c) => {
    const { id } = c.get('user') as { id: string }
    try {
      return c.json(withBrain(id, (mem) => {
        const stats = mem.stats()
        return stats
      }))
    } catch (e: any) {
      if (e.message === 'NO_BRAIN') return noBrainError(c)
      throw e
    }
  })

  // GET /search?q=&limit= — search memories
  api.get('/search', (c) => {
    const { id } = c.get('user') as { id: string }
    const q = c.req.query('q') || ''
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '20'), 1), 100)
    try {
      return c.json(withBrain(id, (mem) => {
        const results = mem.search(q, { limit })
        return { results, total: results.length }
      }))
    } catch (e: any) {
      if (e.message === 'NO_BRAIN') return noBrainError(c)
      throw e
    }
  })

  // GET /health — insular report
  api.get('/health', (c) => {
    const { id } = c.get('user') as { id: string }
    try {
      return c.json(withBrain(id, (_mem, brain) => brain.health()))
    } catch (e: any) {
      if (e.message === 'NO_BRAIN') return noBrainError(c)
      throw e
    }
  })

  // GET /salience — distribution
  api.get('/salience', (c) => {
    const { id } = c.get('user') as { id: string }
    try {
      return c.json(withBrain(id, (_mem, brain) => brain.salience.distribution()))
    } catch (e: any) {
      if (e.message === 'NO_BRAIN') return noBrainError(c)
      throw e
    }
  })

  // GET /entities — list all entities
  api.get('/entities', (c) => {
    const { id } = c.get('user') as { id: string }
    try {
      return c.json(withBrain(id, (_mem, brain) => {
        const entities = brain.entities.list()
        return { entities }
      }))
    } catch (e: any) {
      if (e.message === 'NO_BRAIN') return noBrainError(c)
      throw e
    }
  })

  // GET /entity/:name — entity detail + memories
  api.get('/entity/:name', (c) => {
    const { id } = c.get('user') as { id: string }
    const name = decodeURIComponent(c.req.param('name'))
    try {
      return c.json(withBrain(id, (_mem, brain) => {
        const result = brain.entities.getEntity(name)
        if (!result) return c.json({ error: 'Entity not found' }, 404)
        return result
      }))
    } catch (e: any) {
      if (e.message === 'NO_BRAIN') return noBrainError(c)
      throw e
    }
  })

  // GET /graph — entities + co-occurrence edges for graph visualization
  api.get('/graph', (c) => {
    const { id } = c.get('user') as { id: string }
    try {
      return c.json(withBrain(id, (mem, brain) => {
        const entities = brain.entities.list()
        if (!entities.length) return { nodes: [], edges: [] }

        const db = (mem as any).store?.raw?.()
        if (!db) return { nodes: entities, edges: [] }

        // Build co-occurrence: which entities appear in the same memories?
        // mentions table has: entity_id, memory_id
        const edges: Array<{ source: string; target: string; weight: number }> = []

        try {
          // Get all entity pairs that share at least one memory
          const rows = db.prepare(`
            SELECT m1.entity_id as e1, m2.entity_id as e2, COUNT(*) as weight
            FROM mentions m1
            JOIN mentions m2 ON m1.memory_id = m2.memory_id AND m1.entity_id < m2.entity_id
            GROUP BY m1.entity_id, m2.entity_id
            HAVING weight >= 1
            ORDER BY weight DESC
            LIMIT 200
          `).all() as Array<{ e1: string; e2: string; weight: number }>

          // Map entity IDs to names
          const idToName: Record<string, string> = {}
          for (const e of entities) {
            idToName[e.id] = e.canonicalName
          }

          for (const r of rows) {
            if (idToName[r.e1] && idToName[r.e2]) {
              edges.push({ source: idToName[r.e1], target: idToName[r.e2], weight: r.weight })
            }
          }
        } catch {
          // mentions table might not exist, fall back to no edges
        }

        return { nodes: entities, edges }
      }))
    } catch (e: any) {
      if (e.message === 'NO_BRAIN') return noBrainError(c)
      throw e
    }
  })

  // POST /cycle — trigger brain cycle
  api.post('/cycle', async (c) => {
    const { id } = c.get('user') as { id: string }
    const path = userBrainPath(id)
    if (!existsSync(path)) return noBrainError(c)

    const mem = createMemory({ storage: 'sqlite', path })
    const brain = new Brain(mem, {})
    try {
      const report = await brain.cycle()
      return c.json(report)
    } finally {
      mem.close()
    }
  })

  // GET /memories?page=&limit=&kind=&source=&sort=&salience_min=&salience_max= — paginated list
  api.get('/memories', (c) => {
    const { id } = c.get('user') as { id: string }
    const page = Math.max(parseInt(c.req.query('page') || '1'), 1)
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50'), 1), 200)
    const kind = c.req.query('kind') || ''
    const source = c.req.query('source') || ''
    const sort = c.req.query('sort') || 'date' // date | salience
    const salienceMin = parseFloat(c.req.query('salience_min') || '0')
    const salienceMax = parseFloat(c.req.query('salience_max') || '999')

    try {
      return c.json(withBrain(id, (mem) => {
        // Use search with empty query to get all, then filter
        // Actually, we need direct DB access for pagination. Use the internal db.
        const db = (mem as any).store?.raw?.()
        if (!db) return { memories: [], total: 0 }

        let where = 'WHERE 1=1'
        const params: any[] = []

        if (kind) { where += ' AND kind = ?'; params.push(kind) }
        if (source) { where += ' AND source = ?'; params.push(source) }
        where += ' AND salience >= ? AND salience <= ?'
        params.push(salienceMin, salienceMax)

        const countRow = db.prepare(`SELECT COUNT(*) as c FROM memory_index ${where}`).get(...params) as any
        const total = countRow?.c || 0

        const orderBy = sort === 'salience' ? 'salience DESC' : 'created DESC'
        const offset = (page - 1) * limit
        const rows = db.prepare(`SELECT id, source, source_id, title, body, kind, tags, entity, scope, created, updated, salience FROM memory_index ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...params, limit, offset)

        return {
          memories: rows,
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
        }
      }))
    } catch (e: any) {
      if (e.message === 'NO_BRAIN') return noBrainError(c)
      throw e
    }
  })

  // GET /timeline — memories per day (last 30d)
  api.get('/timeline', (c) => {
    const { id } = c.get('user') as { id: string }
    const days = Math.min(parseInt(c.req.query('days') || '30'), 90)

    try {
      return c.json(withBrain(id, (mem) => {
        const db = (mem as any).store?.raw?.()
        if (!db) return { timeline: [] }

        const since = Date.now() - days * 24 * 60 * 60 * 1000
        const rows = db.prepare(`
          SELECT date(created/1000, 'unixepoch') as day, COUNT(*) as count
          FROM memory_index
          WHERE created > ?
          GROUP BY day
          ORDER BY day ASC
        `).all(since) as Array<{ day: string; count: number }>

        return { timeline: rows, days }
      }))
    } catch (e: any) {
      if (e.message === 'NO_BRAIN') return noBrainError(c)
      throw e
    }
  })

  return api
}
