"""Function-only durable ownership and cost reservation in the existing database."""

import json
from dataclasses import asdict
from typing import Any

from controller import Window, WindowUnsafe


class RdsLedger:
    def __init__(
        self,
        client: Any,
        *,
        cluster_arn: str,
        secret_arn: str,
        database: str = "opengeo",
    ):
        self.client = client
        self.arguments = {
            "resourceArn": cluster_arn,
            "secretArn": secret_arn,
            "database": database,
        }

    def _call(self, sql: str, parameters: list[dict[str, Any]]) -> Any:
        response = self.client.execute_statement(
            **self.arguments, sql=sql, parameters=parameters
        )
        rows = response.get("records")
        if not isinstance(rows, list) or len(rows) != 1 or len(rows[0]) != 1:
            raise WindowUnsafe("invalid_ledger_response")
        value = rows[0][0]
        if "booleanValue" in value:
            return value["booleanValue"]
        return json.loads(value["stringValue"])

    def claim(self, token: str, scope_hash: str, has_work: bool) -> dict[str, Any]:
        return self._call(
            "SELECT app.claim_worker_runtime(:token, :scope, :work)",
            [
                {"name": "token", "typeHint": "UUID", "value": {"stringValue": token}},
                {"name": "scope", "value": {"stringValue": scope_hash}},
                {"name": "work", "value": {"booleanValue": has_work}},
            ],
        )

    def retain(self, token: str, revision: int, window: Window) -> None:
        accepted = self._call(
            "SELECT app.advance_worker_runtime(:token, :revision, :window)",
            [
                {"name": "token", "typeHint": "UUID", "value": {"stringValue": token}},
                {"name": "revision", "value": {"longValue": revision}},
                {
                    "name": "window",
                    "typeHint": "JSON",
                    "value": {"stringValue": json.dumps(asdict(window))},
                },
            ],
        )
        if accepted is not True:
            raise WindowUnsafe("worker_window_lease_lost")

    def release(self, token: str, revision: int) -> None:
        accepted = self._call(
            "SELECT app.release_worker_runtime(:token, :revision)",
            [
                {"name": "token", "typeHint": "UUID", "value": {"stringValue": token}},
                {"name": "revision", "value": {"longValue": revision}},
            ],
        )
        if accepted is not True:
            raise WindowUnsafe("worker_window_lease_lost")

    def unfinished(self, workload: str = "shared") -> dict[str, int]:
        if workload not in {"shared", "pmtiles-v2"}:
            raise WindowUnsafe("unsupported_worker_workload")
        function = (
            "worker_runtime_unfinished_pmtiles_v2"
            if workload == "pmtiles-v2" else "worker_runtime_unfinished"
        )
        result = self._call(f"SELECT app.{function}()", [])
        if not isinstance(result, dict) or any(
            type(v) is not int or v < 0 for v in result.values()
        ):
            raise WindowUnsafe("invalid_unfinished_counts")
        return result
