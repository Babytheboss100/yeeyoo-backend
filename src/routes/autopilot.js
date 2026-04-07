import { Router } from 'express'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'

const r = Router()
r.use(auth)

r.post('/generate', async (req, res) => {
  const { url } = req.body
  if (!url) return res.status(400).json({ error: 'URL mangler' })

  try {
    // 1. Scrape with Jina Reader
    const jinaRes = await fetch(`https://r.jina.ai/${url}`, {
      headers: { 'Accept': 'text/plain' }
    })
    if (!jinaRes.ok) throw new Error('Kunne ikke hente innhold fra URL')
    const scraped = await jinaRes.text()
    const content = scraped.substring(0, 15000)

    // 2. Generate posts with Gemini Flash
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) return res.status(503).json({ error: 'Gemini API-nøkkel ikke konfigurert' })

    const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: 'You are a social media expert. Always respond with valid JSON only, no markdown fences.' }] },
        contents: [{ parts: [{ text: `Based on this website content, generate 5 social media posts (mix of LinkedIn, Instagram, Facebook). Return a JSON array where each item has: "platform" (linkedin|instagram|facebook), "content" (the post text), "hashtags" (string of hashtags).\n\nWebsite content:\n${content}` }] }],
        generationConfig: { maxOutputTokens: 2000 }
      })
    })
    if (!aiRes.ok) {
      const e = await aiRes.json()
      throw new Error(e.error?.message || 'Gemini feil')
    }
    const aiData = await aiRes.json()
    let raw = aiData.candidates[0].content.parts[0].text
    // Strip markdown fences if present
    raw = raw.replace(/```json\s*/i, '').replace(/```\s*$/, '').trim()
    const posts = JSON.parse(raw)

    // 3. Insert into posts table with status=pending
    const saved = []
    for (const p of posts) {
      const { rows } = await pool.query(
        `INSERT INTO posts (user_id, platform, content, hashtags, status, ai_model)
         VALUES ($1, $2, $3, $4, 'pending', 'gemini') RETURNING *`,
        [req.user.id, p.platform, p.content, p.hashtags || '']
      )
      saved.push(rows[0])
    }

    res.json({ posts: saved, source: url })
  } catch (e) {
    console.error('Autopilot error:', e)
    res.status(500).json({ error: e.message })
  }
})

export default r
