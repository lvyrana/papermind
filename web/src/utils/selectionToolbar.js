const DEFAULT_EDGE = 12
const DEFAULT_GAP = 10

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function normalizeRect(rect) {
  if (!rect) return null
  const left = Number(rect.left ?? rect.x)
  const top = Number(rect.top ?? rect.y)
  const right = Number(rect.right ?? (left + Number(rect.width)))
  const bottom = Number(rect.bottom ?? (top + Number(rect.height)))
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) {
    return null
  }
  return { left, top, right, bottom }
}

function unionRects(rects) {
  if (!rects.length) return null
  return {
    left: Math.min(...rects.map(rect => rect.left)),
    top: Math.min(...rects.map(rect => rect.top)),
    right: Math.max(...rects.map(rect => rect.right)),
    bottom: Math.max(...rects.map(rect => rect.bottom)),
  }
}

function makeToolbarRect(left, top, width, height) {
  return { left, top, right: left + width, bottom: top + height }
}

function intersectsWithGap(a, b, gap) {
  return a.left < b.right + gap
    && a.right > b.left - gap
    && a.top < b.bottom + gap
    && a.bottom > b.top - gap
}

function overlapArea(a, b) {
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
  return width * height
}

export function getSelectionToolbarPosition(
  selection,
  toolbarRect = {},
  viewport = {},
) {
  const viewportWidth = Number(viewport.width)
    || (typeof window === 'undefined' ? 1024 : window.innerWidth)
  const viewportHeight = Number(viewport.height)
    || (typeof window === 'undefined' ? 768 : window.innerHeight)
  const edge = Number(viewport.edge) || DEFAULT_EDGE
  const gap = Number(viewport.gap) || DEFAULT_GAP
  const width = Math.min(
    Number(toolbarRect.width) || 420,
    Math.max(1, viewportWidth - edge * 2),
  )
  const height = Math.min(
    Number(toolbarRect.height) || 42,
    Math.max(1, viewportHeight - edge * 2),
  )

  const selectionRects = (selection?.selectionRects || [])
    .map(normalizeRect)
    .filter(Boolean)
  const suppliedBounds = normalizeRect(selection?.bounds)
  const fallbackBounds = normalizeRect({
    left: selection?.x || viewportWidth / 2,
    right: (selection?.x || viewportWidth / 2) + 1,
    top: selection?.y || viewportHeight / 2,
    bottom: (selection?.y || viewportHeight / 2) + 1,
  })
  const bounds = suppliedBounds || unionRects(selectionRects) || fallbackBounds
  const collisionRects = selectionRects.length ? selectionRects : [bounds]
  const centerX = (bounds.left + bounds.right) / 2
  const centerY = (bounds.top + bounds.bottom) / 2
  const centeredLeft = centerX - width / 2
  const centeredTop = centerY - height / 2

  // Keep the primary actions outside the selected text. Above is the least
  // disruptive reading position; sides come next, and below is the last choice.
  const candidates = [
    makeToolbarRect(centeredLeft, bounds.top - gap - height, width, height),
    makeToolbarRect(bounds.right + gap, centeredTop, width, height),
    makeToolbarRect(bounds.left - gap - width, centeredTop, width, height),
    makeToolbarRect(centeredLeft, bounds.bottom + gap, width, height),
  ]

  // Irregular multi-line selections can leave usable whitespace around their
  // first or last line even when their union box fills most of the viewport.
  if (selectionRects.length) {
    const ordered = [...selectionRects].sort((a, b) => a.top - b.top || a.left - b.left)
    const anchors = [ordered[0], ordered[ordered.length - 1]]
    for (const rect of anchors) {
      const lineCenterX = (rect.left + rect.right) / 2
      const lineCenterY = (rect.top + rect.bottom) / 2
      candidates.push(
        makeToolbarRect(lineCenterX - width / 2, rect.top - gap - height, width, height),
        makeToolbarRect(rect.right + gap, lineCenterY - height / 2, width, height),
        makeToolbarRect(rect.left - gap - width, lineCenterY - height / 2, width, height),
        makeToolbarRect(lineCenterX - width / 2, rect.bottom + gap, width, height),
      )
    }
  }

  const fitsViewport = rect => rect.left >= edge
    && rect.top >= edge
    && rect.right <= viewportWidth - edge
    && rect.bottom <= viewportHeight - edge
  const isClear = rect => !collisionRects.some(selected => intersectsWithGap(rect, selected, gap))
  const clearCandidate = candidates.find(rect => fitsViewport(rect) && isClear(rect))
  if (clearCandidate) {
    return { left: clearCandidate.left, top: clearCandidate.top }
  }

  // A nearly full-screen selection can leave no collision-free location.
  // Clamp candidates to the viewport and choose the one covering the least
  // selected area rather than placing the toolbar arbitrarily in the middle.
  const clamped = candidates.map((candidate, index) => {
    const left = clampNumber(candidate.left, edge, viewportWidth - edge - width)
    const top = clampNumber(candidate.top, edge, viewportHeight - edge - height)
    const rect = makeToolbarRect(left, top, width, height)
    const coveredArea = collisionRects.reduce((sum, selected) => sum + overlapArea(rect, selected), 0)
    return { rect, coveredArea, index }
  })
  clamped.sort((a, b) => a.coveredArea - b.coveredArea || a.index - b.index)
  return { left: clamped[0].rect.left, top: clamped[0].rect.top }
}
