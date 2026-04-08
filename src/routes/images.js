import { Router } from 'express'
import { auth } from '../middleware/auth.js'

const r = Router()
r.use(auth)

function buildImagePrompt(content, platform) {
  const clean = content.replace(/[#@\n\r]/g, ' ').replace(/\s+/g, ' ').trim()
  const keywords = clean.substring(0, 150)

  const prompts = {
    linkedin: `A confident Norwegian man in his 30s wearing a navy suit, standing in a modern glass-walled Oslo office. He is presenting a real estate investment portfolio on a large wall-mounted screen showing graphs and property photos. Oslo fjord and Barcode district visible through floor-to-ceiling windows. Bright natural daylight, clean Scandinavian interior with light wood and white walls. Shot from a slight low angle, professional corporate photography style. The scene relates to: ${keywords}`,
    instagram: `A stylish young Norwegian couple in their late 20s walking through a bright, newly renovated luxury apartment in Oslo. Minimalist Scandinavian interior with large windows overlooking the city, white oak floors, designer furniture. Golden hour sunlight streaming in. They are smiling and pointing at the view. Aspirational lifestyle photography, warm color palette, shallow depth of field. The scene relates to: ${keywords}`,
    facebook: `A happy Norwegian family of four — parents in their 30s and two young children — standing in front of their new modern Scandinavian-style home. The house has clean lines, large windows, and a small green front garden. Bright sunny summer day in Norway, everyone is smiling. Warm, inviting atmosphere. Documentary-style photography with natural lighting. The scene relates to: ${keywords}`,
    tiktok: `A young energetic Norwegian woman in her mid-20s, casually dressed, holding up her smartphone toward the camera showing a property investment app screen. She has a big smile and is standing on a modern Oslo street with colorful buildings and a tram in the background. Dynamic composition, slightly tilted camera angle, vibrant colors, natural outdoor lighting. The scene relates to: ${keywords}`,
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
