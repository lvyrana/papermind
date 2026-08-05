export const PDF_RENDER_RADIUS = 2

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
