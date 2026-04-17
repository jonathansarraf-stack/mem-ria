// Cortex Cloud — Database layer (SQLite via better-sqlite3)

import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export interface User {
  id: string
  email: string
  name: string
  password_hash: string
  email_verified: number
  created: number
  updated: number
}

export interface Subscription {
  user_id: string
  plan: string
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  status: string
  license_key: string | null
  created: number
  updated: number
}

export interface LoginAttempt {
  login_token_hash: string
  user_id: string
  otp_hash: string
  expires: number
  attempts: number
  consumed: number
  created: number
}

export interface RefreshSession {
  token_hash: string
  user_id: string
  expires: number
  user_agent: string | null
  ip: string | null
  created: number
  last_used: number
}

let _db: Database.Database

export function initDB(dbPath: string): Database.Database {
  _db = new Database(dbPath)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')

  _db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL,
      updated INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      plan TEXT NOT NULL DEFAULT 'free',
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      status TEXT NOT NULL DEFAULT 'inactive',
      license_key TEXT,
      created INTEGER NOT NULL,
      updated INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS login_attempts (
      login_token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      otp_hash TEXT NOT NULL,
      expires INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      consumed INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS refresh_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      expires INTEGER NOT NULL,
      user_agent TEXT,
      ip TEXT,
      created INTEGER NOT NULL,
      last_used INTEGER NOT NULL
    );
  `)

  // Cleanup expired rows every 15 min
  setInterval(() => cleanupExpired(), 15 * 60 * 1000)

  return _db
}

export function getDB(): Database.Database {
  if (!_db) throw new Error('Database not initialized. Call initDB() first.')
  return _db
}

// --- Users ---

export function createUser(email: string, passwordHash: string, name: string): User {
  const db = getDB()
  const now = Date.now()
  const id = randomUUID()
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, email_verified, created, updated)
     VALUES (?, ?, ?, ?, 0, ?, ?)`
  ).run(id, email.toLowerCase().trim(), name, passwordHash, now, now)
  return { id, email: email.toLowerCase().trim(), name, password_hash: passwordHash, email_verified: 0, created: now, updated: now }
}

export function getUserByEmail(email: string): User | undefined {
  return getDB().prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim()) as User | undefined
}

export function getUserById(id: string): User | undefined {
  return getDB().prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined
}

export function setEmailVerified(userId: string): void {
  getDB().prepare('UPDATE users SET email_verified = 1, updated = ? WHERE id = ?').run(Date.now(), userId)
}

// --- Subscriptions ---

export function getSubscription(userId: string): Subscription | undefined {
  return getDB().prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(userId) as Subscription | undefined
}

export function upsertSubscription(userId: string, data: Partial<Subscription>): void {
  const db = getDB()
  const now = Date.now()
  const existing = getSubscription(userId)
  if (existing) {
    const fields: string[] = []
    const values: unknown[] = []
    for (const [k, v] of Object.entries(data)) {
      if (k !== 'user_id' && k !== 'created') {
        fields.push(`${k} = ?`)
        values.push(v)
      }
    }
    fields.push('updated = ?')
    values.push(now, userId)
    db.prepare(`UPDATE subscriptions SET ${fields.join(', ')} WHERE user_id = ?`).run(...values)
  } else {
    db.prepare(
      `INSERT INTO subscriptions (user_id, plan, stripe_customer_id, stripe_subscription_id, status, license_key, created, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(userId, data.plan || 'free', data.stripe_customer_id || null, data.stripe_subscription_id || null, data.status || 'inactive', data.license_key || null, now, now)
  }
}

// --- Login attempts ---

export function createLoginAttempt(tokenHash: string, userId: string, otpHash: string): void {
  const now = Date.now()
  const expires = now + 5 * 60 * 1000 // 5 min
  getDB().prepare(
    `INSERT INTO login_attempts (login_token_hash, user_id, otp_hash, expires, attempts, consumed, created)
     VALUES (?, ?, ?, ?, 0, 0, ?)`
  ).run(tokenHash, userId, otpHash, expires, now)
}

export function getLoginAttempt(tokenHash: string): LoginAttempt | undefined {
  return getDB().prepare('SELECT * FROM login_attempts WHERE login_token_hash = ?').get(tokenHash) as LoginAttempt | undefined
}

export function incrementLoginAttempts(tokenHash: string): void {
  getDB().prepare('UPDATE login_attempts SET attempts = attempts + 1 WHERE login_token_hash = ?').run(tokenHash)
}

export function consumeLoginAttempt(tokenHash: string): void {
  getDB().prepare('UPDATE login_attempts SET consumed = 1 WHERE login_token_hash = ?').run(tokenHash)
}

// --- Refresh sessions ---

export function createRefreshSession(tokenHash: string, userId: string, userAgent?: string, ip?: string): void {
  const now = Date.now()
  const expires = now + 30 * 24 * 60 * 60 * 1000 // 30 days
  getDB().prepare(
    `INSERT INTO refresh_sessions (token_hash, user_id, expires, user_agent, ip, created, last_used)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(tokenHash, userId, expires, userAgent || null, ip || null, now, now)
}

export function getRefreshSession(tokenHash: string): RefreshSession | undefined {
  return getDB().prepare('SELECT * FROM refresh_sessions WHERE token_hash = ?').get(tokenHash) as RefreshSession | undefined
}

export function touchRefreshSession(tokenHash: string): void {
  getDB().prepare('UPDATE refresh_sessions SET last_used = ? WHERE token_hash = ?').run(Date.now(), tokenHash)
}

export function deleteRefreshSession(tokenHash: string): void {
  getDB().prepare('DELETE FROM refresh_sessions WHERE token_hash = ?').run(tokenHash)
}

export function deleteUserRefreshSessions(userId: string): void {
  getDB().prepare('DELETE FROM refresh_sessions WHERE user_id = ?').run(userId)
}

// --- Cleanup ---

function cleanupExpired(): void {
  const now = Date.now()
  const db = getDB()
  db.prepare('DELETE FROM login_attempts WHERE expires < ?').run(now)
  db.prepare('DELETE FROM refresh_sessions WHERE expires < ?').run(now)
}
