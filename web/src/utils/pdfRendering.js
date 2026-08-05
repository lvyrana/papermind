export const PDF_RENDER_RADIUS = 2
export const PDF_MAX_CANVAS_DPR = 2
export const PDF_MAX_CANVAS_PIXELS = 6_000_000
export const PDF_MAX_CSS_PIXELS = 2_500_000
export const PDF_MIN_OUTPUT_SCALE = 0.5

export function hasRenderablePdfPages(pageCount) {
  return Number.isFinite(pageCount) && pageCount >= 1
}

export function getPdfRenderWindow(currentPage, totalPages, radius = PDF_RENDER_RADIUS) {
  const total = Math.max(0, Math.trunc(Number(totalPages) || 0))
  if (!total) return []

  const center = Math.min(total, Math.max(1, Math.trunc(Number(currentPage) || 1)))
  const safeRadius = Math.max(0, Math.trunc(Number(radius) || 0))
  const start = Math.max(1, center - safeRadius)
  const end = Math.min(total, center + safeRadius)
  return Array.from({ length: end - start + 1 }, (_, index) => start + index)
}

export function getPdfRenderScale(requestedScale, baseViewport, maxCssPixels = PDF_MAX_CSS_PIXELS) {
  const scale = Number.isFinite(requestedScale) && requestedScale > 0 ? requestedScale : 1
  const width = Number(baseViewport?.width) || 0
  const height = Number(baseViewport?.height) || 0
  const basePixels = width * height
  if (basePixels <= 0 || basePixels * scale * scale <= maxCssPixels) return scale
  return Math.max(0.35, Math.sqrt(maxCssPixels / basePixels))
}

export function getPdfCanvasOutputScale(
  viewport,
  devicePixelRatio = 1,
  maxCanvasPixels = PDF_MAX_CANVAS_PIXELS,
) {
  const deviceScale = Math.min(Number(devicePixelRatio) || 1, PDF_MAX_CANVAS_DPR)
  const cssPixels = (Number(viewport?.width) || 0) * (Number(viewport?.height) || 0)
  if (cssPixels <= 0) return 1
  const pixelLimitedScale = Math.sqrt(maxCanvasPixels / cssPixels)
  return Math.max(PDF_MIN_OUTPUT_SCALE, Math.min(deviceScale, pixelLimitedScale))
}

export function getPdfCanvasOutputScaleCandidates(viewport, devicePixelRatio = 1) {
  const primary = getPdfCanvasOutputScale(viewport, devicePixelRatio)
  const candidates = [
    primary,
    Math.min(primary, 1),
    Math.min(primary, 0.75),
    PDF_MIN_OUTPUT_SCALE,
  ]
  return [...new Set(candidates.map(value => Number(value.toFixed(2))))].filter(value => value > 0)
}
