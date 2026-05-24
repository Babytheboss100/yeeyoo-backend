// AI-video via fal.ai queue API (HOLO Sesjon J). Bruker FAL_KEY (samme som FLUX).

const MODELS = {
  luma: 'fal-ai/luma-dream-machine',                       // tekst→video
  runway: 'fal-ai/runway-gen3/turbo/image-to-video',       // bilde→video
}

// Aksepter alias (luma/runway), full fal-sti, eller default luma.
export function resolveModel(key) {
  if (!key) return MODELS.luma
  if (MODELS[key]) return MODELS[key]
  return key.includes('/') ? key : MODELS.luma
}

export async function submitVideo({ model, prompt, imageUrl }) {
  const key = process.env.FAL_KEY
  if (!key) throw new Error('FAL_KEY mangler')
  const input = {}
  if (prompt) input.prompt = prompt
  if (imageUrl) input.image_url = imageUrl
  const res = await fetch(`https://queue.fal.run/${model}`, {
    method: 'POST',
    headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.request_id) {
    const e = new Error(data?.detail || data?.error || `fal.ai ${res.status}`)
    e.fal = data
    throw e
  }
  return { requestId: data.request_id }
}

export async function checkVideo({ model, requestId }) {
  const key = process.env.FAL_KEY
  if (!key) throw new Error('FAL_KEY mangler')
  const statusRes = await fetch(`https://queue.fal.run/${model}/requests/${requestId}/status`, {
    headers: { Authorization: `Key ${key}` },
  })
  const status = await statusRes.json().catch(() => ({}))

  if (status.status === 'COMPLETED') {
    const resRes = await fetch(`https://queue.fal.run/${model}/requests/${requestId}`, {
      headers: { Authorization: `Key ${key}` },
    })
    const result = await resRes.json().catch(() => ({}))
    const videoUrl = result.video?.url || result.output?.video?.url || result.videos?.[0]?.url || null
    return { state: 'completed', videoUrl, raw: result }
  }
  if (status.status === 'IN_QUEUE' || status.status === 'IN_PROGRESS') {
    return { state: 'processing' }
  }
  return { state: 'failed', error: status.error || status.detail || `ukjent status: ${status.status}` }
}
