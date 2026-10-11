import asyncio
import json
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from urllib.parse import urlsplit
from uuid import UUID

import anyio.to_thread
import pytest
from fastapi import FastAPI

from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.config import Settings
from opengeo_api.dataset_repository_browser import (
    DatasetRepositoryAccessDenied,
    DatasetRepositoryEntry,
    DatasetRepositoryObject,
    DatasetRepositoryObjectNotFound,
    DatasetRepositoryObjectVersion,
    DatasetRepositoryObjectVersionsPage,
    DatasetRepositoryPage,
    DatasetRepositoryResponseInvalid,
    DatasetRepositoryUnavailable,
)
from opengeo_api.ingestion import (
    Dataset,
    DatasetCapabilities,
    IngestionConflict,
    RepositoryObjectRegistration,
    RepositoryObjectSource,
)
from opengeo_api.user_connections import (
    ProjectDatasetConnectionBinding,
    UserConnectionConflict,
    UserConnectionStoreUnavailable,
    UserDatasetConnection,
    UserDatasetConnectionOverview,
    UserDatasetConnectionProjectReference,
    UserDatasetConnectionVerification,
    UserDatasetConnectionVerificationSubmission,
)

USER_ID = UUID("20000000-0000-4000-8000-000000000051")
ORG_ID = UUID("10000000-0000-4000-8000-000000000051")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000051")
CONNECTION_ID = UUID("a0000000-0000-4000-8000-000000000051")
BINDING_ID = UUID("a1000000-0000-4000-8000-000000000051")
VERIFICATION_ID = UUID("b0000000-0000-4000-8000-000000000051")
NOW = datetime(2026, 8, 24, 16, tzinfo=UTC)


@pytest.fixture(autouse=True)
def inline_threadpool(monkeypatch: pytest.MonkeyPatch) -> None:
    async def run_sync(function, *args, **kwargs):
        del kwargs
        return function(*args)

    monkeypatch.setattr(anyio.to_thread, "run_sync", run_sync)


class PassingProbe:
    async def check(self) -> None:
        pass


class FakeVerifier:
    async def verify(self, token: str) -> VerifiedAccessToken:
        assert token == "valid-token"
        return VerifiedAccessToken("subject", "client", "user", (), ())


class FakePrincipalRepository:
    async def resolve(self, subject: str) -> Principal:
        assert subject == "subject"
        return Principal(
            user_id=USER_ID,
            subject=subject,
            email="2301690+aaronkyle@users.noreply.github.com",
            display_name="Aaron Dennis",
            memberships=(OrganizationMembership(ORG_ID, "admin"),),
        )


def connection(**changes) -> UserDatasetConnection:
    record = UserDatasetConnection(
        connection_id=CONNECTION_ID,
        owner_user_id=USER_ID,
        provider="s3",
        display_name="Geospatial data",
        bucket_name="example-geodata",
        region_name="us-east-1",
        object_prefix="",
        credential_mode="assume_role",
        role_arn="arn:aws:iam::222222222222:role/OpenGeoDatasetReader",
        configured_secret_fields=(),
        credential_revision=0,
        target_revision=1,
        status="unverified",
        last_verified_at=None,
        sanitized_error_code=None,
        created_at=NOW,
        updated_at=NOW,
        owned_by_caller=True,
    )
    return replace(record, **changes)


def binding() -> ProjectDatasetConnectionBinding:
    return ProjectDatasetConnectionBinding(
        binding_id=BINDING_ID,
        project_id=PROJECT_ID,
        display_name="Shared geospatial data",
        created_by=USER_ID,
        created_at=NOW,
        connection=connection(),
    )


def verification() -> UserDatasetConnectionVerification:
    return UserDatasetConnectionVerification(
        verification_id=VERIFICATION_ID,
        connection_id=CONNECTION_ID,
        target_revision=1,
        credential_revision=1,
        state="queued",
        attempt_count=0,
        bucket_access_confirmed=False,
        object_access_confirmed=False,
        deny_canaries_confirmed=False,
        objects_observed=0,
        sanitized_error_code=None,
        duration_ms=None,
        requested_by=USER_ID,
        created_at=NOW,
        started_at=None,
        finished_at=None,
    )


class FakeUserConnectionRepository:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def list_my_connections(self, context):
        self.calls.append(("list", context))
        return (connection(),)

    async def get_my_connection(self, context, connection_id):
        self.calls.append(("get", context, connection_id))
        return connection()

    async def create_connection(self, context, draft, request_id):
        self.calls.append(("create", context, draft, request_id))
        return connection(
            display_name=draft.display_name,
            bucket_name=draft.bucket_name,
            region_name=draft.region_name,
            object_prefix=draft.object_prefix,
            credential_mode=draft.credential_mode,
            role_arn=draft.role_arn,
        )

    async def update_connection(self, context, connection_id, changes, request_id):
        self.calls.append(("update", context, connection_id, changes, request_id))
        return connection(**changes)

    async def rotate_credentials(
        self, context, connection_id, expected_revision, credentials, request_id
    ):
        fields = tuple(sorted(credentials.values))
        if fields not in {
            ("external_id",),
            ("access_key_id", "secret_access_key"),
            ("access_key_id", "secret_access_key", "session_token"),
        }:
            raise UserConnectionConflict("credential_fields_invalid")
        self.calls.append(
            (
                "rotate",
                context,
                connection_id,
                expected_revision,
                credentials,
                request_id,
            )
        )
        return connection(
            configured_secret_fields=("external_id",),
            credential_revision=1,
            status="unverified",
        )

    async def list_project_bindings(self, context, project_id):
        self.calls.append(("list_bindings", context, project_id))
        return (binding(),)

    async def request_verification(self, context, connection_id, request_id):
        self.calls.append(("verify", context, connection_id, request_id))
        return UserDatasetConnectionVerificationSubmission(verification(), True)

    async def list_verifications(self, context, connection_id):
        self.calls.append(("list_verifications", context, connection_id))
        return (verification(),)

    async def get_my_connection_overview(self, context, connection_id):
        self.calls.append(("overview", context, connection_id))
        return UserDatasetConnectionOverview(
            connection_id=CONNECTION_ID,
            target_revision=1,
            credential_revision=1,
            health="checking",
            latest_verification=verification(),
            project_references=(
                UserDatasetConnectionProjectReference(
                    binding_id=BINDING_ID,
                    project_id=PROJECT_ID,
                    project_name="Field atlas",
                    project_status="active",
                    display_name="Shared geospatial data",
                    created_at=NOW,
                ),
            ),
        )

    async def create_project_binding(
        self, context, project_id, connection_id, display_name, request_id
    ):
        self.calls.append(("bind", context, project_id, connection_id, display_name, request_id))
        return binding()

    async def remove_project_binding(self, context, project_id, binding_id, request_id):
        self.calls.append(("unbind", context, project_id, binding_id, request_id))


class FailingRepository(FakeUserConnectionRepository):
    async def list_my_connections(self, context):
        del context
        raise UserConnectionStoreUnavailable("secret_access_key=must-not-leak")


class DatasetVerificationDispatcher:
    def __init__(self, available: bool = True) -> None:
        self.available = available
        self.dispatched: list[UUID] = []

    async def dispatch_user_dataset_verification(self, verification_id):
        self.dispatched.append(verification_id)


class DatasetRepositoryBrowser:
    def __init__(
        self,
        *,
        failure: Exception | None = None,
        page: DatasetRepositoryPage | None = None,
        object_record: DatasetRepositoryObject | None = None,
        versions_page: DatasetRepositoryObjectVersionsPage | None = None,
    ) -> None:
        self.available = True
        self.failure = failure
        self.page = page
        self.object_record = object_record
        self.versions_page = versions_page
        self.calls: list[tuple] = []

    async def browse(self, context, repository_connection, prefix, cursor, limit):
        self.calls.append((context, repository_connection, prefix, cursor, limit))
        if self.failure is not None:
            raise self.failure
        if self.page is not None:
            return self.page
        return DatasetRepositoryPage(
            prefix=prefix,
            parent_prefix="" if prefix else None,
            entries=(
                DatasetRepositoryEntry(
                    kind="prefix",
                    relative_path=f"{prefix}ma/",
                    name="ma",
                ),
                DatasetRepositoryEntry(
                    kind="object",
                    relative_path=f"{prefix}catalog.geojson",
                    name="catalog.geojson",
                    size_bytes=2048,
                    last_modified=NOW,
                    storage_class="STANDARD",
                ),
            ),
            truncated=True,
            next_cursor="next_page_1",
        )

    async def inspect(self, context, repository_connection, relative_path, version_id=None):
        self.calls.append(("inspect", context, repository_connection, relative_path, version_id))
        if self.failure is not None:
            raise self.failure
        if self.object_record is not None:
            return self.object_record
        return DatasetRepositoryObject(
            relative_path=relative_path,
            name=relative_path.rsplit("/", maxsplit=1)[-1],
            size_bytes=2048,
            last_modified=NOW,
            content_type="application/geo+json",
            etag='"etag-value"',
            storage_class="STANDARD",
            version_id="version-4",
            checksum_sha256="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        )

    async def versions(self, context, repository_connection, relative_path, cursor, limit):
        self.calls.append(
            ("versions", context, repository_connection, relative_path, cursor, limit)
        )
        if self.failure is not None:
            raise self.failure
        if self.versions_page is not None:
            return self.versions_page
        return DatasetRepositoryObjectVersionsPage(
            relative_path=relative_path,
            entries=(
                DatasetRepositoryObjectVersion(
                    version_id="version-4",
                    is_latest=True,
                    is_delete_marker=False,
                    last_modified=NOW,
                    size_bytes=2048,
                    etag='"etag-value"',
                    storage_class="STANDARD",
                ),
                DatasetRepositoryObjectVersion(
                    version_id="version-3",
                    is_latest=False,
                    is_delete_marker=False,
                    last_modified=datetime(2026, 8, 23, 16, tzinfo=UTC),
                    size_bytes=1024,
                    etag='"older-etag"',
                    storage_class="STANDARD",
                ),
            ),
            truncated=False,
            next_cursor=None,
        )


class RepositoryObjectRegistrationRepository:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def register_repository_object(
        self, context, project_id, draft, request_id
    ) -> RepositoryObjectRegistration:
        self.calls.append((context, project_id, draft, request_id))
        dataset = Dataset(
            dataset_id=UUID("d0000000-0000-4000-8000-000000000051"),
            project_id=project_id,
            name=draft.name,
            description=draft.description,
            classification=draft.classification,
            source_type="repository",
            format=draft.format,
            status="active",
            owner_user_id=USER_ID,
            current_version_id=None,
            current_version_number=None,
            current_version_state=None,
            feature_count=None,
            extent=None,
            crs=None,
            geometry_type=None,
            quality_results={},
            processing_job_state=None,
            processing_error_code=None,
            tags=draft.tags,
            created_at=NOW,
            updated_at=NOW,
            capabilities=DatasetCapabilities(True, True, False, True),
        )
        source = RepositoryObjectSource(
            dataset_id=dataset.dataset_id,
            connection_id=draft.connection_id,
            connection_target_revision=draft.expected_target_revision,
            provider="s3",
            bucket_name="example-geodata",
            region_name="us-east-1",
            object_prefix="",
            relative_path=draft.relative_path,
            provider_version_id=draft.provider_version_id,
            size_bytes=draft.size_bytes,
            last_modified=draft.last_modified,
            content_type=draft.content_type,
            etag=draft.etag,
            storage_class=draft.storage_class,
            provider_checksum_sha256=draft.provider_checksum_sha256,
            created_by=USER_ID,
            created_at=NOW,
        )
        return RepositoryObjectRegistration(dataset, source, True, True)


def api_app(
    repository: FakeUserConnectionRepository,
    dispatcher: DatasetVerificationDispatcher | None = None,
    browser: DatasetRepositoryBrowser | None = None,
    ingestion_repository=None,
) -> FastAPI:
    return create_app(
        settings=Settings(env="test", expose_docs=True),
        readiness_probe=PassingProbe(),
        token_verifier=FakeVerifier(),
        principal_repository=FakePrincipalRepository(),
        user_connection_repository=repository,
        user_dataset_verification_dispatcher=dispatcher,
        user_dataset_repository_browser=browser,
        ingestion_repository=ingestion_repository,
    )


@dataclass(frozen=True)
class AsgiResponse:
    status_code: int
    content: bytes

    @property
    def text(self) -> str:
        return self.content.decode("utf-8")

    def json(self):
        return json.loads(self.content)


def request(
    app: FastAPI,
    method: str,
    path: str,
    *,
    request_headers: dict[str, str] | None = None,
    json_body: dict | None = None,
) -> AsgiResponse:
    parsed = urlsplit(path)
    body = b"" if json_body is None else json.dumps(json_body).encode()
    header_items = list((request_headers or {}).items())
    if json_body is not None:
        header_items.extend(
            [("content-type", "application/json"), ("content-length", str(len(body)))]
        )

    async def invoke() -> AsgiResponse:
        incoming = [{"type": "http.request", "body": body, "more_body": False}]
        outgoing = []

        async def receive():
            if incoming:
                return incoming.pop(0)
            return {"type": "http.disconnect"}

        async def send(message):
            outgoing.append(message)

        await app(
            {
                "type": "http",
                "asgi": {"version": "3.0", "spec_version": "2.3"},
                "http_version": "1.1",
                "method": method,
                "scheme": "http",
                "path": parsed.path,
                "raw_path": parsed.path.encode(),
                "query_string": parsed.query.encode(),
                "root_path": "",
                "headers": [(key.lower().encode(), value.encode()) for key, value in header_items],
                "client": ("127.0.0.1", 12345),
                "server": ("testserver", 80),
            },
            receive,
            send,
        )
        start = next(message for message in outgoing if message["type"] == "http.response.start")
        response_body = b"".join(
            message.get("body", b"")
            for message in outgoing
            if message["type"] == "http.response.body"
        )
        return AsgiResponse(start["status"], response_body)

    return asyncio.run(invoke())


def headers() -> dict[str, str]:
    return {
        "Authorization": "Bearer valid-token",
        "X-OpenGeo-Organization": str(ORG_ID),
        "X-Request-ID": "request-user-connection-51",
    }


def test_create_persists_only_non_secret_s3_metadata() -> None:
    repository = FakeUserConnectionRepository()
    response = request(
        api_app(repository),
        "POST",
        "/me/dataset-connections",
        request_headers=headers(),
        json_body={
            "provider": "s3",
            "display_name": " Geospatial data ",
            "bucket_name": "example-geodata",
            "region_name": "us-east-1",
            "object_prefix": "",
            "credential_mode": "assume_role",
            "role_arn": "arn:aws:iam::222222222222:role/OpenGeoDatasetReader",
        },
    )

    assert response.status_code == 201
    assert response.json()["bucket_name"] == "example-geodata"
    assert response.json()["credential_ready"] is True
    assert response.json()["verification_available"] is False
    assert response.json()["repository_browse_available"] is False
    assert "secret_arn" not in response.text
    assert "credentials" not in response.text
    assert repository.calls[0][2].display_name == "Geospatial data"


def test_access_key_profile_is_a_safe_draft_until_credentials_are_replaced() -> None:
    repository = FakeUserConnectionRepository()
    response = request(
        api_app(repository),
        "POST",
        "/me/dataset-connections",
        request_headers=headers(),
        json_body={
            "display_name": "Private archive",
            "bucket_name": "private-geospatial-archive",
            "credential_mode": "access_key",
        },
    )

    assert response.status_code == 201
    call = repository.calls[0]
    assert call[2].credential_mode == "access_key"
    assert "access_key_id" not in response.text
    assert "secret_access_key" not in response.text


def test_credential_replacement_is_write_only_and_revision_guarded() -> None:
    repository = FakeUserConnectionRepository()
    response = request(
        api_app(repository),
        "PUT",
        f"/me/dataset-connections/{CONNECTION_ID}/credentials",
        request_headers=headers(),
        json_body={
            "expected_credential_revision": 0,
            "external_id": "opaque-external-id",
        },
    )

    assert response.status_code == 200
    assert response.json()["configured_secret_fields"] == ["external_id"]
    assert response.json()["credential_revision"] == 1
    assert "opaque-external-id" not in response.text
    values = repository.calls[0][4].values
    assert values == {"external_id": "opaque-external-id"}


def test_invalid_bucket_console_url_and_credential_shape_are_rejected() -> None:
    app = api_app(FakeUserConnectionRepository())
    invalid_bucket = request(
        app,
        "POST",
        "/me/dataset-connections",
        request_headers=headers(),
        json_body={
            "display_name": "Console URL",
            "bucket_name": "https://us-east-1.console.aws.amazon.com/s3/buckets/example-geodata",
            "credential_mode": "workload_identity",
        },
    )
    mixed_secrets = request(
        app,
        "PUT",
        f"/me/dataset-connections/{CONNECTION_ID}/credentials",
        request_headers=headers(),
        json_body={
            "expected_credential_revision": 0,
            "external_id": "opaque-external-id",
            "secret_access_key": "not-a-valid-complete-key-value",
        },
    )

    assert invalid_bucket.status_code == 422
    assert mixed_secrets.status_code == 409


def test_project_binding_contract_reuses_one_connection_without_copying_secrets() -> None:
    repository = FakeUserConnectionRepository()
    app = api_app(repository)
    created = request(
        app,
        "POST",
        f"/projects/{PROJECT_ID}/dataset-connection-bindings",
        request_headers=headers(),
        json_body={
            "connection_id": str(CONNECTION_ID),
            "display_name": "Shared geospatial data",
        },
    )
    listed = request(
        app,
        "GET",
        f"/projects/{PROJECT_ID}/dataset-connection-bindings",
        request_headers=headers(),
    )

    assert created.status_code == 201
    assert listed.status_code == 200
    assert listed.json()[0]["connection"]["connection_id"] == str(CONNECTION_ID)
    assert "secret_arn" not in listed.text


def test_store_failure_is_sanitized() -> None:
    response = request(
        api_app(FailingRepository()),
        "GET",
        "/me/dataset-connections",
        request_headers=headers(),
    )

    assert response.status_code == 503
    assert response.json() == {"detail": "user_connection_store_unavailable"}
    assert "must-not-leak" not in response.text


def test_owner_can_dispatch_and_read_secret_free_dataset_verification() -> None:
    repository = FakeUserConnectionRepository()
    dispatcher = DatasetVerificationDispatcher()
    app = api_app(repository, dispatcher)
    requested = request(
        app,
        "POST",
        f"/me/dataset-connections/{CONNECTION_ID}/verifications",
        request_headers=headers(),
    )
    listed = request(
        app,
        "GET",
        f"/me/dataset-connections/{CONNECTION_ID}/verifications",
        request_headers=headers(),
    )
    connections = request(
        app,
        "GET",
        "/me/dataset-connections",
        request_headers=headers(),
    )

    assert requested.status_code == 202
    assert requested.json()["created"] is True
    assert requested.json()["verification"]["state"] == "queued"
    assert listed.status_code == 200
    assert listed.json()[0]["verification_id"] == str(VERIFICATION_ID)
    assert connections.json()[0]["verification_available"] is True
    assert dispatcher.dispatched == [VERIFICATION_ID]
    assert "secret" not in requested.text


def test_owner_reads_revision_aware_health_and_visible_project_references() -> None:
    repository = FakeUserConnectionRepository()
    response = request(
        api_app(repository),
        "GET",
        f"/me/dataset-connections/{CONNECTION_ID}/overview",
        request_headers=headers(),
    )

    assert response.status_code == 200
    assert response.json() == {
        "connection_id": str(CONNECTION_ID),
        "target_revision": 1,
        "credential_revision": 1,
        "health": "checking",
        "latest_verification": {
            "verification_id": str(VERIFICATION_ID),
            "connection_id": str(CONNECTION_ID),
            "target_revision": 1,
            "credential_revision": 1,
            "state": "queued",
            "attempt_count": 0,
            "bucket_access_confirmed": False,
            "object_access_confirmed": False,
            "deny_canaries_confirmed": False,
            "objects_observed": 0,
            "sanitized_error_code": None,
            "duration_ms": None,
            "requested_by": str(USER_ID),
            "created_at": "2026-08-24T16:00:00Z",
            "started_at": None,
            "finished_at": None,
        },
        "project_references": [
            {
                "binding_id": str(BINDING_ID),
                "project_id": str(PROJECT_ID),
                "project_name": "Field atlas",
                "project_status": "active",
                "display_name": "Shared geospatial data",
                "created_at": "2026-08-24T16:00:00Z",
            }
        ],
    }
    assert "bucket_name" not in response.text
    assert "role_arn" not in response.text
    assert "secret" not in response.text


def test_dataset_verification_request_fails_before_persistence_when_unavailable() -> None:
    repository = FakeUserConnectionRepository()
    response = request(
        api_app(repository),
        "POST",
        f"/me/dataset-connections/{CONNECTION_ID}/verifications",
        request_headers=headers(),
    )
    assert response.status_code == 503
    assert response.json() == {"detail": "dataset_verification_unavailable"}
    assert not any(call[0] == "verify" for call in repository.calls)


def test_verified_owner_browses_bounded_relative_repository_metadata() -> None:
    class VerifiedRepository(FakeUserConnectionRepository):
        async def get_my_connection(self, context, connection_id):
            self.calls.append(("get", context, connection_id))
            return connection(status="verified", last_verified_at=NOW)

        async def list_my_connections(self, context):
            self.calls.append(("list", context))
            return (connection(status="verified", last_verified_at=NOW),)

    repository = VerifiedRepository()
    browser = DatasetRepositoryBrowser()
    app = api_app(repository, browser=browser)
    listed = request(
        app,
        "GET",
        "/me/dataset-connections",
        request_headers=headers(),
    )
    response = request(
        app,
        "GET",
        f"/me/dataset-connections/{CONNECTION_ID}/repository?prefix=usa%2F&cursor=page_1&limit=25",
        request_headers=headers(),
    )

    assert listed.status_code == 200
    assert listed.json()[0]["repository_browse_available"] is True
    assert response.status_code == 200
    assert response.json() == {
        "connection_id": str(CONNECTION_ID),
        "prefix": "usa/",
        "parent_prefix": "",
        "entries": [
            {
                "kind": "prefix",
                "relative_path": "usa/ma/",
                "name": "ma",
                "size_bytes": None,
                "last_modified": None,
                "storage_class": None,
                "version_id": None,
            },
            {
                "kind": "object",
                "relative_path": "usa/catalog.geojson",
                "name": "catalog.geojson",
                "size_bytes": 2048,
                "last_modified": "2026-08-24T16:00:00Z",
                "storage_class": "STANDARD",
                "version_id": None,
            },
        ],
        "truncated": True,
        "next_cursor": "next_page_1",
    }
    assert browser.calls[0][2:] == ("usa/", "page_1", 25)
    assert "example-geodata" not in response.text
    assert "role_arn" not in response.text
    assert "secret" not in response.text


def test_verified_owner_inspects_one_exact_current_repository_object() -> None:
    class VerifiedRepository(FakeUserConnectionRepository):
        async def get_my_connection(self, context, connection_id):
            return connection(status="verified", last_verified_at=NOW)

    browser = DatasetRepositoryBrowser()
    response = request(
        api_app(VerifiedRepository(), browser=browser),
        "GET",
        (f"/me/dataset-connections/{CONNECTION_ID}/repository/object?path=usa%2Fcatalog.geojson"),
        request_headers=headers(),
    )

    assert response.status_code == 200
    assert response.json() == {
        "connection_id": str(CONNECTION_ID),
        "relative_path": "usa/catalog.geojson",
        "name": "catalog.geojson",
        "size_bytes": 2048,
        "last_modified": "2026-08-24T16:00:00Z",
        "content_type": "application/geo+json",
        "etag": '"etag-value"',
        "storage_class": "STANDARD",
        "version_id": "version-4",
        "checksum_sha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    }
    assert browser.calls == [
        (
            "inspect",
            browser.calls[0][1],
            browser.calls[0][2],
            "usa/catalog.geojson",
            None,
        )
    ]
    assert "example-geodata" not in response.text
    assert "role_arn" not in response.text
    assert "secret" not in response.text


def test_verified_owner_lists_versions_and_inspects_one_exact_version() -> None:
    class VerifiedRepository(FakeUserConnectionRepository):
        async def get_my_connection(self, context, connection_id):
            return connection(status="verified", last_verified_at=NOW)

    browser = DatasetRepositoryBrowser()
    app = api_app(VerifiedRepository(), browser=browser)
    versions = request(
        app,
        "GET",
        (
            f"/me/dataset-connections/{CONNECTION_ID}/repository/object/versions"
            "?path=usa%2Fcatalog.geojson&limit=50"
        ),
        request_headers=headers(),
    )
    exact = request(
        app,
        "GET",
        (
            f"/me/dataset-connections/{CONNECTION_ID}/repository/object"
            "?path=usa%2Fcatalog.geojson&version_id=version-3"
        ),
        request_headers=headers(),
    )

    assert versions.status_code == 200
    assert versions.json()["relative_path"] == "usa/catalog.geojson"
    assert [entry["version_id"] for entry in versions.json()["entries"]] == [
        "version-4",
        "version-3",
    ]
    assert versions.json()["entries"][0]["is_latest"] is True
    assert exact.status_code == 502  # the fake deliberately returned another version
    assert exact.json() == {"detail": "dataset_repository_response_invalid"}
    assert browser.calls[0][0] == "versions"
    assert browser.calls[0][3:] == ("usa/catalog.geojson", None, 50)
    assert browser.calls[1][0] == "inspect"
    assert browser.calls[1][3:] == ("usa/catalog.geojson", "version-3")
    assert "example-geodata" not in versions.text
    assert "secret" not in versions.text


@pytest.mark.parametrize("version_id", ["version-3", "null"])
def test_exact_repository_version_is_returned_only_when_identity_matches(
    version_id: str,
) -> None:
    class VerifiedRepository(FakeUserConnectionRepository):
        async def get_my_connection(self, context, connection_id):
            return connection(status="verified", last_verified_at=NOW)

    record = DatasetRepositoryObject(
        relative_path="usa/catalog.geojson",
        name="catalog.geojson",
        size_bytes=1024,
        last_modified=datetime(2026, 8, 23, 16, tzinfo=UTC),
        content_type="application/geo+json",
        etag='"older-etag"',
        storage_class="STANDARD",
        version_id=version_id,
        checksum_sha256=None,
    )
    response = request(
        api_app(
            VerifiedRepository(),
            browser=DatasetRepositoryBrowser(object_record=record),
        ),
        "GET",
        (
            f"/me/dataset-connections/{CONNECTION_ID}/repository/object"
            f"?path=usa%2Fcatalog.geojson&version_id={version_id}"
        ),
        request_headers=headers(),
    )

    assert response.status_code == 200
    assert response.json()["version_id"] == version_id
    assert response.json()["size_bytes"] == 1024


def test_exact_repository_version_registers_as_governed_dataset_without_reading_bytes() -> None:
    class VerifiedRepository(FakeUserConnectionRepository):
        async def get_my_connection(self, context, connection_id):
            return connection(status="verified", last_verified_at=NOW, target_revision=7)

    browser = DatasetRepositoryBrowser()
    ingestion = RepositoryObjectRegistrationRepository()
    response = request(
        api_app(VerifiedRepository(), browser=browser, ingestion_repository=ingestion),
        "POST",
        f"/me/dataset-connections/{CONNECTION_ID}/repository/object/registrations",
        request_headers=headers(),
        json_body={
            "project_id": str(PROJECT_ID),
            "relative_path": "usa/catalog.geojson",
            "version_id": "version-4",
            "name": "MassGIS catalog",
            "description": "Exact external source reference",
            "classification": "internal",
            "format": "geojson",
            "tags": ["massgis", "catalog"],
        },
    )

    assert response.status_code == 200
    assert response.json()["created"] is True
    assert response.json()["attached"] is True
    assert response.json()["source"]["provider_version_id"] == "version-4"
    assert response.json()["source"]["connection_target_revision"] == 7
    assert browser.calls[0][0] == "inspect"
    assert browser.calls[0][3:] == ("usa/catalog.geojson", "version-4")
    assert len(ingestion.calls) == 1
    draft = ingestion.calls[0][2]
    assert draft.expected_target_revision == 7
    assert draft.size_bytes == 2048
    assert draft.tags == ("massgis", "catalog")
    assert "role_arn" not in response.text
    assert "secret" not in response.text


@pytest.mark.parametrize(
    ("version_id", "relative_path", "format"),
    [
        ("null", "usa/catalog.geojson", "geojson"),
        ("version-4", "../catalog.geojson", "geojson"),
        ("version-4", "usa/catalog.geojson", "pmtiles"),
    ],
)
def test_repository_registration_rejects_mutable_or_mismatched_identity_before_external_access(
    version_id: str, relative_path: str, format: str
) -> None:
    browser = DatasetRepositoryBrowser()
    response = request(
        api_app(
            FakeUserConnectionRepository(),
            browser=browser,
            ingestion_repository=RepositoryObjectRegistrationRepository(),
        ),
        "POST",
        f"/me/dataset-connections/{CONNECTION_ID}/repository/object/registrations",
        request_headers=headers(),
        json_body={
            "project_id": str(PROJECT_ID),
            "relative_path": relative_path,
            "version_id": version_id,
            "name": "Catalog",
            "classification": "internal",
            "format": format,
            "tags": [],
        },
    )
    assert response.status_code == 422
    assert browser.calls == []


def test_repository_registration_fails_if_connection_target_changes_after_inspection() -> None:
    class VerifiedRepository(FakeUserConnectionRepository):
        async def get_my_connection(self, context, connection_id):
            return connection(status="verified", last_verified_at=NOW)

    class ChangedTargetRepository(RepositoryObjectRegistrationRepository):
        async def register_repository_object(self, context, project_id, draft, request_id):
            del context, project_id, draft, request_id
            raise IngestionConflict("connection_target_changed")

    response = request(
        api_app(
            VerifiedRepository(),
            browser=DatasetRepositoryBrowser(),
            ingestion_repository=ChangedTargetRepository(),
        ),
        "POST",
        f"/me/dataset-connections/{CONNECTION_ID}/repository/object/registrations",
        request_headers=headers(),
        json_body={
            "project_id": str(PROJECT_ID),
            "relative_path": "catalog.geojson",
            "version_id": "version-4",
            "name": "Catalog",
            "classification": "internal",
            "format": "geojson",
            "tags": [],
        },
    )
    assert response.status_code == 409
    assert response.json() == {"detail": {"code": "connection_target_changed"}}


@pytest.mark.parametrize("version_id", ["", "line%0Abreak"])
def test_repository_version_selection_rejects_unsafe_identity_before_external_access(
    version_id: str,
) -> None:
    browser = DatasetRepositoryBrowser()
    response = request(
        api_app(FakeUserConnectionRepository(), browser=browser),
        "GET",
        (
            f"/me/dataset-connections/{CONNECTION_ID}/repository/object"
            f"?path=item.geojson&version_id={version_id}"
        ),
        request_headers=headers(),
    )
    assert response.status_code == 422
    assert browser.calls == []


@pytest.mark.parametrize(
    "record",
    [
        DatasetRepositoryObject(
            "other.geojson",
            "other.geojson",
            1,
            NOW,
            "application/geo+json",
            '"etag"',
            "STANDARD",
            None,
            None,
        ),
        DatasetRepositoryObject(
            "item.geojson",
            "wrong-name",
            1,
            NOW,
            "application/geo+json",
            '"etag"',
            "STANDARD",
            None,
            None,
        ),
        DatasetRepositoryObject(
            "item.geojson",
            "item.geojson",
            True,
            NOW,
            "application/geo+json",
            '"etag"',
            "STANDARD",
            None,
            None,
        ),
        DatasetRepositoryObject(
            "item.geojson",
            "item.geojson",
            1,
            datetime(2026, 8, 31),
            "application/geo+json",
            '"etag"',
            "STANDARD",
            None,
            None,
        ),
        DatasetRepositoryObject(
            "item.geojson",
            "item.geojson",
            1,
            NOW,
            "application/geo+json",
            '"etag"',
            "STANDARD",
            None,
            "not-a-checksum",
        ),
    ],
)
def test_repository_object_inspection_rejects_malformed_runtime_metadata(
    record: DatasetRepositoryObject,
) -> None:
    class VerifiedRepository(FakeUserConnectionRepository):
        async def get_my_connection(self, context, connection_id):
            return connection(status="verified", last_verified_at=NOW)

    response = request(
        api_app(
            VerifiedRepository(),
            browser=DatasetRepositoryBrowser(object_record=record),
        ),
        "GET",
        f"/me/dataset-connections/{CONNECTION_ID}/repository/object?path=item.geojson",
        request_headers=headers(),
    )
    assert response.status_code == 502
    assert response.json() == {"detail": "dataset_repository_response_invalid"}


@pytest.mark.parametrize("path", ["", "../private", "/absolute", "folder/", "windows\\path"])
def test_repository_object_inspection_rejects_unsafe_paths_before_external_access(
    path: str,
) -> None:
    browser = DatasetRepositoryBrowser()
    response = request(
        api_app(FakeUserConnectionRepository(), browser=browser),
        "GET",
        f"/me/dataset-connections/{CONNECTION_ID}/repository/object?path={path}",
        request_headers=headers(),
    )
    assert response.status_code == 422
    assert response.json() == {"detail": "repository_object_path_invalid"}
    assert browser.calls == []


@pytest.mark.parametrize(
    ("failure", "status_code", "detail"),
    [
        (
            DatasetRepositoryObjectNotFound("key=must-not-leak"),
            404,
            "dataset_repository_object_not_found",
        ),
        (DatasetRepositoryAccessDenied("private"), 403, "dataset_repository_access_denied"),
        (
            DatasetRepositoryResponseInvalid("etag=must-not-leak"),
            502,
            "dataset_repository_response_invalid",
        ),
        (
            DatasetRepositoryUnavailable("access-key=must-not-leak"),
            503,
            "dataset_repository_unavailable",
        ),
    ],
)
def test_repository_object_inspection_sanitizes_failures(
    failure: Exception, status_code: int, detail: str
) -> None:
    class VerifiedRepository(FakeUserConnectionRepository):
        async def get_my_connection(self, context, connection_id):
            return connection(status="verified", last_verified_at=NOW)

    response = request(
        api_app(
            VerifiedRepository(),
            browser=DatasetRepositoryBrowser(failure=failure),
        ),
        "GET",
        f"/me/dataset-connections/{CONNECTION_ID}/repository/object?path=item.geojson",
        request_headers=headers(),
    )
    assert response.status_code == status_code
    assert response.json() == {"detail": detail}
    assert "must-not-leak" not in response.text


def test_repository_browse_fails_closed_until_verified_and_configured() -> None:
    repository = FakeUserConnectionRepository()
    unavailable = request(
        api_app(repository),
        "GET",
        f"/me/dataset-connections/{CONNECTION_ID}/repository",
        request_headers=headers(),
    )
    unverified = request(
        api_app(repository, browser=DatasetRepositoryBrowser()),
        "GET",
        f"/me/dataset-connections/{CONNECTION_ID}/repository",
        request_headers=headers(),
    )

    assert unavailable.status_code == 503
    assert unavailable.json() == {"detail": "dataset_repository_unavailable"}
    assert unverified.status_code == 409
    assert unverified.json() == {"detail": {"code": "connection_not_verified"}}


@pytest.mark.parametrize(
    ("query", "detail"),
    [
        ("prefix=../private/", "repository_prefix_invalid"),
        ("prefix=%2Fabsolute", "repository_prefix_invalid"),
        ("prefix=windows%5Cpath", "repository_prefix_invalid"),
        ("prefix=usa", "repository_prefix_invalid"),
        ("cursor=not%2Bbase64", "repository_cursor_invalid"),
        ("limit=101", "repository_limit_invalid"),
    ],
)
def test_repository_browse_rejects_unsafe_navigation_before_external_access(
    query: str, detail: str
) -> None:
    browser = DatasetRepositoryBrowser()
    response = request(
        api_app(FakeUserConnectionRepository(), browser=browser),
        "GET",
        f"/me/dataset-connections/{CONNECTION_ID}/repository?{query}",
        request_headers=headers(),
    )

    assert response.status_code == 422
    assert response.json() == {"detail": detail}
    assert browser.calls == []


@pytest.mark.parametrize(
    "page",
    [
        DatasetRepositoryPage("other/", "", (), False, None),
        DatasetRepositoryPage("", "unexpected/", (), False, None),
        DatasetRepositoryPage(
            "",
            None,
            (DatasetRepositoryEntry("object", "../private", "private"),),
            False,
            None,
        ),
        DatasetRepositoryPage(
            "",
            None,
            (DatasetRepositoryEntry("unexpected", "private", "private"),),
            False,
            None,
        ),
        DatasetRepositoryPage(
            "",
            None,
            (DatasetRepositoryEntry("object", "item", "item", size_bytes=True),),
            False,
            None,
        ),
        DatasetRepositoryPage(
            "",
            None,
            (
                DatasetRepositoryEntry(
                    "object", "item", "item", last_modified=datetime(2026, 8, 31)
                ),
            ),
            False,
            None,
        ),
        DatasetRepositoryPage(
            "",
            None,
            (DatasetRepositoryEntry("prefix", "folder/", "folder", size_bytes=1),),
            False,
            None,
        ),
        DatasetRepositoryPage(
            "",
            None,
            tuple(
                DatasetRepositoryEntry("object", f"item-{index}", f"item-{index}")
                for index in range(2)
            ),
            False,
            None,
        ),
        DatasetRepositoryPage("", None, (), True, None),
        DatasetRepositoryPage("", None, (), False, "unexpected_cursor"),
    ],
)
def test_repository_browse_rejects_malformed_isolated_runtime_pages(
    page: DatasetRepositoryPage,
) -> None:
    class VerifiedRepository(FakeUserConnectionRepository):
        async def get_my_connection(self, context, connection_id):
            return connection(status="verified", last_verified_at=NOW)

    response = request(
        api_app(
            VerifiedRepository(),
            browser=DatasetRepositoryBrowser(page=page),
        ),
        "GET",
        f"/me/dataset-connections/{CONNECTION_ID}/repository?limit=1",
        request_headers=headers(),
    )

    assert response.status_code == 502
    assert response.json() == {"detail": "dataset_repository_response_invalid"}
    assert "private" not in response.text


@pytest.mark.parametrize(
    ("failure", "status_code", "detail"),
    [
        (DatasetRepositoryAccessDenied("private"), 403, "dataset_repository_access_denied"),
        (
            DatasetRepositoryResponseInvalid("object-key=must-not-leak"),
            502,
            "dataset_repository_response_invalid",
        ),
        (
            DatasetRepositoryUnavailable("access-key=must-not-leak"),
            503,
            "dataset_repository_unavailable",
        ),
    ],
)
def test_repository_browse_sanitizes_isolated_runtime_failures(
    failure: Exception, status_code: int, detail: str
) -> None:
    class VerifiedRepository(FakeUserConnectionRepository):
        async def get_my_connection(self, context, connection_id):
            return connection(status="verified", last_verified_at=NOW)

    response = request(
        api_app(
            VerifiedRepository(),
            browser=DatasetRepositoryBrowser(failure=failure),
        ),
        "GET",
        f"/me/dataset-connections/{CONNECTION_ID}/repository",
        request_headers=headers(),
    )

    assert response.status_code == status_code
    assert response.json() == {"detail": detail}
    assert "must-not-leak" not in response.text


def test_openapi_exposes_account_and_project_connection_plumbing() -> None:
    paths = request(api_app(FakeUserConnectionRepository()), "GET", "/openapi.json").json()["paths"]

    assert {
        "/me/dataset-connections",
        "/me/dataset-connections/{connection_id}",
        "/me/dataset-connections/{connection_id}/credentials",
        "/me/dataset-connections/{connection_id}/verifications",
        "/me/dataset-connections/{connection_id}/repository",
        "/me/dataset-connections/{connection_id}/repository/object",
        "/me/dataset-connections/{connection_id}/repository/object/registrations",
        "/projects/{project_id}/dataset-connection-bindings",
        "/projects/{project_id}/dataset-connection-bindings/{binding_id}",
    } <= set(paths)
