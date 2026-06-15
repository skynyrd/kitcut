from __future__ import annotations

from . import cuts as cutlib
from .models import Project, Segment


def _ts(t: float) -> str:
    ms_total = int(round(max(0.0, t) * 1000))
    h, ms_total = divmod(ms_total, 3600000)
    m, ms_total = divmod(ms_total, 60000)
    s, ms = divmod(ms_total, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _segment_text(seg: Segment) -> str:
    if seg.words:
        return "".join(w.text for w in seg.words if not w.removed).strip()
    return seg.text.strip()


def build_srt(project: Project) -> str:
    """SRT re-timed to the cut timeline so captions align with the FCPXML cut."""
    kept = cutlib.project_kept(project)
    if not kept:
        return ""

    def to_cut(t: float) -> float:
        acc = 0.0
        for s, e in kept:
            if t <= s:
                return acc
            if t <= e:
                return acc + (t - s)
            acc += e - s
        return acc

    blocks: list[str] = []
    idx = 1
    for seg in project.segments:
        text = _segment_text(seg)
        if not text:
            continue
        cs, ce = to_cut(seg.start), to_cut(seg.end)
        if ce - cs < 0.05:  # segment falls entirely inside a cut
            continue
        blocks.append(f"{idx}\n{_ts(cs)} --> {_ts(ce)}\n{text}\n")
        idx += 1

    return "\n".join(blocks)
