from __future__ import annotations

from pathlib import Path
from urllib.parse import quote
from xml.sax.saxutils import escape

from . import cuts as cutlib
from .models import Project


def _frame_duration(fps: float) -> tuple[int, int]:
    """(numerator, denominator) seconds-per-frame for FCPXML."""
    for target, fd in (
        (23.976, (1001, 24000)),
        (29.97, (1001, 30000)),
        (59.94, (1001, 60000)),
    ):
        if abs(fps - target) < 0.03:
            return fd
    f = max(1, round(fps))
    return (100, f * 100)


def _t(seconds: float, fd: tuple[int, int]) -> str:
    """Frame-aligned rational time, e.g. '12300/2500s'."""
    num, den = fd
    spf = num / den
    frames = max(0, round(seconds / spf))
    return f"{frames * num}/{den}s"


def _seq_audio_rate(hz: int) -> str:
    if hz == 44100:
        return "44.1k"
    return f"{round(hz / 1000)}k"


def _bookmark(path: Path) -> str | None:
    """Base64 macOS bookmark so the sandboxed Final Cut can resolve the file.
    Returns None if pyobjc isn't available."""
    try:
        import base64

        from Foundation import NSURL  # type: ignore

        url = NSURL.fileURLWithPath_(str(path.resolve()))
        data, _err = (
            url.bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error_(
                1 << 10, None, None, None
            )
        )
        if data is None:
            return None
        return base64.b64encode(bytes(data)).decode("ascii")
    except Exception:
        return None


def build_fcpxml(project: Project, source_path: Path) -> str:
    fps = project.fps or 25.0
    fd = _frame_duration(fps)
    width = project.width or 1920
    height = project.height or 1080
    duration = project.duration or 0.0
    audio_rate = project.audio_rate or 48000

    kept = cutlib.project_kept(project)
    if not kept:
        kept = [(0.0, duration)]

    src_url = "file://" + quote(str(source_path.resolve()))
    name = escape(project.name)

    bookmark = _bookmark(source_path)
    if bookmark:
        media_rep = (
            f'<media-rep kind="original-media" src="{src_url}">\n'
            f"        <bookmark>{bookmark}</bookmark>\n"
            "      </media-rep>"
        )
    else:
        media_rep = f'<media-rep kind="original-media" src="{src_url}"/>'

    clips: list[str] = []
    offset = 0.0
    for i, (s, e) in enumerate(kept):
        length = e - s
        if length <= 0:
            continue
        clips.append(
            f'          <asset-clip ref="r2" name="clip{i + 1}" '
            f'offset="{_t(offset, fd)}" start="{_t(s, fd)}" '
            f'duration="{_t(length, fd)}"/>'
        )
        offset += length
    spine = "\n".join(clips)
    total = _t(offset, fd)

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<!DOCTYPE fcpxml>\n"
        '<fcpxml version="1.9">\n'
        "  <resources>\n"
        f'    <format id="r1" frameDuration="{fd[0]}/{fd[1]}s" '
        f'width="{width}" height="{height}" colorSpace="1-1-1 (Rec. 709)"/>\n'
        f'    <asset id="r2" name="{name}" start="0s" duration="{_t(duration, fd)}" '
        'hasVideo="1" videoSources="1" format="r1" hasAudio="1" audioSources="1" '
        f'audioChannels="2" audioRate="{audio_rate}">\n'
        f"      {media_rep}\n"
        "    </asset>\n"
        "  </resources>\n"
        "  <library>\n"
        '    <event name="kitcut">\n'
        f'      <project name="{name} (kitcut)">\n'
        f'        <sequence format="r1" duration="{total}" tcStart="0s" '
        f'tcFormat="NDF" audioLayout="stereo" audioRate="{_seq_audio_rate(audio_rate)}">\n'
        "          <spine>\n"
        f"{spine}\n"
        "          </spine>\n"
        "        </sequence>\n"
        "      </project>\n"
        "    </event>\n"
        "  </library>\n"
        "</fcpxml>\n"
    )
