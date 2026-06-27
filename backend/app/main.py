from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
import subprocess
import uuid
from pathlib import Path

from fastapi import (
    FastAPI,
    File,
    HTTPException,
    Response,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import cuts as cutlib
from . import fcpxml, ffmpeg_utils, storage, vad
from .jobs import jobs
from .models import CutParams, CutRegion, CutSource, Project, ProjectStatus, Reel
from .transcribe import DEFAULT_MODEL, transcribe

app = FastAPI(title="kitcut", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _startup() -> None:
    jobs.bind_loop()


def _ffmpeg_version() -> str | None:
    exe = shutil.which("ffmpeg")
    if not exe:
        return None
    try:
        out = subprocess.run([exe, "-version"], capture_output=True, text=True, timeout=5)
        return out.stdout.splitlines()[0] if out.stdout else exe
    except Exception:
        return exe


@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ok",
        "ffmpeg": _ffmpeg_version(),
        "media_dir": str(storage.MEDIA_DIR),
        "model_dir": str(storage.MODEL_DIR),
        "default_model": DEFAULT_MODEL,
    }


@app.get("/api/projects")
def list_projects() -> list[Project]:
    return storage.list_projects()


def _create_clip(file: UploadFile, reel_id: str | None = None) -> Project:
    project_id = uuid.uuid4().hex[:12]
    storage.ensure_project_dir(project_id)

    suffix = Path(file.filename or "").suffix or ".mp4"

    # Store uploaded file in uploads directory, symlink from media directory (saves space)
    upload_filename = f"{project_id}{suffix}"
    upload_path = storage.uploads_path(upload_filename)
    with upload_path.open("wb") as out:
        shutil.copyfileobj(file.file, out)

    # Create symlink from media/projectid/source.mp4 to uploads/projectid.mp4
    dst = storage.source_path(project_id, suffix)
    dst.symlink_to(upload_path.resolve())

    try:
        meta = ffmpeg_utils.probe(str(dst))
    except ffmpeg_utils.FFmpegError as exc:
        upload_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"could not read media: {exc}")

    project = Project(
        id=project_id,
        name=file.filename or project_id,
        source_filename=dst.name,
        reel_id=reel_id,
        duration=meta["duration"],
        width=meta["width"],
        height=meta["height"],
        fps=meta["fps"],
        audio_rate=meta.get("audio_rate"),
    )
    storage.save_project(project)
    return project


def _create_clip_from_path(file_path: str, reel_id: str | None = None) -> Project:
    """Create a clip from an existing file path using a symlink (no copying)."""
    src = Path(file_path).resolve()
    if not src.exists():
        raise HTTPException(status_code=400, detail=f"file not found: {file_path}")
    if not src.is_file():
        raise HTTPException(status_code=400, detail=f"not a file: {file_path}")

    project_id = uuid.uuid4().hex[:12]
    storage.ensure_project_dir(project_id)

    suffix = src.suffix or ".mp4"
    dst = storage.source_path(project_id, suffix)

    try:
        meta = ffmpeg_utils.probe(str(src))
    except ffmpeg_utils.FFmpegError as exc:
        raise HTTPException(status_code=400, detail=f"could not read media: {exc}")

    # Create symlink instead of copying
    dst.symlink_to(src)

    project = Project(
        id=project_id,
        name=src.name,
        source_filename=dst.name,
        reel_id=reel_id,
        duration=meta["duration"],
        width=meta["width"],
        height=meta["height"],
        fps=meta["fps"],
        audio_rate=meta.get("audio_rate"),
    )
    storage.save_project(project)
    return project


# ---- Playback proxies: lightweight 720p copies the browser can scrub smoothly ----

_proxy_sem = asyncio.Semaphore(1)  # serialize encodes so "build N proxies" ≠ N concurrent ffmpegs
_proxy_inflight: set[str] = set()  # clips currently building, to de-dup enqueues


def _build_proxy_blocking(project_id: str) -> None:
    """Build the proxy under a temp name, then atomically publish it, so the
    `/proxy` endpoint never serves a half-written file."""
    src = storage.find_source(project_id)
    if src is None:
        return
    final = storage.proxy_path(project_id)
    tmp = final.with_name("proxy.building.mp4")
    ffmpeg_utils.build_proxy(src, tmp)
    tmp.replace(final)


async def _schedule_proxy(project_id: str) -> None:
    """Background proxy build, serialized by `_proxy_sem`. Best-effort: on failure
    the player just keeps using the original via the `/proxy` fallback."""
    try:
        async with _proxy_sem:
            await asyncio.to_thread(_build_proxy_blocking, project_id)
    except Exception as exc:  # noqa: BLE001 - proxy is optional, never fatal
        print(f"proxy build failed for {project_id}: {exc}")
    finally:
        _proxy_inflight.discard(project_id)


def _enqueue_proxy(project_id: str) -> None:
    """Schedule a background proxy build, unless one already exists, is already
    running, or the clip has no video stream to downscale."""
    if storage.proxy_path(project_id).exists() or project_id in _proxy_inflight:
        return
    p = storage.load_project(project_id)
    if p is None or p.width is None:  # missing clip or audio-only → nothing to proxy
        return
    _proxy_inflight.add(project_id)
    asyncio.create_task(_schedule_proxy(project_id))


@app.post("/api/projects")
async def create_project(file: UploadFile) -> Project:
    return _create_clip(file)


def _require_project(project_id: str) -> Project:
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return project


# ---- Reels: ordered collections of clips edited & exported together ----


def _require_reel(reel_id: str) -> Reel:
    reel = storage.load_reel(reel_id)
    if reel is None:
        raise HTTPException(status_code=404, detail="reel not found")
    return reel


def _clip_summary(p: Project) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "duration": p.duration,
        "width": p.width,
        "height": p.height,
        "fps": p.fps,
        "status": p.status.value,
        "language": p.language,
        "transcribed": bool(p.segments),
        "proxy_ready": storage.proxy_path(p.id).exists(),
    }


def _reel_detail(reel: Reel) -> dict:
    """Reel plus its clips' summaries, in running order (missing clips skipped)."""
    clips = [
        _clip_summary(p)
        for cid in reel.clip_ids
        if (p := storage.load_project(cid)) is not None
    ]
    return {"reel": reel.model_dump(), "clips": clips}


class CreateReel(BaseModel):
    name: str | None = None


class ReelOrder(BaseModel):
    clip_ids: list[str]


class AddVideoPaths(BaseModel):
    paths: list[str]


@app.post("/api/reels")
def create_reel(body: CreateReel | None = None) -> dict:
    reel = Reel(
        id="reel_" + uuid.uuid4().hex[:10],
        name=(body.name if body else None) or "Untitled reel",
    )
    storage.save_reel(reel)
    return _reel_detail(reel)


@app.get("/api/reels")
def list_reels() -> list[Reel]:
    return storage.list_reels()


@app.get("/api/reels/{reel_id}")
def get_reel(reel_id: str) -> dict:
    return _reel_detail(_require_reel(reel_id))


@app.post("/api/reels/{reel_id}/build-proxies")
async def build_reel_proxies(reel_id: str) -> dict:
    """Backfill: enqueue background proxy builds for every clip that lacks one
    (e.g. clips added before proxies existed). De-duped and serialized."""
    reel = _require_reel(reel_id)
    for cid in reel.clip_ids:
        _enqueue_proxy(cid)
    pending = sum(
        1
        for cid in reel.clip_ids
        if (p := storage.load_project(cid)) is not None
        and p.width is not None
        and not storage.proxy_path(cid).exists()
    )
    return {"pending": pending}


@app.get("/api/reels/{reel_id}/timeline")
def get_reel_timeline(reel_id: str) -> dict:
    reel = _require_reel(reel_id)
    clips = [
        p for cid in reel.clip_ids if (p := storage.load_project(cid)) is not None
    ]
    return cutlib.reel_timeline(reel, clips)


def _audio_fingerprint(clip_ids: list[str]) -> list[list]:
    """Identity of the inputs for the cached reel audio: order + each clip's
    audio.wav size & mtime. Any add/remove/reorder/re-transcribe changes it."""
    fp: list[list] = []
    for cid in clip_ids:
        st = storage.audio_path(cid).stat()
        fp.append([cid, st.st_size, int(st.st_mtime)])
    return fp


@app.get("/api/reels/{reel_id}/audio")
def get_reel_audio(reel_id: str, clips: str | None = None) -> FileResponse:
    """One continuous WAV of the reel's clip audio, concatenated in running order.

    With `?clips=id1,id2,…` only those clips (a timeline page) are concatenated —
    each subset is cached under its own key. Rebuilt only when the input
    fingerprint changes; the unified-timeline waveform loads this single file."""
    reel = _require_reel(reel_id)
    # filter to the requested subset (if any), preserving reel running order
    requested = set(clips.split(",")) if clips else None
    clip_ids = [
        cid
        for cid in reel.clip_ids
        if storage.load_project(cid) is not None
        and (requested is None or cid in requested)
    ]
    if not clip_ids:
        raise HTTPException(status_code=404, detail="reel has no audio")

    parts = [_ensure_audio(cid) for cid in clip_ids]
    fp = _audio_fingerprint(clip_ids)
    key = (
        ""
        if requested is None
        else hashlib.sha1(",".join(clip_ids).encode()).hexdigest()[:10]
    )
    out = storage.reel_audio_path(reel_id, key)
    meta = storage.reel_audio_meta_path(reel_id, key)

    cached_fp = None
    if out.exists() and meta.exists():
        try:
            cached_fp = json.loads(meta.read_text())
        except Exception:
            cached_fp = None
    if cached_fp != fp or not out.exists():
        ffmpeg_utils.concat_audio(parts, out)
        meta.write_text(json.dumps(fp))

    return FileResponse(out)


@app.post("/api/reels/{reel_id}/videos")
async def add_reel_videos(reel_id: str, files: list[UploadFile] = File(...)) -> dict:
    reel = _require_reel(reel_id)
    for f in files:
        clip = _create_clip(f, reel_id=reel_id)
        reel.clip_ids.append(clip.id)
        _enqueue_proxy(clip.id)
    storage.save_reel(reel)
    return _reel_detail(reel)


@app.post("/api/reels/{reel_id}/videos/from-paths")
async def add_reel_videos_from_paths(reel_id: str, body: AddVideoPaths) -> dict:
    """Add videos from existing file paths (creates symlinks, no copying)."""
    reel = _require_reel(reel_id)
    for path in body.paths:
        clip = _create_clip_from_path(path, reel_id=reel_id)
        reel.clip_ids.append(clip.id)
        _enqueue_proxy(clip.id)
    storage.save_reel(reel)
    return _reel_detail(reel)


@app.put("/api/reels/{reel_id}/order")
def reorder_reel(reel_id: str, body: ReelOrder) -> dict:
    reel = _require_reel(reel_id)
    if set(body.clip_ids) != set(reel.clip_ids):
        raise HTTPException(
            status_code=400, detail="order must be a permutation of the reel's clips"
        )
    reel.clip_ids = body.clip_ids
    storage.save_reel(reel)
    return _reel_detail(reel)


@app.delete("/api/reels/{reel_id}/videos/{clip_id}")
def remove_reel_video(reel_id: str, clip_id: str, delete_media: bool = False) -> dict:
    reel = _require_reel(reel_id)
    if clip_id not in reel.clip_ids:
        raise HTTPException(status_code=404, detail="clip not in reel")
    reel.clip_ids = [c for c in reel.clip_ids if c != clip_id]
    storage.save_reel(reel)
    if delete_media:
        storage.delete_project(clip_id)
    return _reel_detail(reel)


class ReelRename(BaseModel):
    name: str


@app.put("/api/reels/{reel_id}/name")
def rename_reel(reel_id: str, body: ReelRename) -> dict:
    reel = _require_reel(reel_id)
    reel.name = body.name.strip() or reel.name
    storage.save_reel(reel)
    return _reel_detail(reel)


@app.delete("/api/reels/{reel_id}")
def delete_reel(reel_id: str) -> dict:
    """Delete a project (reel) and all its clips' workspace files. The user's
    external originals are never touched (only symlinks are unlinked)."""
    _require_reel(reel_id)
    storage.delete_reel(reel_id)
    return {"ok": True}


@app.put("/api/reels/{reel_id}/cut-params")
def update_reel_cut_params(reel_id: str, params: CutParams, apply: str = "all") -> dict:
    """Set the reel default. With apply=all, push it to every clip and recompute.

    Recompute runs VAD per clip synchronously (matches the per-clip endpoint).
    """
    reel = _require_reel(reel_id)
    reel.default_cut_params = params
    storage.save_reel(reel)
    if apply == "all":
        for cid in reel.clip_ids:
            clip = storage.load_project(cid)
            if clip is not None:
                _apply_cut_params(clip, params)
    return _reel_detail(reel)


@app.get("/api/projects/{project_id}")
def get_project(project_id: str) -> Project:
    project = _require_project(project_id)
    project.proxy_ready = storage.proxy_path(project_id).exists()
    return project


@app.get("/api/projects/{project_id}/video")
def get_video(project_id: str) -> FileResponse:
    _require_project(project_id)
    src = storage.find_source(project_id)
    if src is None:
        raise HTTPException(status_code=404, detail="source not found")
    return FileResponse(src)


@app.get("/api/projects/{project_id}/proxy")
def get_proxy(project_id: str) -> FileResponse:
    """Serve the lightweight playback proxy if built, else fall back to the
    original source so the player always has something to show."""
    _require_project(project_id)
    proxy = storage.proxy_path(project_id)
    if proxy.exists():
        return FileResponse(proxy)
    src = storage.find_source(project_id)
    if src is None:
        raise HTTPException(status_code=404, detail="source not found")
    return FileResponse(src)


@app.get("/api/projects/{project_id}/audio")
def get_audio(project_id: str) -> FileResponse:
    _require_project(project_id)
    path = storage.audio_path(project_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="audio not extracted yet")
    return FileResponse(path)


def _ensure_audio(project_id: str) -> Path:
    audio = storage.audio_path(project_id)
    if not audio.exists():
        src = storage.find_source(project_id)
        if src is None:
            raise HTTPException(status_code=404, detail="source not found")
        ffmpeg_utils.extract_audio(src, audio)
    return audio


@app.get("/api/projects/{project_id}/cuts")
def get_cuts(project_id: str) -> dict:
    return cutlib.cuts_payload(_require_project(project_id))


def _apply_cut_params(project: Project, params: CutParams) -> None:
    """Set cut params on a clip and recompute its auto-cuts, keeping manual cuts.

    VAD speech is the keep-signal; only re-run when the threshold changes.
    """
    project.cut_params = params
    audio = _ensure_audio(project.id)

    if not project.speech_regions or project.speech_threshold != params.vad_threshold:
        project.speech_regions = vad.detect_speech(audio, params.vad_threshold)
        project.speech_threshold = params.vad_threshold

    gaps = cutlib.recompute_auto(project, project.speech_regions)
    auto_cuts = cutlib.build_auto_cuts(gaps, params)
    manual = [c for c in project.cuts if c.source == CutSource.manual]
    project.silences = gaps
    project.cuts = auto_cuts + manual
    storage.save_project(project)


@app.put("/api/projects/{project_id}/cut-params")
def update_cut_params(project_id: str, params: CutParams) -> dict:
    project = _require_project(project_id)
    _apply_cut_params(project, params)
    return cutlib.cuts_payload(project)


@app.put("/api/projects/{project_id}/cuts")
def replace_cuts(project_id: str, regions: list[CutRegion]) -> dict:
    project = _require_project(project_id)
    project.cuts = regions
    storage.save_project(project)
    return cutlib.cuts_payload(project)


def _safe_name(name: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in name) or "kitcut"


@app.get("/api/projects/{project_id}/export/fcpxml")
def export_fcpxml(project_id: str) -> Response:
    project = _require_project(project_id)
    src = storage.find_source(project_id)
    if src is None:
        raise HTTPException(status_code=404, detail="source not found")
    xml = fcpxml.build_fcpxml(project, src)
    return Response(
        content=xml,
        media_type="application/xml",
        headers={"Content-Disposition": f'attachment; filename="{_safe_name(project.name)}.fcpxml"'},
    )


@app.get("/api/reels/{reel_id}/export/fcpxml")
def export_reel_fcpxml(reel_id: str, transitions: bool = True) -> Response:
    reel = _require_reel(reel_id)
    clips: list[tuple[Project, Path]] = []
    for cid in reel.clip_ids:
        p = storage.load_project(cid)
        if p is None:
            continue
        src = storage.find_source(cid)
        if src is None:
            raise HTTPException(status_code=404, detail=f"source missing for clip {cid}")
        clips.append((p, src))
    if not clips:
        raise HTTPException(status_code=400, detail="reel has no videos to export")
    xml = fcpxml.build_reel_fcpxml(reel, clips, transitions=transitions)
    return Response(
        content=xml,
        media_type="application/xml",
        headers={"Content-Disposition": f'attachment; filename="{_safe_name(reel.name)}.fcpxml"'},
    )


class RemovedWords(BaseModel):
    removed: list[tuple[int, int]]  # (segment_id, word_index) pairs


@app.put("/api/projects/{project_id}/removed-words")
def set_removed_words(project_id: str, body: RemovedWords) -> dict:
    project = _require_project(project_id)
    removed = {(s, i) for s, i in body.removed}
    for seg in project.segments:
        for idx, word in enumerate(seg.words):
            word.removed = (seg.id, idx) in removed
    storage.save_project(project)
    return cutlib.cuts_payload(project)


class HiddenWords(BaseModel):
    hidden: list[tuple[int, int]]  # (segment_id, word_index) pairs


@app.put("/api/projects/{project_id}/hidden-words")
def set_hidden_words(project_id: str, body: HiddenWords) -> dict:
    """Mark words as transcript-only removed: dropped from the transcript and
    subtitles, but the footage is kept (unlike `removed-words`, which cuts the
    video). Leaves cuts/kept untouched, so the reel timeline is unaffected."""
    project = _require_project(project_id)
    hidden = {(s, i) for s, i in body.hidden}
    for seg in project.segments:
        for idx, word in enumerate(seg.words):
            word.hidden = (seg.id, idx) in hidden
    storage.save_project(project)
    return cutlib.cuts_payload(project)


class WordTextEdit(BaseModel):
    segment_id: int
    word_index: int
    text: str


@app.put("/api/projects/{project_id}/word-text")
def edit_word_text(project_id: str, body: WordTextEdit) -> dict:
    project = _require_project(project_id)
    seg = next((s for s in project.segments if s.id == body.segment_id), None)
    if seg is None or not (0 <= body.word_index < len(seg.words)):
        raise HTTPException(status_code=404, detail="word not found")
    seg.words[body.word_index].text = body.text
    seg.text = "".join(w.text for w in seg.words).strip()
    storage.save_project(project)
    return {"ok": True, "segment_id": seg.id, "text": seg.text}


class TranscribeRequest(BaseModel):
    model_size: str = DEFAULT_MODEL
    language: str | None = None  # None = auto-detect (tr/en)


def _transcribe_work(project_id: str, model_size: str, language: str | None):
    def work(progress, is_cancelled):
        if is_cancelled():
            raise RuntimeError("transcription cancelled")

        project = _require_project(project_id)
        project.status = ProjectStatus.extracting
        project.error = None
        storage.save_project(project)
        try:
            if is_cancelled():
                raise RuntimeError("transcription cancelled")

            progress(0.02, "extracting audio")
            src = storage.find_source(project_id)
            if src is None:
                raise FileNotFoundError("source video missing")
            ffmpeg_utils.extract_audio(src, storage.audio_path(project_id))

            if is_cancelled():
                raise RuntimeError("transcription cancelled")

            project.status = ProjectStatus.transcribing
            storage.save_project(project)

            result = transcribe(
                storage.audio_path(project_id),
                model_size=model_size,
                language=language,
                progress=progress,
            )

            if is_cancelled():
                raise RuntimeError("transcription cancelled")

            project.segments = result["segments"]
            project.language = result["language"]
            project.aligned = result.get("aligned", False)
            project.align_error = result.get("align_error")
            progress(0.98, "detecting speech (VAD)")
            project.speech_regions = vad.detect_speech(
                storage.audio_path(project_id), project.cut_params.vad_threshold
            )
            project.speech_threshold = project.cut_params.vad_threshold
            project.status = ProjectStatus.transcribed
            storage.save_project(project)
            return {
                "language": result["language"],
                "segments": len(result["segments"]),
            }
        except Exception as exc:
            project.status = ProjectStatus.error
            project.error = str(exc)
            storage.save_project(project)
            raise

    return work


@app.post("/api/projects/{project_id}/transcribe")
async def start_transcribe(project_id: str, req: TranscribeRequest) -> dict:
    _require_project(project_id)
    job = jobs.create("transcribe")
    asyncio.create_task(
        jobs.run(job, _transcribe_work(project_id, req.model_size, req.language))
    )
    return {"job_id": job.id}


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    """Cancel a job."""
    if not jobs.cancel(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    return {"cancelled": True}


@app.post("/api/projects/{project_id}/reset-transcription")
def reset_transcription(project_id: str) -> Project:
    """Reset transcription artifacts but keep the source video file."""
    project = _require_project(project_id)
    project_path = storage.project_dir(project_id)

    if project_path.exists():
        # Delete extracted audio and other non-source artifacts
        for f in project_path.glob("*"):
            if not (f.name.startswith("source") or f.name.startswith("proxy")):
                if f.is_file():
                    f.unlink()
                elif f.is_dir():
                    shutil.rmtree(f)

    # Reset project to untranscribed state
    project.status = ProjectStatus.created
    project.segments = []
    project.language = None
    storage.save_project(project)
    return project


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job.snapshot()


@app.websocket("/ws/jobs/{job_id}")
async def ws_job(ws: WebSocket, job_id: str) -> None:
    await ws.accept()
    job = jobs.get(job_id)
    if job is None:
        await ws.send_json({"error": "job not found"})
        await ws.close()
        return

    await ws.send_json(job.snapshot())
    if job.state.value in ("done", "error"):
        await ws.close()
        return

    try:
        while True:
            event = await job.queue.get()
            await ws.send_json(event)
            if event.get("state") in ("done", "error"):
                break
    except WebSocketDisconnect:
        return
    finally:
        await ws.close()
