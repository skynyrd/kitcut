export interface Health {
  status: string
  ffmpeg: string | null
  media_dir: string
  model_dir: string
  default_model: string
}

export interface Word {
  text: string
  start: number
  end: number
  removed: boolean
}

export interface Segment {
  id: number
  start: number
  end: number
  text: string
  words: Word[]
}

export interface CutParams {
  mode: 'uniform' | 'adaptive'
  vad_threshold: number
  speech_min_silence_ms: number
  pad_ms: number
  broll_min_ms: number
  broll_keep_ms: number
  keep_nonspeech: boolean
}

export type SilenceKind = 'speech' | 'nonspeech'

export interface CutRegion {
  id: string
  start: number
  end: number
  source: 'auto' | 'manual'
  kind: SilenceKind
}

export interface CutStats {
  n_cuts: number
  removed_words: number
  removed_s: number
  final_s: number
  original_s: number
}

export interface CutsPayload {
  cut_params: CutParams
  silences: { start: number; end: number; kind: SilenceKind }[]
  cuts: CutRegion[]
  word_cuts: { start: number; end: number }[]
  kept: [number, number][]
  stats: CutStats
}

export type ProjectStatus =
  | 'created'
  | 'extracting'
  | 'transcribing'
  | 'transcribed'
  | 'error'

export interface Project {
  id: string
  name: string
  source_filename: string
  reel_id: string | null
  duration: number | null
  width: number | null
  height: number | null
  fps: number | null
  language: string | null
  status: ProjectStatus
  error: string | null
  segments: Segment[]
  silences: unknown[]
  cut_params: CutParams
}

export interface ClipSummary {
  id: string
  name: string
  duration: number | null
  width: number | null
  height: number | null
  fps: number | null
  status: ProjectStatus
  language: string | null
  transcribed: boolean
}

export interface Reel {
  id: string
  name: string
  clip_ids: string[]
  default_cut_params: CutParams
}

export interface ReelDetail {
  reel: Reel
  clips: ClipSummary[]
}

export interface TimelineClip extends ClipSummary {
  duration: number
  offset: number
  cuts: CutRegion[]
  word_cuts: { start: number; end: number }[]
  kept: [number, number][]
  stats: CutStats
}

export interface ReelTotals {
  n_clips: number
  original_s: number
  final_s: number
  removed_s: number
  n_cuts: number
  removed_words: number
}

export interface ReelTimeline {
  reel: Reel
  clips: TimelineClip[]
  totals: ReelTotals
}

export interface JobEvent {
  id: string
  kind: string
  state: 'pending' | 'running' | 'done' | 'error'
  progress: number
  message: string
  error: string | null
}

export async function getHealth(): Promise<Health> {
  const res = await fetch('/api/health')
  if (!res.ok) throw new Error(`health check failed: ${res.status}`)
  return res.json()
}

export async function createProject(file: File): Promise<Project> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/api/projects', { method: 'POST', body: form })
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`)
  return res.json()
}

export async function getProject(id: string): Promise<Project> {
  const res = await fetch(`/api/projects/${id}`)
  if (!res.ok) throw new Error(`get project failed: ${res.status}`)
  return res.json()
}

export async function startTranscribe(
  id: string,
  modelSize: string,
  language: string | null,
): Promise<string> {
  const res = await fetch(`/api/projects/${id}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_size: modelSize, language }),
  })
  if (!res.ok) throw new Error(`transcribe failed: ${res.status}`)
  const data = await res.json()
  return data.job_id as string
}

export async function getCuts(id: string): Promise<CutsPayload> {
  const res = await fetch(`/api/projects/${id}/cuts`)
  if (!res.ok) throw new Error(`get cuts failed: ${res.status}`)
  return res.json()
}

export async function updateCutParams(
  id: string,
  params: CutParams,
): Promise<CutsPayload> {
  const res = await fetch(`/api/projects/${id}/cut-params`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  if (!res.ok) throw new Error(`update params failed: ${res.status}`)
  return res.json()
}

export async function replaceCuts(
  id: string,
  regions: CutRegion[],
): Promise<CutsPayload> {
  const res = await fetch(`/api/projects/${id}/cuts`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(regions),
  })
  if (!res.ok) throw new Error(`replace cuts failed: ${res.status}`)
  return res.json()
}

export async function setRemovedWords(
  id: string,
  removed: [number, number][],
): Promise<CutsPayload> {
  const res = await fetch(`/api/projects/${id}/removed-words`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ removed }),
  })
  if (!res.ok) throw new Error(`set removed words failed: ${res.status}`)
  return res.json()
}

export async function editWordText(
  id: string,
  segmentId: number,
  wordIndex: number,
  text: string,
): Promise<void> {
  const res = await fetch(`/api/projects/${id}/word-text`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ segment_id: segmentId, word_index: wordIndex, text }),
  })
  if (!res.ok) throw new Error(`edit word failed: ${res.status}`)
}

export async function createReel(name?: string): Promise<ReelDetail> {
  const res = await fetch('/api/reels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name ?? null }),
  })
  if (!res.ok) throw new Error(`create reel failed: ${res.status}`)
  return res.json()
}

export async function listReels(): Promise<Reel[]> {
  const res = await fetch('/api/reels')
  if (!res.ok) throw new Error(`list reels failed: ${res.status}`)
  return res.json()
}

export async function getReel(id: string): Promise<ReelDetail> {
  const res = await fetch(`/api/reels/${id}`)
  if (!res.ok) throw new Error(`get reel failed: ${res.status}`)
  return res.json()
}

export async function getReelTimeline(id: string): Promise<ReelTimeline> {
  const res = await fetch(`/api/reels/${id}/timeline`)
  if (!res.ok) throw new Error(`get reel timeline failed: ${res.status}`)
  return res.json()
}

export async function addReelVideos(id: string, files: File[]): Promise<ReelDetail> {
  const form = new FormData()
  for (const f of files) form.append('files', f)
  const res = await fetch(`/api/reels/${id}/videos`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`add videos failed: ${res.status} ${await res.text()}`)
  return res.json()
}

export async function removeReelVideo(
  id: string,
  clipId: string,
  deleteMedia = false,
): Promise<ReelDetail> {
  const res = await fetch(
    `/api/reels/${id}/videos/${clipId}?delete_media=${deleteMedia}`,
    { method: 'DELETE' },
  )
  if (!res.ok) throw new Error(`remove video failed: ${res.status}`)
  return res.json()
}

export async function reorderReel(id: string, clipIds: string[]): Promise<ReelDetail> {
  const res = await fetch(`/api/reels/${id}/order`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clip_ids: clipIds }),
  })
  if (!res.ok) throw new Error(`reorder reel failed: ${res.status}`)
  return res.json()
}

export async function updateReelCutParams(
  id: string,
  params: CutParams,
  apply: 'all' | 'reel' = 'all',
): Promise<ReelDetail> {
  const res = await fetch(`/api/reels/${id}/cut-params?apply=${apply}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  if (!res.ok) throw new Error(`update reel params failed: ${res.status}`)
  return res.json()
}

export function reelFcpxmlUrl(id: string): string {
  return `/api/reels/${id}/export/fcpxml`
}

/** Concatenated audio of every clip in the reel (one continuous WAV).
 *  `v` is a cache-busting token bumped when the reel's audio changes. */
export function reelAudioUrl(id: string, v?: number | string): string {
  return `/api/reels/${id}/audio${v != null ? `?v=${v}` : ''}`
}

export function videoUrl(id: string): string {
  return `/api/projects/${id}/video`
}

export function audioUrl(id: string): string {
  return `/api/projects/${id}/audio`
}

export function fcpxmlUrl(id: string): string {
  return `/api/projects/${id}/export/fcpxml`
}

/** Open a WebSocket to stream job progress. Returns a close function. */
export function watchJob(
  jobId: string,
  onEvent: (e: JobEvent) => void,
): () => void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/ws/jobs/${jobId}`)
  ws.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data))
    } catch {
      /* ignore malformed frames */
    }
  }
  return () => ws.close()
}
