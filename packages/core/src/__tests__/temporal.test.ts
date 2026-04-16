import { describe, it, expect } from 'vitest'
import { parseTemporalFilter } from '../store/sqlite.js'

describe('parseTemporalFilter', () => {
  it('parses "hoje" / "today"', () => {
    const r1 = parseTemporalFilter('decisões de hoje')
    expect(r1.label).toBe('hoje')
    expect(r1.from).toBeGreaterThan(0)
    expect(r1.cleaned).toBe('decisões de')

    const r2 = parseTemporalFilter('meetings today')
    expect(r2.label).toBe('hoje')
    expect(r2.from).toBeGreaterThan(0)
  })

  it('parses "ontem" / "yesterday"', () => {
    const r1 = parseTemporalFilter('o que aconteceu ontem')
    expect(r1.label).toBe('ontem')

    const r2 = parseTemporalFilter('what happened yesterday')
    expect(r2.label).toBe('ontem')
  })

  it('parses "essa semana" / "this week"', () => {
    const r = parseTemporalFilter('decisões essa semana')
    expect(r.label).toBe('esta semana')

    const r2 = parseTemporalFilter('decisions this week')
    expect(r2.label).toBe('esta semana')
  })

  it('parses "último mês" / "last month"', () => {
    const r = parseTemporalFilter('reuniões do último mês')
    expect(r.label).toBe('último mês')

    const r2 = parseTemporalFilter('meetings last month')
    expect(r2.label).toBe('último mês')
  })

  it('returns null for queries without temporal hints', () => {
    const r = parseTemporalFilter('architecture decisions')
    expect(r.from).toBeNull()
    expect(r.label).toBeNull()
    expect(r.cleaned).toBe('architecture decisions')
  })
})
