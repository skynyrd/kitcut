"""Reel FCPXML transitions: auto clip-junctions + manual internal cut-joins.

`build_reel_fcpxml` probes the source media, so we stub ffmpeg_utils + the SFX
lookup. All clips here are 25fps → seq frame grid is (100, 2500), so N frames
serialize as f"{N*100}/2500s" (a 6-frame transition = "600/2500s").
"""
from pathlib import Path
from xml.dom.minidom import parseString

import pytest

from app import fcpxml
from app.models import CutRegion, Project, Reel


@pytest.fixture(autouse=True)
def stub_media(monkeypatch):
    monkeypatch.setattr(fcpxml.ffmpeg_utils, "start_timecode", lambda src: None)
    monkeypatch.setattr(fcpxml.ffmpeg_utils, "video_frame_count", lambda src: 100_000)
    # pretend the swipe SFX exists so the connected sound path runs deterministically
    monkeypatch.setattr(fcpxml, "_sfx_source", lambda: Path("/fake/Air Swipe 05.wav"))
    monkeypatch.setattr(
        fcpxml.ffmpeg_utils,
        "probe",
        lambda src: {"duration": 0.5, "audio_rate": 44100},
    )


def _clip(cid: str, duration: float = 10.0, cuts=None) -> Project:
    return Project(
        id=cid,
        name=cid,
        source_filename=f"{cid}.mov",
        duration=duration,
        width=1920,
        height=1080,
        fps=25.0,
        audio_rate=48000,
        language="en",
        cuts=cuts or [],
    )


def _cut(start: float, end: float, transition: bool = False) -> CutRegion:
    return CutRegion(id=f"c{start}", start=start, end=end, transition=transition)


def _reel(clips, disabled=None) -> Reel:
    return Reel(
        id="r",
        name="reel",
        clip_ids=[c.id for c in clips],
        disabled_junctions=disabled or [],
    )


def _build(clips, disabled=None, transitions=True) -> str:
    reel = _reel(clips, disabled)
    xml = fcpxml.build_reel_fcpxml(
        reel, [(c, Path(f"/fake/{c.id}.mov")) for c in clips], transitions=transitions
    )
    parseString(xml)  # must be well-formed
    return xml


def test_internal_cut_join_transition_on():
    # one clip, one silence cut 4..5 the user opted into → kept [(0,4),(5,10)]
    clip = _clip("a", cuts=[_cut(4.0, 5.0, transition=True)])
    xml = _build([clip])
    assert xml.count("<transition ") == 1
    assert 'duration="600/2500s"' in xml  # 6-frame Slide
    assert xml.count('ref="rSfx"') == 1  # one connected swipe (lane -1)
    assert 'lane="-1"' in xml
    # both edges trimmed half (3f): 100f→97 tail, 125f→122 head (start shifted +3)
    assert 'duration="9700/2500s"' in xml
    assert 'duration="12200/2500s"' in xml
    assert 'start="12800/2500s"' in xml


def test_internal_cut_join_off_by_default():
    clip = _clip("a", cuts=[_cut(4.0, 5.0)])  # transition defaults False
    xml = _build([clip])
    assert "<transition " not in xml
    assert xml.count('name="Air Swipe 05"') == 0
    # untrimmed: 0..4 = 100f, 5..10 = 125f
    assert 'duration="10000/2500s"' in xml
    assert 'duration="12500/2500s"' in xml


def test_clip_junction_auto_on_regression():
    a, b = _clip("a"), _clip("b")
    xml = _build([a, b])
    assert xml.count("<transition ") == 1
    assert 'duration="600/2500s"' in xml
    assert 'offset="24400/2500s"' in xml  # boundary(247) - half(3)
    assert xml.count('ref="rSfx"') == 1
    # both boundary clips trimmed: 250f → 247
    assert xml.count('duration="24700/2500s"') == 2


def test_clip_junction_disabled():
    a, b = _clip("a"), _clip("b")
    xml = _build([a, b], disabled=[a.id])
    assert "<transition " not in xml
    assert xml.count('duration="25000/2500s"') == 2  # untrimmed, full 250f each


def test_master_switch_off_suppresses_internal():
    clip = _clip("a", cuts=[_cut(4.0, 5.0, transition=True)])
    xml = _build([clip], transitions=False)
    assert "<transition " not in xml


def test_short_handles_skip_transition():
    # cut 0.1..0.2 leaves a tiny head interval (0..0.1 = ~2.5f < 12f) → no transition
    clip = _clip("a", cuts=[_cut(0.1, 5.0, transition=True)])
    xml = _build([clip])
    assert "<transition " not in xml
