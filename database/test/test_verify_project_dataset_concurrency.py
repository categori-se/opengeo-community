from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from uuid import uuid4

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))
SPEC = importlib.util.spec_from_file_location(
    "opengeo_verify_project_dataset_concurrency",
    SCRIPT_DIR / "verify_project_dataset_concurrency.py",
)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class ConcurrencyCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def test_removes_only_mutable_synthetic_records_when_history_is_absent(self):
        admin = AsyncMock()
        transaction = AsyncMock()
        transaction.fetch_one.side_effect = [(0,), (0,), (0,)]
        context = MODULE.TenantContext(user_id=uuid4(), organization_id=uuid4())
        project_id, map_id, dataset_id = uuid4(), uuid4(), uuid4()
        with (
            patch.object(MODULE, "RollbackTransaction", return_value=transaction),
            patch.object(MODULE, "set_context", new=AsyncMock()),
        ):
            await MODULE.cleanup_fixture(admin, context, project_id, map_id, dataset_id)
        admin.commit.assert_awaited_once()
        admin.rollback.assert_not_awaited()
        self.assertEqual(transaction.execute.await_count, 5)
        for call in transaction.execute.await_args_list:
            sql, parameters = call.args
            self.assertNotIn("map_versions", sql)
            self.assertIn("organization_id = %s", sql)
            self.assertEqual(parameters[0], context.organization_id)
        self.assertEqual(
            transaction.fetch_one.await_args_list[1].args[1],
            (context.organization_id, map_id),
        )

    async def test_preserves_unexpected_history_before_deleting_any_fixture_rows(self):
        admin = AsyncMock()
        transaction = AsyncMock()
        transaction.fetch_one.side_effect = [(0,), (1,)]
        context = MODULE.TenantContext(user_id=uuid4(), organization_id=uuid4())
        with (
            patch.object(MODULE, "RollbackTransaction", return_value=transaction),
            patch.object(MODULE, "set_context", new=AsyncMock()),
            self.assertRaisesRegex(MODULE.VerificationError, "immutable map history"),
        ):
            await MODULE.cleanup_fixture(admin, context, uuid4(), uuid4(), uuid4())
        transaction.execute.assert_not_awaited()
        admin.commit.assert_not_awaited()
        admin.rollback.assert_awaited_once()
