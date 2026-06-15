from __future__ import annotations

import asyncio
import shutil
import subprocess
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, Response, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import cuts as cutlib
from . import fcpxml, ffmpeg_utils, storage, subtitles, vad
from .jobs import jobs
from .models import CutParams, CutRegion, CutSource, Project, ProjectStatus
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


@app.post("/api/projects")
async def create_project(file: UploadFile) -> Project:
    project_id = uuid.uuid4().hex[:12]
    storage.ensure_project_dir(project_id)

    suffix = Path(file.filename or "").suffix or ".mp4"
    dst = storage.source_path(project_id, suffix)
    with dst.open("wb") as out:
        shutil.copyfileobj(file.file, out)

    try:
        meta = ffmpeg_utils.probe(dst)
    except ffmpeg_utils.FFmpegError as exc:
        raise HTTPException(status_code=400, detail=f"could not read media: {exc}")

    project = Project(
        id=project_id,
        name=file.filename or project_id,
        source_filename=dst.name,
        duration=meta["duration"],
        width=meta["width"],
        height=meta["height"],
        fps=meta["fps"],
        audio_rate=meta.get("audio_rate"),
    )
    storage.save_project(project)
    return project


def _require_project(project_id: str) -> Project:
    project = storage.load_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return project


@app.get("/api/projects/{project_id}")
def get_project(project_id: str) -> Project:
    return _require_project(project_id)


@app.get("/api/projects/{project_id}/video")
def get_video(project_id: str) -> FileResponse:
    _require_project(project_id)
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


@app.put("/api/projects/{project_id}/cut-params")
def update_cut_params(project_id: str, params: CutParams) -> dict:
    project = _require_project(project_id)
    project.cut_params = params
    audio = _ensure_audio(project_id)

    # VAD speech is the keep-signal; only re-run when the threshold changes.
    if not project.speech_regions or project.speech_threshold != params.vad_threshold:
        project.speech_regions = vad.detect_speech(audio, params.vad_threshold)
        project.speech_threshold = params.vad_threshold

    gaps = cutlib.recompute_auto(project, project.speech_regions)
    auto_cuts = cutlib.build_auto_cuts(gaps, params)
    manual = [c for c in project.cuts if c.source == CutSource.manual]
    project.silences = gaps
    project.cuts = auto_cuts + manual
    storage.save_project(project)
    return cutlib.cuts_payload(project)


@app.put("/api/projects/{project_id}/cuts")
def replace_cuts(project_id: str, regions: list[CutRegion]) -> dict:
    project = _require_project(project_id)
    project.cuts = regions
    storage.save_project(project)
    return cutlib.cuts_payload(project)


@app.get("/api/projects/{project_id}/export/fcpxml")
def export_fcpxml(project_id: str) -> Response:
    project = _require_project(project_id)
    src = storage.find_source(project_id)
    if src is None:
        raise HTTPException(status_code=404, detail="source not found")
    xml = fcpxml.build_fcpxml(project, src)
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in project.name) or "kitcut"
    return Response(
        content=xml,
        media_type="application/xml",
        headers={"Content-Disposition": f'attachment; filename="{safe}.fcpxml"'},
    )


@app.get("/api/projects/{project_id}/export/srt")
def export_srt(project_id: str) -> Response:
    project = _require_project(project_id)
    srt = subtitles.build_srt(project)
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in project.name) or "kitcut"
    return Response(
        content=srt,
        media_type="application/x-subrip",
        headers={"Content-Disposition": f'attachment; filename="{safe}.srt"'},
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
    def work(progress):
        project = _require_project(project_id)
        project.status = ProjectStatus.extracting
        project.error = None
        storage.save_project(project)
        try:
            progress(0.02, "extracting audio")
            src = storage.find_source(project_id)
            if src is None:
                raise FileNotFoundError("source video missing")
            ffmpeg_utils.extract_audio(src, storage.audio_path(project_id))

            project.status = ProjectStatus.transcribing
            storage.save_project(project)

            result = transcribe(
                storage.audio_path(project_id),
                model_size=model_size,
                language=language,
                progress=progress,
            )
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
