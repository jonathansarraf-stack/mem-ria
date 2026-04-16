import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { MemRia } from '@mem-ria/core'
import type { Connector } from './types.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n/)
  if (!m) return { frontmatter: {}, body: content }
  const fm: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/)
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return { frontmatter: fm, body: content.slice(m[0].length) }
}

function extractTitle(content: string, fallbackName: string): string {
  const h1 = content.match(/^#\s+(.+)$/m)
  if (h1) return h1[1].trim().slice(0, 120)
  const firstLine = content.split('\n').find(l => l.trim() && !l.startsWith('---'))
  if (firstLine) return firstLine.trim().replace(/^[#*>\s-]+/, '').slice(0, 120)
  return fallbackName
}

function walkMemoryDirs(baseDir: string): string[] {
  const results: string[] = []
  if (!existsSync(baseDir)) return results
  // Walk ~/.claude/projects/*/memory/*.md
  const projectsDir = join(baseDir, 'projects')
  if (!existsSync(projectsDir)) return results
  let projectEntries: string[]
  try { projectEntries = readdirSync(projectsDir) } catch { return results }
  for (const project of projectEntries) {
    const memDir = join(projectsDir, project, 'memory')
    if (!existsSync(memDir)) continue
    let files: string[]
    try { files = readdirSync(memDir) } catch { continue }
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      if (f === 'MEMORY.md') continue // index file, skip
      results.push(join(memDir, f))
    }
  }
  return results
}

function typeToKind(type: string): 'fact' | 'person' | 'project' | 'doc' {
  if (type === 'feedback') return 'fact'
  if (type === 'user') return 'person'
  if (type === 'project') return 'project'
  return 'doc'
}

// ── Connector ───────────────────────────────────────────────────────────────

export const claudeMemoryConnector: Connector = {
  name: 'claude-memory',

  async scan(mem: MemRia, config?: Record<string, unknown>): Promise<{ count: number }> {
    const basePath = (config?.basePath as string) || (process.env.HOME + '/.claude')
    const files = walkMemoryDirs(basePath)
    let count = 0

    for (const file of files) {
      let content: string
      try { content = readFileSync(file, 'utf8') } catch { continue }
      if (content.length < 10) continue

      const { frontmatter, body } = parseFrontmatter(content)
      const title = frontmatter.name || extractTitle(body, basename(file, '.md'))
      const type = frontmatter.type || 'unknown'
      const tags = ['claude-auto-memory', type]

      let stat: ReturnType<typeof statSync> | null = null
      try { stat = statSync(file) } catch { /* ignore */ }

      mem.upsert({
        source: 'claude_memory',
        sourceId: basename(file),
        title,
        body: body.slice(0, 20000),
        kind: typeToKind(type),
        tags,
        created: stat?.birthtimeMs || Date.now(),
        updated: stat?.mtimeMs || Date.now(),
      })
      count++
    }

    return { count }
  },
}
