/**
 * Insular Cortex — self-diagnosis of the memory system's health.
 *
 * Port of Jarvis insular.js, generalized: no hardcoded log paths,
 * no filesystem checks. All dimensions query the database or accept
 * pluggable InsularCheck instances.
 *
 * 6 built-in dimensions:
 *   1. ingestion   — entries indexed in last 24h vs 7d average
 *   2. database    — integrity check + entry count
 *   3. accessLog   — search usage in last 24h
 *   4. embeddings  — % of entries with embedding vectors
 *   5. salience    — distribution sanity (not all high, not all zero)
 *   6. lastCycle   — reads cycle timestamps from metadata table
 *
 * Custom checks can be injected via config.checks[].
 */

import type { MemRia } from '@mem-ria/core'
import type Database from 'better-sqlite3'

// ── Public types ────────────────────────────────────────────────────────────

export type HealthStatus = 'green' | 'yellow' | 'red'

export interface InsularCheck {
  dimension: string
  check: () => { status: HealthStatus; message: string }
}

export interface InsularConfig {
  checks?: InsularCheck[]
  alertFn?: (report: HealthReport) => void
}

export interface HealthReport {
  overall: HealthStatus
  checks: Array<{ dimension: string; status: string; message: string }>
  timestamp: number
}

export interface Insular {
  fullReport(scope?: string): HealthReport
  checkIngestion(
    scope?: string,
  ): { status: string; message: string; last24h: number; avg7d: number }
}

// ── Constants ───────────────────────────────────────────────────────────────

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const MAX_STALE_HOURS = 30

// ── Factory ─────────────────────────────────────────────────────────────────

export function createInsular(
  mem: MemRia,
  config?: InsularConfig,
): Insular {
  const db = mem.store.raw() as Database.Database
  const customChecks = config?.checks ?? []
  const alertFn = config?.alertFn

  // Ensure metadata table exists for lastCycle tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS mem_ria_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated INTEGER NOT NULL
    );
  `)

  // ── Dimension 1: Ingestion ────────────────────────────────────────────

  function checkIngestion(
    scope?: string,
  ): { status: string; message: string; last24h: number; avg7d: number } {
    const now = Date.now()
    const scopeClause = scope ? `AND scope = ?` : ''
    const scopeArgs = scope ? [scope] : []

    const last24h = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM memory_index WHERE updated > ? ${scopeClause}`,
        )
        .get(now - ONE_DAY_MS, ...scopeArgs) as { n: number }
    ).n

    const last7d = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM memory_index WHERE updated > ? ${scopeClause}`,
        )
        .get(now - 7 * ONE_DAY_MS, ...scopeArgs) as { n: number }
    ).n

    const avg7d = Math.round(last7d / 7)

    let status: HealthStatus = 'green'
    let message = `${last24h} entries indexed in last 24h (7d avg: ${avg7d}/day)`

    if (last24h === 0) {
      status = 'red'
      message = 'ZERO entries in last 24h -- ingestion halted!'
    } else if (avg7d > 0 && last24h < avg7d * 0.3) {
      status = 'yellow'
      message = `Only ${last24h} entries in 24h (avg ${avg7d}) -- 70%+ drop`
    }

    return { status, message, last24h, avg7d }
  }

  // ── Dimension 2: Database ─────────────────────────────────────────────

  function checkDatabase(): {
    dimension: string
    status: HealthStatus
    message: string
  } {
    const issues: string[] = []

    try {
      const integrity = db.prepare(`PRAGMA integrity_check`).get() as {
        integrity_check: string
      }
      if (integrity.integrity_check !== 'ok') {
        issues.push(`integrity_check: ${integrity.integrity_check}`)
      }
    } catch (e: unknown) {
      issues.push(
        `integrity_check failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    }

    const total = (
      db.prepare(`SELECT COUNT(*) AS n FROM memory_index`).get() as { n: number }
    ).n

    let status: HealthStatus = 'green'
    let message = `${total} entries`

    if (issues.length) {
      status = 'red'
      message = issues.join('; ')
    }

    return { dimension: 'database', status, message }
  }

  // ── Dimension 3: Access Log ───────────────────────────────────────────

  function checkAccessLog(): {
    dimension: string
    status: HealthStatus
    message: string
  } {
    const now = Date.now()

    // memory_access_log may not exist in all setups
    let last24h = 0
    let total = 0
    try {
      last24h = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM memory_access_log WHERE accessed_at > ?`,
          )
          .get(now - ONE_DAY_MS) as { n: number }
      ).n
      total = (
        db
          .prepare(`SELECT COUNT(*) AS n FROM memory_access_log`)
          .get() as { n: number }
      ).n
    } catch {
      // Table does not exist — not a failure, just no data
      return {
        dimension: 'accessLog',
        status: 'yellow',
        message: 'Access log table not found',
      }
    }

    let status: HealthStatus = 'green'
    let message = `${last24h} accesses in 24h (${total} total)`

    if (total > 0 && last24h === 0) {
      status = 'yellow'
      message = 'No accesses in 24h -- is anyone searching?'
    }

    return { dimension: 'accessLog', status, message }
  }

  // ── Dimension 4: Embeddings ───────────────────────────────────────────

  function checkEmbeddings(): {
    dimension: string
    status: HealthStatus
    message: string
  } {
    const totalEntries = (
      db.prepare(`SELECT COUNT(*) AS n FROM memory_index`).get() as { n: number }
    ).n

    let embedded = 0
    try {
      embedded = (
        db
          .prepare(`SELECT COUNT(*) AS n FROM memory_embeddings`)
          .get() as { n: number }
      ).n
    } catch {
      // Table may not exist yet
      return {
        dimension: 'embeddings',
        status: totalEntries > 0 ? 'yellow' : 'green',
        message:
          totalEntries > 0
            ? 'Embeddings table not found'
            : 'No entries yet',
      }
    }

    const coverage = totalEntries > 0 ? Math.round((embedded / totalEntries) * 100) : 0

    let status: HealthStatus = 'green'
    let message = `${embedded}/${totalEntries} entries with embedding (${coverage}%)`

    if (embedded === 0 && totalEntries > 0) {
      status = 'yellow'
      message += ' -- no embeddings configured (optional: provide an EmbeddingAdapter)'
    } else if (coverage < 50) {
      status = 'red'
      message += ' -- severe under-coverage!'
    } else if (coverage < 80) {
      status = 'yellow'
      message += ' -- coverage below 80%'
    }

    return { dimension: 'embeddings', status, message }
  }

  // ── Dimension 5: Salience ─────────────────────────────────────────────

  function checkSalience(): {
    dimension: string
    status: HealthStatus
    message: string
  } {
    const total = (
      db.prepare(`SELECT COUNT(*) AS n FROM memory_index`).get() as { n: number }
    ).n
    const withSalience = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM memory_index WHERE salience > 0`,
        )
        .get() as { n: number }
    ).n
    const highSal = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM memory_index WHERE salience >= 3`,
        )
        .get() as { n: number }
    ).n
    const veryHighSal = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM memory_index WHERE salience >= 5`,
        )
        .get() as { n: number }
    ).n

    const pctHigh = total > 0 ? Math.round((highSal / total) * 100) : 0

    let status: HealthStatus = 'green'
    let message = `${withSalience} computed, ${highSal} high (${pctHigh}%), ${veryHighSal} very high`

    if (withSalience === 0 && total > 0) {
      status = 'red'
      message = 'No salience computed -- scoring halted!'
    } else if (pctHigh > 50) {
      status = 'yellow'
      message += ' -- over half marked important, consider recalibrating'
    }

    return { dimension: 'salience', status, message }
  }

  // ── Dimension 6: Last Cycle ───────────────────────────────────────────

  function checkLastCycle(): {
    dimension: string
    status: HealthStatus
    message: string
  } {
    const cycleKeys = [
      'last_rescan',
      'last_prune',
      'last_salience',
      'last_embeddings',
    ]
    const now = Date.now()
    const issues: string[] = []

    for (const key of cycleKeys) {
      try {
        const row = db
          .prepare(
            `SELECT value, updated FROM mem_ria_metadata WHERE key = ?`,
          )
          .get(key) as { value: string; updated: number } | undefined

        if (!row) {
          issues.push(`${key}: never recorded`)
          continue
        }

        const ageHours = Math.round((now - row.updated) / (60 * 60 * 1000))
        if (ageHours > MAX_STALE_HOURS) {
          issues.push(`${key}: ${ageHours}h ago (expected <${MAX_STALE_HOURS}h)`)
        }
      } catch {
        issues.push(`${key}: failed to read`)
      }
    }

    let status: HealthStatus = 'green'
    if (issues.length >= 3) status = 'red'
    else if (issues.length >= 1) status = 'yellow'

    const message = issues.length
      ? issues.join('; ')
      : 'All cycles ran recently'

    return { dimension: 'lastCycle', status, message }
  }

  // ── fullReport ────────────────────────────────────────────────────────

  function fullReport(scope?: string): HealthReport {
    const builtInChecks = [
      { dimension: 'ingestion', ...checkIngestion(scope) },
      checkDatabase(),
      checkAccessLog(),
      checkEmbeddings(),
      checkSalience(),
      checkLastCycle(),
    ]

    // Run custom checks
    const customResults = customChecks.map((c) => ({
      dimension: c.dimension,
      ...c.check(),
    }))

    const allChecks = [
      ...builtInChecks.map((c) => ({
        dimension: c.dimension,
        status: c.status,
        message: c.message,
      })),
      ...customResults.map((c) => ({
        dimension: c.dimension,
        status: c.status,
        message: c.message,
      })),
    ]

    const overall: HealthStatus = allChecks.some((c) => c.status === 'red')
      ? 'red'
      : allChecks.some((c) => c.status === 'yellow')
        ? 'yellow'
        : 'green'

    const report: HealthReport = {
      overall,
      checks: allChecks,
      timestamp: Date.now(),
    }

    if (alertFn && overall !== 'green') {
      alertFn(report)
    }

    return report
  }

  return { fullReport, checkIngestion }
}
