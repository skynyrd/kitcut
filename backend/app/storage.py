from __future__ import annotations

import shutil
from pathlib import Path

from .models import Project, Reel

BASE_DIR = Path(__file__).resolve().parent.parent.parent
MEDIA_DIR = BASE_DIR / "media"
MODEL_DIR = BASE_DIR / "models"
# Centralized uploads directory (outside codebase, outside media)
UPLOADS_DIR = BASE_DIR / "uploads"
# Reels live under the (gitignored) media tree; clips keep their own dirs.
REELS_DIR = MEDIA_DIR / "reels"


def project_dir(project_id: str) -> Path:
    return MEDIA_DIR / project_id


def project_json_path(project_id: str) -> Path:
    return project_dir(project_id) / "project.json"


def source_path(project_id: str, suffix: str) -> Path:
    return project_dir(project_id) / f"source{suffix}"


def audio_path(project_id: str) -> Path:
    return project_dir(project_id) / "audio.wav"


def proxy_path(project_id: str) -> Path:
    return project_dir(project_id) / "proxy.mp4"


def find_source(project_id: str) -> Path | None:
    d = project_dir(project_id)
    if not d.exists():
        return None
    for p in d.glob("source.*"):
        return p
    return None


def ensure_project_dir(project_id: str) -> Path:
    d = project_dir(project_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def ensure_uploads_dir() -> Path:
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    return UPLOADS_DIR


def uploads_path(filename: str) -> Path:
    """Get a unique path in the uploads directory."""
    ensure_uploads_dir()
    return UPLOADS_DIR / filename


def delete_project(project_id: str) -> None:
    """Remove kitcut's working files for a clip: its media dir and the upload copy
    (if it was uploaded). `rmtree` only unlinks the `source.*` symlink, so the
    user's external original — whether the upload-dir copy's source or a
    from-paths target on disk — is never followed/deleted."""
    d = project_dir(project_id)
    if d.exists():
        shutil.rmtree(d)
    if UPLOADS_DIR.exists():
        for f in UPLOADS_DIR.glob(f"{project_id}.*"):
            f.unlink(missing_ok=True)


def save_project(project: Project) -> None:
    ensure_project_dir(project.id)
    project_json_path(project.id).write_text(project.model_dump_json(indent=2))


def load_project(project_id: str) -> Project | None:
    path = project_json_path(project_id)
    if not path.exists():
        return None
    try:
        return Project.model_validate_json(path.read_text())
    except Exception:
        return None  # stale/incompatible schema — treat as missing


def list_projects() -> list[Project]:
    if not MEDIA_DIR.exists():
        return []
    projects: list[Project] = []
    for child in MEDIA_DIR.iterdir():
        if child.is_dir() and child.name != REELS_DIR.name:
            p = load_project(child.name)
            if p is not None:
                projects.append(p)
    return projects


def reel_json_path(reel_id: str) -> Path:
    return REELS_DIR / f"{reel_id}.json"


def reel_audio_path(reel_id: str, key: str = "") -> Path:
    suffix = f".{key}" if key else ""
    return REELS_DIR / f"{reel_id}{suffix}.audio.wav"


def reel_audio_meta_path(reel_id: str, key: str = "") -> Path:
    """Sidecar fingerprint of the inputs the cached reel audio was built from.
    `key` distinguishes per-page subsets from the whole-reel audio (key="")."""
    suffix = f".{key}" if key else ""
    return REELS_DIR / f"{reel_id}{suffix}.audio.json"


def save_reel(reel: Reel) -> None:
    REELS_DIR.mkdir(parents=True, exist_ok=True)
    reel_json_path(reel.id).write_text(reel.model_dump_json(indent=2))


def load_reel(reel_id: str) -> Reel | None:
    path = reel_json_path(reel_id)
    if not path.exists():
        return None
    try:
        return Reel.model_validate_json(path.read_text())
    except Exception:
        return None  # stale/incompatible schema — treat as missing


def list_reels() -> list[Reel]:
    if not REELS_DIR.exists():
        return []
    reels: list[Reel] = []
    for child in REELS_DIR.glob("*.json"):
        # skip audio-meta sidecars (`<reel_id>[.<key>].audio.json`)
        if child.name.endswith(".audio.json"):
            continue
        reel = load_reel(child.stem)
        if reel is not None:
            reels.append(reel)
    return reels


def delete_reel(reel_id: str) -> None:
    """Delete a reel and all of its clips' working files. Originals outside the
    workspace are untouched (see `delete_project`). The `{reel_id}.` glob (note the
    dot) clears the reel json + cached audio sidecars without matching a different
    reel whose id merely shares this one's prefix."""
    reel = load_reel(reel_id)
    if reel is not None:
        for cid in reel.clip_ids:
            delete_project(cid)
    if REELS_DIR.exists():
        for f in REELS_DIR.glob(f"{reel_id}.*"):
            f.unlink(missing_ok=True)
