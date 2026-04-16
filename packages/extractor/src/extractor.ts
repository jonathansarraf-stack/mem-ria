// @mem-ria/extractor — Auto-extract facts from agent conversations

import crypto from 'node:crypto'
import type { MemRia, UpsertInput, MemoryKind } from '@mem-ria/core'
import type { LLMAdapter } from '@mem-ria/brain'
import type { ExtractorConfig, ExtractedFact } from './types.js'

const DEFAULT_KINDS = ['fact', 'decision', 'preference']
const DEFAULT_MIN_CONFIDENCE = 0.7

const DEFAULT_SYSTEM_PROMPT = `You are a memory extraction system. Analyze the conversation and extract factual information worth remembering permanently.

EXTRACT:
- Factual information (names, dates, numbers, relationships)
- Decisions made during the conversation
- User preferences and patterns
- Important context about projects, people, or organizations

DO NOT EXTRACT:
- Greetings, small talk, or filler
- Opinions or speculation
- Questions without answers
- Information that is purely transient

For each extracted fact, provide:
- title: short label (max 80 chars)
- body: the factual content (1-2 sentences)
- kind: one of "fact", "decision", "preference"
- entity: primary person/project/org mentioned (or null)
- tags: 1-3 relevant keywords
- confidence: 0-1 how certain this is worth remembering

Respond ONLY with a JSON array of extracted facts. If nothing worth remembering, return [].
Example: [{"title":"CEO preference","body":"Prefers async communication over meetings","kind":"preference","entity":"Jonathan","tags":["communication"],"confidence":0.9}]`

interface RawFact {
  title?: string
  body?: string
  kind?: string
  entity?: string | null
  tags?: string[]
  confidence?: number
}

/**
 * Compute content hash matching @mem-ria/core's dedup logic.
 */
function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

export class Extractor {
  private _mem: MemRia
  private _llm: LLMAdapter
  private _kinds: string[]
  private _scope: string | undefined
  private _minConfidence: number
  private _systemPrompt: string
  /** Content hashes already saved by this instance — prevents cross-call dups */
  private _seen: Set<string>

  constructor(mem: MemRia, config: ExtractorConfig) {
    this._mem = mem
    this._llm = config.llm
    this._kinds = config.autoKinds ?? DEFAULT_KINDS
    this._scope = config.scope
    this._minConfidence = config.minConfidence ?? DEFAULT_MIN_CONFIDENCE
    this._systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
    this._seen = new Set()
  }

  /**
   * Process a single user/agent exchange and extract facts.
   */
  async process(input: {
    userMessage: string
    agentResponse: string
    agentId?: string
    metadata?: Record<string, unknown>
  }): Promise<ExtractedFact[]> {
    const userContent = [
      'USER MESSAGE:',
      input.userMessage,
      '',
      'AGENT RESPONSE:',
      input.agentResponse,
    ].join('\n')

    const rawText = await this._llm.synthesize(this._systemPrompt, userContent, { maxTokens: 1024 })
    const rawFacts = parseJsonFromResponse(rawText)

    return this._saveFacts(rawFacts, input.agentId)
  }

  /**
   * Process a batch of messages and extract facts.
   */
  async processBatch(
    messages: Array<{ role: 'user' | 'agent'; content: string }>,
  ): Promise<ExtractedFact[]> {
    const transcript = messages
      .map((m) => `${m.role === 'user' ? 'USER' : 'AGENT'}: ${m.content}`)
      .join('\n')

    const rawText = await this._llm.synthesize(this._systemPrompt, transcript, { maxTokens: 1024 })
    const rawFacts = parseJsonFromResponse(rawText)

    return this._saveFacts(rawFacts)
  }

  /**
   * Common logic: normalize, filter, dedup, save.
   */
  private _saveFacts(rawFacts: RawFact[], agentId?: string): ExtractedFact[] {
    const results: ExtractedFact[] = []

    for (const raw of rawFacts) {
      const fact = this._normalize(raw, agentId)
      if (!fact) continue

      // Confidence filter
      if (fact.confidence < this._minConfidence) {
        results.push({ ...fact, saved: false })
        continue
      }

      // Kind filter
      if (!this._kinds.includes(fact.kind)) {
        results.push({ ...fact, saved: false })
        continue
      }

      // Content-hash dedup (mirrors core's sha256 of `title|body`)
      const hash = sha256(`${fact.title}|${fact.body}`.slice(0, 2000))
      if (this._seen.has(hash)) {
        results.push({ ...fact, saved: false })
        continue
      }

      const upsertInput: UpsertInput = {
        source: 'extractor',
        sourceId: agentId ? `extractor:${agentId}` : undefined,
        title: fact.title,
        body: fact.body,
        kind: fact.kind as MemoryKind,
        tags: fact.tags,
        entity: fact.entity,
        scope: this._scope,
      }

      const entryId = this._mem.upsert(upsertInput)
      this._seen.add(hash)
      results.push({ ...fact, saved: true, entryId })
    }

    return results
  }

  /**
   * Normalize a raw extracted fact into our shape.
   */
  private _normalize(raw: RawFact, agentId?: string): ExtractedFact | null {
    if (!raw.title || !raw.body) return null

    const tags = Array.isArray(raw.tags) ? raw.tags.map(String) : []
    if (agentId && !tags.includes(agentId)) {
      tags.push(agentId)
    }

    return {
      title: String(raw.title).slice(0, 200),
      body: String(raw.body).slice(0, 2000),
      kind: raw.kind && DEFAULT_KINDS.includes(raw.kind) ? raw.kind : 'fact',
      entity: raw.entity ? String(raw.entity) : undefined,
      tags,
      confidence: typeof raw.confidence === 'number' ? raw.confidence : 0.5,
      saved: false,
    }
  }
}

/**
 * Parse JSON array from LLM response. Handles:
 * - Raw JSON array
 * - JSON wrapped in markdown code blocks
 * - JSON object with a top-level array field
 */
function parseJsonFromResponse(text: string): RawFact[] {
  const trimmed = text.trim()

  // Try direct parse first
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed
    // Handle { memories: [...] } or { facts: [...] } wrapper
    for (const key of Object.keys(parsed)) {
      if (Array.isArray(parsed[key])) return parsed[key]
    }
    return []
  } catch {
    // Not direct JSON — try extracting from markdown code block
  }

  // Extract from ```json ... ``` or ``` ... ```
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim())
      if (Array.isArray(parsed)) return parsed
      for (const key of Object.keys(parsed)) {
        if (Array.isArray(parsed[key])) return parsed[key]
      }
    } catch {
      // fall through
    }
  }

  // Last resort: find first [ ... ] in text
  const arrayMatch = trimmed.match(/\[[\s\S]*\]/)
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0])
    } catch {
      // give up
    }
  }

  return []
}
