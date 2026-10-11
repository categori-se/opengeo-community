import logging
from collections.abc import Awaitable
from typing import Annotated, Any, Literal, Self, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session
from opengeo_api.feature_routes import GeoJsonFeatureRequest, _feature_document
from opengeo_api.features import (
    FeatureDraft,
    FeatureInvalid,
    feature_field_document,
    normalize_geometry,
)
from opengeo_api.field_capture import (
    FieldCaptureAccessDenied,
    FieldCaptureConflict,
    FieldCaptureInvalid,
    FieldCaptureNotFound,
    FieldCaptureRepository,
    FieldCaptureStoreUnavailable,
    FieldForm,
    FieldReviewDecision,
    FieldReviewResult,
    FieldSubmission,
    FieldSubmissionReceipt,
    FieldSubmissionState,
    PostgresFieldCaptureRepository,
)
from opengeo_api.logging import get_request_id
from opengeo_api.resource_routes import tenant_context

logger = logging.getLogger(__name__)
router = APIRouter(tags=["offline field capture"])
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Instructions = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)
]
ReviewMessage = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)
]


class RequestModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class FieldFormRequest(RequestModel):
    title: Title
    instructions: Instructions | None = None


class FieldFormVersionRequest(FieldFormRequest):
    expected_version: int = Field(ge=1)


class FieldSubmissionRequest(RequestModel):
    client_submission_id: UUID
    supersedes_submission_id: UUID | None = None
    operation: Literal["create", "update"] = "create"
    target_feature_id: UUID | None = None
    target_feature_version: int | None = Field(default=None, ge=1)
    feature: GeoJsonFeatureRequest

    @model_validator(mode="after")
    def validate_operation_shape(self) -> Self:
        if self.operation == "create":
            if self.target_feature_id is not None or self.target_feature_version is not None:
                raise ValueError("create submissions cannot declare a target feature")
        elif self.target_feature_id is None or self.target_feature_version is None:
            raise ValueError("update submissions require a target feature and base version")
        return self


class FieldReviewRequest(RequestModel):
    expected_version: int = Field(ge=1)
    decision: FieldReviewDecision
    message: ReviewMessage | None = None


def repository_from_request(request: Request) -> FieldCaptureRepository:
    repository = request.app.state.field_capture_repository
    if not isinstance(repository, PostgresFieldCaptureRepository):
        return cast(FieldCaptureRepository, repository)
    return repository


async def execute_field_capture[ResponseT](operation: Awaitable[ResponseT]) -> ResponseT:
    try:
        return await operation
    except FieldCaptureAccessDenied as error:
        raise HTTPException(status_code=403, detail="action_forbidden") from error
    except FieldCaptureNotFound as error:
        raise HTTPException(status_code=404, detail=f"{error.resource}_not_found") from error
    except FieldCaptureConflict as error:
        detail: dict[str, Any] = {"code": error.code}
        if error.current_version is not None:
            detail["current_version"] = error.current_version
        raise HTTPException(status_code=409, detail=detail) from error
    except FieldCaptureInvalid as error:
        raise HTTPException(
            status_code=422,
            detail={"code": "field_capture_validation_failed", "message": str(error)},
        ) from error
    except FieldCaptureStoreUnavailable as error:
        logger.error("field_capture.store_unavailable", extra={"error_type": type(error).__name__})
        raise HTTPException(status_code=503, detail="field_capture_store_unavailable") from error


@router.post(
    "/projects/{project_id}/datasets/{dataset_id}/field-forms",
    status_code=status.HTTP_201_CREATED,
)
async def create_field_form(
    project_id: UUID,
    dataset_id: UUID,
    payload: FieldFormRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FieldCaptureRepository, Depends(repository_from_request)],
) -> JSONResponse:
    form = await execute_field_capture(
        repository.create_form(
            tenant_context(session),
            project_id,
            dataset_id,
            payload.title,
            payload.instructions,
            get_request_id(),
        )
    )
    return JSONResponse(_form_document(form), status_code=status.HTTP_201_CREATED)


@router.get("/projects/{project_id}/datasets/{dataset_id}/field-forms")
async def list_field_forms(
    project_id: UUID,
    dataset_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FieldCaptureRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    forms = await execute_field_capture(
        repository.list_forms(tenant_context(session), project_id, dataset_id)
    )
    return {"forms": [_form_document(form) for form in forms], "number_returned": len(forms)}


@router.post(
    "/projects/{project_id}/datasets/{dataset_id}/field-forms/{form_id}/versions",
    status_code=status.HTTP_201_CREATED,
)
async def create_field_form_version(
    project_id: UUID,
    dataset_id: UUID,
    form_id: UUID,
    payload: FieldFormVersionRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FieldCaptureRepository, Depends(repository_from_request)],
) -> JSONResponse:
    form = await execute_field_capture(
        repository.create_form_version(
            tenant_context(session),
            project_id,
            dataset_id,
            form_id,
            payload.expected_version,
            payload.title,
            payload.instructions,
            get_request_id(),
        )
    )
    return JSONResponse(_form_document(form), status_code=status.HTTP_201_CREATED)


@router.post(
    "/projects/{project_id}/datasets/{dataset_id}/field-forms/{form_id}/versions/{form_version}/submissions",
    status_code=status.HTTP_201_CREATED,
)
async def create_field_submission(
    project_id: UUID,
    dataset_id: UUID,
    form_id: UUID,
    form_version: int,
    payload: FieldSubmissionRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FieldCaptureRepository, Depends(repository_from_request)],
) -> JSONResponse:
    if form_version < 1:
        raise HTTPException(status_code=422, detail="field_form_version_invalid")
    feature = _submission_draft(payload)
    receipt = await execute_field_capture(
        repository.create_submission(
            tenant_context(session),
            project_id,
            dataset_id,
            form_id,
            form_version,
            payload.client_submission_id,
            payload.supersedes_submission_id,
            payload.operation,
            payload.target_feature_id,
            payload.target_feature_version,
            feature,
            get_request_id(),
        )
    )
    return JSONResponse(
        _receipt_document(receipt),
        status_code=status.HTTP_201_CREATED if receipt.created else status.HTTP_200_OK,
    )


@router.get("/projects/{project_id}/datasets/{dataset_id}/field-submissions")
async def list_field_submissions(
    project_id: UUID,
    dataset_id: UUID,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FieldCaptureRepository, Depends(repository_from_request)],
    state: FieldSubmissionState | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
) -> dict[str, Any]:
    submissions = await execute_field_capture(
        repository.list_submissions(
            tenant_context(session),
            project_id,
            dataset_id,
            state=state,
            limit=limit,
            offset=offset,
        )
    )
    return {
        "submissions": [_submission_document(item) for item in submissions],
        "number_returned": len(submissions),
        "limit": limit,
        "offset": offset,
    }


@router.post(
    "/projects/{project_id}/datasets/{dataset_id}/field-submissions/{submission_id}/review"
)
async def review_field_submission(
    project_id: UUID,
    dataset_id: UUID,
    submission_id: UUID,
    payload: FieldReviewRequest,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FieldCaptureRepository, Depends(repository_from_request)],
) -> dict[str, Any]:
    result = await execute_field_capture(
        repository.review_submission(
            tenant_context(session),
            project_id,
            dataset_id,
            submission_id,
            payload.expected_version,
            payload.decision,
            payload.message,
            get_request_id(),
        )
    )
    return _review_document(result)


def _submission_draft(payload: FieldSubmissionRequest) -> FeatureDraft:
    expected_feature_id = (
        payload.client_submission_id if payload.operation == "create" else payload.target_feature_id
    )
    assert expected_feature_id is not None
    if payload.feature.id is not None and payload.feature.id != expected_feature_id:
        raise HTTPException(status_code=422, detail="field_submission_feature_id_mismatch")
    try:
        geometry_type, geometry, bbox = normalize_geometry(payload.feature.geometry)
    except FeatureInvalid as error:
        raise HTTPException(
            status_code=422,
            detail={"code": "field_capture_validation_failed", "message": str(error)},
        ) from error
    return FeatureDraft(
        expected_feature_id,
        geometry_type,
        geometry,
        bbox,
        dict(payload.feature.properties),
    )


def _form_document(form: FieldForm) -> dict[str, Any]:
    return {
        "id": str(form.form_id),
        "dataset_id": str(form.dataset_id),
        "version": form.version_number,
        "title": form.title,
        "instructions": form.instructions,
        "collection_generation": form.collection_generation,
        "geometry_type": form.geometry_type,
        "fields": [feature_field_document(field) for field in form.fields],
        "created_by": str(form.created_by),
        "created_at": form.created_at.isoformat(),
        "updated_by": str(form.updated_by),
        "updated_at": form.updated_at.isoformat(),
    }


def _submission_document(submission: FieldSubmission) -> dict[str, Any]:
    return {
        "id": str(submission.submission_id),
        "dataset_id": str(submission.dataset_id),
        "form_id": str(submission.form_id),
        "form_version": submission.form_version,
        "supersedes_submission_id": (
            str(submission.supersedes_submission_id)
            if submission.supersedes_submission_id is not None
            else None
        ),
        "operation": submission.operation,
        "target_feature_id": (
            str(submission.target_feature_id) if submission.target_feature_id is not None else None
        ),
        "target_feature_version": submission.target_feature_version,
        "payload_sha256": submission.payload_sha256,
        "feature": {
            "type": "Feature",
            "id": str(
                submission.submission_id
                if submission.operation == "create"
                else submission.target_feature_id
            ),
            "geometry": submission.geometry,
            "properties": submission.properties,
        },
        "state": submission.state,
        "review_version": submission.review_version,
        "submitted_by": str(submission.submitted_by),
        "submitted_at": submission.submitted_at.isoformat(),
        "reviewed_by": str(submission.reviewed_by) if submission.reviewed_by else None,
        "reviewed_at": submission.reviewed_at.isoformat() if submission.reviewed_at else None,
        "review_message": submission.review_message,
        "promoted_feature_id": (
            str(submission.promoted_feature_id)
            if submission.promoted_feature_id is not None
            else None
        ),
    }


def _receipt_document(receipt: FieldSubmissionReceipt) -> dict[str, Any]:
    return {"created": receipt.created, "submission": _submission_document(receipt.submission)}


def _review_document(result: FieldReviewResult) -> dict[str, Any]:
    promoted = None
    if result.promotion is not None:
        promoted = _feature_document(result.promotion.feature)
        promoted["opengeo:collectionGeneration"] = result.promotion.collection.generation
    return {"submission": _submission_document(result.submission), "promoted_feature": promoted}
