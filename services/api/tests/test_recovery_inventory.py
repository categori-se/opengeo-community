import asyncio
import json
from hashlib import sha256
from uuid import UUID

import pytest

from opengeo_api.recovery_inventory import (
    PostgresRecoveryInventoryRepository,
    RecoveryInventoryInvalid,
)
from opengeo_api.tenant_database import TenantContext

CONTEXT = TenantContext(UUID(int=1), UUID(int=2))


def document(padding=0):
    return json.dumps(
        {
            "schema_version": "opengeo.account-recovery-inventory.1.0.0",
            "organization_id": str(CONTEXT.organization_id),
            "captured_by": str(CONTEXT.user_id),
            "snapshot_id": "100:120:110",
            "tables": {},
            "limits": {
                "metadata_inventory_only": True,
                "object_bytes_included": False,
                "credentials_included": False,
            },
            "padding": "x" * padding,
        }
    ).encode()


def rows(body):
    return [
        (
            "100:120:110",
            CONTEXT.organization_id,
            len(body),
            sha256(body).hexdigest(),
            i,
            body[offset : offset + 24576],
        )
        for i, offset in enumerate(range(0, len(body), 24576))
    ]


class SnapshotExecutor:
    def __init__(self, chunks):
        self.chunks = chunks
        self.calls = []
        self.context = None
        self.position = 0
        self.commands = []

    async def run_readonly_snapshot(self, context, operation):
        self.context = context
        return await operation(self)

    async def execute(self, sql, parameters=()):
        self.commands.append(sql)
        return 0

    async def fetch_all(self, sql, parameters=()):
        self.calls.append((sql, parameters))
        result = self.chunks[self.position : self.position + 20]
        self.position += len(result)
        return result


def test_capture_reassembles_multiple_pages_inside_one_snapshot():
    body = document(500000)
    executor = SnapshotExecutor(rows(body))
    result = asyncio.run(PostgresRecoveryInventoryRepository(executor).capture(CONTEXT))
    assert result.body == body
    assert result.checksum_sha256 == sha256(body).hexdigest()
    assert executor.context == CONTEXT
    assert len(executor.calls) == 2
    assert all(sql.startswith("FETCH FORWARD 20") for sql, _ in executor.calls)
    assert len(executor.commands) == 2
    assert "NO SCROLL CURSOR" in executor.commands[0]
    assert executor.commands[-1] == "CLOSE opengeo_account_recovery_inventory"


@pytest.mark.parametrize(
    "field,value",
    [
        (0, "101:120:110"),
        (1, UUID(int=3)),
        (2, 8388609),
        (3, "0" * 64),
        (4, 5),
    ],
)
def test_capture_rejects_changed_snapshot_account_size_hash_or_index(field, value):
    chunks = rows(document(30000))
    changed = list(chunks[1])
    changed[field] = value
    chunks[1] = tuple(changed)
    with pytest.raises(RecoveryInventoryInvalid):
        asyncio.run(PostgresRecoveryInventoryRepository(SnapshotExecutor(chunks)).capture(CONTEXT))


def test_capture_rejects_truncated_export():
    chunks = rows(document(30000))[:1]
    with pytest.raises(RecoveryInventoryInvalid, match="incomplete"):
        asyncio.run(PostgresRecoveryInventoryRepository(SnapshotExecutor(chunks)).capture(CONTEXT))


def test_failed_validation_closes_cursor_without_returning_partial_result():
    executor = SnapshotExecutor(rows(document(30000))[:1])
    with pytest.raises(RecoveryInventoryInvalid):
        asyncio.run(PostgresRecoveryInventoryRepository(executor).capture(CONTEXT))
    assert executor.commands[-1] == "CLOSE opengeo_account_recovery_inventory"


def test_capture_rejects_bytes_that_do_not_match_sealed_hash():
    chunks = rows(document())
    changed = list(chunks[0])
    changed[5] = b"z" + changed[5][1:]
    chunks[0] = tuple(changed)
    with pytest.raises(RecoveryInventoryInvalid, match="checksum"):
        asyncio.run(PostgresRecoveryInventoryRepository(SnapshotExecutor(chunks)).capture(CONTEXT))


def test_capture_rejects_wrong_actor_even_with_valid_transport_hash():
    payload = json.loads(document())
    payload["captured_by"] = str(UUID(int=3))
    chunks = rows(json.dumps(payload).encode())
    with pytest.raises(RecoveryInventoryInvalid, match="document"):
        asyncio.run(PostgresRecoveryInventoryRepository(SnapshotExecutor(chunks)).capture(CONTEXT))
