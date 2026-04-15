import { createCanvas } from 'canvas'

const PLATFORM_ICONS = {
  linkedin: 'in', facebook: 'fb', instagram: 'ig',
  twitter: 'tw', email: '@', tiktok: 'tk',
}

const PLATFORM_COLORS = {
  linkedin: '#0a66c2', facebook: '#1877f2', instagram: '#e4405f',
  twitter: '#1da1f2', email: '#7c3aed', tiktok: '#010101',
}

/**
 * Wrap text to fit within maxWidth, returning array of lines.
 */
function wrapText(ctx, text, maxWidth) {
  const words = text.split(/\s+/)
  const lines = []
  let line = ''

  for (const word of words) {
    const test = line ? line + ' ' + word : word
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line)
      line = word
    } else {
      line = test
    }
  }
  if (line) lines.push(line)
  return lines
}

/**
 * Draw a rounded rectangle path.
 */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

/**
 * Render a branded 1080x1080 social media image using node-canvas.
 * No browser needed — pure CPU rendering.
 */
export async function renderBrandedImage(text, platform, projectName) {
  const W = 1080, H = 1080, PAD = 72
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')

  // ─── Background gradient ────────────────────────────────────
  const bg = ctx.createLinearGradient(0, 0, W * 0.4, H)
  bg.addColorStop(0, '#0a0e27')
  bg.addColorStop(0.35, '#1a1145')
  bg.addColorStop(0.7, '#0d1b3e')
  bg.addColorStop(1, '#06081a')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)

  // ─── Grid pattern ───────────────────────────────────────────
  ctx.strokeStyle = 'rgba(255,255,255,0.018)'
  ctx.lineWidth = 1
  for (let x = 0; x < W; x += 60) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke() }
  for (let y = 0; y < H; y += 60) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke() }

  // ─── Glow orbs ──────────────────────────────────────────────
  const orb1 = ctx.createRadialGradient(W + 80, -120, 0, W + 80, -120, 400)
  orb1.addColorStop(0, 'rgba(124,58,237,0.22)')
  orb1.addColorStop(1, 'rgba(124,58,237,0)')
  ctx.fillStyle = orb1
  ctx.fillRect(0, 0, W, H)

  const orb2 = ctx.createRadialGradient(-60, H + 100, 0, -60, H + 100, 350)
  orb2.addColorStop(0, 'rgba(45,91,227,0.18)')
  orb2.addColorStop(1, 'rgba(45,91,227,0)')
  ctx.fillStyle = orb2
  ctx.fillRect(0, 0, W, H)

  // ─── Platform badge ─────────────────────────────────────────
  const plat = platform?.toLowerCase() || 'social'
  const platLabel = PLATFORM_ICONS[plat] ? `${PLATFORM_ICONS[plat]}  ${plat}` : plat
  const platColor = PLATFORM_COLORS[plat] || '#7c3aed'

  ctx.font = '600 15px "Segoe UI", Arial, sans-serif'
  const badgeW = ctx.measureText(platLabel).width + 44
  roundRect(ctx, PAD, PAD, badgeW, 40, 20)
  ctx.fillStyle = 'rgba(255,255,255,0.06)'
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.1)'
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.fillStyle = 'rgba(255,255,255,0.65)'
  ctx.textBaseline = 'middle'
  ctx.fillText(platLabel, PAD + 22, PAD + 20)

  // ─── Post text ──────────────────────────────────────────────
  const safeText = text.replace(/\n+/g, ' ').trim()
  const displayText = safeText.length > 400 ? safeText.substring(0, 397) + '...' : safeText
  const fontSize = displayText.length > 250 ? 28 : displayText.length > 150 ? 34 : 40

  ctx.font = `600 ${fontSize}px "Segoe UI", Arial, sans-serif`
  ctx.fillStyle = '#f0f4ff'
  ctx.textBaseline = 'top'

  const maxTextWidth = W - PAD * 2
  const lines = wrapText(ctx, displayText, maxTextWidth)
  const lineHeight = fontSize * 1.55
  const totalTextHeight = lines.length * lineHeight
  const textY = Math.max(PAD + 70, (H - totalTextHeight) / 2 - 30)

  // Text shadow
  ctx.shadowColor = 'rgba(0,0,0,0.4)'
  ctx.shadowBlur = 20
  ctx.shadowOffsetY = 3
  for (let i = 0; i < Math.min(lines.length, 16); i++) {
    ctx.fillText(lines[i], PAD, textY + i * lineHeight)
  }
  ctx.shadowColor = 'transparent'
  ctx.shadowBlur = 0
  ctx.shadowOffsetY = 0

  // ─── Project tag (bottom-left) ──────────────────────────────
  if (projectName) {
    const tagText = projectName.substring(0, 30)
    ctx.font = '600 14px "Segoe UI", Arial, sans-serif'
    const tagW = ctx.measureText(tagText).width + 36
    const tagY = H - PAD - 36

    roundRect(ctx, PAD, tagY, tagW, 32, 8)
    ctx.fillStyle = 'rgba(124,58,237,0.15)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(124,58,237,0.3)'
    ctx.lineWidth = 1
    ctx.stroke()

    ctx.fillStyle = 'rgba(168,85,247,0.85)'
    ctx.textBaseline = 'middle'
    ctx.fillText(tagText, PAD + 18, tagY + 16)
  }

  // ─── Brand logo (bottom-right) ──────────────────────────────
  const brandX = W - PAD
  const brandY = H - PAD

  // "yeeyoo" text with gradient effect (simulate with two-tone)
  ctx.font = '800 30px "Segoe UI", Arial, sans-serif'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'bottom'
  ctx.fillStyle = '#7c3aed'
  ctx.fillText('yeeyoo', brandX, brandY - 14)

  // Subtitle
  ctx.font = '600 11px "Segoe UI", Arial, sans-serif'
  ctx.fillStyle = 'rgba(255,255,255,0.3)'
  ctx.fillText('AI-GENERERT INNHOLD', brandX, brandY)

  // ─── Accent line (platform color) ──────────────────────────
  ctx.fillStyle = platColor
  ctx.fillRect(PAD, PAD + 56, 50, 3)

  ctx.textAlign = 'left' // reset

  // ─── Export as PNG base64 ───────────────────────────────────
  const buf = canvas.toBuffer('image/png')
  return `data:image/png;base64,${buf.toString('base64')}`
}

/**
 * Render with a hard 5s timeout. Returns null if too slow.
 */
export async function renderBrandedImageSafe(text, platform, projectName, timeoutMs = 5000) {
  return Promise.race([
    renderBrandedImage(text, platform, projectName).catch(e => {
      console.error('[IMAGE] Canvas render failed:', e.message)
      return null
    }),
    new Promise(resolve => setTimeout(() => resolve(null), timeoutMs)),
  ])
}
