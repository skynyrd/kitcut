import pytest
from fastapi.testclient import TestClient
from app.main import app
from app import storage
from app.models import Project


@pytest.fixture
def client():
    """Create a test client for the FastAPI app."""
    return TestClient(app)


class TestHealth:
    """Test health endpoint."""

    def test_health_check(self, client):
        """Test GET /api/health returns OK status."""
        response = client.get("/api/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "ffmpeg" in data
        assert "media_dir" in data
        assert "model_dir" in data


class TestProjects:
    """Test project endpoints."""

    def test_list_projects_empty(self, client):
        """Test listing projects returns a list."""
        response = client.get("/api/projects")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)


class TestReels:
    """Test reel endpoints."""

    def test_create_reel(self, client):
        """Test creating a reel."""
        response = client.post("/api/reels", json={"name": "test_reel"})
        assert response.status_code == 200
        data = response.json()
        assert "reel" in data
        assert data["reel"]["name"] == "test_reel"
        assert "clip_ids" in data["reel"]

    def test_list_reels(self, client):
        """Test listing reels."""
        response = client.get("/api/reels")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)


class TestTransitions:
    """Per-seam transition flags: cut-join (on CutRegion) + clip-junction (on Reel)."""

    def test_cut_transition_roundtrips(self, client):
        proj = Project(
            id="t_cut_trans", name="t", source_filename="t.mov", duration=10.0
        )
        storage.save_project(proj)
        try:
            r = client.put(
                f"/api/projects/{proj.id}/cuts",
                json=[
                    {"id": "c1", "start": 4.0, "end": 5.0,
                     "source": "manual", "kind": "speech", "transition": True}
                ],
            )
            assert r.status_code == 200
            cuts = r.json()["cuts"]
            assert len(cuts) == 1 and cuts[0]["transition"] is True
        finally:
            storage.delete_project(proj.id)

    def test_junction_transition_toggle(self, client):
        rid = client.post("/api/reels", json={"name": "jt"}).json()["reel"]["id"]
        # membership is validated against clip_ids, not project existence — inject ids
        reel = storage.load_reel(rid)
        reel.clip_ids = ["clipA", "clipB"]
        storage.save_reel(reel)
        try:
            base = f"/api/reels/{rid}/junction-transitions"
            r = client.put(base, json={"left_clip_id": "clipA", "enabled": False})
            assert r.status_code == 200
            assert r.json()["reel"]["disabled_junctions"] == ["clipA"]
            # re-enable removes it again
            r = client.put(base, json={"left_clip_id": "clipA", "enabled": True})
            assert r.json()["reel"]["disabled_junctions"] == []
            # a clip not in the reel is rejected
            r = client.put(base, json={"left_clip_id": "nope", "enabled": False})
            assert r.status_code == 404
        finally:
            storage.delete_reel(rid)
