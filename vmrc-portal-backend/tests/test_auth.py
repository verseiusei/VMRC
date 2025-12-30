# File: tests/test_auth.py

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_login_not_implemented():
    resp = client.post("/api/v1/auth/login", json={"email": "foo@bar.com", "password": "test"})
    assert resp.status_code == 501
    assert "not implemented" in resp.json()["detail"].lower()
