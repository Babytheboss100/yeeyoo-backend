import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { pool } from '../db.js'
import { renderBrandedImageSafe } from '../services/imageRenderer.js'
import { fal } from '@fal-ai/client'

const r = Router()
r.use(auth)

// Configure fal.ai client
fal.config({ credentials: () => process.env.FAL_KEY })

const PLATFORM_SIZES = {
  linkedin:  { width: 1792, height: 1024, aspect_ratio: '16:9' },
  facebook:  { width: 1792, height: 1024, aspect_ratio: '16:9' },
  twitter:   { width: 1792, height: 1024, aspect_ratio: '16:9' },
  instagram: { width: 1024, height: 1024, aspect_ratio: '1:1' },
  tiktok:    { width: 1024, height: 1792, aspect_ratio: '9:16' },
  email:     { width: 1792, height: 1024, aspect_ratio: '16:9' },
}

function buildFluxPrompt(content, platform) {
  const clean = content.replace(/[#@\n\r]/g, ' ').replace(/\s+/g, ' ').trim()
  const postText = clean.substring(0, 300)
  const p = platform?.toLowerCase() || 'linkedin'
  return `Professional social media photo for ${p}, ${postText}, ultra high quality, sharp, vibrant colors, modern aesthetic, 4K, no text, no watermarks, photorealistic`
}

async function generateWithFlux(content, platform) {
  const apiKey = process.env.FAL_KEY
  if (!apiKey) throw new Error('FAL_KEY ikke konfigurert')

  const promptText = buildFluxPrompt(content, platform)
  const size = PLATFORM_SIZES[platform?.toLowerCase()] || PLATFORM_SIZES.linkedin
  console.log('[IMAGE] FLUX called — platform:', platform, '| aspect:', size.aspect_ratio)
  console.log('[IMAGE] FLUX prompt:', promptText.substring(0, 200))

  const result = await fal.subscribe('fal-ai/flux-pro/v1.1-ultra', {
    input: {
      prompt: promptText,
      aspect_ratio: size.aspect_ratio,
      output_format: 'png',
      safety_tolerance: '5',
    },
  })

  console.log('[IMAGE] FLUX response:', JSON.stringify({ images: result.data?.images?.length, requestId: result.requestId, keys: Object.keys(result.data || {}) }))

  const imageUrl = result.data?.images?.[0]?.url
  if (!imageUrl) {
    console.error('[IMAGE] FLUX no image URL in response:', JSON.stringify(result.data).substring(0, 500))
    throw new Error('Ingen bildedata i FLUX respons')
  }

  // Fetch image and convert to base64
  const imgRes = await fetch(imageUrl)
  if (!imgRes.ok) throw new Error(`Kunne ikke laste ned FLUX-bilde: ${imgRes.status}`)
  const buf = Buffer.from(await imgRes.arrayBuffer())
  return `data:image/png;base64,${buf.toString('base64')}`
}

// POST /api/images/generate — unified image generation
// Tries node-canvas first (fast, free), falls back to FLUX 1.1 Pro
r.post('/generate', async (req, res) => {
  const { postId, content, text, platform, projectName } = req.body
  const imageText = text || content
  console.log('[IMAGE] POST /generate hit — platform:', platform, '| postId:', postId, '| text length:', imageText?.length)
  if (!imageText) return res.status(400).json({ error: 'Tekst/innhold mangler' })

  try {
    let image = null
    let provider = null

    // Try node-canvas first (free branded images)
    image = await renderBrandedImageSafe(imageText, platform, projectName, 5000)
    if (image) provider = 'canvas'

    if (!image) {
      // Fall back to FLUX 1.1 Pro
      try {
        image = await generateWithFlux(imageText, platform)
        provider = 'flux'
      } catch (fluxErr) {
        console.error('[IMAGE] FLUX fallback also failed:', fluxErr.message)
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
