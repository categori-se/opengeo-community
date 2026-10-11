"""Function-only, exact-object Data API adapter for an explicitly reviewed one-shot run."""

import hashlib
import json
import re
from collections.abc import Sequence
from typing import Any
from uuid import UUID

from psycopg.types.json import Jsonb

from opengeo_worker.aws_clients import QueryTransport, SigV4Signer, UrlQueryTransport
from opengeo_worker.models import TransientFailure
from opengeo_worker.repository import WorkerRepository

FUNCTIONS = {
    "SELECT * FROM app.claim_dataset_ingest(%s, %s, %s, %s, %s)": "claim",
    "SELECT app.heartbeat_dataset_ingest(%s, %s, %s)": "heartbeat",
    "SELECT app.complete_dataset_ingest(%s, %s, %s, %s)": "complete",
    "SELECT app.fail_dataset_ingest(%s, %s, %s, %s)": "fail",
    "SELECT app.release_dataset_ingest(%s, %s, %s, %s)": "release",
}


class OneShotDataApiRepository(WorkerRepository):
    """No direct PostgreSQL socket, table writes, SQS operations, or automatic retries."""

    def __init__(
        self, plan: dict[str, Any], signer: SigV4Signer, transport: QueryTransport | None = None
    ) -> None:
        self.dataset_format = plan.get("datasetFormat", "geojson")
        if self.dataset_format not in {"geojson", "shapefile", "cog", "csv"}:
            raise ValueError("one_shot_dataset_format_invalid")
        self.plan = plan
        self.signer = signer
        self.transport = transport or UrlQueryTransport()
        self.outcome = "not_started"
        self.worker_token: UUID | None = None

    def _fetch_one(self, statement: str, parameters: Sequence[object]) -> tuple[Any, ...] | None:
        operation = FUNCTIONS.get(statement)
        if operation is None:
            raise ValueError("one_shot_function_denied")
        if operation == "claim":
            if tuple(parameters[:3]) != tuple(
                self.plan[k] for k in ("bucket", "key", "s3VersionId")
            ):
                raise ValueError("one_shot_source_mismatch")
            if self.worker_token is not None:
                raise ValueError("one_shot_already_attempted")
            token = parameters[3]
            if not isinstance(token, UUID):
                raise ValueError("one_shot_worker_token_invalid")
            self.worker_token = token
        elif (
            parameters[0] != UUID(self.plan["jobId"])
            or parameters[1] != self.worker_token
            or self.worker_token is None
        ):
            raise ValueError("one_shot_job_mismatch")
        encoded = []
        for index, value in enumerate(parameters):
            name = f"p{index}"
            sql_type = (
                "::jsonb" if isinstance(value, Jsonb) else "::integer" if type(value) is int else ""
            )
            statement = statement.replace("%s", ":" + name + sql_type, 1)
            field: dict[str, Any] = {"name": name}
            if isinstance(value, UUID):
                field.update(value={"stringValue": str(value)}, typeHint="UUID")
            elif isinstance(value, Jsonb):
                field.update(
                    value={"stringValue": json.dumps(value.obj, allow_nan=False)}, typeHint="JSON"
                )
            elif type(value) is int:
                field["value"] = {"longValue": value}
            elif isinstance(value, str):
                field["value"] = {"stringValue": value}
            else:
                raise ValueError("one_shot_parameter_invalid")
            encoded.append(field)
        body = json.dumps(
            {
                "resourceArn": self.plan["clusterArn"],
                "secretArn": self.plan["workerSecretArn"],
                "database": "opengeo",
                "sql": statement,
                "parameters": encoded,
            }
        ).encode()
        if len(body) > 262_144:
            raise ValueError("one_shot_request_too_large")
        host = f"rds-data.{self.plan['region']}.amazonaws.com"
        headers = self.signer.sign(
            method="POST",
            service="rds-data",
            host=host,
            path="/Execute",
            query=None,
            headers={"content-type": "application/json"},
            payload_hash=hashlib.sha256(body).hexdigest(),
        )
        response = self.transport.call(f"https://{host}/Execute", headers, body, 30)
        if response.status != 200 or len(response.body) > 1_048_576:
            # Never echo database responses, credentials or signed headers.
            error_type = "unknown"
            try:
                candidate = json.loads(response.body).get("__type", "").split("#")[-1]
                if re.fullmatch(r"[A-Za-z]{1,64}", candidate):
                    error_type = candidate
            except (ValueError, AttributeError):
                pass
            raise TransientFailure(f"one_shot_data_api_unavailable_{response.status}_{error_type}")
        try:
            records = json.loads(response.body)["records"]
            if len(records) != 1:
                raise ValueError("row_count")
            row = tuple(self._field(field) for field in records[0])
            if operation == "claim":
                if len(row) != 14:
                    raise ValueError("claim_shape")
                row = tuple(
                    UUID(v) if 1 <= i <= 6 and v is not None else v for i, v in enumerate(row)
                )
                if row[0] == "claimed":
                    expected = tuple(
                        UUID(self.plan[k])
                        for k in (
                            "jobId",
                            "organizationId",
                            "projectId",
                            "datasetId",
                            "datasetVersionId",
                            "originalObjectId",
                        )
                    )
                    if (
                        row[1:7] != expected
                        or row[8:12]
                        != (
                            self.dataset_format,
                            self.plan["contentType"],
                            self.plan["sizeBytes"],
                            self.plan["sha256"],
                        )
                        or row[13] != self.plan["outputPrefix"]
                    ):
                        raise ValueError("claim_mismatch")
                elif row[0] not in {
                    "not_ready",
                    "busy",
                    "already_completed",
                    "already_failed",
                    "already_cancelled",
                }:
                    raise ValueError("claim_status")
                self.outcome = row[0]
            elif operation in {"complete", "fail", "heartbeat"}:
                if len(row) != 1 or type(row[0]) is not bool:
                    raise ValueError("result_shape")
                if operation != "heartbeat" and row[0]:
                    self.outcome = "completed" if operation == "complete" else "failed"
            elif operation == "release":
                if len(row) != 1 or row[0] not in {"queued", "failed", "lost"}:
                    raise ValueError("release_shape")
                self.outcome = row[0]
            return row
        except (ValueError, KeyError, TypeError) as error:
            raise TransientFailure("one_shot_data_api_result_invalid") from error

    def _fetch_all(self, statement: str, parameters: Sequence[object]) -> list[tuple[Any, ...]]:
        raise ValueError("one_shot_function_denied")

    @staticmethod
    def _field(field: dict[str, Any]) -> Any:
        if len(field) != 1:
            raise ValueError("field_shape")
        key, value = next(iter(field.items()))
        if key == "isNull" and value is True:
            return None
        if key in {"stringValue", "longValue", "booleanValue"}:
            return value
        raise ValueError("field_type")
