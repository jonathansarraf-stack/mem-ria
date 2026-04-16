// @mem-ria/server — HTTP API server with agent auth

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { MemRia, UpsertInput } from '@mem-ria/core'
import type { Brain } from '@mem-ria/brain'
import type { Extractor } from '@mem-ria/extractor'

export interface ServerConfig {
  mem: MemRia
  brain: Brain
  extractor?: Extractor
  port?: number
  apiKey?: string
  agents?: Array<{ id: string; scopes: string[] }>
}

export function createApp(config: ServerConfig) {
  const { mem, brain, extractor } = config
  const app = new Hono()

  // CORS — restrict to localhost origins
  app.use('*', cors({
    origin: (origin) => {
      if (!origin) return origin  // same-origin requests
      if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) return origin
      return ''  // reject other origins
    }
  }))

  // Generate random key if none provided
  const apiKey = config.apiKey || (() => {
    const key = randomBytes(16).toString('hex')
    console.warn(`[mem-ria] No API key configured. Generated: ${key}`)
    return key
  })()

  // Body size limit (1MB) — before auth
  app.use('/api/*', async (c, next) => {
    const contentLength = parseInt(c.req.header('Content-Length') || '0')
    if (contentLength > 1024 * 1024) {
      return c.json({ error: 'Request body too large (max 1MB)' }, 413)
    }
    await next()
  })

  // Auth middleware — always active
  app.use('/api/*', async (c, next) => {
    const auth = c.req.header('Authorization')
    const expected = `Bearer ${apiKey}`
    if (!auth || auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    await next()
  })

  // Agent scope resolution
  function resolveScope(c: { req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined } }): string | undefined {
    const agentId = c.req.header('X-Mem-Ria-Agent')
    if (agentId && config.agents) {
      const agent = config.agents.find(a => a.id === agentId)
      if (!agent) return undefined // unknown agent
      // If explicit scope requested, validate it's allowed
      const requestedScope = c.req.header('X-Mem-Ria-Scope') || c.req.query('scope')
      if (requestedScope) {
        if (!agent.scopes.includes(requestedScope) && requestedScope !== 'global') {
          return agent.scopes[0] // fall back to primary scope
        }
        return requestedScope
      }
      return agent.scopes[0]
    }
    return c.req.header('X-Mem-Ria-Scope') || c.req.query('scope') || undefined
  }

  // --- Memory CRUD ---

  app.post('/api/memory', async (c) => {
    let body: UpsertInput
    try {
      body = await c.req.json<UpsertInput>()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    const scope = resolveScope(c)
    const id = mem.upsert({ ...body, scope: body.scope || scope })
    return c.json({ id })
  })

  app.get('/api/memory/search', (c) => {
    const q = c.req.query('q') || ''
    const rawLimit = parseInt(c.req.query('limit') || '10')
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 10
    const scope = resolveScope(c)
    const results = mem.search(q, { limit, scope })
    return c.json({ results, total: results.length })
  })

  // Stats must be before :id to avoid matching "stats" as an id
  app.get('/api/memory/stats', (c) => {
    const stats = mem.stats()
    return c.json(stats)
  })

  app.get('/api/memory/:id', (c) => {
    const entry = mem.get(c.req.param('id'))
    if (!entry) return c.json({ error: 'Not found' }, 404)
    return c.json(entry)
  })

  app.delete('/api/memory/:id', (c) => {
    mem.delete(c.req.param('id'))
    return c.json({ ok: true })
  })

  // --- Extractor ---

  app.post('/api/memory/extract', async (c) => {
    if (!extractor) return c.json({ error: 'Extractor not configured' }, 501)
    let body: { userMessage: string; agentResponse: string; agentId?: string }
    try {
      body = await c.req.json<{ userMessage: string; agentResponse: string; agentId?: string }>()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    const facts = await extractor.process(body)
    return c.json({ facts, saved: facts.filter(f => f.saved).length })
  })

  // --- Entities ---

  app.get('/api/entities', (c) => {
    const entities = brain.entities.list()
    return c.json({ entities })
  })

  app.get('/api/entities/:name', (c) => {
    const result = brain.entities.getEntity(c.req.param('name'))
    if (!result) return c.json({ error: 'Not found' }, 404)
    return c.json(result)
  })

  // --- Brain ---

  app.get('/api/brain/health', (c) => {
    const scope = resolveScope(c)
    const health = brain.health(scope)
    return c.json(health)
  })

  app.post('/api/brain/cycle', async (c) => {
    const scope = resolveScope(c)
    const report = await brain.cycle(scope)
    return c.json(report)
  })

  app.get('/api/brain/salience', (c) => {
    const scope = resolveScope(c)
    const dist = brain.salience.distribution(scope)
    return c.json(dist)
  })

  // --- Health ---

  app.get('/healthz', (c) => c.json({ ok: true, ts: Date.now() }))

  // --- Dashboard ---

  app.get('/dashboard', async (c) => {
    try {
      const { readFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      // Try multiple locations for the dashboard file
      const locations = [
        join(process.cwd(), 'apps', 'dashboard', 'index.html'),
        join(process.cwd(), '..', '..', 'apps', 'dashboard', 'index.html'),
        join(__dirname, '..', '..', '..', 'apps', 'dashboard', 'index.html'),
      ]
      for (const loc of locations) {
        try {
          const html = readFileSync(loc, 'utf8')
          return c.html(html)
        } catch { /* try next */ }
      }
      return c.text('Dashboard not found. Run from mem-ria root directory.', 404)
    } catch {
      return c.text('Dashboard error', 500)
    }
  })

  return app
}

export function startServer(config: ServerConfig): void {
  const app = createApp(config)
  const port = config.port || 3333
  serve({ fetch: app.fetch, port }, () => {
    console.log(`[mem-ria] HTTP API listening on http://localhost:${port}`)
  })
}

export { Hono }
