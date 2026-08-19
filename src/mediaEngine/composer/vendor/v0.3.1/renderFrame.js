// yeeyoo-media-composer — frame-rendering (v0.2)
// Tegner ÉN frame ved global tid t. Deterministisk: ingen klokker, ingen
// tilfeldighet. Kjører på @napi-rs/canvas server-side og nettleser-canvas.
// MERK (P1.1): nettleser-preview er TILNÆRMET — servereksport er autoritativ
// (font-/plattformforskjeller). Video-frames leveres ferdig lastet i assets
// under nøkkel `videoframe:<elementId>` av compose.js per iterasjon.

import { ease, lerp } from './easing.js'
import { activeScenes, elementVisibility, activeCaptions } from './timeline.js'
import { elKey, bgKey } from './assets.js'

export function renderFrame(ctx, project, timeline, t, assets) {
  const { width: W, height: H } = project.canvas
  ctx.save()
  ctx.fillStyle = project.canvas.background
  ctx.fillRect(0, 0, W, H)

  for (const a of activeScenes(timeline, t)) {
    const scene = project.scenes[a.index]
    ctx.save()
    applyTransition(ctx, scene.transition, a.transitionProgress, W, H)
    drawScene(ctx, scene, a.localT, assets, W, H)
    ctx.restore()
  }

  drawCaptions(ctx, project, t, W, H)
  ctx.restore()
}

function applyTransition(ctx, transition, progress, W, H) {
  if (progress >= 1 || transition.type === 'none') return
  const p = ease('easeInOutCubic', progress)
  switch (transition.type) {
    case 'fade': ctx.globalAlpha = p; break
    case 'slide-left': ctx.translate(W * (1 - p), 0); break
    case 'slide-right': ctx.translate(-W * (1 - p), 0); break
    case 'slide-up': ctx.translate(0, H * (1 - p)); break
    case 'wipe': {
      ctx.beginPath(); ctx.rect(0, 0, W * p, H); ctx.clip(); break
    }
  }
}

function drawScene(ctx, scene, localT, assets, W, H) {
  if (scene.background) {
    if (typeof scene.background === 'string') {
      ctx.fillStyle = scene.background
      ctx.fillRect(0, 0, W, H)
    } else {
      const img = assets.get(bgKey(scene))
      if (img) drawFitted(ctx, img, 0, 0, W, H, 'cover')
    }
  }
  for (const el of scene.elements) {
    drawElement(ctx, el, localT, scene.duration, assets, W, H)
  }
}

function drawElement(ctx, el, localT, sceneDuration, assets, W, H) {
  const vis = elementVisibility(el, localT, sceneDuration)
  if (!vis.visible) return

  let x = el.x, y = el.y, opacity = el.opacity, scale = 1, rotation = el.rotation
  for (const a of el.animate) {
    if (localT < a.start) continue
    const p = ease(a.easing, Math.min(1, (localT - a.start) / (a.end - a.start)))
    const v = lerp(a.from, a.to, p)
    if (a.prop === 'x') x = v
    else if (a.prop === 'y') y = v
    else if (a.prop === 'opacity') opacity = v
    else if (a.prop === 'scale') scale = v
    else if (a.prop === 'rotation') rotation = v
  }

  const ip = vis.inProgress
  let dy = 0
  if (ip < 1) {
    switch (el.in.type) {
      case 'fade':
        opacity *= ease('easeOutQuad', ip); break
      case 'slide-up':
        opacity *= ease('easeOutQuad', ip)
        dy = (1 - ease('easeOutCubic', ip)) * 0.06 * H
        break
      case 'slide-down':
        opacity *= ease('easeOutQuad', ip)
        dy = -(1 - ease('easeOutCubic', ip)) * 0.06 * H
        break
      case 'pop':
        opacity *= ease('easeOutQuad', ip)
        scale *= ease('easeOutBack', ip)
        break
    }
  }
  if (vis.outProgress > 0) opacity *= 1 - ease('easeInQuad', vis.outProgress)
  if (opacity <= 0) return

  ctx.save()
  ctx.globalAlpha = Math.max(0, Math.min(1, opacity)) * ctx.globalAlpha
  ctx.translate(x * W, y * H + dy)
  if (rotation) ctx.rotate((rotation * Math.PI) / 180)
  if (scale !== 1) ctx.scale(scale, scale)

  if (el.type === 'text') drawText(ctx, el, W, H)
  else if (el.type === 'image') drawImageEl(ctx, el, assets.get(elKey(el)), W, H)
  else if (el.type === 'video') drawVideoEl(ctx, el, assets.get(`videoframe:${el.id}`), W, H)
  else if (el.type === 'rect') drawRect(ctx, el, W, H)
  ctx.restore()
}

function drawText(ctx, el, W, H) {
  const s = el.style
  const fontSize = Math.round((s.fontSize ?? 0.05) * H)
  ctx.font = `${s.fontWeight ?? '700'} ${fontSize}px ${s.fontFamily ?? 'sans-serif'}`
  ctx.textAlign = s.align ?? 'center'
  ctx.textBaseline = 'middle'
  const maxWidth = (el.w ?? 0.86) * W
  const lines = wrapText(ctx, el.text, maxWidth)
  const lineHeight = fontSize * (s.lineHeight ?? 1.25)
  const totalH = lines.length * lineHeight
  if (s.shadow !== false) {
    ctx.shadowColor = 'rgba(0,0,0,0.45)'
    ctx.shadowBlur = fontSize * 0.15
    ctx.shadowOffsetY = fontSize * 0.04
  }
  ctx.fillStyle = s.color ?? '#ffffff'
  lines.forEach((line, i) => {
    ctx.fillText(line, 0, -totalH / 2 + lineHeight * (i + 0.5), maxWidth)
  })
}

function drawImageEl(ctx, el, img, W, H) {
  if (!img) return
  const w = (el.w ?? img.width / W) * W
  const h = el.h != null ? el.h * H : (w * img.height) / img.width
  clipRounded(ctx, el, w, h)
  drawFitted(ctx, img, -w / 2, -h / 2, w, h, el.fit ?? 'fill')
}

function drawVideoEl(ctx, el, frameImg, W, H) {
  if (!frameImg) return
  const w = (el.w ?? 1) * W
  const h = (el.h ?? 1) * H
  clipRounded(ctx, el, w, h)
  drawFitted(ctx, frameImg, -w / 2, -h / 2, w, h, el.fit)
}

function clipRounded(ctx, el, w, h) {
  if (el.style.rounded) {
    const r = Math.min(w, h) * (el.style.rounded === true ? 0.08 : el.style.rounded)
    roundRectPath(ctx, -w / 2, -h / 2, w, h, r)
    ctx.clip()
  }
}

function drawFitted(ctx, img, x, y, w, h, fit) {
  if (fit === 'fill' || !fit) {
    ctx.drawImage(img, x, y, w, h)
    return
  }
  const scale = fit === 'cover'
    ? Math.max(w / img.width, h / img.height)
    : Math.min(w / img.width, h / img.height)
  const dw = img.width * scale, dh = img.height * scale
  if (fit === 'cover') {
    ctx.save()
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip()
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)
    ctx.restore()
  } else {
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)
  }
}

function drawRect(ctx, el, W, H) {
  const w = (el.w ?? 0.5) * W
  const h = (el.h ?? 0.1) * H
  const s = el.style
  ctx.fillStyle = s.color ?? '#7c3aed'
  const r = (s.radius ?? 0) * Math.min(w, h)
  if (r > 0) { roundRectPath(ctx, -w / 2, -h / 2, w, h, r); ctx.fill() }
  else ctx.fillRect(-w / 2, -h / 2, w, h)
}

function drawCaptions(ctx, project, t, W, H) {
  const caps = activeCaptions(project, t)
  if (caps.length === 0) return
  const cap = caps[0] // v0.2: én caption-track; validering hindrer ikke overlapp ennå (P1.5)
  const s = cap.style
  const fontSize = Math.round((s.fontSize ?? 0.032) * H)
  ctx.save()
  ctx.font = `${s.fontWeight ?? '700'} ${fontSize}px ${s.fontFamily ?? 'sans-serif'}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const maxWidth = W * 0.84
  const lines = wrapText(ctx, cap.text, maxWidth)
  const lineHeight = fontSize * 1.3
  const pad = fontSize * 0.55
  const boxH = lines.length * lineHeight + pad * 2
  const boxTop = H * 0.82 - boxH // safe area: hold over nederste 18 %
  const widest = Math.max(...lines.map(l => ctx.measureText(l).width))
  const boxW = Math.min(maxWidth + pad * 2, widest + pad * 2)
  ctx.fillStyle = s.background ?? 'rgba(0,0,0,0.55)'
  roundRectPath(ctx, W / 2 - boxW / 2, boxTop, boxW, boxH, fontSize * 0.35)
  ctx.fill()
  ctx.fillStyle = s.color ?? '#ffffff'
  lines.forEach((line, i) => {
    ctx.fillText(line, W / 2, boxTop + pad + lineHeight * i + lineHeight / 2, maxWidth)
  })
  ctx.restore()
}

function wrapText(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/)
  const lines = []
  let line = ''
  for (const word of words) {
    const test = line ? line + ' ' + word : word
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line)
      line = word
    } else line = test
  }
  if (line) lines.push(line)
  return lines
}

function roundRectPath(ctx, x, y, w, h, r) {
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
