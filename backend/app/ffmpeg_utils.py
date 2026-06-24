from __future__ import annotations

import json
import subprocess
import tempfile
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


def video_frame_count(path: Path) -> int | None:
    """Exact number of video frames from stream metadata. The container/format
    duration can run longer than the video stream (audio padding, DJI &c.), so a
    frame count derived from it over-declares and trips FCP's 'no respective
    media'. Returns None when the stream doesn't report a usable count."""
    cmd = [
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=nb_frames",
        "-of", "default=nw=1:nk=1", str(path),
    ]
    out = subprocess.run(cmd, capture_output=True, text=True)
    val = out.stdout.strip()
    return int(val) if val.isdigit() and int(val) > 0 else None


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


def build_proxy(src: Path, dst: Path, height: int = 720, bitrate: str = "4M") -> Path:
    """Build a lightweight preview proxy: 8-bit H.264 + AAC in a 16:9 box of the
    given height, faststart, with a keyframe every 0.5s for snappy scrubbing.

    Hardware-encoded via VideoToolbox so a 4K 10-bit HEVC source transcodes in
    seconds. Preview-only — export still references the camera original."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    box_w = round(height * 16 / 9)
    cmd = [
        "ffmpeg",
        "-y",
        "-i", str(src),
        "-map", "0:v:0",
        "-map", "0:a:0?",  # '?' → don't fail when the source has no audio
        "-dn",  # drop mapped data streams
        "-write_tmcd", "0",  # stop the mp4 muxer synthesizing an iPhone timecode track
        "-vf", f"scale={box_w}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2",
        "-c:v", "h264_videotoolbox",
        "-b:v", bitrate,
        "-pix_fmt", "yuv420p",
        "-force_key_frames", "expr:gte(t,n_forced*0.5)",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        str(dst),
    ]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        raise FFmpegError(out.stderr.strip() or "ffmpeg proxy build failed")
    return dst


def concat_audio(parts: list[Path], dst: Path, sample_rate: int = 16000) -> Path:
    """Concatenate equal-format WAVs (mono PCM) into one PCM WAV, in order.

    Inputs are the per-clip `audio.wav` files (all extracted with the same
    settings), so the concat demuxer joins them cleanly; we re-encode to PCM to
    keep the output uniform regardless of source quirks."""
    if not parts:
        raise FFmpegError("no audio parts to concatenate")
    dst.parent.mkdir(parents=True, exist_ok=True)
    listing = "".join(f"file '{p.resolve().as_posix()}'\n" for p in parts)
    tmp = tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False)
    try:
        tmp.write(listing)
        tmp.close()
        cmd = [
            "ffmpeg",
            "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", tmp.name,
            "-ac", "1",
            "-ar", str(sample_rate),
            "-c:a", "pcm_s16le",
            str(dst),
        ]
        out = subprocess.run(cmd, capture_output=True, text=True)
        if out.returncode != 0:
            raise FFmpegError(out.stderr.strip() or "ffmpeg audio concat failed")
    finally:
        Path(tmp.name).unlink(missing_ok=True)
    return dst
