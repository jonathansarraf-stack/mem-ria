// Cortex Cloud — Admin analytics API (aggregated, no PII exposure)

import { Hono } from 'hono'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { getDB } from './db.js'
import { createMemory } from '@mem-ria/core'
import { Brain } from '@mem-ria/brain'

const BRAINS_DIR = '/data/cortex/brains'
const ADMIN_KEY = 'cortex2026'

function requireAdmin() {
  return async (c: any, next: any) => {
    const key = c.req.query('key') || c.req.header('X-Admin-Key') || ''
    if (key !== ADMIN_KEY) return c.json({ error: 'Forbidden' }, 403)
    await next()
  }
}

export function createAdminApiRoutes(): Hono {
  const admin = new Hono()
  admin.use('*', requireAdmin())

  // GET /overview — high-level metrics
  admin.get('/overview', (c) => {
    const db = getDB()

    const totalUsers = (db.prepare('SELECT COUNT(*) as c FROM users').get() as any).c
    const verifiedUsers = (db.prepare('SELECT COUNT(*) as c FROM users WHERE email_verified = 1').get() as any).c
    const activeSessions = (db.prepare('SELECT COUNT(*) as c FROM refresh_sessions WHERE expires > ?').get(Date.now()) as any).c

    const subs = db.prepare('SELECT plan, status, COUNT(*) as c FROM subscriptions GROUP BY plan, status').all() as any[]

    // Count synced brains
    let syncedBrains = 0
    let totalBrainSize = 0
    if (existsSync(BRAINS_DIR)) {
      const userDirs = readdirSync(BRAINS_DIR)
      for (const dir of userDirs) {
        const brainPath = join(BRAINS_DIR, dir, 'brain.db')
        if (existsSync(brainPath)) {
          syncedBrains++
          totalBrainSize += statSync(brainPath).size
        }
      }
    }

    // Signups over time (last 30 days, by day)
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
    const signupsByDay = db.prepare(`
      SELECT date(created/1000, 'unixepoch') as day, COUNT(*) as c
      FROM users WHERE created > ?
      GROUP BY day ORDER BY day
    `).all(thirtyDaysAgo) as any[]

    // Logins (refresh sessions created) last 30 days
    const loginsByDay = db.prepare(`
      SELECT date(created/1000, 'unixepoch') as day, COUNT(*) as c
      FROM refresh_sessions WHERE created > ?
      GROUP BY day ORDER BY day
    `).all(thirtyDaysAgo) as any[]

    return c.json({
      users: {
        total: totalUsers,
        verified: verifiedUsers,
        active_sessions: activeSessions,
      },
      subscriptions: subs,
      brains: {
        synced: syncedBrains,
        total_size_mb: Math.round(totalBrainSize / 1024 / 1024 * 10) / 10,
      },
      signups_30d: signupsByDay,
      logins_30d: loginsByDay,
    })
  })

  // GET /users — list users with anonymized info
  admin.get('/users', (c) => {
    const db = getDB()
    const users = db.prepare(`
      SELECT
        u.id,
        substr(u.email, 1, 2) || '***@' || substr(u.email, instr(u.email, '@') + 1) as email_masked,
        u.name,
        u.email_verified,
        u.created,
        s.plan,
        s.status as sub_status,
        s.license_key IS NOT NULL as has_key
      FROM users u
      LEFT JOIN subscriptions s ON s.user_id = u.id
      ORDER BY u.created DESC
    `).all() as any[]

    // Enrich with brain info
    const enriched = users.map((u: any) => {
      const brainPath = join(BRAINS_DIR, u.id, 'brain.db')
      let brain_synced = false
      let brain_size = 0
      let brain_entries = 0
      let brain_last_sync = 0
      let brain_sources: Record<string, number> = {}
      let brain_kinds: Record<string, number> = {}
      let brain_health = ''
      let brain_entities = 0

      if (existsSync(brainPath)) {
        brain_synced = true
        const st = statSync(brainPath)
        brain_size = st.size
        brain_last_sync = st.mtimeMs

        try {
          const mem = createMemory({ storage: 'sqlite', path: brainPath })
          const b = new Brain(mem, {})
          const stats = mem.stats()
          brain_entries = stats.total
          brain_sources = stats.bySource
          brain_kinds = stats.byKind
          brain_health = b.health().overall
          brain_entities = b.entities.list().length
          mem.close()
        } catch {}
      }

      return {
        id: u.id,
        email_masked: u.email_masked,
        name: u.name || '(no name)',
        verified: !!u.email_verified,
        created: u.created,
        plan: u.plan || 'free',
        sub_status: u.sub_status || 'none',
        has_key: !!u.has_key,
        brain: {
          synced: brain_synced,
          size_kb: Math.round(brain_size / 1024),
          entries: brain_entries,
          sources: brain_sources,
          kinds: brain_kinds,
          health: brain_health,
          entities: brain_entities,
          last_sync: brain_last_sync,
        },
      }
    })

    return c.json({ users: enriched, total: enriched.length })
  })

  // GET /aggregate — aggregated brain analytics across all users
  admin.get('/aggregate', (c) => {
    let totalEntries = 0
    let totalEntities = 0
    const allSources: Record<string, number> = {}
    const allKinds: Record<string, number> = {}
    const healthDist: Record<string, number> = { green: 0, yellow: 0, red: 0, none: 0 }
    const entriesDist: number[] = []
    const brainSizes: number[] = []

    if (existsSync(BRAINS_DIR)) {
      const userDirs = readdirSync(BRAINS_DIR)
      for (const dir of userDirs) {
        const brainPath = join(BRAINS_DIR, dir, 'brain.db')
        if (!existsSync(brainPath)) continue

        try {
          const mem = createMemory({ storage: 'sqlite', path: brainPath })
          const brain = new Brain(mem, {})
          const stats = mem.stats()

          totalEntries += stats.total
          entriesDist.push(stats.total)
          brainSizes.push(statSync(brainPath).size)
          totalEntities += brain.entities.list().length

          for (const [k, v] of Object.entries(stats.bySource)) {
            allSources[k] = (allSources[k] || 0) + (v as number)
          }
          for (const [k, v] of Object.entries(stats.byKind)) {
            allKinds[k] = (allKinds[k] || 0) + (v as number)
          }

          const h = brain.health().overall
          healthDist[h] = (healthDist[h] || 0) + 1

          mem.close()
        } catch {}
      }
    }

    const userCount = entriesDist.length
    return c.json({
      brains_analyzed: userCount,
      total_entries_all_users: totalEntries,
      avg_entries_per_user: userCount ? Math.round(totalEntries / userCount) : 0,
      median_entries: userCount ? entriesDist.sort((a, b) => a - b)[Math.floor(userCount / 2)] : 0,
      total_entities: totalEntities,
      avg_entities_per_user: userCount ? Math.round(totalEntities / userCount) : 0,
      sources_global: allSources,
      kinds_global: allKinds,
      health_distribution: healthDist,
      brain_sizes: {
        avg_kb: userCount ? Math.round(brainSizes.reduce((a, b) => a + b, 0) / userCount / 1024) : 0,
        max_kb: brainSizes.length ? Math.round(Math.max(...brainSizes) / 1024) : 0,
        total_mb: Math.round(brainSizes.reduce((a, b) => a + b, 0) / 1024 / 1024 * 10) / 10,
      },
    })
  })

  // GET /funnel — conversion funnel
  admin.get('/funnel', (c) => {
    const db = getDB()

    const signups = (db.prepare('SELECT COUNT(*) as c FROM users').get() as any).c
    const verified = (db.prepare('SELECT COUNT(*) as c FROM users WHERE email_verified = 1').get() as any).c
    const loggedIn = (db.prepare('SELECT COUNT(DISTINCT user_id) as c FROM refresh_sessions').get() as any).c

    // Users with brains
    let synced = 0
    if (existsSync(BRAINS_DIR)) {
      synced = readdirSync(BRAINS_DIR).filter(dir =>
        existsSync(join(BRAINS_DIR, dir, 'brain.db'))
      ).length
    }

    const paying = (db.prepare("SELECT COUNT(*) as c FROM subscriptions WHERE status = 'active'").get() as any).c

    return c.json({
      funnel: [
        { step: 'Signup', count: signups, pct: 100 },
        { step: 'Email verified', count: verified, pct: signups ? Math.round(verified / signups * 100) : 0 },
        { step: 'Logged in', count: loggedIn, pct: signups ? Math.round(loggedIn / signups * 100) : 0 },
        { step: 'Brain synced', count: synced, pct: signups ? Math.round(synced / signups * 100) : 0 },
        { step: 'Paying', count: paying, pct: signups ? Math.round(paying / signups * 100) : 0 },
      ],
    })
  })

  return admin
}
