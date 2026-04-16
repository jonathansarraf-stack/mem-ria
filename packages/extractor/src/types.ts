// @mem-ria/extractor — Type definitions

import type { LLMAdapter } from '@mem-ria/brain'

export interface ExtractorConfig {
  llm: LLMAdapter
  autoKinds?: string[]        // which kinds to extract (default: ['fact', 'decision', 'preference'])
  scope?: string              // scope for extracted entries
  minConfidence?: number      // threshold to save (default: 0.7)
  systemPrompt?: string       // override extraction prompt
}

export interface ExtractedFact {
  title: string
  body: string
  kind: string
  entity?: string
  tags: string[]
  confidence: number
  saved: boolean
  entryId?: string
}
