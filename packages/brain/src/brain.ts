// @mem-ria/brain — Brain facade class
// Composes all brain modules into a single interface with scheduling

import type { MemRia } from '@mem-ria/core'
import { createSalience, type Salience, type SalienceConfig } from './salience.js'
import { createPruner, type Pruner, type PrunerConfig } from './pruner.js'
import { createEntities, type Entities, type EntitiesConfig } from './entities.js'
import { createReplay, type Replay, type ReplayConfig } from './replay.js'
import { createInsular, type Insular, type InsularConfig, type HealthReport } from './insular.js'
import { createConsolidator, type Consolidator, type ConsolidatorConfig } from './consolidator.js'
import { createEmbeddings, type Embeddings, type EmbeddingsConfig } from './embeddings.js'
import { createProactive, type Proactive, type ProactiveConfig } from './proactive.js'
import { runCycle, type CycleReport } from './cycle.js'
import type { LLMAdapter } from './llm.js'
import type { EmbeddingAdapter } from './embeddings-adapter.js'

export interface BrainConfig {
  llm?: LLMAdapter
  embeddingAdapter?: EmbeddingAdapter
  salience?: SalienceConfig
  pruner?: PrunerConfig
  entities?: EntitiesConfig
  replay?: Omit<ReplayConfig, 'llm'> & { llm?: LLMAdapter }
  insular?: InsularConfig
  consolidator?: Omit<ConsolidatorConfig, 'llm'> & { llm?: LLMAdapter }
  embeddings?: Omit<EmbeddingsConfig, 'adapter'> & { adapter?: EmbeddingAdapter }
  proactive?: Omit<ProactiveConfig, 'llm'> & { llm?: LLMAdapter }
  schedule?: {
    cycle?: string | number  // interval in ms or 'daily' | 'hourly'
    replay?: string          // 'weekly' | 'daily'
  }
  connectorScanFn?: (scope?: string) => Promise<{ count: number }>
}

function parseScheduleInterval(schedule?: string | number): number | null {
  if (!schedule) return null
  if (typeof schedule === 'number') return schedule
  if (schedule === 'hourly') return 60 * 60 * 1000
  if (schedule === 'daily') return 24 * 60 * 60 * 1000
  return null
}

export class Brain {
  readonly salience: Salience
  readonly pruner: Pruner
  readonly entities: Entities
  readonly replay: Replay | null
  readonly insular: Insular
  readonly consolidator: Consolidator | null
  readonly embeddings: Embeddings | null
  readonly proactive: Proactive | null

  private _mem: MemRia
  private _config: BrainConfig
  private _timer: ReturnType<typeof setInterval> | null = null

  constructor(mem: MemRia, config: BrainConfig = {}) {
    this._mem = mem
    this._config = config

    this.salience = createSalience(mem, config.salience)
    this.pruner = createPruner(mem, config.pruner)
    this.entities = createEntities(mem, config.entities)
    this.insular = createInsular(mem, config.insular)

    // Modules that need LLM
    const llm = config.llm
    this.replay = llm
      ? createReplay(mem, { llm, ...config.replay })
      : config.replay?.llm
        ? createReplay(mem, { llm: config.replay.llm, ...config.replay })
        : null

    this.consolidator = llm
      ? createConsolidator(mem, { llm, ...config.consolidator })
      : config.consolidator?.llm
        ? createConsolidator(mem, { llm: config.consolidator.llm, ...config.consolidator })
        : null

    this.proactive = llm
      ? createProactive(mem, { llm, ...config.proactive })
      : config.proactive?.llm
        ? createProactive(mem, { llm: config.proactive.llm, ...config.proactive })
        : null

    // Modules that need embedding adapter
    const embAdapter = config.embeddingAdapter
    this.embeddings = embAdapter
      ? createEmbeddings(mem, { adapter: embAdapter, ...config.embeddings })
      : config.embeddings?.adapter
        ? createEmbeddings(mem, { adapter: config.embeddings.adapter, ...config.embeddings })
        : null
  }

  async cycle(scope?: string): Promise<CycleReport> {
    return runCycle(
      {
        salience: this.salience,
        pruner: this.pruner,
        entities: this.entities,
        replay: this.replay || undefined,
        insular: this.insular,
        consolidator: this.consolidator || undefined,
        embeddings: this.embeddings || undefined,
        connectorScanFn: this._config.connectorScanFn,
        mem: this._mem,
      },
      scope
    )
  }

  health(scope?: string): HealthReport {
    return this.insular.fullReport(scope)
  }

  start(): void {
    if (this._timer) return
    const interval = parseScheduleInterval(this._config.schedule?.cycle) || 24 * 60 * 60 * 1000
    this._timer = setInterval(() => {
      this.cycle().catch((e) => console.error('[mem-ria brain] cycle error:', e))
    }, interval)
    // Don't block Node.js from exiting
    if (this._timer && typeof this._timer === 'object' && 'unref' in this._timer) {
      this._timer.unref()
    }
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }
}
