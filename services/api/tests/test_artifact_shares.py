"""Focused repository boundary checks; SQL/RLS acceptance remains separate."""

import asyncio
import hashlib
from datetime import UTC, datetime
from uuid import UUID

import pytest

from opengeo_api import artifact_shares as shares
from opengeo_api.authorization import Roles
from opengeo_api.rendering import (
    PostgresRenderRepository,
    RenderAccessDenied,
    RenderConflict,
    RenderNotFound,
)
from opengeo_api.tenant_database import TenantContext

ORG = UUID(int=15901)
USER = UUID(int=15902)
ARTIFACT = UUID(int=15903)
SHARE = UUID(int=15904)
KEY = UUID(int=15905)
RESOURCE = UUID(int=15906)
WORKSPACE = UUID(int=15907)
CONTEXT = TenantContext(USER, ORG)
PASSWORD = "one secret password"
CREATED = datetime(2026, 10, 7, tzinfo=UTC)
ROW = (SHARE, ARTIFACT, 3, "Map viewer", CREATED, None)
TARGET = (
    RESOURCE,
    UUID(int=15908),
    WORKSPACE,
    None,
    None,
    UUID(int=15909),
    "completed",
    "source.opengeo.tools",
    "organizations/pinned/artifacts/map.html",
    "exact-s3-version",
    "text/html",
    1024,
    "b" * 64,
)


class Transaction:
    def __init__(self, one=(), many=()):
        self.one = list(one)
        self.many = list(many)
        self.queries = []
        self.executions = []

    async def fetch_one(self, statement, parameters=()):
        self.queries.append((statement, parameters))
        assert self.one, f"Unexpected fetch: {statement}"
        return self.one.pop(0)

    async def fetch_all(self, statement, parameters=()):
        self.queries.append((statement, parameters))
        return self.many.pop(0)

    async def execute(self, statement, parameters=()):
        self.executions.append((statement, parameters))
        return 1


class Repository:
    _require = staticmethod(PostgresRenderRepository._require)

    def __init__(self, transactions, roles=None):
        self.transactions = list(transactions)
        self.roles = roles or Roles("member", project="owner")
        self.active = False
        self.commits = 0
        self.contexts = []

    async def _run(self, context, operation):
        self.contexts.append(context)
        transaction = self.transactions.pop(0)
        self.active = True
        try:
            result = await operation(transaction)
            self.commits += 1
            return result
        finally:
            self.active = False

    async def _resource_roles(self, tx, context, workspace, resource):
        assert (workspace, resource) == (WORKSPACE, RESOURCE)
        return self.roles


@pytest.fixture
def boundary(monkeypatch):
    calls = []

    async def target(tx, context, artifact_id, version):
        assert (artifact_id, version) == (ARTIFACT, 3)
        calls.append(("target", context))
        return TARGET

    async def manifest(repository, tx, context, workspace, resource, artifact_id, version):
        assert (workspace, resource, artifact_id, version) == (WORKSPACE, RESOURCE, ARTIFACT, 3)
        calls.append(("private-manifest", context))

    async def public_seal(tx, context, output):
        assert output == TARGET
        calls.append(("public-seal", context))

    monkeypatch.setattr(shares, "_target", target)
    monkeypatch.setattr(shares, "_edition_manifest", manifest)
    monkeypatch.setattr(shares, "_public_seal", public_seal)
    return calls


@pytest.fixture
def derive(monkeypatch):
    # Most checks concern admission/authorization ordering, independently of
    # scrypt speed. A separate test uses the exact production slow verifier.
    calls = []

    def check(password, salt):
        calls.append((password, salt))
        return hashlib.sha256(password.encode() + salt).digest()

    monkeypatch.setattr(shares, "_derive_password", check)
    return calls


def stored_row(password=PASSWORD):
    salt = bytes(range(16))
    return (*ROW, salt.hex(), shares._derive_password(password, salt).hex())


def test_real_scrypt_is_salted_and_parameters_and_memory_are_bounded():
    first = shares._derive_password(PASSWORD, bytes(range(16)))
    assert len(first) == 32
    assert first == shares._derive_password(PASSWORD, bytes(range(16)))
    assert first != shares._derive_password(PASSWORD, bytes(range(1, 17)))
    assert (shares.SCRYPT_N, shares.SCRYPT_R, shares.SCRYPT_P) == (32768, 8, 3)
    assert shares.SCRYPT_MAXMEM == 64 * 1024 * 1024


def test_create_requires_publisher_before_hash_and_only_portable_html(
    boundary, derive, monkeypatch
):
    repository = Repository([Transaction()], Roles("member", project="viewer"))
    with pytest.raises(RenderAccessDenied):
        asyncio.run(shares.create_share(repository, CONTEXT, ARTIFACT, 3, ROW[3], PASSWORD))
    assert not derive

    async def image_target(tx, context, artifact_id, version):
        return (*TARGET[:10], "image/png", *TARGET[11:])

    monkeypatch.setattr(shares, "_target", image_target)
    with pytest.raises(RenderConflict, match="artifact_share_representation_unsupported"):
        asyncio.run(
            shares.create_share(Repository([Transaction()]), CONTEXT, ARTIFACT, 3, ROW[3], PASSWORD)
        )
    assert not derive


@pytest.mark.parametrize("password", ["too short", "a" * 129, "\ud800" * 12])
def test_password_bounds_reject_before_database_or_hash(password, derive):
    repository = Repository([])
    with pytest.raises(RenderConflict, match="artifact_share_password_invalid"):
        asyncio.run(shares.create_share(repository, CONTEXT, ARTIFACT, 3, ROW[3], password))
    with pytest.raises(RenderNotFound, match="artifact_share"):
        asyncio.run(shares.unlock_share(repository, ORG, SHARE, password))
    assert not repository.contexts and not derive


def test_create_rechecks_sources_and_never_returns_password_material(boundary, derive):
    insert = Transaction([None, None, ROW])
    repository = Repository([Transaction(), insert])
    result = asyncio.run(
        shares.create_share(repository, CONTEXT, ARTIFACT, 3, ROW[3], PASSWORD, KEY)
    )
    assert result == {
        "id": str(SHARE),
        "artifact_id": str(ARTIFACT),
        "version_number": 3,
        "title": ROW[3],
        "created_at": CREATED.isoformat(),
        "revoked_at": None,
    }
    assert PASSWORD not in repr(insert.queries) and PASSWORD not in repr(result)
    parameters = insert.queries[-1][1]
    assert len(parameters[4]) == 32 and len(parameters[5]) == 64
    assert [name for name, _ in boundary] == ["target", "target", "private-manifest", "public-seal"]
    assert len(derive) == 1


def test_same_creation_key_reuses_only_exact_password_and_intent(boundary, derive):
    inserted = Transaction([None, None, ROW])
    asyncio.run(
        shares.create_share(
            Repository([Transaction(), inserted]), CONTEXT, ARTIFACT, 3, ROW[3], PASSWORD, KEY
        )
    )
    verifier = inserted.queries[-1][1]
    existing = (*ROW, verifier[4], verifier[5])
    same = Transaction([None, existing])
    result = asyncio.run(
        shares.create_share(
            Repository([Transaction(), same]), CONTEXT, ARTIFACT, 3, ROW[3], PASSWORD, KEY
        )
    )
    assert result["id"] == str(SHARE)
    assert not any("INSERT" in sql for sql, _ in same.queries)
    for password, title in [("a changed password", ROW[3]), (PASSWORD, "Changed title")]:
        with pytest.raises(RenderConflict, match="artifact_share_creation_key_conflict"):
            asyncio.run(
                shares.create_share(
                    Repository([Transaction(), Transaction([None, existing])]),
                    CONTEXT,
                    ARTIFACT,
                    3,
                    title,
                    password,
                    KEY,
                )
            )
    revoked = (*existing[:5], CREATED, *existing[6:])
    with pytest.raises(RenderConflict, match="artifact_share_already_revoked"):
        asyncio.run(
            shares.create_share(
                Repository([Transaction(), Transaction([None, revoked])]),
                CONTEXT,
                ARTIFACT,
                3,
                ROW[3],
                PASSWORD,
                KEY,
            )
        )


def test_source_ineligibility_prevents_creation_and_unlock(boundary, derive, monkeypatch):
    async def withdrawn(tx, context, output):
        raise RenderConflict("artifact_source_not_public")

    monkeypatch.setattr(shares, "_public_seal", withdrawn)
    insertion = Transaction()
    with pytest.raises(RenderConflict, match="artifact_source_not_public"):
        asyncio.run(
            shares.create_share(
                Repository([Transaction(), insertion]), CONTEXT, ARTIFACT, 3, ROW[3], PASSWORD
            )
        )
    assert not insertion.queries
    with pytest.raises(RenderNotFound, match="artifact_share"):
        asyncio.run(
            shares.unlock_share(
                Repository([Transaction([stored_row(), (1,)]), Transaction([ROW])]),
                ORG,
                SHARE,
                PASSWORD,
            )
        )


def test_attempt_commits_before_hash_and_success_returns_only_exact_output(
    boundary, derive, monkeypatch
):
    stored = stored_row()
    admission = Transaction([stored, (1,)])
    repository = Repository([admission, Transaction([ROW])])
    original = shares._derive_password

    def unlocked(password, salt):
        assert repository.commits == 1 and not repository.active
        return original(password, salt)

    monkeypatch.setattr(shares, "_derive_password", unlocked)
    record, output = asyncio.run(shares.unlock_share(repository, ORG, SHARE, PASSWORD))
    assert record["id"] == str(SHARE) and output == TARGET
    assert output[9] == "exact-s3-version"
    assert repository.contexts == [TenantContext(UUID(int=0), ORG)] * 2
    assert admission.queries[1][1] == (ORG, SHARE)
    assert "ON CONFLICT" in admission.queries[1][0]
    assert not any(tx.executions for tx in [admission])
    assert [name for name, _ in boundary] == ["target", "public-seal"]


def test_wrong_password_consumes_admission_and_does_not_resolve_output(boundary, derive):
    stored = stored_row()
    repository = Repository([Transaction([stored, (4,)])])
    with pytest.raises(RenderNotFound, match="artifact_share"):
        asyncio.run(shares.unlock_share(repository, ORG, SHARE, "incorrect password"))
    assert repository.commits == 1 and not boundary


def test_quota_denies_before_hash_and_revoked_or_wrong_account_is_unavailable(boundary, derive):
    stored = stored_row()
    derive.clear()
    with pytest.raises(RenderConflict, match="artifact_share_rate_limited"):
        asyncio.run(
            shares.unlock_share(
                Repository([Transaction([stored, None, (SHARE,)])]), ORG, SHARE, PASSWORD
            )
        )
    assert not derive
    missing = Transaction([None])
    with pytest.raises(RenderNotFound, match="artifact_share"):
        asyncio.run(shares.unlock_share(Repository([missing]), UUID(int=999), SHARE, PASSWORD))
    assert missing.queries[0][1] == (UUID(int=999), SHARE)
    assert not derive and not boundary
    with pytest.raises(RenderNotFound, match="artifact_share"):
        asyncio.run(
            shares.unlock_share(
                Repository([Transaction([stored, None, None])]), ORG, SHARE, PASSWORD
            )
        )


def test_revocation_during_hash_blocks_resolution(boundary, derive):
    with pytest.raises(RenderNotFound, match="artifact_share"):
        asyncio.run(
            shares.unlock_share(
                Repository([Transaction([stored_row(), (1,)]), Transaction([None])]),
                ORG,
                SHARE,
                PASSWORD,
            )
        )
    assert not boundary


def test_post_signing_recheck_has_no_quota_or_hash_and_denies_withdrawal(
    boundary, derive, monkeypatch
):
    resolve = Transaction([ROW])
    record, output = asyncio.run(shares.recheck_share(Repository([resolve]), ORG, SHARE))
    assert record["id"] == str(SHARE) and output == TARGET
    assert len(resolve.queries) == 1 and not derive
    with pytest.raises(RenderNotFound, match="artifact_share"):
        asyncio.run(shares.recheck_share(Repository([Transaction([None])]), ORG, SHARE))

    async def withdrawn(tx, context, output):
        raise RenderConflict("artifact_source_not_public")

    monkeypatch.setattr(shares, "_public_seal", withdrawn)
    with pytest.raises(RenderNotFound, match="artifact_share"):
        asyncio.run(shares.recheck_share(Repository([Transaction([ROW])]), ORG, SHARE))
    assert not derive


def test_history_omits_verifiers_and_revoke_requires_current_publisher(boundary, derive):
    history = Transaction([(RESOURCE, WORKSPACE, "portable-map-html")], [[ROW, ROW]])
    result = asyncio.run(shares.list_shares(Repository([history]), CONTEXT, ARTIFACT, 1, 0))
    assert result["can_publish"] and result["has_more"] and len(result["records"]) == 1
    assert "password" not in repr(result)
    assert history.queries[-1][1] == (ORG, ARTIFACT, 2, 0)
    revoked = Transaction([(RESOURCE, WORKSPACE, None)])
    with pytest.raises(RenderAccessDenied):
        asyncio.run(
            shares.revoke_share(
                Repository([revoked], Roles("member", project="viewer")), CONTEXT, SHARE
            )
        )
    assert not revoked.executions
    active = Transaction([(RESOURCE, WORKSPACE, None)])
    assert asyncio.run(shares.revoke_share(Repository([active]), CONTEXT, SHARE)) == {
        "id": str(SHARE),
        "revoked": True,
    }
    assert active.executions[0][1] == (USER, ORG, SHARE)
    repeated = Transaction([(RESOURCE, WORKSPACE, CREATED)])
    asyncio.run(shares.revoke_share(Repository([repeated]), CONTEXT, SHARE))
    assert not repeated.executions
