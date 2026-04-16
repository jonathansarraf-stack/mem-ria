import type { MemRia } from '@mem-ria/core'
import type { LLMAdapter } from './llm.js'
import type Database from 'better-sqlite3'

export interface ProactiveEvent {
  title: string
  start: string
  end?: string
  attendees?: string[]
  description?: string
}

export interface ProactiveConfig {
  llm: LLMAdapter
  deliveryFn?: (briefing: string) => void
}

export interface Proactive {
  tick(opts: {
    events: ProactiveEvent[]
    scope?: string
  }): Promise<{ briefings: number; skipped: number }>
}

const BRIEFING_PROMPT = `You are a proactive briefing assistant. Given an upcoming event and relevant memory context, produce a concise briefing in the same language as the memories.

The briefing should:
- Summarize who the attendees are and any known context about them
- Highlight relevant past decisions, projects, or notes
- Be brief (3-8 lines) and actionable
- Output ONLY the briefing text, no JSON`

export function createProactive(
  mem: MemRia,
  config: ProactiveConfig,
): Proactive {
  const db = mem.store.raw() as Database.Database

  // Ensure dedup table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS proactive_fired (
      event_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      fired_at INTEGER NOT NULL,
      briefing TEXT,
      PRIMARY KEY (event_id, scope)
    )
  `)

  return {
    async tick(opts) {
      const scope = opts.scope ?? 'global'
      let briefings = 0
      let skipped = 0

      for (const event of opts.events) {
        // Build a stable event ID from title + start
        const eventId = `${event.title}::${event.start}`

        // Check dedup
        const fired = db
          .prepare(
            'SELECT 1 FROM proactive_fired WHERE event_id = ? AND scope = ?',
          )
          .get(eventId, scope)

        if (fired) {
          skipped++
          continue
        }

        // Gather relevant memories via search
        const queries = [
          event.title,
          ...(event.attendees ?? []).map((a) =>
            a.includes('@') ? a.split('@')[0] : a,
          ),
        ].filter(Boolean)

        const relevantIds = new Set<string>()
        for (const q of queries) {
          const hits = mem.search(q, { limit: 5, scope })
          for (const h of hits) relevantIds.add(h.id)
        }

        // Fetch memory details
        const memories: string[] = []
        for (const id of [...relevantIds].slice(0, 8)) {
          const entry = mem.get(id)
          if (entry) {
            memories.push(`- (${entry.source}) ${entry.title}`)
          }
        }

        // Build LLM input
        const userPrompt = [
          `Event: ${event.title}`,
          event.start ? `Time: ${event.start}` : '',
          event.attendees?.length
            ? `Attendees: ${event.attendees.join(', ')}`
            : '',
          event.description ? `Description: ${event.description}` : '',
          '',
          memories.length
            ? `Relevant memories:\n${memories.join('\n')}`
            : 'No relevant context found in memory.',
        ]
          .filter(Boolean)
          .join('\n')

        let briefingText: string
        try {
          briefingText = await config.llm.synthesize(
            BRIEFING_PROMPT,
            userPrompt,
            { maxTokens: 512 },
          )
        } catch (e) {
          console.warn('[mem-ria proactive] LLM synthesis failed for event:', event.title, (e as Error).message)
          skipped++
          continue
        }

        if (!briefingText?.trim()) {
          skipped++
          continue
        }

        // Record in dedup table
        db.prepare(
          'INSERT OR IGNORE INTO proactive_fired (event_id, scope, fired_at, briefing) VALUES (?, ?, ?, ?)',
        ).run(eventId, scope, Date.now(), briefingText.trim())

        // Deliver
        if (config.deliveryFn) {
          config.deliveryFn(briefingText.trim())
        }

        briefings++
      }

      return { briefings, skipped }
    },
  }
}
