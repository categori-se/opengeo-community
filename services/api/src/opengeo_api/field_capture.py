import hashlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from datetime import datetime
from typing import Any, Literal, Protocol, TypeVar, cast
from uuid import UUID, uuid4

from psycopg.types.json import Jsonb

from opengeo_api.authorization import Action, AuthorizationDenied, Roles, authorize
from opengeo_api.features import (
    FeatureAccessDenied,
    FeatureConflict,
    FeatureDraft,
    FeatureField,
    FeatureInvalid,
    FeatureMutation,
    FeatureNotFound,
    FeatureStoreUnavailable,
    GeometryType,
    PostgresFeatureRepository,
    _canonical_json,
    _fields_from_schema,
    _require_geometry_type,
    _schema_definition,
    authorize_feature_attachments,
    normalize_properties,
)
from opengeo_api.tenant_database import (
    TenantContext,
    TenantDatabaseConflict,
    TenantDatabaseUnavailable,
    TenantTransaction,
    TenantTransactionExecutor,
)

FieldSubmissionState = Literal[
    "submitted",
    "in_review",
    "changes_requested",
    "rejected",
    "accepted",
]
FieldReviewDecision = Literal["start_review", "request_changes", "reject", "accept"]
FieldSubmissionOperation = Literal["create", "update"]


class FieldCaptureStoreUnavailable(RuntimeError):
    pass


class FieldCaptureAccessDenied(RuntimeError):
    pass


class FieldCaptureNotFound(RuntimeError):
    def __init__(self, resource: str) -> None:
        self.resource = resource
        super().__init__(resource)


class FieldCaptureConflict(RuntimeError):
    def __init__(self, code: str, current_version: int | None = None) -> None:
        self.code = code
        self.current_version = current_version
        super().__init__(code)


class FieldCaptureInvalid(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class FieldForm:
    form_id: UUID
    dataset_id: UUID
    version_number: int
    title: str
    instructions: str | None
    collection_generation: int
    geometry_type: GeometryType
    fields: tuple[FeatureField, ...]
    created_by: UUID
    created_at: datetime
    updated_by: UUID
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class FieldSubmission:
    submission_id: UUID
    dataset_id: UUID
    form_id: UUID
    form_version: int
    supersedes_submission_id: UUID | None
    operation: FieldSubmissionOperation
    target_feature_id: UUID | None
    target_feature_version: int | None
    payload_sha256: str
    geometry_type: GeometryType
    geometry: dict[str, Any]
    properties: dict[str, Any]
    state: FieldSubmissionState
    review_version: int
    submitted_by: UUID
    submitted_at: datetime
    reviewed_by: UUID | None
    reviewed_at: datetime | None
    review_message: str | None
    promoted_feature_id: UUID | None


@dataclass(frozen=True, slots=True)
class FieldSubmissionReceipt:
    submission: FieldSubmission
    created: bool


@dataclass(frozen=True, slots=True)
class FieldReviewResult:
    submission: FieldSubmission
    promotion: FeatureMutation | None


class FieldCaptureRepository(Protocol):
    async def create_form(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        title: str,
        instructions: str | None,
        request_id: str,
    ) -> FieldForm: ...

    async def create_form_version(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        form_id: UUID,
        expected_version: int,
        title: str,
        instructions: str | None,
        request_id: str,
    ) -> FieldForm: ...

    async def list_forms(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
    ) -> tuple[FieldForm, ...]: ...

    async def create_submission(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        form_id: UUID,
        form_version: int,
        submission_id: UUID,
        supersedes_submission_id: UUID | None,
        operation: FieldSubmissionOperation,
        target_feature_id: UUID | None,
        target_feature_version: int | None,
        feature: FeatureDraft,
        request_id: str,
    ) -> FieldSubmissionReceipt: ...

    async def list_submissions(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        *,
        state: FieldSubmissionState | None,
        limit: int,
        offset: int,
    ) -> tuple[FieldSubmission, ...]: ...

    async def review_submission(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        submission_id: UUID,
        expected_version: int,
        decision: FieldReviewDecision,
        message: str | None,
        request_id: str,
    ) -> FieldReviewResult: ...


ResultT = TypeVar("ResultT")


class PostgresFieldCaptureRepository:
    def __init__(self, executor: TenantTransactionExecutor) -> None:
        self._executor = executor

    async def _run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
    ) -> ResultT:
        try:
            return await self._executor.run(context, operation)
        except FeatureAccessDenied as error:
            raise FieldCaptureAccessDenied("action forbidden") from error
        except FeatureNotFound as error:
            raise FieldCaptureNotFound(error.resource) from error
        except FeatureConflict as error:
            raise FieldCaptureConflict(error.code, error.current_version) from error
        except FeatureStoreUnavailable as error:
            raise FieldCaptureStoreUnavailable("field capture dependency failed") from error
        except TenantDatabaseConflict as error:
            raise FieldCaptureConflict("field_capture_store_conflict") from error
        except TenantDatabaseUnavailable as error:
            raise FieldCaptureStoreUnavailable("field capture store operation failed") from error

    async def create_form(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        title: str,
        instructions: str | None,
        request_id: str,
    ) -> FieldForm:
        async def operation(transaction: TenantTransaction) -> FieldForm:
            scope = await self._scope(transaction, context, project_id, dataset_id)
            self._require(Action.FIELD_FORM_MANAGE, scope.roles)
            PostgresFeatureRepository._require_editable_dataset(scope)
            collection = await PostgresFeatureRepository._collection(
                transaction, context, dataset_id
            )
            form_id = uuid4()
            head_row = await transaction.fetch_one(
                """
                INSERT INTO app.field_forms
                  (id, organization_id, dataset_id, current_version, created_by, updated_by)
                VALUES (%s, %s, %s, 1, %s, %s)
                RETURNING created_at, updated_at
                """,
                (
                    form_id,
                    context.organization_id,
                    dataset_id,
                    context.user_id,
                    context.user_id,
                ),
            )
            assert head_row is not None
            await self._insert_form_version(
                transaction,
                context,
                dataset_id,
                form_id,
                1,
                title,
                instructions,
                collection.generation,
                collection.geometry_type,
                collection.fields,
            )
            await self._activity(
                transaction,
                context,
                project_id,
                "field.form.created",
                "field_form",
                form_id,
                request_id,
                {"dataset_id": str(dataset_id), "version": 1},
            )
            return FieldForm(
                form_id,
                dataset_id,
                1,
                title,
                instructions,
                collection.generation,
                collection.geometry_type,
                collection.fields,
                context.user_id,
                cast(datetime, head_row[0]),
                context.user_id,
                cast(datetime, head_row[1]),
            )

        return await self._run(context, operation)

    async def create_form_version(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        form_id: UUID,
        expected_version: int,
        title: str,
        instructions: str | None,
        request_id: str,
    ) -> FieldForm:
        async def operation(transaction: TenantTransaction) -> FieldForm:
            scope = await self._scope(transaction, context, project_id, dataset_id)
            self._require(Action.FIELD_FORM_MANAGE, scope.roles)
            PostgresFeatureRepository._require_editable_dataset(scope)
            collection = await PostgresFeatureRepository._collection(
                transaction, context, dataset_id
            )
            head = await transaction.fetch_one(
                """
                SELECT current_version, created_by, created_at
                FROM app.field_forms
                WHERE organization_id = %s AND dataset_id = %s AND id = %s
                FOR UPDATE
                """,
                (context.organization_id, dataset_id, form_id),
            )
            if head is None:
                raise FieldCaptureNotFound("field_form")
            current_version = cast(int, head[0])
            if current_version != expected_version:
                raise FieldCaptureConflict("field_form_version_conflict", current_version)
            next_version = expected_version + 1
            await self._insert_form_version(
                transaction,
                context,
                dataset_id,
                form_id,
                next_version,
                title,
                instructions,
                collection.generation,
                collection.geometry_type,
                collection.fields,
            )
            updated = await transaction.fetch_one(
                """
                UPDATE app.field_forms
                SET current_version = %s, updated_by = %s
                WHERE organization_id = %s AND dataset_id = %s AND id = %s
                  AND current_version = %s
                RETURNING updated_at
                """,
                (
                    next_version,
                    context.user_id,
                    context.organization_id,
                    dataset_id,
                    form_id,
                    expected_version,
                ),
            )
            if updated is None:
                raise FieldCaptureConflict("field_form_version_conflict", current_version)
            await self._activity(
                transaction,
                context,
                project_id,
                "field.form.version_created",
                "field_form",
                form_id,
                request_id,
                {"dataset_id": str(dataset_id), "version": next_version},
            )
            return FieldForm(
                form_id,
                dataset_id,
                next_version,
                title,
                instructions,
                collection.generation,
                collection.geometry_type,
                collection.fields,
                cast(UUID, head[1]),
                cast(datetime, head[2]),
                context.user_id,
                cast(datetime, updated[0]),
            )

        return await self._run(context, operation)

    async def list_forms(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
    ) -> tuple[FieldForm, ...]:
        async def operation(transaction: TenantTransaction) -> tuple[FieldForm, ...]:
            scope = await self._scope(transaction, context, project_id, dataset_id)
            self._require(Action.DATASET_READ, scope.roles)
            await PostgresFeatureRepository._collection(transaction, context, dataset_id)
            rows = await transaction.fetch_all(
                """
                SELECT form.id, form.dataset_id, version.version_number,
                       version.title, version.instructions,
                       version.collection_generation, version.geometry_type::text,
                       version.schema_definition, form.created_by, form.created_at,
                       form.updated_by, form.updated_at
                FROM app.field_forms form
                JOIN app.field_form_versions version
                  ON version.organization_id = form.organization_id
                 AND version.dataset_id = form.dataset_id
                 AND version.form_id = form.id
                 AND version.version_number = form.current_version
                WHERE form.organization_id = %s AND form.dataset_id = %s
                ORDER BY version.title, form.id
                LIMIT 100
                """,
                (context.organization_id, dataset_id),
            )
            return tuple(self._form(row) for row in rows)

        return await self._run(context, operation)

    async def create_submission(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        form_id: UUID,
        form_version: int,
        submission_id: UUID,
        supersedes_submission_id: UUID | None,
        operation: FieldSubmissionOperation,
        target_feature_id: UUID | None,
        target_feature_version: int | None,
        feature: FeatureDraft,
        request_id: str,
    ) -> FieldSubmissionReceipt:
        async def transaction_operation(
            transaction: TenantTransaction,
        ) -> FieldSubmissionReceipt:
            scope = await self._scope(transaction, context, project_id, dataset_id)
            self._require(Action.FIELD_SUBMISSION_CREATE, scope.roles)
            PostgresFeatureRepository._require_editable_dataset(scope)
            form = await self._form_version(transaction, context, dataset_id, form_id, form_version)
            _require_geometry_type(feature, form.geometry_type)
            if operation == "create":
                if target_feature_id is not None or target_feature_version is not None:
                    raise FieldCaptureInvalid("create submissions cannot declare a target feature")
                feature_id = submission_id
            else:
                if target_feature_id is None or target_feature_version is None:
                    raise FieldCaptureInvalid(
                        "update submissions require a target feature and base version"
                    )
                if target_feature_version < 1:
                    raise FieldCaptureInvalid("target feature version must be positive")
                target = await transaction.fetch_one(
                    """
                    SELECT version_number, deleted_at
                    FROM app.dataset_features
                    WHERE organization_id = %s AND dataset_id = %s AND id = %s
                    """,
                    (context.organization_id, dataset_id, target_feature_id),
                )
                if target is None or target[1] is not None:
                    raise FieldCaptureConflict("field_submission_target_unavailable")
                feature_id = target_feature_id
            normalized = replace(
                feature,
                feature_id=feature_id,
                properties=normalize_properties(feature.properties, form.fields),
            )
            await authorize_feature_attachments(
                transaction, context, [normalized.properties], form.fields
            )
            payload_sha256 = self._submission_checksum(
                form_id,
                form_version,
                supersedes_submission_id,
                operation,
                target_feature_id,
                target_feature_version,
                normalized,
            )
            existing = await self._submission_optional(
                transaction, context, dataset_id, submission_id, lock=True
            )
            if existing is not None:
                if existing.payload_sha256 != payload_sha256:
                    raise FieldCaptureConflict("field_submission_idempotency_conflict")
                return FieldSubmissionReceipt(existing, False)
            if supersedes_submission_id is not None:
                previous = await self._submission_optional(
                    transaction,
                    context,
                    dataset_id,
                    supersedes_submission_id,
                    lock=True,
                )
                if previous is None:
                    raise FieldCaptureNotFound("superseded_field_submission")
                if previous.state != "changes_requested":
                    raise FieldCaptureConflict("field_submission_not_correctable")
                if (
                    previous.operation != operation
                    or previous.target_feature_id != target_feature_id
                ):
                    raise FieldCaptureConflict("field_submission_correction_target_mismatch")
            row = await transaction.fetch_one(
                """
                INSERT INTO app.field_submissions
                  (id, organization_id, dataset_id, form_id, form_version,
                   supersedes_submission_id, operation, target_feature_id,
                   target_feature_version, payload_sha256, geometry_type,
                   properties, geometry_geojson, geometry, submitted_by)
                VALUES (
                  %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                  %s, %s, ST_SetSRID(ST_GeomFromGeoJSON(%s::text), 4326), %s
                )
                RETURNING id, dataset_id, form_id, form_version,
                          supersedes_submission_id, operation::text,
                          target_feature_id, target_feature_version, payload_sha256,
                          geometry_type::text, geometry_geojson, properties,
                          state::text, review_version, submitted_by, submitted_at,
                          reviewed_by, reviewed_at, review_message, promoted_feature_id
                """,
                (
                    submission_id,
                    context.organization_id,
                    dataset_id,
                    form_id,
                    form_version,
                    supersedes_submission_id,
                    operation,
                    target_feature_id,
                    target_feature_version,
                    payload_sha256,
                    normalized.geometry_type,
                    Jsonb(normalized.properties),
                    Jsonb(normalized.geometry),
                    Jsonb(normalized.geometry),
                    context.user_id,
                ),
            )
            assert row is not None
            await self._submission_event(
                transaction,
                context,
                dataset_id,
                submission_id,
                1,
                None,
                "submitted",
                None,
                request_id,
            )
            await self._activity(
                transaction,
                context,
                project_id,
                "field.submission.created",
                "field_submission",
                submission_id,
                request_id,
                {
                    "dataset_id": str(dataset_id),
                    "form_id": str(form_id),
                    "form_version": form_version,
                    "operation": operation,
                    "target_feature_id": (
                        str(target_feature_id) if target_feature_id is not None else None
                    ),
                    "target_feature_version": target_feature_version,
                    "supersedes_submission_id": (
                        str(supersedes_submission_id)
                        if supersedes_submission_id is not None
                        else None
                    ),
                },
            )
            return FieldSubmissionReceipt(self._submission(row), True)

        try:
            return await self._run(context, transaction_operation)
        except FeatureInvalid as error:
            raise FieldCaptureInvalid(str(error)) from error

    async def list_submissions(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        *,
        state: FieldSubmissionState | None,
        limit: int,
        offset: int,
    ) -> tuple[FieldSubmission, ...]:
        async def operation(transaction: TenantTransaction) -> tuple[FieldSubmission, ...]:
            scope = await self._scope(transaction, context, project_id, dataset_id)
            self._require(Action.FIELD_SUBMISSION_READ, scope.roles)
            state_sql = "" if state is None else "AND submission.state = %s"
            parameters: tuple[Any, ...] = (context.organization_id, dataset_id)
            if state is not None:
                parameters += (state,)
            rows = await transaction.fetch_all(
                f"""
                {self._submission_select()}
                WHERE submission.organization_id = %s
                  AND submission.dataset_id = %s
                  {state_sql}
                ORDER BY submission.submitted_at DESC, submission.id
                LIMIT %s OFFSET %s
                """,
                (*parameters, limit, offset),
            )
            return tuple(self._submission(row) for row in rows)

        return await self._run(context, operation)

    async def review_submission(
        self,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
        submission_id: UUID,
        expected_version: int,
        decision: FieldReviewDecision,
        message: str | None,
        request_id: str,
    ) -> FieldReviewResult:
        async def operation(transaction: TenantTransaction) -> FieldReviewResult:
            scope = await self._scope(transaction, context, project_id, dataset_id)
            self._require(Action.FIELD_SUBMISSION_REVIEW, scope.roles)
            PostgresFeatureRepository._require_editable_dataset(scope)
            current = await self._submission_optional(
                transaction, context, dataset_id, submission_id, lock=True
            )
            if current is None:
                raise FieldCaptureNotFound("field_submission")
            if current.review_version != expected_version:
                raise FieldCaptureConflict(
                    "field_submission_version_conflict", current.review_version
                )
            target_state = self._target_state(current.state, decision, message)
            next_version = current.review_version + 1
            promotion: FeatureMutation | None = None
            promoted_feature_id: UUID | None = None
            if target_state == "accepted":
                collection = await PostgresFeatureRepository._collection(
                    transaction, context, dataset_id, lock=True
                )
                promoted_feature_id = (
                    current.submission_id
                    if current.operation == "create"
                    else current.target_feature_id
                )
                assert promoted_feature_id is not None
                feature = FeatureDraft(
                    promoted_feature_id,
                    current.geometry_type,
                    current.geometry,
                    (0.0, 0.0, 0.0, 0.0),
                    normalize_properties(current.properties, collection.fields),
                )
                _require_geometry_type(feature, collection.geometry_type)
                await authorize_feature_attachments(
                    transaction, context, [feature.properties], collection.fields
                )
                if current.operation == "create":
                    exists = await transaction.fetch_one(
                        """
                        SELECT 1 FROM app.dataset_features
                        WHERE organization_id = %s AND dataset_id = %s AND id = %s
                        """,
                        (context.organization_id, dataset_id, submission_id),
                    )
                    if exists is not None:
                        raise FieldCaptureConflict("field_submission_feature_id_exists")
                    record = await PostgresFeatureRepository._insert_feature(
                        transaction,
                        context,
                        dataset_id,
                        feature,
                        "create",
                        f"Accepted field submission {submission_id}",
                        request_id,
                    )
                    collection = await PostgresFeatureRepository._advance_collection(
                        transaction, context, collection, count_delta=1
                    )
                    promoted_version = 1
                    event_type = "dataset.feature.promoted_from_field_submission"
                else:
                    assert current.target_feature_version is not None
                    try:
                        target = await PostgresFeatureRepository._feature_head(
                            transaction,
                            context,
                            dataset_id,
                            promoted_feature_id,
                            lock=True,
                        )
                    except FeatureNotFound as error:
                        raise FieldCaptureConflict("field_submission_target_unavailable") from error
                    if target.version_number != current.target_feature_version:
                        raise FieldCaptureConflict(
                            "field_submission_target_version_conflict",
                            target.version_number,
                        )
                    try:
                        await PostgresFeatureRepository._require_feature_lock_access(
                            transaction,
                            context,
                            dataset_id,
                            promoted_feature_id,
                            None,
                        )
                    except FeatureConflict as error:
                        if error.code != "feature_locked":
                            raise
                        raise FieldCaptureConflict(
                            "field_submission_target_locked",
                            error.current_version,
                        ) from error
                    promoted_version = current.target_feature_version + 1
                    row = await transaction.fetch_one(
                        """
                        UPDATE app.dataset_features
                        SET version_number = %s, properties = %s,
                            geometry_geojson = %s,
                            geometry = ST_SetSRID(
                              ST_GeomFromGeoJSON(%s::text), 4326
                            ),
                            updated_by = %s
                        WHERE organization_id = %s AND dataset_id = %s AND id = %s
                          AND deleted_at IS NULL AND version_number = %s
                        RETURNING id, version_number, geometry_type::text, properties,
                                  geometry_geojson, bbox, created_by, created_at,
                                  updated_by, updated_at
                        """,
                        (
                            promoted_version,
                            Jsonb(feature.properties),
                            Jsonb(feature.geometry),
                            Jsonb(feature.geometry),
                            context.user_id,
                            context.organization_id,
                            dataset_id,
                            promoted_feature_id,
                            current.target_feature_version,
                        ),
                    )
                    if row is None:
                        raise FieldCaptureConflict(
                            "field_submission_target_version_conflict",
                            target.version_number,
                        )
                    await PostgresFeatureRepository._insert_revision(
                        transaction,
                        context,
                        dataset_id,
                        promoted_feature_id,
                        promoted_version,
                        "update",
                        feature.geometry_type,
                        feature.properties,
                        feature.geometry,
                        f"Accepted field update submission {submission_id}",
                        request_id,
                    )
                    await PostgresFeatureRepository._drop_feature_lock(
                        transaction,
                        context,
                        dataset_id,
                        promoted_feature_id,
                    )
                    record = PostgresFeatureRepository._feature(row)
                    collection = await PostgresFeatureRepository._advance_collection(
                        transaction, context, collection, count_delta=0
                    )
                    event_type = "dataset.feature.promoted_update_from_field_submission"
                promotion = FeatureMutation(collection, record)
                await PostgresFeatureRepository._event(
                    transaction,
                    context,
                    project_id,
                    dataset_id,
                    event_type,
                    "feature",
                    promoted_feature_id,
                    request_id,
                    {
                        "dataset_id": str(dataset_id),
                        "field_submission_id": str(submission_id),
                        "operation": current.operation,
                        "base_version": current.target_feature_version,
                        "version": promoted_version,
                        "generation": collection.generation,
                    },
                )
            row = await transaction.fetch_one(
                """
                UPDATE app.field_submissions
                SET state = %s, review_version = %s, reviewed_by = %s,
                    reviewed_at = clock_timestamp(), review_message = %s,
                    promoted_feature_id = %s
                WHERE organization_id = %s AND dataset_id = %s AND id = %s
                  AND review_version = %s
                RETURNING id, dataset_id, form_id, form_version,
                          supersedes_submission_id, operation::text,
                          target_feature_id, target_feature_version, payload_sha256,
                          geometry_type::text, geometry_geojson, properties,
                          state::text, review_version, submitted_by, submitted_at,
                          reviewed_by, reviewed_at, review_message, promoted_feature_id
                """,
                (
                    target_state,
                    next_version,
                    context.user_id,
                    message,
                    promoted_feature_id,
                    context.organization_id,
                    dataset_id,
                    submission_id,
                    expected_version,
                ),
            )
            if row is None:
                raise FieldCaptureConflict(
                    "field_submission_version_conflict", current.review_version
                )
            await self._submission_event(
                transaction,
                context,
                dataset_id,
                submission_id,
                next_version,
                current.state,
                target_state,
                message,
                request_id,
            )
            await self._activity(
                transaction,
                context,
                project_id,
                f"field.submission.{target_state}",
                "field_submission",
                submission_id,
                request_id,
                {
                    "dataset_id": str(dataset_id),
                    "review_version": next_version,
                    "promoted_feature_id": (
                        str(promoted_feature_id) if promoted_feature_id is not None else None
                    ),
                },
            )
            return FieldReviewResult(self._submission(row), promotion)

        try:
            return await self._run(context, operation)
        except FeatureInvalid as error:
            raise FieldCaptureInvalid(str(error)) from error

    @staticmethod
    def _target_state(
        current: FieldSubmissionState,
        decision: FieldReviewDecision,
        message: str | None,
    ) -> FieldSubmissionState:
        if decision == "start_review":
            if current != "submitted":
                raise FieldCaptureConflict("field_submission_not_submitted")
            if message is not None:
                raise FieldCaptureInvalid("start_review does not accept a review message")
            return "in_review"
        if current != "in_review":
            raise FieldCaptureConflict("field_submission_not_in_review")
        if decision in {"request_changes", "reject"} and message is None:
            raise FieldCaptureInvalid(f"{decision} requires a review message")
        return cast(
            FieldSubmissionState,
            {"request_changes": "changes_requested", "reject": "rejected", "accept": "accepted"}[
                decision
            ],
        )

    @staticmethod
    async def _scope(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        dataset_id: UUID,
    ) -> Any:
        return await PostgresFeatureRepository._scope(transaction, context, project_id, dataset_id)

    @staticmethod
    def _require(action: Action, roles: Roles) -> None:
        try:
            authorize(action, roles)
        except AuthorizationDenied as error:
            raise FieldCaptureAccessDenied("action forbidden") from error

    @staticmethod
    async def _insert_form_version(
        transaction: TenantTransaction,
        context: TenantContext,
        dataset_id: UUID,
        form_id: UUID,
        version_number: int,
        title: str,
        instructions: str | None,
        collection_generation: int,
        geometry_type: GeometryType,
        fields: tuple[FeatureField, ...],
    ) -> None:
        await transaction.execute(
            """
            INSERT INTO app.field_form_versions
              (organization_id, dataset_id, form_id, version_number, title,
               instructions, collection_generation, geometry_type,
               schema_definition, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                context.organization_id,
                dataset_id,
                form_id,
                version_number,
                title,
                instructions,
                collection_generation,
                geometry_type,
                Jsonb(_schema_definition(fields)),
                context.user_id,
            ),
        )

    @staticmethod
    async def _form_version(
        transaction: TenantTransaction,
        context: TenantContext,
        dataset_id: UUID,
        form_id: UUID,
        version_number: int,
    ) -> FieldForm:
        row = await transaction.fetch_one(
            """
            SELECT version.form_id, version.dataset_id, version.version_number,
                   version.title, version.instructions,
                   version.collection_generation, version.geometry_type::text,
                   version.schema_definition, form.created_by, form.created_at,
                   form.updated_by, form.updated_at
            FROM app.field_form_versions version
            JOIN app.field_forms form
              ON form.organization_id = version.organization_id
             AND form.dataset_id = version.dataset_id
             AND form.id = version.form_id
            WHERE version.organization_id = %s AND version.dataset_id = %s
              AND version.form_id = %s AND version.version_number = %s
            """,
            (context.organization_id, dataset_id, form_id, version_number),
        )
        if row is None:
            raise FieldCaptureNotFound("field_form_version")
        return PostgresFieldCaptureRepository._form(row)

    @staticmethod
    def _form(row: tuple[Any, ...]) -> FieldForm:
        return FieldForm(
            form_id=cast(UUID, row[0]),
            dataset_id=cast(UUID, row[1]),
            version_number=cast(int, row[2]),
            title=cast(str, row[3]),
            instructions=cast(str | None, row[4]),
            collection_generation=cast(int, row[5]),
            geometry_type=cast(GeometryType, row[6]),
            fields=_fields_from_schema(cast(dict[str, Any], row[7])),
            created_by=cast(UUID, row[8]),
            created_at=cast(datetime, row[9]),
            updated_by=cast(UUID, row[10]),
            updated_at=cast(datetime, row[11]),
        )

    @staticmethod
    def _submission_checksum(
        form_id: UUID,
        form_version: int,
        supersedes_submission_id: UUID | None,
        operation: FieldSubmissionOperation,
        target_feature_id: UUID | None,
        target_feature_version: int | None,
        feature: FeatureDraft,
    ) -> str:
        return hashlib.sha256(
            _canonical_json(
                {
                    "formId": str(form_id),
                    "formVersion": form_version,
                    "supersedesSubmissionId": (
                        str(supersedes_submission_id)
                        if supersedes_submission_id is not None
                        else None
                    ),
                    "operation": operation,
                    "targetFeatureId": (
                        str(target_feature_id) if target_feature_id is not None else None
                    ),
                    "targetFeatureVersion": target_feature_version,
                    "geometry": feature.geometry,
                    "properties": feature.properties,
                }
            )
        ).hexdigest()

    @staticmethod
    async def _submission_optional(
        transaction: TenantTransaction,
        context: TenantContext,
        dataset_id: UUID,
        submission_id: UUID,
        *,
        lock: bool,
    ) -> FieldSubmission | None:
        row = await transaction.fetch_one(
            f"""
            {PostgresFieldCaptureRepository._submission_select()}
            WHERE submission.organization_id = %s
              AND submission.dataset_id = %s AND submission.id = %s
            {"FOR UPDATE" if lock else ""}
            """,
            (context.organization_id, dataset_id, submission_id),
        )
        return None if row is None else PostgresFieldCaptureRepository._submission(row)

    @staticmethod
    def _submission_select() -> str:
        return """
            SELECT submission.id, submission.dataset_id, submission.form_id,
                   submission.form_version, submission.supersedes_submission_id,
                   submission.operation::text, submission.target_feature_id,
                   submission.target_feature_version, submission.payload_sha256,
                   submission.geometry_type::text, submission.geometry_geojson,
                   submission.properties, submission.state::text,
                   submission.review_version, submission.submitted_by,
                   submission.submitted_at, submission.reviewed_by,
                   submission.reviewed_at, submission.review_message,
                   submission.promoted_feature_id
            FROM app.field_submissions submission
        """

    @staticmethod
    def _submission(row: tuple[Any, ...]) -> FieldSubmission:
        return FieldSubmission(
            submission_id=cast(UUID, row[0]),
            dataset_id=cast(UUID, row[1]),
            form_id=cast(UUID, row[2]),
            form_version=cast(int, row[3]),
            supersedes_submission_id=cast(UUID | None, row[4]),
            operation=cast(FieldSubmissionOperation, row[5]),
            target_feature_id=cast(UUID | None, row[6]),
            target_feature_version=cast(int | None, row[7]),
            payload_sha256=cast(str, row[8]),
            geometry_type=cast(GeometryType, row[9]),
            geometry=cast(dict[str, Any], row[10]),
            properties=cast(dict[str, Any], row[11]),
            state=cast(FieldSubmissionState, row[12]),
            review_version=cast(int, row[13]),
            submitted_by=cast(UUID, row[14]),
            submitted_at=cast(datetime, row[15]),
            reviewed_by=cast(UUID | None, row[16]),
            reviewed_at=cast(datetime | None, row[17]),
            review_message=cast(str | None, row[18]),
            promoted_feature_id=cast(UUID | None, row[19]),
        )

    @staticmethod
    async def _submission_event(
        transaction: TenantTransaction,
        context: TenantContext,
        dataset_id: UUID,
        submission_id: UUID,
        version: int,
        from_state: FieldSubmissionState | None,
        to_state: FieldSubmissionState,
        message: str | None,
        request_id: str,
    ) -> None:
        await transaction.execute(
            """
            INSERT INTO app.field_submission_events
              (organization_id, dataset_id, submission_id, submission_version,
               from_state, to_state, actor_user_id, message, request_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                context.organization_id,
                dataset_id,
                submission_id,
                version,
                from_state,
                to_state,
                context.user_id,
                message,
                request_id,
            ),
        )

    @staticmethod
    async def _activity(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        event_type: str,
        resource_type: str,
        resource_id: UUID,
        request_id: str,
        payload: dict[str, Any],
    ) -> None:
        await transaction.execute(
            """
            INSERT INTO app.activity_events
              (organization_id, actor_user_id, project_id, event_type,
               resource_type, resource_id, request_id, payload)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                context.organization_id,
                context.user_id,
                project_id,
                event_type,
                resource_type,
                resource_id,
                request_id,
                Jsonb(payload),
            ),
        )
