#!/usr/bin/env node
// mem-ria CLI — Command-line interface for mem-ria brain

import { Command } from 'commander'
import { createMemory, validateKey, getPlan, LIMITS } from '@mem-ria/core'
import type { Plan } from '@mem-ria/core'
import { Brain } from '@mem-ria/brain'
import {
  ConnectorRegistry,
  claudeMemoryConnector,
  claudeMdConnector,
  gitHistoryConnector,
  markdownVaultConnector,
} from '@mem-ria/connectors'
import { startMCPServer } from '@mem-ria/mcp'
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execSync } from 'node:child_process'

const MEM_RIA_DIR = join(homedir(), '.mem-ria')
const CONFIG_PATH = join(MEM_RIA_DIR, 'config.json')
const BRAIN_DB_PATH = join(MEM_RIA_DIR, 'brain.db')

interface Config {
  mode: 'personal' | 'multi-agent'
  dbPath: string
  scope?: string
  agents?: Array<{ id: string; scopes: string[] }>
  licenseKey?: string
}

function loadConfig(): Config {
  if (existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    } catch {
      console.warn('[mem-ria] Config file corrupted, using defaults')
      return { mode: 'personal' as const, dbPath: BRAIN_DB_PATH }
    }
  }
  return { mode: 'personal', dbPath: BRAIN_DB_PATH }
}

function saveConfig(config: Config): void {
  mkdirSync(MEM_RIA_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

function createBrainFromConfig(config: Config) {
  const mem = createMemory({ storage: 'sqlite', path: config.dbPath, scope: config.scope })
  const brain = new Brain(mem, {})
  return { mem, brain }
}

function isGitRepo(dir: string): boolean {
  try { execSync('git rev-parse --git-dir', { cwd: dir, stdio: 'pipe' }); return true } catch { return false }
}

const program = new Command()
program
  .name('mem-ria')
  .description('A brain for your AI. Not just a database.')
  .version('0.1.0')

// --- init ---
program
  .command('init')
  .description('Initialize mem-ria in the current directory')
  .option('--mode <mode>', 'personal or multi-agent', 'personal')
  .option('--agents <agents>', 'Comma-separated agent IDs (multi-agent mode)')
  .action(async (opts) => {
    mkdirSync(MEM_RIA_DIR, { recursive: true })
    const config: Config = { mode: opts.mode, dbPath: BRAIN_DB_PATH, scope: 'global' }
    if (opts.agents) {
      config.agents = opts.agents.split(',').map((id: string) => ({
        id: id.trim(),
        scopes: [`agent:${id.trim()}`, 'org:default'],
      }))
    }
    saveConfig(config)

    const mem = createMemory({ storage: 'sqlite', path: BRAIN_DB_PATH })
    const registry = new ConnectorRegistry()
    registry.register(claudeMemoryConnector)
    registry.register(claudeMdConnector)
    // Ingest .md files from the current project directory
    registry.register(markdownVaultConnector, {
      path: process.cwd(),
      kindMapping: { 'decisions/': 'decision', 'decision/': 'decision', 'docs/': 'doc', 'people/': 'person' },
    })
    if (isGitRepo(process.cwd())) {
      registry.register(gitHistoryConnector, { repos: [process.cwd()], maxCommits: 50 })
    }
    const scanResult = await registry.scanAll(mem)

    // Configure Claude Code MCP
    const claudeDir = join(homedir(), '.claude')
    const claudeSettingsPath = join(claudeDir, 'settings.json')
    if (existsSync(claudeDir)) {
      try {
        const settings = existsSync(claudeSettingsPath) ? JSON.parse(readFileSync(claudeSettingsPath, 'utf8')) : {}
        if (!settings.mcpServers) settings.mcpServers = {}
        settings.mcpServers['mem-ria'] = { command: 'mem-ria', args: ['serve'] }
        writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2))
        console.log('  MCP server configured in ~/.claude/settings.json')
      } catch { /* skip */ }
    }

    mem.close()
    console.log(`\nmem-ria initialized.`)
    console.log(`  Mode: ${config.mode}`)
    console.log(`  Database: ${BRAIN_DB_PATH}`)
    console.log(`  Memories ingested: ${scanResult.total}`)
    console.log(`\n  Run 'mem-ria serve' to start the brain.`)
  })

// --- serve ---
program
  .command('serve')
  .description('Start the MCP server (and optionally HTTP API)')
  .option('--http', 'Also start HTTP API server')
  .option('--port <port>', 'HTTP port', '3333')
  .action(async (opts) => {
    const config = loadConfig()
    const { mem, brain } = createBrainFromConfig(config)
    if (opts.http) {
      const { startServer } = await import('@mem-ria/server')
      startServer({ mem, brain, port: parseInt(opts.port) })
    }
    brain.start()
    console.error('[mem-ria] Brain scheduler started (daily cycle)')
    await startMCPServer({ mem, brain })
  })

// --- search ---
program
  .command('search <query>')
  .description('Search memory')
  .option('--scope <scope>', 'Scope filter')
  .option('--limit <n>', 'Max results', '10')
  .option('--json', 'Output as JSON')
  .action((query, opts) => {
    const config = loadConfig()
    const { mem } = createBrainFromConfig(config)
    const results = mem.search(query, { limit: parseInt(opts.limit), scope: opts.scope })
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2))
    } else if (results.length === 0) {
      console.log('No memories found.')
    } else {
      for (const r of results) {
        console.log(`\n[${r.kind}/${r.source}] ${r.title}`)
        console.log(`  Score: ${r.finalScore.toFixed(2)} | Salience: ${r.salience.toFixed(1)} | Scope: ${r.scope}`)
        if (r.snippet) console.log(`  ${r.snippet.replace(/<\/?mark>/g, '*')}`)
      }
    }
    mem.close()
  })

// --- status ---
program
  .command('status')
  .description('Show brain health and statistics')
  .action(() => {
    const config = loadConfig()
    const { mem, brain } = createBrainFromConfig(config)
    const stats = mem.stats()
    const health = brain.health()
    console.log(`\nmem-ria status\n`)
    console.log(`Total memories: ${stats.total}`)
    console.log(`By source: ${Object.entries(stats.bySource).map(([k, v]) => `${k}(${v})`).join(', ') || 'none'}`)
    console.log(`By kind: ${Object.entries(stats.byKind).map(([k, v]) => `${k}(${v})`).join(', ') || 'none'}`)
    console.log(`\nBrain Health: ${health.overall.toUpperCase()}`)
    for (const c of health.checks) {
      const icon = c.status === 'green' ? 'OK' : c.status === 'yellow' ? 'WARN' : 'ERR'
      console.log(`  [${icon}] ${c.dimension}: ${c.message}`)
    }
    mem.close()
  })

// --- cycle ---
program
  .command('cycle')
  .description('Run brain cycle manually')
  .option('--scope <scope>', 'Scope to cycle')
  .action(async (opts) => {
    const config = loadConfig()
    const { mem, brain } = createBrainFromConfig(config)
    console.log('Running brain cycle...\n')
    const report = await brain.cycle(opts.scope)
    for (const step of report.steps) {
      console.log(JSON.stringify(step))
    }
    console.log(`\nCompleted in ${report.elapsed}ms. Health: ${report.health.overall}`)
    mem.close()
  })

// --- scan ---
program
  .command('scan')
  .description('Run all connectors to ingest new data')
  .action(async () => {
    const config = loadConfig()
    const { mem } = createBrainFromConfig(config)
    const registry = new ConnectorRegistry()
    registry.register(claudeMemoryConnector)
    registry.register(claudeMdConnector)
    registry.register(markdownVaultConnector, {
      path: process.cwd(),
      kindMapping: { 'decisions/': 'decision', 'decision/': 'decision', 'docs/': 'doc', 'people/': 'person' },
    })
    if (isGitRepo(process.cwd())) {
      registry.register(gitHistoryConnector, { repos: [process.cwd()], maxCommits: 100 })
    }
    console.log('Scanning...\n')
    const result = await registry.scanAll(mem)
    console.log(`Total ingested: ${result.total}`)
    for (const [name, count] of Object.entries(result.byConnector)) {
      console.log(`  ${name}: ${count}`)
    }
    mem.close()
  })

// --- doctor ---
program
  .command('doctor')
  .description('Diagnose mem-ria installation')
  .action(() => {
    console.log('\nmem-ria doctor\n')
    if (existsSync(CONFIG_PATH)) {
      console.log('[OK] Config: ' + CONFIG_PATH)
    } else {
      console.log('[ERR] Config missing. Run `mem-ria init`')
    }
    if (existsSync(BRAIN_DB_PATH)) {
      const size = statSync(BRAIN_DB_PATH).size
      console.log(`[OK] Brain DB: ${BRAIN_DB_PATH} (${(size / 1024).toFixed(0)} KB)`)
    } else {
      console.log('[ERR] Brain DB missing. Run `mem-ria init`')
    }
    const claudeSettingsPath = join(homedir(), '.claude', 'settings.json')
    if (existsSync(claudeSettingsPath)) {
      try {
        const settings = JSON.parse(readFileSync(claudeSettingsPath, 'utf8'))
        console.log(settings.mcpServers?.['mem-ria'] ? '[OK] Claude Code MCP: configured' : '[WARN] Claude Code MCP: not configured')
      } catch { console.log('[WARN] Claude Code settings: parse error') }
    } else {
      console.log('[INFO] Claude Code: not installed')
    }
    if (existsSync(BRAIN_DB_PATH)) {
      const config = loadConfig()
      const { mem, brain } = createBrainFromConfig(config)
      console.log(`\nBrain health: ${brain.health().overall}`)
      mem.close()
    }
  })

// --- config ---
program
  .command('config [key] [value]')
  .description('Show or set configuration')
  .action((key, value) => {
    const ALLOWED_CONFIG_KEYS = ['mode', 'dbPath', 'scope']
    const config = loadConfig()
    if (!key) {
      console.log(JSON.stringify(config, null, 2))
    } else if (!ALLOWED_CONFIG_KEYS.includes(key)) {
      console.error(`Unknown config key: ${key}. Allowed: ${ALLOWED_CONFIG_KEYS.join(', ')}`)
      return
    } else if (!value) {
      console.log((config as unknown as Record<string, unknown>)[key])
    } else {
      (config as unknown as Record<string, unknown>)[key] = value
      saveConfig(config)
      console.log(`Set ${key} = ${value}`)
    }
  })

// --- activate ---
program
  .command('activate <key>')
  .description('Activate a license key')
  .action((key: string) => {
    const result = validateKey(key)
    if (!result.valid) {
      console.error(`Invalid key: ${result.error}`)
      process.exitCode = 1
      return
    }
    const config = loadConfig()
    config.licenseKey = key
    saveConfig(config)
    const expires = result.expires ? new Date(result.expires).toISOString().split('T')[0] : 'unknown'
    console.log(`\nLicense activated!`)
    console.log(`  Plan: ${result.plan}`)
    console.log(`  Expires: ${expires}`)
    const limits = LIMITS[result.plan]
    console.log(`  Max entries: ${limits.maxEntries.toLocaleString()}`)
    console.log(`  Features: ${Object.entries(limits).filter(([k, v]) => k !== 'maxEntries' && v).map(([k]) => k).join(', ') || 'none'}`)
  })

// --- plan ---
program
  .command('plan')
  .description('Show current plan and limits')
  .action(() => {
    const info = getPlan(CONFIG_PATH)
    console.log(`\nmem-ria plan\n`)
    console.log(`  Plan: ${info.plan}`)
    if (info.valid && info.expires) {
      console.log(`  Expires: ${new Date(info.expires).toISOString().split('T')[0]}`)
    } else if (info.plan === 'free') {
      console.log(`  No license key. Using free plan.`)
    } else if (info.error) {
      console.log(`  Error: ${info.error}`)
    }
    const limits = LIMITS[info.plan]
    console.log(`\n  Limits:`)
    console.log(`    Max entries: ${limits.maxEntries.toLocaleString()}`)
    console.log(`    Scheduler: ${limits.scheduler ? 'yes' : 'no'}`)
    console.log(`    Embeddings: ${limits.embeddings ? 'yes' : 'no'}`)
    console.log(`    Replay: ${limits.replay ? 'yes' : 'no'}`)
    console.log(`    Proactive: ${limits.proactive ? 'yes' : 'no'}`)
    console.log(`    HTTP API: ${limits.httpApi ? 'yes' : 'no'}`)
    console.log(`    Multi-agent: ${limits.multiAgent ? 'yes' : 'no'}`)
    console.log(`    Extractor: ${limits.extractor ? 'yes' : 'no'}`)
  })

program.parse()
