from __future__ import annotations

import uuid

from .models import (
    CutKind,
    CutMode,
    CutParams,
    CutRegion,
    CutSource,
    Project,
    SilenceGap,
    SilenceKind,
)


def _merge(spans: list[tuple[float, float]]) -> list[tuple[float, float]]:
    merged: list[tuple[float, float]] = []
    for s, e in sorted(spans):
        if e <= s:
            continue
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return merged


def nonspeech_gaps(
    speech: list[tuple[float, float]], duration: float | None
) -> list[tuple[float, float]]:
    """Complement of VAD speech within [0, duration] = candidates to cut."""
    if not duration:
        return []
    gaps: list[tuple[float, float]] = []
    cursor = 0.0
    for s, e in _merge(list(speech)):
        if s > cursor:
            gaps.append((cursor, s))
        cursor = max(cursor, e)
    if cursor < duration:
        gaps.append((cursor, duration))
    return gaps


def classify(gaps: list[tuple[float, float]], params: CutParams) -> list[SilenceGap]:
    """A non-speech gap is b-roll if long, else a speech pause."""
    broll_min = params.broll_min_ms / 1000
    return [
        SilenceGap(
            start=s,
            end=e,
            kind=SilenceKind.nonspeech if (e - s) >= broll_min else SilenceKind.speech,
        )
        for s, e in gaps
    ]


def _region(start: float, end: float, kind: SilenceKind) -> CutRegion:
    return CutRegion(
        id=f"auto-{uuid.uuid4().hex[:8]}",
        start=round(start, 3),
        end=round(end, 3),
        source=CutSource.auto,
        kind=CutKind(kind.value),
    )


def build_auto_cuts(gaps: list[SilenceGap], params: CutParams) -> list[CutRegion]:
    """Turn classified non-speech gaps into remove-regions per the params."""
    pad = params.pad_ms / 1000
    speech_min = params.speech_min_silence_ms / 1000
    broll_min = params.broll_min_ms / 1000
    broll_keep = params.broll_keep_ms / 1000

    cuts: list[CutRegion] = []
    for g in gaps:
        d = g.end - g.start
        as_pause = params.mode == CutMode.uniform or g.kind == SilenceKind.speech
        if as_pause:
            if d < speech_min:
                continue
            cs, ce = g.start + pad, g.end - pad
        else:
            if params.keep_nonspeech or d < broll_min:
                continue
            keep_half = broll_keep / 2
            cs, ce = g.start + keep_half, g.end - keep_half
        if ce - cs > 0.02:
            cuts.append(_region(cs, ce, g.kind))
    return cuts


def recompute_auto(
    project: Project, speech: list[tuple[float, float]]
) -> list[SilenceGap]:
    gaps = nonspeech_gaps(speech, project.duration)
    return classify(gaps, project.cut_params)


def _kept_from_removes(
    removes: list[tuple[float, float]], duration: float | None
) -> list[tuple[float, float]]:
    if not duration:
        return []
    merged = _merge([(max(0.0, s), min(duration, e)) for s, e in removes])
    kept: list[tuple[float, float]] = []
    cursor = 0.0
    for s, e in merged:
        if s > cursor:
            kept.append((cursor, s))
        cursor = max(cursor, e)
    if cursor < duration:
        kept.append((cursor, duration))
    return kept


def removed_word_spans(project: Project) -> list[tuple[float, float]]:
    return [
        (w.start, w.end)
        for seg in project.segments
        for w in seg.words
        if w.removed and w.end > w.start
    ]


def project_removes(project: Project) -> list[tuple[float, float]]:
    return [(c.start, c.end) for c in project.cuts] + removed_word_spans(project)


def project_kept(project: Project) -> list[tuple[float, float]]:
    return _kept_from_removes(project_removes(project), project.duration)


def project_stats(project: Project) -> dict:
    kept = project_kept(project)
    kept_total = sum(e - s for s, e in kept)
    dur = project.duration or 0.0
    removed_words = sum(1 for seg in project.segments for w in seg.words if w.removed)
    return {
        "n_cuts": len(project.cuts),
        "removed_words": removed_words,
        "removed_s": round(dur - kept_total, 2),
        "final_s": round(kept_total, 2),
        "original_s": round(dur, 2),
    }


def cuts_payload(project: Project) -> dict:
    return {
        "cut_params": project.cut_params.model_dump(),
        "silences": [g.model_dump() for g in project.silences],
        "cuts": [c.model_dump() for c in project.cuts],
        "kept": project_kept(project),
        "stats": project_stats(project),
    }
