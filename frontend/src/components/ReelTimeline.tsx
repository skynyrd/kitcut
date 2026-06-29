import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { reelAudioUrl, type CutRegion, type TimelineClip } from '../api'
import {
  clipAtTime,
  findCutAt,
  nearestSnap,
  transitionMarkers,
  type CutSide,
} from './timelineGeometry'

// ─── Lane geometry ─────────────────────────────────────────────────────────
// Stacked lanes, drawn top→bottom on one canvas: clip ribbon, (optional) wave,
// cut lane. Nothing overlaps, so colors no longer stack — the core of the fix.
const CLIP_H = 24 // clip ribbon (names + junction transitions)
const WAVE_H = 84 // de-emphasized audio (hidden when the audio toggle is off)
const CUT_H = 34 // cut lane (silence/manual cuts + a transcript sub-strip)
const WORD_STRIP = 7 // bottom sub-strip of the cut lane for transcript cuts
const PH_OVERFLOW = 6 // playhead overhang above/below the lanes

// Solid (non-stacking) lane colors — the whole point of lanes is that nothing
// overlaps, so we no longer need translucency. Dark theme.
const BAND_A = '#16243d'
const BAND_B = '#1c2c49'
const DIVIDER = 'rgba(80, 120, 170, 0.55)'
const ACTIVE = '#5dff8f' // reserved: active/selection only
const WAVE_COLOR = '#5f7796' // muted grey-blue — context, not foreground
const LABEL_COLOR = '#cfe0f2'

// Cut lane: ONE neutral "removed" fill for every cut; the KIND is a 3px top cap,
// not a full-region hue (that was the old color-soup). Manual = dashed edge.
// Gold = transitions only; green = focus only; pink = playhead only.
const CUT_BG = 'rgba(0, 0, 0, 0.22)'
const CUT_SEP = 'rgba(80, 120, 170, 0.35)'
const REMOVED_FILL = 'rgba(150, 165, 190, 0.16)'
// faint full-height column over the waveform marking a cut, so it's visible AND
// grabbable there (editing isn't confined to the thin bottom strip)
const CUT_BAND = 'rgba(150, 165, 190, 0.09)'
const CAP_SPEECH = '#c0392b'
const CAP_BROLL = '#e67e22'
const WORD_COLOR = '#9b59b6'
const MANUAL_DASH = 'rgba(236, 110, 95, 0.95)'
const TRANS_GOLD = '#ffc233'
const SELECT_OUTLINE = '#5dff8f'
const MIN_CUT_W = 2 // tiny cuts still draw a visible sliver

const EDGE_PX = 5 // grab zone for resizing a cut edge, in pixels
const HIT_PX = 6 // min clickable body width for tiny cuts, in pixels
const SNAP_PX = 7 // magnet radius, in pixels (matches the wave timeline)
const MIN_CUT = 0.02 // s — discard cuts shorter than this

const AUDIO_KEY = 'kitcut.reelAudio'

// pointer drag state machine for the cut lane
type Drag =
  | { mode: 'scrub'; downT: number; moved: boolean }
  | { mode: 'create'; clipId: string; anchor: number; cutId: string; started: boolean }
  | {
      mode: 'move' | 'resize'
      clipId: string
      cutId: string
      side: CutSide
      grab: number // local time at pointer-down
      origStart: number // clip-local
      origEnd: number
      moved: boolean
    }

const JUNCTION_PX = 10 // how close a right-click must be to a clip boundary to mean its junction

// A togglable transition point: an internal cut-join (keyed by its cut) or a
// clip-to-clip junction (keyed by the junction's LEFT clip id). `on` = currently active.
type Seam =
  | { kind: 'cut'; clipId: string; cutId: string; on: boolean }
  | { kind: 'junction'; leftId: string; on: boolean }

// One reversible step. Clip removal is intentionally NOT undoable (it drops a
// whole video from the reel — a deliberate, heavier action).
type UndoEntry =
  | { kind: 'cuts'; clipId: string; prev: CutRegion[] } // restore a clip's cut list
  | { kind: 'junction'; leftId: string; prev: boolean } // restore a junction's enabled state

const newCutId = () => `manual-${Math.random().toString(36).slice(2, 10)}`

/** True when two cut lists describe the same edit (so a local draft can be
 *  dropped once the props round-trip catches up). */
function sameCuts(a: CutRegion[], b: CutRegion[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort((x, y) => x.start - y.start)
  const sb = [...b].sort((x, y) => x.start - y.start)
  for (let i = 0; i < sa.length; i++) {
    if (Math.abs(sa[i].start - sb[i].start) > 1e-3) return false
    if (Math.abs(sa[i].end - sb[i].end) > 1e-3) return false
    if (!!sa[i].transition !== !!sb[i].transition) return false
  }
  return true
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

interface Peaks {
  min: Float32Array
  max: Float32Array
  dur: number
  fine: number
}

/** Decode the reel WAV → a fine min/max peaks array. Drawn aggregated per-pixel,
 *  so the same array serves every zoom (no per-zoom recompute). */
function computePeaks(buf: AudioBuffer): Peaks {
  const data = buf.getChannelData(0)
  const dur = buf.duration || 1
  const fine = Math.min(48000, Math.max(1000, Math.ceil(dur * 200))) // ~5ms buckets
  const min = new Float32Array(fine)
  const max = new Float32Array(fine)
  const per = data.length / fine
  for (let i = 0; i < fine; i++) {
    const s = Math.floor(i * per)
    const e = Math.min(data.length, Math.floor((i + 1) * per))
    let lo = 0
    let hi = 0
    for (let j = s; j < e; j++) {
      const v = data[j]
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    min[i] = lo
    max[i] = hi
  }
  return { min, max, dur, fine }
}

/** Lane-based reel timeline (canvas). Replaces the WaveSurfer overlay strip:
 *  the waveform is just one (toggleable) lane, so editing/colors/transitions no
 *  longer fight a single stacked plane. 18.1 = clip + wave lanes, playhead, scrub. */
export function ReelTimeline({
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
  const scrollRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)

  const [pxPerSec, setPxPerSec] = useState(0)
  const [viewportW, setViewportW] = useState(0)
  const [audioOn, setAudioOn] = useState(
    () => (localStorage.getItem(AUDIO_KEY) ?? '1') === '1',
  )
  const [peaksRev, setPeaksRev] = useState(0) // bump to trigger a redraw on decode
  const [menu, setMenu] = useState<{
    x: number
    y: number
    clipId: string | null
    cut: { clipId: string; cutId: string } | null
    seam: Seam | null
  } | null>(null)

  const total = useMemo(
    () => clips.reduce((a, c) => a + (c.duration || 0), 0),
    [clips],
  )
  const audioKey = clipIds.join(',')

  // live refs so draw()/playhead read current values without re-binding listeners
  const ppsRef = useRef(pxPerSec)
  ppsRef.current = pxPerSec
  const viewportWRef = useRef(viewportW)
  viewportWRef.current = viewportW
  const audioOnRef = useRef(audioOn)
  audioOnRef.current = audioOn
  const clipsRef = useRef(clips)
  clipsRef.current = clips
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const disabledJunctionsRef = useRef(disabledJunctions)
  disabledJunctionsRef.current = disabledJunctions
  const onScrubRef = useRef(onScrub)
  onScrubRef.current = onScrub
  const onCutsRef = useRef(onClipCutsChange)
  onCutsRef.current = onClipCutsChange
  const onRemoveClipRef = useRef(onRemoveClip)
  onRemoveClipRef.current = onRemoveClip
  const onToggleJunctionRef = useRef(onToggleJunction)
  onToggleJunctionRef.current = onToggleJunction
  const peaksRef = useRef<Peaks | null>(null)
  const cursorRef = useRef<number | null>(null) // page-local seconds, or null = off page
  const playingRef = useRef(false)
  // local working cut lists for clips being edited — authoritative until the
  // debounced save round-trips back through props (then reconciled away)
  const editsRef = useRef<Map<string, CutRegion[]>>(new Map())
  const selectedRef = useRef<{ clipId: string; cutId: string } | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const undoRef = useRef<UndoEntry[]>([])
  const redoRef = useRef<UndoEntry[]>([])
  // snapshot taken at drag start, pushed to the undo stack only if the drag commits
  const pendingUndoRef = useRef<{ clipId: string; prev: CutRegion[] } | null>(null)

  const fit = viewportW > 0 && total > 0 ? viewportW / total : 0
  const contentWidth = Math.max(viewportW, total * pxPerSec)
  const lanesH = CLIP_H + (audioOn ? WAVE_H : 0) + CUT_H

  // ─── Canvas sizing (HiDPI) ───────────────────────────────────────────────
  function sizeCanvas() {
    const canvas = canvasRef.current
    const el = scrollRef.current
    if (!canvas || !el) return
    const w = el.clientWidth
    const h = CLIP_H + (audioOnRef.current ? WAVE_H : 0) + CUT_H
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    const ctx = canvas.getContext('2d')
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  // ─── Draw (viewport only) ────────────────────────────────────────────────
  function draw() {
    const canvas = canvasRef.current
    const el = scrollRef.current
    if (!canvas || !el) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const pps = ppsRef.current
    const w = el.clientWidth
    const audio = audioOnRef.current
    const waveH = audio ? WAVE_H : 0
    const cutY = CLIP_H + waveH
    const h = cutY + CUT_H
    const scrollLeft = el.scrollLeft
    ctx.clearRect(0, 0, w, h)
    if (pps <= 0) return

    const t0 = scrollLeft / pps
    const t1 = (scrollLeft + w) / pps
    const list = clipsRef.current

    // ── Clip lane ──
    ctx.textBaseline = 'middle'
    ctx.font = '11px system-ui, -apple-system, sans-serif'
    list.forEach((c, i) => {
      const cs = c.offset
      const ce = c.offset + (c.duration || 0)
      if (ce < t0 || cs > t1) return // viewport cull
      const x0 = cs * pps - scrollLeft
      const x1 = ce * pps - scrollLeft
      ctx.fillStyle = i % 2 ? BAND_B : BAND_A
      ctx.fillRect(x0, 0, x1 - x0, CLIP_H)
      // left divider through the whole stack
      const dx = Math.round(x0) + 0.5
      ctx.strokeStyle = DIVIDER
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(dx, 0)
      ctx.lineTo(dx, h)
      ctx.stroke()
      if (i === list.length - 1) {
        const rx = Math.round(x1) - 0.5
        ctx.beginPath()
        ctx.moveTo(rx, 0)
        ctx.lineTo(rx, h)
        ctx.stroke()
      }
      // active clip frame (green = focus only)
      if (c.id === activeIdRef.current) {
        ctx.strokeStyle = ACTIVE
        ctx.lineWidth = 2
        ctx.strokeRect(x0 + 1, 1, x1 - x0 - 2, CLIP_H - 2)
      }
      // clip name (clipped to the block)
      const bw = x1 - x0 - 8
      if (bw > 14) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(x0 + 4, 0, bw, CLIP_H)
        ctx.clip()
        ctx.fillStyle = LABEL_COLOR
        ctx.fillText(c.name, x0 + 6, CLIP_H / 2 + 0.5)
        ctx.restore()
      }
    })

    // ── Waveform lane ──
    const peaks = peaksRef.current
    if (audio && peaks) {
      const { min, max, dur, fine } = peaks
      const midY = CLIP_H + waveH / 2
      const amp = (waveH / 2) * 0.92
      ctx.strokeStyle = WAVE_COLOR
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let px = 0; px < w; px++) {
        const ta = (px + scrollLeft) / pps
        const tb = (px + 1 + scrollLeft) / pps
        if (tb < 0 || ta > dur) continue
        let b0 = Math.floor((ta / dur) * fine)
        let b1 = Math.ceil((tb / dur) * fine)
        b0 = Math.max(0, Math.min(fine - 1, b0))
        b1 = Math.max(b0 + 1, Math.min(fine, b1))
        let lo = 0
        let hi = 0
        for (let b = b0; b < b1; b++) {
          if (min[b] < lo) lo = min[b]
          if (max[b] > hi) hi = max[b]
        }
        ctx.moveTo(px + 0.5, midY - hi * amp)
        ctx.lineTo(px + 0.5, midY - lo * amp)
      }
      ctx.stroke()
    }

    // ── Cut lane ──
    ctx.fillStyle = CUT_BG
    ctx.fillRect(0, cutY, w, CUT_H)
    ctx.strokeStyle = CUT_SEP
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, cutY + 0.5)
    ctx.lineTo(w, cutY + 0.5)
    ctx.stroke()

    const cutTop = cutY + 3
    const cutBot = cutY + CUT_H - WORD_STRIP - 1
    const cutH = cutBot - cutTop
    const wordY = cutY + CUT_H - WORD_STRIP
    list.forEach((c) => {
      // transcript (word) cuts — thin distinct sub-strip along the bottom
      for (const wcut of c.word_cuts) {
        const s = c.offset + wcut.start
        const e = c.offset + wcut.end
        if (e < t0 || s > t1) continue
        const x0 = s * pps - scrollLeft
        ctx.fillStyle = WORD_COLOR
        ctx.fillRect(x0, wordY, Math.max(MIN_CUT_W, e * pps - scrollLeft - x0), WORD_STRIP - 1)
      }
      // silence / manual cuts — neutral fill + kind cap, manual = dashed edge
      const sel = selectedRef.current
      const bandTop = CLIP_H
      const bandH = cutY + CUT_H - CLIP_H
      for (const cut of cutsFor(c)) {
        const s = c.offset + cut.start
        const e = c.offset + cut.end
        if (e < t0 || s > t1) continue
        const x0 = s * pps - scrollLeft
        const dw = Math.max(MIN_CUT_W, e * pps - scrollLeft - x0)
        // faint full-height column (over the waveform too) so the cut is visible
        // and grabbable anywhere below the clip ribbon, not just the bottom strip
        ctx.fillStyle = CUT_BAND
        ctx.fillRect(x0, bandTop, dw, bandH)
        ctx.fillStyle = REMOVED_FILL
        ctx.fillRect(x0, cutTop, dw, cutH)
        ctx.fillStyle = cut.kind === 'nonspeech' ? CAP_BROLL : CAP_SPEECH
        ctx.fillRect(x0, cutTop, dw, 3)
        if (cut.source === 'manual') {
          ctx.save()
          ctx.setLineDash([3, 2])
          ctx.strokeStyle = MANUAL_DASH
          ctx.lineWidth = 1
          ctx.strokeRect(x0 + 0.5, cutTop + 0.5, dw - 1, cutH - 1)
          ctx.restore()
        }
        // a cut bridged by a transition: gold bars on its edges (= the join)
        if (cut.transition) {
          ctx.fillStyle = TRANS_GOLD
          ctx.fillRect(x0, cutTop, 3, cutH)
          ctx.fillRect(x0 + dw - 3, cutTop, 3, cutH)
        }
        // selection (green = focus only) — full height so it's obvious on the wave
        if (sel && sel.clipId === c.id && sel.cutId === cut.id) {
          ctx.strokeStyle = SELECT_OUTLINE
          ctx.lineWidth = 2
          ctx.strokeRect(x0 + 1, bandTop + 1, dw - 2, bandH - 2)
        }
      }
    })

    // ── Clip-to-clip junction transitions: a gold line on the boundary ──
    for (const m of transitionMarkers(list, disabledJunctionsRef.current)) {
      if (m.time < t0 || m.time > t1) continue
      const x = Math.round(m.time * pps - scrollLeft)
      ctx.strokeStyle = TRANS_GOLD
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(x + 0.5, 0)
      ctx.lineTo(x + 0.5, h)
      ctx.stroke()
      ctx.fillStyle = TRANS_GOLD
      ctx.beginPath()
      ctx.moveTo(x - 4, 0)
      ctx.lineTo(x + 4, 0)
      ctx.lineTo(x, 6)
      ctx.closePath()
      ctx.fill()
    }
  }

  // ─── Playhead (DOM overlay pinned to the viewport) ───────────────────────
  function positionPlayhead() {
    const ph = playheadRef.current
    if (!ph) return
    const t = cursorRef.current
    const onPage = clipsRef.current.some((c) => c.id === activeIdRef.current)
    const pps = ppsRef.current
    const x = t != null ? t * pps - (scrollRef.current?.scrollLeft ?? 0) : -1
    if (t == null || !onPage || pps <= 0 || x < 0 || x > viewportWRef.current) {
      ph.style.display = 'none'
      return
    }
    ph.style.display = 'block'
    ph.style.left = `${x}px`
  }

  // keep the playhead in view while playing (page-jump when it nears the edge)
  function followPlayhead() {
    const el = scrollRef.current
    const t = cursorRef.current
    const pps = ppsRef.current
    if (!el || t == null || pps <= 0) return
    const x = t * pps - el.scrollLeft
    if (x < 0 || x > el.clientWidth * 0.9) {
      el.scrollLeft = Math.max(0, t * pps - el.clientWidth * 0.1)
    }
  }

  // ─── Cut editing helpers ─────────────────────────────────────────────────
  /** The clip's working cut list: a local draft while editing, else the props. */
  function cutsFor(clip: TimelineClip): CutRegion[] {
    return editsRef.current.get(clip.id) ?? clip.cuts
  }
  /** Seed a mutable working copy for `clipId` (so edits don't touch props). */
  function beginEdit(clipId: string): CutRegion[] {
    let list = editsRef.current.get(clipId)
    if (!list) {
      const clip = clipsRef.current.find((c) => c.id === clipId)
      list = (clip?.cuts ?? []).map((c) => ({ ...c }))
      editsRef.current.set(clipId, list)
    }
    return list
  }
  function commitClip(clipId: string) {
    onCutsRef.current(clipId, editsRef.current.get(clipId) ?? [])
  }

  /** Magnet `t` (page-local seconds) to the nearest clip boundary / other cut
   *  edge / transcript edge / playhead within SNAP_PX. Pixel-based so the pull
   *  feels identical at any zoom. */
  function snapTime(t: number, excludeId: string | null, includePlayhead = true): number {
    const pps = ppsRef.current
    if (pps <= 0) return t
    const targets: number[] = []
    for (const c of clipsRef.current) {
      targets.push(c.offset, c.offset + (c.duration || 0))
      for (const cut of cutsFor(c)) {
        if (cut.id !== excludeId) targets.push(c.offset + cut.start, c.offset + cut.end)
      }
      for (const w of c.word_cuts) targets.push(c.offset + w.start, c.offset + w.end)
    }
    const ph = cursorRef.current
    if (includePlayhead && ph != null) targets.push(ph)
    return nearestSnap(t, targets, SNAP_PX / pps)
  }

  function selectCut(sel: { clipId: string; cutId: string } | null) {
    selectedRef.current = sel
    draw()
  }

  // ─── Undo / redo (cut edits + junction toggles; not clip removal) ────────
  const cutsForClipId = (clipId: string): CutRegion[] => {
    const clip = clipsRef.current.find((c) => c.id === clipId)
    return clip ? cutsFor(clip) : []
  }
  /** Snapshot the CURRENT state of the same target an entry points at — the inverse
   *  step, used to fill the opposite stack when undoing/redoing. */
  function captureState(e: UndoEntry): UndoEntry {
    if (e.kind === 'cuts')
      return { kind: 'cuts', clipId: e.clipId, prev: cutsForClipId(e.clipId).map((c) => ({ ...c })) }
    return { kind: 'junction', leftId: e.leftId, prev: !disabledJunctionsRef.current.includes(e.leftId) }
  }
  function applyEntry(e: UndoEntry) {
    if (e.kind === 'cuts') {
      editsRef.current.set(e.clipId, e.prev.map((c) => ({ ...c })))
      const sel = selectedRef.current
      if (sel && sel.clipId === e.clipId && !e.prev.some((c) => c.id === sel.cutId))
        selectedRef.current = null
      commitClip(e.clipId)
      draw()
    } else {
      onToggleJunctionRef.current(e.leftId, e.prev)
    }
  }
  /** Record a new reversible action; a fresh action invalidates the redo branch. */
  function recordUndo(entry: UndoEntry) {
    undoRef.current.push(entry)
    if (undoRef.current.length > 50) undoRef.current.shift()
    redoRef.current = []
  }
  function pushCutsUndo(clipId: string) {
    recordUndo({ kind: 'cuts', clipId, prev: cutsForClipId(clipId).map((c) => ({ ...c })) })
  }
  function pushPendingUndo() {
    if (!pendingUndoRef.current) return
    recordUndo({ kind: 'cuts', ...pendingUndoRef.current })
    pendingUndoRef.current = null
  }
  function undo() {
    const entry = undoRef.current.pop()
    if (!entry) return
    redoRef.current.push(captureState(entry)) // current state → redo
    applyEntry(entry)
  }
  function redo() {
    const entry = redoRef.current.pop()
    if (!entry) return
    undoRef.current.push(captureState(entry)) // current state → undo
    applyEntry(entry)
  }

  /** Scrub, snapping the target to a nearby edge (clip boundary / cut / transcript),
   *  but NOT the playhead itself (that would just stick it in place). */
  function scrubTo(t: number) {
    onScrubRef.current(snapTime(t, null, false))
  }

  function deleteCut(sel: { clipId: string; cutId: string }) {
    pushCutsUndo(sel.clipId)
    const list = beginEdit(sel.clipId).filter((c) => c.id !== sel.cutId)
    editsRef.current.set(sel.clipId, list)
    if (selectedRef.current?.cutId === sel.cutId) selectedRef.current = null
    commitClip(sel.clipId)
    draw()
  }
  function deleteSelected() {
    if (selectedRef.current) deleteCut(selectedRef.current)
  }

  /** The transition seam at a point: the cut under the cursor (its join), else a
   *  clip-to-clip boundary within JUNCTION_PX. `null` when there's no join there. */
  function seamAt(t: number, y: number): Seam | null {
    const pps = ppsRef.current
    const list = clipsRef.current
    const clip = clipAtTime(list, t)
    if (clip && inEditArea(y)) {
      const hit = findCutAt(cutsFor(clip), t - clip.offset, EDGE_PX / pps, HIT_PX / pps)
      if (hit) {
        const cut = cutsFor(clip)[hit.index]
        return { kind: 'cut', clipId: clip.id, cutId: cut.id, on: !!cut.transition }
      }
    }
    for (let i = 1; i < list.length; i++) {
      if (Math.abs(t - list[i].offset) * pps <= JUNCTION_PX) {
        const leftId = list[i - 1].id
        return { kind: 'junction', leftId, on: !disabledJunctionsRef.current.includes(leftId) }
      }
    }
    return null
  }

  function toggleSeam(s: Seam) {
    if (s.kind === 'cut') {
      pushCutsUndo(s.clipId)
      const list = beginEdit(s.clipId).map((c) =>
        c.id === s.cutId ? { ...c, transition: !c.transition } : c,
      )
      editsRef.current.set(s.clipId, list)
      commitClip(s.clipId)
      draw()
    } else {
      recordUndo({ kind: 'junction', leftId: s.leftId, prev: s.on })
      onToggleJunctionRef.current(s.leftId, !s.on)
    }
  }

  // ─── Decode audio → peaks (skipped entirely when the toggle is off) ──────
  useEffect(() => {
    if (!audioOn) {
      peaksRef.current = null
      setPeaksRev((n) => n + 1)
      return
    }
    let aborted = false
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const res = await fetch(reelAudioUrl(reelId, audioRev, clipIds), {
          signal: ctrl.signal,
        })
        const arr = await res.arrayBuffer()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const AC = window.AudioContext || (window as any).webkitAudioContext
        const actx = new AC()
        const buf = await actx.decodeAudioData(arr)
        void actx.close()
        if (aborted) return
        peaksRef.current = computePeaks(buf)
        setPeaksRev((n) => n + 1)
      } catch {
        /* fetch aborted or decode failed — leave the wave lane blank */
      }
    })()
    return () => {
      aborted = true
      ctrl.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reelId, audioRev, audioKey, audioOn])

  // ─── Track viewport width; default zoom to fit ───────────────────────────
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const apply = () => {
      const w = el.clientWidth
      setViewportW(w)
      viewportWRef.current = w
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // snap zoom up to fit whenever it would show less than the whole page
  useEffect(() => {
    if (fit > 0 && pxPerSec < fit) setPxPerSec(fit)
  }, [fit, pxPerSec])

  // ─── Redraw on any static change ─────────────────────────────────────────
  useEffect(() => {
    sizeCanvas()
    draw()
    positionPlayhead()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pxPerSec, viewportW, audioOn, peaksRev, clips, activeId, disabledJunctions])

  // ─── Redraw + reposition on scroll ───────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      draw()
      positionPlayhead()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─── Playhead driven by the active video (rAF while playing) ─────────────
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    let raf = 0
    const sync = () => {
      const c = clipsRef.current.find((cl) => cl.id === activeIdRef.current)
      cursorRef.current = c ? c.offset + v.currentTime : null
      positionPlayhead()
      if (playingRef.current) followPlayhead()
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoRef])

  // ─── Discrete cursor sync for paused scrubs / page switches ──────────────
  useEffect(() => {
    if (playingRef.current) return
    cursorRef.current = globalTime
    positionPlayhead()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalTime])

  // ─── Reconcile: drop a local draft once props catch up to it ─────────────
  useEffect(() => {
    const edits = editsRef.current
    if (!edits.size) return
    for (const c of clips) {
      const e = edits.get(c.id)
      if (e && sameCuts(e, c.cuts)) edits.delete(c.id)
    }
    for (const id of [...edits.keys()]) {
      if (!clips.some((c) => c.id === id)) edits.delete(id)
    }
    // a deleted/restored cut may have changed what's selected
    const sel = selectedRef.current
    if (sel) {
      const clip = clips.find((c) => c.id === sel.clipId)
      if (!clip || !cutsFor(clip).some((c) => c.id === sel.cutId)) selectedRef.current = null
    }
  }, [clips])

  // ─── Delete the selected cut (⌫ / Del); Esc clears selection ─────────────
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
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        redo()
        return
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (!selectedRef.current) return
        e.preventDefault()
        deleteSelected()
        return
      }
      // ← / → step the playhead one frame (precise; no snap) so you can land exactly
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const list = clipsRef.current
        if (!list.length) return
        e.preventDefault()
        const tot = list.reduce((a, c) => a + (c.duration || 0), 0)
        const cur = cursorRef.current ?? 0
        const here = clipAtTime(list, cur)
        const fps = here?.fps && here.fps > 0 ? here.fps : 30
        const next = Math.max(0, Math.min(tot, cur + (e.key === 'ArrowRight' ? 1 : -1) / fps))
        cursorRef.current = next
        positionPlayhead()
        onScrubRef.current(next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // close the context menu on any outside click
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu])

  // ─── Pointer: scrub (wave/clip lanes) + cut editing (cut lane) ───────────
  /** Pointer position → canvas-local x/y and page-local time t. Measured off the
   *  canvas itself (the drawn surface) so the lane y always lines up. */
  function locate(clientX: number, clientY: number) {
    const cv = canvasRef.current
    const rect = cv!.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    const scrollLeft = scrollRef.current?.scrollLeft ?? 0
    const t = Math.max(0, Math.min(total, (x + scrollLeft) / (ppsRef.current || 1)))
    return { x, y, t }
  }
  /** Everything below the clip ribbon is an editing surface (waveform + cut lane),
   *  so you can drag/grab cuts where the audio is — not just in the thin strip. */
  function inEditArea(y: number): boolean {
    return y >= CLIP_H && y <= CLIP_H + (audioOnRef.current ? WAVE_H : 0) + CUT_H
  }
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
  // setPointerCapture throws in some browsers if the pointer isn't active yet —
  // never let it abort the handler (that would silently kill the whole drag).
  function capture(id: number) {
    try {
      canvasRef.current?.setPointerCapture(id)
    } catch {
      /* fine without capture */
    }
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return
    const { y, t } = locate(e.clientX, e.clientY)
    const pps = ppsRef.current
    const clip = inEditArea(y) ? clipAtTime(clipsRef.current, t) : null
    if (!clip) {
      dragRef.current = { mode: 'scrub', downT: t, moved: false }
      onScrubRef.current(t) // raw live feedback; a pure click snaps on release
      capture(e.pointerId)
      return
    }
    const hit = findCutAt(cutsFor(clip), t - clip.offset, EDGE_PX / pps, HIT_PX / pps)
    if (hit) {
      const cut = cutsFor(clip)[hit.index]
      selectCut({ clipId: clip.id, cutId: cut.id })
      beginEdit(clip.id)
      pendingUndoRef.current = { clipId: clip.id, prev: cutsForClipId(clip.id).map((c) => ({ ...c })) }
      dragRef.current = {
        mode: hit.side === 'body' ? 'move' : 'resize',
        clipId: clip.id,
        cutId: cut.id,
        side: hit.side,
        grab: t,
        origStart: cut.start,
        origEnd: cut.end,
        moved: false,
      }
    } else {
      selectCut(null)
      beginEdit(clip.id) // seed the working list so the first move can push the cut
      pendingUndoRef.current = { clipId: clip.id, prev: cutsForClipId(clip.id).map((c) => ({ ...c })) }
      dragRef.current = {
        mode: 'create',
        clipId: clip.id,
        anchor: t, // raw; snapped per-edge while dragging
        cutId: newCutId(),
        started: false,
      }
    }
    capture(e.pointerId)
  }

  /** Hover affordance: resize on a cut edge, move on its body, crosshair on empty
   *  editable space, default (scrub) on the clip ribbon. */
  function updateHoverCursor(clientX: number, clientY: number) {
    const cv = canvasRef.current
    if (!cv) return
    const { y, t } = locate(clientX, clientY)
    const pps = ppsRef.current
    let cursor = 'default'
    if (inEditArea(y)) {
      const clip = clipAtTime(clipsRef.current, t)
      if (clip) {
        const hit = findCutAt(cutsFor(clip), t - clip.offset, EDGE_PX / pps, HIT_PX / pps)
        cursor = hit ? (hit.side === 'body' ? 'move' : 'ew-resize') : 'crosshair'
      }
    }
    if (cv.style.cursor !== cursor) cv.style.cursor = cursor
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current
    if (!d) {
      updateHoverCursor(e.clientX, e.clientY)
      return
    }
    const { t } = locate(e.clientX, e.clientY)
    const pps = ppsRef.current
    if (d.mode === 'scrub') {
      d.moved = true
      onScrubRef.current(t) // smooth while dragging
      return
    }
    const clip = clipsRef.current.find((c) => c.id === d.clipId)
    if (!clip) return
    const lo = clip.offset
    const hi = clip.offset + (clip.duration || 0)
    const list = editsRef.current.get(d.clipId)
    if (!list) return

    if (d.mode === 'create') {
      // threshold on the RAW drag (anchor is unsnapped) so it can't be trapped by
      // a snap target sitting on the anchor; snap each edge of the new cut.
      if (!d.started && Math.abs(t - d.anchor) * pps < 3) return // a click, not a drag
      const a = clamp(snapTime(Math.min(d.anchor, t), d.cutId), lo, hi)
      const b = clamp(snapTime(Math.max(d.anchor, t), d.cutId), lo, hi)
      if (!d.started) {
        d.started = true
        list.push({
          id: d.cutId,
          start: a - lo,
          end: b - lo,
          source: 'manual',
          kind: 'speech',
          transition: false,
        })
      } else {
        const c = list.find((x) => x.id === d.cutId)
        if (c) {
          c.start = a - lo
          c.end = b - lo
        }
      }
      draw()
      return
    }

    const c = list.find((x) => x.id === d.cutId)
    if (!c) return
    if (d.mode === 'move') {
      const width = d.origEnd - d.origStart
      let ns = lo + d.origStart + (t - d.grab)
      let ne = ns + width
      const sa = snapTime(ns, d.cutId)
      if (sa !== ns) {
        ne += sa - ns
        ns = sa
      } else {
        const sb = snapTime(ne, d.cutId)
        ns += sb - ne
        ne = sb
      }
      if (ns < lo) {
        ns = lo
        ne = lo + width
      }
      if (ne > hi) {
        ne = hi
        ns = hi - width
      }
      c.start = clamp(ns - lo, 0, hi - lo)
      c.end = clamp(ne - lo, 0, hi - lo)
    } else {
      const edge = snapTime(t, d.cutId)
      if (d.side === 'start') c.start = clamp(edge - lo, 0, d.origEnd - MIN_CUT)
      else c.end = clamp(edge - lo, d.origStart + MIN_CUT, hi - lo)
    }
    d.moved = true
    draw()
  }

  function onPointerUp(e: React.PointerEvent) {
    const d = dragRef.current
    dragRef.current = null
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      /* may not have captured */
    }
    if (!d) return
    if (d.mode === 'scrub') {
      if (!d.moved) scrubTo(d.downT) // a click (no drag) snaps to a nearby edge
      return
    }

    if (d.mode === 'create') {
      if (!d.started) {
        pendingUndoRef.current = null
        dropEditIfClean(d.clipId) // the seed clone was unused → drop it
        scrubTo(d.anchor) // a plain click → scrub (snapped to a nearby edge)
        return
      }
      const list = editsRef.current.get(d.clipId)
      const cut = list?.find((x) => x.id === d.cutId)
      if (!list || !cut || cut.end - cut.start < MIN_CUT) {
        // too short → discard
        pendingUndoRef.current = null
        if (list) editsRef.current.set(d.clipId, list.filter((x) => x.id !== d.cutId))
        dropEditIfClean(d.clipId)
        draw()
        return
      }
      pushPendingUndo()
      selectCut({ clipId: d.clipId, cutId: d.cutId })
      commitClip(d.clipId)
      return
    }

    // move / resize
    if (d.moved) {
      pushPendingUndo()
      commitClip(d.clipId)
    } else {
      // a click on a cut: no edit to save, but still move the playhead there
      pendingUndoRef.current = null
      dropEditIfClean(d.clipId)
      scrubTo(d.grab)
    }
    draw()
  }

  /** Drop a working draft once it matches props again (nothing actually changed). */
  function dropEditIfClean(clipId: string) {
    const list = editsRef.current.get(clipId)
    const clip = clipsRef.current.find((c) => c.id === clipId)
    if (list && clip && sameCuts(list, clip.cuts)) editsRef.current.delete(clipId)
  }

  // Right-click → context menu (delete cut / delete clip). Always preventDefault so
  // the canvas's native "Save Image As" menu never appears over the timeline.
  function onContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    const { y, t } = locate(e.clientX, e.clientY)
    const pps = ppsRef.current
    const clip = clipAtTime(clipsRef.current, t)
    let cut: { clipId: string; cutId: string } | null = null
    if (clip && inEditArea(y)) {
      const hit = findCutAt(cutsFor(clip), t - clip.offset, EDGE_PX / pps, HIT_PX / pps)
      if (hit) cut = { clipId: clip.id, cutId: cutsFor(clip)[hit.index].id }
    }
    if (cut) selectCut(cut)
    setMenu({ x: e.clientX, y: e.clientY, clipId: clip?.id ?? null, cut, seam: seamAt(t, y) })
  }

  // ─── Toolbar actions ─────────────────────────────────────────────────────
  function zoomTo(px: number) {
    setPxPerSec(Math.max(fit, px || fit))
  }
  function toggleAudio() {
    setAudioOn((on) => {
      const next = !on
      localStorage.setItem(AUDIO_KEY, next ? '1' : '0')
      return next
    })
  }

  if (!total) return null

  return (
    <div className="cut-track">
      <div className="timeline-toolbar">
        <button onClick={() => zoomTo(pxPerSec * 1.6)}>＋</button>
        <button onClick={() => zoomTo(pxPerSec / 1.6)}>－</button>
        <button onClick={() => zoomTo(0)}>fit</button>
        <button
          className={`rtl-audio-btn${audioOn ? ' on' : ''}`}
          onClick={toggleAudio}
          title="Show/hide the audio waveform lane"
        >
          {audioOn ? '🔊 Audio' : '🔇 No audio'}
        </button>
        <span className="b-hint">
          click to scrub (snaps) · ←/→ step a frame · drag to cut · drag a cut to move/resize ·
          right-click → transition / delete · ⌘Z undo · ⇧⌘Z redo
        </span>
      </div>
      <div className="rtl-viewport" style={{ height: lanesH }}>
        <div ref={scrollRef} className="rtl-scroll" style={{ height: lanesH }}>
          <canvas
            ref={canvasRef}
            className="rtl-canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => {
              if (canvasRef.current) canvasRef.current.style.cursor = ''
            }}
            onContextMenu={onContextMenu}
          />
          <div className="rtl-sizer" style={{ width: contentWidth, height: 1 }} />
        </div>
        <div
          ref={playheadRef}
          className="rtl-playhead"
          style={{ top: -PH_OVERFLOW, height: lanesH + PH_OVERFLOW * 2 }}
        />
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
              {menu.seam.on ? 'Remove transition' : 'Add transition'}
            </button>
          )}
          {menu.cut && (
            <button
              className="rwt-menu-del"
              onClick={() => {
                deleteCut(menu.cut!)
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
                const id = menu.clipId!
                setMenu(null)
                void onRemoveClipRef.current(id)
              }}
            >
              Delete clip
            </button>
          )}
        </div>
      )}
      <p className="hint">
        <span className="legend cap-speech" /> speech cut
        <span className="legend cap-broll" /> b-roll
        <span className="legend cap-word" /> transcript
        <span className="legend cap-manual" /> manual
        <span className="legend cap-trans" /> transition
      </p>
    </div>
  )
}
