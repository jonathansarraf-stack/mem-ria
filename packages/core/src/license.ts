// @mem-ria/core — License key validation (offline, HMAC-signed)
// Key format: CORTEX-{plan}-{expiresTimestamp}-{hmacSignature}

import { createHmac } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export type Plan = 'free' | 'starter' | 'pro' | 'team'

export interface LicenseInfo {
  valid: boolean
  plan: Plan
  expires?: number
  error?: string
}

// HMAC secret (obfuscated - split to make it harder to grep)
const S1 = 'c0rt3x'
const S2 = '_by_30n'
const S3 = 't3ch_2026'
const SECRET = S1 + S2 + S3

const VALID_PLANS = ['starter', 'pro', 'team'] as const

function hmacSign(data: string): string {
  return createHmac('sha256', SECRET).update(data).digest('hex').slice(0, 16)
}

export function generateKey(plan: string, daysValid = 365): string {
  if (!VALID_PLANS.includes(plan as typeof VALID_PLANS[number])) {
    throw new Error(`Invalid plan: ${plan}. Must be one of: ${VALID_PLANS.join(', ')}`)
  }
  const expires = Date.now() + daysValid * 24 * 60 * 60 * 1000
  const payload = plan + expires
  const sig = hmacSign(payload)
  return `CORTEX-${plan}-${expires}-${sig}`
}

export function validateKey(key: string): LicenseInfo {
  if (!key || typeof key !== 'string') {
    return { valid: false, plan: 'free', error: 'No key provided' }
  }

  const parts = key.split('-')
  // Format: CORTEX-{plan}-{timestamp}-{signature}
  if (parts.length !== 4 || parts[0] !== 'CORTEX') {
    return { valid: false, plan: 'free', error: 'Invalid key format' }
  }

  const [, plan, expiresStr, sig] = parts

  if (!VALID_PLANS.includes(plan as typeof VALID_PLANS[number])) {
    return { valid: false, plan: 'free', error: `Invalid plan: ${plan}` }
  }

  const expires = parseInt(expiresStr, 10)
  if (isNaN(expires)) {
    return { valid: false, plan: 'free', error: 'Invalid expiry timestamp' }
  }

  // Verify HMAC
  const expected = hmacSign(plan + expires)
  if (sig !== expected) {
    return { valid: false, plan: 'free', error: 'Invalid signature' }
  }

  // Check expiry
  if (Date.now() > expires) {
    return { valid: false, plan: 'free', expires, error: 'Key expired' }
  }

  return { valid: true, plan: plan as Plan, expires }
}

export function getPlan(configPath?: string): LicenseInfo {
  const cfgPath = configPath || join(homedir(), '.mem-ria', 'config.json')

  if (!existsSync(cfgPath)) {
    return { valid: false, plan: 'free' }
  }

  try {
    const config = JSON.parse(readFileSync(cfgPath, 'utf8'))
    const key = config.licenseKey
    if (!key) {
      return { valid: false, plan: 'free' }
    }
    return validateKey(key)
  } catch {
    return { valid: false, plan: 'free', error: 'Failed to read config' }
  }
}

export const LIMITS: Record<Plan, {
  maxEntries: number
  scheduler: boolean
  embeddings: boolean
  replay: boolean
  proactive: boolean
  httpApi: boolean
  multiAgent: boolean
  extractor: boolean
}> = {
  free: { maxEntries: 100, scheduler: false, embeddings: false, replay: false, proactive: false, httpApi: false, multiAgent: false, extractor: false },
  starter: { maxEntries: 10_000, scheduler: true, embeddings: true, replay: true, proactive: false, httpApi: true, multiAgent: false, extractor: false },
  pro: { maxEntries: 100_000, scheduler: true, embeddings: true, replay: true, proactive: true, httpApi: true, multiAgent: false, extractor: true },
  team: { maxEntries: 500_000, scheduler: true, embeddings: true, replay: true, proactive: true, httpApi: true, multiAgent: true, extractor: true },
}
