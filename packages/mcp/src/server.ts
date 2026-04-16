// @mem-ria/mcp — MCP Server for Claude Code
// Exposes memory tools via Model Context Protocol

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import type { MemRia } from '@mem-ria/core'
import type { Brain } from '@mem-ria/brain'

export interface MCPServerConfig {
  mem: MemRia
  brain: Brain
  name?: string
  version?: string
}

export function createMCPServer(config: MCPServerConfig) {
  const { mem, brain } = config
  const server = new McpServer({
    name: config.name || 'mem-ria',
    version: config.version || '0.1.0',
  })

  // Tool 1: memory_search
  server.tool(
    'memory_search',
    'Search your persistent memory. Returns relevant memories ranked by importance.',
    {
      query: z.string().describe('What to search for'),
      limit: z.number().optional().default(10).describe('Max results'),
      scope: z.string().optional().describe('Namespace: global, project:name, agent:name'),
    },
    async ({ query, limit, scope }) => {
      const results = mem.search(query, { limit, scope })
      const text = results.length === 0
        ? 'No memories found.'
        : results.map((r, i) =>
          `[${i + 1}] (${r.kind}/${r.source}) **${r.title}** [score: ${r.finalScore.toFixed(2)}, salience: ${r.salience.toFixed(1)}]\n${r.snippet || r.body?.slice(0, 300) || ''}`
        ).join('\n\n---\n\n')
      return { content: [{ type: 'text' as const, text }] }
    }
  )

  // Tool 2: memory_save
  server.tool(
    'memory_save',
    'Save a fact, decision, preference, or any important information to persistent memory.',
    {
      title: z.string().describe('Short title for the memory'),
      body: z.string().describe('Full content of the memory'),
      kind: z.enum(['fact', 'decision', 'preference', 'person', 'project', 'note']).optional().default('fact'),
      tags: z.array(z.string()).optional().default([]),
      entity: z.string().optional().describe('Primary entity (person, project name)'),
      scope: z.string().optional().describe('Namespace'),
    },
    async ({ title, body, kind, tags, entity, scope }) => {
      const id = mem.upsert({
        source: 'mcp',
        title,
        body,
        kind,
        tags,
        entity,
        scope,
      })
      return { content: [{ type: 'text' as const, text: `Saved memory: ${id}` }] }
    }
  )

  // Tool 3: memory_entities
  server.tool(
    'memory_entities',
    'List known entities (people, projects, tools) in memory with their importance.',
    {
      type: z.enum(['person', 'project', 'company', 'tool', 'all']).optional().default('all'),
    },
    async ({ type }) => {
      const entities = brain.entities.list()
      const filtered = type === 'all' ? entities : entities.filter(e => e.type === type)
      if (filtered.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No entities found.' }] }
      }
      const text = filtered.map(e =>
        `- **${e.canonicalName}** (${e.type}) — ${e.mentionCount} mentions, aliases: ${e.aliases.join(', ') || 'none'}`
      ).join('\n')
      return { content: [{ type: 'text' as const, text }] }
    }
  )

  // Tool 4: memory_entity_detail
  server.tool(
    'memory_entity_detail',
    'Get everything known about a specific entity.',
    {
      name: z.string().describe('Entity name to look up'),
    },
    async ({ name }) => {
      const result = brain.entities.getEntity(name)
      if (!result) {
        return { content: [{ type: 'text' as const, text: `No entity found matching "${name}".` }] }
      }
      const { entity, memories } = result
      const memText = memories.slice(0, 10).map(m =>
        `- (${m.kind}/${m.source}) ${m.title}: ${m.body?.slice(0, 200) || ''}`
      ).join('\n')
      let aliasesStr = 'none'
      try { aliasesStr = JSON.parse((entity.aliases as string) || '[]').join(', ') || 'none' } catch { /* malformed */ }
      const text = `**${entity.canonical_name}** (${entity.type})\nAliases: ${aliasesStr}\n\n**Memories (${memories.length}):**\n${memText}`
      return { content: [{ type: 'text' as const, text }] }
    }
  )

  // Tool 5: brain_status
  server.tool(
    'brain_status',
    'Check the health of your memory brain. Returns diagnostics across multiple dimensions.',
    {},
    async () => {
      const health = brain.health()
      const checks = health.checks.map(c =>
        `${c.status === 'green' ? '✅' : c.status === 'yellow' ? '⚠️' : '❌'} **${c.dimension}**: ${c.message}`
      ).join('\n')
      const text = `Brain Health: **${health.overall.toUpperCase()}**\n\n${checks}`
      return { content: [{ type: 'text' as const, text }] }
    }
  )

  // Tool 6: brain_cycle
  server.tool(
    'brain_cycle',
    'Manually trigger a brain cycle: recompute importance, prune noise, consolidate.',
    {},
    async () => {
      const report = await brain.cycle()
      const stepsText = report.steps.map(s => `- ${s.step}: ${JSON.stringify({ ...s, step: undefined, ts: undefined })}`).join('\n')
      const text = `Brain cycle completed in ${report.elapsed}ms.\nHealth: ${report.health.overall}\n\nSteps:\n${stepsText}`
      return { content: [{ type: 'text' as const, text }] }
    }
  )

  // Tool 7: memory_stats
  server.tool(
    'memory_stats',
    'Get memory statistics: total entries, by source, by kind, salience distribution.',
    {},
    async () => {
      const stats = mem.stats()
      const dist = brain.salience.distribution()
      const text = [
        `**Total memories:** ${stats.total}`,
        `**By source:** ${Object.entries(stats.bySource).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
        `**By kind:** ${Object.entries(stats.byKind).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
        `**By scope:** ${Object.entries(stats.byScope).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
        `**Salience distribution:** ${dist.buckets.map(b => `${b.bucket}: ${b.n}`).join(', ')}`,
      ].join('\n')
      return { content: [{ type: 'text' as const, text }] }
    }
  )

  // Resource: context for auto-inject
  server.resource(
    'mem-ria://context',
    'mem-ria://context',
    async (uri) => {
      // Return top memories by salience as context
      const stats = mem.stats()
      const dist = brain.salience.distribution()
      const topEntities = brain.entities.list().slice(0, 5)

      const text = [
        `# mem-ria Context`,
        `Total memories: ${stats.total}`,
        `Health: ${brain.health().overall}`,
        '',
        `## Top entities:`,
        ...topEntities.map(e => `- ${e.canonicalName} (${e.type}, ${e.mentionCount} mentions)`),
      ].join('\n')

      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text }] }
    }
  )

  return server
}

export async function startMCPServer(config: MCPServerConfig): Promise<void> {
  const server = createMCPServer(config)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
