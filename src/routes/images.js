import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { pool } from '../db.js'
import { renderBrandedImageSafe } from '../services/imageRenderer.js'

const r = Router()
r.use(auth)

const IMAGE_PROVIDER = process.env.IMAGE_PROVIDER || 'puppeteer' // 'puppeteer' | 'dalle'

function buildDallePrompt(content, platform) {
  const clean = content.replace(/[#@\n\r]/g, ' ').replace(/\s+/g, ' ').trim()
  const postText = clean.substring(0, 300)
  const p = platform?.toLowerCase() || 'linkedin'
  return `Professional social media photo for ${p}, ${postText}, ultra high quality, sharp, vibrant colors, modern aesthetic, 4K, no text, no watermarks, photorealistic`
}

async function generateWithDalle(content, platform) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OpenAI API-nøkkel ikke konfigurert')

  const promptText = buildDallePrompt(content, platform)
  console.log('[IMAGE] DALL-E fallback for:', platform)

  const aiRes = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'dall-e-3', prompt: promptText, n: 1,
      size: '1792x1024', quality: 'standard', response_format: 'b64_json'
    })
  })

  if (!aiRes.ok) {
    const errBody = await aiRes.text()
    throw new Error(`DALL-E ${aiRes.status}: ${errBody.substring(0, 200)}`)
  }

  const json = await aiRes.json()
  const b64 = json.data?.[0]?.b64_json
  if (!b64) throw new Error('Ingen bildedata i DALL-E respons')

  return `data:image/png;base64,${b64}`
}

// POST /api/images/generate — unified image generation
// Tries Puppeteer first (fast, free), falls back to DALL-E
r.post('/generate', async (req, res) => {
  const { postId, content, text, platform, projectName } = req.body
  const imageText = text || content
  if (!imageText) return res.status(400).json({ error: 'Tekst/innhold mangler' })

  try {
    let image = null
    let provider = null

    if (IMAGE_PROVIDER !== 'dalle') {
      // Try Puppeteer first
      image = await renderBrandedImageSafe(imageText, platform, projectName, 5000)
      if (image) provider = 'puppeteer'
    }

    if (!image) {
      // Fall back to DALL-E
      try {
        image = await generateWithDalle(imageText, platform)
        provider = 'dalle'
      } catch (dalleErr) {
        console.error('[IMAGE] DALL-E fallback also failed:', dalleErr.message)
        return res.status(500).json({ error: 'Bildegenerering feilet (begge metoder)' })
      }
    }

    // Save to post if postId provided
    if (postId) {
      await pool.query('UPDATE posts SET image_url = $1 WHERE id = $2 AND user_id = $3', [image, postId, req.user.id])
    }

    console.log(`[IMAGE] Generated via ${provider} for ${platform}`)
    res.json({ image, format: 'png', provider })
  } catch (e) {
    console.error('[IMAGE] Error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Keep /branded as alias for backwards compatibility
r.post('/branded', async (req, res) => {
  req.url = '/generate'
  r.handle(req, res)
})

export default r
