import { useRef, useState } from 'react'
import type { ClipSummary } from '../api'

interface Props {
  clips: ClipSummary[]
  activeId: string | null
  busyIds: string[]
  onSelect: (id: string) => void
  onReorder: (clipIds: string[]) => void
  onRemove: (id: string) => void
  onAddVideos: (files: File[]) => void
  onTranscribeAll: () => void
}

export function ReelSidebar({
  clips,
  activeId,
  busyIds,
  onSelect,
  onReorder,
  onRemove,
  onAddVideos,
  onTranscribeAll,
}: Props) {
  const [dragId, setDragId] = useState<string | null>(null)
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
          <li
            key={c.id}
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
          >
            <span className="clip-grip" title="drag to reorder">
              ⠿
            </span>
            <span className="clip-index">{i + 1}</span>
            <span className="clip-main">
              <span className="clip-name" title={c.name}>
                {c.name}
              </span>
              <span className="clip-sub">
                {c.duration != null ? `${c.duration.toFixed(1)}s` : '—'} · {statusText(c)}
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
        ))}
        {!clips.length && <li className="muted clip-empty">No videos yet.</li>}
      </ol>

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
        <button onClick={() => fileRef.current?.click()}>+ Add videos</button>
        <button onClick={onTranscribeAll} disabled={allTranscribed || !clips.length}>
          Transcribe all
        </button>
      </div>
    </aside>
  )
}
