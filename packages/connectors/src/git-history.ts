import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { MemRia } from '@mem-ria/core'
import type { Connector } from './types.js'

// Patterns that signal a decision commit
const DECISION_PATTERNS = /^(ADR:|BREAKING:|decision:)/i

interface GitCommit {
  hash: string
  authorName: string
  authorEmail: string
  date: string
  subject: string
  body: string
}

function parseGitLog(raw: string): GitCommit[] {
  const commits: GitCommit[] = []
  // Separator-based parsing for clean extraction
  const entries = raw.split('\x00').filter(Boolean)
  for (const entry of entries) {
    const lines = entry.trim().split('\n')
    if (lines.length < 4) continue
    commits.push({
      hash: lines[0],
      authorName: lines[1],
      authorEmail: lines[2],
      date: lines[3],
      subject: lines[4] || '',
      body: lines.slice(5).join('\n').trim(),
    })
  }
  return commits
}

function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'))
}

function getGitCommits(repoPath: string, maxCommits: number, since?: string): GitCommit[] {
  const args = ['-C', repoPath, 'log', `--max-count=${maxCommits}`, '--format=%H%n%an%n%ae%n%aI%n%s%n%b%x00']
  if (since) args.push(`--since=${since}`)
  try {
    const output = execFileSync('git', args, { encoding: 'utf8', timeout: 15000, maxBuffer: 10 * 1024 * 1024 })
    return parseGitLog(output)
  } catch {
    return []
  }
}

export const gitHistoryConnector: Connector = {
  name: 'git-history',

  async scan(mem: MemRia, config?: Record<string, unknown>): Promise<{ count: number }> {
    const maxCommits = (config?.maxCommits as number) || 200
    const since = config?.since as string | undefined
    let repos = config?.repos as string[] | undefined

    // Default: use current directory if it's a git repo
    if (!repos || repos.length === 0) {
      const cwd = process.cwd()
      if (isGitRepo(cwd)) {
        repos = [cwd]
      } else {
        return { count: 0 }
      }
    }

    let count = 0

    for (const repo of repos) {
      if (!existsSync(repo) || !isGitRepo(repo)) continue

      const repoName = repo.split('/').filter(Boolean).pop() || 'unknown'
      const commits = getGitCommits(repo, maxCommits, since)

      for (const commit of commits) {
        const isDecision = DECISION_PATTERNS.test(commit.subject)
        const kind = isDecision ? 'decision' : 'note'
        const tags = ['git', 'commit']
        if (isDecision) tags.push('decision')
        tags.push(repoName)

        const bodyParts = [
          `**Repo:** ${repoName}`,
          `**Author:** ${commit.authorName} <${commit.authorEmail}>`,
          `**Date:** ${commit.date}`,
          `**Hash:** ${commit.hash}`,
          '',
          commit.subject,
        ]
        if (commit.body) {
          bodyParts.push('', commit.body)
        }

        const ts = Date.parse(commit.date) || Date.now()

        mem.upsert({
          source: 'git_history',
          sourceId: `${repoName}:${commit.hash}`,
          title: `[${repoName}] ${commit.subject}`.slice(0, 120),
          body: bodyParts.join('\n').slice(0, 20000),
          kind,
          tags,
          created: ts,
          updated: ts,
        })
        count++
      }
    }

    return { count }
  },
}
