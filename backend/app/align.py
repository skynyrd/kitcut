from __future__ import annotations

import os
from pathlib import Path

# macOS Python.framework ships without usable CA certs, so torch-hub /
# huggingface model downloads fail SSL verification. Point them at certifi.
try:
    import certifi

    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
    os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())
except Exception:
    pass

from .models import Segment, Word

_DEVICE = "cpu"
_cache: dict[str, tuple] = {}


def _get_model(language: str):
    import whisperx

    m = _cache.get(language)
    if m is None:
        m = whisperx.load_align_model(language_code=language, device=_DEVICE)
        _cache[language] = m
    return m


def align_segments(
    audio_path: Path, segments: list[Segment], language: str
) -> tuple[list[Segment] | None, str | None]:
    """Re-align the transcript to audio for tight word timestamps (wav2vec2).

    Returns (refined_segments, error). On any failure the segments are None and
    error explains why — callers should keep the original Whisper timestamps.
    """
    try:
        import whisperx

        model, metadata = _get_model(language)
    except Exception as exc:
        return None, f"load_align_model({language}) failed: {exc!r}"

    seg_dicts = [
        {"start": s.start, "end": s.end, "text": s.text}
        for s in segments
        if s.text.strip()
    ]
    if not seg_dicts:
        return None, "no transcribed segments to align"

    try:
        audio = whisperx.load_audio(str(audio_path))
        result = whisperx.align(
            seg_dicts, model, metadata, audio, _DEVICE, return_char_alignments=False
        )
    except Exception as exc:
        return None, f"align failed: {exc!r}"

    # Refine timestamps IN PLACE at the WORD level. whisperx regroups segments,
    # so we match the FLAT word stream (same tokens, same order) and only update
    # timing — never the word list or text.
    aligned_words = result.get("word_segments")
    if aligned_words is None:
        aligned_words = [
            w for seg in result.get("segments", []) for w in seg.get("words", [])
        ]

    nonempty = [s for s in segments if s.text.strip()]
    orig_refs = [(s, i) for s in nonempty for i in range(len(s.words))]

    if len(orig_refs) != len(aligned_words):
        return None, (
            f"word count mismatch (whisper {len(orig_refs)} vs align "
            f"{len(aligned_words)}); kept whisper timing"
        )

    new_words: dict[int, list[Word]] = {id(s): list(s.words) for s in nonempty}
    refined_count = 0
    for (s, i), aw in zip(orig_refs, aligned_words):
        st, en = aw.get("start"), aw.get("end")
        if st is not None and en is not None and float(en) > float(st):
            o = s.words[i]
            new_words[id(s)][i] = Word(
                text=o.text, start=float(st), end=float(en), removed=o.removed
            )
            refined_count += 1

    out = [
        Segment(
            id=s.id,
            start=s.start,
            end=s.end,
            text=s.text,
            words=new_words.get(id(s), s.words),
        )
        for s in segments
    ]
    note = None if refined_count else "aligned but no timed words"
    return out, note
