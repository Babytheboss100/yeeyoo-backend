import { Router } from 'express'
import { auth } from '../middleware/auth.js'

const r = Router()
r.use(auth)

function buildImagePrompt(content, platform) {
  // Extract keywords from post content for relevance
  const clean = content.replace(/[#@\n\r]/g, ' ').replace(/\s+/g, ' ').trim()
  const keywords = clean.substring(0, 120)

  const people = 'Norwegian people, faces visible, professional setting'
  const prompts = {
    linkedin: `Confident Norwegian business professional in modern Oslo office, ${people}, presenting real estate investment data on screen, city skyline through window, sunny day, photorealistic, sharp focus, no text, no logos, 16:9. Context: ${keywords}`,
    instagram: `Smiling young Norwegian couple touring a bright Scandinavian luxury apartment, ${people}, large windows with Oslo city view, aspirational lifestyle, natural light, warm tones, photorealistic, no text, 16:9. Context: ${keywords}`,
    facebook: `Happy Norwegian family with children standing outside their new modern home, ${people}, sunny day, green lawn, celebrating, warm atmosphere, photorealistic, no text, 16:9. Context: ${keywords}`,
    tiktok: `Energetic young Norwegian professional showing real estate investment app on phone to camera, ${people}, modern Oslo street background, dynamic angle, vibrant energy, photorealistic, no text, 16:9. Context: ${keywords}`,
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
    console.log('=== IMAGE GENERATE START ===')
    console.log('Platform:', platform)
    console.log('Prompt:', promptText)
    console.log('API Key:', apiKey ? `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}` : 'MISSING')

    const formData = new FormData()
    formData.append('prompt', promptText)
    formData.append('output_format', 'webp')
    formData.append('aspect_ratio', '16:9')

    console.log('Calling Stability AI v2beta/stable-image/generate/core ...')
    const aiRes = await fetch('https://api.stability.ai/v2beta/stable-image/generate/core', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'image/*'
      },
      body: formData
    })

    console.log('Stability AI response:', {
      status: aiRes.status,
      statusText: aiRes.statusText,
      contentType: aiRes.headers.get('content-type'),
      contentLength: aiRes.headers.get('content-length'),
      finishReason: aiRes.headers.get('finish-reason'),
      seed: aiRes.headers.get('seed'),
    })

    if (!aiRes.ok) {
      const errBody = await aiRes.text()
      console.error('=== STABILITY AI ERROR ===')
      console.error('Status:', aiRes.status, aiRes.statusText)
      console.error('Headers:', JSON.stringify(Object.fromEntries(aiRes.headers.entries())))
      console.error('Body:', errBody)
      throw new Error(`Stability AI ${aiRes.status}: ${errBody.substring(0, 200)}`)
    }

    const contentType = aiRes.headers.get('content-type') || ''

    let dataUrl
    if (contentType.includes('application/json')) {
      const json = await aiRes.json()
      console.log('Got JSON response, keys:', Object.keys(json))
      const b64 = json.image || json.artifacts?.[0]?.base64
      if (!b64) {
        console.error('No image data in JSON:', JSON.stringify(json).substring(0, 500))
        throw new Error('Ingen bildedata i respons')
      }
      dataUrl = `data:image/webp;base64,${b64}`
      console.log('Image from JSON, base64 length:', b64.length)
    } else {
      const buffer = Buffer.from(await aiRes.arrayBuffer())
      dataUrl = `data:image/webp;base64,${buffer.toString('base64')}`
      console.log('Image from binary, size:', buffer.length, 'bytes')
    }

    console.log('=== IMAGE GENERATE SUCCESS ===')
    res.json({ image: dataUrl, format: 'webp' })
  } catch (e) {
    console.error('Image generate error:', e.stack || e.message)
    res.status(500).json({ error: e.message })
  }
})

export default r
