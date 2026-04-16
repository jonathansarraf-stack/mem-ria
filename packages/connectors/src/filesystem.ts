import { readFileSync, readdirSync, statSync, lstatSync, existsSync } from 'node:fs'
import { join, relative, basename, extname } from 'node:path'
import type { MemRia } from '@mem-ria/core'
import type { Connector } from './types.js'

const DEFAULT_EXTENSIONS = ['.md', '.txt', '.json']

function walkDir(dir: string, extensions: string[], maxDepth = 10): string[] {
  const results: string[] = []
  function rec(d: string, depth: number) {
    if (depth > maxDepth) return
    let names: string[]
    try { names = readdirSync(d) } catch { return }
    for (const name of names) {
      if (name.startsWith('.')) continue
      const full = join(d, name)
      let s: ReturnType<typeof lstatSync>
      try { s = lstatSync(full) } catch { continue }
      if (s.isSymbolicLink()) continue
      if (s.isDirectory()) rec(full, depth + 1)
      else if (s.isFile() && s.size <= 1024 * 1024 && extensions.includes(extname(name).toLowerCase())) {
        results.push(full)
      }
    }
  }
  rec(dir, 0)
  return results
}

function readFileContent(file: string, ext: string): string {
  const raw = readFileSync(file, 'utf8')
  if (ext === '.json') {
    // For JSON files, pretty-print as body
    try {
      const parsed = JSON.parse(raw)
      return '```json\n' + JSON.stringify(parsed, null, 2).slice(0, 20000) + '\n```'
    } catch {
      return raw.slice(0, 20000)
    }
  }
  return raw.slice(0, 20000)
}

function extractTitle(content: string, fallbackName: string): string {
  // Try to extract a markdown heading
  const h1 = content.match(/^#\s+(.+)$/m)
  if (h1) return h1[1].trim().slice(0, 120)
  // First non-empty, non-frontmatter line
  const firstLine = content.split('\n').find(l => l.trim() && !l.startsWith('---') && !l.startsWith('```'))
  if (firstLine) return firstLine.trim().replace(/^[#*>\s-]+/, '').slice(0, 120)
  return fallbackName
}

export const filesystemConnector: Connector = {
  name: 'filesystem',

  async scan(mem: MemRia, config?: Record<string, unknown>): Promise<{ count: number }> {
    const paths = config?.paths as string[] | undefined
    if (!paths || paths.length === 0) return { count: 0 }

    const extensions = (config?.extensions as string[]) || DEFAULT_EXTENSIONS
    // Normalize extensions to include dot prefix
    const normalizedExts = extensions.map(e => e.startsWith('.') ? e : `.${e}`)

    let count = 0

    for (const scanPath of paths) {
      if (!existsSync(scanPath)) continue

      const files = walkDir(scanPath, normalizedExts)
      const dirName = basename(scanPath)

      for (const file of files) {
        const ext = extname(file).toLowerCase()
        let content: string
        try { content = readFileContent(file, ext) } catch { continue }
        if (content.length < 5) continue

        const rel = relative(scanPath, file)
        const title = ext === '.json'
          ? basename(file)
          : extractTitle(content, basename(file, ext))

        let stat: ReturnType<typeof statSync> | null = null
        try { stat = statSync(file) } catch { /* ignore */ }

        mem.upsert({
          source: 'filesystem',
          sourceId: `${dirName}:${rel}`,
          title,
          body: content,
          kind: 'doc',
          tags: ['filesystem', dirName, ext.replace('.', '')],
          created: stat?.birthtimeMs || Date.now(),
          updated: stat?.mtimeMs || Date.now(),
        })
        count++
      }
    }

    return { count }
  },
}
