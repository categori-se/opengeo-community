import asyncio
from datetime import UTC, datetime
from uuid import UUID

import pytest

from opengeo_api.connections import StoredConnectionSecret
from opengeo_api.tenant_database import TenantContext
from opengeo_api.user_connections import (
    PostgresUserDatasetConnectionRepository,
    UserConnectionConflict,
    UserDatasetConnectionDraft,
    UserDatasetCredentials,
)

USER_ID = UUID("20000000-0000-4000-8000-000000000051")
ORG_ID = UUID("10000000-0000-4000-8000-000000000051")
CONNECTION_ID = UUID("a0000000-0000-4000-8000-000000000051")
VERIFICATION_ID = UUID("b0000000-0000-4000-8000-000000000051")
NOW = datetime(2026, 8, 24, 16, tzinfo=UTC)
OLD_SECRET = (
    "arn:aws:secretsmanager:us-east-1:222222222222:secret:opengeo/dev/user-connections/old-AbCd12"
)
NEW_SECRET = (
    "arn:aws:secretsmanager:us-east-1:222222222222:secret:opengeo/dev/user-connections/new-AbCd12"
)


def connection_row(revision: int = 2, target_revision: int = 1, status: str = "unverified"):
    return (
        CONNECTION_ID,
        USER_ID,
        "s3",
        "Geospatial data",
        "example-geodata",
        "us-east-1",
        "",
        "assume_role",
        "arn:aws:iam::222222222222:role/OpenGeoDatasetReader",
        ["external_id"],
        revision,
        target_revision,
        status,
        None,
        None,
        NOW,
        NOW,
    )


def verification_row():
    return (
        VERIFICATION_ID,
        CONNECTION_ID,
        1,
        2,
        "queued",
        0,
        False,
        False,
        False,
        0,
        None,
        None,
        USER_ID,
        NOW,
        None,
        None,
    )


class Transaction:
    def __init__(self, answers) -> None:
        self.answers = list(answers)
        self.calls = []

    async def fetch_one(self, statement, parameters=()):
        self.calls.append(("one", statement, parameters))
        if "FROM app.organization_memberships" in statement:
            return ("member",)
        if not self.answers:
            raise AssertionError(statement)
        return self.answers.pop(0)

    async def fetch_all(self, statement, parameters=()):
        raise AssertionError((statement, parameters))

    async def execute(self, statement, parameters=()):
        self.calls.append(("execute", statement, parameters))


class ListTransaction(Transaction):
    def __init__(self, answers, rows) -> None:
        super().__init__(answers)
        self.rows = rows

    async def fetch_all(self, statement, parameters=()):
        self.calls.append(("all", statement, parameters))
        return self.rows


class Executor:
    def __init__(self, *transactions: Transaction) -> None:
        self.transactions = list(transactions)

    async def run(self, context, operation):
        assert context == TenantContext(USER_ID, ORG_ID)
        return await operation(self.transactions.pop(0))


class SecretStore:
    def __init__(self) -> None:
        self.created = []
        self.discarded = []

    async def create_user_dataset_connection(
        self,
        organization_id,
        owner_user_id,
        connection_id,
        credential_version_id,
        credentials,
    ):
        self.created.append(
            (
                organization_id,
                owner_user_id,
                connection_id,
                credential_version_id,
                dict(credentials),
            )
        )
        return StoredConnectionSecret(NEW_SECRET, ("external_id",))

    async def discard(self, reference):
        self.discarded.append(reference)


def test_create_persists_the_exact_non_secret_s3_target_and_audit_event() -> None:
    transaction = Transaction([connection_row(revision=0)])
    repository = PostgresUserDatasetConnectionRepository(Executor(transaction), SecretStore())

    result = asyncio.run(
        repository.create_connection(
            TenantContext(USER_ID, ORG_ID),
            UserDatasetConnectionDraft(
                provider="s3",
                display_name="Geospatial data",
                bucket_name="example-geodata",
                region_name="us-east-1",
                object_prefix="",
                credential_mode="assume_role",
                role_arn="arn:aws:iam::222222222222:role/OpenGeoDatasetReader",
            ),
            "request-create-51",
        )
    )

    insert = next(
        call
        for call in transaction.calls
        if call[0] == "one" and "INSERT INTO app.user_dataset_connections" in call[1]
    )
    assert insert[2][1:] == (
        ORG_ID,
        USER_ID,
        "s3",
        "Geospatial data",
        "example-geodata",
        "us-east-1",
        "",
        "assume_role",
        "arn:aws:iam::222222222222:role/OpenGeoDatasetReader",
        "unverified",
    )
    assert len(insert[2]) == 11
    audit = next(call for call in transaction.calls if call[0] == "execute")
    assert "user_dataset_connection.created" in audit[2]
    assert result.bucket_name == "example-geodata"


def test_credential_rotation_commits_new_opaque_reference_then_recovers_old_secret() -> None:
    prepare = Transaction([("assume_role", OLD_SECRET, 1)])
    commit = Transaction([(True,), connection_row()])
    store = SecretStore()
    repository = PostgresUserDatasetConnectionRepository(Executor(prepare, commit), store)
    credentials = UserDatasetCredentials({"external_id": "opaque-external-id"})

    result = asyncio.run(
        repository.rotate_credentials(
            TenantContext(USER_ID, ORG_ID),
            CONNECTION_ID,
            1,
            credentials,
            "request-51",
        )
    )

    assert result.credential_revision == 2
    assert result.configured_secret_fields == ("external_id",)
    assert store.created[0][0:3] == (ORG_ID, USER_ID, CONNECTION_ID)
    assert store.created[0][4] == {"external_id": "opaque-external-id"}
    assert store.discarded == [OLD_SECRET]
    assert "opaque-external-id" not in repr(credentials)
    audit = next(call for call in commit.calls if call[0] == "execute")
    assert "user_dataset_connection.credentials_replaced" in audit[2]


def test_stale_rotation_is_rejected_before_secret_storage() -> None:
    store = SecretStore()
    repository = PostgresUserDatasetConnectionRepository(
        Executor(Transaction([("assume_role", OLD_SECRET, 2)])), store
    )

    with pytest.raises(UserConnectionConflict, match="stale_credential_revision"):
        asyncio.run(
            repository.rotate_credentials(
                TenantContext(USER_ID, ORG_ID),
                CONNECTION_ID,
                1,
                UserDatasetCredentials({"external_id": "opaque-external-id"}),
                "request-51",
            )
        )

    assert store.created == []
    assert store.discarded == []


def test_failed_optimistic_commit_recovers_new_secret_and_keeps_old_secret() -> None:
    store = SecretStore()
    repository = PostgresUserDatasetConnectionRepository(
        Executor(
            Transaction([("assume_role", OLD_SECRET, 1)]),
            Transaction([(False,)]),
        ),
        store,
    )

    with pytest.raises(UserConnectionConflict, match="stale_credential_revision"):
        asyncio.run(
            repository.rotate_credentials(
                TenantContext(USER_ID, ORG_ID),
                CONNECTION_ID,
                1,
                UserDatasetCredentials({"external_id": "opaque-external-id"}),
                "request-51",
            )
        )

    assert len(store.created) == 1
    assert store.discarded == [NEW_SECRET]


def test_requests_and_lists_secret_free_leased_verification_attempts() -> None:
    request_transaction = Transaction(
        [
            connection_row(),
            (VERIFICATION_ID, True),
            verification_row(),
        ]
    )
    list_transaction = ListTransaction([connection_row()], [verification_row()])
    repository = PostgresUserDatasetConnectionRepository(
        Executor(request_transaction, list_transaction), SecretStore()
    )

    submission = asyncio.run(
        repository.request_verification(
            TenantContext(USER_ID, ORG_ID),
            CONNECTION_ID,
            "request-verification-52",
        )
    )
    records = asyncio.run(
        repository.list_verifications(TenantContext(USER_ID, ORG_ID), CONNECTION_ID)
    )

    assert submission.created is True
    assert submission.verification.verification_id == VERIFICATION_ID
    assert records == (submission.verification,)
    request_call = next(
        call
        for call in request_transaction.calls
        if call[0] == "one" and "request_user_dataset_connection_verification" in call[1]
    )
    assert request_call[2] == (CONNECTION_ID, USER_ID, "request-verification-52")
    serialized = repr(submission) + repr(records)
    assert "secret_arn" not in serialized
    assert "external_id" not in serialized


def test_overview_requires_current_revisions_for_healthy_and_lists_visible_projects() -> None:
    project_id = UUID("50000000-0000-4000-8000-000000000051")
    binding_id = UUID("a1000000-0000-4000-8000-000000000051")
    succeeded = list(verification_row())
    succeeded[4] = "succeeded"
    succeeded[6:10] = [True, True, True, 1]
    succeeded[11] = 740
    succeeded[14] = NOW
    succeeded[15] = NOW
    transaction = ListTransaction(
        [connection_row(status="verified"), tuple(succeeded)],
        [(binding_id, project_id, "Field atlas", "active", "Archive source", NOW)],
    )
    repository = PostgresUserDatasetConnectionRepository(Executor(transaction), SecretStore())

    overview = asyncio.run(
        repository.get_my_connection_overview(TenantContext(USER_ID, ORG_ID), CONNECTION_ID)
    )

    assert overview.health == "healthy"
    assert overview.target_revision == 1
    assert overview.credential_revision == 2
    assert overview.project_references[0].project_id == project_id
    assert overview.project_references[0].project_name == "Field atlas"
    binding_query = next(
        call
        for call in transaction.calls
        if call[0] == "all" and "project_dataset_connection_bindings" in call[1]
    )
    assert "JOIN app.projects" in binding_query[1]
    assert "LIMIT 250" in binding_query[1]


def test_overview_marks_a_stale_success_as_needing_verification() -> None:
    stale = list(verification_row())
    stale[2] = 1
    stale[3] = 1
    stale[4] = "succeeded"
    stale[6:10] = [True, True, True, 1]
    stale[11] = 500
    stale[14] = NOW
    stale[15] = NOW
    transaction = ListTransaction(
        [connection_row(target_revision=2), tuple(stale)],
        [],
    )
    repository = PostgresUserDatasetConnectionRepository(Executor(transaction), SecretStore())

    overview = asyncio.run(
        repository.get_my_connection_overview(TenantContext(USER_ID, ORG_ID), CONNECTION_ID)
    )

    assert overview.health == "needs_verification"
    assert overview.latest_verification is not None
    assert overview.latest_verification.target_revision == 1


def test_connection_health_is_fail_closed_across_nonhealthy_states() -> None:
    repository = PostgresUserDatasetConnectionRepository(Executor(), SecretStore())
    current = repository._connection(connection_row(status="unverified"), USER_ID)
    queued = repository._verification(verification_row())
    failed_row = list(verification_row())
    failed_row[4] = "failed"
    failed_row[10] = "provider_denied"
    failed_row[14] = NOW
    failed_row[15] = NOW
    failed = repository._verification(tuple(failed_row))

    assert repository._connection_health(current, None) == "needs_verification"
    assert repository._connection_health(current, queued) == "checking"
    assert repository._connection_health(current, failed) == "check_failed"
    assert (
        repository._connection_health(
            repository._connection(connection_row(status="disabled"), USER_ID), queued
        )
        == "disabled"
    )

    access_key_row = list(connection_row(revision=0))
    access_key_row[7] = "access_key"
    access_key_row[8] = None
    access_key_row[9] = []
    assert (
        repository._connection_health(repository._connection(tuple(access_key_row), USER_ID), None)
        == "needs_credentials"
    )
