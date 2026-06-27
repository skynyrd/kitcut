import { Fragment, useEffect, useRef, useState } from 'react'
import type { Segment } from '../api'

/** A non-speech span in the transcript (between lines, or head/tail). `cut` is its
 *  current net state derived from `kept`. */
export type Gap = { start: number; end: number; cut: boolean }

export interface TranscriptGaps {
  head: Gap | null
  after: Record<number, Gap> // keyed by the preceding segment id; last one is the tail
}

const GAP_SUBTLE = 1.0 // s — shorter gaps render as a thin, muted row

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function gapLen(s: number): string {
  return s >= 60 ? fmt(s) : `${s.toFixed(1)}s`
}

function lead(text: string): string {
  return text.match(/^\s*/)?.[0] ?? ''
}

interface Props {
  segments: Segment[]
  gaps: TranscriptGaps
  currentTime: number
  onToggleWord: (segId: number, idx: number) => void
  onToggleSegment: (segId: number, removed: boolean) => void
  onToggleHiddenSegment: (segId: number, hidden: boolean) => void
  onToggleGap: (start: number, end: number, cut: boolean) => void
  onSeek: (t: number) => void
  onEditWord: (segId: number, idx: number, text: string) => void
}

export function TranscriptView({
  segments,
  gaps,
  currentTime,
  onToggleWord,
  onToggleSegment,
  onToggleHiddenSegment,
  onToggleGap,
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

  function gapRow(gap: Gap, key: string) {
    const len = gap.end - gap.start
    return (
      <div
        key={key}
        className={'gap-row' + (len < GAP_SUBTLE ? ' subtle' : '') + (gap.cut ? ' cut' : '')}
      >
        <button className="ts seek" title="seek here" onClick={() => onSeek(gap.start)}>
          {fmt(gap.start)}
        </button>
        <span className="gap-label">{gapLen(len)} {gap.cut ? 'cut' : 'silence'}</span>
        <button
          className="seg-action gap-action"
          onClick={() => onToggleGap(gap.start, gap.end, gap.cut)}
          title={gap.cut ? 'restore this silence' : 'cut this silence'}
        >
          {gap.cut ? 'restore' : 'cut'}
        </button>
      </div>
    )
  }

  if (!segments.length) {
    return <p className="muted">No transcript yet.</p>
  }

  return (
    <div className="transcript">
      <p className="hint">
        Click a word to cut it · double-click to edit text · click the time to seek ·
        “cut” trims the video, “remove” drops only the text
      </p>
      {gaps.head && gapRow(gaps.head, 'gap-head')}
      {segments.map((seg) => {
        const allRemoved = seg.words.length > 0 && seg.words.every((w) => w.removed)
        const allHidden = seg.words.length > 0 && seg.words.every((w) => w.hidden)
        const after = gaps.after[seg.id]
        return (
          <Fragment key={seg.id}>
          <p className="segment">
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
                          (w.hidden ? ' hidden' : '') +
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
              title={allRemoved ? 'restore sentence' : 'cut sentence (trims the video)'}
            >
              {allRemoved ? 'restore' : 'cut'}
            </button>
            <button
              className="seg-action remove"
              onClick={() => onToggleHiddenSegment(seg.id, !allHidden)}
              title={
                allHidden
                  ? 'restore text'
                  : 'remove text only (keeps the video)'
              }
            >
              {allHidden ? 'restore' : 'remove'}
            </button>
          </p>
          {after && gapRow(after, `gap-${seg.id}`)}
          </Fragment>
        )
      })}
    </div>
  )
}
