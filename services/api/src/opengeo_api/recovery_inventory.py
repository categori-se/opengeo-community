"""Exact account metadata inventory; no object reads, publication or restore writes."""

import json
import re
from dataclasses import dataclass
from hashlib import sha256
from typing import Any
from uuid import UUID

from opengeo_api.tenant_database import (
    TenantContext,
    TenantReadonlySnapshotExecutor,
    TenantTransaction,
)

_CHUNK_BYTES = 24_576
_PAGE_CHUNKS = 20
_MAX_BYTES = 8_388_608
_MAX_PAGES = 18
_DECLARE_SQL = """
DECLARE opengeo_account_recovery_inventory NO SCROLL CURSOR FOR
SELECT snapshot_id, organization_id, total_bytes, checksum_sha256, chunk_index, body
FROM app.capture_account_recovery_inventory()
ORDER BY chunk_index
"""
_FETCH_SQL = "FETCH FORWARD 20 FROM opengeo_account_recovery_inventory"
_CLOSE_SQL = "CLOSE opengeo_account_recovery_inventory"


class RecoveryInventoryInvalid(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class AccountRecoveryInventory:
    organization_id: UUID
    snapshot_id: str
    checksum_sha256: str
    body: bytes


class PostgresRecoveryInventoryRepository:
    def __init__(self, executor: TenantReadonlySnapshotExecutor) -> None:
        self._executor = executor

    async def capture(self, context: TenantContext) -> AccountRecoveryInventory:
        """The database function checks current admin authority inside the snapshot."""

        async def read(transaction: TenantTransaction) -> AccountRecoveryInventory:
            header: tuple[str, UUID, int, str] | None = None
            chunks: list[bytes] = []
            for _ in range(_MAX_PAGES):
                rows = await transaction.fetch_all(_FETCH_SQL)
                if not rows or len(rows) > _PAGE_CHUNKS:
                    raise RecoveryInventoryInvalid("recovery_inventory_incomplete")
                for row in rows:
                    if len(row) != 6:
                        raise RecoveryInventoryInvalid("recovery_inventory_invalid_chunk")
                    snapshot, account, total, checksum, index, body = row
                    if (
                        not isinstance(snapshot, str)
                        or re.fullmatch(r"[0-9]+:[0-9]+:[0-9,]*", snapshot) is None
                        or type(total) is not int
                        or not 1 <= total <= _MAX_BYTES
                        or not isinstance(checksum, str)
                        or re.fullmatch(r"[0-9a-f]{64}", checksum) is None
                        or type(index) is not int
                        or index != len(chunks)
                        or not isinstance(body, bytes | memoryview)
                    ):
                        raise RecoveryInventoryInvalid("recovery_inventory_invalid_chunk")
                    try:
                        account_id = UUID(str(account))
                    except ValueError as error:
                        raise RecoveryInventoryInvalid(
                            "recovery_inventory_invalid_account"
                        ) from error
                    current_header = (snapshot, account_id, total, checksum)
                    if account_id != context.organization_id or (
                        header is not None and header != current_header
                    ):
                        raise RecoveryInventoryInvalid("recovery_inventory_snapshot_changed")
                    header = current_header
                    expected_bytes = min(_CHUNK_BYTES, total - index * _CHUNK_BYTES)
                    if expected_bytes <= 0 or len(body) != expected_bytes:
                        raise RecoveryInventoryInvalid("recovery_inventory_invalid_chunk")
                    chunks.append(bytes(body))
                assert header is not None
                if len(chunks) * _CHUNK_BYTES >= header[2]:
                    result = b"".join(chunks)
                    if len(result) != header[2] or sha256(result).hexdigest() != header[3]:
                        raise RecoveryInventoryInvalid("recovery_inventory_checksum_changed")
                    self._check_document(result, context, header[0])
                    return AccountRecoveryInventory(
                        context.organization_id, header[0], header[3], result
                    )
            raise RecoveryInventoryInvalid("recovery_inventory_page_bound")

        async def operation(transaction: TenantTransaction) -> AccountRecoveryInventory:
            # Materialize the fixed bounded capture once, then fetch it without
            # rescanning every account table for every transport page.
            await transaction.execute(_DECLARE_SQL)
            failed = False
            try:
                return await read(transaction)
            except BaseException:
                failed = True
                raise
            finally:
                try:
                    await transaction.execute(_CLOSE_SQL)
                except Exception:
                    # A PostgreSQL error may have already aborted the transaction;
                    # the executor rolls it back. Keep that original capture error.
                    if not failed:
                        raise

        return await self._executor.run_readonly_snapshot(context, operation)

    @staticmethod
    def _check_document(body: bytes, context: TenantContext, snapshot: str) -> None:
        try:
            document: Any = json.loads(body)
        except (ValueError, UnicodeError) as error:
            raise RecoveryInventoryInvalid("recovery_inventory_invalid_document") from error
        if (
            not isinstance(document, dict)
            or document.get("schema_version") != "opengeo.account-recovery-inventory.1.0.0"
            or document.get("organization_id") != str(context.organization_id)
            or document.get("captured_by") != str(context.user_id)
            or document.get("snapshot_id") != snapshot
            or not isinstance(document.get("tables"), dict)
            or not isinstance(document.get("limits"), dict)
            or document["limits"].get("metadata_inventory_only") is not True
            or document["limits"].get("object_bytes_included") is not False
            or document["limits"].get("credentials_included") is not False
        ):
            raise RecoveryInventoryInvalid("recovery_inventory_invalid_document")
