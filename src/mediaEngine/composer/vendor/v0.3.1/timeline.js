// yeeyoo-media-composer — timeline
// Ren tidsmatematikk. En scenes transition overlapper slutten av forrige
// scene: total varighet = sum(durations) − sum(transition.durations).
// Deterministisk: samme prosjekt + samme t → samme tilstand. Ingen klokker.

/**
 * computeTimeline(project) → {
 *   totalDuration, totalFrames, fps,
 *   scenes: [{ index, start, end, transition }]
 * }
 * start/end er scenens synlige vindu på den globale tidslinjen.
 * I overlappet [start, start + transition.duration) er både forrige og
 * denne scenen synlige (forrige under, denne over med transition-progress).
 */
export function computeTimeline(project) {
  const fps = project.canvas.fps
  const scenes = []
  let cursor = 0
  for (let i = 0; i < project.scenes.length; i++) {
    const s = project.scenes[i]
    const overlap = i === 0 ? 0 : s.transition.duration
    const start = cursor - overlap
    const end = start + s.duration
    scenes.push({ index: i, start, end, transition: s.transition })
    cursor = end
  }
  const totalDuration = cursor
  return {
    fps,
    totalDuration,
    totalFrames: Math.max(1, Math.round(totalDuration * fps)),
    scenes,
  }
}

/**
 * activeScenes(timeline, t) → liste av { index, localT, transitionProgress }
 * sortert bunn→topp. transitionProgress ∈ [0,1] er hvor langt inn i sin
 * inngangs-transition scenen er (1 = ferdig inne). Maks to scener samtidig.
 */
export function activeScenes(timeline, t) {
  const out = []
  for (const s of timeline.scenes) {
    if (t >= s.start && t < s.end) {
      const localT = t - s.start
      const td = s.transition.duration
      const transitionProgress = td > 0 ? Math.min(1, localT / td) : 1
      out.push({ index: s.index, localT, transitionProgress })
    }
  }
  // Siste frame: hold siste scene.
  if (out.length === 0 && timeline.scenes.length > 0 && t >= timeline.totalDuration) {
    const last = timeline.scenes[timeline.scenes.length - 1]
    out.push({ index: last.index, localT: last.end - last.start, transitionProgress: 1 })
  }
  return out
}

/**
 * elementVisibility(el, sceneLocalT, sceneDuration) →
 *   { visible, inProgress, outProgress }
 * inProgress ∈ [0,1] under inn-animasjon, 1 etterpå.
 * outProgress ∈ [0,1] under ut-animasjon (0 = ikke startet).
 */
export function elementVisibility(el, localT, sceneDuration) {
  const inStart = el.in.delay
  if (localT < inStart) return { visible: false, inProgress: 0, outProgress: 0 }
  const inProgress =
    el.in.type === 'none' || el.in.duration <= 0
      ? 1
      : Math.min(1, (localT - inStart) / el.in.duration)
  let outProgress = 0
  if (el.out && el.out.type !== 'none' && el.out.duration > 0) {
    const outStart = sceneDuration - el.out.duration
    if (localT >= outStart) outProgress = Math.min(1, (localT - outStart) / el.out.duration)
  }
  return { visible: true, inProgress, outProgress }
}

/** Aktive captions ved global tid t. */
export function activeCaptions(project, t) {
  return project.captions.filter(c => t >= c.start && t < c.end)
}
