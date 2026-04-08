import { Router } from 'express'
import { auth } from '../middleware/auth.js'

const r = Router()
r.use(auth)

function buildImagePrompt(content, platform) {
  // Extract keywords from post content for relevance
  const clean = content.replace(/[#@\n\r]/g, ' ').replace(/\s+/g, ' ').trim()
  const keywords = clean.substring(0, 120)

  const prompts = {
    linkedin: `Modern Norwegian residential building exterior, professional real estate investment, Oslo cityscape background, sunny day, photorealistic, architectural photography, no text, no logos, 16:9. Context: ${keywords}`,
    instagram: `Stunning Norwegian luxury apartment interior, bright Scandinavian design, large windows with city view, aspirational lifestyle, natural light, photorealistic, no text, 16:9. Context: ${keywords}`,
    facebook: `Happy Norwegian family outside their new modern home, sunny day, green lawn, real estate success story, warm atmosphere, photorealistic, no text, 16:9. Context: ${keywords}`,
    tiktok: `Young Norwegian professional pointing at real estate investment app on phone, modern urban background, Oslo street, dynamic energy, photorealistic, no text, 16:9. Context: ${keywords}`,
  }

  return prompts[platform?.toLowerCase()] || prompts.linkedin
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
