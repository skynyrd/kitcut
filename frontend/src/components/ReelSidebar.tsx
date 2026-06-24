import { Fragment, useEffect, useRef, useState } from 'react'
import type { ClipSummary } from '../api'

interface Props {
  clips: ClipSummary[]
  activeId: string | null
  busyIds: string[]
  progressMsg: string
  pageSize: number
  onSelect: (id: string) => void
  onReorder: (clipIds: string[]) => void
  onRemove: (id: string) => void
  onAddVideos: (files: File[]) => void
  onTranscribeAll: () => void
  onStopTranscribe: () => void
}

interface MenuState {
  x: number
  y: number
  clipId: string
}

export function ReelSidebar({
  clips,
  activeId,
  busyIds,
  progressMsg,
  pageSize,
  onSelect,
  onReorder,
  onRemove,
  onAddVideos,
  onTranscribeAll,
  onStopTranscribe,
}: Props) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  function handleDrop(targetId: string) {
    if (!dragId || dragId === targetId) return setDragId(null)
    const ids = clips.map((c) => c.id)
    const from = ids.indexOf(dragId)
    const to = ids.indexOf(targetId)
    setDragId(null)
    if (from < 0 || to < 0) return
    ids.splice(to, 0, ids.splice(from, 1)[0])
    onReorder(ids)
  }

  const allTranscribed = clips.length > 0 && clips.every((c) => c.transcribed)
  const transcribedCount = clips.filter((c) => c.transcribed).length
  const isTranscribingAny = busyIds.length > 0

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu])

  function statusText(c: ClipSummary): string {
    if (busyIds.includes(c.id)) return 'transcribing…'
    if (c.transcribed) return c.language ?? 'transcribed'
    return c.status
  }

  return (
    <aside className="reel-sidebar">
      <div className="reel-sidebar-head">
        <h2>Videos</h2>
        <span className="muted">{clips.length}</span>
      </div>

      <ol className="clip-list">
        {clips.map((c, i) => (
          <Fragment key={c.id}>
            {i % pageSize === 0 && clips.length > pageSize && (
              <li className="clip-section" aria-hidden="true">
                Part {Math.floor(i / pageSize) + 1}
              </li>
            )}
          <li
            className={
              'clip-item' +
              (c.id === activeId ? ' active' : '') +
              (c.id === dragId ? ' dragging' : '')
            }
            draggable
            onDragStart={() => setDragId(c.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => handleDrop(c.id)}
            onClick={() => onSelect(c.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, clipId: c.id })
            }}
          >
            <span className="clip-grip" title="drag to reorder">
              ⠿
            </span>
            {busyIds.includes(c.id) && <span className="loading-dot" style={{ color: '#5dff8f' }}>●</span>}
            <span className="clip-index">{i + 1}</span>
            <span className="clip-main">
              <span className="clip-name" title={c.name}>
                {c.name}
              </span>
              <span className="clip-sub">
                {c.duration != null ? `${c.duration.toFixed(1)}s` : '—'} · {statusText(c)}
                {c.width != null && !c.proxy_ready && ' · optimizing…'}
              </span>
            </span>
            <button
              className="clip-remove"
              title="remove from reel"
              onClick={(e) => {
                e.stopPropagation()
                onRemove(c.id)
              }}
            >
              ×
            </button>
          </li>
          </Fragment>
        ))}
        {!clips.length && <li className="muted clip-empty">No videos yet.</li>}
      </ol>

      {menu && (
        <div className="rwt-menu" style={{ left: menu.x, top: menu.y }}>
          <button
            onClick={() => {
              onRemove(menu.clipId)
              setMenu(null)
            }}
          >
            Delete clip
          </button>
        </div>
      )}

      <div className="reel-actions">
        <input
          ref={fileRef}
          type="file"
          accept="video/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            const files = e.target.files
            if (files?.length) onAddVideos(Array.from(files))
            e.target.value = ''
          }}
        />
        <button onClick={() => fileRef.current?.click()} disabled={!!progressMsg || isTranscribingAny}>
          + Add videos
        </button>
        {!isTranscribingAny && (
          <button onClick={onTranscribeAll} disabled={allTranscribed || !clips.length || !!progressMsg}>
            Transcribe all
          </button>
        )}
        {isTranscribingAny && (
          <button onClick={onStopTranscribe} style={{ backgroundColor: '#d32f2f' }}>
            Stop transcribing
          </button>
        )}
        {!allTranscribed && clips.length > 0 && !isTranscribingAny && (
          <span className="muted" style={{ fontSize: '0.85em' }}>
            (uses default model: large-v3)
          </span>
        )}
        {isTranscribingAny && (
          <div className="progress-indicator">
            <span className="loading-dot">●</span>
            <span className="muted">
              Transcribing {transcribedCount}/{clips.length}
              {busyIds.length > 0 && ` · ${busyIds.length} active`}
            </span>
          </div>
        )}
        {progressMsg && !isTranscribingAny && (
          <div className="progress-indicator">
            <span className="loading-dot">●</span>
            <span className="muted">{progressMsg}</span>
          </div>
        )}
      </div>
    </aside>
  )
}
