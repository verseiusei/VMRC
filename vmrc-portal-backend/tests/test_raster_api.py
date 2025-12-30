# File: tests/test_raster_api.py

"""
Basic smoke tests for the raster API.

These use FastAPI's TestClient. To run:
    pytest -q
"""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_endpoint():
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_list_rasters_empty():
    resp = client.get("/api/v1/rasters/")
    assert resp.status_code == 200
    data = resp.json()
    assert "items" in data
    assert "total" in data
    assert data["items"] == []
    assert data["total"] == 0
