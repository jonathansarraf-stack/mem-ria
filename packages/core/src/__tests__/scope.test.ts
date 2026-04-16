import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createMemory, type MemRia } from '../index.js'

let mem: MemRia

beforeEach(() => {
  mem = createMemory({ storage: 'sqlite', path: ':memory:' })
})

afterEach(() => {
  mem.close()
})

describe('scope isolation', () => {
  it('entries in different scopes are isolated', () => {
    mem.upsert({ source: 'test', title: 'Project A fact', body: 'Secret knowledge about project A', scope: 'project:alpha' })
    mem.upsert({ source: 'test', title: 'Project B fact', body: 'Secret knowledge about project B', scope: 'project:beta' })

    const resultsA = mem.search('Secret knowledge', { scope: 'project:alpha' })
    expect(resultsA.length).toBe(1)
    expect(resultsA[0].title).toBe('Project A fact')

    const resultsB = mem.search('Secret knowledge', { scope: 'project:beta' })
    expect(resultsB.length).toBe(1)
    expect(resultsB[0].title).toBe('Project B fact')
  })

  it('global entries are visible from any scope', () => {
    mem.upsert({ source: 'test', title: 'Global fact', body: 'Universal knowledge shared everywhere', scope: 'global' })
    mem.upsert({ source: 'test', title: 'Scoped fact', body: 'Universal knowledge for project only', scope: 'project:alpha' })

    const results = mem.search('Universal knowledge', { scope: 'project:alpha' })
    expect(results.length).toBe(2) // both global and project:alpha
  })

  it('scoped entries are NOT visible from other scopes', () => {
    mem.upsert({ source: 'test', title: 'Agent Rafael memory', body: 'Private info from Rafael agent', scope: 'agent:rafael' })

    const results = mem.search('Private info', { scope: 'agent:camila' })
    expect(results.length).toBe(0) // camila can't see rafael's memories
  })
})

describe('bridge', () => {
  it('copies an entry from one scope to another', () => {
    const id = mem.upsert({ source: 'test', title: 'Important discovery', body: 'Found a critical bug in auth module', scope: 'agent:rafael' })

    const bridgedId = mem.bridge(id, { from: 'agent:rafael', to: 'org:team' })
    expect(bridgedId).toBeTruthy()

    const bridged = mem.get(bridgedId)
    expect(bridged).toBeTruthy()
    expect(bridged!.scope).toBe('org:team')
    expect(bridged!.title).toBe('Important discovery')
    expect(bridged!.tags).toContain('bridged')
  })

  it('throws if entry scope does not match from', () => {
    const id = mem.upsert({ source: 'test', title: 'X', body: 'Y', scope: 'agent:rafael' })
    expect(() => mem.bridge(id, { from: 'agent:camila', to: 'global' })).toThrow()
  })
})
