// Cortex Cloud — Main server (Hono on port 3335)

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { readFileSync } from 'node:fs'
import { initDB } from './db.js'
import { createAuthRoutes } from './auth.js'
import { createStripeRoutes } from './stripe.js'
import { createBrainRoutes } from './brain.js'
import { createBrainApiRoutes } from './brain-api.js'
import { createAdminApiRoutes } from './admin-api.js'

// Load env files
function loadEnvFile(path: string): void {
  try {
    const content = readFileSync(path, 'utf8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq)
      const val = trimmed.slice(eq + 1)
      if (!process.env[key]) process.env[key] = val
    }
  } catch {
    // File not found, skip
  }
}

// Load secrets
loadEnvFile('/root/.secrets/cortex-jwt.env')
loadEnvFile('/root/.secrets/resend.env')
loadEnvFile('/root/.secrets/cortex-stripe.env')

// Init database
const DB_PATH = process.env.CORTEX_DB || '/data/cortex/cortex.db'

// Ensure data dir exists
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
try { mkdirSync(dirname(DB_PATH), { recursive: true }) } catch {}
try { mkdirSync('/data/cortex/brains', { recursive: true }) } catch {}

initDB(DB_PATH)

// Create app
const app = new Hono()

// CORS — allow cortex.eontech.pro + localhost dev
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return origin
    if (origin.includes('cortex.eontech.pro')) return origin
    if (origin.includes('eontech.pro')) return origin
    if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) return origin
    return ''
  },
  allowHeaders: ['Authorization', 'Content-Type'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
}))

// Health check
app.get('/healthz', (c) => c.json({ ok: true, service: 'cortex-cloud', ts: Date.now() }))

// Auth routes
const authRoutes = createAuthRoutes()
app.route('/api/auth', authRoutes)

// Stripe webhook routes
const stripeRoutes = createStripeRoutes()
app.route('/api/stripe', stripeRoutes)

// Brain sync routes (upload/download)
const brainRoutes = createBrainRoutes()
app.route('/api/brain', brainRoutes)

// Brain API routes (dashboard queries)
const brainApiRoutes = createBrainApiRoutes()
app.route('/api/brain', brainApiRoutes)

// Serve static assets (logo, favicons)
app.get('/brain.png', async (c) => {
  try {
    const { readFileSync } = await import('node:fs')
    const png = readFileSync('/root/mem-ria/assets/logo-cortex-brain.png')
    return new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } })
  } catch { return c.text('Not found', 404) }
})
app.get('/favicon.png', async (c) => {
  try {
    const { readFileSync } = await import('node:fs')
    const png = readFileSync('/root/mem-ria/assets/favicon.png')
    return new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' } })
  } catch { return c.text('Not found', 404) }
})
app.get('/apple-touch-icon.png', async (c) => {
  try {
    const { readFileSync } = await import('node:fs')
    const png = readFileSync('/root/mem-ria/assets/apple-touch-icon.png')
    return new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' } })
  } catch { return c.text('Not found', 404) }
})

// Admin API
const adminApiRoutes = createAdminApiRoutes()
app.route('/api/admin', adminApiRoutes)

// Serve admin dashboard at /admin/
app.get('/admin/*', async (c) => {
  const key = c.req.query('key') || ''
  if (key !== 'cortex2026') {
    return c.text('Access denied. Append ?key=cortex2026 to the URL.', 403)
  }
  try {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const __dirname = join(fileURLToPath(import.meta.url), '..')
    const html = readFileSync(join(__dirname, '..', 'public', 'admin', 'index.html'), 'utf8')
    return c.html(html)
  } catch {
    return c.text('Page not found', 404)
  }
})

app.get('/admin', (c) => c.redirect('/admin/?key=' + (c.req.query('key') || '')))

// Serve business plan at /plan/ (private, basic auth)
app.get('/plan/*', async (c) => {
  // Simple token-based access: ?key=cortex2026
  const key = c.req.query('key') || ''
  if (key !== 'cortex2026') {
    return c.text('Access denied. Append ?key=cortex2026 to the URL.', 403)
  }
  try {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const __dirname = join(fileURLToPath(import.meta.url), '..')
    const html = readFileSync(join(__dirname, '..', 'public', 'plan', 'index.html'), 'utf8')
    return c.html(html)
  } catch {
    return c.text('Page not found', 404)
  }
})

app.get('/plan', (c) => c.redirect('/plan/?key=' + (c.req.query('key') || '')))

// Serve dashboard at /app/
app.get('/app/*', async (c) => {
  try {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const __dirname = join(fileURLToPath(import.meta.url), '..')
    const html = readFileSync(join(__dirname, '..', 'public', 'app', 'index.html'), 'utf8')
    return c.html(html)
  } catch {
    return c.text('Dashboard not found', 404)
  }
})

app.get('/app', (c) => c.redirect('/app/'))

// Start
const PORT = parseInt(process.env.CORTEX_PORT || '3335')
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[cortex-cloud] listening on http://localhost:${PORT}`)
  console.log(`[cortex-cloud] DB: ${DB_PATH}`)
})

export { app }
