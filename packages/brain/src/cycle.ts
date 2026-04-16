// @mem-ria/brain — Brain Cycle orchestrator
// Runs the nightly pipeline: connectors → salience → pruner → embeddings → insular → replay

import type { Salience } from './salience.js'
import type { Pruner } from './pruner.js'
import type { Insular, HealthReport } from './insular.js'
import type { Replay } from './replay.js'
import type { Embeddings } from './embeddings.js'
import type { Entities } from './entities.js'
import type { Consolidator } from './consolidator.js'

export interface CycleStep {
  step: string
  ts: string
  [key: string]: unknown
}

export interface CycleReport {
  steps: CycleStep[]
  health: HealthReport
  elapsed: number
}

export interface CycleModules {
  salience?: Salience
  pruner?: Pruner
  insular?: Insular
  replay?: Replay
  embeddings?: Embeddings
  entities?: Entities
  consolidator?: Consolidator
  connectorScanFn?: (scope?: string) => Promise<{ count: number }>
  mem?: { store: { raw(): unknown } }
}

function log(step: string, data: Record<string, unknown> = {}): CycleStep {
  return { step, ts: new Date().toISOString(), ...data }
}

function recordMeta(db: any, key: string) {
  try {
    db.prepare('INSERT OR REPLACE INTO mem_ria_metadata (key, value, updated) VALUES (?, ?, ?)').run(key, 'ok', Date.now())
  } catch { /* table might not exist */ }
}

export async function runCycle(
  modules: CycleModules,
  scope?: string
): Promise<CycleReport> {
  const startTime = Date.now()
  const steps: CycleStep[] = []
  const db = modules.mem ? modules.mem.store.raw() : null

  // 0. Connectors scan
  if (modules.connectorScanFn) {
    try {
      const r = await modules.connectorScanFn(scope)
      steps.push(log('connectors', r))
      if (db) recordMeta(db, 'last_rescan')
    } catch (e) {
      steps.push(log('connectors_error', { error: (e as Error).message }))
    }
  }

  // 0b. Consolidator
  if (modules.consolidator) {
    try {
      const r = await modules.consolidator.consolidateOnce(scope)
      steps.push(log('consolidator', r))
    } catch (e) {
      steps.push(log('consolidator_skip', { reason: (e as Error).message }))
    }
  }

  // 0c. Entities scan + backfill
  if (modules.entities) {
    try {
      const scanned = modules.entities.scanSources()
      const mentions = modules.entities.backfillMentions(scope)
      steps.push(log('entities', { scanned, ...mentions }))
    } catch (e) {
      steps.push(log('entities_skip', { reason: (e as Error).message }))
    }
  }

  // 1. Salience recompute
  if (modules.salience) {
    try {
      const n = modules.salience.recomputeAll(scope)
      const pruned = modules.salience.pruneAccessLog(90)
      steps.push(log('salience', { recomputed: n, accessLogPruned: pruned }))
      if (db) recordMeta(db, 'last_salience')
    } catch (e) {
      steps.push(log('salience_error', { error: (e as Error).message }))
    }
  }

  // 2. Pruner
  if (modules.pruner) {
    try {
      const cands = modules.pruner.analyze(scope)
      const marked = cands.length ? modules.pruner.mark(cands) : 0
      const byReason: Record<string, number> = {}
      for (const c of cands) byReason[c.reason] = (byReason[c.reason] || 0) + 1
      steps.push(log('prune', { marked, byReason }))
      if (db) recordMeta(db, 'last_prune')
    } catch (e) {
      steps.push(log('prune_error', { error: (e as Error).message }))
    }
  }

  // 3. Embeddings
  if (modules.embeddings) {
    try {
      const r = await modules.embeddings.embedNew(scope)
      steps.push(log('embeddings', r))
      if (db) recordMeta(db, 'last_embeddings')
    } catch (e) {
      steps.push(log('embeddings_error', { error: (e as Error).message }))
    }
  }

  // 4. Insular health check
  let health: HealthReport = {
    overall: 'green',
    checks: [],
    timestamp: Date.now(),
  }
  if (modules.insular) {
    try {
      health = modules.insular.fullReport(scope)
      steps.push(log('insular', {
        overall: health.overall,
        checks: health.checks.map(c => ({ d: c.dimension, s: c.status })),
      }))
    } catch (e) {
      steps.push(log('insular_error', { error: (e as Error).message }))
    }
  }

  // 5. Replay (if today is replay day)
  if (modules.replay) {
    if (modules.replay.shouldRunToday()) {
      try {
        const r = await modules.replay.weeklyReplay(scope)
        steps.push(log('replay', r))
      } catch (e) {
        steps.push(log('replay_error', { error: (e as Error).message }))
      }
    } else {
      steps.push(log('replay_skip', { reason: 'not_replay_day' }))
    }
  }

  const elapsed = Date.now() - startTime
  steps.push(log('done', { elapsedMs: elapsed }))

  return { steps, health, elapsed }
}
