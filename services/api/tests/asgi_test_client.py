"""Synchronous, thread-free ASGI test client for the local Python 3.14 suite."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any, Self

import httpx2 as httpx
from fastapi import FastAPI


class DirectAsgiClient:
    """Exercise an ASGI app directly without Starlette's blocking portal thread."""

    __test__ = False

    def __init__(
        self,
        app: FastAPI,
        base_url: str = "http://testserver",
        raise_server_exceptions: bool = True,
        root_path: str = "",
        backend: str = "asyncio",
        backend_options: dict[str, Any] | None = None,
        cookies: httpx._types.CookieTypes | None = None,
        headers: Mapping[str, str] | None = None,
        follow_redirects: bool = True,
        **_: Any,
    ) -> None:
        del backend, backend_options
        self.app = app
        self.base_url = base_url
        self.raise_server_exceptions = raise_server_exceptions
        self.root_path = root_path
        self.follow_redirects = follow_redirects
        self.cookies = httpx.Cookies(cookies)
        self.headers = dict(headers or {})

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def request(
        self,
        method: str,
        url: str,
        *,
        follow_redirects: bool | None = None,
        **kwargs: Any,
    ) -> httpx.Response:
        async def invoke() -> httpx.Response:
            transport = httpx.ASGITransport(
                app=self.app,
                raise_app_exceptions=self.raise_server_exceptions,
                root_path=self.root_path,
            )
            async with httpx.AsyncClient(
                transport=transport,
                base_url=self.base_url,
                headers=self.headers,
                cookies=self.cookies,
                follow_redirects=self.follow_redirects,
            ) as client:
                return await client.request(
                    method,
                    url,
                    follow_redirects=follow_redirects,
                    **kwargs,
                )

        response = asyncio.run(invoke())
        self.cookies.update(response.cookies)
        return response

    def get(self, url: str, **kwargs: Any) -> httpx.Response:
        return self.request("GET", url, **kwargs)

    def options(self, url: str, **kwargs: Any) -> httpx.Response:
        return self.request("OPTIONS", url, **kwargs)

    def head(self, url: str, **kwargs: Any) -> httpx.Response:
        return self.request("HEAD", url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> httpx.Response:
        return self.request("POST", url, **kwargs)

    def put(self, url: str, **kwargs: Any) -> httpx.Response:
        return self.request("PUT", url, **kwargs)

    def patch(self, url: str, **kwargs: Any) -> httpx.Response:
        return self.request("PATCH", url, **kwargs)

    def delete(self, url: str, **kwargs: Any) -> httpx.Response:
        return self.request("DELETE", url, **kwargs)
