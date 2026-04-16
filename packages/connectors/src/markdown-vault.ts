import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, basename, dirname, extname } from 'node:path'
import type { MemRia } from '@mem-ria/core'

type MemoryKind = 'fact' | 'note' | 'doc' | 'decision' | 'journal' | 'person' | 'project' | 'preference'
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

function walkDir(dir: string, maxDepth = 10, includeExt = ['.md']): string[] {
  const results: string[] = []
  function rec(d: string, depth: number) {
    if (depth > maxDepth) return
    let names: string[]
    try { names = readdirSync(d) } catch { return }
    for (const name of names) {
      if (name.startsWith('.')) continue
      const full = join(d, name)
      let s: ReturnType<typeof statSync>
      try { s = statSync(full) } catch { continue }
      if (s.isDirectory()) rec(full, depth + 1)
      else if (s.isFile() && includeExt.some(ext => name.endsWith(ext))) results.push(full)
    }
  }
  rec(dir, 0)
  return results
}

// Default kind mapping inspired by Obsidian vault conventions
const DEFAULT_KIND_MAPPING: Record<string, MemoryKind> = {
  'pessoas/': 'person',
  'people/': 'person',
  '02-pessoas/': 'person',
  'projetos/': 'project',
  'projects/': 'project',
  '03-projetos/': 'project',
  'decisoes/': 'decision',
  'decisions/': 'decision',
  '04-decisoes/': 'decision',
  'reunioes/': 'note',
  'meetings/': 'note',
  '05-reunioes/': 'note',
  'diario/': 'journal',
  'journal/': 'journal',
  '01-diario/': 'journal',
  'agentes/': 'doc',
  '06-agentes/': 'doc',
}

function kindFromPath(relPath: string, mapping: Record<string, string>): MemoryKind {
  for (const [pattern, kind] of Object.entries(mapping)) {
    if (relPath.includes(pattern)) return kind as MemoryKind
  }
  return 'doc'
}

// ── Connector ───────────────────────────────────────────────────────────────

export const markdownVaultConnector: Connector = {
  name: 'markdown-vault',

  async scan(mem: MemRia, config?: Record<string, unknown>): Promise<{ count: number }> {
    const vaultPath = config?.path as string
    if (!vaultPath) return { count: 0 }
    if (!existsSync(vaultPath)) return { count: 0 }

    const userKindMapping = (config?.kindMapping as Record<string, string>) || {}
    const kindMapping = { ...DEFAULT_KIND_MAPPING, ...userKindMapping }

    const files = walkDir(vaultPath)
    let count = 0

    for (const file of files) {
      let content: string
      try { content = readFileSync(file, 'utf8') } catch { continue }
      if (content.length < 10) continue

      const rel = relative(vaultPath, file)
      const { frontmatter, body } = parseFrontmatter(content)
      const title = frontmatter.title || extractTitle(body, basename(file, '.md'))

      // Build tags from frontmatter + top-level folder
      const tags: string[] = []
      if (frontmatter.tags) {
        tags.push(...String(frontmatter.tags).split(/[,\s]+/).filter(Boolean))
      }
      const topFolder = dirname(rel).split('/')[0]
      if (topFolder && topFolder !== '.') tags.push(topFolder)

      // Detect entity from people/project folders
      let entity: string | undefined
      const kind = kindFromPath(rel, kindMapping)
      if (kind === 'person' || kind === 'project') {
        entity = basename(file, '.md')
      }

      let stat: ReturnType<typeof statSync> | null = null
      try { stat = statSync(file) } catch { /* ignore */ }

      mem.upsert({
        source: 'vault',
        sourceId: rel,
        title,
        body: body.slice(0, 20000),
        kind,
        tags,
        entity,
        created: stat?.birthtimeMs || Date.now(),
        updated: stat?.mtimeMs || Date.now(),
      })
      count++
    }

    return { count }
  },
}
