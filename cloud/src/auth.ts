// Cortex Cloud — Auth routes (signup, login 2-step OTP, me, refresh, logout)

import { Hono } from 'hono'
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import bcrypt from 'bcryptjs'
const { hash: bcryptHash, compare: bcryptCompare } = bcrypt
import jwt from 'jsonwebtoken'
import {
  createUser, getUserByEmail, getUserById, setEmailVerified,
  getSubscription, createLoginAttempt, getLoginAttempt,
  incrementLoginAttempts, consumeLoginAttempt,
  createRefreshSession, getRefreshSession, touchRefreshSession,
  deleteRefreshSession, deleteUserRefreshSessions,
} from './db.js'
import { sendOTPEmail } from './email.js'

function getJwtSecret(): string {
  const s = process.env.JWT_SECRET
  if (!s) throw new Error('JWT_SECRET env var required')
  return s
}

const SALT_ROUNDS = 12

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

function randToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url')
}

function genOTP(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

function issueAccessToken(user: { id: string; email: string; name: string }): string {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name },
    getJwtSecret(),
    { expiresIn: '1h', issuer: 'cortex-cloud', audience: 'cortex' }
  )
}

// Simple in-memory rate limiter
const rateBuckets = new Map<string, { count: number; reset: number }>()

function rateLimit(key: string, max: number, windowMs = 60_000): boolean {
  const now = Date.now()
  const bucket = rateBuckets.get(key)
  if (!bucket || now > bucket.reset) {
    rateBuckets.set(key, { count: 1, reset: now + windowMs })
    return true
  }
  bucket.count++
  return bucket.count <= max
}

// JWT verification middleware
export function requireAuth() {
  return async (c: any, next: any) => {
    const authHeader = c.req.header('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing authorization' }, 401)
    }
    const token = authHeader.slice(7)
    try {
      const payload = jwt.verify(token, getJwtSecret(), { issuer: 'cortex-cloud', audience: 'cortex' }) as jwt.JwtPayload
      c.set('user', { id: payload.sub, email: payload.email, name: payload.name })
      await next()
    } catch {
      return c.json({ error: 'Invalid or expired token' }, 401)
    }
  }
}

export function createAuthRoutes(): Hono {
  const auth = new Hono()

  // POST /signup — create account
  auth.post('/signup', async (c) => {
    const ip = c.req.header('x-forwarded-for') || 'unknown'
    if (!rateLimit(`signup:${ip}`, 5)) {
      return c.json({ error: 'Too many requests' }, 429)
    }

    let body: { email?: string; password?: string; name?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const { email, password, name } = body
    if (!email || !password) {
      return c.json({ error: 'Email and password required' }, 400)
    }
    if (password.length < 8) {
      return c.json({ error: 'Password must be at least 8 characters' }, 400)
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ error: 'Invalid email format' }, 400)
    }

    const existing = getUserByEmail(email)
    if (existing) {
      return c.json({ error: 'Email already registered' }, 409)
    }

    const passwordHash = await bcryptHash(password, SALT_ROUNDS)
    const user = createUser(email, passwordHash, name || '')

    // For v1: auto-verify email (no verification step needed, OTP on login is enough)
    setEmailVerified(user.id)

    return c.json({ ok: true, message: 'Account created. You can now login.' })
  })

  // POST /login — step 1: email + password → send OTP
  auth.post('/login', async (c) => {
    const ip = c.req.header('x-forwarded-for') || 'unknown'
    if (!rateLimit(`login:${ip}`, 10)) {
      return c.json({ error: 'Too many requests' }, 429)
    }

    let body: { email?: string; password?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const { email, password } = body
    if (!email || !password) {
      return c.json({ error: 'Email and password required' }, 400)
    }

    const user = getUserByEmail(email)

    // Timing-safe: always run bcrypt even if user not found
    if (!user) {
      await bcryptCompare(password, '$2b$12$dummyhashtopreventtimingattacksxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
      return c.json({ error: 'Invalid credentials' }, 401)
    }

    const valid = await bcryptCompare(password, user.password_hash)
    if (!valid) {
      return c.json({ error: 'Invalid credentials' }, 401)
    }

    if (!user.email_verified) {
      return c.json({ error: 'Email not verified' }, 403)
    }

    // Generate OTP + login token
    const otp = genOTP()
    const loginToken = randToken(24)
    const otpHash = sha256(otp + ':' + loginToken)
    const tokenHash = sha256(loginToken)

    createLoginAttempt(tokenHash, user.id, otpHash)

    // Send OTP email (fire-and-forget for speed, but log errors)
    sendOTPEmail(user.email, otp).catch(err => console.error('[cortex-cloud] OTP email failed:', err))

    return c.json({
      ok: true,
      step: 2,
      login_token: loginToken,
      expires_in: 300,
    })
  })

  // POST /verify — step 2: login_token + OTP → JWT
  auth.post('/verify', async (c) => {
    const ip = c.req.header('x-forwarded-for') || 'unknown'
    if (!rateLimit(`verify:${ip}`, 20)) {
      return c.json({ error: 'Too many requests' }, 429)
    }

    let body: { login_token?: string; code?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const { login_token, code } = body
    if (!login_token || !code) {
      return c.json({ error: 'login_token and code required' }, 400)
    }

    const tokenHash = sha256(login_token)
    const attempt = getLoginAttempt(tokenHash)

    if (!attempt) {
      return c.json({ error: 'Invalid login token' }, 401)
    }
    if (attempt.consumed) {
      return c.json({ error: 'Login token already used' }, 401)
    }
    if (Date.now() > attempt.expires) {
      return c.json({ error: 'Login token expired' }, 401)
    }
    if (attempt.attempts >= 5) {
      return c.json({ error: 'Too many OTP attempts' }, 401)
    }

    incrementLoginAttempts(tokenHash)

    // Verify OTP (constant-time via hash comparison)
    const expectedHash = sha256(code + ':' + login_token)
    const a = Buffer.from(attempt.otp_hash)
    const b = Buffer.from(expectedHash)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return c.json({ error: 'Invalid code', attempts_left: 5 - attempt.attempts - 1 }, 401)
    }

    consumeLoginAttempt(tokenHash)

    const user = getUserById(attempt.user_id)
    if (!user) {
      return c.json({ error: 'User not found' }, 500)
    }

    // Issue access token
    const accessToken = issueAccessToken(user)

    // Create refresh session
    const refreshToken = randToken(32)
    const refreshHash = sha256(refreshToken)
    const ua = c.req.header('User-Agent')
    createRefreshSession(refreshHash, user.id, ua, ip)

    // Get subscription
    const sub = getSubscription(user.id)

    return c.json({
      ok: true,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        plan: sub?.plan || 'free',
        subscription_status: sub?.status || 'inactive',
      },
    })
  })

  // POST /refresh — refresh access token
  auth.post('/refresh', async (c) => {
    let body: { refresh_token?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    const { refresh_token } = body
    if (!refresh_token) {
      return c.json({ error: 'refresh_token required' }, 400)
    }

    const hash = sha256(refresh_token)
    const session = getRefreshSession(hash)

    if (!session) {
      return c.json({ error: 'Invalid refresh token' }, 401)
    }
    if (Date.now() > session.expires) {
      deleteRefreshSession(hash)
      return c.json({ error: 'Refresh token expired' }, 401)
    }

    const user = getUserById(session.user_id)
    if (!user) {
      deleteRefreshSession(hash)
      return c.json({ error: 'User not found' }, 401)
    }

    touchRefreshSession(hash)
    const accessToken = issueAccessToken(user)
    const sub = getSubscription(user.id)

    return c.json({
      ok: true,
      access_token: accessToken,
      expires_in: 3600,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        plan: sub?.plan || 'free',
        subscription_status: sub?.status || 'inactive',
      },
    })
  })

  // GET /me — current user info + subscription
  auth.get('/me', requireAuth(), async (c) => {
    const { id } = c.get('user')
    const user = getUserById(id)
    if (!user) return c.json({ error: 'User not found' }, 404)

    const sub = getSubscription(user.id)

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        created: user.created,
        plan: sub?.plan || 'free',
        subscription_status: sub?.status || 'inactive',
        license_key: sub?.license_key || null,
      },
    })
  })

  // POST /logout — invalidate refresh token
  auth.post('/logout', async (c) => {
    let body: { refresh_token?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    if (body.refresh_token) {
      deleteRefreshSession(sha256(body.refresh_token))
    }

    return c.json({ ok: true })
  })

  return auth
}
