import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type SyntheticEvent,
} from 'react'
import {
  audioUrl,
  createProject,
  editWordText,
  fcpxmlUrl,
  getHealth,
  getProject,
  replaceCuts,
  setRemovedWords,
  srtUrl,
  startTranscribe,
  updateCutParams,
  videoUrl,
  watchJob,
  type CutParams,
  type CutRegion,
  type CutStats,
  type Health,
  type Project,
} from './api'
import { CutTrack } from './components/CutTrack'
import { SilenceControls } from './components/SilenceControls'
import { TranscriptView } from './components/TranscriptView'
import './App.css'

const MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3']

function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [model, setModel] = useState('small')
  const [language, setLanguage] = useState('auto')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [progressMsg, setProgressMsg] = useState('')
  const [error, setError] = useState<string | null>(null)

  const [cutParams, setCutParams] = useState<CutParams | null>(null)
  const [cuts, setCuts] = useState<CutRegion[]>([])
  const [kept, setKept] = useState<[number, number][]>([])
  const [stats, setStats] = useState<CutStats | null>(null)
  const [revision, setRevision] = useState(0)
  const [cutBusy, setCutBusy] = useState(false)
  const [preview, setPreview] = useState(true)
  const [subs, setSubs] = useState(true)
  const [currentTime, setCurrentTime] = useState(0)

  const closeWs = useRef<(() => void) | null>(null)
  const paramTimer = useRef<number | null>(null)
  const cutTimer = useRef<number | null>(null)
  const wordTimer = useRef<number | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const removesRef = useRef<[number, number][]>([])
  const previewRef = useRef(preview)
  previewRef.current = preview

  // remove spans (complement of kept) drive preview-skip
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

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setHealth(null))
    return () => closeWs.current?.()
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

  async function onUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    resetCutState()
    setProject(null)
    setError(null)
    setBusy(true)
    setProgressMsg('uploading…')
    try {
      setProject(await createProject(file))
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
      setProgressMsg('')
    }
  }

  function resetCutState() {
    setCutParams(null)
    setCuts([])
    setStats(null)
  }

  async function loadCuts(p: Project) {
    const payload = await updateCutParams(p.id, p.cut_params)
    setCutParams(payload.cut_params)
    setCuts(payload.cuts)
    setKept(payload.kept)
    setStats(payload.stats)
    setRevision((r) => r + 1)
  }

  async function onTranscribe() {
    if (!project) return
    setError(null)
    setBusy(true)
    setProgress(0)
    setProgressMsg('starting…')
    try {
      const jobId = await startTranscribe(
        project.id,
        model,
        language === 'auto' ? null : language,
      )
      closeWs.current?.()
      closeWs.current = watchJob(jobId, async (ev) => {
        setProgress(ev.progress)
        setProgressMsg(ev.message || ev.state)
        if (ev.state === 'done') {
          const fresh = await getProject(project.id)
          setProject(fresh)
          await loadCuts(fresh).catch((e) => setError(String(e)))
          setBusy(false)
        } else if (ev.state === 'error') {
          setError(ev.error || 'transcription failed')
          setBusy(false)
        }
      })
    } catch (err) {
      setError(String(err))
      setBusy(false)
    }
  }

  function applyParams(next: CutParams) {
    setCutParams(next)
    if (!project) return
    if (paramTimer.current) clearTimeout(paramTimer.current)
    setCutBusy(true)
    paramTimer.current = window.setTimeout(async () => {
      try {
        const payload = await updateCutParams(project.id, next)
        setCutParams(payload.cut_params)
        setCuts(payload.cuts)
        setKept(payload.kept)
        setStats(payload.stats)
        setRevision((r) => r + 1)
      } catch (e) {
        setError(String(e))
      } finally {
        setCutBusy(false)
      }
    }, 250)
  }

  function onCutsChange(next: CutRegion[]) {
    setCuts(next)
    if (!project) return
    if (cutTimer.current) clearTimeout(cutTimer.current)
    cutTimer.current = window.setTimeout(async () => {
      try {
        const payload = await replaceCuts(project.id, next)
        setKept(payload.kept)
        setStats(payload.stats)
      } catch (e) {
        setError(String(e))
      }
    }, 200)
  }

  function persistRemovedWords(segments: Project['segments']) {
    if (!project) return
    const removed: [number, number][] = []
    segments.forEach((seg) =>
      seg.words.forEach((w, i) => {
        if (w.removed) removed.push([seg.id, i])
      }),
    )
    if (wordTimer.current) clearTimeout(wordTimer.current)
    wordTimer.current = window.setTimeout(async () => {
      try {
        const payload = await setRemovedWords(project.id, removed)
        setKept(payload.kept)
        setStats(payload.stats)
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
    if (project) editWordText(project.id, segId, idx, text).catch((e) => setError(String(e)))
  }

  function seek(t: number) {
    const v = videoRef.current
    if (v) v.currentTime = t
  }

  function onTimeUpdate(e: SyntheticEvent<HTMLVideoElement>) {
    const v = e.currentTarget
    const t = v.currentTime
    setCurrentTime(t)
    if (!previewRef.current) return
    for (const [s, end] of removesRef.current) {
      if (t >= s && t < end - 0.02) {
        v.currentTime = end + 0.001
        break
      }
    }
  }

  const transcribed = project?.status === 'transcribed'
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
      <p className="tagline">silence-cutting + transcript editing</p>

      {error && <p className="bad error-box">{error}</p>}

      <section className="panel">
        <input type="file" accept="video/*" onChange={onUpload} disabled={busy} />
        {project && (
          <div className="meta">
            <strong>{project.name}</strong> · {project.duration?.toFixed(1)}s ·{' '}
            {project.width}×{project.height} · status: {project.status}
            {project.language && ` · ${project.language}`}
          </div>
        )}
      </section>

      {project && (
        <>
          <section className="panel controls">
            <label>
              Model{' '}
              <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
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
                disabled={busy}
              >
                <option value="auto">auto</option>
                <option value="tr">Turkish</option>
                <option value="en">English</option>
              </select>
            </label>
            <button onClick={onTranscribe} disabled={busy}>
              {busy ? 'working…' : transcribed ? 'Re-transcribe' : 'Transcribe'}
            </button>
            {busy && (
              <div className="progress">
                <div className="bar" style={{ width: `${Math.round(progress * 100)}%` }} />
                <span className="progress-label">{progressMsg}</span>
              </div>
            )}
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

          {transcribed && cutParams && (
            <section className="panel timeline-area">
              <div className="panel-head">
                <h2>Timeline</h2>
                <div className="head-tools">
                  <label className="check inline">
                    <input
                      type="checkbox"
                      checked={preview}
                      onChange={(e) => setPreview(e.target.checked)}
                    />
                    Preview (skip cuts on playback)
                  </label>
                  <a className="export-btn" href={fcpxmlUrl(project.id)}>
                    Export FCPXML
                  </a>
                  <a className="export-btn" href={srtUrl(project.id)}>
                    Export SRT
                  </a>
                </div>
              </div>
              <CutTrack
                audioUrl={audioUrl(project.id)}
                cuts={cuts}
                revision={revision}
                onCutsChange={onCutsChange}
                videoRef={videoRef}
              />
              <SilenceControls
                params={cutParams}
                stats={stats}
                busy={cutBusy}
                onChange={applyParams}
              />
            </section>
          )}
        </>
      )}
    </main>
  )
}

export default App
