import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type SyntheticEvent,
} from 'react'
import {
  addReelVideos,
  cancelJob,
  createReel,
  editWordText,
  fcpxmlUrl,
  getCuts,
  getHealth,
  getProject,
  getReel,
  getReelTimeline,
  reelFcpxmlUrl,
  removeReelVideo,
  reorderReel,
  replaceCuts,
  resetTranscription,
  setRemovedWords,
  startTranscribe,
  updateCutParams,
  updateReelCutParams,
  videoUrl,
  watchJob,
  type ClipSummary,
  type CutParams,
  type CutRegion,
  type CutStats,
  type Health,
  type Project,
  type Reel,
  type ReelDetail,
  type ReelTimeline as ReelTimelineData,
} from './api'
import { ReelSidebar } from './components/ReelSidebar'
import { ReelWaveTimeline } from './components/ReelWaveTimeline'
import { SilenceControls } from './components/SilenceControls'
import { TranscriptView } from './components/TranscriptView'
import './App.css'

const MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3']
const REEL_KEY = 'kitcut.reelId'

function App() {
  const [health, setHealth] = useState<Health | null>(null)

  // reel state
  const [reel, setReel] = useState<Reel | null>(null)
  const [clips, setClips] = useState<ClipSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [busyIds, setBusyIds] = useState<string[]>([])
  const [timeline, setTimeline] = useState<ReelTimelineData | null>(null)
  const [globalTime, setGlobalTime] = useState(0)
  const [audioRev, setAudioRev] = useState(0) // bumped when the reel audio changes

  // active-clip editing state
  const [project, setProject] = useState<Project | null>(null)
  const [model, setModel] = useState('large-v3')
  const [language, setLanguage] = useState('auto')
  const [progress, setProgress] = useState(0)
  const [progressMsg, setProgressMsg] = useState('')
  const [error, setError] = useState<string | null>(null)

  const [cutParams, setCutParams] = useState<CutParams | null>(null)
  const [kept, setKept] = useState<[number, number][]>([])
  const [stats, setStats] = useState<CutStats | null>(null)
  const [cutBusy, setCutBusy] = useState(false)
  const [scope, setScope] = useState<'all' | 'clip'>('all')
  const [preview, setPreview] = useState(true)
  const [subs, setSubs] = useState(true)
  const [currentTime, setCurrentTime] = useState(0)

  const paramTimer = useRef<number | null>(null)
  const cutTimer = useRef<number | null>(null)
  const wordTimer = useRef<number | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const removesRef = useRef<[number, number][]>([])
  const previewRef = useRef(preview)
  previewRef.current = preview
  const transcribeAllAbortRef = useRef(false)
  const currentJobIdRef = useRef<string | null>(null)

  // refs to read latest values inside async job/video callbacks
  const reelRef = useRef(reel)
  reelRef.current = reel
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const modelRef = useRef(model)
  modelRef.current = model
  const languageRef = useRef(language)
  languageRef.current = language
  const timelineRef = useRef(timeline)
  timelineRef.current = timeline
  const pendingSeekRef = useRef<number | null>(null)
  const pendingPlayRef = useRef(false)

  // remove spans (complement of kept) drive preview-skip within the active clip
  removesRef.current = (() => {
    const dur = project?.duration ?? 0
    const out: [number, number][] = []
    let cursor = 0
    for (const [s, e] of kept) {
      if (s > cursor) out.push([cursor, s])
      cursor = Math.max(cursor, e)
    }
    if (dur && cursor < dur) out.push([cursor, dur])
    return out
  })()

  function activeOffset(): number {
    const tl = timelineRef.current
    return tl?.clips.find((c) => c.id === activeIdRef.current)?.offset ?? 0
  }

  async function refreshTimeline() {
    const r = reelRef.current
    if (!r) return
    try {
      setTimeline(await getReelTimeline(r.id))
    } catch {
      /* timeline overlay is best-effort */
    }
  }

  // bootstrap: health + open or create a reel
  useEffect(() => {
    getHealth().then(setHealth).catch(() => setHealth(null))
    ;(async () => {
      try {
        const stored = localStorage.getItem(REEL_KEY)
        let detail: ReelDetail | null = null
        if (stored) {
          try {
            detail = await getReel(stored)
          } catch {
            detail = null
          }
        }
        if (!detail) detail = await createReel()
        setReel(detail.reel)
        setClips(detail.clips)
        reelRef.current = detail.reel
        localStorage.setItem(REEL_KEY, detail.reel.id)
        await refreshTimeline()
        if (detail.clips.length) void selectClip(detail.clips[0].id)
      } catch (e) {
        setError(String(e))
      }
    })()
  }, [])

  // Spacebar toggles play/pause anywhere (except while typing in a field)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return
      const ae = document.activeElement as HTMLElement | null
      if (
        ae &&
        (ae.tagName === 'INPUT' ||
          ae.tagName === 'TEXTAREA' ||
          ae.tagName === 'SELECT' ||
          ae.isContentEditable)
      )
        return
      const v = videoRef.current
      if (!v) return
      e.preventDefault()
      if (v.paused) void v.play()
      else v.pause()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // keep the global playhead correct when offsets change (reorder) or clip switches
  useEffect(() => {
    setGlobalTime(activeOffset() + (videoRef.current?.currentTime ?? 0))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline, activeId])

  async function selectClip(id: string, force = false) {
    if (!force && id === activeIdRef.current) return
    setActiveId(id)
    activeIdRef.current = id
    setCurrentTime(0)
    try {
      const p = await getProject(id)
      setProject(p)
      const payload = await getCuts(id)
      setCutParams(payload.cut_params)
      setKept(payload.kept)
      setStats(payload.stats)
    } catch (e) {
      setError(String(e))
    }
  }

  // jump to a clip in the player (used by the sidebar)
  function gotoClip(id: string, localSeek = 0) {
    if (id === activeIdRef.current) {
      const v = videoRef.current
      if (v) v.currentTime = localSeek
      return
    }
    pendingSeekRef.current = localSeek
    void selectClip(id)
  }

  // scrub the unified timeline -> seek the right clip at the right local time
  function onScrub(g: number) {
    const tl = timelineRef.current
    if (!tl) return
    setGlobalTime(g)
    let target = tl.clips[0]
    for (const c of tl.clips) {
      if (g >= c.offset && g < c.offset + c.duration) {
        target = c
        break
      }
      if (g >= c.offset) target = c
    }
    if (!target) return
    const local = Math.max(0, g - target.offset)
    if (target.id === activeIdRef.current) {
      const v = videoRef.current
      if (v) v.currentTime = local
    } else {
      pendingSeekRef.current = local
      void selectClip(target.id, true)
    }
  }

  function onVideoEnded() {
    const tl = timelineRef.current
    if (!tl) return
    const idx = tl.clips.findIndex((c) => c.id === activeIdRef.current)
    const next = idx >= 0 ? tl.clips[idx + 1] : undefined
    if (next) {
      pendingSeekRef.current = 0
      pendingPlayRef.current = true
      void selectClip(next.id, true)
    }
  }

  function onVideoLoaded() {
    const v = videoRef.current
    if (!v) return
    if (pendingSeekRef.current != null) {
      v.currentTime = pendingSeekRef.current
      pendingSeekRef.current = null
    }
    if (pendingPlayRef.current) {
      pendingPlayRef.current = false
      void v.play()
    }
    setGlobalTime(activeOffset() + v.currentTime)
  }

  async function onAddVideos(files: File[]) {
    if (!reelRef.current) return
    setError(null)
    setProgressMsg('uploading…')
    try {
      const detail = await addReelVideos(reelRef.current.id, files)
      setReel(detail.reel)
      setClips(detail.clips)
      await refreshTimeline()
      setAudioRev((n) => n + 1)
      if (!activeIdRef.current && detail.clips.length) void selectClip(detail.clips[0].id)
    } catch (e) {
      setError(String(e))
    } finally {
      setProgressMsg('')
    }
  }


  async function onRemoveClip(id: string) {
    if (!reelRef.current) return
    try {
      const detail = await removeReelVideo(reelRef.current.id, id)
      setReel(detail.reel)
      setClips(detail.clips)
      await refreshTimeline()
      setAudioRev((n) => n + 1)
      if (activeIdRef.current === id) {
        const next = detail.clips[0]?.id ?? null
        if (next) void selectClip(next, true)
        else {
          setActiveId(null)
          activeIdRef.current = null
          setProject(null)
        }
      }
    } catch (e) {
      setError(String(e))
    }
  }

  async function onReorder(ids: string[]) {
    if (!reelRef.current) return
    setClips(
      (prev) => ids.map((id) => prev.find((c) => c.id === id)).filter(Boolean) as ClipSummary[],
    )
    try {
      const detail = await reorderReel(reelRef.current.id, ids)
      setReel(detail.reel)
      setClips(detail.clips)
      await refreshTimeline()
      setAudioRev((n) => n + 1)
    } catch (e) {
      setError(String(e))
    }
  }

  function transcribeClip(id: string): Promise<void> {
    return new Promise((resolve) => {
      startTranscribe(
        id,
        modelRef.current,
        languageRef.current === 'auto' ? null : languageRef.current,
      )
        .then((jobId) => {
          currentJobIdRef.current = jobId
          setError(null)
          setBusyIds((s) => (s.includes(id) ? s : [...s, id]))
          const close = watchJob(jobId, async (ev) => {
            if (id === activeIdRef.current) {
              setProgress(ev.progress)
              setProgressMsg(ev.message || ev.state)
            }
            if (ev.state === 'done') {
              const reelNow = reelRef.current
              try {
                if (reelNow) await updateCutParams(id, reelNow.default_cut_params)
              } catch {
                /* cuts compute is best-effort */
              }
              try {
                if (reelNow) {
                  const detail = await getReel(reelNow.id)
                  setReel(detail.reel)
                  setClips(detail.clips)
                }
                await refreshTimeline()
              } catch {
                /* ignore refresh failure */
              }
              if (id === activeIdRef.current) await selectClip(id, true)
              setBusyIds((s) => s.filter((x) => x !== id))
              close()
              resolve()
            } else if (ev.state === 'error') {
              // If the job was cancelled, clean up the artifacts
              if (transcribeAllAbortRef.current) {
                try {
                  await resetTranscription(id)
                } catch {
                  /* best-effort cleanup */
                }
              } else {
                setError(ev.error || 'transcription failed')
              }
              setBusyIds((s) => s.filter((x) => x !== id))
              close()
              resolve()
            }
          })
        })
        .catch((e) => {
          setError(String(e))
          resolve()
        })
    })
  }

  async function onTranscribeActive() {
    if (activeId) await transcribeClip(activeId)
  }

  async function onTranscribeAll() {
    transcribeAllAbortRef.current = false
    const targets = clips
      .filter((c) => !c.transcribed && !busyIds.includes(c.id))
      .map((c) => c.id)
    for (const id of targets) {
      if (transcribeAllAbortRef.current) break
      await transcribeClip(id) // sequential: bounds Whisper memory
    }
  }

  async function onStopTranscribe() {
    transcribeAllAbortRef.current = true
    if (currentJobIdRef.current) {
      try {
        await cancelJob(currentJobIdRef.current)
        currentJobIdRef.current = null
      } catch (e) {
        setError(String(e))
      }
    }
  }

  // refresh the active clip's editing state from its stored cuts
  async function reloadActiveCuts(id: string) {
    const payload = await getCuts(id)
    setCutParams(payload.cut_params)
    setKept(payload.kept)
    setStats(payload.stats)
  }

  function applyParams(next: CutParams) {
    // optimistic: 'all' edits the reel default, 'clip' edits the active clip
    if (scope === 'all') setReel((r) => (r ? { ...r, default_cut_params: next } : r))
    else setCutParams(next)

    const id = activeIdRef.current
    const r = reelRef.current
    if (paramTimer.current) clearTimeout(paramTimer.current)
    setCutBusy(true)
    paramTimer.current = window.setTimeout(async () => {
      try {
        if (scope === 'all' && r) {
          const detail = await updateReelCutParams(r.id, next, 'all')
          setReel(detail.reel)
          setClips(detail.clips)
          if (id) await reloadActiveCuts(id)
        } else if (id) {
          const payload = await updateCutParams(id, next)
          setCutParams(payload.cut_params)
          setKept(payload.kept)
          setStats(payload.stats)
        }
        await refreshTimeline()
      } catch (e) {
        setError(String(e))
      } finally {
        setCutBusy(false)
      }
    }, 250)
  }

  // persist a cut edit to its owning clip (active or not); refresh the timeline
  function onClipCutsChange(clipId: string, next: CutRegion[]) {
    if (cutTimer.current) clearTimeout(cutTimer.current)
    cutTimer.current = window.setTimeout(async () => {
      try {
        const payload = await replaceCuts(clipId, next)
        if (clipId === activeIdRef.current) {
          setKept(payload.kept)
          setStats(payload.stats)
        }
        await refreshTimeline()
      } catch (e) {
        setError(String(e))
      }
    }, 200)
  }

  function persistRemovedWords(segments: Project['segments']) {
    const id = activeIdRef.current
    if (!id) return
    const removed: [number, number][] = []
    segments.forEach((seg) =>
      seg.words.forEach((w, i) => {
        if (w.removed) removed.push([seg.id, i])
      }),
    )
    if (wordTimer.current) clearTimeout(wordTimer.current)
    wordTimer.current = window.setTimeout(async () => {
      try {
        const payload = await setRemovedWords(id, removed)
        setKept(payload.kept)
        setStats(payload.stats)
        await refreshTimeline()
      } catch (e) {
        setError(String(e))
      }
    }, 150)
  }

  function toggleWord(segId: number, idx: number) {
    setProject((prev) => {
      if (!prev) return prev
      const segments = prev.segments.map((seg) =>
        seg.id !== segId
          ? seg
          : {
              ...seg,
              words: seg.words.map((w, i) =>
                i === idx ? { ...w, removed: !w.removed } : w,
              ),
            },
      )
      persistRemovedWords(segments)
      return { ...prev, segments }
    })
  }

  function toggleSegment(segId: number, removed: boolean) {
    setProject((prev) => {
      if (!prev) return prev
      const segments = prev.segments.map((seg) =>
        seg.id !== segId
          ? seg
          : { ...seg, words: seg.words.map((w) => ({ ...w, removed })) },
      )
      persistRemovedWords(segments)
      return { ...prev, segments }
    })
  }

  function editWord(segId: number, idx: number, text: string) {
    setProject((prev) => {
      if (!prev) return prev
      const segments = prev.segments.map((seg) =>
        seg.id !== segId
          ? seg
          : {
              ...seg,
              words: seg.words.map((w, i) => (i === idx ? { ...w, text } : w)),
            },
      )
      return { ...prev, segments }
    })
    const id = activeIdRef.current
    if (id) editWordText(id, segId, idx, text).catch((e) => setError(String(e)))
  }

  function seek(t: number) {
    const v = videoRef.current
    if (v) v.currentTime = t
  }

  function onTimeUpdate(e: SyntheticEvent<HTMLVideoElement>) {
    const v = e.currentTarget
    const t = v.currentTime
    setCurrentTime(t)
    setGlobalTime(activeOffset() + t)
    if (!previewRef.current) return
    for (const [s, end] of removesRef.current) {
      if (t >= s && t < end - 0.02) {
        v.currentTime = end + 0.001
        break
      }
    }
  }

  function onModel(e: ChangeEvent<HTMLSelectElement>) {
    setModel(e.target.value)
  }

  const transcribed = project?.status === 'transcribed'
  const activeBusy = activeId ? busyIds.includes(activeId) : false
  const totals = timeline?.totals
  const activeSub =
    subs && project
      ? (() => {
          const seg = project.segments.find(
            (s) => currentTime >= s.start && currentTime < s.end,
          )
          if (!seg) return undefined
          const text = seg.words.length
            ? seg.words
                .filter((w) => !w.removed)
                .map((w) => w.text)
                .join('')
                .trim()
            : seg.text
          return text || undefined
        })()
      : undefined

  return (
    <main className="app">
      <header>
        <h1>kitcut</h1>
        <span className={`badge ${health?.ffmpeg ? 'good' : 'bad'}`}>
          {health?.ffmpeg ? 'backend ok' : 'backend down'}
        </span>
      </header>
      <p className="tagline">multi-video silence-cutting + transcript editing</p>

      {error && <p className="bad error-box">{error}</p>}

      <div className="reel-layout">
        <ReelSidebar
          clips={clips}
          activeId={activeId}
          busyIds={busyIds}
          progressMsg={progressMsg}
          onSelect={(id) => gotoClip(id, 0)}
          onReorder={onReorder}
          onRemove={onRemoveClip}
          onAddVideos={onAddVideos}
          onTranscribeAll={onTranscribeAll}
          onStopTranscribe={onStopTranscribe}
        />

        <div className="editor">
          {!project && (
            <section className="panel muted">
              Add videos with “+ Add videos”, then select one to start editing.
            </section>
          )}

          {project && (
            <>
              <section className="panel controls">
                <label>
                  Model{' '}
                  <select value={model} onChange={onModel} disabled={activeBusy}>
                    {MODELS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                        {m === 'medium' || m === 'large-v3' ? ' (better TR)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Language{' '}
                  <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    disabled={activeBusy}
                  >
                    <option value="auto">auto</option>
                    <option value="tr">Turkish</option>
                    <option value="en">English</option>
                  </select>
                </label>
                <button onClick={onTranscribeActive} disabled={activeBusy}>
                  {activeBusy ? 'working…' : transcribed ? 'Re-transcribe' : 'Transcribe'}
                </button>
                {activeBusy && (
                  <div className="progress">
                    <div className="bar" style={{ width: `${Math.round(progress * 100)}%` }} />
                    <span className="progress-label">{progressMsg} · {model}</span>
                  </div>
                )}
                <div className="meta">
                  <strong>{project.name}</strong> · {project.duration?.toFixed(1)}s ·{' '}
                  {project.width}×{project.height} · {project.status}
                  {project.language && ` · ${project.language}`}
                </div>
              </section>

              <div className="workspace">
                <section className="panel pane video-pane">
                  <div className="video-wrap">
                    <video
                      ref={videoRef}
                      className="video"
                      controls
                      src={videoUrl(project.id)}
                      key={project.id}
                      onTimeUpdate={onTimeUpdate}
                      onLoadedMetadata={onVideoLoaded}
                      onEnded={onVideoEnded}
                    />
                    {activeSub && <div className="subtitle-overlay">{activeSub}</div>}
                  </div>
                  <label className="check inline cc-toggle">
                    <input
                      type="checkbox"
                      checked={subs}
                      onChange={(e) => setSubs(e.target.checked)}
                    />
                    Subtitles on video
                  </label>
                </section>

                <section className="panel pane transcript-pane">
                  <h2>Transcript</h2>
                  <TranscriptView
                    segments={project.segments}
                    currentTime={currentTime}
                    onToggleWord={toggleWord}
                    onToggleSegment={toggleSegment}
                    onSeek={seek}
                    onEditWord={editWord}
                  />
                </section>
              </div>

              {timeline && timeline.clips.length > 0 && (
                <section className="panel reel-timeline-panel">
                  <div className="panel-head">
                    <h2>Reel timeline</h2>
                    <div className="head-tools">
                      <label className="check inline">
                        <input
                          type="checkbox"
                          checked={preview}
                          onChange={(e) => setPreview(e.target.checked)}
                        />
                        Preview (skip cuts on playback)
                      </label>
                      {totals && (
                        <span className="stats">
                          {totals.n_clips} clips · {totals.original_s}s →{' '}
                          {totals.final_s}s final (−{totals.removed_s}s)
                        </span>
                      )}
                      {transcribed && (
                        <a className="export-btn" href={fcpxmlUrl(project.id)}>
                          Export clip
                        </a>
                      )}
                      <a className="export-btn" href={reelFcpxmlUrl(timeline.reel.id)}>
                        Export FCPXML
                      </a>
                    </div>
                  </div>
                  <ReelWaveTimeline
                    reelId={timeline.reel.id}
                    clips={timeline.clips}
                    activeId={activeId}
                    globalTime={globalTime}
                    audioRev={audioRev}
                    onScrub={onScrub}
                    onClipCutsChange={onClipCutsChange}
                    onRemoveClip={onRemoveClip}
                    videoRef={videoRef}
                  />
                  {transcribed && cutParams && (
                    <SilenceControls
                      params={scope === 'all' && reel ? reel.default_cut_params : cutParams}
                      stats={stats}
                      busy={cutBusy}
                      scope={scope}
                      onScopeChange={setScope}
                      onChange={applyParams}
                    />
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  )
}

export default App
