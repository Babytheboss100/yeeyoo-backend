// /api/tony — Tony Chat backend (Sesjon I, PRIO 1).
//
// Multi-provider dispatcher: claude (Anthropic), gpt-4o (OpenAI), gemini
// (Google AI), grok (xAI), deepseek (DeepSeek). xAI og DeepSeek bruker
// OpenAI-kompatibel API-shape så de deler samme handler.
//
// Tabeller: tony_conversations, tony_messages (Sesjon I-migrasjon).
// Auth: krever Bearer JWT — `auth`-middleware setter req.user.

import { Router } from 'express'
import crypto from 'crypto'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { checkAILimit, logAIUsage } from '../middleware/aiLimit.js'

const r = Router()
r.use(auth)

// ── Provider-konfig ──────────────────────────────────────────────────
// Hvert kall sender { system, messages, model } i normalisert form og
// får tilbake { reply, tokensIn, tokensOut }. Hvis API-nøkkelen mangler
// kaster funksjonen — vi mapper det til en pen 503 i route-handleren.

const PROVIDERS = {
  claude: {
    env: 'ANTHROPIC_API_KEY',
    model: 'claude-sonnet-5',
    call: callAnthropic,
  },
  'gpt-4o': {
    env: 'OPENAI_API_KEY',
    model: 'gpt-4o',
    call: (opts) => callOpenAICompat('https://api.openai.com/v1/chat/completions', opts),
  },
  gemini: {
    env: 'GEMINI_API_KEY',
    model: 'gemini-2.5-flash',
    call: callGemini,
  },
  grok: {
    env: 'GROK_API_KEY',
    model: 'grok-2-1212',
    call: (opts) => callOpenAICompat('https://api.x.ai/v1/chat/completions', opts),
  },
  deepseek: {
    env: 'DEEPSEEK_API_KEY',
    model: 'deepseek-chat',
    call: (opts) => callOpenAICompat('https://api.deepseek.com/v1/chat/completions', opts),
  },
}

const SYSTEM_PROMPT =
  'Du er Tony — en norsktalende AI-assistent for markedsføring og innholdsproduksjon. ' +
  'Svar konsist, profesjonelt og handlingsorientert. Bruk markdown for struktur når det hjelper. ' +
  'Hvis brukeren skriver på engelsk eller portugisisk, svar på samme språk.'

// ── Provider-implementasjoner ────────────────────────────────────────

async function callAnthropic({ apiKey, model, messages }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      // Anthropic vil ha [{role:'user'|'assistant', content:[{type:'text', text}]}]
      messages: messages.map((m) => ({
        role: m.role === 'system' ? 'user' : m.role,
        content: m.content,
      })),
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`anthropic ${res.status}: ${body.slice(0, 300)}`)
  }
  const data = await res.json()
  const reply = data.content?.[0]?.text || ''
  return {
    reply,
    tokensIn: data.usage?.input_tokens ?? null,
    tokensOut: data.usage?.output_tokens ?? null,
  }
}

async function callOpenAICompat(url, { apiKey, model, messages }) {
  // OpenAI / xAI / DeepSeek deler samme chat-completions-shape
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      max_tokens: 2048,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`openai-compat ${res.status}: ${body.slice(0, 300)}`)
  }
  const data = await res.json()
  const reply = data.choices?.[0]?.message?.content || ''
  return {
    reply,
    tokensIn: data.usage?.prompt_tokens ?? null,
    tokensOut: data.usage?.completion_tokens ?? null,
  }
}

async function callGemini({ apiKey, model, messages }) {
  // Gemini bruker contents[]-format. Vi mapper user→user, assistant→model.
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { maxOutputTokens: 2048 },
      }),
    }
  )
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`gemini ${res.status}: ${body.slice(0, 300)}`)
  }
  const data = await res.json()
  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
  return {
    reply,
    tokensIn: data.usageMetadata?.promptTokenCount ?? null,
    tokensOut: data.usageMetadata?.candidatesTokenCount ?? null,
  }
}

// ── Routes ───────────────────────────────────────────────────────────

// POST /api/tony/chat
//   body { projectId?, model, messages: [{role, content}], conversationId? }
//   resp { reply, conversationId, message_id }
r.post('/chat', checkAILimit('tony_chat'), async (req, res) => {
  const { projectId, model = 'claude', messages, conversationId } = req.body || {}
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages må være ikke-tom liste' })
  }
  const provider = PROVIDERS[model]
  if (!provider) return res.status(400).json({ error: `Ukjent modell: ${model}` })

  const apiKey = process.env[provider.env]
  if (!apiKey) {
    return res.status(503).json({
      error: `Provider ${model} er ikke konfigurert (mangler ${provider.env} på server).`,
    })
  }

  // Hent siste user-melding — det er den vi lagrer som ny rad. Tidligere
  // turn-pairs antas allerede lagret hvis conversationId finnes.
  const last = messages[messages.length - 1]
  if (last.role !== 'user') {
    return res.status(400).json({ error: 'Siste melding må være fra bruker' })
  }

  try {
    // 1) Sørg for at vi har en conversation-rad
    let convoId = conversationId
    if (!convoId) {
      convoId = crypto.randomUUID()
      const title = (last.content || '').slice(0, 80) || 'Ny samtale'
      await pool.query(
        `INSERT INTO tony_conversations (id, user_id, project_id, title, model)
         VALUES ($1, $2, $3, $4, $5)`,
        [convoId, req.user.id, projectId || null, title, model]
      )
    } else {
      // Verify ownership
      const { rows } = await pool.query(
        'SELECT id FROM tony_conversations WHERE id=$1 AND user_id=$2',
        [convoId, req.user.id]
      )
      if (!rows[0]) return res.status(404).json({ error: 'Samtale ikke funnet' })
    }

    // 2) Lagre user-meldingen
    const userMsgId = crypto.randomUUID()
    await pool.query(
      `INSERT INTO tony_messages (id, conversation_id, role, content)
       VALUES ($1, $2, 'user', $3)`,
      [userMsgId, convoId, last.content]
    )

    // 3) Kall AI-provider
    const { reply, tokensIn, tokensOut } = await provider.call({
      apiKey,
      model: provider.model,
      messages,
    })

    // 4) Lagre assistant-svar
    const asstMsgId = crypto.randomUUID()
    await pool.query(
      `INSERT INTO tony_messages (id, conversation_id, role, content, tokens_in, tokens_out)
       VALUES ($1, $2, 'assistant', $3, $4, $5)`,
      [asstMsgId, convoId, reply, tokensIn, tokensOut]
    )

    // 5) Bump updated_at på conversation
    await pool.query(
      `UPDATE tony_conversations SET updated_at=NOW() WHERE id=$1`,
      [convoId]
    )

    // 6) Logg AI-bruk (kostnadssporing + grensetelling)
    await logAIUsage({ userId: req.user.id, endpoint: 'tony_chat', tokensIn, tokensOut })

    res.json({ reply, conversationId: convoId, message_id: asstMsgId })
  } catch (e) {
    console.error('[tony/chat]', e.message)
    res.status(500).json({ error: 'AI-providere svarte ikke som forventet. Prøv igjen eller bytt modell.' })
  }
})

// GET /api/tony/conversations?projectId=
r.get('/conversations', async (req, res) => {
  const { projectId } = req.query
  try {
    const params = [req.user.id]
    let where = 'user_id = $1'
    if (projectId) {
      params.push(projectId)
      where += ` AND project_id = $${params.length}`
    }
    const { rows } = await pool.query(
      `SELECT id, title, model, created_at, updated_at
       FROM tony_conversations
       WHERE ${where}
       ORDER BY updated_at DESC
       LIMIT 100`,
      params
    )
    res.json(rows)
  } catch (e) {
    console.error('[tony/conversations]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// GET /api/tony/conversations/:id
r.get('/conversations/:id', async (req, res) => {
  const { id } = req.params
  try {
    const { rows: convo } = await pool.query(
      `SELECT id, title, model, created_at, updated_at
       FROM tony_conversations
       WHERE id=$1 AND user_id=$2`,
      [id, req.user.id]
    )
    if (!convo[0]) return res.status(404).json({ error: 'Samtale ikke funnet' })

    const { rows: messages } = await pool.query(
      `SELECT id, role, content, created_at
       FROM tony_messages
       WHERE conversation_id=$1
       ORDER BY created_at ASC`,
      [id]
    )
    res.json({ ...convo[0], messages })
  } catch (e) {
    console.error('[tony/conversations/:id]', e.message)
    res.status(500).json({ error: e.message })
  }
})

export default r
