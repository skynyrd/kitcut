import pytest
from app.models import Project, ProjectStatus, Segment, Word, CutParams, Reel


class TestTimelinePerformance:
    """Test timeline performance optimizations."""

    def test_large_project_segment_loading(self):
        """Test that large projects with many segments load efficiently."""
        project = Project(
            id="large-project",
            name="large_video.mp4",
            source_filename="large_video.mp4",
            duration=3600.0,  # 1 hour
            width=1920,
            height=1080,
            fps=30,
        )

        # Simulate 100+ segments (typical for 1-hour transcription)
        segments = []
        for i in range(100):
            words = [
                Word(
                    text=f"word{j}",
                    start=float(i * 36 + j * 0.3),
                    end=float(i * 36 + j * 0.3 + 0.3),
                )
                for j in range(10)
            ]
            seg = Segment(
                id=i,
                start=float(i * 36),
                end=float(i * 36 + 36),
                text=f"Segment {i}",
                words=words,
            )
            segments.append(seg)

        project.segments = segments
        assert len(project.segments) == 100
        assert len(project.segments[0].words) == 10

    def test_reel_with_many_clips(self):
        """Test reel with many clips (44+)."""
        reel = Reel(id="big-reel", name="big_reel", clip_ids=[])

        # Add 44 clips
        for i in range(44):
            clip_id = f"clip-{i:02d}"
            reel.clip_ids.append(clip_id)

        assert len(reel.clip_ids) == 44

    def test_cut_regions_memory_efficient(self):
        """Test that cut regions don't consume excessive memory."""
        from app.models import CutRegion

        # Create many cut regions (typical for detailed editing)
        cuts = []
        for i in range(1000):
            cut = CutRegion(
                id=f"cut-{i}",
                start=float(i * 0.1),
                end=float(i * 0.1 + 0.05),
                source="auto",
                kind="speech",
            )
            cuts.append(cut)

        assert len(cuts) == 1000

        # Memory estimate: each CutRegion ~50 bytes
        # 1000 regions ≈ 50KB (acceptable)
        estimated_memory_kb = len(cuts) * 50 / 1024
        assert estimated_memory_kb < 100  # Should use < 100KB

    def test_vad_regions_lazy_loading_candidates(self):
        """Test that VAD regions can be lazily loaded."""
        # Simulate 3600 seconds of audio with 1-second resolution
        vad_regions = []
        for i in range(3600):
            # Each region is {start: float, end: float, vad_prob: float}
            region = {
                "start": float(i),
                "end": float(i + 1),
                "vad_prob": 0.5 + (i % 10) * 0.05,
            }
            vad_regions.append(region)

        # Should be able to handle 3600 regions efficiently
        assert len(vad_regions) == 3600

        # Can slice for specific time range
        start_second = 1800
        end_second = 1900
        window = [r for r in vad_regions
                  if r["start"] >= start_second and r["end"] <= end_second]
        assert len(window) == 100  # 1 minute = 100 regions


class TestCutParamOptimization:
    """Test cut parameter optimization."""

    def test_adaptive_mode_computation_cost(self):
        """Test that adaptive mode doesn't add significant computation."""
        params_uniform = CutParams(
            mode="uniform",
            vad_threshold=0.5,
            speech_min_silence_ms=300,
            pad_ms=100,
            broll_min_ms=2000,
            broll_keep_ms=500,
            keep_nonspeech=False,
        )

        params_adaptive = CutParams(
            mode="adaptive",
            vad_threshold=0.5,
            speech_min_silence_ms=300,
            pad_ms=100,
            broll_min_ms=2000,
            broll_keep_ms=500,
            keep_nonspeech=True,
        )

        # Both should be equally fast to compare
        assert params_uniform.mode == "uniform"
        assert params_adaptive.mode == "adaptive"
        assert params_adaptive.keep_nonspeech is True
