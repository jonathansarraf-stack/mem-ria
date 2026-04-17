// Cortex Cloud — Stripe webhook (checkout.session.completed → license key)

import { Hono } from 'hono'
import { createHmac } from 'node:crypto'
import { generateKey } from '@mem-ria/core'
import { getUserByEmail, createUser, upsertSubscription } from './db.js'
import { sendLicenseKeyEmail } from './email.js'

// Price ID → plan mapping
const PRICE_TO_PLAN: Record<string, string> = {
  [process.env.STRIPE_STARTER_PRICE || 'price_1TMxhfLHsKvnkVcsmCSQk7cS']: 'starter',
  [process.env.STRIPE_PRO_PRICE || 'price_1TMxhfLHsKvnkVcs4XW1qEyV']: 'pro',
  [process.env.STRIPE_TEAM_PRICE || 'price_1TMxhgLHsKvnkVcs4ZPP6eql']: 'team',
}

function getStripeSecret(): string {
  const sk = process.env.STRIPE_SK
  if (!sk) throw new Error('STRIPE_SK env var required')
  return sk
}

// Verify Stripe webhook signature
function verifyStripeSignature(payload: string, sigHeader: string, secret: string): boolean {
  const parts = sigHeader.split(',')
  const timestamp = parts.find(p => p.startsWith('t='))?.slice(2)
  const v1Sig = parts.find(p => p.startsWith('v1='))?.slice(3)

  if (!timestamp || !v1Sig) return false

  // Reject if timestamp is more than 5 minutes old
  const age = Math.abs(Date.now() / 1000 - parseInt(timestamp))
  if (age > 300) return false

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`)
    .digest('hex')

  return expected === v1Sig
}

export function createStripeRoutes(): Hono {
  const stripe = new Hono()

  // POST /webhook — Stripe sends events here
  stripe.post('/webhook', async (c) => {
    const rawBody = await c.req.text()
    const sig = c.req.header('stripe-signature')

    // If STRIPE_WEBHOOK_SECRET is set, verify signature
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
    if (webhookSecret && sig) {
      if (!verifyStripeSignature(rawBody, sig, webhookSecret)) {
        console.error('[cortex-cloud] Stripe signature verification failed')
        return c.json({ error: 'Invalid signature' }, 400)
      }
    }

    let event: any
    try {
      event = JSON.parse(rawBody)
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }

    console.log(`[cortex-cloud] Stripe event: ${event.type} (${event.id})`)

    if (event.type === 'checkout.session.completed') {
      await handleCheckoutComplete(event.data.object)
    } else if (event.type === 'customer.subscription.deleted') {
      await handleSubscriptionCanceled(event.data.object)
    } else if (event.type === 'customer.subscription.updated') {
      await handleSubscriptionUpdated(event.data.object)
    }

    return c.json({ received: true })
  })

  return stripe
}

async function handleCheckoutComplete(session: any): Promise<void> {
  const email = session.customer_email || session.customer_details?.email
  if (!email) {
    console.error('[cortex-cloud] checkout.session.completed: no email found', session.id)
    return
  }

  const customerId = session.customer
  const subscriptionId = session.subscription

  // Determine plan from line items price
  let plan = 'starter' // default
  if (session.metadata?.plan) {
    plan = session.metadata.plan
  } else {
    // Fetch subscription to get price ID → plan
    try {
      const subData = await fetchStripeSubscription(subscriptionId)
      if (subData?.items?.data?.[0]?.price?.id) {
        const priceId = subData.items.data[0].price.id
        plan = PRICE_TO_PLAN[priceId] || 'starter'
      }
    } catch (err) {
      console.error('[cortex-cloud] Failed to fetch subscription details:', err)
    }
  }

  console.log(`[cortex-cloud] New subscription: ${email} → ${plan}`)

  // Generate license key (valid 365 days)
  const licenseKey = generateKey(plan, 365)

  // Find or note user (they may not have signed up yet)
  let user = getUserByEmail(email)
  if (!user) {
    // Create a placeholder user — they'll set password on first login
    // For now, store with a random hash (can't login with password until they signup)
    const { randomBytes } = await import('node:crypto')
    const { hash } = await import('bcryptjs')
    const placeholder = await hash(randomBytes(32).toString('hex'), 10)
    const { createUser: create } = await import('./db.js')
    user = create(email, placeholder, '')
    // Auto-verify since they paid
    const { setEmailVerified } = await import('./db.js')
    setEmailVerified(user.id)
    console.log(`[cortex-cloud] Created placeholder user for ${email}`)
  }

  // Upsert subscription
  upsertSubscription(user.id, {
    plan,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    status: 'active',
    license_key: licenseKey,
  })

  // Send license key email
  sendLicenseKeyEmail(email, licenseKey, plan).catch(err =>
    console.error('[cortex-cloud] Failed to send license email:', err)
  )
}

async function handleSubscriptionCanceled(sub: any): Promise<void> {
  const customerId = sub.customer
  if (!customerId) return

  // Find user by stripe_customer_id
  const { getDB } = await import('./db.js')
  const row = getDB().prepare(
    'SELECT user_id FROM subscriptions WHERE stripe_customer_id = ?'
  ).get(customerId) as { user_id: string } | undefined

  if (row) {
    upsertSubscription(row.user_id, { status: 'canceled', plan: 'free', license_key: null })
    console.log(`[cortex-cloud] Subscription canceled for customer ${customerId}`)
  }
}

async function handleSubscriptionUpdated(sub: any): Promise<void> {
  const customerId = sub.customer
  if (!customerId) return

  const { getDB } = await import('./db.js')
  const row = getDB().prepare(
    'SELECT user_id FROM subscriptions WHERE stripe_customer_id = ?'
  ).get(customerId) as { user_id: string } | undefined

  if (!row) return

  // Check if status changed
  const status = sub.status === 'active' ? 'active' : sub.status === 'past_due' ? 'past_due' : 'canceled'
  upsertSubscription(row.user_id, { status })

  // If plan changed, check price and update
  if (sub.items?.data?.[0]?.price?.id) {
    const priceId = sub.items.data[0].price.id
    const newPlan = PRICE_TO_PLAN[priceId]
    if (newPlan) {
      const licenseKey = generateKey(newPlan, 365)
      upsertSubscription(row.user_id, { plan: newPlan, license_key: licenseKey })
      console.log(`[cortex-cloud] Subscription updated: customer ${customerId} → ${newPlan}`)
    }
  }
}

// Fetch subscription from Stripe API to get price ID
async function fetchStripeSubscription(subscriptionId: string): Promise<any> {
  if (!subscriptionId) return null
  const sk = getStripeSecret()
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
    headers: { 'Authorization': `Bearer ${sk}` },
  })
  if (!res.ok) {
    console.error(`[cortex-cloud] Stripe API error: ${res.status}`)
    return null
  }
  return res.json()
}
