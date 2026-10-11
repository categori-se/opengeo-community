"""OpenGeo API runtime."""

from typing import Any

__all__ = ["create_app"]


def __getattr__(name: str) -> Any:
    if name != "create_app":
        raise AttributeError(name)
    from opengeo_api.app import create_app

    return create_app
