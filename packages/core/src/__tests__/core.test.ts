import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createMemory, type MemRia } from '../index.js'

let mem: MemRia

beforeEach(() => {
  mem = createMemory({ storage: 'sqlite', path: ':memory:' })
})

afterEach(() => {
  mem.close()
})

describe('upsert + get', () => {
  it('creates an entry and retrieves it by id', () => {
    const id = mem.upsert({
      source: 'test',
      title: 'Test fact',
      body: 'This is a test memory entry',
      kind: 'fact',
      tags: ['test'],
    })
    expect(id).toBeTruthy()
    const entry = mem.get(id)
    expect(entry).toBeTruthy()
    expect(entry!.title).toBe('Test fact')
    expect(entry!.kind).toBe('fact')
    expect(entry!.tags).toEqual(['test'])
    expect(entry!.scope).toBe('global')
  })

  it('deduplicates by content hash', () => {
    const id1 = mem.upsert({ source: 'a', title: 'Same', body: 'Same content' })
    const id2 = mem.upsert({ source: 'b', title: 'Same', body: 'Same content' })
    expect(id1).toBe(id2) // same content hash → same entry
  })

  it('updates existing entry when source+sourceId match', () => {
    const id1 = mem.upsert({ source: 'test', sourceId: 'x1', title: 'V1', body: 'version 1' })
    const id2 = mem.upsert({ source: 'test', sourceId: 'x1', title: 'V2', body: 'version 2' })
    expect(id1).toBe(id2)
    expect(mem.get(id1)!.title).toBe('V2')
  })
})

describe('search', () => {
  it('finds entries by text', () => {
    mem.upsert({ source: 'test', title: 'Architecture decision', body: 'We chose SQLite over Postgres for the MVP' })
    mem.upsert({ source: 'test', title: 'Meeting notes', body: 'Discussed the roadmap for Q2' })

    const results = mem.search('SQLite')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].title).toBe('Architecture decision')
  })

  it('returns empty for no match', () => {
    mem.upsert({ source: 'test', title: 'Hello', body: 'World' })
    const results = mem.search('xyznonexistent')
    expect(results).toEqual([])
  })

  it('respects limit', () => {
    for (let i = 0; i < 10; i++) {
      mem.upsert({ source: 'test', title: `Item ${i}`, body: `Common keyword repeated item ${i}` })
    }
    const results = mem.search('Common keyword', { limit: 3 })
    expect(results.length).toBeLessThanOrEqual(3)
  })
})

describe('delete', () => {
  it('removes an entry', () => {
    const id = mem.upsert({ source: 'test', title: 'To delete', body: 'Gone soon' })
    expect(mem.get(id)).toBeTruthy()
    mem.delete(id)
    expect(mem.get(id)).toBeNull()
  })
})

describe('byEntity', () => {
  it('finds entries by entity name', () => {
    mem.upsert({ source: 'test', title: 'About Beatriz', body: 'She is a PM', entity: 'Beatriz' })
    mem.upsert({ source: 'test', title: 'About Rafael', body: 'He is a dev', entity: 'Rafael' })

    const results = mem.byEntity('Beatriz')
    expect(results.length).toBe(1)
    expect(results[0].entity).toBe('Beatriz')
  })
})

describe('stats', () => {
  it('counts entries by source and kind', () => {
    mem.upsert({ source: 'vault', title: 'A', body: 'aaa', kind: 'fact' })
    mem.upsert({ source: 'vault', title: 'B', body: 'bbb', kind: 'decision' })
    mem.upsert({ source: 'claude', title: 'C', body: 'ccc', kind: 'fact' })

    const s = mem.stats()
    expect(s.total).toBe(3)
    expect(s.bySource['vault']).toBe(2)
    expect(s.bySource['claude']).toBe(1)
    expect(s.byKind['fact']).toBe(2)
    expect(s.byKind['decision']).toBe(1)
  })
})
