# kitcut

A Recut/Descript-style tool to cut silences from videos and edit speech via the transcript.
Transcribes Turkish + English (word-level), auto-cuts silences with configurable intensity,
supports adaptive cutting (tight on speech, gentle on b-roll), transcript-driven editing, and
optional embedded/burned-in subtitles.

> Build is phased. See `.plan/` for the per-phase checklists (local only, gitignored).

## Requirements
- macOS (Apple Silicon), FFmpeg on PATH
- Python 3.12+, Node 20.12+

## Run (dev)

Backend (FastAPI, port 8000):

```bash
cd backend
python3 -m venv .venv            # first time only
./.venv/bin/pip install -r requirements.txt   # first time only
./.venv/bin/uvicorn app.main:app --reload --port 8000
```

Frontend (Vite + React, port 5173):

```bash
cd frontend
npm install                      # first time only
npm run dev
```

Open http://localhost:5173 — the page shows live backend health (status + detected ffmpeg).
The Vite dev server proxies `/api` and `/ws` to the backend on port 8000.

## Layout
- `backend/` — FastAPI app (`app/main.py`), transcription/silence/cut/render modules (added per phase)
- `frontend/` — React + TypeScript (Vite) UI
- `media/` — per-project working files (uploads, audio, renders); gitignored
- `models/` — downloaded Whisper models; gitignored
