from __future__ import annotations

from pathlib import Path

from .models import Project

BASE_DIR = Path(__file__).resolve().parent.parent.parent
MEDIA_DIR = BASE_DIR / "media"
MODEL_DIR = BASE_DIR / "models"


def project_dir(project_id: str) -> Path:
    return MEDIA_DIR / project_id


def project_json_path(project_id: str) -> Path:
    return project_dir(project_id) / "project.json"


def source_path(project_id: str, suffix: str) -> Path:
    return project_dir(project_id) / f"source{suffix}"


def audio_path(project_id: str) -> Path:
    return project_dir(project_id) / "audio.wav"


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
        if child.is_dir():
            p = load_project(child.name)
            if p is not None:
                projects.append(p)
    return projects
