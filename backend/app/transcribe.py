from __future__ import annotations

import os
from pathlib import Path
from typing import Callable

from .models import Segment, Word
from .storage import MODEL_DIR

DEFAULT_MODEL = os.environ.get("KITCUT_MODEL", "small")

_model_cache: dict[tuple[str, str, str], object] = {}


def get_model(size: str, device: str = "cpu", compute_type: str = "int8"):
    """Load (and cache) a faster-whisper model. Downloads on first use."""
    from faster_whisper import WhisperModel

    key = (size, device, compute_type)
    model = _model_cache.get(key)
    if model is None:
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        model = WhisperModel(
            size,
            device=device,
            compute_type=compute_type,
            download_root=str(MODEL_DIR),
        )
        _model_cache[key] = model
    return model


def transcribe(
    audio_path: Path,
    model_size: str = DEFAULT_MODEL,
    language: str | None = None,
    progress: Callable[[float, str], None] | None = None,
) -> dict:
    """Transcribe audio with word-level timestamps.

    `language` None → auto-detect (handles Turkish/English).
    Returns {"language": str, "segments": list[Segment]}.
    """
    model = get_model(model_size)

    if progress:
        progress(0.0, "loading model")

    segments_gen, info = model.transcribe(
        str(audio_path),
        language=language,
        word_timestamps=True,
        vad_filter=False,
    )

    total = info.duration or 0.0
    segments: list[Segment] = []
    for i, seg in enumerate(segments_gen):
        words = [
            Word(text=w.word, start=w.start, end=w.end)
            for w in (seg.words or [])
            if w.start is not None and w.end is not None
        ]
        segments.append(
            Segment(
                id=i,
                start=seg.start,
                end=seg.end,
                text=seg.text.strip(),
                words=words,
            )
        )
        if progress and total:
            progress(min(seg.end / total, 0.9), f"{seg.end:.0f}s / {total:.0f}s")

    # Refine word timestamps with forced alignment (tight boundaries are what
    # make false-start detection work). Falls back to Whisper timing on failure.
    if progress:
        progress(0.95, "aligning words")
    aligned = False
    align_error: str | None = None
    try:
        from .align import align_segments

        refined, align_error = align_segments(audio_path, segments, info.language)
        if refined:
            segments = refined
            aligned = True
    except Exception as exc:
        align_error = f"alignment crashed: {exc!r}"

    return {
        "language": info.language,
        "segments": segments,
        "aligned": aligned,
        "align_error": align_error,
    }
