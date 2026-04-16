import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createMemory, type MemRia } from '@mem-ria/core'
import { type LLMAdapter } from '@mem-ria/brain'
import { Extractor } from '../extractor.js'

// ── Mock LLM helpers ────────────────────────────────────────────────────────

function mockLLM(response: string): LLMAdapter {
  return {
    async synthesize(_system: string, _user: string) {
      return response
    },
  }
}

const TWO_FACTS_RESPONSE = JSON.stringify([
  {
    title: 'Jonathan is CEO of Porti',
    body: 'Jonathan Sarraf is the CEO and founder of Porti, a tech company.',
    kind: 'fact',
    entity: 'Jonathan',
    tags: ['porti', 'ceo'],
    confidence: 0.95,
  },
  {
    title: 'Prefers async communication',
    body: 'Jonathan prefers async communication over meetings whenever possible.',
    kind: 'preference',
    entity: 'Jonathan',
    tags: ['communication'],
    confidence: 0.85,
  },
])

const MIXED_CONFIDENCE_RESPONSE = JSON.stringify([
  {
    title: 'Uses Claude Code daily',
    body: 'Jonathan uses Claude Code as his primary development tool.',
    kind: 'fact',
    entity: 'Jonathan',
    tags: ['tooling'],
    confidence: 0.9,
  },
  {
    title: 'Maybe likes coffee',
    body: 'Jonathan might prefer coffee, mentioned it once.',
    kind: 'preference',
    entity: 'Jonathan',
    tags: ['food'],
    confidence: 0.3,
  },
])

const EMPTY_RESPONSE = JSON.stringify([])

const MARKDOWN_WRAPPED_RESPONSE = `Here are the extracted facts:

\`\`\`json
[
  {
    "title": "Team uses TypeScript",
    "body": "The engineering team standardized on TypeScript for all projects.",
    "kind": "decision",
    "entity": "Porti",
    "tags": ["typescript", "engineering"],
    "confidence": 0.88
  }
]
\`\`\`
`

// ── Tests ───────────────────────────────────────────────────────────────────

let mem: MemRia

beforeEach(() => {
  mem = createMemory({ storage: 'sqlite', path: ':memory:' })
})

afterEach(() => {
  mem.close()
})

describe('Extractor', () => {
  it('extracts and saves facts from a conversation', async () => {
    const ext = new Extractor(mem, { llm: mockLLM(TWO_FACTS_RESPONSE) })

    const results = await ext.process({
      userMessage: 'I am Jonathan, CEO of Porti. I prefer async communication.',
      agentResponse: 'Nice to meet you Jonathan! Noted your preferences.',
    })

    expect(results).toHaveLength(2)
    expect(results[0].saved).toBe(true)
    expect(results[0].entryId).toBeTruthy()
    expect(results[0].title).toBe('Jonathan is CEO of Porti')
    expect(results[1].saved).toBe(true)
    expect(results[1].kind).toBe('preference')

    // Verify actually stored in memory via get
    const entry = mem.get(results[0].entryId!)
    expect(entry).toBeTruthy()
    expect(entry!.title).toBe('Jonathan is CEO of Porti')
  })

  it('filters facts below confidence threshold', async () => {
    const ext = new Extractor(mem, {
      llm: mockLLM(MIXED_CONFIDENCE_RESPONSE),
      minConfidence: 0.7,
    })

    const results = await ext.process({
      userMessage: 'I use Claude Code every day. Maybe I like coffee.',
      agentResponse: 'Great!',
    })

    expect(results).toHaveLength(2)

    const saved = results.filter((r) => r.saved)
    const notSaved = results.filter((r) => !r.saved)
    expect(saved).toHaveLength(1)
    expect(saved[0].title).toBe('Uses Claude Code daily')
    expect(notSaved).toHaveLength(1)
    expect(notSaved[0].title).toBe('Maybe likes coffee')
    expect(notSaved[0].confidence).toBe(0.3)
  })

  it('deduplicates — same fact twice is only saved once', async () => {
    const ext = new Extractor(mem, { llm: mockLLM(TWO_FACTS_RESPONSE) })

    const first = await ext.process({
      userMessage: 'I am Jonathan, CEO of Porti.',
      agentResponse: 'Noted.',
    })
    expect(first.filter((r) => r.saved)).toHaveLength(2)

    // Process same conversation again
    const second = await ext.process({
      userMessage: 'I am Jonathan, CEO of Porti.',
      agentResponse: 'Noted.',
    })
    // Both should be deduped (not saved again)
    expect(second.filter((r) => r.saved)).toHaveLength(0)
  })

  it('returns empty array for trivial conversation', async () => {
    const ext = new Extractor(mem, { llm: mockLLM(EMPTY_RESPONSE) })

    const results = await ext.process({
      userMessage: 'Hi!',
      agentResponse: 'Hello!',
    })

    expect(results).toHaveLength(0)
  })

  it('handles markdown-wrapped JSON response', async () => {
    const ext = new Extractor(mem, { llm: mockLLM(MARKDOWN_WRAPPED_RESPONSE) })

    const results = await ext.process({
      userMessage: 'We decided to use TypeScript everywhere.',
      agentResponse: 'Good decision, noted.',
    })

    expect(results).toHaveLength(1)
    expect(results[0].saved).toBe(true)
    expect(results[0].kind).toBe('decision')
    expect(results[0].title).toBe('Team uses TypeScript')
  })

  it('adds agentId to tags', async () => {
    const ext = new Extractor(mem, { llm: mockLLM(TWO_FACTS_RESPONSE) })

    const results = await ext.process({
      userMessage: 'I am CEO of Porti.',
      agentResponse: 'Got it.',
      agentId: 'jarvis',
    })

    for (const r of results.filter((r) => r.saved)) {
      expect(r.tags).toContain('jarvis')
    }
  })

  it('processBatch extracts from multi-message transcript', async () => {
    const ext = new Extractor(mem, { llm: mockLLM(TWO_FACTS_RESPONSE) })

    const results = await ext.processBatch([
      { role: 'user', content: 'I am Jonathan, CEO of Porti.' },
      { role: 'agent', content: 'Nice to meet you!' },
      { role: 'user', content: 'I prefer async communication.' },
      { role: 'agent', content: 'Noted.' },
    ])

    expect(results).toHaveLength(2)
    expect(results.filter((r) => r.saved)).toHaveLength(2)
  })
})
