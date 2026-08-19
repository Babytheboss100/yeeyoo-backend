// yeeyoo-media-composer — Creative Genome-derivasjon (v1)
// deriveGenome(project, hints) → genome JSONB per YEEYOO_CREATIVE_GENOME_SCHEMA.md §3.
// Deterministisk avledning fra composer-prosjektet. Tony/Sosy-beslutninger
// (narrative, hook.type, cta.type, audience) kommer via hints — de VET det
// allerede fra delegeringen; her persisteres det. Ingen kostnadsdata her
// (cost bor i ai_usage/ai_jobs — genomet refererer via production.job_ids).

const ASPECT_BY_RATIO = [
  { ratio: 9 / 16, name: '9:16' },
  { ratio: 1, name: '1:1' },
  { ratio: 16 / 9, name: '16:9' },
  { ratio: 4 / 5, name: '4:5' },
  { ratio: 1.91, name: '1.91:1' },
]

function nearestAspect(w, h) {
  const r = w / h
  let best = ASPECT_BY_RATIO[0]
  for (const a of ASPECT_BY_RATIO)
    if (Math.abs(a.ratio - r) < Math.abs(best.ratio - r)) best = a
  return best.name
}

function firstWords(text, n = 8) {
  return String(text).trim().split(/\s+/).slice(0, n).join(' ')
}

/** Klassifiser første synlige INNHOLD i første scene (rect = dekor, teller ikke). */
function classifyFirstFrame(project) {
  const scene = project.scenes[0]
  if (!scene) return 'scene'
  // Første innholdselement etter delay — dekorative rects ignoreres.
  const content = scene.elements
    .filter(el => el.type !== 'rect')
    .sort((a, b) => (a.in?.delay ?? 0) - (b.in?.delay ?? 0))
  const first = content[0]
  const hasImageBg = scene.background && typeof scene.background === 'object'
  if (first && (first.in?.delay ?? 0) <= 0.5) {
    if (first.type === 'video') return 'scene'
    if (first.type === 'image') return 'product' // uten ansiktsdeteksjon: bilde ≈ produkt/foto
    if (first.type === 'text') return 'text'
  }
  return hasImageBg ? 'scene' : first?.type === 'text' ? 'text' : 'scene'
}

/** Dominante farger: bakgrunner + rect/tekst-farger, i bruksrekkefølge, maks 4. */
function collectPalette(project) {
  const seen = new Set()
  const out = []
  const push = c => {
    if (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c) && !seen.has(c.toLowerCase())) {
      seen.add(c.toLowerCase())
      out.push(c.toLowerCase())
    }
  }
  push(project.canvas.background)
  for (const s of project.scenes) {
    if (typeof s.background === 'string') push(s.background)
    for (const el of s.elements) {
      push(el.style?.color)
    }
  }
  return out.slice(0, 4)
}

/** Motion-klassifisering: andel animerte elementer + transitions + video. */
function classifyMotion(project) {
  let animated = 0, total = 0, hasVideo = false, transitions = 0
  for (const s of project.scenes) {
    if (s.transition && s.transition.type !== 'none') transitions++
    for (const el of s.elements) {
      total++
      if (el.type === 'video') hasVideo = true
      if ((el.animate?.length ?? 0) > 0 || (el.in && el.in.type !== 'none' && el.in.type !== 'fade'))
        animated++
    }
  }
  if (total === 0) return 'static'
  const ratio = animated / total
  if (hasVideo || ratio > 0.5 || transitions >= project.scenes.length - 1 && transitions > 1)
    return 'dynamic'
  if (ratio > 0 || transitions > 0) return 'calm'
  return 'static'
}

/** Finn hook-tekst (første tekstelement i første scene) og CTA (siste scenes siste tekst). */
function findHookAndCta(project) {
  const first = project.scenes[0]
  const last = project.scenes[project.scenes.length - 1]
  const hookEl = first?.elements.find(el => el.type === 'text')
  // CTA-heuristikk: tekst i siste scene, kortest tekst nær en rect ("knapp") vinner.
  const lastTexts = (last?.elements ?? []).filter(el => el.type === 'text')
  const hasButton = (last?.elements ?? []).some(el => el.type === 'rect' && (el.style?.radius ?? 0) > 0)
  const ctaEl = lastTexts.length
    ? lastTexts.reduce((a, b) => (a.text.length <= b.text.length ? a : b))
    : null
  return {
    hookText: hookEl ? firstWords(hookEl.text) : null,
    ctaText: ctaEl ? firstWords(ctaEl.text, 5) : null,
    ctaPlacement: ctaEl ? 'end' : null,
    ctaLooksLikeButton: hasButton,
  }
}

/**
 * deriveGenome(project, hints)
 * project: VALIDERT composer-prosjekt (etter validateProject).
 * hints (valgfritt, fra Tony/Sosy-delegeringen): { format, language, narrative,
 *   hookType, ctaType, audienceSegment, funnelStage, promptVersion, templateId,
 *   draftCandidates, jobIds, composerProjectSha256, source }
 * Returnerer genome-objekt (v1). Kaster aldri — mangler gir null-felter.
 */
export function deriveGenome(project, hints = {}) {
  try {
    const { hookText, ctaText, ctaPlacement, ctaLooksLikeButton } = findHookAndCta(project)
    const firstFrame = classifyFirstFrame(project)
    return {
      v: 1,
      format: hints.format ?? 'reel',
      language: hints.language ?? null,
      narrative: hints.narrative ?? null,
      hook: {
        type: hints.hookType ?? null,
        first_words: hookText,
        has_face_first_second: firstFrame === 'face',
      },
      cta: {
        type: hints.ctaType ?? (ctaLooksLikeButton ? 'link_in_bio' : null),
        placement: ctaPlacement,
        text: ctaText,
      },
      visual: {
        first_frame: firstFrame,
        palette: collectPalette(project),
        font_family: project.scenes[0]?.elements.find(e => e.type === 'text')?.style?.fontFamily ?? 'sans-serif',
        motion: classifyMotion(project),
        aspect: nearestAspect(project.canvas.width, project.canvas.height),
      },
      audience: {
        segment: hints.audienceSegment ?? null,
        funnel_stage: hints.funnelStage ?? null,
      },
      production: {
        source: hints.source ?? 'composer',
        composer_project_sha256: hints.composerProjectSha256 ?? null,
        template_id: hints.templateId ?? null,
        prompt_version: hints.promptVersion ?? null,
        draft_candidates: hints.draftCandidates ?? null,
        job_ids: Array.isArray(hints.jobIds) ? hints.jobIds : [],
      },
    }
  } catch {
    // Genomet skal ALDRI velte en produksjon — degrader til minimal sannferdig form.
    return { v: 1, format: hints.format ?? null, derivation_failed: true }
  }
}
