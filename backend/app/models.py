from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class Word(BaseModel):
    text: str
    start: float
    end: float
    removed: bool = False  # cut from the video (footage trimmed) + dropped from subtitles
    hidden: bool = False  # dropped from transcript + subtitles only; video kept untouched


class Segment(BaseModel):
    id: int
    start: float
    end: float
    text: str
    words: list[Word] = Field(default_factory=list)


class CutMode(str, Enum):
    uniform = "uniform"
    adaptive = "adaptive"


class CutParams(BaseModel):
    """Configurable cut intensity over VAD speech detection.

    Speech (Silero VAD) is kept; non-speech gaps are candidates to cut.
    `adaptive` keeps long non-speech (b-roll/music); `uniform` cuts every gap.
    """

    mode: CutMode = CutMode.adaptive
    vad_threshold: float = 0.5  # Silero speech probability; higher = stricter
    speech_min_silence_ms: int = 400  # min non-speech gap to cut
    pad_ms: int = 80  # silence kept next to speech
    broll_min_ms: int = 2500  # non-speech longer than this = b-roll
    broll_keep_ms: int = 1500
    keep_nonspeech: bool = True


class SilenceKind(str, Enum):
    speech = "speech"
    nonspeech = "nonspeech"


class SilenceGap(BaseModel):
    start: float
    end: float
    kind: SilenceKind = SilenceKind.speech


class CutSource(str, Enum):
    auto = "auto"
    manual = "manual"


class CutKind(str, Enum):
    speech = "speech"
    nonspeech = "nonspeech"


class CutRegion(BaseModel):
    """A span of the source timeline to be REMOVED."""

    id: str
    start: float
    end: float
    source: CutSource = CutSource.auto
    kind: CutKind = CutKind.speech


class ProjectStatus(str, Enum):
    created = "created"
    extracting = "extracting"
    transcribing = "transcribing"
    transcribed = "transcribed"
    error = "error"


class Project(BaseModel):
    id: str
    name: str
    source_filename: str
    reel_id: str | None = None
    duration: float | None = None
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    audio_rate: int | None = None
    proxy_ready: bool = False  # populated on read from proxy.mp4 existence (preview-only)
    language: str | None = None
    aligned: bool = False
    align_error: str | None = None
    status: ProjectStatus = ProjectStatus.created
    error: str | None = None
    segments: list[Segment] = Field(default_factory=list)
    silences: list[SilenceGap] = Field(default_factory=list)
    speech_regions: list[tuple[float, float]] = Field(default_factory=list)
    speech_threshold: float | None = None  # vad_threshold used for speech_regions
    cuts: list[CutRegion] = Field(default_factory=list)
    cut_params: CutParams = Field(default_factory=CutParams)


class Reel(BaseModel):
    """An ordered collection of clips (Projects) edited and exported together.

    `clip_ids` is the running order — it drives both the unified timeline and
    the combined FCPXML spine. `default_cut_params` is the reel-wide setting
    applied when the user edits with "apply to all videos".
    """

    id: str
    name: str
    clip_ids: list[str] = Field(default_factory=list)
    default_cut_params: CutParams = Field(default_factory=CutParams)
