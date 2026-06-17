import { useRef, type PointerEvent } from 'react'
import type { SilenceKind, TimelineClip } from '../api'

const CUT_COLORS: Record<SilenceKind, string> = {
  speech: 'rgba(192, 57, 43, 0.55)',
  nonspeech: 'rgba(230, 126, 34, 0.6)',
}
const MANUAL_COLOR = 'rgba(231, 76, 60, 0.6)'
const WORD_COLOR = 'rgba(142, 68, 173, 0.55)'

interface Props {
  clips: TimelineClip[]
  globalTime: number
  activeId: string | null
  onScrub: (globalTime: number) => void
}

export function ReelTimeline({ clips, globalTime, activeId, onScrub }: Props) {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const total = clips.reduce((a, c) => a + (c.duration || 0), 0)
  if (!total) return null

  function pick(clientX: number) {
    const el = trackRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    onScrub(ratio * total)
  }

  function down(e: PointerEvent<HTMLDivElement>) {
    dragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    pick(e.clientX)
  }

  return (
    <div
      className="rt-track"
      ref={trackRef}
      onPointerDown={down}
      onPointerMove={(e) => dragging.current && pick(e.clientX)}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
    >
      {clips.map((c) => {
        const left = (c.offset / total) * 100
        const width = (c.duration / total) * 100
        const dur = c.duration || 1
        return (
          <div
            key={c.id}
            className={'rt-clip' + (c.id === activeId ? ' active' : '')}
            style={{ left: `${left}%`, width: `${width}%` }}
          >
            <span className="rt-label" title={c.name}>
              {c.name}
            </span>
            {c.cuts.map((cut) => (
              <div
                key={cut.id}
                className="rt-region"
                style={{
                  left: `${(cut.start / dur) * 100}%`,
                  width: `${((cut.end - cut.start) / dur) * 100}%`,
                  background: cut.source === 'manual' ? MANUAL_COLOR : CUT_COLORS[cut.kind],
                }}
              />
            ))}
            {c.word_cuts.map((w, i) => (
              <div
                key={`w${i}`}
                className="rt-region"
                style={{
                  left: `${(w.start / dur) * 100}%`,
                  width: `${((w.end - w.start) / dur) * 100}%`,
                  background: WORD_COLOR,
                }}
              />
            ))}
          </div>
        )
      })}
      <div
        className="rt-playhead"
        style={{ left: `${(Math.min(globalTime, total) / total) * 100}%` }}
      />
    </div>
  )
}
