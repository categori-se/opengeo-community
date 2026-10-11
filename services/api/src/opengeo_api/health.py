import asyncio
import logging
from typing import Annotated, Literal, cast

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from opengeo_api.config import Settings
from opengeo_api.readiness import ReadinessProbe
from opengeo_api.version import __version__

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/health", tags=["health"])


class LiveHealth(BaseModel):
    status: Literal["ok"] = "ok"
    service: str
    version: str


class ReadyHealth(BaseModel):
    status: Literal["ok", "not_ready"]
    checks: dict[str, Literal["ok", "unavailable"]]


def settings_from_request(request: Request) -> Settings:
    return cast(Settings, request.app.state.settings)


def probe_from_request(request: Request) -> ReadinessProbe:
    return cast(ReadinessProbe, request.app.state.readiness_probe)


@router.get("/live", response_model=LiveHealth)
async def live(
    settings: Annotated[Settings, Depends(settings_from_request)],
) -> LiveHealth:
    return LiveHealth(service=settings.service_name, version=__version__)


@router.get(
    "/ready",
    response_model=ReadyHealth,
    responses={503: {"model": ReadyHealth, "description": "A required dependency is unavailable."}},
)
async def ready(
    settings: Annotated[Settings, Depends(settings_from_request)],
    probe: Annotated[ReadinessProbe, Depends(probe_from_request)],
) -> ReadyHealth | JSONResponse:
    try:
        async with asyncio.timeout(settings.readiness_timeout_seconds):
            await probe.check()
    except Exception as error:
        logger.warning(
            "readiness.failed",
            extra={"check": "database", "error_type": type(error).__name__},
        )
        payload = ReadyHealth(status="not_ready", checks={"database": "unavailable"})
        return JSONResponse(status_code=503, content=payload.model_dump())

    return ReadyHealth(status="ok", checks={"database": "ok"})
