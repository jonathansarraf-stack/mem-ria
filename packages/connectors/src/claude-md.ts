import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import type { MemRia } from '@mem-ria/core'
import type { Connector } from './types.js'

// Common locations where CLAUDE.md files might exist
const COMMON_LOCATIONS = [
  process.env.HOME || '/root',
  '/root',
  '/opt',
]

function findClaudeMdFiles(directories: string[]): string[] {
  const results: string[] = []
  const seen = new Set<string>()

  for (const dir of directories) {
    if (!existsSync(dir)) continue
    // Check for CLAUDE.md directly in the directory
    const candidate = join(dir, 'CLAUDE.md')
    if (existsSync(candidate) && !seen.has(candidate)) {
      seen.add(candidate)
      results.push(candidate)
    }
    // Also check immediate subdirectories (one level deep)
    let entries: string[]
    try { entries = readdirSync(dir) } catch { continue }
    for (const entry of entries) {
      const subdir = join(dir, entry)
      try {
        if (!statSync(subdir).isDirectory()) continue
      } catch { continue }
      const sub = join(subdir, 'CLAUDE.md')
      if (existsSync(sub) && !seen.has(sub)) {
        seen.add(sub)
        results.push(sub)
      }
    }
  }
  return results
}

function detectGitRepos(): string[] {
  // Try to find git repos in home directory (shallow)
  const home = process.env.HOME || '/root'
  const repos: string[] = []
  try {
    const entries = readdirSync(home)
    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      const full = join(home, entry)
      try {
        if (statSync(full).isDirectory() && existsSync(join(full, '.git'))) {
          repos.push(full)
        }
      } catch { continue }
    }
  } catch { /* ignore */ }
  return repos
}

export const claudeMdConnector: Connector = {
  name: 'claude-md',

  async scan(mem: MemRia, config?: Record<string, unknown>): Promise<{ count: number }> {
    let directories = config?.directories as string[] | undefined
    if (!directories || directories.length === 0) {
      // Auto-detect: common locations + git repos
      directories = [...COMMON_LOCATIONS, ...detectGitRepos()]
    }

    const files = findClaudeMdFiles(directories)
    let count = 0

    for (const file of files) {
      let content: string
      try { content = readFileSync(file, 'utf8') } catch { continue }
      if (content.length < 5) continue

      const projectDir = dirname(file)
      const projectName = basename(projectDir)

      let stat: ReturnType<typeof statSync> | null = null
      try { stat = statSync(file) } catch { /* ignore */ }

      mem.upsert({
        source: 'claude_md',
        sourceId: file,
        title: `CLAUDE.md — ${projectName}`,
        body: content.slice(0, 20000),
        kind: 'doc',
        tags: ['claude-md', 'project-config'],
        created: stat?.birthtimeMs || Date.now(),
        updated: stat?.mtimeMs || Date.now(),
      })
      count++
    }

    return { count }
  },
}
