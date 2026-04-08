import { Router } from 'express'
import { auth } from '../middleware/auth.js'

const r = Router()
r.use(auth)

function buildImagePrompt(content, platform) {
  const clean = content.replace(/[#@\n\r]/g, ' ').replace(/\s+/g, ' ').trim()
  const keywords = clean.substring(0, 150)

  const prompts = {
    linkedin: `Portrait photo of a confident Norwegian businessman in his 40s, standing outdoors in Oslo city center, wearing a dark suit, smiling, modern buildings in background, professional headshot style, natural daylight, photorealistic, Canon camera quality. Context: ${keywords}`,
    instagram: `Young Norwegian woman in her 30s sitting at outdoor café in Oslo, laptop open, coffee cup, city street background, sunshine, casual professional style, lifestyle photography, photorealistic, natural light. Context: ${keywords}`,
    facebook: `Happy Norwegian couple signing documents at a desk, both smiling, bright room with large windows, real estate or investment success, warm atmosphere, photorealistic, faces clearly visible. Context: ${keywords}`,
    tiktok: `Energetic young Norwegian man outdoors in Oslo, casual clothes, big smile, pointing at phone screen, urban background, dynamic street photography, photorealistic. Context: ${keywords}`,
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
