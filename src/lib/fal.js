// Generisk fal.ai-klient (HOLO Sesjon J). Queue (async) + sync run.
// Brukes av photoshoot (async) og translate-image (sync inpaint).

const QUEUE = 'https://queue.fal.run'

function falKey() {
  const k = process.env.FAL_KEY
  if (!k) throw new Error('FAL_KEY mangler')
  return k
}

export async function falSubmit(model, input) {
  const res = await fetch(`${QUEUE}/${model}`, {
    method: 'POST',
    headers: { Authorization: `Key ${falKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.request_id) {
    const e = new Error(data?.detail || data?.error || `fal.ai ${res.status}`)
    e.fal = data
    throw e
  }
  return data.request_id
}

export async function falPoll(model, requestId) {
  const k = falKey()
  const sRes = await fetch(`${QUEUE}/${model}/requests/${requestId}/status`, { headers: { Authorization: `Key ${k}` } })
  const s = await sRes.json().catch(() => ({}))
  if (s.status === 'COMPLETED') {
    const rRes = await fetch(`${QUEUE}/${model}/requests/${requestId}`, { headers: { Authorization: `Key ${k}` } })
    const result = await rRes.json().catch(() => ({}))
    return { state: 'completed', result }
  }
  if (s.status === 'IN_QUEUE' || s.status === 'IN_PROGRESS') return { state: 'processing' }
  return { state: 'failed', error: s.error || s.detail || `ukjent status: ${s.status}` }
}

// Synkron kjøring (for raskere modeller som inpainting).
export async function falRun(model, input) {
  const res = await fetch(`https://fal.run/${model}`, {
    method: 'POST',
    headers: { Authorization: `Key ${falKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const e = new Error(data?.detail || data?.error || `fal.ai ${res.status}`)
    e.fal = data
    throw e
  }
  return data
}

export function extractImageUrl(result) {
  return result?.images?.[0]?.url || result?.image?.url || result?.output?.images?.[0]?.url || null
}

// aspect_ratio → fal image_size enum.
export function aspectToImageSize(aspect) {
  return {
    '1:1': 'square_hd',
    '16:9': 'landscape_16_9',
    '9:16': 'portrait_16_9',
    '4:3': 'landscape_4_3',
    '3:4': 'portrait_4_3',
  }[aspect] || 'square_hd'
}
