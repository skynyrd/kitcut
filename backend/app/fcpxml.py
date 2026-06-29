from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import quote
from xml.sax.saxutils import escape

from . import cuts as cutlib
from . import ffmpeg_utils
from . import storage
from .models import Project, Reel, Segment

# Built-in "Slide" transition + the auto Audio Crossfade FCP pairs with it. These
# uids are stable FCP identifiers (reverse-engineered from a real Export XML); FCP
# resolves the effect by uid, not the localized display name.
SLIDE_EFFECT_UID = "FxPlug:6AAB0D54-FCD8-4EBD-A62D-D352A5ED1648"
AUDIO_XFADE_UID = "FFAudioTransition"
TRANSITION_FRAMES = 6  # transition length, in sequence frames
SFX_FILENAME = "Air Swipe 05.wav"  # connected swipe sound, resolved in storage.BASE_DIR


def _sfx_source() -> Path | None:
    """The swipe sound file, or None when it isn't present (transitions still emit
    their video Slide; only the SFX is skipped)."""
    p = storage.BASE_DIR / SFX_FILENAME
    return p if p.exists() else None


def _segment_text(seg: Segment) -> str:
    if seg.words:
        return "".join(
            w.text for w in seg.words if not w.removed and not w.hidden
        ).strip()
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
    # Drop-frame timecode only exists for 29.97/59.94. DJI &c. report a slightly
    # off fps (e.g. 29.939) that would otherwise format as 30 NDF and make FCP
    # reject tcFormat="DF". Trust the timecode and use the true DF frame rate.
    if drop:
        fd = (1001, 60000) if round(fps) >= 50 else (1001, 30000)
    tcfmt = "DF" if drop else "NDF"
    # Use the video stream's true frame count — the container duration can be
    # longer (audio padding), which over-declares frames and makes FCP reject
    # edits that reach past the last real frame ("no respective media").
    asset_dur_frames = ffmpeg_utils.video_frame_count(source_path) or int(
        duration * fd[1] / fd[0]
    )

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
        # clamp so the source range can't run past the asset's media
        len_frames = min(_to_frames(e - s, fd), asset_dur_frames - in_frames)
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
    asset_dur = _tf(asset_dur_frames, fd)
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


def _render_asset_clip(open_tag: str, children: list[str]) -> str:
    if children:
        return open_tag + ">\n" + "\n".join(children) + "\n          </asset-clip>"
    return open_tag + "/>"


def _render_transition(off_frames: int, seq_fd: tuple[int, int]) -> str:
    """A 6-frame built-in Slide, centered on the edit, plus the Audio Crossfade FCP
    pairs with it. The params are deliberately omitted: Final Cut *exports* popup
    params as 'index (Label)' (e.g. '2 (Right)') but its *importer* rejects that
    form ('Encountered an unexpected value'), so we let the Slide use its defaults."""
    return (
        f'          <transition name="Slide" offset="{_tf(off_frames, seq_fd)}" '
        f'duration="{_tf(TRANSITION_FRAMES, seq_fd)}">\n'
        '            <filter-video ref="rSlide" name="Slide"/>\n'
        '            <filter-audio ref="rAudX" name="Audio Crossfade"/>\n'
        "          </transition>"
    )


def _render_sfx_child(
    rec: dict, half: int, seq_fd: tuple[int, int], dur_str: str
) -> str:
    """Connected swipe sound on lane -1, nested in the preceding clip and anchored
    at the transition's first frame (= 3 frames before that clip's out-point)."""
    fd = rec["fd"]
    parent_start_s = (rec["t0"] + rec["in_frames"]) * fd[0] / fd[1]
    off_s = parent_start_s + (rec["len_frames"] - half) * seq_fd[0] / seq_fd[1]
    off_frames = round(off_s * seq_fd[1] / seq_fd[0])
    return (
        f'            <asset-clip ref="rSfx" lane="-1" offset="{_tf(off_frames, seq_fd)}" '
        f'name="Air Swipe 05" duration="{dur_str}" format="rSfxF" audioRole="dialogue"/>'
    )


def build_reel_fcpxml(
    reel: Reel,
    clips: list[tuple[Project, Path]],
    subtitle_mode: str = "title",
    transitions: bool = True,
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
    first_clip, first_src = clips[0]
    seq_fps = first_clip.fps or 25.0
    seq_fd = _frame_duration(seq_fps)
    _tc0 = ffmpeg_utils.start_timecode(first_src)
    if _tc0 and ";" in _tc0:  # drop-frame → true 29.97/59.94 grid (matches format f0)
        seq_fd = (1001, 60000) if round(seq_fps) >= 50 else (1001, 30000)
    seq_audio_rate = first_clip.audio_rate or 48000

    # Master gate. Junctions need 2+ clips (implied by a junction existing); internal
    # cut-joins can occur in a single-clip reel too, so don't gate on clip count here.
    add_transitions = transitions
    half = TRANSITION_FRAMES // 2
    sfx_src = _sfx_source() if add_transitions else None
    if sfx_src is not None:
        sfx_meta = ffmpeg_utils.probe(sfx_src)
        sfx_rate = sfx_meta.get("audio_rate") or 44100
        sfx_dur_str = _tf(
            max(1, _to_frames(sfx_meta.get("duration") or 0.0, seq_fd)), seq_fd
        )
        sfx_url = "file://" + quote(str(sfx_src.resolve()))

    resources: list[str] = []
    style_id = 0
    seq_tcfmt = "NDF"
    # Pass 1: per-clip raw intervals (timeline offset + handle trimming applied
    # later, once we know where the clip-to-clip junctions are).
    clips_meta: list[dict] = []

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
        if drop:  # see build_fcpxml: DF formats must use the true 29.97/59.94 rate
            fd = (1001, 60000) if round(fps) >= 50 else (1001, 30000)
        tcfmt = "DF" if drop else "NDF"
        t0_sec = t0 * fd[0] / fd[1]
        asset_dur_frames = ffmpeg_utils.video_frame_count(src) or int(
            duration * fd[1] / fd[0]
        )  # true video frames; see build_fcpxml
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
            f'duration="{_tf(asset_dur_frames, fd)}" hasVideo="1" hasAudio="1" '
            f'format="{fmt_id}" audioSources="1" audioChannels="2" '
            f'audioRate="{audio_rate}">\n'
            f'      <media-rep kind="original-media" src="{src_url}"/>\n'
            "    </asset>\n"
        )

        kept = cutlib.project_kept(clip) or [(0.0, duration)]
        # starts of cuts the user opted into a transition for; a kept interval whose
        # left edge sits on one of these carries an internal-join transition.
        tstarts = [c.start for c in clip.cuts if c.transition]
        prev_e: float | None = None
        intervals: list[dict] = []
        for s, e in kept:
            in_frames = _to_frames(s, fd)
            # clamp so the source range can't run past the asset's media (rounding
            # can push the last kept interval ~1 frame over → FCP "no respective media")
            raw_len = min(_to_frames(e - s, seq_fd), asset_dur_frames - in_frames)
            if raw_len <= 0:
                continue
            trans_before = prev_e is not None and any(
                abs(prev_e - cs) < 1e-4 for cs in tstarts
            )
            prev_e = e
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
            intervals.append(
                {
                    "in_frames": in_frames,
                    "raw_len": raw_len,
                    "subs": subs,
                    "trans_before": trans_before,
                }
            )
        clips_meta.append(
            {"fd": fd, "t0": t0, "tcfmt": tcfmt, "asset_id": asset_id,
             "name": name, "intervals": intervals}
        )

    # Flatten every non-empty interval into one ordered list — each adjacent pair is
    # a "seam". A seam is a clip-to-clip junction (different clips) or an internal
    # cut-join (same clip, where a silence was removed). Both carry the SAME Slide.
    flat: list[tuple[int, dict]] = [
        (i, iv) for i, m in enumerate(clips_meta) for iv in m["intervals"]
    ]
    clip_ids = [clip.id for clip, _ in clips]
    disabled = set(reel.disabled_junctions)

    # Decide which seams get a transition + the per-record handle trims. A centered
    # transition needs `half` frames of handle on each side; whole/edge intervals
    # have none, so we trim `half` off the inside of each boundary interval — those
    # trimmed frames become the handle FCP slides into.
    seam_on = [False] * len(flat)  # seam_on[k] → transition before flat[k]
    trim_left = [0] * len(flat)
    trim_right = [0] * len(flat)
    if add_transitions:
        for k in range(1, len(flat)):
            (ai, aiv), (bi, biv) = flat[k - 1], flat[k]
            # ≥ a full transition of frames so an edge can give head+tail and stay >0
            if (
                aiv["raw_len"] < 2 * TRANSITION_FRAMES
                or biv["raw_len"] < 2 * TRANSITION_FRAMES
            ):
                continue
            if ai != bi:  # clip junction: auto-on unless this left clip opted out
                on = clip_ids[ai] not in disabled
            else:  # internal cut-join: opt-in per cut
                on = biv["trans_before"]
            if on:
                seam_on[k] = True
                trim_right[k - 1] = half
                trim_left[k] = half

    # Pass 2: lay the (trimmed) intervals end-to-end, building records with offsets.
    pos = 0  # cumulative timeline position across the whole reel, in seq frames
    records: list[dict] = []
    jcount: dict[int, int] = {}  # per-clip running interval number (for the name)
    for k, (i, iv) in enumerate(flat):
        m = clips_meta[i]
        fd, t0, tcfmt = m["fd"], m["t0"], m["tcfmt"]
        asset_id, name = m["asset_id"], m["name"]
        jn = jcount.get(i, 0) + 1
        jcount[i] = jn
        tl, tr = trim_left[k], trim_right[k]
        in_f = iv["in_frames"] + tl
        length = iv["raw_len"] - tl - tr
        open_tag = (
            f'          <asset-clip ref="{asset_id}" name="{name} {jn}" '
            f'offset="{_tf(pos, seq_fd)}" start="{_tf(t0 + in_f, fd)}" '
            f'duration="{_tf(length, seq_fd)}" tcFormat="{tcfmt}"'
        )
        records.append(
            {
                "open_tag": open_tag,
                "subs": iv["subs"],
                "extra": [],
                "pos": pos,
                "len_frames": length,
                "fd": fd,
                "t0": t0,
                "in_frames": in_f,
            }
        )
        pos += length

    # A Slide at each enabled seam (centered on the trimmed edit) + the swipe SFX hung
    # off the preceding interval, anchored to the transition's first frame.
    transition_before: dict[int, str] = {}
    used_transition = used_sfx = False
    for k in range(1, len(flat)):
        if not seam_on[k]:
            continue
        transition_before[k] = _render_transition(records[k]["pos"] - half, seq_fd)
        used_transition = True
        if sfx_src is not None:
            ar = records[k - 1]
            ar["extra"].append(_render_sfx_child(ar, half, seq_fd, sfx_dur_str))
            used_sfx = True

    spine_parts: list[str] = []
    for k, rec in enumerate(records):
        if k in transition_before:
            spine_parts.append(transition_before[k])
        spine_parts.append(_render_asset_clip(rec["open_tag"], rec["subs"] + rec["extra"]))

    effect_res = (
        '    <effect id="r3" name="Basic Title" '
        'uid=".../Titles.localized/Bumper:Opener.localized/'
        'Basic Title.localized/Basic Title.moti"/>\n'
        if use_title
        else ""
    )
    if used_transition:
        effect_res += (
            f'    <effect id="rSlide" name="Slide" uid="{SLIDE_EFFECT_UID}"/>\n'
            f'    <effect id="rAudX" name="Audio Crossfade" uid="{AUDIO_XFADE_UID}"/>\n'
        )
    if used_sfx:
        effect_res += (
            '    <format id="rSfxF" name="FFVideoFormatRateUndefined"/>\n'
            f'    <asset id="rSfx" name="Air Swipe 05" start="0s" '
            f'duration="{sfx_dur_str}" hasAudio="1" audioSources="1" '
            f'audioChannels="2" audioRate="{sfx_rate}">\n'
            f'      <media-rep kind="original-media" src="{sfx_url}"/>\n'
            "    </asset>\n"
        )
    resources_xml = "".join(resources) + effect_res
    spine_xml = "\n".join(spine_parts)
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
