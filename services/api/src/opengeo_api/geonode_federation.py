from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, Protocol, cast
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

from opengeo_api.geonode_adapter import (
    GEONODE_COMMIT,
    GEONODE_VERSION,
    assert_safe_geonode_tree,
)

_CONFIGURATION_SCHEMA = "opengeo.geonode-federation-configuration.1.0.0"
_SNAPSHOT_SCHEMA = "opengeo.geonode-harvest-snapshot.1.0.0"
_JSON_MEDIA = frozenset({"application/json"})
_MAXIMUM_DOCUMENT_BYTES = 2_097_152
_MAXIMUM_JSON_NODES = 50_000
_MAXIMUM_RESOURCE_BYTES = 131_072
_MAXIMUM_RESOURCES = 100
_SAFE_NAME = re.compile(r"^[^\x00-\x1f\x7f]{1,100}$")
_RESOURCE_TYPES = frozenset({"dataset", "document", "map", "geoapp", "service"})

CredentialMode = Literal["anonymous"]
ReconciliationAction = Literal["added", "updated", "unchanged", "withdrawn"]


class GeoNodeFederationFailure(RuntimeError):
    def __init__(self, code: str, *, retryable: bool = False) -> None:
        self.code = code
        self.retryable = retryable
        super().__init__(code)


class GeoNodeCatalogFetcher(Protocol):
    async def fetch_document(
        self,
        url: str,
        *,
        parameters: list[tuple[str, str]],
        accept: str,
        accepted_media_types: frozenset[str],
        maximum_bytes: int,
    ) -> bytes: ...


@dataclass(frozen=True, slots=True)
class GeoNodeFederationConfiguration:
    name: str
    remote_url: str
    scheduling_enabled: bool
    refresh_interval_minutes: int
    maximum_resources: int
    credential_mode: CredentialMode = "anonymous"
    source_version: Literal["5.1.0"] = GEONODE_VERSION

    def __post_init__(self) -> None:
        if _SAFE_NAME.fullmatch(self.name) is None or self.name != self.name.strip():
            raise GeoNodeFederationFailure("geonode_federation_name_invalid")
        normalized_url = normalize_geonode_url(self.remote_url)
        if normalized_url != self.remote_url:
            raise GeoNodeFederationFailure("geonode_federation_url_not_canonical")
        if self.credential_mode != "anonymous":
            raise GeoNodeFederationFailure("geonode_federation_credentials_unsupported")
        if self.source_version != GEONODE_VERSION:
            raise GeoNodeFederationFailure("geonode_federation_version_unsupported")
        if not 60 <= self.refresh_interval_minutes <= 10_080:
            raise GeoNodeFederationFailure("geonode_federation_refresh_invalid")
        if not 1 <= self.maximum_resources <= _MAXIMUM_RESOURCES:
            raise GeoNodeFederationFailure("geonode_federation_limit_invalid")

    @property
    def source_fingerprint(self) -> str:
        return hashlib.sha256(self.remote_url.encode("utf-8")).hexdigest()

    @property
    def configuration_checksum_sha256(self) -> str:
        fields = (
            self.name,
            self.remote_url,
            str(self.scheduling_enabled).lower(),
            str(self.refresh_interval_minutes),
            str(self.maximum_resources),
            self.credential_mode,
        )
        return hashlib.sha256("\x1f".join(fields).encode("utf-8")).hexdigest()

    @property
    def catalog_url(self) -> str:
        return f"{self.remote_url}/api/v2/resources"

    def json_value(self) -> dict[str, Any]:
        return {
            "schema_version": _CONFIGURATION_SCHEMA,
            "source": {
                "product": "geonode",
                "version": GEONODE_VERSION,
                "commit": GEONODE_COMMIT,
            },
            "harvester": {
                "name": self.name,
                "remote_url": self.remote_url,
                "scheduling_enabled": self.scheduling_enabled,
                "refresh_interval_minutes": self.refresh_interval_minutes,
                "maximum_resources": self.maximum_resources,
                "credential_mode": self.credential_mode,
            },
        }


@dataclass(frozen=True, slots=True)
class HarvestedGeoNodeResource:
    remote_identifier: str
    resource_type: str
    title: str
    remote_modified_at: datetime | None
    payload_sha256: str
    payload: Mapping[str, Any]

    def json_value(self) -> dict[str, Any]:
        return {
            "remote_identifier": self.remote_identifier,
            "resource_type": self.resource_type,
            "title": self.title,
            "remote_modified_at": (
                self.remote_modified_at.isoformat() if self.remote_modified_at else None
            ),
            "payload_sha256": self.payload_sha256,
            "payload": dict(self.payload),
        }


@dataclass(frozen=True, slots=True)
class GeoNodeHarvestSnapshot:
    source_url: str
    source_fingerprint: str
    observed_at: datetime
    fresh_until: datetime
    remote_total: int
    truncated: bool
    resources: tuple[HarvestedGeoNodeResource, ...]
    snapshot_sha256: str

    def json_value(self) -> dict[str, Any]:
        return {
            "schema_version": _SNAPSHOT_SCHEMA,
            "source": {
                "product": "geonode",
                "version": GEONODE_VERSION,
                "commit": GEONODE_COMMIT,
                "url": self.source_url,
                "fingerprint_sha256": self.source_fingerprint,
            },
            "observed_at": self.observed_at.isoformat(),
            "fresh_until": self.fresh_until.isoformat(),
            "remote_total": self.remote_total,
            "truncated": self.truncated,
            "resources": [resource.json_value() for resource in self.resources],
            "snapshot_sha256": self.snapshot_sha256,
        }


@dataclass(frozen=True, slots=True)
class FederatedResourceState:
    source_fingerprint: str
    remote_identifier: str
    payload_sha256: str
    status: Literal["current", "withdrawn"]
    last_refreshed_at: datetime


@dataclass(frozen=True, slots=True)
class GeoNodeReconciliationItem:
    remote_identifier: str
    action: ReconciliationAction
    previous_payload_sha256: str | None
    current_payload_sha256: str | None


@dataclass(frozen=True, slots=True)
class GeoNodeReconciliation:
    source_fingerprint: str
    observed_at: datetime
    items: tuple[GeoNodeReconciliationItem, ...]

    @property
    def counts(self) -> dict[str, int]:
        return {
            action: sum(item.action == action for item in self.items)
            for action in ("added", "updated", "unchanged", "withdrawn")
        }


class GeoNodeHarvestEngine:
    def __init__(self, fetcher: GeoNodeCatalogFetcher) -> None:
        self._fetcher = fetcher

    async def harvest(
        self,
        configuration: GeoNodeFederationConfiguration,
        *,
        observed_at: datetime,
    ) -> GeoNodeHarvestSnapshot:
        now = _utc(observed_at, "geonode_harvest_observed_at_invalid")
        try:
            body = await self._fetcher.fetch_document(
                configuration.catalog_url,
                parameters=[
                    ("page", "1"),
                    ("page_size", str(configuration.maximum_resources)),
                ],
                accept="application/json",
                accepted_media_types=_JSON_MEDIA,
                maximum_bytes=_MAXIMUM_DOCUMENT_BYTES,
            )
        except GeoNodeFederationFailure:
            raise
        except Exception as error:
            code = _fetch_failure_code(
                getattr(error, "code", "geonode_harvest_upstream_unavailable")
            )
            retryable = bool(getattr(error, "retryable", True))
            raise GeoNodeFederationFailure(code, retryable=retryable) from error
        return parse_geonode_catalog(configuration, body, observed_at=now)


def parse_geonode_federation_configuration(
    value: Mapping[str, Any],
) -> GeoNodeFederationConfiguration:
    try:
        assert_safe_geonode_tree(value, maximum_nodes=200)
    except ValueError as error:
        raise GeoNodeFederationFailure("geonode_federation_configuration_unsafe") from error
    _exact_keys(value, {"schema_version", "source", "harvester"}, "configuration")
    if value.get("schema_version") != _CONFIGURATION_SCHEMA:
        raise GeoNodeFederationFailure("geonode_federation_schema_unsupported")
    source = _mapping(value.get("source"), "geonode_federation_source_invalid")
    _exact_keys(source, {"product", "version", "commit"}, "source")
    if source != {
        "product": "geonode",
        "version": GEONODE_VERSION,
        "commit": GEONODE_COMMIT,
    }:
        raise GeoNodeFederationFailure("geonode_federation_version_unsupported")
    harvester = _mapping(value.get("harvester"), "geonode_federation_harvester_invalid")
    _exact_keys(
        harvester,
        {
            "name",
            "remote_url",
            "scheduling_enabled",
            "refresh_interval_minutes",
            "maximum_resources",
            "credential_mode",
        },
        "harvester",
    )
    if not isinstance(harvester.get("scheduling_enabled"), bool):
        raise GeoNodeFederationFailure("geonode_federation_schedule_invalid")
    return GeoNodeFederationConfiguration(
        name=_text(harvester.get("name"), 100, "geonode_federation_name_invalid"),
        remote_url=normalize_geonode_url(
            _text(harvester.get("remote_url"), 2_048, "geonode_federation_url_invalid")
        ),
        scheduling_enabled=cast(bool, harvester["scheduling_enabled"]),
        refresh_interval_minutes=_integer(
            harvester.get("refresh_interval_minutes"),
            "geonode_federation_refresh_invalid",
        ),
        maximum_resources=_integer(
            harvester.get("maximum_resources"),
            "geonode_federation_limit_invalid",
        ),
        credential_mode=cast(CredentialMode, harvester.get("credential_mode")),
        source_version=cast(Literal["5.1.0"], source.get("version")),
    )


def geonode_federation_conversion_report(
    configuration: GeoNodeFederationConfiguration,
) -> dict[str, Any]:
    return {
        "schema_version": "opengeo.geonode-federation-conversion-report.1.0.0",
        "source": {
            "product": "geonode",
            "version": GEONODE_VERSION,
            "commit": GEONODE_COMMIT,
        },
        "summary": {"mapped": 6, "preserved": 0, "unsupported": 0, "credentials": 0},
        "fields": [
            {
                "source": source,
                "target": target,
                "outcome": "mapped",
            }
            for source, target in (
                ("name", "name"),
                ("remote_url", "remoteUrl"),
                ("scheduling_enabled", "schedulingEnabled"),
                ("refresh_interval_minutes", "refreshIntervalMinutes"),
                ("maximum_resources", "maximumResources"),
                ("credential_mode", "credentialMode"),
            )
        ],
        "limitations": [
            "Only the exact GeoNode 5.1.0 anonymous catalog contract is mapped.",
            "Scheduling is declarative; no timer or always-on compute is created by import.",
            "Credentials, cookies, tokens, API keys, and authorization headers are rejected.",
        ],
        "configuration_sha256": configuration.configuration_checksum_sha256,
    }


def parse_geonode_catalog(
    configuration: GeoNodeFederationConfiguration,
    body: bytes,
    *,
    observed_at: datetime,
) -> GeoNodeHarvestSnapshot:
    if not 1 <= len(body) <= _MAXIMUM_DOCUMENT_BYTES:
        raise GeoNodeFederationFailure("geonode_harvest_response_too_large")
    try:
        value = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise GeoNodeFederationFailure("geonode_harvest_response_invalid") from error
    if not isinstance(value, dict):
        raise GeoNodeFederationFailure("geonode_harvest_response_invalid")
    try:
        assert_safe_geonode_tree(value, maximum_nodes=_MAXIMUM_JSON_NODES)
    except ValueError as error:
        raise GeoNodeFederationFailure("geonode_harvest_response_unsafe") from error
    resources_value = value.get("resources")
    if not isinstance(resources_value, list):
        raise GeoNodeFederationFailure("geonode_harvest_response_invalid")
    if len(resources_value) > configuration.maximum_resources:
        raise GeoNodeFederationFailure("geonode_harvest_response_too_large")
    remote_total = _integer(
        value.get("total", len(resources_value)), "geonode_harvest_total_invalid"
    )
    if remote_total < len(resources_value) or remote_total > 1_000_000_000:
        raise GeoNodeFederationFailure("geonode_harvest_total_invalid")
    resources: list[HarvestedGeoNodeResource] = []
    identities: set[str] = set()
    for raw in resources_value:
        resource = _harvested_resource(raw)
        if resource.remote_identifier in identities:
            raise GeoNodeFederationFailure("geonode_harvest_identity_collision")
        identities.add(resource.remote_identifier)
        resources.append(resource)
    resources.sort(key=lambda item: item.remote_identifier)
    now = _utc(observed_at, "geonode_harvest_observed_at_invalid")
    canonical_resources = [resource.json_value() for resource in resources]
    snapshot_sha256 = _sha256(
        {
            "source_fingerprint": configuration.source_fingerprint,
            "observed_at": now.isoformat(),
            "remote_total": remote_total,
            "resources": canonical_resources,
        }
    )
    return GeoNodeHarvestSnapshot(
        source_url=configuration.remote_url,
        source_fingerprint=configuration.source_fingerprint,
        observed_at=now,
        fresh_until=now + timedelta(minutes=configuration.refresh_interval_minutes),
        remote_total=remote_total,
        truncated=remote_total > len(resources),
        resources=tuple(resources),
        snapshot_sha256=snapshot_sha256,
    )


def reconcile_geonode_harvest(
    snapshot: GeoNodeHarvestSnapshot,
    previous: tuple[FederatedResourceState, ...],
    *,
    local_identity_sources: Mapping[str, str] | None = None,
) -> GeoNodeReconciliation:
    prior: dict[str, FederatedResourceState] = {}
    for item in previous:
        if item.source_fingerprint != snapshot.source_fingerprint:
            raise GeoNodeFederationFailure("geonode_harvest_source_mismatch")
        if item.remote_identifier in prior:
            raise GeoNodeFederationFailure("geonode_harvest_identity_collision")
        prior[item.remote_identifier] = item
    bindings = local_identity_sources or {}
    current = {item.remote_identifier: item for item in snapshot.resources}
    for identifier in current:
        bound_source = bindings.get(identifier)
        if bound_source is not None and bound_source != snapshot.source_fingerprint:
            raise GeoNodeFederationFailure("geonode_harvest_local_identity_collision")
    changes: list[GeoNodeReconciliationItem] = []
    for identifier in sorted(current.keys() | prior.keys()):
        before = prior.get(identifier)
        after = current.get(identifier)
        if after is None:
            assert before is not None
            if before.status == "withdrawn":
                continue
            changes.append(
                GeoNodeReconciliationItem(
                    identifier,
                    "withdrawn",
                    before.payload_sha256,
                    None,
                )
            )
        elif before is None or before.status == "withdrawn":
            changes.append(
                GeoNodeReconciliationItem(identifier, "added", None, after.payload_sha256)
            )
        elif before.payload_sha256 == after.payload_sha256:
            changes.append(
                GeoNodeReconciliationItem(
                    identifier,
                    "unchanged",
                    before.payload_sha256,
                    after.payload_sha256,
                )
            )
        else:
            changes.append(
                GeoNodeReconciliationItem(
                    identifier,
                    "updated",
                    before.payload_sha256,
                    after.payload_sha256,
                )
            )
    return GeoNodeReconciliation(snapshot.source_fingerprint, snapshot.observed_at, tuple(changes))


def geonode_snapshot_is_fresh(snapshot: GeoNodeHarvestSnapshot, *, now: datetime) -> bool:
    checked = _utc(now, "geonode_harvest_clock_invalid")
    return snapshot.observed_at <= checked <= snapshot.fresh_until


def normalize_geonode_url(value: str) -> str:
    if not isinstance(value, str) or len(value) > 2_048 or value != value.strip():
        raise GeoNodeFederationFailure("geonode_federation_url_invalid")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise GeoNodeFederationFailure("geonode_federation_url_invalid") from error
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.hostname in {"localhost", "localhost.localdomain"}
        or parsed.hostname.endswith(".local")
        or any(character.isspace() or ord(character) < 32 for character in value)
    ):
        raise GeoNodeFederationFailure("geonode_federation_url_invalid")
    host = parsed.hostname.lower().rstrip(".")
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", host):
        raise GeoNodeFederationFailure("geonode_federation_url_invalid")
    netloc = host if port in {None, 443} else f"{host}:{port}"
    path = parsed.path.rstrip("/")
    if not path:
        path = ""
    return urlunsplit(("https", netloc, path, "", ""))


def _harvested_resource(value: Any) -> HarvestedGeoNodeResource:
    raw = _mapping(value, "geonode_harvest_response_invalid")
    encoded = _canonical_json(raw)
    if len(encoded) > _MAXIMUM_RESOURCE_BYTES:
        raise GeoNodeFederationFailure("geonode_harvest_response_too_large")
    identifier_value = raw.get("uuid")
    try:
        identifier = str(UUID(str(identifier_value)))
    except ValueError as error:
        raise GeoNodeFederationFailure("geonode_harvest_identity_invalid") from error
    if identifier != str(identifier_value).lower():
        raise GeoNodeFederationFailure("geonode_harvest_identity_invalid")
    resource_type = _text(raw.get("resource_type"), 50, "geonode_harvest_response_invalid").lower()
    if resource_type not in _RESOURCE_TYPES:
        raise GeoNodeFederationFailure("geonode_harvest_type_unsupported")
    if resource_type == "geoapp":
        subtype = _text(raw.get("subtype"), 50, "geonode_harvest_response_invalid").lower()
        if subtype not in {"dashboard", "geostory", "story"}:
            raise GeoNodeFederationFailure("geonode_harvest_type_unsupported")
    title = _text(raw.get("title"), 500, "geonode_harvest_response_invalid")
    modified = next(
        (raw.get(key) for key in ("last_updated", "modified", "date") if raw.get(key)),
        None,
    )
    return HarvestedGeoNodeResource(
        remote_identifier=identifier,
        resource_type=resource_type,
        title=title,
        remote_modified_at=_optional_timestamp(modified),
        payload_sha256=hashlib.sha256(encoded).hexdigest(),
        payload=dict(raw),
    )


def _optional_timestamp(value: Any) -> datetime | None:
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > 100:
        raise GeoNodeFederationFailure("geonode_harvest_timestamp_invalid")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise GeoNodeFederationFailure("geonode_harvest_timestamp_invalid") from error
    return _utc(parsed, "geonode_harvest_timestamp_invalid")


def _utc(value: datetime, code: str) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise GeoNodeFederationFailure(code)
    return value.astimezone(UTC)


def _mapping(value: Any, code: str) -> Mapping[str, Any]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise GeoNodeFederationFailure(code)
    return value


def _exact_keys(value: Mapping[str, Any], keys: set[str], label: str) -> None:
    if set(value) != keys:
        raise GeoNodeFederationFailure(f"geonode_federation_{label}_invalid")


def _text(value: Any, maximum: int, code: str) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= maximum
        or value != value.strip()
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise GeoNodeFederationFailure(code)
    return value


def _integer(value: Any, code: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise GeoNodeFederationFailure(code)
    return value


def _canonical_json(value: Any) -> bytes:
    try:
        encoded = json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise GeoNodeFederationFailure("geonode_harvest_response_invalid") from error
    if any(not math.isfinite(item) for item in _numbers(value)):
        raise GeoNodeFederationFailure("geonode_harvest_response_invalid")
    return encoded


def _numbers(value: Any) -> list[float]:
    numbers: list[float] = []
    stack = [value]
    while stack:
        current = stack.pop()
        if isinstance(current, bool):
            continue
        if isinstance(current, (int, float)):
            numbers.append(float(current))
        elif isinstance(current, dict):
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)
    return numbers


def _sha256(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value)).hexdigest()


def _fetch_failure_code(value: Any) -> str:
    code = str(value)
    return {
        "destination_unavailable": "geonode_harvest_upstream_unavailable",
        "response_too_large": "geonode_harvest_response_too_large",
        "source_contract_invalid": "geonode_harvest_response_invalid",
        "upstream_unavailable": "geonode_harvest_upstream_unavailable",
    }.get(code, code)
