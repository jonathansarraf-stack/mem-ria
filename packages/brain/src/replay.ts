/**
 * Replay Hipocampal — weekly memory consolidation via LLM synthesis.
 *
 * Port of Jarvis replay.js, generalized to use the LLMAdapter interface
 * instead of hardcoded Anthropic calls.
 *
 * Biology: during sleep the hippocampus replays sequences from the day
 * to the neocortex, creating stronger long-term memories. This module
 * does the same weekly: takes the top-N salient entries, groups by entity,
 * synthesizes each group with an LLM, and stores the result as a denser
 * second-order memory (source='replay', kind='fact').
 */

import type { MemRia } from '@mem-ria/core'
import type { LLMAdapter } from './llm.js'
import type Database from 'better-sqlite3'

// ── Public types ────────────────────────────────────────────────────────────

export interface ReplayConfig {
  llm: LLMAdapter
  topN?: number // default 30
  replayDay?: number // 0=sunday, default 0
  systemPrompt?: string
}

export interface Replay {
  weeklyReplay(
    scope?: string,
  ): Promise<{ entriesCreated: number; entitiesCovered: string[] }>
  shouldRunToday(): boolean
}

// ── Constants ───────────────────────────────────────────────────────────────

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000
const MIN_GROUP_SIZE = 2
const MIN_ENTRIES_FOR_REPLAY = 3
const DEFAULT_MIN_SALIENCE = 1.5

const DEFAULT_SYSTEM_PROMPT = `You are a memory synthesis assistant. You receive memory fragments about an entity and create a dense, actionable summary. Rules:
- Maximum 200 words
- Focus on facts, decisions, relationships, commitments — not ephemeral details
- Use present tense for current facts, past tense for completed events
- If there are contradictions between memories, briefly flag them
- Do not add information that is not in the fragments`

// ── Factory ─────────────────────────────────────────────────────────────────

export function createReplay(mem: MemRia, config: ReplayConfig): Replay {
  const db = mem.store.raw() as Database.Database
  const llm = config.llm
  const topN = config.topN ?? 30
  const replayDay = config.replayDay ?? 0 // sunday
  const systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT

  // ── shouldRunToday ────────────────────────────────────────────────────

  function shouldRunToday(): boolean {
    return new Date().getDay() === replayDay
  }

  // ── weeklyReplay ──────────────────────────────────────────────────────

  async function weeklyReplay(
    scope?: string,
  ): Promise<{ entriesCreated: number; entitiesCovered: string[] }> {
    const weekAgo = Date.now() - ONE_WEEK_MS

    // Build scope filter
    const scopeClause = scope ? `AND m.scope = ?` : ''
    const scopeArgs = scope ? [scope] : []

    // Top salient + recently accessed entries from the week, excluding prior replays
    const top = db
      .prepare(
        `SELECT m.id, m.source, m.title, m.body, m.kind, m.entity, m.salience, m.updated
         FROM memory_index m
         WHERE m.source != 'replay'
           AND m.salience >= ?
           AND (m.updated > ? OR m.id IN (
             SELECT memory_id FROM memory_access_log WHERE accessed_at > ?
           ))
           ${scopeClause}
         ORDER BY m.salience DESC
         LIMIT ?`,
      )
      .all(DEFAULT_MIN_SALIENCE, weekAgo, weekAgo, ...scopeArgs, topN) as Array<{
      id: string
      source: string
      title: string
      body: string
      kind: string
      entity: string | null
      salience: number
      updated: number
    }>

    if (top.length < MIN_ENTRIES_FOR_REPLAY) {
      return { entriesCreated: 0, entitiesCovered: [] }
    }

    // Group by entity (null -> '_general')
    const byEntity = new Map<string, typeof top>()
    for (const m of top) {
      const key = m.entity || '_general'
      const group = byEntity.get(key)
      if (group) {
        group.push(m)
      } else {
        byEntity.set(key, [m])
      }
    }

    let entriesCreated = 0
    const entitiesCovered: string[] = []

    for (const [entity, mems] of byEntity) {
      if (mems.length < MIN_GROUP_SIZE) continue

      const displayName = entity === '_general' ? 'General context' : entity

      // Build context for LLM
      const context = mems
        .map(
          (m, i) =>
            `[${i + 1}] (${m.source}/${m.kind}) ${m.title}\n${(m.body || '').slice(0, 600)}`,
        )
        .join('\n\n---\n\n')

      const userPrompt = `Synthesize what is known about "${displayName}" based on these ${mems.length} memory fragments:\n\n${context}`

      let synthesis: string
      try {
        synthesis = await llm.synthesize(systemPrompt, userPrompt, {
          maxTokens: 400,
        })
      } catch {
        continue // LLM failed for this group, skip
      }

      if (!synthesis) continue

      const weekLabel = new Date().toISOString().slice(0, 10)

      mem.upsert({
        source: 'replay',
        sourceId: `weekly-${entity}-${weekLabel}`,
        title: `Weekly synthesis - ${displayName} - ${weekLabel}`,
        body: `**Hippocampal replay** -- synthesis of ${mems.length} memories (salience >= ${DEFAULT_MIN_SALIENCE})\n\n${synthesis}`,
        kind: 'fact',
        tags: ['replay', 'synthesis', 'weekly', entity],
        entity: entity === '_general' ? undefined : entity,
        scope,
      })

      entriesCreated++
      entitiesCovered.push(displayName)
    }

    return { entriesCreated, entitiesCovered }
  }

  return { weeklyReplay, shouldRunToday }
}
