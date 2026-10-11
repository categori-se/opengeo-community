"""Shared local API test compatibility fixtures."""

import asyncio

import anyio.to_thread
import fastapi.testclient
import pytest

from asgi_test_client import DirectAsgiClient

# Starlette's blocking-portal TestClient hangs before its first request in the
# repository's Python 3.14 environment. All route tests import this replacement
# during collection and exercise the same ASGI application without a helper
# thread. See docs/logbook/versioned-processing-and-portable-history.md.
fastapi.testclient.TestClient = DirectAsgiClient


@pytest.fixture(autouse=True)
def inline_sync_dependencies(monkeypatch: pytest.MonkeyPatch) -> None:
    """Execute FastAPI sync dependencies inline in the direct ASGI event loop."""

    async def run_sync(function, *args, **kwargs):
        del kwargs
        return function(*args)

    async def to_thread(function, *args, **kwargs):
        return function(*args, **kwargs)

    monkeypatch.setattr(anyio.to_thread, "run_sync", run_sync)
    monkeypatch.setattr(asyncio, "to_thread", to_thread)
