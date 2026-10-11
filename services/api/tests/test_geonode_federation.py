import asyncio
import json
from datetime import UTC, datetime, timedelta

import pytest

from opengeo_api.geonode_adapter import GEONODE_COMMIT
from opengeo_api.geonode_federation import (
    FederatedResourceState,
    GeoNodeFederationConfiguration,
    GeoNodeFederationFailure,
    GeoNodeHarvestEngine,
    geonode_federation_conversion_report,
    geonode_snapshot_is_fresh,
    normalize_geonode_url,
    parse_geonode_catalog,
    parse_geonode_federation_configuration,
    reconcile_geonode_harvest,
)

NOW = datetime(2026, 8, 31, 12, tzinfo=UTC)
URL = "https://catalog.example.test/geonode"
ROAD_ID = "11111111-1111-4111-8111-111111111111"
STORY_ID = "22222222-2222-4222-8222-222222222222"


def configuration(**changes) -> GeoNodeFederationConfiguration:
    values = {
        "name": "Research catalog",
        "remote_url": URL,
        "scheduling_enabled": False,
        "refresh_interval_minutes": 1_440,
        "maximum_resources": 100,
        "credential_mode": "anonymous",
    }
    values.update(changes)
    return GeoNodeFederationConfiguration(**values)


def catalog(*, road_title: str = "Road network", include_story: bool = True) -> bytes:
    resources = [
        {
            "uuid": ROAD_ID,
            "resource_type": "dataset",
            "title": road_title,
            "last_updated": "2026-08-30T12:00:00Z",
            "detail_url": "https://catalog.example.test/catalogue/17",
            "extent": {"coords": [84.0, 27.0, 86.0, 29.0], "srid": "EPSG:4326"},
        }
    ]
    if include_story:
        resources.append(
            {
                "uuid": STORY_ID,
                "resource_type": "geoapp",
                "subtype": "geostory",
                "title": "Road access story",
                "modified": "2026-08-30T13:00:00+00:00",
            }
        )
    return json.dumps({"total": len(resources), "page": 1, "resources": resources}).encode()


class Fetcher:
    def __init__(self, body: bytes) -> None:
        self.body = body
        self.calls: list[tuple] = []

    async def fetch_document(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.body


class FetchFailure(RuntimeError):
    code = "upstream_unavailable"
    retryable = True


class FailedFetcher:
    async def fetch_document(self, url, **kwargs):
        del url, kwargs
        raise FetchFailure


def test_exact_configuration_round_trips_without_credentials_or_scheduling_side_effects() -> None:
    original = configuration()
    exported = original.json_value()
    restored = parse_geonode_federation_configuration(exported)
    report = geonode_federation_conversion_report(restored)

    assert restored == original
    assert exported["source"] == {
        "product": "geonode",
        "version": "5.1.0",
        "commit": GEONODE_COMMIT,
    }
    assert exported["harvester"]["credential_mode"] == "anonymous"
    assert report["summary"] == {
        "mapped": 6,
        "preserved": 0,
        "unsupported": 0,
        "credentials": 0,
    }
    assert report["limitations"][1].startswith("Scheduling is declarative")
    assert report["configuration_sha256"] == original.configuration_checksum_sha256
    assert all(
        token not in json.dumps(exported).lower()
        for token in ("password", "access_token", "client_secret", "authorization")
    )


@pytest.mark.parametrize(
    "value",
    (
        "http://catalog.example.test",
        "https://user:password@catalog.example.test",
        "https://catalog.example.test?token=secret",
        "https://localhost/catalog",
        "https://catalog.example.test.local/catalog",
    ),
)
def test_configuration_rejects_noncanonical_or_credential_bearing_urls(value: str) -> None:
    with pytest.raises(GeoNodeFederationFailure, match="url_invalid"):
        normalize_geonode_url(value)

    with pytest.raises(GeoNodeFederationFailure):
        configuration(remote_url=value)


def test_configuration_rejects_secret_fields_and_widened_limits() -> None:
    candidate = configuration().json_value()
    candidate["harvester"]["access_token"] = "secret"
    with pytest.raises(GeoNodeFederationFailure, match="configuration_unsafe"):
        parse_geonode_federation_configuration(candidate)
    with pytest.raises(GeoNodeFederationFailure, match="limit_invalid"):
        configuration(maximum_resources=101)
    with pytest.raises(GeoNodeFederationFailure, match="refresh_invalid"):
        configuration(refresh_interval_minutes=59)


def test_engine_fetches_one_bounded_anonymous_page_and_seals_freshness() -> None:
    fetcher = Fetcher(catalog())
    result = asyncio.run(GeoNodeHarvestEngine(fetcher).harvest(configuration(), observed_at=NOW))

    assert fetcher.calls == [
        (
            f"{URL}/api/v2/resources",
            {
                "parameters": [("page", "1"), ("page_size", "100")],
                "accept": "application/json",
                "accepted_media_types": frozenset({"application/json"}),
                "maximum_bytes": 2_097_152,
            },
        )
    ]
    assert [item.remote_identifier for item in result.resources] == [ROAD_ID, STORY_ID]
    assert result.source_fingerprint == configuration().source_fingerprint
    assert result.fresh_until == NOW + timedelta(days=1)
    assert result.remote_total == 2
    assert result.truncated is False
    assert len(result.snapshot_sha256) == 64
    assert geonode_snapshot_is_fresh(result, now=NOW + timedelta(hours=23))
    assert not geonode_snapshot_is_fresh(result, now=NOW + timedelta(days=2))


def test_engine_normalizes_shared_archiver_failures_to_the_database_contract() -> None:
    with pytest.raises(
        GeoNodeFederationFailure,
        match="geonode_harvest_upstream_unavailable",
    ) as captured:
        asyncio.run(GeoNodeHarvestEngine(FailedFetcher()).harvest(configuration(), observed_at=NOW))
    assert captured.value.retryable is True


def test_catalog_is_deterministic_and_rejects_duplicates_unsafe_fields_and_bad_totals() -> None:
    first = parse_geonode_catalog(configuration(), catalog(), observed_at=NOW)
    second = parse_geonode_catalog(configuration(), catalog(), observed_at=NOW)
    assert first == second

    duplicated = json.loads(catalog())
    duplicated["resources"].append(duplicated["resources"][0])
    duplicated["total"] = 3
    unsafe = json.loads(catalog())
    unsafe["resources"][0]["api-token"] = "secret"
    bad_total = json.loads(catalog())
    bad_total["total"] = 1
    for value, code in (
        (duplicated, "identity_collision"),
        (unsafe, "response_unsafe"),
        (bad_total, "total_invalid"),
    ):
        with pytest.raises(GeoNodeFederationFailure, match=code):
            parse_geonode_catalog(
                configuration(),
                json.dumps(value).encode(),
                observed_at=NOW,
            )


def test_empty_catalog_is_a_valid_snapshot_that_can_withdraw_prior_resources() -> None:
    empty = parse_geonode_catalog(
        configuration(),
        json.dumps({"total": 0, "page": 1, "resources": []}).encode(),
        observed_at=NOW,
    )
    assert empty.resources == ()
    assert empty.remote_total == 0
    assert empty.truncated is False
    prior = (
        FederatedResourceState(
            empty.source_fingerprint,
            ROAD_ID,
            "a" * 64,
            "current",
            NOW - timedelta(days=1),
        ),
    )
    assert reconcile_geonode_harvest(empty, prior).counts == {
        "added": 0,
        "updated": 0,
        "unchanged": 0,
        "withdrawn": 1,
    }


def test_reconciliation_is_retry_safe_and_reports_add_update_withdraw_and_collision() -> None:
    original = parse_geonode_catalog(configuration(), catalog(), observed_at=NOW)
    changed = parse_geonode_catalog(
        configuration(),
        catalog(road_title="Updated road network", include_story=False),
        observed_at=NOW + timedelta(days=1),
    )
    previous = tuple(
        FederatedResourceState(
            original.source_fingerprint,
            item.remote_identifier,
            item.payload_sha256,
            "current",
            original.observed_at,
        )
        for item in original.resources
    )
    result = reconcile_geonode_harvest(changed, previous)

    assert result.counts == {"added": 0, "updated": 1, "unchanged": 0, "withdrawn": 1}
    assert [(item.remote_identifier, item.action) for item in result.items] == [
        (ROAD_ID, "updated"),
        (STORY_ID, "withdrawn"),
    ]
    replay = reconcile_geonode_harvest(
        changed,
        (
            FederatedResourceState(
                changed.source_fingerprint,
                changed.resources[0].remote_identifier,
                changed.resources[0].payload_sha256,
                "current",
                changed.observed_at,
            ),
            FederatedResourceState(
                changed.source_fingerprint,
                STORY_ID,
                previous[1].payload_sha256,
                "withdrawn",
                changed.observed_at,
            ),
        ),
    )
    assert replay.counts == {"added": 0, "updated": 0, "unchanged": 1, "withdrawn": 0}

    with pytest.raises(GeoNodeFederationFailure, match="local_identity_collision"):
        reconcile_geonode_harvest(
            changed,
            previous,
            local_identity_sources={ROAD_ID: "b" * 64},
        )
