import { useEffect, useRef, useState } from 'react'
import type { Reel } from '../api'

interface Props {
  reels: Reel[]
  activeId: string | null
  onSwitch: (id: string) => void
  onCreate: (name: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
}

/** Header dropdown to choose / create / rename / delete the active project (reel). */
export function ReelSwitcher({
  reels,
  activeId,
  onSwitch,
  onCreate,
  onRename,
  onDelete,
}: Props) {
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  const active = reels.find((r) => r.id === activeId)

  // Close on a press that STARTS outside the switcher. Must be `mousedown`, not
  // `click`: an in-menu button (pencil, "+ New project", the active name) swaps
  // itself for an <input> on click, so by the time a `click` listener ran, the
  // clicked node would already be detached and `contains()` would wrongly say
  // "outside" and close the menu. mousedown fires before any of that re-render.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
        setEditingId(null)
        setCreating(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  function startRename(r: Reel) {
    setEditingId(r.id)
    setDraft(r.name)
    setCreating(false)
  }

  function commitRename() {
    if (editingId) {
      const name = draft.trim()
      if (name) onRename(editingId, name)
    }
    setEditingId(null)
  }

  function commitCreate() {
    const name = newName.trim()
    if (!name) return
    onCreate(name)
    setCreating(false)
    setNewName('')
    setOpen(false)
  }

  return (
    <div className="reel-switcher" ref={rootRef}>
      <button
        className="reel-switcher-trigger"
        onClick={() => setOpen((v) => !v)}
        title="switch project"
      >
        <span className="rs-name">{active?.name ?? 'Project'}</span>
        <span className="rs-caret">▾</span>
      </button>
      {open && (
        <div className="reel-switcher-menu">
          <ul className="rs-list">
            {reels.map((r) => (
              <li key={r.id} className={'rs-item' + (r.id === activeId ? ' active' : '')}>
                {editingId === r.id ? (
                  <input
                    className="rs-edit"
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                  />
                ) : (
                  <>
                    <button
                      className="rs-pick"
                      onClick={() => {
                        // the active project is already open → click its name to
                        // rename it; other rows switch
                        if (r.id === activeId) startRename(r)
                        else {
                          onSwitch(r.id)
                          setOpen(false)
                        }
                      }}
                      title={r.id === activeId ? 'click to rename' : 'click to open'}
                    >
                      <span className="rs-check">{r.id === activeId ? '✓' : ''}</span>
                      <span className="rs-item-name">{r.name}</span>
                      <span className="rs-count">{r.clip_ids.length}</span>
                    </button>
                    <button
                      className="rs-ico"
                      title="rename project"
                      onClick={() => startRename(r)}
                    >
                      ✎
                    </button>
                    <button
                      className="rs-ico rs-del"
                      title="delete project"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete project “${r.name}”? This removes its ${r.clip_ids.length} video(s) from kitcut. Your original files are not touched.`,
                          )
                        ) {
                          onDelete(r.id)
                          setOpen(false)
                        }
                      }}
                    >
                      ×
                    </button>
                  </>
                )}
              </li>
            ))}
            {!reels.length && <li className="rs-empty">No projects yet</li>}
          </ul>
          {creating ? (
            <input
              className="rs-edit rs-new-input"
              autoFocus
              placeholder="Project name — Enter to create"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={() => {
                setCreating(false)
                setNewName('')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitCreate()
                if (e.key === 'Escape') {
                  setCreating(false)
                  setNewName('')
                }
              }}
            />
          ) : (
            <button className="rs-new" onClick={() => setCreating(true)}>
              + New project
            </button>
          )}
        </div>
      )}
    </div>
  )
}
