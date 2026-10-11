import asyncio
import re

from fastapi.testclient import TestClient

from opengeo_api.app import create_app
from opengeo_api.config import Settings


class PassingProbe:
    def __init__(self) -> None:
        self.calls = 0

    async def check(self) -> None:
        self.calls += 1


class FailingProbe:
    async def check(self) -> None:
        raise RuntimeError("credential=must-never-reach-the-response")


class SlowProbe:
    async def check(self) -> None:
        await asyncio.sleep(1)


def test_liveness_does_not_depend_on_database() -> None:
    probe = PassingProbe()
    client = TestClient(create_app(Settings(env="test"), probe))

    response = client.get("/health/live")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "opengeo-api",
        "version": "0.1.0",
    }
    assert probe.calls == 0


def test_readiness_reports_database_success() -> None:
    probe = PassingProbe()
    client = TestClient(create_app(Settings(env="test"), probe))

    response = client.get("/health/ready")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "checks": {"database": "ok"}}
    assert probe.calls == 1


def test_readiness_failure_is_sanitized() -> None:
    client = TestClient(create_app(Settings(env="test"), FailingProbe()))

    response = client.get("/health/ready")

    assert response.status_code == 503
    assert response.json() == {
        "status": "not_ready",
        "checks": {"database": "unavailable"},
    }
    assert "credential" not in response.text


def test_readiness_probe_has_a_hard_timeout() -> None:
    settings = Settings(env="test", readiness_timeout_seconds=0.01)
    client = TestClient(create_app(settings, SlowProbe()))

    response = client.get("/health/ready")

    assert response.status_code == 503
    assert response.json()["checks"] == {"database": "unavailable"}


def test_safe_request_id_is_propagated() -> None:
    client = TestClient(create_app(Settings(env="test"), PassingProbe()))

    response = client.get("/health/live", headers={"X-Request-ID": "edge-123/attempt:2"})

    assert response.headers["X-Request-ID"] == "edge-123/attempt:2"


def test_unsafe_request_id_is_replaced() -> None:
    client = TestClient(create_app(Settings(env="test"), PassingProbe()))

    response = client.get("/health/live", headers={"X-Request-ID": "bad\nlog-entry"})

    assert re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
        response.headers["X-Request-ID"],
    )


def test_docs_are_opt_in() -> None:
    hidden = TestClient(create_app(Settings(env="test"), PassingProbe()))
    visible = TestClient(create_app(Settings(env="test", expose_docs=True), PassingProbe()))

    assert hidden.get("/openapi.json").status_code == 404
    assert visible.get("/openapi.json").status_code == 200
