import pytest
from app.models import Project, ProjectStatus, CutParams, CutRegion, Segment, Word


class TestProject:
    """Test Project model."""

    def test_project_creation(self):
        """Test creating a project with valid data."""
        project = Project(
            id="test123",
            name="test_video.mp4",
            source_filename="test_video.mp4",
            reel_id=None,
            duration=100.0,
            width=1920,
            height=1080,
            fps=30,
        )
        assert project.id == "test123"
        assert project.name == "test_video.mp4"
        assert project.status == ProjectStatus.created
        assert project.duration == 100.0

    def test_project_status_transition(self):
        """Test project status changes."""
        project = Project(
            id="test123",
            name="test.mp4",
            source_filename="test.mp4",
            duration=10.0,
            width=1920,
            height=1080,
            fps=30,
        )
        assert project.status == ProjectStatus.created

        project.status = ProjectStatus.transcribing
        assert project.status == ProjectStatus.transcribing

        project.status = ProjectStatus.transcribed
        assert project.status == ProjectStatus.transcribed


class TestCutParams:
    """Test CutParams model."""

    def test_default_cut_params(self):
        """Test creating default cut parameters."""
        params = CutParams(
            mode="uniform",
            vad_threshold=0.5,
            speech_min_silence_ms=300,
            pad_ms=100,
            broll_min_ms=2000,
            broll_keep_ms=500,
            keep_nonspeech=False,
        )
        assert params.mode == "uniform"
        assert params.vad_threshold == 0.5

    def test_adaptive_mode(self):
        """Test adaptive mode params."""
        params = CutParams(
            mode="adaptive",
            vad_threshold=0.6,
            speech_min_silence_ms=500,
            pad_ms=50,
            broll_min_ms=3000,
            broll_keep_ms=1000,
            keep_nonspeech=True,
        )
        assert params.mode == "adaptive"
        assert params.keep_nonspeech is True


class TestSegment:
    """Test Segment model."""

    def test_segment_creation(self):
        """Test creating a segment with words."""
        words = [
            Word(text="hello", start=0.0, end=0.5, removed=False),
            Word(text="world", start=0.5, end=1.0, removed=False),
        ]
        segment = Segment(
            id=0, start=0.0, end=1.0, text="hello world", words=words
        )
        assert segment.id == 0
        assert len(segment.words) == 2
        assert segment.text == "hello world"

    def test_segment_with_removed_words(self):
        """Test segment with removed words."""
        words = [
            Word(text="keep", start=0.0, end=0.5, removed=False),
            Word(text="remove", start=0.5, end=1.0, removed=True),
        ]
        segment = Segment(
            id=0, start=0.0, end=1.0, text="keep remove", words=words
        )
        active_words = [w for w in segment.words if not w.removed]
        assert len(active_words) == 1
        assert active_words[0].text == "keep"
