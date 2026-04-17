// Cortex Cloud — Brain sync endpoints (upload/download brain.db)

import { Hono } from 'hono'
import { writeFileSync, readFileSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { requireAuth } from './auth.js'

const BRAINS_DIR = '/data/cortex/brains'

function brainPath(userId: string): string {
  const dir = join(BRAINS_DIR, userId)
  mkdirSync(dir, { recursive: true })
  return join(dir, 'brain.db')
}

export function createBrainRoutes(): Hono {
  const brain = new Hono()

  // All brain routes require auth
  brain.use('*', requireAuth())

  // POST /upload — receive brain.db (gzipped or raw)
  brain.post('/upload', async (c) => {
    const { id } = c.get('user') as { id: string }
    const contentType = c.req.header('Content-Type') || ''
    const encoding = c.req.header('Content-Encoding') || ''

    let buffer: Buffer
    try {
      const raw = await c.req.arrayBuffer()
      buffer = Buffer.from(raw)
    } catch {
      return c.json({ error: 'Failed to read request body' }, 400)
    }

    if (buffer.length === 0) {
      return c.json({ error: 'Empty body' }, 400)
    }

    // 50MB max
    if (buffer.length > 50 * 1024 * 1024) {
      return c.json({ error: 'brain.db too large (max 50MB)' }, 413)
    }

    // Decompress if gzipped
    let dbBuffer: Buffer
    if (encoding === 'gzip' || contentType === 'application/gzip') {
      try {
        dbBuffer = gunzipSync(buffer)
      } catch {
        return c.json({ error: 'Failed to decompress gzip body' }, 400)
      }
    } else {
      dbBuffer = buffer
    }

    // Validate: SQLite files start with "SQLite format 3\0"
    const magic = dbBuffer.subarray(0, 16).toString('ascii')
    if (!magic.startsWith('SQLite format 3')) {
      return c.json({ error: 'Invalid SQLite file' }, 400)
    }

    const dest = brainPath(id)
    writeFileSync(dest, dbBuffer)

    const stats = statSync(dest)
    console.log(`[cortex-cloud] Brain uploaded: user=${id} size=${(stats.size / 1024).toFixed(0)}KB`)

    return c.json({
      ok: true,
      size: stats.size,
      path: dest,
      uploaded_at: Date.now(),
    })
  })

  // GET /download — download brain.db (gzipped)
  brain.get('/download', (c) => {
    const { id } = c.get('user') as { id: string }
    const path = brainPath(id)

    if (!existsSync(path)) {
      return c.json({ error: 'No brain.db found. Run `mem-ria sync` first.' }, 404)
    }

    const raw = readFileSync(path)
    const compressed = gzipSync(raw)

    return new Response(compressed, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': 'attachment; filename="brain.db.gz"',
        'Content-Encoding': 'gzip',
        'Content-Length': String(compressed.length),
        'X-Original-Size': String(raw.length),
      },
    })
  })

  // GET /status — brain sync status
  brain.get('/status', (c) => {
    const { id } = c.get('user') as { id: string }
    const path = brainPath(id)

    if (!existsSync(path)) {
      return c.json({ synced: false, message: 'No brain.db uploaded yet' })
    }

    const stats = statSync(path)
    return c.json({
      synced: true,
      size: stats.size,
      last_modified: stats.mtimeMs,
      last_modified_iso: new Date(stats.mtimeMs).toISOString(),
    })
  })

  return brain
}
