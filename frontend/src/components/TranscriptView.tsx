import { useEffect, useRef, useState } from 'react'
import type { Segment } from '../api'

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function lead(text: string): string {
  return text.match(/^\s*/)?.[0] ?? ''
}

interface Props {
  segments: Segment[]
  currentTime: number
  onToggleWord: (segId: number, idx: number) => void
  onToggleSegment: (segId: number, removed: boolean) => void
  onSeek: (t: number) => void
  onEditWord: (segId: number, idx: number, text: string) => void
}

export function TranscriptView({
  segments,
  currentTime,
  onToggleWord,
  onToggleSegment,
  onSeek,
  onEditWord,
}: Props) {

  const [editing, setEditing] = useState<{ segId: number; idx: number; lead: string } | null>(
    null,
  )
  const [draft, setDraft] = useState('')
  const clickTimer = useRef<number | null>(null)
  const activeRef = useRef<HTMLSpanElement | null>(null)

  // active word = the one under the playhead
  let activeId: string | null = null
  for (const seg of segments) {
    for (let i = 0; i < seg.words.length; i++) {
      const w = seg.words[i]
      if (currentTime >= w.start && currentTime < w.end) {
        activeId = `${seg.id}-${i}`
      }
    }
  }

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  function handleClick(segId: number, idx: number) {
    if (clickTimer.current) window.clearTimeout(clickTimer.current)
    clickTimer.current = window.setTimeout(() => {
      onToggleWord(segId, idx)
      clickTimer.current = null
    }, 200)
  }

  function startEdit(segId: number, idx: number, text: string) {
    if (clickTimer.current) {
      window.clearTimeout(clickTimer.current)
      clickTimer.current = null
    }
    const l = lead(text)
    setEditing({ segId, idx, lead: l })
    setDraft(text.slice(l.length))
  }

  function commitEdit() {
    if (!editing) return
    onEditWord(editing.segId, editing.idx, editing.lead + draft)
    setEditing(null)
  }

  if (!segments.length) {
    return <p className="muted">No transcript yet.</p>
  }

  return (
    <div className="transcript">
      <p className="hint">
        Click a word to cut it · double-click to edit text · click the time to seek
      </p>
      {segments.map((seg) => {
        const allRemoved = seg.words.length > 0 && seg.words.every((w) => w.removed)
        return (
          <p key={seg.id} className="segment">
            <button
              className="ts seek"
              title="seek here"
              onClick={() => onSeek(seg.start)}
            >
              {fmt(seg.start)}
            </button>
            <span className="segment-text">
              {seg.words.length
                ? seg.words.map((w, i) => {
                    const id = `${seg.id}-${i}`
                    const isEditing = editing?.segId === seg.id && editing?.idx === i
                    if (isEditing) {
                      return (
                        <input
                          key={i}
                          className="word-edit"
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={commitEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitEdit()
                            if (e.key === 'Escape') setEditing(null)
                          }}
                        />
                      )
                    }
                    return (
                      <span
                        key={i}
                        ref={id === activeId ? activeRef : undefined}
                        className={
                          'word' +
                          (w.removed ? ' removed' : '') +
                          (id === activeId ? ' active' : '')
                        }
                        title={`${w.start.toFixed(2)}s`}
                        onClick={() => handleClick(seg.id, i)}
                        onDoubleClick={() => startEdit(seg.id, i, w.text)}
                      >
                        {w.text}
                      </span>
                    )
                  })
                : seg.text}
            </span>
            <button
              className="seg-action"
              onClick={() => onToggleSegment(seg.id, !allRemoved)}
              title={allRemoved ? 'restore sentence' : 'cut sentence'}
            >
              {allRemoved ? 'restore' : 'cut'}
            </button>
          </p>
        )
      })}
    </div>
  )
}
