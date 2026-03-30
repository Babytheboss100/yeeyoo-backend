import { Router } from 'express'
import Stripe from 'stripe'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const r = Router()

// ─── Plandefinisjoner ─────────────────────────────────────────────────────────
export const PLANS = {
  free: {
    id: 'free',
    name: 'Gratis',
    price: 0,
    postsPerMonth: 999,
    projects: 1,
    aiModels: ['claude', 'gpt4o', 'gemini', 'grok', 'deepseek'],
    platforms: 4
  },
  starter: {
    id: 'starter',
    name: 'Grunnleggende',
    price: 29,
    priceId: process.env.STRIPE_PRICE_STARTER,
    postsPerMonth: 50,
    projects: 2,
    aiModels: ['claude', 'gpt4o'],
    platforms: 4
  },
  vekst: {
    id: 'vekst',
    name: 'Vekst',
    price: 79,
    priceId: process.env.STRIPE_PRICE_VEKST,
    postsPerMonth: 200,
    projects: 5,
    aiModels: ['claude', 'gpt4o', 'gemini', 'grok', 'deepseek'],
    platforms: 4
  },
  bedrift: {
    id: 'bedrift',
    name: 'Bedrift',
    price: 149,
    priceId: process.env.STRIPE_PRICE_BEDRIFT,
    postsPerMonth: -1, // ubegrenset
    projects: -1,
    aiModels: ['claude', 'gpt4o', 'gemini', 'grok', 'deepseek'],
    platforms: 4
  }
}

// ─── Hjelpefunksjon: hent eller opprett abonnement ────────────────────────────
async function getSubscription(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM subscriptions WHERE user_id=$1', [userId]
  )
  return rows[0] || { plan: 'free', status: 'active' }
}

// ─── GET /billing/plan — hent aktiv plan ──────────────────────────────────────
r.get('/plan', auth, async (req, res) => {
  try {
    const sub = await getSubscription(req.user.id)
    const plan = PLANS[sub.plan] || PLANS.free
    res.json({ subscription: sub, plan })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ─── GET /billing/usage — sjekk bruk denne måneden ───────────────────────────
r.get('/usage', auth, async (req, res) => {
  try {
    const sub = await getSubscription(req.user.id)
    const plan = PLANS[sub.plan] || PLANS.free

    // Tell poster denne måneden
    const { rows } = await pool.query(`
      SELECT COUNT(*) as count FROM posts
      WHERE user_id=$1
      AND created_at >= date_trunc('month', NOW())
    `, [req.user.id])

    const used = parseInt(rows[0].count)
    const limit = plan.postsPerMonth
    const remaining = limit === -1 ? -1 : Math.max(0, limit - used)
    const canGenerate = limit === -1 || used < limit

    res.json({ used, limit, remaining, canGenerate, plan: sub.plan })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ─── POST /billing/checkout — opprett Stripe checkout session ─────────────────
r.post('/checkout', auth, async (req, res) => {
  const { planId } = req.body
  const plan = PLANS[planId]
  if (!plan || !plan.priceId) return res.status(400).json({ error: 'Ugyldig plan' })

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id])
    const user = rows[0]

    // Hent eller opprett Stripe-kunde
    let customerId
    const sub = await getSubscription(req.user.id)
    if (sub.stripe_customer_id) {
      customerId = sub.stripe_customer_id
    } else {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        metadata: { userId: req.user.id }
      })
      customerId = customer.id
      await pool.query(
        `INSERT INTO subscriptions (user_id, stripe_customer_id, plan, status)
         VALUES ($1,$2,'free','active')
         ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id=$2`,
        [req.user.id, customerId]
      )
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: plan.priceId, quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL}/app?upgrade=success`,
      cancel_url: `${process.env.FRONTEND_URL}/app?upgrade=cancelled`,
      metadata: { userId: req.user.id, planId }
    })

    res.json({ url: session.url })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ─── POST /billing/portal — Stripe kundeportal (endre/kansellere) ─────────────
r.post('/portal', auth, async (req, res) => {
  try {
    const sub = await getSubscription(req.user.id)
    if (!sub.stripe_customer_id) return res.status(400).json({ error: 'Ingen aktiv plan' })

    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/app?tab=settings`
    })
    res.json({ url: session.url })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ─── POST /billing/webhook — Stripe events ───────────────────────────────────
r.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature']
  let event

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (e) {
    return res.status(400).json({ error: `Webhook feil: ${e.message}` })
  }

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object
        const { userId, planId } = session.metadata
        await pool.query(`
          INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, plan, status)
          VALUES ($1,$2,$3,$4,'active')
          ON CONFLICT (user_id) DO UPDATE SET
            stripe_customer_id=$2,
            stripe_subscription_id=$3,
            plan=$4, status='active',
            updated_at=NOW()
        `, [userId, session.customer, session.subscription, planId])
        break
      }

      case 'invoice.paid': {
        const invoice = event.data.object
        const sub = await stripe.subscriptions.retrieve(invoice.subscription)
        await pool.query(`
          UPDATE subscriptions SET
            status='active',
            current_period_end=to_timestamp($1),
            updated_at=NOW()
          WHERE stripe_subscription_id=$2
        `, [sub.current_period_end, invoice.subscription])
        break
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object
        const planId = Object.keys(PLANS).find(k =>
          PLANS[k].priceId === sub.items.data[0]?.price.id
        ) || 'free'
        await pool.query(`
          UPDATE subscriptions SET
            plan=$1, status=$2,
            current_period_end=to_timestamp($3),
            updated_at=NOW()
          WHERE stripe_subscription_id=$4
        `, [planId, sub.status, sub.current_period_end, sub.id])
        break
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object
        await pool.query(`
          UPDATE subscriptions SET plan='free', status='cancelled', updated_at=NOW()
          WHERE stripe_subscription_id=$1
        `, [sub.id])
        break
      }
    }
    res.json({ received: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default r
export { getSubscription }
