"""Password-gated viewer grants for one retained portable Artifact edition.

These records never grant Project/Layer access or enter public release listings.
The first slice keeps the existing current-public-source eligibility requirement.
The caller delivers the returned exact object through a short-lived static ticket;
revocation prevents new tickets, not recall of bytes or already-issued tickets.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import secrets
from threading import Semaphore
from typing import TYPE_CHECKING, Any
from uuid import UUID

from opengeo_api.artifact_releases import _public_seal, _target
from opengeo_api.authorization import Action, is_allowed
from opengeo_api.project_artifacts import _edition_manifest
from opengeo_api.rendering import RenderAccessDenied, RenderConflict, RenderNotFound
from opengeo_api.tenant_database import TenantContext, TenantTransaction

if TYPE_CHECKING:
    from opengeo_api.rendering import PostgresRenderRepository

SCRYPT_N = 32_768
SCRYPT_R = 8
SCRYPT_P = 3
SCRYPT_MAXMEM = 67_108_864
MAX_ATTEMPTS = 5
ATTEMPT_WINDOW_MINUTES = 15
_HASH_SLOTS = Semaphore(2)
_FIELDS = "id,artifact_id,version_number,title,created_at,revoked_at"


def _password_valid(password: str) -> bool:
    if not isinstance(password, str) or not 12 <= len(password) <= 128:
        return False
    try:
        password.encode("utf8")
    except UnicodeError:
        return False
    return True


def _derive_password(password: str, salt: bytes) -> bytes:
    # Bound working memory across concurrent shares within this Lambda process.
    with _HASH_SLOTS:
        return hashlib.scrypt(
            password.encode("utf8"),
            salt=salt,
            n=SCRYPT_N,
            r=SCRYPT_R,
            p=SCRYPT_P,
            maxmem=SCRYPT_MAXMEM,
            dklen=32,
        )


def _record(row: tuple[Any, ...]) -> dict[str, Any]:
    return {
        "id": str(row[0]),
        "artifact_id": str(row[1]),
        "version_number": row[2],
        "title": row[3],
        "created_at": row[4].isoformat(),
        "revoked_at": row[5].isoformat() if row[5] is not None else None,
    }


async def _publish_target(
    repository: PostgresRenderRepository,
    tx: TenantTransaction,
    context: TenantContext,
    artifact_id: UUID,
    version: int,
    *,
    seal: bool,
) -> tuple[Any, ...]:
    target = await _target(tx, context, artifact_id, version)
    repository._require(
        Action.RESOURCE_PUBLISH,
        await repository._resource_roles(tx, context, target[2], target[0]),
    )
    if target[10] != "text/html":
        raise RenderConflict("artifact_share_representation_unsupported")
    if seal:
        await _edition_manifest(
            repository, tx, context, target[2], target[0], artifact_id, version
        )
        await _public_seal(tx, context, target)
    return target


async def create_share(
    repository: PostgresRenderRepository,
    context: TenantContext,
    artifact_id: UUID,
    version: int,
    title: str,
    password: str,
    creation_key: UUID | None = None,
) -> dict[str, Any]:
    if not _password_valid(password):
        raise RenderConflict("artifact_share_password_invalid")
    if not isinstance(title, str) or not 1 <= len(title.strip()) <= 200:
        raise RenderConflict("artifact_share_title_invalid")
    if type(version) is not int or not 1 <= version <= 2_147_483_647:
        raise RenderConflict("artifact_share_version_invalid")
    title = title.strip()

    async def preauthorize(tx: TenantTransaction) -> None:
        await _publish_target(repository, tx, context, artifact_id, version, seal=False)

    await repository._run(context, preauthorize)
    # UUID creation keys are high-entropy per-request identities. Tenant/actor
    # binding yields a unique salt, reproducible only for exact-key retries, so
    # concurrent retries can compare slow verifiers without hashing under locks.
    salt = (
        hashlib.sha256(
            f"opengeo.artifact-share.v1/{context.organization_id}/"
            f"{context.user_id}/{creation_key}".encode("ascii")
        ).digest()[:16]
        if creation_key is not None
        else secrets.token_bytes(16)
    )
    verifier = await asyncio.to_thread(_derive_password, password, salt)

    async def operation(tx: TenantTransaction) -> dict[str, Any]:
        await _publish_target(repository, tx, context, artifact_id, version, seal=True)
        if creation_key is not None:
            await tx.fetch_one(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 159))::text",
                (f"{context.organization_id}/{context.user_id}/{creation_key}",),
            )
            previous = await tx.fetch_one(
                f"""SELECT {_FIELDS},password_salt,password_hash
                FROM app.project_artifact_shares
                WHERE organization_id=%s AND created_by=%s AND creation_key=%s""",
                (context.organization_id, context.user_id, creation_key),
            )
            if previous is not None:
                if (
                    previous[1:4] != (artifact_id, version, title)
                    or not hmac.compare_digest(previous[6], salt.hex())
                    or not hmac.compare_digest(previous[7], verifier.hex())
                ):
                    raise RenderConflict("artifact_share_creation_key_conflict")
                if previous[5] is not None:
                    raise RenderConflict("artifact_share_already_revoked")
                return _record(previous)
        row = await tx.fetch_one(
            f"""INSERT INTO app.project_artifact_shares
            (organization_id,artifact_id,version_number,title,password_salt,password_hash,
             created_by,creation_key)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING {_FIELDS}""",
            (
                context.organization_id,
                artifact_id,
                version,
                title,
                salt.hex(),
                verifier.hex(),
                context.user_id,
                creation_key,
            ),
        )
        if row is None:
            raise RenderConflict("artifact_share_insert_failed")
        return _record(row)

    return await repository._run(context, operation)


async def list_shares(
    repository: PostgresRenderRepository,
    context: TenantContext,
    artifact_id: UUID,
    limit: int,
    offset: int,
) -> dict[str, Any]:
    if type(limit) is not int or not 1 <= limit <= 100 or type(offset) is not int or offset < 0:
        raise RenderConflict("artifact_share_pagination_invalid")

    async def operation(tx: TenantTransaction) -> dict[str, Any]:
        target = await tx.fetch_one(
            """SELECT a.resource_id,r.project_id,a.representation
            FROM app.project_artifacts a JOIN app.governed_resources r
              ON r.organization_id=a.organization_id AND r.id=a.resource_id
            WHERE a.organization_id=%s AND a.id=%s""",
            (context.organization_id, artifact_id),
        )
        if target is None:
            raise RenderNotFound("artifact")
        roles = await repository._resource_roles(tx, context, target[1], target[0])
        repository._require(Action.RENDER_READ, roles)
        rows = await tx.fetch_all(
            f"""SELECT {_FIELDS} FROM app.project_artifact_shares
            WHERE organization_id=%s AND artifact_id=%s
            ORDER BY created_at DESC,id DESC LIMIT %s OFFSET %s""",
            (context.organization_id, artifact_id, limit + 1, offset),
        )
        return {
            "can_publish": target[2] == "portable-map-html"
            and is_allowed(Action.RESOURCE_PUBLISH, roles),
            "records": [_record(row) for row in rows[:limit]],
            "has_more": len(rows) > limit,
        }

    return await repository._run(context, operation)


async def revoke_share(
    repository: PostgresRenderRepository, context: TenantContext, share_id: UUID
) -> dict[str, Any]:
    async def operation(tx: TenantTransaction) -> dict[str, Any]:
        row = await tx.fetch_one(
            """SELECT a.resource_id,r.project_id,share.revoked_at
            FROM app.project_artifact_shares share
            JOIN app.project_artifacts a ON a.organization_id=share.organization_id
              AND a.id=share.artifact_id
            JOIN app.governed_resources r ON r.organization_id=a.organization_id
              AND r.id=a.resource_id
            WHERE share.organization_id=%s AND share.id=%s FOR UPDATE OF share""",
            (context.organization_id, share_id),
        )
        if row is None:
            raise RenderNotFound("artifact_share")
        repository._require(
            Action.RESOURCE_PUBLISH,
            await repository._resource_roles(tx, context, row[1], row[0]),
        )
        if row[2] is None:
            await tx.execute(
                """UPDATE app.project_artifact_shares
                SET revoked_at=clock_timestamp(),revoked_by=%s
                WHERE organization_id=%s AND id=%s""",
                (context.user_id, context.organization_id, share_id),
            )
        return {"id": str(share_id), "revoked": True}

    return await repository._run(context, operation)


async def unlock_share(
    repository: PostgresRenderRepository,
    organization_id: UUID,
    share_id: UUID,
    password: str,
) -> tuple[dict[str, Any], tuple[Any, ...]]:
    if not _password_valid(password):
        raise RenderNotFound("artifact_share")
    context = TenantContext(UUID(int=0), organization_id)

    async def admit(tx: TenantTransaction) -> tuple[Any, ...]:
        row = await tx.fetch_one(
            f"""SELECT {_FIELDS},password_salt,password_hash
            FROM app.project_artifact_shares
            WHERE organization_id=%s AND id=%s AND revoked_at IS NULL""",
            (organization_id, share_id),
        )
        if row is None:
            raise RenderNotFound("artifact_share")
        admitted = await tx.fetch_one(
            """INSERT INTO app.project_artifact_share_attempts
              (organization_id,share_id,window_started_at,attempt_count)
            SELECT organization_id,id,clock_timestamp(),1
            FROM app.project_artifact_shares
            WHERE organization_id=%s AND id=%s AND revoked_at IS NULL
            ON CONFLICT (organization_id,share_id) DO UPDATE
            SET window_started_at=CASE
                  WHEN app.project_artifact_share_attempts.window_started_at
                    <= clock_timestamp()-interval '15 minutes'
                  THEN clock_timestamp()
                  ELSE app.project_artifact_share_attempts.window_started_at END,
                attempt_count=CASE
                  WHEN app.project_artifact_share_attempts.window_started_at
                    <= clock_timestamp()-interval '15 minutes'
                  THEN 1 ELSE app.project_artifact_share_attempts.attempt_count+1 END
            WHERE app.project_artifact_share_attempts.window_started_at
                <= clock_timestamp()-interval '15 minutes'
              OR app.project_artifact_share_attempts.attempt_count<5
            RETURNING attempt_count""",
            (organization_id, share_id),
        )
        if admitted is None:
            active = await tx.fetch_one(
                """SELECT id FROM app.project_artifact_shares
                WHERE organization_id=%s AND id=%s AND revoked_at IS NULL""",
                (organization_id, share_id),
            )
            if active is None:
                raise RenderNotFound("artifact_share")
            raise RenderConflict("artifact_share_rate_limited")
        return row

    row = await repository._run(context, admit)
    # Admission commits before this slow work; a wrong password cannot roll its
    # attempt back, and no transaction/row lock is held while scrypt runs.
    verifier = await asyncio.to_thread(_derive_password, password, bytes.fromhex(row[6]))
    if not hmac.compare_digest(verifier.hex(), row[7]):
        raise RenderNotFound("artifact_share")

    return await recheck_share(repository, organization_id, share_id)


async def recheck_share(
    repository: PostgresRenderRepository,
    organization_id: UUID,
    share_id: UUID,
) -> tuple[dict[str, Any], tuple[Any, ...]]:
    """Recheck an already authenticated grant after asynchronous ticket signing.

    This is an internal delivery check, not an anonymous access endpoint. It
    neither verifies a password nor reserves another attempt.
    """
    context = TenantContext(UUID(int=0), organization_id)

    async def resolve(tx: TenantTransaction) -> tuple[dict[str, Any], tuple[Any, ...]]:
        current = await tx.fetch_one(
            f"""SELECT {_FIELDS} FROM app.project_artifact_shares
            WHERE organization_id=%s AND id=%s AND revoked_at IS NULL""",
            (organization_id, share_id),
        )
        if current is None:
            raise RenderNotFound("artifact_share")
        try:
            target = await _target(tx, context, current[1], current[2])
            if target[10] != "text/html":
                raise RenderNotFound("artifact_share")
            await _public_seal(tx, context, target)
        except (RenderAccessDenied, RenderConflict, RenderNotFound):
            raise RenderNotFound("artifact_share") from None
        return _record(current), target

    return await repository._run(context, resolve)
