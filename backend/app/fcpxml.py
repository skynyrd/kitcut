from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import quote
from xml.sax.saxutils import escape

from . import cuts as cutlib
from . import ffmpeg_utils
from .models import Project, Reel, Segment


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


def _style_def(style_id: int) -> str:
    # White text + a soft drop shadow for readability. (No stroke: a thick
    # outline fills thin glyphs and turns them black. backgroundColor is
    # caption-only in FCP, so Basic Title can't draw a box.)
    return (
        f'<text-style-def id="ts{style_id}">'
        '<text-style font="Helvetica" fontSize="60" fontColor="1 1 1 1" '
        'shadowColor="0 0 0 0.9" shadowOffset="6 315" shadowBlurRadius="10" '
        'backgroundColor="0 0 0 0.5" alignment="center"/></text-style-def>'
    )


def _subtitle_piece(
    use_title: bool,
    lang: str,
    style_id: int,
    off: str,
    dur: str,
    text: str,
    effect_ref: str = "r3",
) -> str:
    """One subtitle child of an asset-clip — a Basic Title or an iTT caption."""
    style_def = _style_def(style_id)
    if use_title:
        return (
            f'            <title ref="{effect_ref}" lane="1" name="{escape(text[:40])}" '
            f'offset="{off}" start="3600s" duration="{dur}">\n'
            '              <param name="Position" '
            'key="9999/999166631/999166633/1/100/101" value="0 -466"/>\n'
            "              <text><text-style "
            f'ref="ts{style_id}">{escape(text)}</text-style></text>\n'
            f"              {style_def}\n"
            "            </title>"
        )
    return (
        f'            <caption lane="1" name="{escape(text[:40])}" '
        f'offset="{off}" duration="{dur}" '
        f'role="iTT?captionFormat=ITT.{lang}">\n'
        '              <text placement="bottom"><text-style '
        f'ref="ts{style_id}">{escape(text)}</text-style></text>\n'
        f"              {style_def}\n"
        "            </caption>"
    )


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
            subs.append(_subtitle_piece(use_title, lang, style_id, off, dur, text))
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


def build_reel_fcpxml(
    reel: Reel,
    clips: list[tuple[Project, Path]],
    subtitle_mode: str = "title",
) -> str:
    """One Final Cut sequence concatenating every clip's kept intervals in order.

    Each clip contributes its own `<format>`+`<asset>` (sources may differ in
    fps/resolution); the spine references them with offsets that accumulate
    across the whole reel. Timeline times (offset/duration) use the sequence
    frame grid; source in-points (`start`) and subtitle offsets use each clip's
    own grid + timecode anchor `t0`. Mixed frame rates are conformed by FCP.
    """
    if not clips:
        raise ValueError("reel has no videos to export")

    use_title = subtitle_mode == "title"
    first_clip = clips[0][0]
    seq_fd = _frame_duration(first_clip.fps or 25.0)
    seq_audio_rate = first_clip.audio_rate or 48000

    resources: list[str] = []
    spine: list[str] = []
    pos = 0  # cumulative timeline position across the whole reel, in seq frames
    style_id = 0
    seq_tcfmt = "NDF"

    for idx, (clip, src) in enumerate(clips):
        fps = clip.fps or 25.0
        fd = _frame_duration(fps)
        duration = clip.duration or 0.0
        width = clip.width or 1920
        height = clip.height or 1080
        audio_rate = clip.audio_rate or 48000
        lang = clip.language or "en"

        tc = ffmpeg_utils.start_timecode(src)
        if tc:
            t0, drop = _timecode_frames(tc, max(1, round(fps)))
        else:
            t0, drop = 0, False
        tcfmt = "DF" if drop else "NDF"
        t0_sec = t0 * fd[0] / fd[1]
        if idx == 0:
            seq_tcfmt = tcfmt

        fmt_id, asset_id = f"f{idx}", f"a{idx}"
        src_url = "file://" + quote(str(src.resolve()))
        name = escape(clip.name)
        resources.append(
            f'    <format id="{fmt_id}" name="FFVideoFormatRateUndefined" '
            f'frameDuration="{fd[0]}/{fd[1]}s" width="{width}" height="{height}" '
            'colorSpace="1-1-1 (Rec. 709)"/>\n'
            f'    <asset id="{asset_id}" name="{name}" start="{_tf(t0, fd)}" '
            f'duration="{_tf(_to_frames(duration, fd), fd)}" hasVideo="1" hasAudio="1" '
            f'format="{fmt_id}" audioSources="1" audioChannels="2" '
            f'audioRate="{audio_rate}">\n'
            f'      <media-rep kind="original-media" src="{src_url}"/>\n'
            "    </asset>\n"
        )

        kept = cutlib.project_kept(clip) or [(0.0, duration)]
        ci = 0
        for s, e in kept:
            len_frames = _to_frames(e - s, seq_fd)
            if len_frames <= 0:
                continue
            ci += 1
            in_frames = _to_frames(s, fd)
            open_tag = (
                f'          <asset-clip ref="{asset_id}" name="{name} {ci}" '
                f'offset="{_tf(pos, seq_fd)}" start="{_tf(t0 + in_frames, fd)}" '
                f'duration="{_tf(len_frames, seq_fd)}" tcFormat="{tcfmt}"'
            )
            subs: list[str] = []
            for seg in clip.segments:
                ov_s = max(seg.start, s)
                ov_e = min(seg.end, e)
                if _to_frames(ov_e - ov_s, seq_fd) <= 0:
                    continue
                text = _segment_text(seg)
                if not text:
                    continue
                style_id += 1
                # Subtitles are timeline items: align offset/duration to the
                # SEQUENCE frame grid (anchored at the clip's source time t0_sec),
                # not the clip's own grid. Otherwise FCP rejects them as "not on an
                # edit frame boundary" whenever a clip's fps differs from the seq's.
                off = _tf(_to_frames(t0_sec + ov_s, seq_fd), seq_fd)
                dur = _tf(_to_frames(ov_e - ov_s, seq_fd), seq_fd)
                subs.append(_subtitle_piece(use_title, lang, style_id, off, dur, text))
            if subs:
                spine.append(
                    open_tag + ">\n" + "\n".join(subs) + "\n          </asset-clip>"
                )
            else:
                spine.append(open_tag + "/>")
            pos += len_frames

    effect_res = (
        '    <effect id="r3" name="Basic Title" '
        'uid=".../Titles.localized/Bumper:Opener.localized/'
        'Basic Title.localized/Basic Title.moti"/>\n'
        if use_title
        else ""
    )
    resources_xml = "".join(resources) + effect_res
    spine_xml = "\n".join(spine)
    reel_name = escape(reel.name)

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<!DOCTYPE fcpxml>\n"
        '<fcpxml version="1.9">\n'
        "  <resources>\n"
        f"{resources_xml}"
        "  </resources>\n"
        "  <library>\n"
        '    <event name="kitcut">\n'
        f'      <project name="{reel_name} (kitcut)">\n'
        f'        <sequence format="f0" tcStart="0s" tcFormat="{seq_tcfmt}" '
        f'audioLayout="stereo" audioRate="{_seq_audio_rate(seq_audio_rate)}">\n'
        "          <spine>\n"
        f"{spine_xml}\n"
        "          </spine>\n"
        "        </sequence>\n"
        "      </project>\n"
        "    </event>\n"
        "  </library>\n"
        "</fcpxml>\n"
    )
