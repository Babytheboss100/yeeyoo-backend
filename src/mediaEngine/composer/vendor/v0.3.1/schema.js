// yeeyoo-media-composer — prosjektskjema (v0.2)
// Streng, versjonert validering med ressursgrenser og stabile feilkoder.
// Kaster ALDRI på ugyldig klientdata — returnerer alltid { ok, errors }.
// Offentlig kontrakt bruker assetId, ALDRI serverstier. Lokale stier (src)
// aksepteres kun med eksplisitt { allowLocalPaths: true } (intern bruk).

const TRANSITIONS = ['none', 'fade', 'slide-left', 'slide-right', 'slide-up', 'wipe']
const ELEMENT_TYPES = ['text', 'image', 'video', 'rect']
const ANIM_IN = ['none', 'fade', 'slide-up', 'slide-down', 'pop']
const ANIM_OUT = ['none', 'fade']
const FITS = ['cover', 'contain', 'fill']
const ANIM_PROPS = ['x', 'y', 'opacity', 'scale', 'rotation']
const ASPECTS = { '9:16': [1080, 1920], '1:1': [1080, 1080], '16:9': [1920, 1080] }

// Ressursgrenser (P0.7). Kan strammes inn per tier senere — aldri løsnes av klient.
export const LIMITS = {
  maxDurationSec: 60,
  maxScenes: 50,
  maxElementsPerScene: 30,
  maxCaptions: 100,
  maxTextLength: 500,
  maxVideoElements: 10,
  maxCanvasDim: 2160,
  maxAnimationsPerElement: 20,
}

export function defaultProject(aspect = '9:16') {
  const [width, height] = ASPECTS[aspect] || ASPECTS['9:16']
  return {
    schemaVersion: 1,
    kind: 'reel',
    canvas: { width, height, fps: 30, background: '#000000' },
    scenes: [],
    captions: [],
    audio: null,
  }
}

const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v)
const isNum = v => typeof v === 'number' && Number.isFinite(v)
const isStr = v => typeof v === 'string'
const inRange = (v, lo, hi) => isNum(v) && v >= lo && v <= hi

/**
 * validateProject(input, { allowLocalPaths = false }) → { ok, errors, project }
 * errors: [{ code, path, message }] — stabile koder for API-mapping.
 * Muterer aldri input.
 */
export function validateProject(input, opts = {}) {
  const allowLocalPaths = opts.allowLocalPaths === true
  const errors = []
  const err = (code, path, message) => errors.push({ code, path, message })

  if (!isObj(input)) {
    return { ok: false, errors: [{ code: 'PROJECT_NOT_OBJECT', path: '', message: 'project må være et objekt' }], project: null }
  }
  let p
  try { p = JSON.parse(JSON.stringify(input)) } catch {
    return { ok: false, errors: [{ code: 'PROJECT_NOT_SERIALIZABLE', path: '', message: 'project må være ren JSON' }], project: null }
  }

  if (p.schemaVersion !== 1) err('BAD_SCHEMA_VERSION', 'schemaVersion', 'må være 1')
  if (p.kind !== 'reel') err('BAD_KIND', 'kind', `må være "reel"`)

  // ── canvas ──
  if (!isObj(p.canvas)) { err('BAD_CANVAS', 'canvas', 'må være objekt'); p.canvas = {} }
  const c = p.canvas
  if (!Number.isInteger(c.width) || c.width < 16 || c.width > LIMITS.maxCanvasDim)
    err('BAD_CANVAS_DIM', 'canvas.width', `heltall 16–${LIMITS.maxCanvasDim}`)
  if (!Number.isInteger(c.height) || c.height < 16 || c.height > LIMITS.maxCanvasDim)
    err('BAD_CANVAS_DIM', 'canvas.height', `heltall 16–${LIMITS.maxCanvasDim}`)
  c.fps = c.fps ?? 30
  if (![24, 25, 30, 60].includes(c.fps)) err('BAD_FPS', 'canvas.fps', '24, 25, 30 eller 60')
  if (!isStr(c.background)) c.background = '#000000'

  // ── scenes ──
  if (!Array.isArray(p.scenes) || p.scenes.length === 0) {
    err('NO_SCENES', 'scenes', 'må være ikke-tom liste')
    p.scenes = []
  }
  if (p.scenes.length > LIMITS.maxScenes)
    err('TOO_MANY_SCENES', 'scenes', `maks ${LIMITS.maxScenes}`)

  const sceneIds = new Set()
  const globalElementIds = new Set() // compose kobler klipp/frames på el.id GLOBALT
  let videoElementCount = 0
  let totalDuration = 0
  let prevSceneDuration = null
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/ // IDer kan ende i filstier/nøkler — aldri fri tekst

  p.scenes.forEach((s0, i) => {
    const at = `scenes[${i}]`
    if (!isObj(s0)) { err('BAD_SCENE', at, 'må være objekt'); p.scenes[i] = { duration: 0, elements: [] }; return }
    const s = s0
    s.id = isStr(s.id) ? s.id : `scene-${i}`
    if (!ID_RE.test(s.id)) err('INVALID_ID', `${at}.id`, 'kun [A-Za-z0-9_-], maks 64 tegn')
    if (sceneIds.has(s.id)) err('DUPLICATE_SCENE_ID', `${at}.id`, `duplikat: ${s.id}`)
    sceneIds.add(s.id)

    if (!inRange(s.duration, 0.1, 120)) err('BAD_SCENE_DURATION', `${at}.duration`, '0.1–120 sekunder')
    else totalDuration += s.duration

    if (s.background != null && !isStr(s.background)) {
      if (!isObj(s.background) || (!isStr(s.background.assetId) && !(allowLocalPaths && isStr(s.background.image))))
        err('BAD_BACKGROUND', `${at}.background`, 'farge-streng eller { assetId }')
    }

    if (!isObj(s.transition)) s.transition = { type: 'none', duration: 0 }
    if (!TRANSITIONS.includes(s.transition.type))
      err('BAD_TRANSITION', `${at}.transition.type`, TRANSITIONS.join('|'))
    s.transition.duration = isNum(s.transition.duration) ? s.transition.duration : 0.5
    if (s.transition.type === 'none') s.transition.duration = 0
    if (s.transition.duration < 0 || (isNum(s.duration) && s.transition.duration >= s.duration))
      err('BAD_TRANSITION_DURATION', `${at}.transition.duration`, '≥0 og kortere enn scenens varighet')
    // Overlappet trekkes fra FORRIGE scene — kan ikke være lengre enn den.
    if (i > 0 && prevSceneDuration != null && s.transition.duration >= prevSceneDuration)
      err('TRANSITION_EXCEEDS_PREV_SCENE', `${at}.transition.duration`, `må være kortere enn forrige scenes varighet (${prevSceneDuration}s)`)
    if (i === 0) s.transition = { type: 'none', duration: 0 }
    prevSceneDuration = isNum(s.duration) ? s.duration : null

    if (!Array.isArray(s.elements)) {
      if (s.elements != null) err('BAD_ELEMENTS', `${at}.elements`, 'må være liste')
      s.elements = []
    }
    if (s.elements.length > LIMITS.maxElementsPerScene)
      err('TOO_MANY_ELEMENTS', `${at}.elements`, `maks ${LIMITS.maxElementsPerScene}`)

    const elIds = new Set()
    s.elements.forEach((el0, j) => {
      const eat = `${at}.elements[${j}]`
      if (!isObj(el0)) { err('BAD_ELEMENT', eat, 'må være objekt'); s.elements[j] = { type: 'rect' }; return }
      const el = el0
      el.id = isStr(el.id) ? el.id : `el-${i}-${j}`
      if (!ID_RE.test(el.id)) err('INVALID_ID', `${eat}.id`, 'kun [A-Za-z0-9_-], maks 64 tegn')
      if (elIds.has(el.id)) err('DUPLICATE_ELEMENT_ID', `${eat}.id`, `duplikat i scenen: ${el.id}`)
      elIds.add(el.id)
      // GLOBALT unik: compose bruker el.id som nøkkel på tvers av scener.
      if (globalElementIds.has(el.id)) err('DUPLICATE_GLOBAL_ELEMENT_ID', `${eat}.id`, `duplikat på tvers av scener: ${el.id}`)
      globalElementIds.add(el.id)

      if (!ELEMENT_TYPES.includes(el.type)) err('BAD_ELEMENT_TYPE', `${eat}.type`, ELEMENT_TYPES.join('|'))

      if (el.type === 'text') {
        if (!isStr(el.text)) err('MISSING_TEXT', `${eat}.text`, 'kreves for type text')
        else if (el.text.length > LIMITS.maxTextLength)
          err('TEXT_TOO_LONG', `${eat}.text`, `maks ${LIMITS.maxTextLength} tegn`)
      }
      if (el.type === 'image' || el.type === 'video') {
        const hasAssetId = isStr(el.assetId) && el.assetId.length > 0
        const hasSrc = isStr(el.src) && el.src.length > 0
        if (!hasAssetId && !(allowLocalPaths && hasSrc))
          err('MISSING_ASSET_ID', `${eat}.assetId`, 'assetId kreves (src kun internt med allowLocalPaths)')
        if (hasSrc && !allowLocalPaths)
          err('LOCAL_PATH_FORBIDDEN', `${eat}.src`, 'serverstier er ikke tillatt i offentlig kontrakt — bruk assetId')
      }
      if (el.type === 'video') {
        videoElementCount++
        el.srcStart = isNum(el.srcStart) && el.srcStart >= 0 ? el.srcStart : 0
        if (el.srcEnd != null && (!isNum(el.srcEnd) || el.srcEnd <= el.srcStart))
          err('BAD_TRIM', `${eat}.srcEnd`, 'må være > srcStart')
        el.fit = FITS.includes(el.fit) ? el.fit : 'cover'
        el.loop = el.loop === true // false → freeze siste frame
      }
      if (el.type === 'image') el.fit = FITS.includes(el.fit) ? el.fit : null

      for (const k of ['x', 'y']) {
        el[k] = isNum(el[k]) ? el[k] : 0.5
        if (!inRange(el[k], -0.5, 1.5)) err('BAD_POSITION', `${eat}.${k}`, '[-0.5, 1.5]')
      }
      for (const k of ['w', 'h']) {
        if (el[k] != null && !inRange(el[k], 0.001, 2)) err('BAD_SIZE', `${eat}.${k}`, '(0, 2]')
        if (el[k] == null) el[k] = null
      }
      el.opacity = isNum(el.opacity) ? el.opacity : 1
      if (!inRange(el.opacity, 0, 1)) err('BAD_OPACITY', `${eat}.opacity`, '[0, 1]')
      el.rotation = isNum(el.rotation) ? el.rotation : 0
      if (!inRange(el.rotation, -360, 360)) err('BAD_ROTATION', `${eat}.rotation`, '[-360, 360]')
      if (!isObj(el.style)) el.style = {}
      if (el.style.fontSize != null && !inRange(el.style.fontSize, 0.005, 0.5))
        err('BAD_FONT_SIZE', `${eat}.style.fontSize`, '(0.005–0.5, relativ til høyde)')

      if (!isObj(el.in)) el.in = { type: 'fade', delay: 0, duration: 0.4 }
      if (!ANIM_IN.includes(el.in.type)) err('BAD_ANIM_IN', `${eat}.in.type`, ANIM_IN.join('|'))
      el.in.delay = inRange(el.in.delay, 0, 120) ? el.in.delay : 0
      el.in.duration = inRange(el.in.duration, 0, 10) ? el.in.duration : 0.4

      if (!isObj(el.out)) el.out = { type: 'none', duration: 0.3 }
      if (!ANIM_OUT.includes(el.out.type)) err('BAD_ANIM_OUT', `${eat}.out.type`, ANIM_OUT.join('|'))
      el.out.duration = inRange(el.out.duration, 0, 10) ? el.out.duration : 0.3

      if (!Array.isArray(el.animate)) {
        if (el.animate != null) err('BAD_ANIMATE', `${eat}.animate`, 'må være liste')
        el.animate = []
      }
      if (el.animate.length > LIMITS.maxAnimationsPerElement)
        err('TOO_MANY_ANIMATIONS', `${eat}.animate`, `maks ${LIMITS.maxAnimationsPerElement}`)
      el.animate.forEach((a, k) => {
        const aat = `${eat}.animate[${k}]`
        if (!isObj(a)) { err('BAD_KEYFRAME', aat, 'må være objekt'); el.animate[k] = null; return }
        if (!ANIM_PROPS.includes(a.prop)) err('BAD_KEYFRAME_PROP', `${aat}.prop`, ANIM_PROPS.join('|'))
        for (const f of ['from', 'to', 'start', 'end'])
          if (!isNum(a[f])) err('BAD_KEYFRAME_NUM', `${aat}.${f}`, 'må være tall')
        if (isNum(a.start) && isNum(a.end) && a.end <= a.start)
          err('BAD_KEYFRAME_RANGE', aat, 'end må være > start')
        a.easing = isStr(a.easing) ? a.easing : 'easeInOutQuad'
      })
      el.animate = el.animate.filter(Boolean)
    })
  })

  if (videoElementCount > LIMITS.maxVideoElements)
    err('TOO_MANY_VIDEO_ELEMENTS', 'scenes', `maks ${LIMITS.maxVideoElements} videoklipp totalt`)

  // Total varighet (uten overlapp-fratrekk — konservativ øvre grense).
  if (totalDuration > LIMITS.maxDurationSec)
    err('DURATION_LIMIT', 'scenes', `total varighet maks ${LIMITS.maxDurationSec}s`)

  // ── captions ──
  if (!Array.isArray(p.captions)) {
    if (p.captions != null) err('BAD_CAPTIONS', 'captions', 'må være liste')
    p.captions = []
  }
  if (p.captions.length > LIMITS.maxCaptions)
    err('TOO_MANY_CAPTIONS', 'captions', `maks ${LIMITS.maxCaptions}`)
  p.captions.forEach((cap, i) => {
    const at = `captions[${i}]`
    if (!isObj(cap)) { err('BAD_CAPTION', at, 'må være objekt'); p.captions[i] = null; return }
    if (!isStr(cap.text)) err('MISSING_CAPTION_TEXT', `${at}.text`, 'kreves')
    else if (cap.text.length > LIMITS.maxTextLength)
      err('CAPTION_TOO_LONG', `${at}.text`, `maks ${LIMITS.maxTextLength} tegn`)
    if (!isNum(cap.start) || !isNum(cap.end) || cap.end <= cap.start)
      err('BAD_CAPTION_TIME', at, 'start/end må være tall med end > start')
    else if (cap.start < 0 || cap.start > totalDuration)
      err('CAPTION_OUT_OF_RANGE', `${at}.start`, `innenfor [0, ${totalDuration.toFixed(1)}]`)
    if (!isObj(cap.style)) cap.style = {}
  })
  p.captions = p.captions.filter(Boolean)

  // ── audio ──
  if (p.audio != null) {
    if (!isObj(p.audio)) { err('BAD_AUDIO', 'audio', 'må være objekt'); p.audio = null }
    else {
      for (const trk of ['music', 'voiceover']) {
        const a = p.audio[trk]
        if (a == null) continue
        if (!isObj(a)) { err('BAD_AUDIO_TRACK', `audio.${trk}`, 'må være objekt'); p.audio[trk] = null; continue }
        const hasAssetId = isStr(a.assetId) && a.assetId.length > 0
        const hasSrc = isStr(a.src) && a.src.length > 0
        if (!hasAssetId && !(allowLocalPaths && hasSrc))
          err('MISSING_ASSET_ID', `audio.${trk}.assetId`, 'assetId kreves')
        a.volume = inRange(a.volume, 0, 2) ? a.volume : (trk === 'music' ? 0.3 : 1.0)
      }
    }
  }

  return { ok: errors.length === 0, errors, project: errors.length === 0 ? p : null }
}
