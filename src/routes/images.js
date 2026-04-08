import { Router } from 'express'
import { auth } from '../middleware/auth.js'

const r = Router()
r.use(auth)

function buildImagePrompt(content, platform) {
  // Extract key theme from post content
  const snippet = content.substring(0, 150).replace(/[#@\n]/g, ' ').trim()

  const platformStyle = {
    linkedin: 'corporate boardroom, professional handshake, laptop with financial dashboard',
    instagram: 'lifestyle wealth, modern apartment with city view, coffee and laptop',
    facebook: 'friendly business meeting, diverse team collaboration, bright office',
    tiktok: 'dynamic young professional, smartphone with trading app, energetic urban setting',
  }
  const scene = platformStyle[platform?.toLowerCase()] || platformStyle.linkedin

  return `Professional financial marketing photo. ${scene}. Context: ${snippet}. Clean modern Scandinavian office interior, Norwegian aesthetic, natural light, warm tones. High quality, photorealistic, sharp focus, suitable for social media ad. No text, no logos, no watermarks. 16:9 aspect ratio.`
}

r.post('/generate', async (req, res) => {
  const { content, platform } = req.body
  if (!content) return res.status(400).json({ error: 'Innhold mangler' })

  const apiKey = process.env.STABILITY_API_KEY
  if (!apiKey) return res.status(503).json({ error: 'Stability AI ikke konfigurert' })

  try {
    const promptText = buildImagePrompt(content, platform)
    console.log('Image generate: platform:', platform, '| prompt:', promptText.substring(0, 100))

    const formData = new FormData()
    formData.append('prompt', promptText)
    formData.append('output_format', 'webp')
    formData.append('aspect_ratio', '16:9')

    const aiRes = await fetch('https://api.stability.ai/v2beta/stable-image/generate/core', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'image/*'
      },
      body: formData
    })

    if (!aiRes.ok) {
      const errText = await aiRes.text()
      console.error('Stability AI error:', aiRes.status, errText)
      throw new Error('Bildegenerering feilet: ' + aiRes.status)
    }

    const contentType = aiRes.headers.get('content-type') || ''

    let dataUrl
    if (contentType.includes('application/json')) {
      // API returned JSON with base64 image
      const json = await aiRes.json()
      const b64 = json.image || json.artifacts?.[0]?.base64
      if (!b64) throw new Error('Ingen bildedata i respons')
      dataUrl = `data:image/webp;base64,${b64}`
      console.log('Image generate: got JSON response with base64')
    } else {
      // API returned raw binary image
      const buffer = Buffer.from(await aiRes.arrayBuffer())
      const base64 = buffer.toString('base64')
      dataUrl = `data:image/webp;base64,${base64}`
      console.log('Image generate: got binary response,', buffer.length, 'bytes')
    }

    res.json({ image: dataUrl, format: 'webp' })
  } catch (e) {
    console.error('Image generate error:', e.stack || e.message)
    res.status(500).json({ error: e.message })
  }
})

export default r
