import { Router } from 'express'
import { auth } from '../middleware/auth.js'

const r = Router()
r.use(auth)

r.post('/generate', async (req, res) => {
  const { content, platform } = req.body
  if (!content) return res.status(400).json({ error: 'Innhold mangler' })

  const apiKey = process.env.STABILITY_API_KEY
  if (!apiKey) return res.status(503).json({ error: 'Stability AI ikke konfigurert' })

  try {
    // Build a visual prompt from the post content
    const promptText = `Professional social media graphic for ${platform || 'LinkedIn'}. Clean, modern design with subtle gradients. Theme: ${content.substring(0, 200)}. No text overlay, no watermarks. High quality, corporate style.`

    console.log('Image generate: calling Stability AI for', platform)

    const formData = new FormData()
    formData.append('prompt', promptText)
    formData.append('output_format', 'webp')

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

    const buffer = Buffer.from(await aiRes.arrayBuffer())
    const base64 = buffer.toString('base64')
    const dataUrl = `data:image/webp;base64,${base64}`

    console.log('Image generate: success, size:', buffer.length, 'bytes')

    res.json({ image: dataUrl, format: 'webp', size: buffer.length })
  } catch (e) {
    console.error('Image generate error:', e.stack || e.message)
    res.status(500).json({ error: e.message })
  }
})

export default r
