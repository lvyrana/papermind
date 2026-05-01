import { useEffect, useState } from 'react'

// placement: 'bottom' | 'top' | 'left' | 'right'
export default function TourBubble({ targetRef, text, step, total, placement = 'bottom', onNext }) {
  const [rect, setRect] = useState(null)

  useEffect(() => {
    function update() {
      if (targetRef?.current) {
        setRect(targetRef.current.getBoundingClientRect())
      }
    }
    update()
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [targetRef])

  if (!rect) return null

  const W = 224
  const centerX = rect.left + rect.width / 2
  const bubbleLeft = Math.max(12, Math.min(centerX - W / 2, window.innerWidth - W - 12))
  const arrowLeft = Math.max(10, Math.min(centerX - bubbleLeft - 5, W - 20))

  let posStyle = { position: 'fixed', zIndex: 1000, width: W }
  if (placement === 'bottom') {
    posStyle.top = rect.bottom + 10
    posStyle.left = bubbleLeft
  } else if (placement === 'top') {
    posStyle.top = rect.top - 100
    posStyle.left = bubbleLeft
  } else if (placement === 'left') {
    posStyle.top = rect.top + rect.height / 2 - 55
    posStyle.left = rect.left - W - 10
  } else if (placement === 'right') {
    posStyle.top = rect.top + rect.height / 2 - 55
    posStyle.left = rect.right + 10
  }

  return (
    <div style={posStyle}>
      {/* Arrow */}
      {placement === 'bottom' && (
        <div style={{
          position: 'absolute', top: -5, left: arrowLeft,
          width: 0, height: 0,
          borderLeft: '5px solid transparent',
          borderRight: '5px solid transparent',
          borderBottom: '5px solid #1E3A5F',
        }} />
      )}
      {placement === 'top' && (
        <div style={{
          position: 'absolute', bottom: -5, left: arrowLeft,
          width: 0, height: 0,
          borderLeft: '5px solid transparent',
          borderRight: '5px solid transparent',
          borderTop: '5px solid #1E3A5F',
        }} />
      )}
      {placement === 'left' && (
        <div style={{
          position: 'absolute', right: -5, top: 44,
          width: 0, height: 0,
          borderTop: '5px solid transparent',
          borderBottom: '5px solid transparent',
          borderLeft: '5px solid #1E3A5F',
        }} />
      )}
      {placement === 'right' && (
        <div style={{
          position: 'absolute', left: -5, top: 44,
          width: 0, height: 0,
          borderTop: '5px solid transparent',
          borderBottom: '5px solid transparent',
          borderRight: '5px solid #1E3A5F',
        }} />
      )}

      {/* Bubble body */}
      <div style={{
        background: '#1E3A5F',
        borderRadius: 14,
        padding: '13px 15px',
        boxShadow: '0 8px 32px rgba(30,58,95,0.28)',
        color: '#FFFDF9',
      }}>
        <p style={{ fontSize: 13, lineHeight: 1.65, margin: '0 0 10px', fontFamily: "'DM Sans', system-ui" }}>
          {text}
        </p>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 11, opacity: 0.4, fontFamily: 'monospace' }}>{step} / {total}</span>
          <button
            onClick={onNext}
            style={{
              background: '#E8877A', color: '#FFFDF9',
              border: 'none', borderRadius: 8,
              padding: '5px 12px', fontSize: 12,
              fontWeight: 500, cursor: 'pointer',
              fontFamily: "'DM Sans', system-ui",
            }}
          >
            {step < total ? '下一步 →' : '知道了 ✓'}
          </button>
        </div>
      </div>
    </div>
  )
}
