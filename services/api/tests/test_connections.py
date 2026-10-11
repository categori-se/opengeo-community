import asyncio
import json
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest

from opengeo_api.cognito_provisioning import AwsCredentials
from opengeo_api.config import Settings
from opengeo_api.connections import (
    AwsConnectionSecretStore,
    ConnectionAccessDenied,
    ConnectionSecretStoreUnavailable,
    ConnectionStoreUnavailable,
    ExternalConnectionDraft,
    PostgresExternalConnectionRepository,
    StoredConnectionSecret,
)
from opengeo_api.tenant_database import TenantContext, TenantDatabaseUnavailable

ORG_ID = UUID("10000000-0000-4000-8000-000000000477")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000477")
CONNECTION_ID = UUID("70000000-0000-4000-8000-000000000477")
SECRET_ARN = (
    "arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/test/connections/"
    f"{ORG_ID}/{CONNECTION_ID}-AbCd12"
)
BROWSER_SECRET_ARN = (
    "arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/test/browser-connections/"
    f"{ORG_ID}/{CONNECTION_ID}-AbCd12"
)


def versioned_browser_secret(version: int = 1, owner: int = 478) -> str:
    return (
        "arn:aws:secretsmanager:us-east-1:111111111111:secret:"
        f"opengeo/test/browser-connections/{ORG_ID}/{UUID(int=owner)}/"
        f"{CONNECTION_ID}/{UUID(int=version)}-AbCd12"
    )


class FakeCredentials:
    def load(self) -> AwsCredentials:
        return AwsCredentials("AKIDEXAMPLE", "signing-secret", "session-token")


class RecordingTransport:
    def __init__(self, *, status: int = 200, response: bytes | None = None) -> None:
        self.status = status
        self.response = response
        self.calls: list[tuple] = []

    def call(self, url, headers, body, timeout_seconds):
        self.calls.append((url, headers, body, timeout_seconds))
        operation = headers["x-amz-target"]
        if self.response is not None:
            return self.status, self.response
        if operation == "secretsmanager.CreateSecret":
            return self.status, json.dumps({"ARN": SECRET_ARN, "VersionId": "v1"}).encode()
        return self.status, b"{}"


def settings() -> Settings:
    return Settings(
        env="test",
        aws_region="us-east-1",
        geodata_bucket="test.storage.opengeo.tools",
        geodata_kms_key_arn=(
            "arn:aws:kms:us-east-1:111111111111:key/11111111-2222-4333-8444-555555555555"
        ),
    )


def test_secrets_manager_adapter_writes_exact_secret_and_uses_recoverable_cleanup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def immediate(function, *args):
        return function(*args)

    monkeypatch.setattr(asyncio, "to_thread", immediate)
    transport = RecordingTransport()
    store = AwsConnectionSecretStore(
        settings(),
        credentials=FakeCredentials(),
        transport=transport,
        now=lambda: datetime(2026, 8, 23, 12, tzinfo=UTC),
    )

    result = asyncio.run(
        store.create(ORG_ID, PROJECT_ID, CONNECTION_ID, "reader", "database-password")
    )
    asyncio.run(store.discard(result.reference))

    assert result.reference == SECRET_ARN
    assert result.configured_fields == ("password", "username")
    create_body = json.loads(transport.calls[0][2])
    assert create_body["Name"] == f"opengeo/test/connections/{ORG_ID}/{CONNECTION_ID}"
    assert create_body["KmsKeyId"] == settings().geodata_kms_key_arn
    assert json.loads(create_body["SecretString"]) == {
        "password": "database-password",
        "username": "reader",
    }
    assert "database-password" not in json.dumps(transport.calls[0][1])
    delete_body = json.loads(transport.calls[1][2])
    assert delete_body == {"RecoveryWindowInDays": 7, "SecretId": SECRET_ARN}


def test_secrets_manager_failure_is_sanitized(monkeypatch: pytest.MonkeyPatch) -> None:
    async def immediate(function, *args):
        return function(*args)

    monkeypatch.setattr(asyncio, "to_thread", immediate)
    transport = RecordingTransport(
        status=400,
        response=b'{"message":"database-password must-not-leak"}',
    )
    store = AwsConnectionSecretStore(settings(), credentials=FakeCredentials(), transport=transport)

    with pytest.raises(ConnectionSecretStoreUnavailable) as caught:
        asyncio.run(store.create(ORG_ID, PROJECT_ID, CONNECTION_ID, "reader", "database-password"))
    assert "database-password" not in str(caught.value)
    assert "must-not-leak" not in str(caught.value)


def test_user_dataset_credentials_use_an_immutable_versioned_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def immediate(function, *args):
        return function(*args)

    monkeypatch.setattr(asyncio, "to_thread", immediate)
    transport = RecordingTransport()
    store = AwsConnectionSecretStore(settings(), credentials=FakeCredentials(), transport=transport)
    owner_user_id = UUID("20000000-0000-4000-8000-000000000477")
    credential_version_id = uuid4()

    result = asyncio.run(
        store.create_user_dataset_connection(
            ORG_ID,
            owner_user_id,
            CONNECTION_ID,
            credential_version_id,
            {"external_id": "opaque-external-id"},
        )
    )

    body = json.loads(transport.calls[0][2])
    assert body["Name"] == (
        f"opengeo/test/user-connections/{ORG_ID}/{owner_user_id}/"
        f"{CONNECTION_ID}/{credential_version_id}"
    )
    assert body["ClientRequestToken"] == str(credential_version_id)
    assert json.loads(body["SecretString"]) == {"external_id": "opaque-external-id"}
    assert result.configured_fields == ("external_id",)
    assert "opaque-external-id" not in json.dumps(transport.calls[0][1])


def test_basemap_browser_key_is_versioned_and_read_only_through_the_scoped_adapter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def immediate(function, *args):
        return function(*args)

    class BrowserKeyTransport(RecordingTransport):
        def call(self, url, headers, body, timeout_seconds):
            self.calls.append((url, headers, body, timeout_seconds))
            if headers["x-amz-target"] == "secretsmanager.CreateSecret":
                return 200, json.dumps({"ARN": BROWSER_SECRET_ARN, "VersionId": "v1"}).encode()
            return 200, json.dumps(
                {"SecretString": json.dumps({"api_key": "client-visible-browser-key"})}
            ).encode()

    monkeypatch.setattr(asyncio, "to_thread", immediate)
    transport = BrowserKeyTransport()
    store = AwsConnectionSecretStore(settings(), credentials=FakeCredentials(), transport=transport)
    owner_user_id = UUID("20000000-0000-4000-8000-000000000478")
    credential_version_id = uuid4()

    stored = asyncio.run(
        store.create_user_basemap_connection(
            ORG_ID,
            owner_user_id,
            CONNECTION_ID,
            credential_version_id,
            "client-visible-browser-key",
        )
    )
    resolved = asyncio.run(store.get_user_basemap_connection_api_key(stored.reference))

    create_body = json.loads(transport.calls[0][2])
    assert create_body["Name"] == (
        f"opengeo/test/browser-connections/{ORG_ID}/{owner_user_id}/"
        f"{CONNECTION_ID}/{credential_version_id}"
    )
    assert create_body["Tags"][-1] == {
        "Key": "opengeo:browser-visible",
        "Value": "true",
    }
    assert json.loads(create_body["SecretString"]) == {"api_key": "client-visible-browser-key"}
    assert stored.configured_fields == ("api_key",)
    assert json.loads(transport.calls[1][2]) == {"SecretId": BROWSER_SECRET_ARN}
    assert resolved == "client-visible-browser-key"
    with pytest.raises(ConnectionSecretStoreUnavailable, match="invalid basemap secret reference"):
        asyncio.run(store.get_user_basemap_connection_api_key(SECRET_ARN))
    with pytest.raises(ConnectionSecretStoreUnavailable, match="invalid basemap secret reference"):
        asyncio.run(
            store.get_user_basemap_connection_api_key(
                BROWSER_SECRET_ARN.replace("111111111111", "222222222222")
            )
        )
    assert len(transport.calls) == 2


def test_versioned_basemap_key_reuses_one_decrypt_until_sixty_second_expiry() -> None:
    clock = [100.0]
    transport = RecordingTransport(
        response=b'{"SecretString":"{\\"api_key\\":\\"browser-key-before\\"}"}',
    )
    store = AwsConnectionSecretStore(
        settings(),
        credentials=FakeCredentials(),
        transport=transport,
        cache_clock=lambda: clock[0],
    )
    reference = versioned_browser_secret()
    for _ in range(10):
        assert (
            asyncio.run(store.get_user_basemap_connection_api_key(reference))
            == "browser-key-before"
        )
    assert len(transport.calls) == 1
    clock[0] = 159.999
    assert asyncio.run(store.get_user_basemap_connection_api_key(reference)) == "browser-key-before"
    transport.response = b'{"SecretString":"{\\"api_key\\":\\"browser-key-after\\"}"}'
    clock[0] = 160.0
    assert asyncio.run(store.get_user_basemap_connection_api_key(reference)) == "browser-key-after"
    assert len(transport.calls) == 2


def test_basemap_key_cache_coalesces_concurrent_exact_version_reads() -> None:
    transport = RecordingTransport(
        response=b'{"SecretString":"{\\"api_key\\":\\"browser-key-shared\\"}"}',
    )
    store = AwsConnectionSecretStore(settings(), credentials=FakeCredentials(), transport=transport)

    async def read_concurrently():
        return await asyncio.gather(
            *[
                store.get_user_basemap_connection_api_key(versioned_browser_secret())
                for _ in range(12)
            ]
        )

    assert asyncio.run(read_concurrently()) == ["browser-key-shared"] * 12
    assert len(transport.calls) == 1


def test_basemap_cache_keeps_exact_owner_and_rotation_versions_separate() -> None:
    transport = RecordingTransport(
        response=b'{"SecretString":"{\\"api_key\\":\\"first-browser-key\\"}"}',
    )
    store = AwsConnectionSecretStore(settings(), credentials=FakeCredentials(), transport=transport)
    first = versioned_browser_secret()
    assert asyncio.run(store.get_user_basemap_connection_api_key(first)) == "first-browser-key"
    transport.response = b'{"SecretString":"{\\"api_key\\":\\"other-browser-key\\"}"}'
    for reference in (versioned_browser_secret(version=2), versioned_browser_secret(owner=479)):
        assert (
            asyncio.run(store.get_user_basemap_connection_api_key(reference)) == "other-browser-key"
        )
    assert asyncio.run(store.get_user_basemap_connection_api_key(first)) == "first-browser-key"
    assert len(transport.calls) == 3


def test_basemap_key_cache_bounds_entries_and_discards_cached_versions() -> None:
    class KeyTransport(RecordingTransport):
        def call(self, url, headers, body, timeout_seconds):
            self.calls.append((url, headers, body, timeout_seconds))
            if headers["x-amz-target"] == "secretsmanager.DeleteSecret":
                return 200, b"{}"
            return 200, b'{"SecretString":"{\\"api_key\\":\\"client-browser-key\\"}"}'

    transport = KeyTransport()
    clock = [0.0]
    store = AwsConnectionSecretStore(
        settings(),
        credentials=FakeCredentials(),
        transport=transport,
        cache_clock=lambda: clock[0],
    )
    for version in range(1, 130):
        clock[0] += 0.01
        asyncio.run(store.get_user_basemap_connection_api_key(versioned_browser_secret(version)))
    assert len(store._browser_key_cache) == 128
    assert versioned_browser_secret(1) not in store._browser_key_cache
    latest = versioned_browser_secret(129)
    asyncio.run(store.discard(latest))
    assert latest not in store._browser_key_cache
    asyncio.run(store.get_user_basemap_connection_api_key(latest))
    assert len(transport.calls) == 131


@pytest.mark.parametrize(
    "status,response",
    [
        (503, b"{}"),
        (200, b'{"SecretString":"{\\"api_key\\":\\"short\\"}"}'),
    ],
)
def test_basemap_key_cache_never_retains_failed_reads(status: int, response: bytes) -> None:
    transport = RecordingTransport(status=status, response=response)
    store = AwsConnectionSecretStore(settings(), credentials=FakeCredentials(), transport=transport)
    for _ in range(2):
        with pytest.raises(ConnectionSecretStoreUnavailable):
            asyncio.run(store.get_user_basemap_connection_api_key(versioned_browser_secret()))
    assert len(transport.calls) == 2
    assert store._browser_key_cache == {}


def test_unversioned_basemap_secret_retains_uncached_behavior() -> None:
    transport = RecordingTransport(
        response=b'{"SecretString":"{\\"api_key\\":\\"client-browser-key\\"}"}',
    )
    store = AwsConnectionSecretStore(settings(), credentials=FakeCredentials(), transport=transport)
    for _ in range(3):
        asyncio.run(store.get_user_basemap_connection_api_key(BROWSER_SECRET_ARN))
    assert len(transport.calls) == 3
    assert store._browser_key_cache == {}


def test_connection_draft_repr_never_exposes_credentials() -> None:
    draft = ExternalConnectionDraft(
        provider="postgresql",
        display_name="Warehouse",
        endpoint_host="gis.example.test",
        endpoint_port=5432,
        database_name="research",
        allowed_schemas=("public",),
        read_only=True,
        tls_mode="verify_full",
        network_mode="public_internet",
        username="reader",
        password="database-password",
    )
    assert "reader" not in repr(draft)
    assert "database-password" not in repr(draft)


class AuthorizationTransaction:
    def __init__(self, project_role: str) -> None:
        self.project_role = project_role

    async def fetch_one(self, statement, parameters=()):
        del parameters
        if "FROM app.organization_memberships" in statement:
            return ("member",)
        if "FROM app.projects project" in statement:
            return (PROJECT_ID, self.project_role)
        raise AssertionError(statement)

    async def fetch_all(self, statement, parameters=()):
        raise AssertionError((statement, parameters))

    async def execute(self, statement, parameters=()):
        raise AssertionError((statement, parameters))


class FailingSecondTransactionExecutor:
    def __init__(self, project_role: str = "owner") -> None:
        self.project_role = project_role
        self.calls = 0

    async def run(self, context, operation):
        del context
        self.calls += 1
        if self.calls == 2:
            raise TenantDatabaseUnavailable("database failed after secret creation")
        return await operation(AuthorizationTransaction(self.project_role))

    async def fetch_one(self, context, statement, parameters=()):
        raise AssertionError((context, statement, parameters))


class RecordingSecretStore:
    def __init__(self) -> None:
        self.created = 0
        self.discarded: list[str] = []

    async def create(
        self, organization_id, project_id, connection_id, username, password
    ) -> StoredConnectionSecret:
        del organization_id, project_id, connection_id, username, password
        self.created += 1
        return StoredConnectionSecret(SECRET_ARN, ("password", "username"))

    async def discard(self, reference: str) -> None:
        self.discarded.append(reference)


def connection_draft() -> ExternalConnectionDraft:
    return ExternalConnectionDraft(
        provider="postgresql",
        display_name="Warehouse",
        endpoint_host="gis.example.test",
        endpoint_port=5432,
        database_name="research",
        allowed_schemas=("public",),
        read_only=True,
        tls_mode="verify_full",
        network_mode="public_internet",
        username="reader",
        password="database-password",
    )


def test_repository_reauthorizes_and_discards_secret_after_database_failure() -> None:
    executor = FailingSecondTransactionExecutor()
    secret_store = RecordingSecretStore()
    repository = PostgresExternalConnectionRepository(executor, secret_store)

    with pytest.raises(ConnectionStoreUnavailable):
        asyncio.run(
            repository.create_connection(
                TenantContext(ORG_ID, ORG_ID),
                PROJECT_ID,
                connection_draft(),
                "request-1",
            )
        )

    assert executor.calls == 2
    assert secret_store.created == 1
    assert secret_store.discarded == [SECRET_ARN]


def test_repository_checks_manage_authority_before_writing_a_secret() -> None:
    executor = FailingSecondTransactionExecutor(project_role="viewer")
    secret_store = RecordingSecretStore()
    repository = PostgresExternalConnectionRepository(executor, secret_store)

    with pytest.raises(ConnectionAccessDenied):
        asyncio.run(
            repository.create_connection(
                TenantContext(ORG_ID, ORG_ID),
                PROJECT_ID,
                connection_draft(),
                "request-1",
            )
        )

    assert executor.calls == 1
    assert secret_store.created == 0
    assert secret_store.discarded == []
