import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type SyntheticEvent,
} from 'react'
import {
  addReelVideos,
  buildReelProxies,
  cancelJob,
  createReel,
  deleteReel,
  editWordText,
  fcpxmlUrl,
  getCuts,
  getHealth,
  getProject,
  getReel,
  getReelTimeline,
  listReels,
  reelFcpxmlUrl,
  removeReelVideo,
  renameReel,
  reorderReel,
  replaceCuts,
  resetTranscription,
  setHiddenWords,
  setRemovedWords,
  startTranscribe,
  updateCutParams,
  updateReelCutParams,
  proxyUrl,
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
import { ReelSwitcher } from './components/ReelSwitcher'
import { ReelWaveTimeline } from './components/ReelWaveTimeline'
import { SilenceControls } from './components/SilenceControls'
import { TranscriptView } from './components/TranscriptView'
import './App.css'

const MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3']
const REEL_KEY = 'kitcut.reelId'
const PAGE_SIZE = 5 // clips per timeline page

function App() {
  const [health, setHealth] = useState<Health | null>(null)

  // reel state
  const [reel, setReel] = useState<Reel | null>(null)
  const [reels, setReels] = useState<Reel[]>([]) // all projects, for the switcher
  const [clips, setClips] = useState<ClipSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [busyIds, setBusyIds] = useState<string[]>([])
  const [timeline, setTimeline] = useState<ReelTimelineData | null>(null)
  const [globalTime, setGlobalTime] = useState(0)
  const [audioRev, setAudioRev] = useState(0) // bumped when the reel audio changes
  const [currentPage, setCurrentPage] = useState(0)

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
  const hiddenTimer = useRef<number | null>(null)
  // bumped on any clip-membership change (add/remove/reorder) so the background
  // proxy poll can discard a getReel result that raced with the mutation
  const clipMutation = useRef(0)
  const scrubTimer = useRef<number | null>(null)
  const editLoadTimer = useRef<number | null>(null)
  const pendingScrubTimeRef = useRef<number | null>(null)
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

  // ---- Pagination: a "page" is a 5-clip window over the reel. The timeline +
  // waveform render only the current page (performance); export still combines
  // every clip. Offsets are rebased so the page's first clip sits at t=0. ----
  const tlClips = timeline?.clips ?? []
  const pageCount = Math.max(1, Math.ceil(tlClips.length / PAGE_SIZE))
  const page = Math.min(currentPage, pageCount - 1)
  // Memoized so the timeline's region effect (which depends on `clips`) only
  // rebuilds when the page actually changes — NOT on every playback/scrub render.
  const pageClips = useMemo(() => {
    const all = timeline?.clips ?? []
    const base = all[page * PAGE_SIZE]?.offset ?? 0
    return all
      .slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)
      .map((c) => ({ ...c, offset: c.offset - base }))
  }, [timeline, page])
  const pageClipIds = useMemo(() => pageClips.map((c) => c.id), [pageClips])
  const pageClipsRef = useRef(pageClips)
  pageClipsRef.current = pageClips
  const tlClipsRef = useRef(tlClips)
  tlClipsRef.current = tlClips

  // remove spans (complement of kept) drive preview-skip within the active clip.
  // Empty while the loaded editing state isn't for the active clip yet (during
  // timeline navigation) so we never skip using another clip's cuts.
  removesRef.current = (() => {
    if (!project || project.id !== activeId) return []
    const dur = project.duration ?? 0
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
    // page-local offset of the active clip (0 when it's not on the current page)
    return pageClipsRef.current.find((c) => c.id === activeIdRef.current)?.offset ?? 0
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

  // Open a reel: swap in its clips/timeline/player and persist it as the active
  // project. Shared by bootstrap, the switcher, and post-create/-delete flows.
  async function openReel(detail: ReelDetail) {
    setReel(detail.reel)
    setClips(detail.clips)
    reelRef.current = detail.reel
    localStorage.setItem(REEL_KEY, detail.reel.id)
    clipMutation.current += 1 // drop any in-flight proxy poll from the previous reel
    void buildReelProxies(detail.reel.id).catch(() => {}) // backfill any missing proxies
    await refreshTimeline()
    if (detail.clips.length) {
      // restore the page the user left by selecting that page's first clip
      const savedPage = Number(localStorage.getItem(`kitcut.page.${detail.reel.id}`)) || 0
      const startIdx = Math.min(savedPage * PAGE_SIZE, detail.clips.length - 1)
      goToClip(detail.clips[startIdx].id, 0)
    } else {
      setCurrentPage(0)
      setActiveId(null)
      activeIdRef.current = null
      setProject(null)
    }
  }

  async function refreshReels() {
    try {
      setReels(await listReels())
    } catch {
      /* best-effort: the switcher just shows the last-known list */
    }
  }

  async function switchReel(id: string) {
    if (id === reelRef.current?.id) return
    try {
      await openReel(await getReel(id))
    } catch (e) {
      setError(String(e))
    }
  }

  async function newProject(name: string) {
    try {
      await openReel(await createReel(name.trim() || undefined))
      await refreshReels()
    } catch (e) {
      setError(String(e))
    }
  }

  async function renameProject(id: string, name: string) {
    try {
      const detail = await renameReel(id, name)
      if (id === reelRef.current?.id) {
        setReel(detail.reel)
        reelRef.current = detail.reel
      }
      await refreshReels()
    } catch (e) {
      setError(String(e))
    }
  }

  async function removeProject(id: string) {
    try {
      await deleteReel(id)
      const rest = await listReels()
      setReels(rest)
      if (id === reelRef.current?.id) {
        // deleted the open project → land on another, or a fresh empty one
        await openReel(rest.length ? await getReel(rest[0].id) : await createReel())
        if (!rest.length) await refreshReels()
      }
    } catch (e) {
      setError(String(e))
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
        await openReel(detail)
        await refreshReels()
      } catch (e) {
        setError(String(e))
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // The active clip's playback proxy may still be building. Drive the player off
  // the proxy URL (which falls back to the original) and track readiness so we can
  // upgrade original→proxy the moment it lands.
  const activeClip = clips.find((c) => c.id === activeId)
  const proxyReady = !!(activeClip?.proxy_ready ?? project?.proxy_ready)
  const activeProxyReadyRef = useRef(proxyReady)
  activeProxyReadyRef.current = proxyReady

  // Poll while any video clip is still optimizing; stop once all proxies exist.
  // (audio-only clips have no video to proxy, so they never count as pending)
  const anyProxyPending = clips.some((c) => c.width != null && !c.proxy_ready)
  useEffect(() => {
    if (!anyProxyPending) return
    let stop = false
    let lastPending = Infinity
    let noProgress = 0
    let timer = 0
    const tick = async () => {
      if (stop) return
      try {
        const r = reelRef.current
        if (r) {
          const gen = clipMutation.current
          const detail = await getReel(r.id)
          // a delete/reorder/add landed while this fetch was in flight → its
          // clip list is now stale; drop it so we don't resurrect a removed clip
          if (stop || gen !== clipMutation.current) return
          const active = detail.clips.find((c) => c.id === activeIdRef.current)
          // preserve playhead + play state across the original→proxy upgrade remount
          if (
            active?.proxy_ready &&
            activeProxyReadyRef.current === false &&
            videoRef.current
          ) {
            pendingSeekRef.current = videoRef.current.currentTime
            pendingPlayRef.current = !videoRef.current.paused
          }
          const pending = detail.clips.filter((c) => c.width != null && !c.proxy_ready).length
          noProgress = pending < lastPending ? 0 : noProgress + 1
          lastPending = pending
          setClips(detail.clips)
          if (pending === 0) return // all built; effect tears down via anyProxyPending
        }
      } catch {
        /* best-effort: a failed proxy just keeps the original */
      }
      // keep polling unless builds stall (no completions for ~20 ticks / ~50s)
      if (!stop && noProgress < 20) timer = window.setTimeout(tick, 2500)
    }
    timer = window.setTimeout(tick, 2500)
    return () => {
      stop = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyProxyPending])

  // follow the active clip: bring its page into view whenever activeId changes
  // (click, sidebar jump, playback crossing a boundary). A *manual* page switch
  // leaves activeId untouched, so it never auto-selects a clip.
  useEffect(() => {
    if (!activeId) return
    const idx = tlClipsRef.current.findIndex((c) => c.id === activeId)
    if (idx >= 0) setCurrentPage(Math.floor(idx / PAGE_SIZE))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  // clamp the page if clips were removed, and persist it per reel
  useEffect(() => {
    setCurrentPage((p) => Math.min(p, pageCount - 1))
  }, [pageCount])
  useEffect(() => {
    if (reel) localStorage.setItem(`kitcut.page.${reel.id}`, String(currentPage))
  }, [currentPage, reel])

  // keep the playhead correct when offsets change (reorder), clip switches, or
  // the page changes (offsets rebase to the new page)
  useEffect(() => {
    setGlobalTime(activeOffset() + (videoRef.current?.currentTime ?? 0))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline, activeId, currentPage])

  // Load a clip's heavy editing state (transcript + cuts). Guarded so results for
  // a clip you've already scrubbed past are dropped.
  async function loadEditingState(id: string) {
    try {
      const p = await getProject(id)
      if (id !== activeIdRef.current) return
      setProject(p)
      const payload = await getCuts(id)
      if (id !== activeIdRef.current) return
      setCutParams(payload.cut_params)
      setKept(payload.kept)
      setStats(payload.stats)
    } catch (e) {
      setError(String(e))
    }
  }

  function scheduleEditingLoad(id: string) {
    if (editLoadTimer.current) clearTimeout(editLoadTimer.current)
    editLoadTimer.current = window.setTimeout(() => void loadEditingState(id), 250)
  }

  // Switch the player to a clip. The video swaps + seeks immediately (it's driven
  // by activeId); the transcript/cuts load now, or — for rapid timeline
  // navigation — after a short settle (`defer`).
  function goToClip(id: string, localSeek = 0, defer = false) {
    if (id === activeIdRef.current) {
      const v = videoRef.current
      if (v) v.currentTime = localSeek
      return
    }
    setActiveId(id)
    activeIdRef.current = id
    pendingSeekRef.current = localSeek
    setCurrentTime(localSeek)
    if (defer) scheduleEditingLoad(id)
    else void loadEditingState(id)
  }

  // scrub the unified timeline -> seek the right clip at the right local time (debounced)
  function onScrub(g: number) {
    if (!pageClipsRef.current.length) return
    // Immediate UI update for visual feedback (g is page-local time)
    setGlobalTime(g)

    // Debounce the actual seeking/clip switching
    if (scrubTimer.current) clearTimeout(scrubTimer.current)
    pendingScrubTimeRef.current = g

    scrubTimer.current = window.setTimeout(() => {
      const time = pendingScrubTimeRef.current
      if (time === null) return

      const pc = pageClipsRef.current
      let target = pc[0]
      for (const c of pc) {
        if (time >= c.offset && time < c.offset + c.duration) {
          target = c
          break
        }
        if (time >= c.offset) target = c
      }
      if (!target) return
      const local = Math.max(0, time - target.offset)
      if (target.id === activeIdRef.current) {
        const v = videoRef.current
        if (v) v.currentTime = local
      } else {
        // defer: swap the video now, load transcript/cuts once scrubbing settles
        goToClip(target.id, local, true)
      }
    }, 50) // 50ms debounce
  }

  function onVideoEnded() {
    const tl = timelineRef.current
    if (!tl) return
    const idx = tl.clips.findIndex((c) => c.id === activeIdRef.current)
    const next = idx >= 0 ? tl.clips[idx + 1] : undefined
    if (next) {
      pendingPlayRef.current = true
      goToClip(next.id, 0)
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
    clipMutation.current += 1
    setError(null)
    setProgressMsg('uploading…')
    try {
      const detail = await addReelVideos(reelRef.current.id, files)
      setReel(detail.reel)
      setClips(detail.clips)
      await refreshTimeline()
      setAudioRev((n) => n + 1)
      if (!activeIdRef.current && detail.clips.length) goToClip(detail.clips[0].id, 0)
    } catch (e) {
      setError(String(e))
    } finally {
      setProgressMsg('')
    }
  }


  async function onRemoveClip(id: string) {
    if (!reelRef.current) return
    clipMutation.current += 1
    const oldIdx = clips.findIndex((c) => c.id === id)
    try {
      const detail = await removeReelVideo(reelRef.current.id, id)
      setReel(detail.reel)
      setClips(detail.clips)
      await refreshTimeline()
      // No audioRev bump: the page audio URL keys off its clipIds, so the
      // waveform only rebuilds when the *visible* page's clips actually change —
      // deleting a clip on another page leaves the timeline (and cursor) put.
      if (activeIdRef.current === id) {
        // focus the clip that took this one's place (or the new last), not the
        // reel's first clip, so deleting mid-reel doesn't fling you to the start
        const next = detail.clips[Math.min(oldIdx, detail.clips.length - 1)]?.id ?? null
        if (next) goToClip(next, 0)
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
    clipMutation.current += 1
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
              if (id === activeIdRef.current) await loadEditingState(id)
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

  // Transcript-only removal: persists `hidden`, which the backend keeps out of
  // subtitles but never cuts from the video — so no timeline refresh is needed.
  function persistHiddenWords(segments: Project['segments']) {
    const id = activeIdRef.current
    if (!id) return
    const hidden: [number, number][] = []
    segments.forEach((seg) =>
      seg.words.forEach((w, i) => {
        if (w.hidden) hidden.push([seg.id, i])
      }),
    )
    if (hiddenTimer.current) clearTimeout(hiddenTimer.current)
    hiddenTimer.current = window.setTimeout(() => {
      setHiddenWords(id, hidden).catch((e) => setError(String(e)))
    }, 150)
  }

  function toggleHiddenSegment(segId: number, hidden: boolean) {
    setProject((prev) => {
      if (!prev) return prev
      const segments = prev.segments.map((seg) =>
        seg.id !== segId
          ? seg
          : { ...seg, words: seg.words.map((w) => ({ ...w, hidden })) },
      )
      persistHiddenWords(segments)
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
    subs && project && project.id === activeId
      ? (() => {
          const seg = project.segments.find(
            (s) => currentTime >= s.start && currentTime < s.end,
          )
          if (!seg) return undefined
          const text = seg.words.length
            ? seg.words
                .filter((w) => !w.removed && !w.hidden)
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
        <ReelSwitcher
          reels={reels}
          activeId={reel?.id ?? null}
          onSwitch={switchReel}
          onCreate={newProject}
          onRename={renameProject}
          onDelete={removeProject}
        />
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
          pageSize={PAGE_SIZE}
          onSelect={(id) => goToClip(id, 0)}
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
                      src={proxyUrl(activeId ?? project.id)}
                      key={`${activeId ?? project.id}:${proxyReady}`}
                      onTimeUpdate={onTimeUpdate}
                      onLoadedMetadata={onVideoLoaded}
                      onEnded={onVideoEnded}
                    />
                    {activeSub && <div className="subtitle-overlay">{activeSub}</div>}
                  </div>
                  {/* Preload the rest of this part's clips so switching doesn't wait on
                      the network — the main player gets them from cache on swap. Other
                      parts cost nothing until you open them. */}
                  <div className="clip-preloaders" aria-hidden="true">
                    {pageClips
                      .filter((c) => c.id !== activeId)
                      .map((c) => (
                        <video key={c.id} src={proxyUrl(c.id)} preload="auto" muted tabIndex={-1} />
                      ))}
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
                  {project.id === activeId ? (
                    <TranscriptView
                      segments={project.segments}
                      currentTime={currentTime}
                      onToggleWord={toggleWord}
                      onToggleSegment={toggleSegment}
                      onToggleHiddenSegment={toggleHiddenSegment}
                      onSeek={seek}
                      onEditWord={editWord}
                    />
                  ) : (
                    <p className="muted">loading transcript…</p>
                  )}
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
                  {pageCount > 1 && (
                    <div className="pager">
                      <button
                        className="pager-arrow"
                        onClick={() => setCurrentPage(Math.max(0, page - 1))}
                        disabled={page === 0}
                      >
                        ‹
                      </button>
                      <span className="pager-label">
                        Part {page + 1} / {pageCount}
                      </span>
                      <div className="page-dots">
                        {Array.from({ length: pageCount }, (_, i) => (
                          <button
                            key={i}
                            className={`page-dot${i === page ? ' active' : ''}`}
                            onClick={() => setCurrentPage(i)}
                            title={`Part ${i + 1}`}
                          />
                        ))}
                      </div>
                      <button
                        className="pager-arrow"
                        onClick={() => setCurrentPage(Math.min(pageCount - 1, page + 1))}
                        disabled={page === pageCount - 1}
                      >
                        ›
                      </button>
                    </div>
                  )}
                  <ReelWaveTimeline
                    reelId={timeline.reel.id}
                    clips={pageClips}
                    clipIds={pageClipIds}
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
