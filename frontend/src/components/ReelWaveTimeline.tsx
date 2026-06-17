import { useEffect, useRef, useState, type RefObject } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'
import { reelAudioUrl, type CutRegion, type SilenceKind, type TimelineClip } from '../api'

const CUT_COLORS: Record<SilenceKind, string> = {
  speech: 'rgba(192, 57, 43, 0.30)',
  nonspeech: 'rgba(230, 126, 34, 0.32)',
}
const MANUAL_COLOR = 'rgba(231, 76, 60, 0.45)'
const PENDING_COLOR = 'rgba(231, 76, 60, 0.95)'
const WORD_COLOR = 'rgba(142, 68, 173, 0.40)'
const BAND_A = 'rgba(122, 156, 198, 0.05)'
const BAND_B = 'rgba(122, 156, 198, 0.14)'
const DIVIDER = '2px solid rgba(30, 58, 95, 0.6)'
const ACTIVE_FRAME = 'inset 0 0 0 2px rgba(93, 255, 143, 0.55)'
const SELECT_OUTLINE = '2px solid #5dff8f'

interface MenuState {
  x: number
  y: number
  regionId: string | null
  clipId: string | null
}

interface Props {
  reelId: string
  clips: TimelineClip[]
  activeId: string | null
  globalTime: number
  audioRev: number
  onScrub: (globalTime: number) => void
  onClipCutsChange: (clipId: string, cuts: CutRegion[]) => void
  onRemoveClip: (clipId: string) => void
  videoRef: RefObject<HTMLVideoElement | null>
}

function labelEl(name: string, active: boolean): HTMLElement {
  const span = document.createElement('span')
  span.className = 'rwt-label' + (active ? ' active' : '')
  span.textContent = name
  return span
}

const isWord = (id: string) => id.includes('::word-')
const isLabel = (id: string) => id.startsWith('label::')
const isBand = (id: string) => id.startsWith('band::')
const isCut = (id: string) => !isWord(id) && !isLabel(id) && !isBand(id) && id !== 'pending'

/** Unified reel timeline: one waveform of the whole reel (concatenated clip
 *  audio). Every clip sits in a framed band; its cut + word regions are placed
 *  at the global offset. Cut regions are editable and route back to their clip. */
export function ReelWaveTimeline({
  reelId,
  clips,
  activeId,
  globalTime,
  audioRev,
  onScrub,
  onClipCutsChange,
  onRemoveClip,
  videoRef,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wsRef = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const regionsRef = useRef<any>(null)
  const [ready, setReady] = useState(false)
  const [pxPerSec, setPxPerSec] = useState(0)
  const [pendingMsg, setPendingMsg] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)

  const clipsRef = useRef(clips)
  clipsRef.current = clips
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const onScrubRef = useRef(onScrub)
  onScrubRef.current = onScrub
  const onCutsRef = useRef(onClipCutsChange)
  onCutsRef.current = onClipCutsChange
  const onRemoveClipRef = useRef(onRemoveClip)
  onRemoveClipRef.current = onRemoveClip
  const playingRef = useRef(false)
  const programmatic = useRef(false)
  const manualIds = useRef<Set<string>>(new Set())
  const pendingStart = useRef<number | null>(null)
  const selectedRef = useRef<string | null>(null)

  const total = clips.reduce((a, c) => a + (c.duration || 0), 0)

  function clipAt(t: number): TimelineClip | null {
    let target: TimelineClip | null = null
    for (const c of clipsRef.current) {
      const end = c.offset + (c.duration || 0)
      if (t >= c.offset && t < end) return c
      if (t >= c.offset) target = c
    }
    return target
  }

  /** Rebuild a clip's full cut list (clip-local) from the current regions. */
  function collect(clipId: string): CutRegion[] {
    const clip = clipsRef.current.find((c) => c.id === clipId)
    if (!clip) return []
    const dur = clip.duration || 1
    const prefix = `${clipId}::`
    const byId = new Map(clip.cuts.map((c) => [c.id, c]))
    return (regionsRef.current?.getRegions() ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((r: any) => r.id.startsWith(prefix) && isCut(r.id))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((r: any): CutRegion => {
        const cutId = r.id.slice(prefix.length)
        const ex = byId.get(cutId)
        const isManual = manualIds.current.has(r.id) || ex?.source === 'manual'
        return {
          id: cutId,
          start: Math.max(0, r.start - clip.offset),
          end: Math.min(dur, r.end - clip.offset),
          source: isManual ? 'manual' : 'auto',
          kind: ex?.kind ?? 'speech',
        }
      })
      .sort((a: CutRegion, b: CutRegion) => a.start - b.start)
  }

  function selectCut(regionId: string | null) {
    selectedRef.current = regionId
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(regionsRef.current?.getRegions() ?? []).forEach((r: any) => {
      if (r.element && isCut(r.id))
        r.element.style.outline = r.id === regionId ? SELECT_OUTLINE : ''
    })
  }

  function deleteRegion(regionId: string | null) {
    if (!regionId || !isCut(regionId)) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reg = (regionsRef.current?.getRegions() ?? []).find((r: any) => r.id === regionId)
    if (!reg) return
    const clipId = regionId.split('::')[0]
    reg.remove()
    if (selectedRef.current === regionId) selectCut(null)
    onCutsRef.current(clipId, collect(clipId))
  }

  // create wavesurfer; recreate only when the reel audio changes
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const regions = RegionsPlugin.create()
    const ws = WaveSurfer.create({
      container: el,
      height: 130,
      waveColor: '#9bb4d0',
      progressColor: '#9bb4d0',
      cursorColor: '#5dff8f',
      cursorWidth: 2,
      autoScroll: true,
      url: reelAudioUrl(reelId, audioRev),
      plugins: [regions],
    })
    wsRef.current = ws
    regionsRef.current = regions
    setReady(false)

    ws.on('ready', () => {
      setReady(true)
      setPxPerSec(el.clientWidth / (ws.getDuration() || 1))
    })
    ws.on('interaction', (time: number) => {
      selectCut(null)
      onScrubRef.current(time)
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    regions.on('region-clicked', (r: any, e: MouseEvent) => {
      if (!isCut(r.id)) return
      e.stopPropagation()
      selectCut(r.id)
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    regions.on('region-created', (r: any) => {
      if (programmatic.current) return
      const clip = clipAt(r.start)
      if (!clip) {
        r.remove()
        return
      }
      const id = `${clip.id}::manual-${Math.random().toString(36).slice(2, 10)}`
      manualIds.current.add(id)
      const lo = clip.offset
      const hi = clip.offset + (clip.duration || 0)
      programmatic.current = true
      r.setOptions({
        id,
        color: MANUAL_COLOR,
        start: Math.max(lo, Math.min(r.start, hi)),
        end: Math.max(lo, Math.min(r.end, hi)),
      })
      programmatic.current = false
      onCutsRef.current(clip.id, collect(clip.id))
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    regions.on('region-updated', (r: any) => {
      if (programmatic.current || !isCut(r.id)) return
      const clipId = r.id.split('::')[0]
      const clip = clipsRef.current.find((c) => c.id === clipId)
      if (!clip) return
      const lo = clip.offset
      const hi = clip.offset + (clip.duration || 0)
      const ns = Math.max(lo, Math.min(r.start, hi))
      const ne = Math.max(lo, Math.min(r.end, hi))
      if (ns !== r.start || ne !== r.end) {
        programmatic.current = true
        r.setOptions({ start: ns, end: ne })
        programmatic.current = false
      }
      manualIds.current.add(r.id)
      onCutsRef.current(clipId, collect(clipId))
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    regions.on('region-double-clicked', (r: any) => {
      if (!isCut(r.id)) return
      deleteRegion(r.id)
    })

    // right-click a cut or clip band → context menu
    const onCtx = (e: MouseEvent) => {
      const path = e.composedPath()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cutReg = (regions.getRegions() ?? []).find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (r: any) => isCut(r.id) && r.element && path.includes(r.element),
      )
      if (cutReg) {
        e.preventDefault()
        selectCut(cutReg.id)
        const clipId = cutReg.id.split('::')[0]
        setMenu({ x: e.clientX, y: e.clientY, regionId: cutReg.id, clipId })
        return
      }

      // if no cut hit, find which clip is at the cursor position by time
      // get the waveform container and calculate time from click position
      if (!el.contains(e.target as Node)) return
      const rect = el.getBoundingClientRect()
      const x = e.clientX - rect.left
      const time = (x / rect.width) * (ws.getDuration() || 0)

      // find which clip this time falls into
      for (const clip of clipsRef.current) {
        const clipStart = clip.offset
        const clipEnd = clip.offset + (clip.duration || 0)
        if (time >= clipStart && time < clipEnd) {
          e.preventDefault()
          selectCut(null)
          setMenu({ x: e.clientX, y: e.clientY, regionId: null, clipId: clip.id })
          return
        }
      }
    }
    el.addEventListener('contextmenu', onCtx)

    const disableDrag = regions.enableDragSelection({ color: MANUAL_COLOR })

    return () => {
      el.removeEventListener('contextmenu', onCtx)
      disableDrag?.()
      ws.destroy()
      wsRef.current = null
      regionsRef.current = null
    }
  }, [reelId, audioRev])

  // (re)render regions for every clip: framed band, words, then editable cuts
  useEffect(() => {
    const regions = regionsRef.current
    if (!regions || !ready) return
    programmatic.current = true
    regions.clearRegions()
    manualIds.current.clear()
    selectedRef.current = null

    // Show word regions and labels only when zoomed in (> 100px/sec)
    const showDetails = pxPerSec > 100

    clips.forEach((c, ci) => {
      const band = regions.addRegion({
        id: `band::${c.id}`,
        start: c.offset,
        end: c.offset + (c.duration || 0),
        color: ci % 2 ? BAND_B : BAND_A,
        drag: false,
        resize: false,
      })
      if (band.element) {
        band.element.style.pointerEvents = 'none'
        band.element.style.borderLeft = DIVIDER
        if (ci === clips.length - 1) band.element.style.borderRight = DIVIDER
        if (c.id === activeId) band.element.style.boxShadow = ACTIVE_FRAME
      }

      // Only show clip labels when zoomed in
      if (showDetails) {
        const lab = regions.addRegion({
          id: `label::${c.id}`,
          start: c.offset,
          content: labelEl(c.name, c.id === activeId),
          color: 'transparent',
          drag: false,
          resize: false,
        })
        if (lab.element) lab.element.style.pointerEvents = 'none'
      }

      // Only show word regions when zoomed in
      if (showDetails) {
        c.word_cuts.forEach((w, i) => {
          const wr = regions.addRegion({
            id: `${c.id}::word-${i}`,
            start: c.offset + w.start,
            end: c.offset + w.end,
            color: WORD_COLOR,
            drag: false,
            resize: false,
          })
          if (wr.element) wr.element.style.pointerEvents = 'none'
        })
      }
      for (const cut of c.cuts) {
        regions.addRegion({
          id: `${c.id}::${cut.id}`,
          start: c.offset + cut.start,
          end: c.offset + cut.end,
          color: cut.source === 'manual' ? MANUAL_COLOR : CUT_COLORS[cut.kind],
          drag: true,
          resize: true,
        })
      }
    })
    programmatic.current = false
  }, [ready, clips, activeId, pxPerSec])

  // smooth playhead from the active video (rAF); offset read live via refs
  useEffect(() => {
    const v = videoRef.current
    if (!v || !ready) return
    let raf = 0
    const offset = () =>
      clipsRef.current.find((c) => c.id === activeIdRef.current)?.offset ?? 0
    const sync = () => wsRef.current?.setTime(offset() + v.currentTime)
    const loop = () => {
      sync()
      raf = requestAnimationFrame(loop)
    }
    const onPlay = () => {
      playingRef.current = true
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(loop)
    }
    const onPause = () => {
      playingRef.current = false
      cancelAnimationFrame(raf)
      sync()
    }
    const onSeek = () => sync()
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.addEventListener('seeked', onSeek)
    sync()
    if (!v.paused) onPlay()
    return () => {
      cancelAnimationFrame(raf)
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('seeked', onSeek)
    }
  }, [videoRef, ready])

  // discrete sync for paused scrubs / clip switches (rAF owns it while playing)
  useEffect(() => {
    if (!ready || playingRef.current) return
    wsRef.current?.setTime(globalTime)
  }, [globalTime, ready])

  // delete the selected cut (Backspace/Delete); Escape clears selection
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ae = document.activeElement as HTMLElement | null
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable))
        return
      if (e.key === 'Escape') {
        selectCut(null)
        setMenu(null)
        return
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (!selectedRef.current) return
        e.preventDefault()
        deleteRegion(selectedRef.current)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 'b' key: mark cut start, then end → manual cut on the active clip
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'b' && e.key !== 'B') return
      const ae = document.activeElement as HTMLElement | null
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable))
        return
      const v = videoRef.current
      const regions = regionsRef.current
      if (!v || !regions) return
      e.preventDefault()
      const offset =
        clipsRef.current.find((c) => c.id === activeIdRef.current)?.offset ?? 0
      const cur = offset + v.currentTime

      if (pendingStart.current == null) {
        pendingStart.current = cur
        programmatic.current = true
        regions.addRegion({
          id: 'pending',
          start: cur,
          end: cur + 0.04,
          color: PENDING_COLOR,
          drag: false,
          resize: false,
        })
        programmatic.current = false
        setPendingMsg(`cut start @ ${cur.toFixed(2)}s — press b again to set end`)
        return
      }

      const a = Math.min(pendingStart.current, cur)
      const b = Math.max(pendingStart.current, cur)
      regions
        .getRegions()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((r: any) => r.id === 'pending')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .forEach((r: any) => r.remove())
      pendingStart.current = null
      setPendingMsg(null)

      const clip = clipAt(a)
      if (!clip || b - a <= 0.02) return
      const hi = clip.offset + (clip.duration || 0)
      const id = `${clip.id}::manual-${Math.random().toString(36).slice(2, 10)}`
      manualIds.current.add(id)
      programmatic.current = true
      regions.addRegion({
        id,
        start: Math.max(clip.offset, a),
        end: Math.min(hi, b),
        color: MANUAL_COLOR,
        drag: true,
        resize: true,
      })
      programmatic.current = false
      onCutsRef.current(clip.id, collect(clip.id))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoRef])

  // close the context menu on any outside click
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu])

  function zoomTo(px: number) {
    const ws = wsRef.current
    const el = containerRef.current
    if (!ws || !el) return
    const fit = el.clientWidth / (ws.getDuration() || 1)
    const next = Math.max(fit, px)
    setPxPerSec(next)
    try {
      ws.zoom(next)
    } catch {
      /* not ready */
    }
  }

  if (!total) return null

  return (
    <div className="cut-track">
      <div className="timeline-toolbar">
        <button onClick={() => zoomTo(pxPerSec * 1.6)}>＋</button>
        <button onClick={() => zoomTo(pxPerSec / 1.6)}>－</button>
        <button onClick={() => zoomTo(0)}>fit</button>
        <span className="b-hint">
          {pendingMsg ??
            'drag empty to cut · b sets in/out · click a cut then ⌫ / right-click to delete'}
        </span>
      </div>
      <div ref={containerRef} className="waveform" />
      {menu && (
        <div className="rwt-menu" style={{ left: menu.x, top: menu.y }}>
          {menu.regionId && (
            <button
              onClick={() => {
                deleteRegion(menu.regionId)
                setMenu(null)
              }}
            >
              Delete cut
            </button>
          )}
          {menu.clipId && (
            <button
              onClick={() => {
                const clipId = menu.clipId!
                setMenu(null)
                void onRemoveClipRef.current(clipId)
              }}
            >
              Delete clip
            </button>
          )}
        </div>
      )}
      <p className="hint">
        <span className="legend speech" /> speech cut
        <span className="legend nonspeech" /> b-roll
        <span className="legend word" /> transcript cut
        <span className="legend manual" /> manual · drag edge to adjust · select + ⌫ to delete
      </p>
    </div>
  )
}
