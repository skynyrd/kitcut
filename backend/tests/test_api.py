import pytest
from fastapi.testclient import TestClient
from app.main import app


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
