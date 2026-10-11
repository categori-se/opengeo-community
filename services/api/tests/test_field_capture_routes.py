import hashlib
import json
from dataclasses import replace
from datetime import UTC, datetime
from uuid import UUID, uuid4

from fastapi.testclient import TestClient

from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.config import Settings
from opengeo_api.features import (
    FeatureCollection,
    FeatureMutation,
    FeatureRecord,
    normalize_fields,
    normalize_properties,
)
from opengeo_api.field_capture import (
    FieldCaptureConflict,
    FieldCaptureNotFound,
    FieldForm,
    FieldReviewResult,
    FieldSubmission,
    FieldSubmissionReceipt,
)

USER_ID = UUID("20000000-0000-4000-8000-000000000141")
ORG_ID = UUID("10000000-0000-4000-8000-000000000141")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000141")
DATASET_ID = UUID("80000000-0000-4000-8000-000000000141")
FORM_ID = UUID("a0000000-0000-4000-8000-000000000141")
SUBMISSION_ID = UUID("b0000000-0000-4000-8000-000000000141")
CORRECTION_ID = UUID("b0000000-0000-4000-8000-000000000142")
TARGET_FEATURE_ID = UUID("90000000-0000-4000-8000-000000000141")
NOW = datetime(2026, 8, 20, 18, tzinfo=UTC)


class PassingProbe:
    async def check(self) -> None:
        pass


class FakeVerifier:
    async def verify(self, token: str) -> VerifiedAccessToken:
        assert token == "valid-token"
        return VerifiedAccessToken("field-subject", "client", "user", (), ())


class FakePrincipalRepository:
    async def resolve(self, subject: str) -> Principal:
        assert subject == "field-subject"
        return Principal(
            user_id=USER_ID,
            subject=subject,
            email="field@example.test",
            display_name="Field Editor",
            memberships=(OrganizationMembership(ORG_ID, "member"),),
        )


class MemoryFieldCaptureRepository:
    def __init__(self) -> None:
        self.forms: dict[UUID, FieldForm] = {}
        self.submissions: dict[UUID, FieldSubmission] = {}
        self.payloads: dict[UUID, str] = {}
        self.calls: list[tuple] = []
        self.features = {
            TARGET_FEATURE_ID: FeatureRecord(
                TARGET_FEATURE_ID,
                3,
                "Point",
                {"type": "Point", "coordinates": [-77.04, 38.91]},
                (-77.04, 38.91, -77.04, 38.91),
                {"name": "Existing station", "verified": False},
                USER_ID,
                NOW,
                USER_ID,
                NOW,
            )
        }

    async def create_form(self, context, project_id, dataset_id, title, instructions, request_id):
        self.calls.append(("create_form", context, project_id, dataset_id, request_id))
        form = self._form(FORM_ID, 1, title, instructions)
        self.forms[form.form_id] = form
        return form

    async def create_form_version(
        self,
        context,
        project_id,
        dataset_id,
        form_id,
        expected_version,
        title,
        instructions,
        request_id,
    ):
        del context, project_id, dataset_id, request_id
        current = self._get_form(form_id)
        if current.version_number != expected_version:
            raise FieldCaptureConflict("field_form_version_conflict", current.version_number)
        changed = replace(
            current,
            version_number=expected_version + 1,
            title=title,
            instructions=instructions,
        )
        self.forms[form_id] = changed
        return changed

    async def list_forms(self, context, project_id, dataset_id):
        self.calls.append(("list_forms", context, project_id, dataset_id))
        return tuple(self.forms.values())

    async def create_submission(
        self,
        context,
        project_id,
        dataset_id,
        form_id,
        form_version,
        submission_id,
        supersedes_submission_id,
        operation,
        target_feature_id,
        target_feature_version,
        feature,
        request_id,
    ):
        self.calls.append(("submit", context, project_id, dataset_id, request_id))
        form = self._get_form(form_id)
        if form.version_number != form_version:
            raise FieldCaptureNotFound("field_form_version")
        properties = normalize_properties(feature.properties, form.fields)
        payload = json.dumps(
            {
                "form": str(form_id),
                "version": form_version,
                "supersedes": (
                    str(supersedes_submission_id) if supersedes_submission_id is not None else None
                ),
                "operation": operation,
                "target_feature_id": (
                    str(target_feature_id) if target_feature_id is not None else None
                ),
                "target_feature_version": target_feature_version,
                "geometry": feature.geometry,
                "properties": properties,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        checksum = hashlib.sha256(payload.encode()).hexdigest()
        if submission_id in self.submissions:
            if self.payloads[submission_id] != checksum:
                raise FieldCaptureConflict("field_submission_idempotency_conflict")
            return FieldSubmissionReceipt(self.submissions[submission_id], False)
        if supersedes_submission_id is not None:
            previous = self.submissions.get(supersedes_submission_id)
            if previous is None:
                raise FieldCaptureNotFound("superseded_field_submission")
            if previous.state != "changes_requested":
                raise FieldCaptureConflict("field_submission_not_correctable")
            if previous.operation != operation or previous.target_feature_id != target_feature_id:
                raise FieldCaptureConflict("field_submission_correction_target_mismatch")
        if operation == "update" and target_feature_id not in self.features:
            raise FieldCaptureConflict("field_submission_target_unavailable")
        submission = FieldSubmission(
            submission_id=submission_id,
            dataset_id=dataset_id,
            form_id=form_id,
            form_version=form_version,
            supersedes_submission_id=supersedes_submission_id,
            operation=operation,
            target_feature_id=target_feature_id,
            target_feature_version=target_feature_version,
            payload_sha256=checksum,
            geometry_type=feature.geometry_type,
            geometry=feature.geometry,
            properties=properties,
            state="submitted",
            review_version=1,
            submitted_by=USER_ID,
            submitted_at=NOW,
            reviewed_by=None,
            reviewed_at=None,
            review_message=None,
            promoted_feature_id=None,
        )
        self.submissions[submission_id] = submission
        self.payloads[submission_id] = checksum
        return FieldSubmissionReceipt(submission, True)

    async def list_submissions(self, context, project_id, dataset_id, *, state, limit, offset):
        del context, project_id, dataset_id
        values = list(self.submissions.values())
        if state is not None:
            values = [item for item in values if item.state == state]
        return tuple(values[offset : offset + limit])

    async def review_submission(
        self,
        context,
        project_id,
        dataset_id,
        submission_id,
        expected_version,
        decision,
        message,
        request_id,
    ):
        del context, project_id, request_id
        current = self.submissions.get(submission_id)
        if current is None:
            raise FieldCaptureNotFound("field_submission")
        if current.review_version != expected_version:
            raise FieldCaptureConflict("field_submission_version_conflict", current.review_version)
        if decision == "start_review":
            if current.state != "submitted":
                raise FieldCaptureConflict("field_submission_not_submitted")
            target = "in_review"
        else:
            if current.state != "in_review":
                raise FieldCaptureConflict("field_submission_not_in_review")
            target = {
                "request_changes": "changes_requested",
                "reject": "rejected",
                "accept": "accepted",
            }[decision]
        promoted_id = (
            (submission_id if current.operation == "create" else current.target_feature_id)
            if target == "accepted"
            else None
        )
        changed = replace(
            current,
            state=target,
            review_version=expected_version + 1,
            reviewed_by=USER_ID,
            reviewed_at=NOW,
            review_message=message,
            promoted_feature_id=promoted_id,
        )
        promotion = None
        if target == "accepted":
            if changed.operation == "update":
                assert changed.target_feature_id is not None
                assert changed.target_feature_version is not None
                current_feature = self.features[changed.target_feature_id]
                if current_feature.version_number != changed.target_feature_version:
                    raise FieldCaptureConflict(
                        "field_submission_target_version_conflict",
                        current_feature.version_number,
                    )
                feature = replace(
                    current_feature,
                    version_number=current_feature.version_number + 1,
                    geometry=changed.geometry,
                    properties=changed.properties,
                    updated_by=USER_ID,
                    updated_at=NOW,
                )
                self.features[changed.target_feature_id] = feature
            else:
                feature = FeatureRecord(
                    submission_id,
                    1,
                    changed.geometry_type,
                    changed.geometry,
                    (-77.03, 38.9, -77.03, 38.9),
                    changed.properties,
                    USER_ID,
                    NOW,
                    USER_ID,
                    NOW,
                )
            collection = FeatureCollection(
                dataset_id,
                changed.geometry_type,
                self._get_form(changed.form_id).fields,
                2,
                1,
                USER_ID,
                NOW,
                USER_ID,
                NOW,
            )
            promotion = FeatureMutation(collection, feature)
        self.submissions[submission_id] = changed
        return FieldReviewResult(changed, promotion)

    @staticmethod
    def _form(form_id, version, title, instructions):
        return FieldForm(
            form_id,
            DATASET_ID,
            version,
            title,
            instructions,
            1,
            "Point",
            normalize_fields(
                [
                    {
                        "name": "name",
                        "type": "string",
                        "required": True,
                        "label": "Station name",
                        "description": "Name visible to field staff",
                        "min_length": 1,
                        "max_length": 100,
                    },
                    {"name": "verified", "type": "boolean", "required": False},
                ]
            ),
            USER_ID,
            NOW,
            USER_ID,
            NOW,
        )

    def _get_form(self, form_id):
        try:
            return self.forms[form_id]
        except KeyError as error:
            raise FieldCaptureNotFound("field_form") from error


def api_client(repository: MemoryFieldCaptureRepository) -> TestClient:
    return TestClient(
        create_app(
            settings=Settings(env="test", expose_docs=True),
            readiness_probe=PassingProbe(),
            token_verifier=FakeVerifier(),
            principal_repository=FakePrincipalRepository(),
            field_capture_repository=repository,
        )
    )


def headers() -> dict[str, str]:
    return {
        "Authorization": "Bearer valid-token",
        "X-OpenGeo-Organization": str(ORG_ID),
        "X-Request-ID": "field-capture-request-123",
    }


def form_url() -> str:
    return f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/field-forms"


def submission_url(form_id=FORM_ID, version=1) -> str:
    return f"{form_url()}/{form_id}/versions/{version}/submissions"


def submission_payload(
    submission_id=SUBMISSION_ID,
    name="Station",
    supersedes=None,
    operation="create",
    target_feature_id=None,
    target_feature_version=None,
):
    feature_id = target_feature_id if operation == "update" else submission_id
    return {
        "client_submission_id": str(submission_id),
        "supersedes_submission_id": str(supersedes) if supersedes else None,
        "operation": operation,
        "target_feature_id": str(target_feature_id) if target_feature_id else None,
        "target_feature_version": target_feature_version,
        "feature": {
            "type": "Feature",
            "id": str(feature_id),
            "geometry": {"type": "Point", "coordinates": [-77.03, 38.9]},
            "properties": {"name": name, "verified": True},
        },
    }


def initialize(repository, client):
    return client.post(
        form_url(),
        headers=headers(),
        json={"title": "Station survey", "instructions": "Stand safely off the roadway."},
    )


def test_shared_auth_org_scope_and_immutable_form_versions() -> None:
    repository = MemoryFieldCaptureRepository()
    client = api_client(repository)

    assert client.get(form_url()).status_code == 401
    created = initialize(repository, client)
    updated = client.post(
        f"{form_url()}/{FORM_ID}/versions",
        headers=headers(),
        json={
            "expected_version": 1,
            "title": "Station survey v2",
            "instructions": "Confirm the station marker before saving.",
        },
    )

    assert created.status_code == 201
    assert created.json()["geometry_type"] == "Point"
    assert created.json()["fields"][0]["name"] == "name"
    assert created.json()["fields"][0]["label"] == "Station name"
    assert created.json()["fields"][0]["description"] == "Name visible to field staff"
    assert created.json()["fields"][0]["max_length"] == 100
    assert updated.status_code == 201
    assert updated.json()["version"] == 2
    assert repository.calls[0][1].organization_id == ORG_ID
    assert repository.calls[0][-1] == "field-capture-request-123"


def test_offline_replay_is_idempotent_and_payload_changes_conflict() -> None:
    repository = MemoryFieldCaptureRepository()
    client = api_client(repository)
    initialize(repository, client)

    created = client.post(submission_url(), headers=headers(), json=submission_payload())
    replay = client.post(submission_url(), headers=headers(), json=submission_payload())
    changed = client.post(
        submission_url(), headers=headers(), json=submission_payload(name="Changed replay")
    )

    assert created.status_code == 201
    assert created.json()["created"] is True
    assert replay.status_code == 200
    assert replay.json()["created"] is False
    assert replay.json()["submission"]["id"] == str(SUBMISSION_ID)
    assert changed.status_code == 409
    assert changed.json()["detail"] == {"code": "field_submission_idempotency_conflict"}
    assert len(repository.submissions) == 1


def test_submission_preserves_nested_and_ordered_repeating_properties() -> None:
    repository = MemoryFieldCaptureRepository()
    client = api_client(repository)
    initialize(repository, client)
    repository.forms[FORM_ID] = replace(
        repository.forms[FORM_ID],
        fields=normalize_fields(
            [
                {
                    "name": "observer",
                    "type": "group",
                    "required": True,
                    "fields": [
                        {"name": "name", "type": "string", "required": True},
                        {"name": "certified", "type": "boolean", "required": False},
                    ],
                },
                {
                    "name": "samples",
                    "type": "group",
                    "repeat": True,
                    "min_items": 1,
                    "max_items": 3,
                    "fields": [
                        {"name": "kind", "type": "string", "required": True},
                        {"name": "reading", "type": "number", "required": True},
                    ],
                },
            ]
        ),
    )
    payload = submission_payload()
    payload["feature"]["properties"] = {
        "observer": {"name": "A. Rivera", "certified": True},
        "samples": [
            {"kind": "water", "reading": 7.2},
            {"kind": "soil", "reading": 4.1},
        ],
    }

    response = client.post(submission_url(), headers=headers(), json=payload)

    assert response.status_code == 201
    assert (
        response.json()["submission"]["feature"]["properties"] == payload["feature"]["properties"]
    )


def test_review_quarantine_and_atomic_promotion_keep_stable_identity() -> None:
    repository = MemoryFieldCaptureRepository()
    client = api_client(repository)
    initialize(repository, client)
    client.post(submission_url(), headers=headers(), json=submission_payload())
    review_url = (
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/field-submissions/{SUBMISSION_ID}/review"
    )

    queued = client.get(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/field-submissions",
        headers=headers(),
        params={"state": "submitted"},
    )
    started = client.post(
        review_url,
        headers=headers(),
        json={"expected_version": 1, "decision": "start_review"},
    )
    accepted = client.post(
        review_url,
        headers=headers(),
        json={"expected_version": 2, "decision": "accept", "message": "GPS verified"},
    )
    stale = client.post(
        review_url,
        headers=headers(),
        json={"expected_version": 2, "decision": "reject", "message": "stale"},
    )

    assert queued.json()["submissions"][0]["promoted_feature_id"] is None
    assert started.json()["submission"]["state"] == "in_review"
    assert accepted.json()["submission"]["state"] == "accepted"
    assert accepted.json()["submission"]["promoted_feature_id"] == str(SUBMISSION_ID)
    assert accepted.json()["promoted_feature"]["id"] == str(SUBMISSION_ID)
    assert accepted.json()["promoted_feature"]["opengeo:collectionGeneration"] == 2
    assert stale.status_code == 409
    assert stale.json()["detail"]["current_version"] == 3


def test_requested_changes_are_corrected_by_a_linked_new_submission() -> None:
    repository = MemoryFieldCaptureRepository()
    client = api_client(repository)
    initialize(repository, client)
    client.post(submission_url(), headers=headers(), json=submission_payload())
    review_url = (
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/field-submissions/{SUBMISSION_ID}/review"
    )
    client.post(
        review_url,
        headers=headers(),
        json={"expected_version": 1, "decision": "start_review"},
    )
    requested = client.post(
        review_url,
        headers=headers(),
        json={
            "expected_version": 2,
            "decision": "request_changes",
            "message": "Use the sign text, not the road name.",
        },
    )
    correction = client.post(
        submission_url(),
        headers=headers(),
        json=submission_payload(
            submission_id=CORRECTION_ID,
            name="Corrected station",
            supersedes=SUBMISSION_ID,
        ),
    )

    assert requested.json()["submission"]["state"] == "changes_requested"
    assert correction.status_code == 201
    assert correction.json()["submission"]["supersedes_submission_id"] == str(SUBMISSION_ID)
    assert correction.json()["submission"]["state"] == "submitted"


def test_offline_update_requires_its_exact_base_until_reviewed_correction() -> None:
    repository = MemoryFieldCaptureRepository()
    client = api_client(repository)
    initialize(repository, client)
    update_payload = submission_payload(
        name="Inspected station",
        operation="update",
        target_feature_id=TARGET_FEATURE_ID,
        target_feature_version=3,
    )
    created = client.post(submission_url(), headers=headers(), json=update_payload)
    review_url = (
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/field-submissions/{SUBMISSION_ID}/review"
    )
    client.post(
        review_url,
        headers=headers(),
        json={"expected_version": 1, "decision": "start_review"},
    )
    repository.features[TARGET_FEATURE_ID] = replace(
        repository.features[TARGET_FEATURE_ID], version_number=4
    )
    stale = client.post(
        review_url,
        headers=headers(),
        json={"expected_version": 2, "decision": "accept", "message": "Reviewed"},
    )

    assert created.status_code == 201
    assert created.json()["submission"]["operation"] == "update"
    assert created.json()["submission"]["target_feature_id"] == str(TARGET_FEATURE_ID)
    assert created.json()["submission"]["feature"]["id"] == str(TARGET_FEATURE_ID)
    assert stale.status_code == 409
    assert stale.json()["detail"] == {
        "code": "field_submission_target_version_conflict",
        "current_version": 4,
    }
    assert repository.submissions[SUBMISSION_ID].state == "in_review"

    client.post(
        review_url,
        headers=headers(),
        json={
            "expected_version": 2,
            "decision": "request_changes",
            "message": "Reload the changed feature.",
        },
    )
    correction = client.post(
        submission_url(),
        headers=headers(),
        json=submission_payload(
            submission_id=CORRECTION_ID,
            name="Inspected current station",
            supersedes=SUBMISSION_ID,
            operation="update",
            target_feature_id=TARGET_FEATURE_ID,
            target_feature_version=4,
        ),
    )
    correction_review_url = (
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/field-submissions/{CORRECTION_ID}/review"
    )
    client.post(
        correction_review_url,
        headers=headers(),
        json={"expected_version": 1, "decision": "start_review"},
    )
    accepted = client.post(
        correction_review_url,
        headers=headers(),
        json={"expected_version": 2, "decision": "accept", "message": "Reviewed"},
    )

    assert correction.status_code == 201
    assert accepted.status_code == 200
    assert accepted.json()["submission"]["promoted_feature_id"] == str(TARGET_FEATURE_ID)
    assert accepted.json()["promoted_feature"]["id"] == str(TARGET_FEATURE_ID)
    assert accepted.json()["promoted_feature"]["opengeo:version"] == 5


def test_submission_contract_is_bounded_and_exact() -> None:
    repository = MemoryFieldCaptureRepository()
    client = api_client(repository)
    initialize(repository, client)
    invalid = submission_payload()
    invalid["unexpected"] = True
    mismatch = submission_payload()
    mismatch["feature"]["id"] = str(uuid4())
    missing_update_target = submission_payload(operation="update")
    create_with_target = submission_payload(
        target_feature_id=TARGET_FEATURE_ID,
        target_feature_version=3,
    )

    assert client.post(submission_url(), headers=headers(), json=invalid).status_code == 422
    response = client.post(submission_url(), headers=headers(), json=mismatch)
    oversized_offset = client.get(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/field-submissions",
        headers=headers(),
        params={"offset": 10_001},
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "field_submission_feature_id_mismatch"
    assert (
        client.post(submission_url(), headers=headers(), json=missing_update_target).status_code
        == 422
    )
    assert (
        client.post(submission_url(), headers=headers(), json=create_with_target).status_code == 422
    )
    assert oversized_offset.status_code == 422
