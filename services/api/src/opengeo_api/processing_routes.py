from typing import Annotated

from fastapi import APIRouter, Depends, Request

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session
from opengeo_api.data_preservation import (
    DataPreservationRepository,
    DataPreservationStoreUnavailable,
)
from opengeo_api.data_preservation_routes import repository_from_request, tenant_context
from opengeo_api.processing_tools import ProcessingRegistryResponse, processing_registry

router = APIRouter(prefix="/processing", tags=["processing"])


@router.get("/tools", response_model=ProcessingRegistryResponse)
async def list_processing_tools(
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[DataPreservationRepository, Depends(repository_from_request)],
) -> ProcessingRegistryResponse:
    admission: dict[str, bool | str] = {"ready": False, "reason": "runtime_not_configured"}
    if request.app.state.settings.pmtiles_derivative_dispatch_configured:
        if session.selected_membership is None:
            admission = {"ready": False, "reason": "runtime_status_unavailable"}
        else:
            try:
                admission = await repository.pmtiles_admission_status(tenant_context(session))
            except DataPreservationStoreUnavailable:
                admission = {"ready": False, "reason": "runtime_status_unavailable"}
    return processing_registry(
        pmtiles_input_formats=frozenset(
            request.app.state.settings.pmtiles_input_formats.split(",")
        ),
        pmtiles_admission=admission,
    )
