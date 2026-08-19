// /api/translate-image — oversett tekst i bilder (HOLO Sesjon J, #11).
//
// Flyt: 1) OCR via Claude vision  2) oversett via Claude  3) (valgfritt) inpaint
// ny tekst via fal.ai. Inpainting krever mask_url (region som skal erstattes);
// uten mask returneres OCR+oversettelse uten nytt bilde (auto-maske er TODO).
// Synkron — Anthropic-stegene tar ~5-10s. Authed + tenant-isolert + rate-limited.

import { Router } from 'express'
import crypto from 'crypto'
import { pool } from '../db.js'
import { auth } from '../middleware/auth.js'
import { enforceProjectOwnership } from '../middleware/project.js'
import { CrawlError, validateCrawlUrl } from '../services/safeCrawler.js'
import { checkAILimit, logAIUsage } from '../middleware/aiLimit.js'
import { falRun, extractImageUrl } from '../lib/fal.js'
import { logAudit } from '../lib/audit.js'
import { beginDurableJob, durableResult } from '../jobs/jobCutover.js'
import { transitionJob } from '../jobs/jobStore.js'

const r = Router()
r.use(auth)
r.use(enforceProjectOwnership)

const INPAINT_MODEL = 'fal-ai/flux/dev/inpainting'

async function anthropic(body) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('AI-provider ikke konfigurert')
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error?.message || `anthropic ${res.status}`)
  return { text: (data.content?.[0]?.text || '').trim(), usage: data.usage }
}

// POST /generate — { image_url, source_lang, target_lang, project_id, mask_url? }
r.post('/generate', checkAILimit('translate_image'), async (req, res) => {
  const { image_url: imageUrl, source_lang: sourceLang, target_lang: targetLang, project_id: projectId, mask_url: maskUrl } = req.body || {}
  if (!imageUrl || !targetLang) return res.status(400).json({ error: 'image_url og target_lang kreves' })

  if (!projectId) return res.status(400).json({ error: 'projectId kreves' })

  // Providerne henter disse URL-ene, ikke vi - men de kommer fra klienten, og
  // en ubekreftet URL gjor providerkontoen var til en apen henteproxy og
  // lagrer malet i image_translations. Samme vakt, kun validering.
  try {
    await validateCrawlUrl(imageUrl)
    if (maskUrl) await validateCrawlUrl(maskUrl)
  } catch (error) {
    if (error instanceof CrawlError) return res.status(400).json({ error: 'Ugyldig eller blokkert bilde-URL', code: error.code })
    throw error
  }

  let durable
  let id
  try {
    durable = await beginDurableJob({ userId: req.user.id, projectId, kind: 'translate_image', provider: 'anthropic+fal', model: INPAINT_MODEL, input: { imageUrl, sourceLang, targetLang, hasMask: !!maskUrl }, idempotencyKey: req.get('Idempotency-Key') || crypto.randomUUID() })
    const running = await transitionJob({ id: durable.id, userId: req.user.id, projectId, from: 'queued', to: 'running' })
    if (!running) return res.status(409).json({ error: 'Jobben er allerede startet' })
    id = durable.id
    await pool.query(
      `INSERT INTO image_translations (id, user_id, project_id, source_image_url, source_lang, target_lang, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
      [id, req.user.id, projectId, imageUrl, sourceLang || null, targetLang]
    )
    // 1) OCR via Claude vision
    const ocr = await anthropic({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: imageUrl } },
          { type: 'text', text: 'Extract ALL visible text in this image, preserving line breaks. Return ONLY the text, no commentary.' },
        ],
      }],
    })
    const detectedText = ocr.text

    // 2) Oversett via Claude
    const tr = await anthropic({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Translate the following text${sourceLang ? ` from ${sourceLang}` : ''} to ${targetLang}. Return ONLY the translation, preserving line breaks:\n\n${detectedText}`,
      }],
    })
    const translatedText = tr.text

    // 3) Inpaint (kun hvis mask_url er gitt)
    let translatedImageUrl = null
    if (maskUrl) {
      const result = await falRun(INPAINT_MODEL, {
        image_url: imageUrl,
        mask_url: maskUrl,
        prompt: `Render this exact text in the masked area, matching the original style and font: "${translatedText}"`,
      })
      translatedImageUrl = extractImageUrl(result)
    }

    await pool.query(
      `UPDATE image_translations
       SET detected_text=$1, translated_text=$2, translated_image_url=$3, status='completed'
       WHERE id=$4`,
      [detectedText, translatedText, translatedImageUrl, id]
    )
    await logAIUsage({ userId: req.user.id, endpoint: 'translate_image', tokensIn: (ocr.usage?.input_tokens || 0) + (tr.usage?.input_tokens || 0), tokensOut: (ocr.usage?.output_tokens || 0) + (tr.usage?.output_tokens || 0) })
    await logAudit({ userId: req.user.id, action: 'translate_image.generate', resourceType: 'image_translation', resourceId: id, metadata: { targetLang, inpainted: !!translatedImageUrl } })
    await transitionJob({ id, userId: req.user.id, projectId, from: 'running', to: 'succeeded', ...durableResult('translate_image', { detectedText, translatedText, translatedImageUrl }, { tokensIn: (ocr.usage?.input_tokens || 0) + (tr.usage?.input_tokens || 0), tokensOut: (ocr.usage?.output_tokens || 0) + (tr.usage?.output_tokens || 0) }) })

    res.json({
      id,
      status: 'completed',
      detectedText,
      translatedText,
      translatedImageUrl,
      note: translatedImageUrl ? undefined : 'Ingen mask_url oppgitt — returnerte OCR + oversettelse uten nytt bilde. Send mask_url for in-place inpainting.',
    })
  } catch (e) {
    if (durable) await transitionJob({ id: durable.id, userId: req.user.id, projectId, from: 'running', to: 'failed', error: e }).catch(() => {})
    await pool.query("UPDATE image_translations SET status='failed', error=$1 WHERE id=$2", [e.message, id]).catch(() => {})
    console.error('[translate-image/generate]', e.message)
    res.status(502).json({ error: e.message, id })
  }
})

// GET /:id — hent resultat.
r.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, source_image_url, translated_image_url, source_lang, target_lang, detected_text, translated_text, status, error, created_at FROM image_translations WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Ikke funnet' })
    res.json(rows[0])
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default r
