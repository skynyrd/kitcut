import { useEffect, useRef, useState, type RefObject } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'
import { reelAudioUrl, type CutRegion, type SilenceKind, type TimelineClip } from '../api'
import { nearestSnap, transitionMarkers } from './timelineGeometry'

const CUT_COLORS: Record<SilenceKind, string> = {
  speech: 'rgba(192, 57, 43, 0.30)',
  nonspeech: 'rgba(230, 126, 34, 0.32)',
}
const MANUAL_COLOR = 'rgba(231, 76, 60, 0.45)'
const PENDING_COLOR = 'rgba(231, 76, 60, 0.95)'
const WORD_COLOR = 'rgba(142, 68, 173, 0.40)'
const BAND_A = 'rgba(122, 156, 198, 0.05)'
const BAND_B = 'rgba(122, 156, 198, 0.14)'
const TRANS_COLOR = '#ffc233' // transition marker line (gold — distinct from cuts/divider/active)
const DIVIDER = '2px solid rgba(30, 58, 95, 0.6)'
const ACTIVE_FRAME = 'inset 0 0 0 2px rgba(93, 255, 143, 0.55)'
const SELECT_OUTLINE = '2px solid #5dff8f'

// A togglable transition point nearest the right-click: an internal cut-join (keyed
// by its cut) or a clip-to-clip junction (keyed by the junction's LEFT clip id).
type SeamTarget =
  | { kind: 'cut'; clipId: string; cutId: string; on: boolean }
  | { kind: 'junction'; leftId: string; on: boolean }

interface MenuState {
  x: number
  y: number
  regionId: string | null // the cut under the cursor (for "Delete cut")
  clipId: string | null // the clip under the cursor (for "Delete clip")
  seam: SeamTarget | null // nearest transition point to the click (for "… transition here")
}

interface Props {
  reelId: string
  clips: TimelineClip[]
  clipIds: string[]
  activeId: string | null
  globalTime: number
  audioRev: number
  disabledJunctions: string[]
  onScrub: (globalTime: number) => void
  onClipCutsChange: (clipId: string, cuts: CutRegion[]) => void
  onRemoveClip: (clipId: string) => void
  onToggleJunction: (leftClipId: string, enabled: boolean) => void
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
const isTrans = (id: string) => id.startsWith('trans::') // a "T" transition marker
const isCut = (id: string) =>
  !isWord(id) && !isLabel(id) && !isBand(id) && !isTrans(id) && id !== 'pending'

const SNAP_PX = 7 // magnet radius for manual-cut edges, in pixels

/** Unified reel timeline: one waveform of the whole reel (concatenated clip
 *  audio). Every clip sits in a framed band; its cut + word regions are placed
 *  at the global offset. Cut regions are editable and route back to their clip. */
export function ReelWaveTimeline({
  reelId,
  clips,
  clipIds,
  activeId,
  globalTime,
  audioRev,
  disabledJunctions,
  onScrub,
  onClipCutsChange,
  onRemoveClip,
  onToggleJunction,
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
  const [viewportTime, setViewportTime] = useState({ start: 0, end: 0 })

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
  const onToggleJunctionRef = useRef(onToggleJunction)
  onToggleJunctionRef.current = onToggleJunction
  const disabledJunctionsRef = useRef(disabledJunctions)
  disabledJunctionsRef.current = disabledJunctions
  const pxPerSecRef = useRef(pxPerSec)
  pxPerSecRef.current = pxPerSec
  const globalTimeRef = useRef(globalTime)
  globalTimeRef.current = globalTime
  const playheadRef = useRef<HTMLDivElement>(null)
  const playingRef = useRef(false)
  const programmatic = useRef(false)
  // tracks the *real* (unsnapped) edges of an in-progress drag/resize so the magnet
  // can release: the plugin moves a region by delta, so if we just reset it to the
  // snap target the accumulated mouse movement is lost and the edge gets trapped.
  const dragRef = useRef<{ id: string; rs: number; re: number; ss: number; se: number } | null>(
    null,
  )
  const manualIds = useRef<Set<string>>(new Set())
  const pendingStart = useRef<number | null>(null)
  const selectedRef = useRef<string | null>(null)

  const total = clips.reduce((a, c) => a + (c.duration || 0), 0)
  const audioKey = clipIds.join(',') // identity of the page's audio

  function clipAt(t: number): TimelineClip | null {
    let target: TimelineClip | null = null
    for (const c of clipsRef.current) {
      const end = c.offset + (c.duration || 0)
      if (t >= c.offset && t < end) return c
      if (t >= c.offset) target = c
    }
    return target
  }

  /** Magnet a time onto the nearest clip boundary / other cut edge / playhead within
   *  SNAP_PX. Pixel-based so the pull feels identical at any zoom. */
  function snapTime(t: number, excludeId: string | null, includePlayhead = true): number {
    const pps = pxPerSecRef.current
    if (!pps || pps <= 0) return t
    const targets: number[] = []
    for (const c of clipsRef.current) targets.push(c.offset, c.offset + (c.duration || 0))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const r of regionsRef.current?.getRegions() ?? []) {
      // snap to other cut edges AND transcript (word) cut edges
      if (r.id !== excludeId && (isCut(r.id) || isWord(r.id))) targets.push(r.start, r.end)
    }
    // playhead skipped for the b-key marks (they already sit on it → would self-snap)
    const ph = includePlayhead ? wsRef.current?.getCurrentTime?.() : undefined
    if (typeof ph === 'number' && ph > 0) targets.push(ph)
    return nearestSnap(t, targets, SNAP_PX / pps)
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
          transition: ex?.transition ?? false, // preserve the opt-in across edits
        }
      })
      .sort((a: CutRegion, b: CutRegion) => a.start - b.start)
  }

  /** Toggle the transition at a seam (the nearest one to where the user clicked):
   *  a cut-join flips that cut's flag (read from the clip's authoritative cut list,
   *  not the viewport-culled regions); a junction toggles via the reel. */
  function toggleSeam(s: SeamTarget) {
    if (s.kind === 'cut') {
      const clip = clipsRef.current.find((c) => c.id === s.clipId)
      if (!clip) return
      // optimistic: outline the cut now, so it's instant (the save+refresh confirms it)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reg = (regionsRef.current?.getRegions() ?? []).find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (r: any) => r.id === `${s.clipId}::${s.cutId}`,
      )
      reg?.element?.classList.toggle('rwt-cut-trans', !s.on)
      onCutsRef.current(
        s.clipId,
        clip.cuts.map((c) => (c.id === s.cutId ? { ...c, transition: !c.transition } : c)),
      )
    } else {
      onToggleJunctionRef.current(s.leftId, !s.on)
    }
  }

  /** The transition seam nearest `time` within `clip`: its cut-joins and its two
   *  junctions, by distance to the nearest edge (0 when the playhead is INSIDE a cut, so
   *  parking anywhere on a cut targets it; near a clip boundary targets the boundary). */
  function nearestSeam(clip: TimelineClip, ci: number, time: number): SeamTarget | null {
    const list = clipsRef.current
    const disabled = disabledJunctionsRef.current
    type C = { seam: SeamTarget; dist: number }
    const cands: C[] = []
    for (const cut of clip.cuts) {
      const s = clip.offset + cut.start
      const e = clip.offset + cut.end
      const dist = time < s ? s - time : time > e ? time - e : 0
      cands.push({ seam: { kind: 'cut', clipId: clip.id, cutId: cut.id, on: !!cut.transition }, dist })
    }
    if (ci > 0)
      cands.push({
        seam: { kind: 'junction', leftId: list[ci - 1].id, on: !disabled.includes(list[ci - 1].id) },
        dist: Math.abs(time - clip.offset),
      })
    if (ci < list.length - 1)
      cands.push({
        seam: { kind: 'junction', leftId: clip.id, on: !disabled.includes(clip.id) },
        dist: Math.abs(time - (clip.offset + (clip.duration || 0))),
      })
    if (!cands.length) return null
    return cands.reduce((a, b) => (b.dist < a.dist ? b : a)).seam
  }

  /** A custom playhead overlay (taller than the waveform + a top handle) — wavesurfer's
   *  own cursor is clipped to the waveform height, so we draw our own and keep it in
   *  sync wherever the cursor moves (playback rAF, paused scrub, scroll, zoom). */
  function positionPlayhead() {
    const ph = playheadRef.current
    const ws = wsRef.current
    const el = containerRef.current
    if (!ph || !ws || !el) return
    const onPage = clipsRef.current.some((c) => c.id === activeIdRef.current)
    const pps = pxPerSecRef.current
    const t = ws.getCurrentTime?.() ?? 0
    const x = t * pps - (ws.getScroll?.() ?? 0)
    if (!onPage || pps <= 0 || x < 0 || x > el.clientWidth) {
      ph.style.display = 'none'
      return
    }
    ph.style.display = 'block'
    ph.style.left = `${x}px`
  }
  const positionPlayheadRef = useRef(positionPlayhead)
  positionPlayheadRef.current = positionPlayhead

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

  // Viewport-based rendering: only show regions in view + buffer
  function isRegionVisible(start: number, end: number): boolean {
    const BUFFER_TIME = 10; // seconds of buffer on each side
    return (
      end > viewportTime.start - BUFFER_TIME &&
      start < viewportTime.end + BUFFER_TIME
    );
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
      cursorWidth: 0, // hidden — we draw our own taller playhead overlay instead
      autoScroll: true,
      url: reelAudioUrl(reelId, audioRev, clipIds),
      plugins: [regions],
    })
    wsRef.current = ws
    regionsRef.current = regions
    setReady(false)

    ws.on('ready', () => {
      setReady(true)
      setPxPerSec(el.clientWidth / (ws.getDuration() || 1))
      positionPlayheadRef.current()
    })
    ws.on('scroll', () => positionPlayheadRef.current())
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
      const ss = snapTime(r.start, r.id)
      const se = snapTime(r.end, r.id)
      programmatic.current = true
      r.setOptions({
        id,
        color: MANUAL_COLOR,
        start: Math.max(lo, Math.min(ss, hi)),
        end: Math.max(lo, Math.min(se, hi)),
      })
      programmatic.current = false
      onCutsRef.current(clip.id, collect(clip.id))
    })

    // LIVE magnet while dragging/resizing. The plugin applies a delta to the
    // region each pointermove; we accumulate the true position in `dragRef` so
    // snapping is computed from where the mouse really is (and releases past the
    // threshold) rather than from the previously-snapped value.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    regions.on('region-update', (r: any, side: string | undefined) => {
      if (programmatic.current || !isCut(r.id)) return
      const clip = clipsRef.current.find((c) => c.id === r.id.split('::')[0])
      if (!clip) return
      const lo = clip.offset
      const hi = clip.offset + (clip.duration || 0)
      let d = dragRef.current
      if (!d || d.id !== r.id) {
        d = { id: r.id, rs: r.start, re: r.end, ss: r.start, se: r.end }
        dragRef.current = d
      } else {
        d.rs += r.start - d.ss // add the delta the plugin just applied
        d.re += r.end - d.se
      }
      let ns = d.rs
      let ne = d.re
      if (side === 'start') ns = snapTime(d.rs, r.id)
      else if (side === 'end') ne = snapTime(d.re, r.id)
      else {
        // moving the whole region: shift to align an edge, preserving width
        const sa = snapTime(d.rs, r.id)
        if (sa !== d.rs) {
          ns = sa
          ne = d.re + (sa - d.rs)
        } else {
          const sb = snapTime(d.re, r.id)
          ne = sb
          ns = d.rs + (sb - d.re)
        }
      }
      ns = Math.max(lo, Math.min(ns, hi))
      ne = Math.max(lo, Math.min(ne, hi))
      d.ss = ns
      d.se = ne
      if (ns !== r.start || ne !== r.end) {
        programmatic.current = true
        r.setOptions({ start: ns, end: ne })
        programmatic.current = false
      }
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    regions.on('region-updated', (r: any) => {
      dragRef.current = null
      if (programmatic.current || !isCut(r.id)) return
      const clipId = r.id.split('::')[0]
      const clip = clipsRef.current.find((c) => c.id === clipId)
      if (!clip) return
      const lo = clip.offset
      const hi = clip.offset + (clip.duration || 0)
      const ns = Math.max(lo, Math.min(snapTime(r.start, r.id), hi))
      const ne = Math.max(lo, Math.min(snapTime(r.end, r.id), hi))
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

    // right-click → context menu. The transition acts at the PLAYHEAD (positioned via
    // ←/→ or a scrub) — snapped to the nearest seam (cut-join or clip boundary) — so
    // it lands where you navigated, not where the mouse happened to be. Delete cut/clip
    // still target what was actually clicked.
    const onCtx = (e: MouseEvent) => {
      const path = e.composedPath()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cutReg = (regions.getRegions() ?? []).find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (r: any) => isCut(r.id) && r.element && path.includes(r.element),
      )
      if (!el.contains(e.target as Node)) return
      const list = clipsRef.current
      // clicked target → delete actions (click time correct at any zoom via internal scroll)
      const rect = el.getBoundingClientRect()
      const pps = pxPerSecRef.current || rect.width / (ws.getDuration() || 1)
      const clickTime = ((ws.getScroll?.() ?? 0) + (e.clientX - rect.left)) / pps
      const clickClipId = cutReg
        ? cutReg.id.split('::')[0]
        : list.find((c) => clickTime >= c.offset && clickTime < c.offset + (c.duration || 0))?.id ??
          null
      // playhead → the transition seam
      const phTime = ws.getCurrentTime?.() ?? globalTimeRef.current
      const phIdx = list.findIndex(
        (c) => phTime >= c.offset && phTime < c.offset + (c.duration || 0),
      )
      const seam = phIdx >= 0 ? nearestSeam(list[phIdx], phIdx, phTime) : null
      if (!clickClipId && !seam) return
      e.preventDefault()
      selectCut(cutReg ? cutReg.id : null)
      setMenu({
        x: e.clientX,
        y: e.clientY,
        regionId: cutReg ? cutReg.id : null,
        clipId: clickClipId,
        seam,
      })
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reelId, audioRev, audioKey])

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

      // Transcript (word) cuts — always rendered (no viewport cull), at every zoom
      // level like the silence cuts below. They're few (merged spans), and the
      // viewport cull keys off wavesurfer's inner scroll which `el.scrollLeft`
      // can't see — so culling here would wrongly hide cuts once zoomed in.
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
      for (const cut of c.cuts) {
        const cutStart = c.offset + cut.start
        const cutEnd = c.offset + cut.end
        // Phase 8.3: Viewport-based rendering - skip invisible cuts
        if (isRegionVisible(cutStart, cutEnd)) {
          const cr = regions.addRegion({
            id: `${c.id}::${cut.id}`,
            start: cutStart,
            end: cutEnd,
            color: cut.source === 'manual' ? MANUAL_COLOR : CUT_COLORS[cut.kind],
            drag: true,
            resize: true,
          })
          // A cut with a transition is BRIDGED — outline the removed region in gold so
          // the indicator sits on the join (the cut's edges), not floating mid-gap.
          if (cut.transition && cr.element) cr.element.classList.add('rwt-cut-trans')
        }
      }
    })

    // Junction transition markers: a gold vertical line on each still-enabled clip-to-
    // clip boundary. (Cut-join transitions are shown by outlining the cut above.) A
    // zero-length region renders as wavesurfer's native marker = a full-height line in
    // `color`; `.rwt-trans` brightens + thickens it. Pointer-events off so right-clicks
    // fall through to the clip beneath.
    for (const m of transitionMarkers(clips, disabledJunctions)) {
      const mk = regions.addRegion({
        id: m.id,
        start: m.time,
        color: TRANS_COLOR,
        drag: false,
        resize: false,
      })
      if (mk.element) {
        mk.element.style.pointerEvents = 'none'
        mk.element.classList.add('rwt-trans')
        mk.element.title = 'clip transition'
      }
    }
    programmatic.current = false
  }, [ready, clips, activeId, pxPerSec, viewportTime, disabledJunctions])

  // smooth playhead from the active video (rAF); offset read live via refs
  useEffect(() => {
    const v = videoRef.current
    if (!v || !ready) return
    let raf = 0
    const sync = () => {
      const c = clipsRef.current.find((cl) => cl.id === activeIdRef.current)
      if (!c) return // active clip isn't on this page → no playhead here
      wsRef.current?.setTime(c.offset + v.currentTime)
      positionPlayheadRef.current()
    }
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
    positionPlayheadRef.current()
  }, [globalTime, ready])

  // reposition the custom playhead on zoom / page / scroll changes (these don't move
  // the video, so the rAF/scrub paths above don't fire)
  useEffect(() => {
    if (!ready) return
    positionPlayheadRef.current()
  }, [ready, pxPerSec, viewportTime, activeId, clips])

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

  // ← / → step the playhead one frame, so you can land exactly on a cut/seam before
  // right-clicking to add a transition there. Hold to repeat; zoom in to see single
  // frames (one frame is sub-pixel at fit zoom).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const ae = document.activeElement as HTMLElement | null
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable))
        return
      const ws = wsRef.current
      const list = clipsRef.current
      if (!ws || !list.length) return
      e.preventDefault()
      // step from the REAL cursor position — globalTime state goes stale during playback
      const cur = ws.getCurrentTime?.() ?? globalTimeRef.current
      const here = clipAt(cur)
      const fps = here?.fps && here.fps > 0 ? here.fps : 30
      const total = list.reduce((a, c) => a + (c.duration || 0), 0)
      const next = Math.max(
        0,
        Math.min(total, cur + (e.key === 'ArrowRight' ? 1 : -1) / fps),
      )
      ws.setTime?.(next) // move the cursor + our overlay now, then seek the video
      positionPlayheadRef.current()
      onScrubRef.current(next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      const cur = snapTime(offset + v.currentTime, null, false)

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

  // Track viewport scroll position for viewport-based rendering
  useEffect(() => {
    const el = containerRef.current
    if (!el || !ready) return

    const updateViewport = () => {
      const ws = wsRef.current
      if (!ws) return
      const duration = ws.getDuration() || 0
      if (duration === 0) return

      // Calculate visible time range based on scroll position
      const scrollLeft = el.scrollLeft || 0
      const containerWidth = el.clientWidth
      const startTime = (scrollLeft / pxPerSec) * (duration / (duration || 1))
      const endTime = ((scrollLeft + containerWidth) / pxPerSec) * (duration / (duration || 1))

      setViewportTime({ start: startTime, end: endTime })
      positionPlayheadRef.current()
    }

    // Update on scroll
    el.addEventListener('scroll', updateViewport)
    // Initial update
    updateViewport()

    return () => el.removeEventListener('scroll', updateViewport)
  }, [ready, pxPerSec])

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
            'drag empty to cut · ←/→ step a frame · right-click → add transition · b sets in/out'}
        </span>
      </div>
      <div className="waveform-wrap">
        <div ref={containerRef} className="waveform" />
        <div ref={playheadRef} className="rwt-playhead" />
      </div>
      {menu && (
        <div className="rwt-menu" style={{ left: menu.x, top: menu.y }}>
          {menu.seam && (
            <button
              onClick={() => {
                toggleSeam(menu.seam!)
                setMenu(null)
              }}
            >
              {menu.seam.on ? 'Remove transition at playhead' : 'Add transition at playhead'}
            </button>
          )}
          {menu.regionId && (
            <button
              className="rwt-menu-del"
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
              className="rwt-menu-del"
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
