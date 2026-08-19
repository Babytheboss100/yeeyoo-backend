// yeeyoo-media-composer — easing
// Ren matematikk, ingen avhengigheter. t ∈ [0,1] → [0,1].

export const easings = {
  linear: t => t,
  easeInQuad: t => t * t,
  easeOutQuad: t => t * (2 - t),
  easeInOutQuad: t => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  easeInCubic: t => t * t * t,
  easeOutCubic: t => --t * t * t + 1,
  easeInOutCubic: t =>
    t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1,
  // "pop": overshoot inn (back-out)
  easeOutBack: t => {
    const c1 = 1.70158
    const c3 = c1 + 1
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
  },
}

export function ease(name, t) {
  const fn = easings[name] || easings.linear
  return fn(Math.min(1, Math.max(0, t)))
}

export function lerp(a, b, t) {
  return a + (b - a) * t
}
