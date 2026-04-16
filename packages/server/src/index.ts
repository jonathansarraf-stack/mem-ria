// @mem-ria/server — HTTP API server with agent auth

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
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

  // CORS
  app.use('*', cors())

  // Auth middleware
  if (config.apiKey) {
    app.use('/api/*', async (c, next) => {
      const auth = c.req.header('Authorization')
      if (!auth || auth !== `Bearer ${config.apiKey}`) {
        return c.json({ error: 'Unauthorized' }, 401)
      }
      await next()
    })
  }

  // Agent scope resolution
  function resolveScope(c: { req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined } }): string | undefined {
    const agentId = c.req.header('X-Mem-Ria-Agent')
    if (agentId && config.agents) {
      const agent = config.agents.find(a => a.id === agentId)
      if (agent) return agent.scopes[0] // primary scope
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

  app.get('/api/memory/:id', (c) => {
    const entry = mem.get(c.req.param('id'))
    if (!entry) return c.json({ error: 'Not found' }, 404)
    return c.json(entry)
  })

  app.delete('/api/memory/:id', (c) => {
    mem.delete(c.req.param('id'))
    return c.json({ ok: true })
  })

  app.get('/api/memory/stats', (c) => {
    const scope = resolveScope(c)
    const stats = mem.stats()
    return c.json(stats)
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
