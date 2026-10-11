import asyncio
import base64
import hashlib
import hmac
import json
import re
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from enum import Enum
from time import monotonic
from typing import Any, Protocol, cast
from uuid import UUID

import httpx2
from psycopg.types.json import Json, Jsonb

from opengeo_api.cognito_provisioning import (
    AwsCredentialProvider,
    AwsCredentials,
    CredentialProvider,
)
from opengeo_api.config import Settings


class RdsDataApiUnavailable(RuntimeError):
    pass


class RdsDataApiConflict(RuntimeError):
    pass


class _RdsDataApiResuming(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class DataApiResult:
    records: tuple[tuple[Any, ...], ...]
    updated: int


class DataApiTransport(Protocol):
    async def call(
        self,
        url: str,
        headers: Mapping[str, str],
        body: bytes,
        timeout_seconds: float,
    ) -> tuple[int, Mapping[str, str], bytes]: ...


class HttpxDataApiTransport:
    def __init__(self) -> None:
        self._client: httpx2.AsyncClient | None = None

    @asynccontextmanager
    async def connection_scope(self) -> AsyncIterator[None]:
        """Reuse bounded connections only within an explicitly owned event loop."""
        if self._client is not None:
            raise RuntimeError("Data API connection scope is already active")
        async with httpx2.AsyncClient(
            follow_redirects=False,
            limits=httpx2.Limits(
                max_connections=10, max_keepalive_connections=5, keepalive_expiry=30.0
            ),
        ) as client:
            self._client = client
            try:
                yield
            finally:
                self._client = None

    async def call(
        self,
        url: str,
        headers: Mapping[str, str],
        body: bytes,
        timeout_seconds: float,
    ) -> tuple[int, Mapping[str, str], bytes]:
        try:
            if self._client is not None:
                response = await self._client.post(
                    url, headers=dict(headers), content=body, timeout=timeout_seconds
                )
            else:
                # One-shot CLI callers retain automatic cleanup and never share
                # an async client across separate asyncio.run event loops.
                async with httpx2.AsyncClient(
                    timeout=timeout_seconds,
                    follow_redirects=False,
                ) as client:
                    response = await client.post(url, headers=dict(headers), content=body)
        except httpx2.HTTPError as error:
            raise RdsDataApiUnavailable("RDS Data API could not be reached") from error
        return response.status_code, dict(response.headers.items()), response.content


class RdsDataApiClient:
    """Bounded SigV4 client for the four Data API transaction operations OpenGeo uses."""

    _MAX_REQUEST_BYTES = 1_048_576

    def __init__(
        self,
        settings: Settings,
        credentials: CredentialProvider | None = None,
        transport: DataApiTransport | None = None,
        now: Callable[[], datetime] | None = None,
        sleep: Callable[[float], Awaitable[None]] | None = None,
        monotonic_clock: Callable[[], float] | None = None,
    ) -> None:
        if not settings.data_api_configured:
            raise ValueError("RDS Data API must be configured")
        assert settings.data_api_region is not None
        assert settings.data_api_cluster_arn is not None
        assert settings.data_api_secret_arn is not None
        self._region = settings.data_api_region
        self._cluster_arn = settings.data_api_cluster_arn
        self._secret_arn = settings.data_api_secret_arn
        self._database = settings.db_name
        self._timeout_seconds = settings.readiness_timeout_seconds
        self._resume_timeout_seconds = settings.data_api_resume_timeout_seconds
        self._credentials = credentials or AwsCredentialProvider(
            timeout_seconds=settings.readiness_timeout_seconds
        )
        self._transport = transport or HttpxDataApiTransport()
        self._now = now or (lambda: datetime.now(UTC))
        self._sleep = sleep or asyncio.sleep
        self._monotonic = monotonic_clock or monotonic

    @asynccontextmanager
    async def connection_scope(self) -> AsyncIterator[None]:
        if isinstance(self._transport, HttpxDataApiTransport):
            async with self._transport.connection_scope():
                yield
        else:
            yield

    async def begin(self) -> str:
        response = await self._call(
            "BeginTransaction",
            {
                "resourceArn": self._cluster_arn,
                "secretArn": self._secret_arn,
                "database": self._database,
            },
        )
        transaction_id = response.get("transactionId")
        if not isinstance(transaction_id, str) or not transaction_id:
            raise RdsDataApiUnavailable("RDS Data API returned an invalid transaction")
        return transaction_id

    async def execute(
        self,
        statement: str,
        parameters: Sequence[Any] = (),
        transaction_id: str | None = None,
        *,
        timeout_seconds: float | None = None,
        transport_timeout_seconds: float | None = None,
    ) -> DataApiResult:
        sql, encoded_parameters = compile_data_api_statement(statement, parameters)
        payload: dict[str, Any] = {
            "resourceArn": self._cluster_arn,
            "secretArn": self._secret_arn,
            "database": self._database,
            "sql": sql,
            "parameters": encoded_parameters,
            "includeResultMetadata": True,
            "resultSetOptions": {
                "decimalReturnType": "STRING",
                "longReturnType": "LONG",
            },
        }
        if transaction_id is not None:
            if not transaction_id:
                raise RdsDataApiUnavailable("RDS Data API transaction is invalid")
            payload["transactionId"] = transaction_id
        # An explicit caller budget covers transport and database-resume waits
        # together. A transport timeout never replays an uncertain operation.
        try:
            async with asyncio.timeout(timeout_seconds):
                response = await self._call(
                    "Execute",
                    payload,
                    timeout_seconds=timeout_seconds,
                    transport_timeout_seconds=transport_timeout_seconds,
                )
        except TimeoutError as error:
            raise RdsDataApiUnavailable("RDS Data API request timed out") from error
        return decode_data_api_result(response)

    async def commit(self, transaction_id: str) -> None:
        await self._end("CommitTransaction", transaction_id)

    async def rollback(self, transaction_id: str) -> None:
        await self._end("RollbackTransaction", transaction_id)

    async def _end(self, operation: str, transaction_id: str) -> None:
        if not transaction_id:
            raise RdsDataApiUnavailable("RDS Data API transaction is invalid")
        await self._call(
            operation,
            {
                "resourceArn": self._cluster_arn,
                "secretArn": self._secret_arn,
                "transactionId": transaction_id,
            },
        )

    async def _call(
        self,
        operation: str,
        payload: Mapping[str, Any],
        *,
        timeout_seconds: float | None = None,
        transport_timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        deadline = self._monotonic() + (
            self._resume_timeout_seconds if timeout_seconds is None else timeout_seconds
        )
        delay_seconds = 1.0
        while True:
            call_timeout_seconds = timeout_seconds
            if timeout_seconds is not None:
                remaining_seconds = deadline - self._monotonic()
                if remaining_seconds <= 0:
                    raise RdsDataApiUnavailable("RDS Data API request timed out")
                call_timeout_seconds = remaining_seconds
            if transport_timeout_seconds is not None:
                call_timeout_seconds = min(
                    self._timeout_seconds if call_timeout_seconds is None else call_timeout_seconds,
                    transport_timeout_seconds,
                )
            try:
                # Only the identity caller opts into a shorter transport cap.
                # A stalled/uncertain call is cancelled, never a resume retry.
                async with asyncio.timeout(
                    call_timeout_seconds if transport_timeout_seconds is not None else None
                ):
                    return await self._signed_call(
                        operation, payload, timeout_seconds=call_timeout_seconds
                    )
            except _RdsDataApiResuming as error:
                remaining_seconds = deadline - self._monotonic()
                if remaining_seconds <= 0:
                    raise RdsDataApiUnavailable(
                        "RDS Data API database did not resume in time"
                    ) from error
                await self._sleep(min(delay_seconds, remaining_seconds))
                delay_seconds = min(delay_seconds * 2, 4.0)

    async def _signed_call(
        self, operation: str, payload: Mapping[str, Any], *, timeout_seconds: float | None = None
    ) -> dict[str, Any]:
        body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
        if len(body) > self._MAX_REQUEST_BYTES:
            raise RdsDataApiUnavailable("RDS Data API request exceeds the OpenGeo bound")
        timestamp = self._now().astimezone(UTC)
        amz_date = timestamp.strftime("%Y%m%dT%H%M%SZ")
        date_stamp = timestamp.strftime("%Y%m%d")
        host = f"rds-data.{self._region}.amazonaws.com"
        path = f"/{operation}"
        credentials = self._credentials.load()
        payload_hash = hashlib.sha256(body).hexdigest()
        canonical = {
            "content-type": "application/json",
            "host": host,
            "x-amz-content-sha256": payload_hash,
            "x-amz-date": amz_date,
        }
        if credentials.session_token:
            canonical["x-amz-security-token"] = credentials.session_token
        signed_header_names = ";".join(sorted(canonical))
        canonical_headers = "".join(f"{key}:{canonical[key]}\n" for key in sorted(canonical))
        canonical_request = "\n".join(
            ["POST", path, "", canonical_headers, signed_header_names, payload_hash]
        )
        scope = f"{date_stamp}/{self._region}/rds-data/aws4_request"
        string_to_sign = "\n".join(
            [
                "AWS4-HMAC-SHA256",
                amz_date,
                scope,
                hashlib.sha256(canonical_request.encode()).hexdigest(),
            ]
        )
        signature = hmac.new(
            self._signing_key(credentials, date_stamp),
            string_to_sign.encode(),
            hashlib.sha256,
        ).hexdigest()
        headers = {
            **canonical,
            "authorization": (
                "AWS4-HMAC-SHA256 "
                f"Credential={credentials.access_key_id}/{scope}, "
                f"SignedHeaders={signed_header_names}, Signature={signature}"
            ),
        }
        status_code, response_headers, response_body = await self._transport.call(
            f"https://{host}{path}",
            headers,
            body,
            self._timeout_seconds if timeout_seconds is None else timeout_seconds,
        )
        try:
            decoded = json.loads(response_body) if response_body else {}
        except ValueError as error:
            raise RdsDataApiUnavailable("RDS Data API returned invalid JSON") from error
        if not isinstance(decoded, dict):
            raise RdsDataApiUnavailable("RDS Data API returned an invalid response")
        if 200 <= status_code < 300:
            return cast(dict[str, Any], decoded)

        error_type = str(
            response_headers.get("x-amzn-errortype")
            or response_headers.get("X-Amzn-Errortype")
            or decoded.get("__type", "")
        )
        error_type = error_type.split(":", 1)[0].rsplit("#", 1)[-1]
        message = str(decoded.get("message") or decoded.get("Message") or "")
        if error_type == "DatabaseResumingException":
            raise _RdsDataApiResuming("RDS Data API database is resuming")
        if error_type == "DatabaseErrorException" and re.search(
            r"(?:SQLSTATE|SQLState)\s*:?\s*23[0-9A-Z]{3}", message
        ):
            raise RdsDataApiConflict("RDS Data API constraint conflict")
        raise RdsDataApiUnavailable("RDS Data API operation failed")

    def _signing_key(self, credentials: AwsCredentials, date_stamp: str) -> bytes:
        date_key = hmac.new(
            f"AWS4{credentials.secret_access_key}".encode(),
            date_stamp.encode(),
            hashlib.sha256,
        ).digest()
        region_key = hmac.new(date_key, self._region.encode(), hashlib.sha256).digest()
        service_key = hmac.new(region_key, b"rds-data", hashlib.sha256).digest()
        return hmac.new(service_key, b"aws4_request", hashlib.sha256).digest()


def compile_data_api_statement(
    statement: str, parameters: Sequence[Any]
) -> tuple[str, list[dict[str, Any]]]:
    parts: list[str] = []
    parameter_index = 0
    cursor = 0
    while cursor < len(statement):
        character = statement[cursor]
        if character != "%":
            parts.append(character)
            cursor += 1
            continue
        if cursor + 1 >= len(statement):
            raise RdsDataApiUnavailable("RDS Data API statement contains an invalid placeholder")
        marker = statement[cursor + 1]
        if marker == "%":
            parts.append("%")
            cursor += 2
            continue
        if marker != "s":
            raise RdsDataApiUnavailable("RDS Data API statement contains an invalid placeholder")
        if parameter_index >= len(parameters):
            raise RdsDataApiUnavailable("RDS Data API statement parameter count is invalid")
        value = parameters[parameter_index]
        placeholder = f":p{parameter_index}"
        if isinstance(value, (list, tuple)):
            array_type, _ = _encode_array_parameter(value)
            placeholder = f"CAST({placeholder} AS {array_type}[])"
        parts.append(placeholder)
        parameter_index += 1
        cursor += 2
    if parameter_index != len(parameters):
        raise RdsDataApiUnavailable("RDS Data API statement parameter count is invalid")
    encoded = [
        {"name": f"p{index}", **_encode_parameter(value)} for index, value in enumerate(parameters)
    ]
    return "".join(parts), encoded


def _encode_parameter(value: Any) -> dict[str, Any]:
    if value is None:
        return {"value": {"isNull": True}}
    if isinstance(value, (Json, Jsonb)):
        return {
            "value": {"stringValue": json.dumps(value.obj, separators=(",", ":"), sort_keys=True)},
            "typeHint": "JSON",
        }
    if isinstance(value, UUID):
        return {"value": {"stringValue": str(value)}, "typeHint": "UUID"}
    if isinstance(value, datetime):
        normalized = value.astimezone(UTC).replace(tzinfo=None) if value.tzinfo else value
        return {
            "value": {"stringValue": normalized.isoformat(sep=" ", timespec="microseconds")},
            "typeHint": "TIMESTAMP",
        }
    if isinstance(value, date):
        return {"value": {"stringValue": value.isoformat()}, "typeHint": "DATE"}
    if isinstance(value, Decimal):
        return {"value": {"stringValue": str(value)}, "typeHint": "DECIMAL"}
    if isinstance(value, Enum):
        return _encode_parameter(value.value)
    if isinstance(value, bool):
        return {"value": {"booleanValue": value}}
    if isinstance(value, int):
        return {"value": {"longValue": value}}
    if isinstance(value, float):
        return {"value": {"doubleValue": value}}
    if isinstance(value, str):
        return {"value": {"stringValue": value}}
    if isinstance(value, bytes):
        return {"value": {"blobValue": base64.b64encode(value).decode("ascii")}}
    if isinstance(value, (list, tuple)):
        _, encoded = _encode_array_parameter(value)
        return {"value": {"stringValue": encoded}}
    raise RdsDataApiUnavailable("RDS Data API parameter type is unsupported")


def _encode_array_parameter(values: list[Any] | tuple[Any, ...]) -> tuple[str, str]:
    # Data API does not accept array parameters. Send a bound PostgreSQL array
    # literal with a fixed, inferred cast; never interpolate element values in SQL.
    kinds = {type(value) for value in values if value is not None}
    allowed = {str: "text", UUID: "uuid", int: "bigint", float: "double precision", bool: "boolean"}
    if len(values) > 100_000 or len(kinds) > 1 or any(kind not in allowed for kind in kinds):
        raise RdsDataApiUnavailable("RDS Data API array parameter type is unsupported")
    array_type = allowed[next(iter(kinds))] if kinds else "text"
    encoded = []
    for value in values:
        if value is None:
            encoded.append("NULL")
        else:
            text = str(value).lower() if isinstance(value, bool) else str(value)
            encoded.append('"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"')
    return array_type, "{" + ",".join(encoded) + "}"


def decode_data_api_result(response: Mapping[str, Any]) -> DataApiResult:
    metadata_value = response.get("columnMetadata", [])
    records_value = response.get("records", [])
    updated_value = response.get("numberOfRecordsUpdated", 0)
    # Aurora can serialize the two optional result lists as JSON null for
    # write-only statements. They carry the same meaning as omitted lists.
    if metadata_value is None:
        metadata_value = []
    if records_value is None:
        records_value = []
    if not isinstance(metadata_value, list) or not isinstance(records_value, list):
        raise RdsDataApiUnavailable("RDS Data API result shape is invalid")
    if not isinstance(updated_value, int) or updated_value < 0:
        raise RdsDataApiUnavailable("RDS Data API update count is invalid")
    metadata: list[Mapping[str, Any]] = []
    for item in metadata_value:
        if not isinstance(item, dict):
            raise RdsDataApiUnavailable("RDS Data API column metadata is invalid")
        metadata.append(item)
    rows: list[tuple[Any, ...]] = []
    for record in records_value:
        if not isinstance(record, list) or len(record) != len(metadata):
            raise RdsDataApiUnavailable("RDS Data API record shape is invalid")
        rows.append(
            tuple(
                _decode_field(field, str(column.get("typeName", "")))
                for field, column in zip(record, metadata, strict=True)
            )
        )
    return DataApiResult(records=tuple(rows), updated=updated_value)


def _decode_field(field: Any, type_name: str) -> Any:
    if not isinstance(field, dict) or len(field) != 1:
        raise RdsDataApiUnavailable("RDS Data API field is invalid")
    key, value = next(iter(field.items()))
    if key == "isNull":
        if value is not True:
            raise RdsDataApiUnavailable("RDS Data API null field is invalid")
        return None
    if key == "booleanValue" and isinstance(value, bool):
        return value
    if key == "longValue" and isinstance(value, int) and not isinstance(value, bool):
        return value
    if key == "doubleValue" and isinstance(value, int | float) and not isinstance(value, bool):
        return float(value)
    if key == "blobValue" and isinstance(value, str):
        try:
            return base64.b64decode(value, validate=True)
        except ValueError as error:
            raise RdsDataApiUnavailable("RDS Data API blob field is invalid") from error
    if key == "stringValue" and isinstance(value, str):
        return _decode_string(value, type_name)
    if key == "arrayValue" and isinstance(value, dict):
        return _decode_array(value, type_name)
    raise RdsDataApiUnavailable("RDS Data API field union is invalid")


def _decode_string(value: str, type_name: str) -> Any:
    normalized = type_name.lower()
    if normalized in {"json", "jsonb"}:
        try:
            return json.loads(value)
        except ValueError as error:
            raise RdsDataApiUnavailable("RDS Data API JSON field is invalid") from error
    if normalized in {"timestamp", "timestamptz", "timestamp with time zone"}:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            # Aurora Data API returns TIMESTAMPTZ in UTC, sometimes without an
            # offset suffix. Preserve SQL timestamp-without-time-zone semantics.
            if normalized != "timestamp" and parsed.tzinfo is None:
                return parsed.replace(tzinfo=UTC)
            return parsed
        except ValueError as error:
            raise RdsDataApiUnavailable("RDS Data API timestamp field is invalid") from error
    if normalized == "date":
        try:
            return date.fromisoformat(value)
        except ValueError as error:
            raise RdsDataApiUnavailable("RDS Data API date field is invalid") from error
    if normalized == "uuid":
        try:
            return UUID(value)
        except ValueError as error:
            raise RdsDataApiUnavailable("RDS Data API UUID field is invalid") from error
    if normalized in {"numeric", "decimal"}:
        try:
            return Decimal(value)
        except ValueError as error:
            raise RdsDataApiUnavailable("RDS Data API decimal field is invalid") from error
    return value


def _decode_array(value: Mapping[str, Any], type_name: str) -> list[Any]:
    if len(value) != 1:
        raise RdsDataApiUnavailable("RDS Data API array field is invalid")
    key, entries = next(iter(value.items()))
    if not isinstance(entries, list):
        raise RdsDataApiUnavailable("RDS Data API array values are invalid")
    base_type = type_name.lower()
    if base_type.startswith("_"):
        base_type = base_type[1:]
    if base_type.endswith("[]"):
        base_type = base_type[:-2]
    if key == "stringValues" and all(isinstance(entry, str) for entry in entries):
        return [_decode_string(entry, base_type) for entry in entries]
    if key == "longValues" and all(
        isinstance(entry, int) and not isinstance(entry, bool) for entry in entries
    ):
        return list(entries)
    if key == "doubleValues" and all(
        isinstance(entry, int | float) and not isinstance(entry, bool) for entry in entries
    ):
        return [float(entry) for entry in entries]
    if key == "booleanValues" and all(isinstance(entry, bool) for entry in entries):
        return list(entries)
    if key == "arrayValues" and all(isinstance(entry, dict) for entry in entries):
        return [_decode_array(entry, base_type) for entry in entries]
    raise RdsDataApiUnavailable("RDS Data API array union is invalid")
