import { Router } from 'express'
import { auth } from '../middleware/auth.js'

const r = Router()
r.use(auth)

function buildImagePrompt(content, platform) {
  const clean = content.replace(/[#@\n\r]/g, ' ').replace(/\s+/g, ' ').trim()
  const keywords = clean.substring(0, 150)

  const prompts = {
    linkedin: `Aerial view of Oslo fjord at sunrise, dramatic Norwegian landscape, modern city skyline in background, golden hour light, photorealistic nature photography. Context: ${keywords}`,
    instagram: `Beautiful Norwegian mountain landscape with a lake reflection, sunny day, green hills, dramatic sky, travel photography, photorealistic. Context: ${keywords}`,
    facebook: `Cozy Norwegian cabin by a fjord, warm lights inside, snowy mountains in background, peaceful winter scene, photorealistic. Context: ${keywords}`,
    tiktok: `Norwegian northern lights aurora borealis over snowy landscape, vivid green and purple colors, photorealistic night photography. Context: ${keywords}`,
  }

  return prompts[platform?.toLowerCase()] || prompts.linkedin
}

r.post('/generate', async (req, res) => {
  const { content, platform } = req.body
  if (!content) return res.status(400).json({ error: 'Innhold mangler' })

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return res.status(503).json({ error: 'OpenAI API-nøkkel ikke konfigurert' })

  try {
    const promptText = buildImagePrompt(content, platform)
    console.log('=== DALL-E 3 IMAGE GENERATE ===')
    console.log('Platform:', platform)
    console.log('Prompt:', promptText.substring(0, 200))

    const aiRes = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: promptText,
        n: 1,
        size: '1792x1024',
        quality: 'standard',
        response_format: 'b64_json'
      })
    })

    console.log('DALL-E response status:', aiRes.status, aiRes.statusText)

    if (!aiRes.ok) {
      const errBody = await aiRes.text()
      console.error('=== DALL-E ERROR ===')
      console.error('Status:', aiRes.status, aiRes.statusText)
      console.error('Body:', errBody.substring(0, 500))
      throw new Error(`DALL-E ${aiRes.status}: ${errBody.substring(0, 200)}`)
    }

    const json = await aiRes.json()
    const b64 = json.data?.[0]?.b64_json
    if (!b64) {
      console.error('No image in DALL-E response:', JSON.stringify(json).substring(0, 500))
      throw new Error('Ingen bildedata i respons')
    }

    const dataUrl = `data:image/png;base64,${b64}`
    console.log('=== DALL-E SUCCESS === base64 length:', b64.length)

    res.json({ image: dataUrl, format: 'png' })
  } catch (e) {
    console.error('Image generate error:', e.stack || e.message)
    res.status(500).json({ error: e.message })
  }
})

export default r
