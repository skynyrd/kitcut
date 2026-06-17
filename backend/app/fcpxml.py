from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import quote
from xml.sax.saxutils import escape

from . import cuts as cutlib
from . import ffmpeg_utils
from .models import Project, Segment


def _segment_text(seg: Segment) -> str:
    if seg.words:
        return "".join(w.text for w in seg.words if not w.removed).strip()
    return seg.text.strip()


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


def _tf(frames: int, fd: tuple[int, int]) -> str:
    """Frame index -> rational time string, e.g. '2318749433/30000s'."""
    return f"{frames * fd[0]}/{fd[1]}s"


def _to_frames(seconds: float, fd: tuple[int, int]) -> int:
    return max(0, round(seconds * fd[1] / fd[0]))


def _seq_audio_rate(hz: int) -> str:
    return "44.1k" if hz == 44100 else f"{round(hz / 1000)}k"


def _timecode_frames(tc: str, nominal_fps: int) -> tuple[int, bool]:
    """Parse 'HH:MM:SS;FF' (drop-frame) / 'HH:MM:SS:FF' (non-drop) into the
    absolute frame index Final Cut uses to anchor the media. Returns
    (frame_index, is_drop_frame)."""
    drop = ";" in tc
    parts = re.split(r"[:;.]", tc.strip())
    if len(parts) != 4:
        return 0, False
    try:
        h, m, s, f = (int(p) for p in parts)
    except ValueError:
        return 0, False
    naive = (h * 3600 + m * 60 + s) * nominal_fps + f
    if drop:
        drop_per_min = 2 if nominal_fps == 30 else (4 if nominal_fps == 60 else 0)
        total_min = h * 60 + m
        naive -= drop_per_min * (total_min - total_min // 10)
    return naive, drop


def build_fcpxml(
    project: Project, source_path: Path, subtitle_mode: str = "title"
) -> str:
    fps = project.fps or 25.0
    fd = _frame_duration(fps)
    width = project.width or 1920
    height = project.height or 1080
    duration = project.duration or 0.0
    audio_rate = project.audio_rate or 48000

    # Anchor to the source's start timecode — Final Cut places the media there,
    # so clip in/out points must be timecode-relative, not 0-based.
    tc = ffmpeg_utils.start_timecode(source_path)
    if tc:
        t0, drop = _timecode_frames(tc, max(1, round(fps)))
    else:
        t0, drop = 0, False
    tcfmt = "DF" if drop else "NDF"

    kept = cutlib.project_kept(project)
    if not kept:
        kept = [(0.0, duration)]

    src_url = "file://" + quote(str(source_path.resolve()))
    name = escape(project.name)

    lang = project.language or "en"
    use_title = subtitle_mode == "title"
    clips: list[str] = []
    pos = 0  # cumulative timeline position, in frames
    style_id = 0
    for i, (s, e) in enumerate(kept):
        in_frames = _to_frames(s, fd)
        len_frames = _to_frames(e - s, fd)
        if len_frames <= 0:
            continue
        open_tag = (
            f'          <asset-clip ref="r2" name="clip{i + 1}" '
            f'offset="{_tf(t0 + pos, fd)}" start="{_tf(t0 + in_frames, fd)}" '
            f'duration="{_tf(len_frames, fd)}" tcFormat="{tcfmt}"'
        )
        # One subtitle piece per kept clip the segment OVERLAPS, so a subtitle
        # that spans a cut still shows on both sides of the cut.
        subs: list[str] = []
        for seg in project.segments:
            ov_s = max(seg.start, s)
            ov_e = min(seg.end, e)
            if _to_frames(ov_e - ov_s, fd) <= 0:
                continue
            text = _segment_text(seg)
            if not text:
                continue
            style_id += 1
            off = _tf(t0 + _to_frames(ov_s, fd), fd)
            dur = _tf(_to_frames(ov_e - ov_s, fd), fd)
            # White text + a soft drop shadow for readability. (No stroke: a
            # thick outline fills thin glyphs and turns them black. backgroundColor
            # is caption-only in FCP, so Basic Title can't draw a box.)
            style_def = (
                f'<text-style-def id="ts{style_id}">'
                '<text-style font="Helvetica" fontSize="60" fontColor="1 1 1 1" '
                'shadowColor="0 0 0 0.9" shadowOffset="6 315" shadowBlurRadius="10" '
                'backgroundColor="0 0 0 0.5" alignment="center"/></text-style-def>'
            )
            if use_title:
                subs.append(
                    f'            <title ref="r3" lane="1" name="{escape(text[:40])}" '
                    f'offset="{off}" start="3600s" duration="{dur}">\n'
                    '              <param name="Position" '
                    'key="9999/999166631/999166633/1/100/101" value="0 -466"/>\n'
                    "              <text><text-style "
                    f'ref="ts{style_id}">{escape(text)}</text-style></text>\n'
                    f"              {style_def}\n"
                    "            </title>"
                )
            else:
                subs.append(
                    f'            <caption lane="1" name="{escape(text[:40])}" '
                    f'offset="{off}" duration="{dur}" '
                    f'role="iTT?captionFormat=ITT.{lang}">\n'
                    '              <text placement="bottom"><text-style '
                    f'ref="ts{style_id}">{escape(text)}</text-style></text>\n'
                    f"              {style_def}\n"
                    "            </caption>"
                )
        if subs:
            clips.append(open_tag + ">\n" + "\n".join(subs) + "\n          </asset-clip>")
        else:
            clips.append(open_tag + "/>")
        pos += len_frames
    spine = "\n".join(clips)

    asset_start = _tf(t0, fd)
    asset_dur = _tf(_to_frames(duration, fd), fd)
    effect_res = (
        '    <effect id="r3" name="Basic Title" '
        'uid=".../Titles.localized/Bumper:Opener.localized/'
        'Basic Title.localized/Basic Title.moti"/>\n'
        if use_title
        else ""
    )

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<!DOCTYPE fcpxml>\n"
        '<fcpxml version="1.9">\n'
        "  <resources>\n"
        f'    <format id="r1" name="FFVideoFormatRateUndefined" '
        f'frameDuration="{fd[0]}/{fd[1]}s" width="{width}" height="{height}" '
        'colorSpace="1-1-1 (Rec. 709)"/>\n'
        f'    <asset id="r2" name="{name}" start="{asset_start}" '
        f'duration="{asset_dur}" hasVideo="1" hasAudio="1" format="r1" '
        'audioSources="1" audioChannels="2" '
        f'audioRate="{audio_rate}">\n'
        f'      <media-rep kind="original-media" src="{src_url}"/>\n'
        "    </asset>\n"
        f"{effect_res}"
        "  </resources>\n"
        "  <library>\n"
        '    <event name="kitcut">\n'
        f'      <project name="{name} (kitcut)">\n'
        f'        <sequence format="r1" tcStart="0s" tcFormat="{tcfmt}" '
        f'audioLayout="stereo" audioRate="{_seq_audio_rate(audio_rate)}">\n'
        "          <spine>\n"
        f"{spine}\n"
        "          </spine>\n"
        "        </sequence>\n"
        "      </project>\n"
        "    </event>\n"
        "  </library>\n"
        "</fcpxml>\n"
    )
