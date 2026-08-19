/** Ren, deterministisk fit-geometri; delt av server-render og tester/browser. */
export function fittedPlacement({ imageWidth, imageHeight, x, y, width, height, fit, focalPoint = null }) {
  if (fit === 'fill' || !fit) return { x, y, width, height, clip: false }
  const scale = fit === 'cover'
    ? Math.max(width / imageWidth, height / imageHeight)
    : Math.min(width / imageWidth, height / imageHeight)
  const drawWidth = imageWidth * scale
  const drawHeight = imageHeight * scale
  const fx = fit === 'cover' ? (focalPoint?.x ?? 0.5) : 0.5
  const fy = fit === 'cover' ? (focalPoint?.y ?? 0.5) : 0.5
  return {
    x: x + (width - drawWidth) * fx,
    y: y + (height - drawHeight) * fy,
    width: drawWidth,
    height: drawHeight,
    clip: fit === 'cover',
  }
}
