import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createMemory, type MemRia } from '@mem-ria/core'
import { Brain } from '../brain.js'
import { createSalience } from '../salience.js'
import { createPruner } from '../pruner.js'
import { createEntities } from '../entities.js'
import { createInsular } from '../insular.js'
import { noopAdapter } from '../llm.js'
import { noopEmbeddings } from '../embeddings-adapter.js'

let mem: MemRia

beforeEach(() => {
  mem = createMemory({ storage: 'sqlite', path: ':memory:' })
  // Seed some data
  mem.upsert({ source: 'test', title: 'Architecture Decision', body: 'We chose SQLite over Postgres for MVP', kind: 'decision', tags: ['architecture', 'decision'], entity: 'mem-ria' })
  mem.upsert({ source: 'test', title: 'Beatriz is PM', body: 'Beatriz Yamamoto is the product manager for Porti', kind: 'person', entity: 'Beatriz' })
  mem.upsert({ source: 'test', title: 'Daily standup', body: 'ok valeu', kind: 'note' })
  mem.upsert({ source: 'test', title: 'Important fact', body: 'The company revenue grew 30% this quarter which is important for planning', kind: 'fact', tags: ['importante'] })
})

afterEach(() => {
  mem.close()
})

describe('Brain facade', () => {
  it('instantiates with all modules when adapters explicitly provided', () => {
    const brain = new Brain(mem, { llm: noopAdapter(), embeddingAdapter: noopEmbeddings() })
    expect(brain.salience).toBeTruthy()
    expect(brain.pruner).toBeTruthy()
    expect(brain.entities).toBeTruthy()
    expect(brain.insular).toBeTruthy()
    // SDK users who pass adapters explicitly bypass license gate
    expect(brain.replay).toBeTruthy()
    expect(brain.consolidator).toBeTruthy()
    expect(brain.embeddings).toBeTruthy()
    expect(brain.proactive).toBeTruthy()
  })

  it('instantiates without LLM (replay/consolidator/proactive are null)', () => {
    const brain = new Brain(mem)
    expect(brain.salience).toBeTruthy()
    expect(brain.pruner).toBeTruthy()
    expect(brain.replay).toBeNull()
    expect(brain.consolidator).toBeNull()
    expect(brain.proactive).toBeNull()
  })

  it('runs a full cycle', async () => {
    const brain = new Brain(mem, { llm: noopAdapter(), embeddingAdapter: noopEmbeddings() })
    const report = await brain.cycle()
    expect(report.steps.length).toBeGreaterThan(0)
    expect(report.elapsed).toBeGreaterThanOrEqual(0)
    expect(report.health).toBeTruthy()
    expect(report.health.overall).toBeTruthy()
    // Should have at least salience, prune, insular, done steps
    const stepNames = report.steps.map(s => s.step)
    expect(stepNames).toContain('salience')
    expect(stepNames).toContain('done')
  })

  it('health() returns a report', () => {
    const brain = new Brain(mem)
    const health = brain.health()
    expect(health.overall).toBeTruthy()
    expect(health.checks.length).toBeGreaterThan(0)
    expect(health.timestamp).toBeGreaterThan(0)
  })

  it('start/stop scheduler', async () => {
    const brain = new Brain(mem, { schedule: { cycle: 100000 } })
    brain.start()
    expect(() => brain.start()).not.toThrow() // idempotent
    brain.stop()
    brain.stop() // idempotent
  })
})

describe('Salience', () => {
  it('recomputes all and changes scores', () => {
    const salience = createSalience(mem)
    const count = salience.recomputeAll()
    expect(count).toBe(4) // 4 entries seeded

    const dist = salience.distribution()
    expect(dist.buckets.length).toBeGreaterThan(0)
    expect(dist.top.length).toBeGreaterThan(0)
  })

  it('decision kind scores higher than note', () => {
    const salience = createSalience(mem)
    salience.recomputeAll()
    const dist = salience.distribution()
    const decision = dist.top.find(t => t.title === 'Architecture Decision')
    const note = dist.top.find(t => t.title === 'Daily standup')
    if (decision && note) {
      expect(decision.salience).toBeGreaterThan(note.salience)
    }
  })

  it('logAccess records access', () => {
    const salience = createSalience(mem)
    const entries = mem.search('Architecture')
    expect(entries.length).toBeGreaterThan(0)
    const logged = salience.logAccess([entries[0].id], 'test')
    expect(logged).toBe(1)
  })
})

describe('Pruner', () => {
  it('detects noise entries', () => {
    const pruner = createPruner(mem)
    expect(pruner.isNoise('ok')).toBe(true)
    expect(pruner.isNoise('valeu')).toBe(true)
    expect(pruner.isNoise('kkkkk')).toBe(true)
    expect(pruner.isNoise('This is a meaningful sentence')).toBe(false)
  })

  it('analyzes and finds prune candidates', () => {
    const pruner = createPruner(mem)
    const candidates = pruner.analyze()
    // "ok valeu" should be a candidate (noise or too short)
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.some(c => c.reason === 'noise_pattern' || c.reason === 'body_too_short')).toBe(true)
  })

  it('salience protects important entries', () => {
    const salience = createSalience(mem)
    salience.recomputeAll()
    const pruner = createPruner(mem, { salienceProtect: 0.1 }) // low threshold
    const report = pruner.report()
    // Some entries should be protected by salience
    // (decision and important fact should have salience > 0.1)
    expect(report.protected_by_salience).toBeTruthy()
  })
})

describe('Entities', () => {
  it('creates and finds entities', () => {
    const entities = createEntities(mem)
    entities.upsertEntity({ canonicalName: 'Beatriz Yamamoto', type: 'person', aliases: ['Beatriz', 'Bia'] })

    const list = entities.list()
    expect(list.length).toBeGreaterThan(0)
    expect(list.find(e => e.canonicalName === 'Beatriz Yamamoto')).toBeTruthy()
  })

  it('findMentions detects names in text', () => {
    const entities = createEntities(mem)
    entities.upsertEntity({ canonicalName: 'Beatriz', type: 'person', aliases: ['Bia'] })

    const mentions = entities.findMentions('Talked to Bia about the project')
    expect(mentions.length).toBeGreaterThan(0)
    expect(mentions[0].canonicalName).toBe('Beatriz')
  })

  it('backfillMentions processes existing entries', () => {
    const entities = createEntities(mem)
    entities.upsertEntity({ canonicalName: 'Beatriz', type: 'person', aliases: ['Beatriz Yamamoto'] })

    const result = entities.backfillMentions()
    expect(result.processed).toBeGreaterThan(0)
  })
})

describe('Insular', () => {
  it('produces a health report', () => {
    const insular = createInsular(mem)
    const report = insular.fullReport()
    expect(report.overall).toBeTruthy()
    expect(['green', 'yellow', 'red']).toContain(report.overall)
    expect(report.checks.length).toBeGreaterThan(0)
  })

  it('checkIngestion detects entries', () => {
    const insular = createInsular(mem)
    const check = insular.checkIngestion()
    expect(check.last24h).toBeGreaterThan(0) // we just inserted entries
  })
})
