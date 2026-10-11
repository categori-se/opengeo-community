from typing import Annotated

from fastapi import APIRouter, Depends

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session
from opengeo_api.processing_tools import ProcessingRegistryResponse, processing_registry

router = APIRouter(prefix="/processing", tags=["processing"])


@router.get("/tools", response_model=ProcessingRegistryResponse)
async def list_processing_tools(
    session: Annotated[AuthSession, Depends(current_session)],
) -> ProcessingRegistryResponse:
    del session
    return processing_registry()
