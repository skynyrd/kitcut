from __future__ import annotations

import json
import subprocess
from pathlib import Path


class FFmpegError(RuntimeError):
    pass


def _fraction(value: str | None) -> float | None:
    if not value:
        return None
    try:
        if "/" in value:
            num, den = value.split("/", 1)
            den_f = float(den)
            return float(num) / den_f if den_f else None
        return float(value)
    except (ValueError, ZeroDivisionError):
        return None


def probe(path: Path) -> dict:
    """Return basic media metadata via ffprobe."""
    cmd = [
        "ffprobe",
        "-v", "error",
        "-show_format",
        "-show_streams",
        "-of", "json",
        str(path),
    ]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        raise FFmpegError(out.stderr.strip() or "ffprobe failed")

    data = json.loads(out.stdout or "{}")
    fmt = data.get("format", {})
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)

    duration = None
    if fmt.get("duration"):
        duration = _fraction(fmt["duration"])
    elif video and video.get("duration"):
        duration = _fraction(video["duration"])

    return {
        "duration": duration,
        "width": video.get("width") if video else None,
        "height": video.get("height") if video else None,
        "fps": _fraction(video.get("avg_frame_rate")) if video else None,
        "has_audio": audio is not None,
        "audio_rate": int(audio["sample_rate"])
        if audio and audio.get("sample_rate")
        else None,
    }


def start_timecode(path: Path) -> str | None:
    """Source start timecode (e.g. '21:26:54;13'), or None. Final Cut anchors
    an asset's media timeline to this, so clip in/out points must be relative
    to it — otherwise FCP reports 'no respective media'."""
    cmd = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "format_tags=timecode:stream_tags=timecode",
        "-of", "default=nw=1:nk=1",
        str(path),
    ]
    out = subprocess.run(cmd, capture_output=True, text=True)
    for line in out.stdout.splitlines():
        line = line.strip()
        if line and ":" in line:
            return line
    return None


def extract_audio(src: Path, dst: Path, sample_rate: int = 16000) -> Path:
    """Extract mono PCM WAV suitable for Whisper + silence analysis."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-y",
        "-i", str(src),
        "-vn",
        "-ac", "1",
        "-ar", str(sample_rate),
        "-c:a", "pcm_s16le",
        str(dst),
    ]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        raise FFmpegError(out.stderr.strip() or "ffmpeg audio extraction failed")
    return dst
