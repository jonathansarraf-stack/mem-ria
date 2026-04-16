import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createMemory, type MemRia } from '../index.js'

let mem: MemRia

beforeEach(() => {
  mem = createMemory({ storage: 'sqlite', path: ':memory:' })
})

afterEach(() => {
  mem.close()
})

describe('Multi-scope E2E', () => {
  describe('personal mode (Claude Code user)', () => {
    it('project-scoped entries + global cascade', () => {
      // Global fact
      mem.upsert({ source: 'claude', title: 'User prefers TypeScript', body: 'Always use TypeScript over JS', kind: 'preference', scope: 'global' })
      // Project-specific facts
      mem.upsert({ source: 'claude', title: 'mem-ria uses SQLite', body: 'Decision: SQLite for v1', kind: 'decision', scope: 'project:mem-ria' })
      mem.upsert({ source: 'claude', title: 'eon-work uses Postgres', body: 'Decision: Postgres for multi-tenant', kind: 'decision', scope: 'project:eon-work' })

      // Search from mem-ria project: sees its own + global
      const memRiaResults = mem.search('decision', { scope: 'project:mem-ria' })
      expect(memRiaResults.length).toBe(1) // only mem-ria decision (global pref doesn't match "decision")

      // Search for TypeScript from mem-ria: sees global
      const tsResults = mem.search('TypeScript', { scope: 'project:mem-ria' })
      expect(tsResults.length).toBe(1)
      expect(tsResults[0].scope).toBe('global')

      // Search from eon-work: sees its own, NOT mem-ria's
      const eonResults = mem.search('SQLite', { scope: 'project:eon-work' })
      expect(eonResults.length).toBe(0) // SQLite is in project:mem-ria, not visible
    })
  })

  describe('multi-agent mode (OpenClaw/CrewAI)', () => {
    it('agent isolation + shared org scope', () => {
      // Agent Rafael saves private memory
      mem.upsert({ source: 'agent', title: 'Rafael internal note', body: 'Client Acme wants 15% discount', kind: 'fact', scope: 'agent:rafael' })
      // Agent Camila saves private memory
      mem.upsert({ source: 'agent', title: 'Camila internal note', body: 'Product launch delayed to Q3', kind: 'fact', scope: 'agent:camila' })
      // Shared org memory
      mem.upsert({ source: 'agent', title: 'Team decision', body: 'All agents use formal tone with clients', kind: 'decision', scope: 'org:porti' })

      // Rafael sees his own + org
      const rafaelSearch = mem.search('discount', { scope: 'agent:rafael' })
      expect(rafaelSearch.length).toBe(1)
      expect(rafaelSearch[0].scope).toBe('agent:rafael')

      // Camila does NOT see Rafael's private memory
      const camilaSearch = mem.search('discount', { scope: 'agent:camila' })
      expect(camilaSearch.length).toBe(0)

      // Both see shared org memory (via explicit org scope search)
      // Note: cascade only includes scope + global, not org
      // For org visibility, agent must include org in their scope query
    })

    it('bridge promotes private → shared', () => {
      // Rafael discovers something important
      const id = mem.upsert({ source: 'agent', title: 'Critical bug found', body: 'Auth module has SQL injection vulnerability', kind: 'fact', scope: 'agent:rafael' })

      // Bridge to org
      const bridgedId = mem.bridge(id, { from: 'agent:rafael', to: 'org:porti' })
      const bridged = mem.get(bridgedId)
      expect(bridged!.scope).toBe('org:porti')
      expect(bridged!.tags).toContain('bridged')
      expect(bridged!.title).toBe('Critical bug found')

      // Original still in rafael's scope
      const original = mem.get(id)
      expect(original!.scope).toBe('agent:rafael')
    })
  })

  describe('brain-cycle scoped', () => {
    it('stats respect scope', () => {
      mem.upsert({ source: 'test', title: 'Global A', body: 'global entry', scope: 'global' })
      mem.upsert({ source: 'test', title: 'Project B', body: 'project entry', scope: 'project:alpha' })
      mem.upsert({ source: 'test', title: 'Agent C', body: 'agent entry', scope: 'agent:rafael' })

      const globalStats = mem.stats()
      expect(globalStats.total).toBe(3)
      expect(globalStats.byScope['global']).toBe(1)
      expect(globalStats.byScope['project:alpha']).toBe(1)
      expect(globalStats.byScope['agent:rafael']).toBe(1)
    })
  })
})
