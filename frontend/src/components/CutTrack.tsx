import { useEffect, useRef, useState, type RefObject } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'
import type { CutRegion, SilenceKind } from '../api'

const COLORS: Record<SilenceKind, string> = {
  speech: 'rgba(192, 57, 43, 0.30)',
  nonspeech: 'rgba(230, 126, 34, 0.32)',
}
const MANUAL_COLOR = 'rgba(231, 76, 60, 0.45)' // red for manual / b-cuts
const PENDING_COLOR = 'rgba(231, 76, 60, 0.95)'

interface Props {
  audioUrl: string
  cuts: CutRegion[]
  revision: number
  onCutsChange: (cuts: CutRegion[]) => void
  videoRef: RefObject<HTMLVideoElement | null>
}

export function CutTrack({ audioUrl, cuts, revision, onCutsChange, videoRef }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wsRef = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const regionsRef = useRef<any>(null)
  const cutsRef = useRef<CutRegion[]>(cuts)
  const manualIds = useRef<Set<string>>(new Set())
  const programmatic = useRef(false)
  const pendingStart = useRef<number | null>(null)
  const [ready, setReady] = useState(false)
  const [pxPerSec, setPxPerSec] = useState(0)
  const [pendingMsg, setPendingMsg] = useState<string | null>(null)
  cutsRef.current = cuts

  function collect(): CutRegion[] {
    const regs = (regionsRef.current?.getRegions() ?? []).filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (r: any) => r.id !== 'pending',
    )
    const byId = new Map(cutsRef.current.map((c) => [c.id, c]))
    return regs
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((r: any): CutRegion => {
        const ex = byId.get(r.id)
        const isManual = manualIds.current.has(r.id) || ex?.source === 'manual'
        return {
          id: r.id,
          start: r.start,
          end: r.end,
          source: isManual ? 'manual' : 'auto',
          kind: ex?.kind ?? 'speech',
        }
      })
      .sort((a: CutRegion, b: CutRegion) => a.start - b.start)
  }

  // create wavesurfer
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
      url: audioUrl,
      plugins: [regions],
    })
    wsRef.current = ws
    regionsRef.current = regions
    setReady(false)

    ws.on('ready', () => {
      setReady(true)
      const d = ws.getDuration() || 1
      setPxPerSec(el.clientWidth / d)
    })

    // click on waveform seeks the VIDEO (wavesurfer never plays its own audio)
    ws.on('interaction', (time: number) => {
      const v = videoRef.current
      if (v) v.currentTime = time
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    regions.on('region-updated', (r: any) => {
      manualIds.current.add(r.id)
      onCutsChange(collect())
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    regions.on('region-created', (r: any) => {
      if (programmatic.current) return
      const id = `manual-${Math.random().toString(36).slice(2, 10)}`
      manualIds.current.add(id)
      r.setOptions({ id, color: MANUAL_COLOR })
      onCutsChange(collect())
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    regions.on('region-double-clicked', (r: any) => {
      r.remove()
      onCutsChange(collect())
    })
    const disableDrag = regions.enableDragSelection({ color: MANUAL_COLOR })

    return () => {
      disableDrag?.()
      ws.destroy()
      wsRef.current = null
      regionsRef.current = null
    }
  }, [audioUrl])

  // (re)render regions on ready / external recompute
  useEffect(() => {
    const regions = regionsRef.current
    if (!regions || !ready) return
    programmatic.current = true
    regions.clearRegions()
    manualIds.current.clear()
    for (const c of cutsRef.current) {
      regions.addRegion({
        id: c.id,
        start: c.start,
        end: c.end,
        color: c.source === 'manual' ? MANUAL_COLOR : COLORS[c.kind],
        drag: true,
        resize: true,
      })
    }
    programmatic.current = false
  }, [ready, revision])

  // playhead: drive the wavesurfer cursor from the video (smooth via rAF)
  useEffect(() => {
    const v = videoRef.current
    if (!v || !ready) return
    let raf = 0
    const sync = () => {
      if (wsRef.current) wsRef.current.setTime(v.currentTime)
    }
    const loop = () => {
      sync()
      raf = requestAnimationFrame(loop)
    }
    const onPlay = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(loop)
    }
    const onPause = () => {
      cancelAnimationFrame(raf)
      sync()
    }
    // On seek, just move the cursor — do NOT cancel the loop, otherwise the
    // preview-skip seek (when playback jumps over a cut) stalls the playhead.
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

  // 'b' key: first press = mark in, second = mark out -> red cut region
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
      const cur = v.currentTime

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      regions
        .getRegions()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((r: any) => r.id === 'pending')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .forEach((r: any) => r.remove())
      pendingStart.current = null
      setPendingMsg(null)
      if (b - a > 0.02) {
        const id = `manual-${Math.random().toString(36).slice(2, 10)}`
        manualIds.current.add(id)
        programmatic.current = true
        regions.addRegion({ id, start: a, end: b, color: MANUAL_COLOR, drag: true, resize: true })
        programmatic.current = false
        onCutsChange(collect())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [videoRef])

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

  return (
    <div className="cut-track">
      <div className="timeline-toolbar">
        <button onClick={() => zoomTo(pxPerSec * 1.6)}>＋</button>
        <button onClick={() => zoomTo(pxPerSec / 1.6)}>－</button>
        <button onClick={() => zoomTo(0)}>fit</button>
        <span className="b-hint">{pendingMsg ?? 'press b to set cut start, b again to set end'}</span>
      </div>
      <div ref={containerRef} className="waveform" />
      <p className="hint">
        <span className="legend speech" /> speech cut
        <span className="legend nonspeech" /> b-roll
        <span className="legend manual" /> manual / b-cut · drag edge to adjust · drag empty to add ·
        double-click to remove
      </p>
    </div>
  )
}
