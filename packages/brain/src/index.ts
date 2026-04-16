// @mem-ria/brain — Brain modules

// Core modules
export { createSalience } from './salience.js'
export type { SalienceConfig, Salience, SalienceDistribution } from './salience.js'

export { createPruner } from './pruner.js'
export type { PrunerConfig, PruneCandidate, PruneReport, Pruner } from './pruner.js'

export { createEntities, markdownDirScanner } from './entities.js'
export type { EntitySource, EntitiesConfig, Entities } from './entities.js'

export { createReplay } from './replay.js'
export type { ReplayConfig, Replay } from './replay.js'

export { createInsular } from './insular.js'
export type { InsularCheck, InsularConfig, HealthReport, HealthStatus, Insular } from './insular.js'

export { createConsolidator } from './consolidator.js'
export type { Consolidator, ConsolidatorConfig } from './consolidator.js'

export { createEmbeddings } from './embeddings.js'
export type { Embeddings, EmbeddingsConfig } from './embeddings.js'

export { createProactive } from './proactive.js'
export type { Proactive, ProactiveConfig, ProactiveEvent } from './proactive.js'

// Adapters
export { anthropicAdapter, openaiAdapter, googleAdapter, customAdapter, noopAdapter } from './llm.js'
export type { LLMAdapter } from './llm.js'

export {
  openaiEmbeddings, geminiEmbeddings, voyageEmbeddings, customEmbeddings, noopEmbeddings,
} from './embeddings-adapter.js'
export type { EmbeddingAdapter } from './embeddings-adapter.js'

// Orchestration
export { runCycle } from './cycle.js'
export type { CycleReport, CycleStep, CycleModules } from './cycle.js'

// Brain facade
export { Brain } from './brain.js'
export type { BrainConfig } from './brain.js'
