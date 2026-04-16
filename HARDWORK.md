# Hard-Work: mem-ria — De Eon Core a Produto

**Objetivo:** Extrair os 15 módulos cerebrais do Jarvis (`/root/jarvis/memory/`), refatorar pra TypeScript modular, empacotar como monorepo publicável com MCP server + CLI + HTTP API. Resultado: qualquer pessoa usando Claude Code instala em 2 min e ganha um cérebro persistente. Multi-agent (OpenClaw etc.) funciona via HTTP API.

**Modo:** Hard-work autônomo, fase por fase. **Regra de ouro: só avança pra próxima phase se a anterior passar no gate de checagem.**

**Base:** `/root/jarvis/memory/*.js` (Eon Core pessoal) — 15 módulos, ~480 linhas no unified.js, ~175 no salience.js, ~107 no pruner.js, ~130 no entities.js, ~120 no replay.js, ~120 no insular.js, ~180 no connectors.js.

**Destino:** `/root/mem-ria/` — monorepo TypeScript.

---

## Regra de gates

Cada phase tem um **GATE** no final: um checklist de verificação obrigatória. O hard-work **NÃO avança** pra phase seguinte até todos os itens do gate estarem verdes. Se um gate falha, corrige ali mesmo antes de seguir. Isso evita acumular dívida técnica que quebra tudo depois.

```
Phase N → [GATE N: checklist] → ✅ tudo verde? → Phase N+1
                                → ❌ algo falhou? → corrige → re-testa gate
```

---

## Estado inicial

```
/root/jarvis/memory/
├── unified.js          (480 lines) — core: schema, upsert, scanners, FTS5, search, dedup
├── salience.js         (175 lines) — 7 sinais de importância
├── pruner.js           (107 lines) — poda com proteção por salience
├── entities.js         (130 lines) — entidades canônicas + mentions + alias resolution
├── replay.js           (120 lines) — síntese semanal via Anthropic Haiku
├── insular.js          (120 lines) — autodiagnóstico 6 dimensões
├── connectors.js       (180 lines) — Google Calendar, Gmail, Clawdio journal
├── consolidator.js     (150 lines) — merge episodic → semantic
├── embeddings.js       (100 lines) — OpenAI embeddings
├── semantic-embeddings.js (120 lines) — Gemini embedding + cosine search
├── proactive.js        (100 lines) — briefing antecipatório
├── multimodal.js       (150 lines) — image/audio/PDF ingest
├── vault-writer.js     (100 lines) — escreve de volta pro vault
├── semantic.js         (80 lines)  — semantic facts store
└── episodic.js         (60 lines)  — episodic turns store
```

**Problemas pra virar produto:**
1. Paths hardcoded (`/root/vault`, `/root/.claude/...`, `/opt/openclaw-web/...`)
2. JS puro, sem tipos exportados
3. Singletons com `require('./unified')` — não testável, não multi-instance
4. Scanners acoplados ao unified.js — mistura storage com ingestão
5. LLM hardcoded (Anthropic direto no replay.js)
6. Zero testes

---

## As 14 Phases

### Phase 1 · Monorepo setup

**Objetivo:** Criar a estrutura do monorepo com tooling pronto.

- [ ] `pnpm init` + `turbo.json` (turborepo)
- [ ] Workspaces: `packages/core`, `packages/brain`, `packages/connectors`, `packages/extractor`, `packages/mcp`, `packages/server`, `packages/cli`
- [ ] `tsconfig.base.json` com strict: true, target ES2022, moduleResolution bundler
- [ ] `tsconfig.json` por package estendendo base
- [ ] Vitest como test runner (config no root)
- [ ] Build com `tsup` (cada package gera ESM + CJS + types)
- [ ] `.gitignore`, `LICENSE` (MIT), `package.json` root
- [ ] Commit inicial

**GATE 1:**
- [ ] `pnpm install` roda sem erro
- [ ] `pnpm build` compila todos os packages (mesmo vazios) sem erro
- [ ] `pnpm test` roda sem erro (mesmo sem testes ainda)
- [ ] Cada package tem `package.json`, `tsconfig.json`, `src/index.ts` (pode ser export vazio)
- [ ] `git status` limpo após commit

**Estimativa:** 30 min.

---

### Phase 2 · @mem-ria/core — Storage + Memory CRUD

**Objetivo:** Portar o core do unified.js pra TypeScript com storage abstrato.

**Origem:** `unified.js` linhas 1-155 (schema, upsert, helpers) + linhas 348-478 (search, byEntity, stats)

- [ ] `packages/core/src/types.ts` — interfaces:
  ```typescript
  interface MemoryEntry {
    id: string
    source: string
    sourceId?: string
    title: string
    body: string
    kind: 'fact' | 'note' | 'doc' | 'decision' | 'journal' | 'person' | 'project' | 'preference'
    tags: string[]
    entity?: string
    scope: string              // 'global' | 'project:X' | 'agent:Y' | 'org:Z'
    created: number
    updated: number
    contentHash: string
    salience?: number
    shouldArchive?: boolean
    archiveReason?: string
  }

  interface SearchResult extends MemoryEntry {
    snippet?: string
    rank: number
    finalScore: number
    temporalLabel?: string
    semantic?: boolean
  }

  interface SearchOptions {
    limit?: number
    source?: string
    scope?: string
    noSemantic?: boolean
    noLog?: boolean
    context?: string
  }

  interface MemRiaConfig {
    storage: 'sqlite' | 'postgres'
    path?: string
    connectionString?: string
    scope?: string
  }

  interface StorageAdapter {
    upsert(entry: Partial<MemoryEntry>): string
    search(query: string, opts: SearchOptions): Promise<SearchResult[]>
    byEntity(name: string, scope?: string): MemoryEntry[]
    get(id: string): MemoryEntry | null
    delete(id: string): void
    stats(scope?: string): { total: number; bySource: Record<string, number> }
    raw(): unknown
  }
  ```
- [ ] `packages/core/src/store/sqlite.ts` — SQLiteAdapter implementando StorageAdapter
  - Schema: `memory_index` + `memory_fts` (FTS5) + `memory_embeddings` + `entities` + `mentions` + `memory_access_log` + `source_registry`
  - Porta: triggers FTS, upsert com dedup por content_hash, search com BM25 + decay + salience boost
  - Usa `better-sqlite3`
  - Factory function `createSQLiteStore(config)` — recebe path, sem hardcode
  - Scope support: `memory_index.scope TEXT DEFAULT 'global'` — filtro automático no search
- [ ] `packages/core/src/store/postgres.ts` — PostgresAdapter (stub). Joga erro: "Postgres adapter coming soon."
- [ ] `packages/core/src/memory.ts` — classe MemRia:
  ```typescript
  class MemRia {
    constructor(config: MemRiaConfig)
    upsert(entry: UpsertInput): string
    search(query: string, opts?: SearchOptions): Promise<SearchResult[]>
    byEntity(name: string): MemoryEntry[]
    get(id: string): MemoryEntry | null
    delete(id: string): void
    stats(): Stats
    bridge(entryId: string, opts: { from: string, to: string }): string
    get store(): StorageAdapter
  }
  ```
  - Porta: `parseTemporalFilter`, `decayScore`, `sha256`, `newId`
  - Temporal parsing bilíngue: EN + PT-BR
- [ ] `packages/core/src/index.ts` — export { MemRia, createMemory } + todos os types
- [ ] Testes unitários:
  - `core.test.ts`: upsert, get, delete, dedup por hash, search com BM25, byEntity, stats
  - `temporal.test.ts`: parseTemporalFilter com queries em EN e PT-BR
  - `scope.test.ts`: search filtra por scope, entries de scopes diferentes não vazam
  - `bridge.test.ts`: bridge copia entry de um scope pra outro

**GATE 2:**
- [ ] `pnpm build --filter core` compila sem erro
- [ ] `pnpm test --filter core` — TODOS os testes passam
- [ ] Verificação manual: cria instância em memória, upsert 3 entries, search retorna ordenado por score
- [ ] Verificação manual: upsert mesmo conteúdo 2x → retorna mesmo id (dedup funciona)
- [ ] Verificação manual: search com "hoje" filtra temporalmente
- [ ] Verificação manual: entry no scope A não aparece no search do scope B
- [ ] Types exportam corretamente: `import { MemRia, MemoryEntry } from '@mem-ria/core'` resolve

**Estimativa:** 2h.

---

### Phase 3 · @mem-ria/brain — Módulos cerebrais

**Objetivo:** Portar todos os módulos do Jarvis pra TypeScript com factory functions.

**Origem:** `salience.js`, `pruner.js`, `entities.js`, `replay.js`, `insular.js`, `consolidator.js`, `embeddings.js`, `semantic-embeddings.js`, `proactive.js`

**Arquitetura:** Cada módulo é uma factory function que recebe `MemRia` instance.

```typescript
export function createSalience(mem: MemRia, config?: SalienceConfig): Salience
export function createPruner(mem: MemRia, config?: PrunerConfig): Pruner
// etc.
```

**LLM adapter (compartilhado por replay, consolidator, proactive, extractor):**
```typescript
interface LLMAdapter {
  synthesize(system: string, user: string, opts?: { maxTokens?: number }): Promise<string>
}

export function anthropicAdapter(apiKey: string, model?: string): LLMAdapter
export function openaiAdapter(apiKey: string, model?: string): LLMAdapter
export function googleAdapter(apiKey: string, model?: string): LLMAdapter
export function customAdapter(fn: (system: string, user: string) => Promise<string>): LLMAdapter
```

**Embedding adapter (compartilhado por embeddings, semantic search):**
```typescript
interface EmbeddingAdapter {
  embed(text: string): Promise<number[]>
  dimensions: number
  model: string
}

export function openaiEmbeddings(apiKey: string, model?: string): EmbeddingAdapter
export function geminiEmbeddings(apiKey: string, model?: string): EmbeddingAdapter
export function voyageEmbeddings(apiKey: string, model?: string): EmbeddingAdapter
export function customEmbeddings(fn: (text: string) => Promise<number[]>, dim: number): EmbeddingAdapter
```

#### 3a. Salience (amígdala)
- [ ] `packages/brain/src/salience.ts`
- [ ] 7 sinais generalizados (sem hardcode de "Jonathan diary" ou "eon_strategic")
- [ ] `computeSalience(entry)`, `recomputeAll(scope?)`, `logAccess(ids, context)`, `distribution(scope?)`, `pruneAccessLog(maxDays)`
- [ ] Config com `kindWeights`, `importantTags`, `protectThreshold`, `boostSources`, `boostKinds`
- [ ] Testes: decision > note. logAccess aumenta score. protectThreshold funciona.

#### 3b. Pruner (poda sináptica)
- [ ] `packages/brain/src/pruner.ts`
- [ ] analyze, mark, apply, unmarkAll, report
- [ ] Config com `noisePatterns`, `minBodyLength`, `staleAfterDays`, `salienceProtect`, `protectedKinds`
- [ ] Testes: noise detecta "ok valeu". salience >= 3 protege. stale + 0 mentions = candidate.

#### 3c. Entities (córtex associativo)
- [ ] `packages/brain/src/entities.ts`
- [ ] upsertEntity, findMentions, backfillMentions
- [ ] EntitySource interface: `{ type, scan: () => Array<{ name, aliases?, filePath? }> }`
- [ ] Built-in: `markdownDirScanner(dir, type)`
- [ ] Testes: alias "Bia" → "Beatriz". findMentions detecta. backfill popula.

#### 3d. Replay (hipocampo)
- [ ] `packages/brain/src/replay.ts`
- [ ] weeklyReplay via LLMAdapter
- [ ] Config com `llm`, `topN`, `replayDay`, `systemPrompt`
- [ ] Testes: mock LLM → cria entry source='replay'. Agrupa por entidade.

#### 3e. Insular (autodiagnóstico)
- [ ] `packages/brain/src/insular.ts`
- [ ] 6 dimensões genéricas (ingestion, database, accessLog, embeddings, salience, lastCycle)
- [ ] InsularCheck interface pra custom checks
- [ ] alertFn callback quando red
- [ ] Testes: ingestion zero = red. tudo ok = green.

#### 3f. Consolidator (sono REM)
- [ ] `packages/brain/src/consolidator.ts`
- [ ] Consolida entries fragmentadas via LLMAdapter
- [ ] Testes: mock LLM, verifica merge.

#### 3g. Embeddings (Wernicke)
- [ ] `packages/brain/src/embeddings.ts`
- [ ] Multi-provider via EmbeddingAdapter
- [ ] semanticSearch com cosine similarity
- [ ] Fallback no search quando BM25 retorna poucos
- [ ] Testes: mock embeddings, storage + cosine search funciona.

#### 3h. Proactive (pré-frontal)
- [ ] `packages/brain/src/proactive.ts`
- [ ] Generalizado: recebe events como input, não hardcoded Google Calendar
- [ ] deliveryFn callback
- [ ] Testes: mock LLM + events → briefing gerado. Dedup funciona.

#### 3i. Cycle (orquestrador)
- [ ] `packages/brain/src/cycle.ts`
- [ ] Pipeline: connectors.scan → salience → pruner → embeddings → insular → replay (se dia certo)
- [ ] Logging JSON lines por step
- [ ] Config com `scopes`, `schedule`

#### 3j. Brain (facade)
- [ ] `packages/brain/src/index.ts` — classe Brain:
  ```typescript
  class Brain {
    salience: Salience
    pruner: Pruner
    entities: Entities
    replay: Replay
    insular: Insular
    consolidator: Consolidator
    embeddings: Embeddings
    proactive: Proactive

    constructor(mem: MemRia, config: BrainConfig)
    async cycle(scope?: string): Promise<CycleReport>
    health(scope?: string): HealthReport
    start(): void       // scheduler interno
    stop(): void
  }
  ```

**GATE 3:**
- [ ] `pnpm build --filter brain` compila sem erro
- [ ] `pnpm test --filter brain` — TODOS os testes passam
- [ ] Verificação manual: `new Brain(mem, config)` instancia sem erro com todos os módulos
- [ ] Verificação manual: `brain.cycle()` roda pipeline completo (com mock LLM) — cada step produz output
- [ ] Verificação manual: `brain.health()` retorna report com 6 dimensões, todas green
- [ ] Verificação manual: salience.recomputeAll() muda scores. pruner.analyze() acha candidates. entities.findMentions() detecta nomes.
- [ ] Verificação manual: `brain.start()` agenda ciclo sem crash — `brain.stop()` para limpo
- [ ] Importação limpa: `import { Brain, createSalience, createPruner } from '@mem-ria/brain'` resolve

**Estimativa:** 4-5h.

---

### Phase 4 · @mem-ria/connectors — Plugins de ingestão

**Objetivo:** Connectors plugáveis pra fontes de dados.

```typescript
interface Connector {
  name: string
  scan(mem: MemRia, config: Record<string, unknown>): Promise<{ count: number }>
}
```

#### 4a. claude-memory
- [ ] Scana `.claude/projects/*/memory/*.md` — porta `scanClaudeMemory()`
- [ ] Config: `{ basePath?: string }` default `~/.claude`

#### 4b. claude-md
- [ ] Scana `CLAUDE.md` em diretórios configurados ou auto-detecta via git repos
- [ ] kind='doc', tags=['claude-md']

#### 4c. markdown-vault
- [ ] Qualquer pasta de .md — porta `scanVaultObsidian()` generalizado
- [ ] Config: `{ path, kindMapping? }`

#### 4d. git-history
- [ ] Commits recentes de repos configurados
- [ ] Config: `{ repos, maxCommits?, since? }`

#### 4e. filesystem
- [ ] Watch genérico .md/.txt/.json
- [ ] Config: `{ paths, extensions?, watch? }`

#### 4f. ConnectorRegistry
- [ ] `register(connector)`, `scanAll()` em paralelo

**GATE 4:**
- [ ] `pnpm build --filter connectors` compila sem erro
- [ ] `pnpm test --filter connectors` — testes passam
- [ ] Verificação manual: `claudeMemoryConnector.scan(mem, { basePath: '/tmp/test-claude' })` ingere entries de um diretório mock com .md files
- [ ] Verificação manual: `markdownVaultConnector.scan(mem, { path: '/tmp/test-vault' })` ingere entries
- [ ] Verificação manual: `gitHistoryConnector.scan(mem, { repos: ['/root/mem-ria'] })` ingere commits
- [ ] Verificação manual: `registry.scanAll()` roda todos em paralelo sem crash
- [ ] Importação limpa: `import { claudeMemoryConnector, markdownVaultConnector } from '@mem-ria/connectors'`

**Estimativa:** 2h.

---

### Phase 5 · @mem-ria/extractor — Auto-extração de fatos (multi-agent)

**Objetivo:** Módulo que extrai fatos automaticamente de conversas agent↔user sem intervenção humana. Essencial pra multi-agent (OpenClaw, CrewAI) onde não tem um humano dizendo "lembra disso".

**Origem:** `agent-memory.js` do OpenClaw que já faz isso via Gemini Flash.

- [ ] `packages/extractor/src/index.ts`:
  ```typescript
  interface ExtractorConfig {
    llm: LLMAdapter
    autoKinds?: string[]        // quais kinds extrair (default: ['fact', 'decision', 'preference'])
    scope?: string              // scope pras entries extraídas
    minConfidence?: number      // threshold de confiança pra salvar (default: 0.7)
    systemPrompt?: string       // override do prompt de extração
  }

  class Extractor {
    constructor(mem: MemRia, config: ExtractorConfig)

    // Processa um par input/output e extrai fatos
    async process(input: {
      userMessage: string
      agentResponse: string
      agentId?: string
      metadata?: Record<string, unknown>
    }): Promise<ExtractedFact[]>

    // Processa batch de mensagens (ex: resumo de conversa)
    async processBatch(messages: Array<{
      role: 'user' | 'agent'
      content: string
    }>): Promise<ExtractedFact[]>
  }

  interface ExtractedFact {
    title: string
    body: string
    kind: string
    entity?: string
    tags: string[]
    confidence: number
    saved: boolean        // se passou do threshold e foi salvo
    entryId?: string      // id no mem-ria se salvo
  }
  ```
- [ ] Prompt de extração (LLM):
  ```
  Analise esta conversa e extraia fatos importantes.
  Retorne JSON array com: title, body, kind (fact|decision|preference|person|project), entity, tags, confidence (0-1).
  Regras:
  - Só extraia informação factual, não opiniões momentâneas
  - Decisões (kind=decision) precisam de confidence >= 0.8
  - Se não houver fatos relevantes, retorne array vazio
  - Dedup: se o fato é óbvio/trivial, não extraia
  ```
- [ ] Dedup automática: antes de salvar, verifica se já existe entry com content_hash similar
- [ ] Testes: mock LLM, verifica extração. Confidence abaixo do threshold não salva. Dedup funciona.

**GATE 5:**
- [ ] `pnpm build --filter extractor` compila sem erro
- [ ] `pnpm test --filter extractor` — testes passam
- [ ] Verificação manual: `extractor.process({ userMessage: "Fecha o deal com Acme por R$50k", agentResponse: "Registrado." })` → extrai fact com entity "Acme"
- [ ] Verificação manual: `extractor.process({ userMessage: "ok", agentResponse: "ok" })` → retorna array vazio (nada relevante)
- [ ] Verificação manual: processar mesma mensagem 2x → segunda vez não duplica (dedup)
- [ ] Importação limpa: `import { Extractor } from '@mem-ria/extractor'`

**Estimativa:** 1.5h.

---

### Phase 6 · @mem-ria/mcp — MCP Server

**Objetivo:** MCP server que dá tools de memória ao Claude Code (e qualquer client MCP).

**Dependência:** `@modelcontextprotocol/sdk`

- [ ] `packages/mcp/src/server.ts` — MCP server com 7 tools:

  | Tool | O que faz |
  |---|---|
  | `memory_search` | Busca com BM25 + salience + decay. Params: query, limit, scope |
  | `memory_save` | Salva fact/decision/preference. Params: title, body, kind, tags, entity, scope |
  | `memory_entities` | Lista entidades conhecidas. Params: type filter |
  | `memory_entity_detail` | Tudo sobre uma entidade. Params: name |
  | `brain_status` | Health report (insular). 6 dimensões. |
  | `brain_cycle` | Trigger manual do brain-cycle |
  | `memory_stats` | Stats: total, by source, by kind, salience distribution |

- [ ] **Auto-inject context (opção C):**
  - Resource `mem-ria://context` com top-N memórias relevantes pro projeto
  - `mem-ria init` adiciona instrução no CLAUDE.md:
    ```markdown
    # mem-ria
    You have access to a persistent memory brain via MCP tools.
    At the start of every conversation, call memory_search with the user's
    first message to retrieve relevant context before responding.
    Always save important decisions, facts, and preferences using memory_save.
    ```
  - `mem-ria init` configura o MCP server no `~/.claude/settings.json`

- [ ] **Scope detection:** detecta working directory via MCP `roots` → seta scope `project:<dir-name>` automaticamente

**GATE 6:**
- [ ] `pnpm build --filter mcp` compila sem erro
- [ ] `pnpm test --filter mcp` — testes passam (com MCP client mock)
- [ ] Verificação manual: MCP server sobe em modo stdio
- [ ] Verificação manual: client mock chama `memory_save` → entry aparece no brain.db
- [ ] Verificação manual: client mock chama `memory_search` → retorna entries ranqueados
- [ ] Verificação manual: client mock chama `brain_status` → retorna health report JSON
- [ ] Verificação manual: client mock chama `memory_entities` → retorna lista
- [ ] **Verificação real com Claude Code:** configurar MCP no settings.json, abrir conversa, Claude consegue chamar `memory_search` e recebe resultados
- [ ] Importação limpa: `import { createMCPServer } from '@mem-ria/mcp'`

**Estimativa:** 2-3h.

---

### Phase 7 · @mem-ria/cli — Interface de linha de comando

**Objetivo:** CLI global pra init, serve, search, status, cycle.

- [ ] `packages/cli/src/index.ts` com subcomandos:
  - `mem-ria init [--mode personal|multi-agent] [--agents a,b,c]`
  - `mem-ria serve [--http] [--port 3333]`
  - `mem-ria search <query> [--scope X] [--limit N] [--json]`
  - `mem-ria status`
  - `mem-ria cycle`
  - `mem-ria scan`
  - `mem-ria doctor`
  - `mem-ria config [key] [value]`
- [ ] `bin/mem-ria` shebang + entry
- [ ] `package.json` com `"bin": { "mem-ria": "./bin/mem-ria" }`

**GATE 7:**
- [ ] `pnpm build --filter cli` compila sem erro
- [ ] Verificação manual: `node packages/cli/dist/index.js init` cria `~/.mem-ria/config.json` + `brain.db`
- [ ] Verificação manual: `node packages/cli/dist/index.js scan` roda connectors e reporta entries ingeridas
- [ ] Verificação manual: `node packages/cli/dist/index.js search "test"` retorna resultados formatados
- [ ] Verificação manual: `node packages/cli/dist/index.js status` mostra health com cores no terminal
- [ ] Verificação manual: `node packages/cli/dist/index.js cycle` roda brain-cycle e reporta cada stage
- [ ] Verificação manual: `node packages/cli/dist/index.js doctor` verifica brain.db, MCP config, connectors
- [ ] Verificação manual: `node packages/cli/dist/index.js serve` sobe MCP server (stdio) sem crash
- [ ] Verificação manual: `node packages/cli/dist/index.js serve --http` sobe HTTP API na porta configurada

**Estimativa:** 2h.

---

### Phase 8 · @mem-ria/server — HTTP API + Agent auth

**Objetivo:** Server REST pra multi-agent e integrações externas. Inclui autenticação por agent.

- [ ] `packages/server/src/index.ts` — Hono server:
  ```
  POST   /api/memory              → upsert
  GET    /api/memory/search?q=    → search
  GET    /api/memory/:id          → get by id
  DELETE /api/memory/:id          → delete
  GET    /api/memory/stats        → stats

  POST   /api/memory/extract      → extractor (multi-agent: auto-extrai fatos de conversa)

  GET    /api/entities            → list entities
  GET    /api/entities/:name      → entity detail

  GET    /api/brain/health        → insular report
  POST   /api/brain/cycle         → trigger brain cycle
  GET    /api/brain/salience      → salience distribution

  GET    /healthz                 → liveness
  ```
- [ ] **Auth:** API key via `Authorization: Bearer <key>`
- [ ] **Agent auth (multi-agent):** Header `X-Mem-Ria-Agent: rafael`
  - Valida que agent existe no config
  - Auto-scoping: requests do rafael vão pra scope `agent:rafael`
  - Search cascade: retorna `agent:rafael` + `org:<configured-org>` + `global`
  - Agent registry em config:
    ```json
    {
      "mode": "multi-agent",
      "agents": [
        { "id": "rafael", "scopes": ["agent:rafael", "org:porti"] },
        { "id": "camila", "scopes": ["agent:camila", "org:porti"] }
      ]
    }
    ```
- [ ] **Scoping:** header `X-Mem-Ria-Scope` ou query param `scope=` (override manual)
- [ ] CORS configurável
- [ ] `Dockerfile` + `docker-compose.yml`

**GATE 8:**
- [ ] `pnpm build --filter server` compila sem erro
- [ ] `pnpm test --filter server` — testes passam
- [ ] Verificação manual: `curl -X POST localhost:3333/api/memory -d '{"title":"test","body":"test body"}'` → 200 + entry id
- [ ] Verificação manual: `curl localhost:3333/api/memory/search?q=test` → retorna entries
- [ ] Verificação manual: `curl localhost:3333/api/brain/health` → retorna health report
- [ ] Verificação manual: `curl -H "X-Mem-Ria-Agent: rafael" localhost:3333/api/memory/search?q=test` → retorna só entries do scope rafael + org + global
- [ ] Verificação manual: agent rafael salva entry → agent camila NÃO vê (scope isolation)
- [ ] Verificação manual: agent rafael salva entry com scope org:porti → agent camila VÊ
- [ ] Verificação manual: `curl -X POST localhost:3333/api/memory/extract -d '{"userMessage":"...","agentResponse":"..."}'` → extrai fatos
- [ ] Verificação manual: `docker build .` funciona
- [ ] Verificação manual: request sem API key → 401

**Estimativa:** 2.5h.

---

### Phase 9 · Multi-scope completo + bridge

**Objetivo:** Garantir que o sistema de namespaces funciona end-to-end em todos os layers.

- [ ] Scopes hierárquicos:
  ```
  global                    → visível em qualquer contexto
  project:<name>            → visível só nesse projeto
  agent:<name>              → visível só pra esse agent
  org:<name>                → visível pra todos agents/users da org
  ```
- [ ] Search cascade: scope do request + org (se configurada) + global
- [ ] Bridge entre scopes: `mem.bridge(entryId, { from, to })` copia entry
- [ ] Brain-cycle roda por scope: `brain.cycle('project:mem-ria')`
- [ ] MCP server: auto-detect scope pelo working dir
- [ ] HTTP server: scope via header ou agent auto-scope
- [ ] CLI: `--scope` flag em search, scan, cycle

**GATE 9:**
- [ ] Teste E2E personal: `mem-ria init` num projeto → scan → entries ficam em `project:X` → search sem scope retorna `project:X` + `global`
- [ ] Teste E2E multi-agent: 2 agents via HTTP API → cada um só vê o seu + shared
- [ ] Teste E2E bridge: entry em `agent:rafael` → bridge pra `org:porti` → `agent:camila` encontra
- [ ] Teste E2E brain-cycle scoped: `brain.cycle('agent:rafael')` → só processa entries do rafael
- [ ] Teste E2E cascade: entry global aparece em search de qualquer scope
- [ ] Verificação: entry no `project:A` NÃO aparece no `project:B` (isolamento)

**Estimativa:** 1.5h.

---

### Phase 10 · Dashboard local

**Objetivo:** UI web local pra visualizar o brain.

- [ ] `apps/dashboard/` — static HTML + vanilla JS (zero build)
- [ ] Servido pelo HTTP server: `GET /dashboard`
- [ ] Páginas:
  1. **Overview** — total, sources, salience distribution, health traffic lights
  2. **Search** — input + resultados com score/source/kind
  3. **Entities** — lista com alias count, mention count, tipo
  4. **Entity detail** — tudo sobre uma entidade
  5. **Brain cycle log** — último run, stages, warnings
  6. **Health** — insular report 6 dimensões com trend
- [ ] Dark mode, monospace, minimal
- [ ] Auto-refresh 30s

**GATE 10:**
- [ ] `mem-ria serve --http` → abrir `localhost:3333/dashboard` no browser → página carrega
- [ ] Overview mostra dados reais (total entries, sources, health)
- [ ] Search funciona: digitar query → resultados aparecem
- [ ] Entities lista entidades reais do brain.db
- [ ] Health mostra 6 dimensões com cores corretas (green/yellow/red)
- [ ] Nenhum erro no console do browser

**Estimativa:** 2-3h.

---

### Phase 11 · Documentação + README

**Objetivo:** Docs pra alguém instalar e usar sem ajuda.

- [ ] `README.md` root — hero:
  ```
  # mem-ria
  A brain for your AI. Not just a database.
  ```
  - Quick start Claude Code (3 linhas)
  - Quick start multi-agent (HTTP API)
  - Feature list com analogias neuro
  - Brain modules table
- [ ] `docs/brain-modules.md` — cada módulo com analogia + API + config
- [ ] `docs/connectors.md` — uso + como criar custom
- [ ] `docs/mcp.md` — setup Claude Code
- [ ] `docs/http-api.md` — referência REST
- [ ] `docs/multi-agent.md` — setup multi-agent + extractor
- [ ] `docs/architecture.md` — diagrama L1-L4
- [ ] `packages/*/README.md` — curto, link pro docs

**GATE 11:**
- [ ] README renderiza corretamente no GitHub (preview via `grip` ou similar)
- [ ] Seguir o quickstart do zero num diretório limpo → funciona sem erros
- [ ] Seguir o setup multi-agent do docs → funciona
- [ ] Links internos entre docs não quebram
- [ ] Nenhum path hardcoded ou referência ao Jonathan/Jarvis/Eon nos docs

**Estimativa:** 2h.

---

### Phase 12 · Testes end-to-end + CI

**Objetivo:** Garantir que tudo funciona junto, CI verde.

- [ ] E2E: `mem-ria init` → scan → search → cycle → status (script bash)
- [ ] E2E: MCP server + client mock → todas as 7 tools respondem
- [ ] E2E: HTTP API → upsert → search → extract → cycle → health
- [ ] E2E: multi-scope → 2 agents isolados, bridge, cascade
- [ ] E2E: brain-cycle completo com LLM mock → todos stages passam
- [ ] ESLint + Prettier configurados
- [ ] GitHub Actions: lint → build → test
- [ ] `package.json` de cada package completo (name, version, description, keywords, repository, license)
- [ ] `.npmignore` ou `files` field
- [ ] `npx mem-ria --help` funciona sem install global

**GATE 12:**
- [ ] CI verde no GitHub Actions (lint + build + test)
- [ ] `npx mem-ria init && npx mem-ria scan && npx mem-ria search "test" && npx mem-ria status` — tudo funciona numa máquina limpa (testar num diretório temporário)
- [ ] `docker build . && docker run --rm memria/server` — sobe e responde no healthz
- [ ] Zero warnings no build
- [ ] Zero testes falhando

**Estimativa:** 2h.

---

### Phase 13 · Smoke test completo (validação final)

**Objetivo:** Testar o produto como um usuário real faria. Duas personas: Claude Code user e multi-agent dev.

#### Persona 1: Dev que usa Claude Code
- [ ] Máquina limpa (diretório /tmp/test-personal)
- [ ] `npm install -g mem-ria`
- [ ] `mem-ria init` → verifica que criou config + brain.db + configurou MCP
- [ ] Criar 3 arquivos .md fake simulando auto-memory do Claude
- [ ] `mem-ria scan` → verifica ingestão
- [ ] `mem-ria search "decisão"` → retorna resultados
- [ ] `mem-ria status` → health green
- [ ] `mem-ria cycle` → roda sem erro, reporta stages
- [ ] Abrir Claude Code com MCP configurado → chamar memory_search → funciona
- [ ] Claude salva via memory_save → entry aparece em `mem-ria search`
- [ ] `mem-ria serve --http` → dashboard abre e mostra dados

#### Persona 2: Dev multi-agent
- [ ] Máquina limpa (diretório /tmp/test-multiagent)
- [ ] `mem-ria init --mode multi-agent --agents rafael,camila`
- [ ] `mem-ria serve --http --port 3333`
- [ ] curl como rafael: POST memory → save entry
- [ ] curl como camila: POST memory → save entry
- [ ] curl como rafael: GET search → vê só o dele + org
- [ ] curl como camila: GET search → vê só o dela + org
- [ ] curl: POST extract → extrai fatos de conversa
- [ ] curl: POST brain/cycle → roda cycle
- [ ] curl: GET brain/health → report green
- [ ] Dashboard: overview mostra entries de ambos agents

**GATE 13:**
- [ ] Persona 1: TODAS as verificações passam sem workaround
- [ ] Persona 2: TODAS as verificações passam sem workaround
- [ ] Zero erros no console durante ambos os testes
- [ ] Se algum step falhou → voltar pra phase relevante, corrigir, re-rodar gates daquela phase + este gate

**Estimativa:** 1.5h.

---

### Phase 14 · Publish + Launch

**Objetivo:** Publicar e divulgar.

- [ ] `npm publish` — pacotes públicos:
  - `mem-ria` (CLI + bundled)
  - `@mem-ria/core`
  - `@mem-ria/brain`
  - `@mem-ria/connectors`
  - `@mem-ria/extractor`
  - `@mem-ria/mcp`
  - `@mem-ria/server`
- [ ] GitHub repo público com README, LICENSE, CI badge
- [ ] GitHub releases — v0.1.0 + changelog
- [ ] Posts de lançamento:
  - X/Twitter: thread "meu Claude Code lembra decisões de 3 semanas atrás"
  - Hacker News: "Show HN: mem-ria — a brain for your AI, not just a database"
  - r/ClaudeAI: "I gave Claude Code a brain that gets smarter overnight"
  - r/ChatGPTCoding: "Persistent memory for AI coding tools"
  - Dev.to: artigo sobre a arquitetura cerebral

**GATE 14 (final):**
- [ ] `npm install -g mem-ria` funciona (em outra máquina ou CI)
- [ ] `npx mem-ria init` funciona sem install
- [ ] GitHub repo acessível, README renderiza, CI badge verde
- [ ] Pelo menos 1 post publicado
- [ ] Alguém externo (não Jonathan) conseguiu instalar seguindo o README

**Estimativa:** 2h.

---

## Resumo completo

| # | Phase | Tempo | Gate |
|---|---|---|---|
| 1 | Monorepo setup | 30min | Build + test rodam |
| 2 | Core (storage + CRUD) | 2h | Upsert/search/dedup/scope tudo testado |
| 3 | Brain (12 módulos) | 4-5h | Cycle completo com mock LLM |
| 4 | Connectors (5 plugins) | 2h | Cada connector ingere de diretório mock |
| 5 | **Extractor (novo)** | 1.5h | Auto-extração de fatos funciona |
| 6 | MCP server (7 tools) | 2-3h | **Claude Code real conecta e busca** |
| 7 | CLI (8 comandos) | 2h | Todos os comandos funcionam |
| 8 | HTTP API + agent auth | 2.5h | Multi-agent com isolation funciona |
| 9 | Multi-scope + bridge | 1.5h | E2E personal + multi-agent |
| 10 | Dashboard local | 2-3h | Browser mostra dados reais |
| 11 | Docs + README | 2h | Quickstart funciona do zero |
| 12 | E2E tests + CI | 2h | CI verde, npx funciona |
| 13 | **Smoke test (novo)** | 1.5h | 2 personas testam end-to-end |
| 14 | Publish + launch | 2h | npm install funciona, posts publicados |
| **Total** | | **~28-32h** | |

## Grafo de dependências

```
Phase 1 (setup)
    │
    ▼
Phase 2 (core) ◄── fundação de tudo
    │
    ├──────────────────┐
    ▼                  ▼
Phase 3 (brain)    Phase 4 (connectors)
    │                  │
    ├──────────┐       │
    ▼          │       │
Phase 5 (extractor)   │  ◄── precisa de brain (LLM adapter) + core
    │          │       │
    ▼          ▼       ▼
Phase 6 (MCP)  Phase 7 (CLI)  Phase 8 (HTTP+agent) ◄── podem em paralelo
    │          │       │
    └────┬─────┘───────┘
         ▼
Phase 9 (multi-scope) ◄── valida tudo junto
         │
         ▼
Phase 10 (dashboard) ◄── precisa do HTTP server
         │
         ├──────────────────┐
         ▼                  ▼
Phase 11 (docs)      Phase 12 (E2E+CI)
         │                  │
         └────────┬─────────┘
                  ▼
         Phase 13 (smoke test) ◄── validação final antes de publicar
                  │
                  ▼
         Phase 14 (publish)
```

## Regra de rollback

Se um gate falha:
1. **Não avança.** Resolve ali.
2. Se o fix mexeu em algo de uma phase anterior, **re-roda o gate daquela phase** antes de continuar.
3. Se 3+ tentativas de fix no mesmo gate → para, documenta o blocker, e pede input humano antes de continuar.
