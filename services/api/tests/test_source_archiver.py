import asyncio
import base64
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import httpx2
import pytest

from opengeo_api.cognito_provisioning import AwsCredentials
from opengeo_api.source_archiver import (
    AnonymousSourceFetcher,
    ArchiveFetchSpec,
    AsyncioPinnedArchiveTransport,
    AwsS3ArchiveStorage,
    FetchedArchive,
    HttpxArchiveS3Transport,
    SourceArchiveFailure,
    _FetchRequest,
    _read_response,
    _stored_archive,
    _stream_chunked,
    archive_target,
    archive_targets,
)


def test_provider_metadata_cannot_become_a_retained_layer_capture():
    with pytest.raises(SourceArchiveFailure) as caught:
        _stored_archive(
            "archive-bucket",
            "capture.json",
            FetchedArchive("application/json", 2, "a" * 64),
            {},
            require_metadata=False,
        )
    assert caught.value.code == "destination_integrity_failed"


PNG = b"\x89PNG\r\n\x1a\n" + b"bounded-image"
PMTILES = b"PMTiles\x03" + b"bounded-archive"
CHECKSUM = hashlib.sha256(PNG).hexdigest()
NOW = datetime(2026, 8, 28, 12, tzinfo=UTC)
KMS_ARN = "arn:aws:kms:us-east-1:111111111111:key/1234abcd-1234-4567-89ab-123456789abc"


def wms_spec(**changes: object) -> ArchiveFetchSpec:
    values = {
        "source_type": "wms",
        "source_url": "https://maps.example.com/geoserver/wms",
        "source_configuration": {
            "version": "1.3.0",
            "layers": ["massgis:wetlands", "massgis:habitat"],
            "styles": ["", "screening"],
            "format": "image/jpeg",
            "transparent": True,
            "crs": "EPSG:3857",
            "tile_size": 256,
            "attribution": "MassGIS",
        },
        "copy_method": "bounded_map_capture",
        "capture_scope": {
            "kind": "bounded_image",
            "bounds": [-71.5, 42.0, -71.0, 42.5],
            "width": 1024,
            "height": 512,
        },
        "maximum_requests": 1,
        "maximum_output_bytes": 2_162_688,
        "output_content_type": "image/png",
    }
    values.update(changes)
    return ArchiveFetchSpec(**values)  # type: ignore[arg-type]


def pmtiles_spec(**changes: object) -> ArchiveFetchSpec:
    values = {
        "source_type": "pmtiles",
        "source_url": "https://data.example.com/releases/roads.pmtiles",
        "source_configuration": {
            "tile_type": "vector",
            "source_layer": "roads",
            "geometry_type": "LineString",
            "min_zoom": 0,
            "max_zoom": 14,
            "attribution": "Example data",
        },
        "copy_method": "exact_object_copy",
        "capture_scope": {"kind": "exact_object"},
        "maximum_requests": 1,
        "maximum_output_bytes": 1_000_000,
        "output_content_type": "application/vnd.pmtiles",
    }
    values.update(changes)
    return ArchiveFetchSpec(**values)  # type: ignore[arg-type]


def arcgis_spec(**changes: object) -> ArchiveFetchSpec:
    values = {
        "source_type": "arcgis",
        "source_url": "https://services.example.com/ArcGIS/rest/services/facilities/FeatureServer/0",
        "source_configuration": {
            "object_id_field": "OBJECTID",
            "fields": ["OBJECTID", "name"],
            "geometry_type": "Point",
            "page_size": 2,
            "attribution": "Example agency",
        },
        "copy_method": "bounded_feature_capture",
        "capture_scope": {
            "kind": "bounded_features",
            "bounds": [-71.5, 42.0, -71.0, 42.5],
            "maximum_features": 3,
            "page_size": 2,
        },
        "maximum_requests": 2,
        "maximum_output_bytes": 1_000_000,
        "output_content_type": "application/geo+json",
    }
    values.update(changes)
    return ArchiveFetchSpec(**values)  # type: ignore[arg-type]


def wfs_spec(**changes: object) -> ArchiveFetchSpec:
    values = {
        "source_type": "wfs",
        "source_url": "https://maps.example.com/geoserver/wfs",
        "source_configuration": {
            "version": "2.0.0",
            "type_name": "public:facilities",
            "geometry_name": "geom",
            "fields": ["facility_id", "name"],
            "sort_by": "facility_id",
            "geometry_type": "Point",
            "page_size": 2,
            "attribution": "Example agency",
        },
        "copy_method": "bounded_feature_capture",
        "capture_scope": {
            "kind": "bounded_features",
            "bounds": [-71.5, 42.0, -71.0, 42.5],
            "maximum_features": 3,
            "page_size": 2,
        },
        "maximum_requests": 2,
        "maximum_output_bytes": 1_000_000,
        "output_content_type": "application/geo+json",
    }
    values.update(changes)
    return ArchiveFetchSpec(**values)  # type: ignore[arg-type]


def test_wms_target_is_canonical_png_getmap_with_projected_bounds() -> None:
    target = archive_target(wms_spec())
    path, query = target.path_and_query.split("?", 1)

    assert path == "/geoserver/wms"
    assert parse_qsl(query, keep_blank_values=True) == [
        ("SERVICE", "WMS"),
        ("REQUEST", "GetMap"),
        ("VERSION", "1.3.0"),
        ("LAYERS", "massgis:wetlands,massgis:habitat"),
        ("STYLES", ",screening"),
        ("FORMAT", "image/png"),
        ("TRANSPARENT", "TRUE"),
        ("WIDTH", "1024"),
        ("HEIGHT", "512"),
        ("CRS", "EPSG:3857"),
        (
            "BBOX",
            "-7959343.59171906,5160979.44404978,-7903683.84632242,5236173.78392094",
        ),
    ]


def test_wms_111_uses_srs_and_rejects_unprojectable_polar_scope() -> None:
    configuration = dict(wms_spec().source_configuration)
    configuration["version"] = "1.1.1"
    target = archive_target(wms_spec(source_configuration=configuration))
    query = dict(parse_qsl(target.path_and_query.split("?", 1)[1]))
    assert query["SRS"] == "EPSG:3857"
    assert "CRS" not in query

    scope = dict(wms_spec().capture_scope)
    scope["bounds"] = [-10, -89, 10, 20]
    with pytest.raises(SourceArchiveFailure) as error:
        archive_target(wms_spec(capture_scope=scope))
    assert error.value.code == "source_contract_invalid"
    assert error.value.retryable is False


@pytest.mark.parametrize(
    "source_url",
    [
        "http://maps.example.com/wms",
        "https://user@maps.example.com/wms",
        "https://maps.example.com:8443/wms",
        "https://maps.example.com/wms#fragment",
        "https://maps.example.com/wms?api_key=secret",
        "https://127.0.0.1/wms",
        "https://localhost/wms",
    ],
)
def test_source_target_rejects_non_anonymous_or_non_public_url_shapes(
    source_url: str,
) -> None:
    with pytest.raises(SourceArchiveFailure) as error:
        archive_target(wms_spec(source_url=source_url))
    assert error.value.code == "unsafe_network_target"


def test_wms_rejects_even_safe_base_query_to_keep_getmap_canonical() -> None:
    with pytest.raises(SourceArchiveFailure) as error:
        archive_target(wms_spec(source_url="https://maps.example.com/wms?lang=en"))
    assert error.value.code == "source_contract_invalid"


@pytest.mark.parametrize(
    "changes",
    [
        {"maximum_requests": 2},
        {"output_content_type": "application/vnd.pmtiles"},
        {"copy_method": "exact_object_copy"},
        {"capture_scope": {"kind": "exact_object"}},
        {"source_configuration": {"version": "1.3.0"}},
    ],
)
def test_wms_contract_cannot_expand_or_change_output(changes: dict[str, object]) -> None:
    with pytest.raises(SourceArchiveFailure) as error:
        archive_target(wms_spec(**changes))
    assert error.value.code == "source_contract_invalid"


def test_pmtiles_requires_exact_object_contract_and_v3_path() -> None:
    target = archive_target(pmtiles_spec(maximum_output_bytes=536_870_912))
    assert target.host == "data.example.com"
    assert target.path_and_query == "/releases/roads.pmtiles"

    with pytest.raises(SourceArchiveFailure) as error:
        archive_target(pmtiles_spec(source_url="https://data.example.com/roads.bin"))
    assert error.value.code == "source_contract_invalid"


def test_feature_targets_pin_stable_order_fields_bounds_and_final_page_size() -> None:
    arcgis = archive_targets(arcgis_spec())
    first_path, first_query = arcgis[0].path_and_query.split("?", 1)
    second_query = dict(parse_qsl(arcgis[1].path_and_query.split("?", 1)[1]))
    first = dict(parse_qsl(first_query))

    assert first_path.endswith("/FeatureServer/0/query")
    assert first["f"] == "geojson"
    assert first["outFields"] == "OBJECTID,name"
    assert first["orderByFields"] == "OBJECTID ASC"
    assert first["geometry"] == "-71.5,42,-71,42.5"
    assert first["resultOffset"] == "0"
    assert first["resultRecordCount"] == "2"
    assert second_query["resultOffset"] == "2"
    assert second_query["resultRecordCount"] == "1"

    wfs = archive_targets(wfs_spec())
    first_wfs = dict(parse_qsl(wfs[0].path_and_query.split("?", 1)[1]))
    second_wfs = dict(parse_qsl(wfs[1].path_and_query.split("?", 1)[1]))
    assert first_wfs["SERVICE"] == "WFS"
    assert first_wfs["VERSION"] == "2.0.0"
    assert first_wfs["TYPENAMES"] == "public:facilities"
    assert first_wfs["PROPERTYNAME"] == "facility_id,name,geom"
    assert first_wfs["SORTBY"] == "facility_id A"
    assert first_wfs["BBOX"] == "-71.5,42,-71,42.5,urn:ogc:def:crs:OGC::CRS84"
    assert first_wfs["COUNT"] == "2"
    assert second_wfs["COUNT"] == "1"
    assert second_wfs["STARTINDEX"] == "2"


@pytest.mark.parametrize(
    "spec",
    [
        arcgis_spec(source_url="https://services.example.com/FeatureServer"),
        arcgis_spec(maximum_requests=1),
        arcgis_spec(maximum_output_bytes=134_217_729),
        arcgis_spec(
            source_configuration={
                **arcgis_spec().source_configuration,
                "page_size": 1,
            }
        ),
        wfs_spec(source_url="https://maps.example.com/wfs?SERVICE=WFS"),
        wfs_spec(maximum_requests=3),
    ],
)
def test_feature_contract_rejects_ambiguous_paths_or_limit_drift(
    spec: ArchiveFetchSpec,
) -> None:
    with pytest.raises(SourceArchiveFailure) as error:
        archive_targets(spec)
    assert error.value.code == "source_contract_invalid"

    with pytest.raises(SourceArchiveFailure) as error:
        archive_target(pmtiles_spec(maximum_output_bytes=536_870_913))
    assert error.value.code == "source_contract_invalid"


class Resolver:
    def __init__(self, addresses: tuple[str, ...]) -> None:
        self.addresses = addresses
        self.calls: list[tuple[str, int]] = []

    async def resolve(self, host: str, port: int) -> tuple[str, ...]:
        self.calls.append((host, port))
        return self.addresses


class PinnedTransport:
    def __init__(self, body: bytes = PNG) -> None:
        self.body = body
        self.calls: list[tuple[str, str, str, int]] = []

    async def fetch(self, target, pinned_address, request, destination):
        self.calls.append((target.host, pinned_address, request.accept, request.maximum_bytes))
        _write_bytes(destination, self.body)
        return FetchedArchive(
            request.accept,
            len(self.body),
            hashlib.sha256(self.body).hexdigest(),
        )


class FeaturePageTransport:
    def __init__(self, pages: list[bytes]) -> None:
        self.pages = pages
        self.calls: list[tuple[str, str, str, int]] = []

    async def fetch(self, target, pinned_address, request, destination):
        self.calls.append(
            (target.path_and_query, pinned_address, request.accept, request.maximum_bytes)
        )
        if not self.pages:
            raise AssertionError("unexpected feature page request")
        body = self.pages.pop(0)
        _write_bytes(destination, body)
        return FetchedArchive(
            "application/geo+json",
            len(body),
            hashlib.sha256(body).hexdigest(),
        )


def feature_page(features: list[dict[str, object]]) -> bytes:
    return json.dumps(
        {"type": "FeatureCollection", "features": features},
        separators=(",", ":"),
    ).encode()


def point_feature(identity: int, name: str, **changes: object) -> dict[str, object]:
    value: dict[str, object] = {
        "type": "Feature",
        "id": identity,
        "properties": {"OBJECTID": identity, "name": name},
        "geometry": {"type": "Point", "coordinates": [-71.2, 42.3]},
    }
    value.update(changes)
    return value


def test_fetcher_resolves_once_and_pins_only_public_answers(tmp_path: Path) -> None:
    resolver = Resolver(("93.184.216.34",))
    transport = PinnedTransport()
    fetcher = AnonymousSourceFetcher(resolver=resolver, transport=transport)

    result = asyncio.run(fetcher.fetch(wms_spec(), tmp_path / "capture.png"))

    assert result.size_bytes == len(PNG)
    assert resolver.calls == [("maps.example.com", 443)]
    assert transport.calls == [("maps.example.com", "93.184.216.34", "image/png", 2_162_688)]


def test_fetcher_rejects_entire_dns_set_if_one_answer_is_not_global(tmp_path: Path) -> None:
    resolver = Resolver(("93.184.216.34", "10.0.0.7"))
    transport = PinnedTransport()
    fetcher = AnonymousSourceFetcher(resolver=resolver, transport=transport)

    with pytest.raises(SourceArchiveFailure) as error:
        asyncio.run(fetcher.fetch(wms_spec(), tmp_path / "capture.png"))

    assert error.value.code == "unsafe_network_target"
    assert error.value.retryable is False
    assert transport.calls == []


@pytest.mark.parametrize(
    ("content_type", "prefix"),
    [
        ("image/tiff", b"II*\0\x08\0\0\0"),
        ("image/geotiff", b"MM\0*\0\0\0\x08"),
        ("image/tiff", b"II+\0\x08\0\0\0"),
        ("image/geotiff", b"MM\0+\0\x08\0\0"),
    ],
)
def test_public_file_stages_exact_classic_and_big_tiff_without_storage(
    tmp_path, content_type, prefix
):
    body = prefix + b"bounded-tiff"
    response = (
        f"HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\n"
        f"Content-Length: {len(body)}\r\n\r\n".encode()
        + body
    )
    connector = Connector(response)
    resolver = Resolver(("93.184.216.34",))
    destination = tmp_path / "exact.tif"
    result = asyncio.run(
        AnonymousSourceFetcher(
            resolver=resolver, transport=AsyncioPinnedArchiveTransport(connector)
        ).fetch_public_file(
            "https://data.example.com/exact.tif",
            content_type=content_type,
            size_bytes=len(body),
            checksum_sha256=hashlib.sha256(body).hexdigest(),
            destination=destination,
        )
    )
    assert result == FetchedArchive(content_type, len(body), hashlib.sha256(body).hexdigest())
    assert destination.read_bytes() == body
    assert list(tmp_path.iterdir()) == [destination]
    assert resolver.calls == [("data.example.com", 443)]
    assert connector.calls == [("93.184.216.34", "data.example.com", True)]
    assert b"Accept-Encoding: identity\r\n" in connector.writer.request
    assert b"Authorization:" not in connector.writer.request
    assert b"Cookie:" not in connector.writer.request
    assert connector.writer.closed


@pytest.mark.parametrize(
    "changes",
    [
        {"content_type": "application/octet-stream"},
        {"size_bytes": True},
        {"size_bytes": 0},
        {"size_bytes": 67_108_865},
        {"checksum_sha256": "A" * 64},
        {"checksum_sha256": "a" * 63},
    ],
)
def test_public_file_rejects_unsealed_facts_without_network(tmp_path, changes):
    resolver = Resolver(("93.184.216.34",))
    transport = PinnedTransport()
    facts = {"content_type": "image/tiff", "size_bytes": 20, "checksum_sha256": "a" * 64}
    with pytest.raises(SourceArchiveFailure) as caught:
        asyncio.run(
            AnonymousSourceFetcher(resolver=resolver, transport=transport).fetch_public_file(
                "https://data.example.com/exact.tif",
                **(facts | changes),
                destination=tmp_path / "exact.tif",
            )
        )
    assert caught.value.code == "source_contract_invalid"
    assert resolver.calls == transport.calls == []
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize(
    "url",
    [
        "http://data.example.com/exact.tif",
        "https://user:secret@data.example.com/exact.tif",
        "https://127.0.0.1/exact.tif",
        "https://data.internal/exact.tif",
        "https://data.example.com/exact.tif?download=1",
        "https://data.example.com/exact.tif?",
        "https://data.example.com/exact.tif#version",
        "https://data.example.com/exact tif",
    ],
)
def test_public_file_rejects_unsafe_or_query_urls_without_network(tmp_path, url):
    resolver = Resolver(("93.184.216.34",))
    transport = PinnedTransport()
    with pytest.raises(SourceArchiveFailure) as caught:
        asyncio.run(
            AnonymousSourceFetcher(resolver=resolver, transport=transport).fetch_public_file(
                url,
                content_type="image/tiff",
                size_bytes=20,
                checksum_sha256="a" * 64,
                destination=tmp_path / "exact.tif",
            )
        )
    assert caught.value.code == "unsafe_network_target"
    assert resolver.calls == transport.calls == []
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize(
    ("body", "size", "checksum", "code"),
    [
        (b"II*\0\x08\0\0\0tiff", 12, "a" * 64, "destination_integrity_failed"),
        (b"II*\0\x08\0\0\0tiff", 13, None, "destination_integrity_failed"),
        (b"not-tiff-body", 13, None, "response_magic_rejected"),
        (b"II+\0\x04\0\0\0bad!", 12, None, "response_magic_rejected"),
    ],
)
def test_public_file_rejects_size_hash_and_magic_and_removes_partial(
    tmp_path, body, size, checksum, code
):
    transport = PinnedTransport(body)
    with pytest.raises(SourceArchiveFailure) as caught:
        asyncio.run(
            AnonymousSourceFetcher(
                resolver=Resolver(("93.184.216.34",)), transport=transport
            ).fetch_public_file(
                "https://data.example.com/exact.tif",
                content_type="image/tiff",
                size_bytes=size,
                checksum_sha256=checksum or hashlib.sha256(body).hexdigest(),
                destination=tmp_path / "exact.tif",
            )
        )
    assert caught.value.code == code
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("existing", ["file", "symlink"])
def test_public_file_preserves_existing_destination_without_network(tmp_path, existing):
    destination = tmp_path / "exact.tif"
    if existing == "file":
        destination.write_bytes(b"unrelated")
    else:
        destination.symlink_to(tmp_path / "absent-target")
    resolver = Resolver(("93.184.216.34",))
    transport = PinnedTransport()
    with pytest.raises(SourceArchiveFailure) as caught:
        asyncio.run(
            AnonymousSourceFetcher(resolver=resolver, transport=transport).fetch_public_file(
                "https://data.example.com/exact.tif",
                content_type="image/tiff",
                size_bytes=20,
                checksum_sha256="a" * 64,
                destination=destination,
            )
        )
    assert caught.value.code == "destination_conflict"
    assert resolver.calls == transport.calls == []
    if existing == "file":
        assert destination.read_bytes() == b"unrelated"
    else:
        assert destination.is_symlink()
    assert list(tmp_path.iterdir()) == [destination]


def test_public_file_preserves_destination_created_during_fetch(tmp_path):
    destination = tmp_path / "exact.tif"
    body = b"II*\0\x08\0\0\0bounded-tiff"

    class RacingTransport(PinnedTransport):
        async def fetch(self, *args):
            result = await super().fetch(*args)
            destination.write_bytes(b"unrelated")
            return result

    with pytest.raises(SourceArchiveFailure) as caught:
        asyncio.run(
            AnonymousSourceFetcher(
                resolver=Resolver(("93.184.216.34",)), transport=RacingTransport(body)
            ).fetch_public_file(
                "https://data.example.com/exact.tif",
                content_type="image/tiff",
                size_bytes=len(body),
                checksum_sha256=hashlib.sha256(body).hexdigest(),
                destination=destination,
            )
        )
    assert caught.value.code == "destination_conflict"
    assert destination.read_bytes() == b"unrelated"
    assert list(tmp_path.iterdir()) == [destination]


@pytest.mark.parametrize(
    "failure",
    [
        SourceArchiveFailure("response_invalid", retryable=False),
        TimeoutError(),
        asyncio.CancelledError(),
    ],
)
def test_public_file_cleans_partial_on_transport_failure_timeout_or_cancellation(tmp_path, failure):
    class FailingTransport:
        async def fetch(self, _target, _address, _request, destination):
            destination.write_bytes(b"partial")
            raise failure

    with pytest.raises(SourceArchiveFailure):
        asyncio.run(
            AnonymousSourceFetcher(
                resolver=Resolver(("93.184.216.34",)), transport=FailingTransport()
            ).fetch_public_file(
                "https://data.example.com/exact.tif",
                content_type="image/tiff",
                size_bytes=20,
                checksum_sha256="a" * 64,
                destination=tmp_path / "exact.tif",
            )
        )
    assert not list(tmp_path.iterdir())


def test_chunked_body_reads_at_most_64_kib_before_short_body_failure():
    class TrackingReader(asyncio.StreamReader):
        def __init__(self):
            super().__init__()
            self.exact_reads = []

        async def readexactly(self, count):
            self.exact_reads.append(count)
            return await super().readexactly(count)

    async def operation():
        reader = TrackingReader()
        reader.feed_data(b"10001\r\n")  # One 65,537-byte chunk; no body allocation.
        reader.feed_eof()
        with pytest.raises(SourceArchiveFailure) as caught:
            await _stream_chunked(
                reader, 65_537, lambda data: len(data), hashlib.sha256(), bytearray()
            )
        assert caught.value.code == "response_invalid"
        assert reader.exact_reads == [65_536]

    asyncio.run(operation())


@pytest.mark.parametrize("media", ["image/tiff", "image/geotiff"])
def test_public_file_cannot_become_a_retained_layer_capture(tmp_path, media):
    body = b"II*\0\x08\0\0\0tiff"
    source = tmp_path / "capture.tif"
    source.write_bytes(body)
    fetched = FetchedArchive(media, len(body), hashlib.sha256(body).hexdigest())
    with pytest.raises(SourceArchiveFailure) as caught:
        _stored_archive(
            "archive-bucket",
            "capture.tif",
            fetched,
            {},
            require_metadata=False,
        )
    assert caught.value.code == "destination_integrity_failed"
    transport = S3Transport((200, {}))
    with pytest.raises(SourceArchiveFailure, match="destination_integrity_failed"):
        asyncio.run(storage(transport).store("organizations/o/capture.tif", source, fetched))
    assert transport.put_calls == transport.head_calls == []


def test_feature_fetcher_pages_to_one_canonical_geojson_archive(tmp_path: Path) -> None:
    resolver = Resolver(("93.184.216.34",))
    transport = FeaturePageTransport(
        [
            feature_page([point_feature(1, "Clinic"), point_feature(2, "School")]),
            feature_page([point_feature(3, "Library")]),
        ]
    )
    destination = tmp_path / "snapshot.geojson"

    result = asyncio.run(
        AnonymousSourceFetcher(resolver=resolver, transport=transport).fetch(
            arcgis_spec(),
            destination,
        )
    )

    payload = json.loads(destination.read_text())
    assert result.content_type == "application/geo+json"
    assert result.size_bytes == destination.stat().st_size
    assert result.checksum_sha256 == hashlib.sha256(destination.read_bytes()).hexdigest()
    assert [feature["properties"]["OBJECTID"] for feature in payload["features"]] == [1, 2, 3]
    assert resolver.calls == [("services.example.com", 443), ("services.example.com", 443)]
    assert len(transport.calls) == 2
    assert all(
        call[2] == "application/geo+json, application/json;q=0.9" for call in transport.calls
    )
    assert not list(tmp_path.glob("*.page-*"))


def test_feature_fetcher_accepts_a_bounded_empty_result(tmp_path: Path) -> None:
    destination = tmp_path / "empty.geojson"
    result = asyncio.run(
        AnonymousSourceFetcher(
            resolver=Resolver(("93.184.216.34",)),
            transport=FeaturePageTransport([feature_page([])]),
        ).fetch(arcgis_spec(), destination)
    )

    assert result.content_type == "application/geo+json"
    payload = json.loads(destination.read_text())
    assert payload["features"] == []
    assert payload["opengeo:capture"]["countStatus"] == "unknown"


@pytest.mark.parametrize(
    "pages",
    [
        [
            feature_page([point_feature(1, "Clinic"), point_feature(2, "School")]),
            feature_page([point_feature(2, "Duplicate")]),
        ],
        [
            feature_page(
                [
                    point_feature(
                        1,
                        "Wrong geometry",
                        geometry={
                            "type": "LineString",
                            "coordinates": [[-71.2, 42.3], [-71.1, 42.4]],
                        },
                    )
                ]
            )
        ],
        [
            feature_page(
                [
                    point_feature(
                        1,
                        "Wrong point shape",
                        geometry={"type": "Point", "coordinates": [[-71.2, 42.3]]},
                    )
                ]
            )
        ],
        [
            feature_page(
                [
                    point_feature(
                        1,
                        "Extra field",
                        properties={"OBJECTID": 1, "name": "Extra field", "secret": "no"},
                    )
                ]
            )
        ],
    ],
)
def test_feature_fetcher_rejects_duplicate_or_shape_expanding_pages(
    tmp_path: Path,
    pages: list[bytes],
) -> None:
    with pytest.raises(SourceArchiveFailure) as error:
        asyncio.run(
            AnonymousSourceFetcher(
                resolver=Resolver(("93.184.216.34",)),
                transport=FeaturePageTransport(pages),
            ).fetch(arcgis_spec(), tmp_path / "rejected.geojson")
        )
    assert error.value.code == "response_invalid"
    assert not list(tmp_path.glob("*.page-*"))
    assert not (tmp_path / "rejected.geojson").exists()


class Writer:
    def __init__(self) -> None:
        self.request = b""
        self.closed = False

    def write(self, data: bytes) -> None:
        self.request += data

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        self.closed = True

    async def wait_closed(self) -> None:
        return None


class Connector:
    def __init__(self, response: bytes) -> None:
        self.response = response
        self.calls: list[tuple[str, str, bool]] = []
        self.writer = Writer()

    async def connect(self, pinned_address, host, context):
        self.calls.append((pinned_address, host, context.check_hostname))
        reader = asyncio.StreamReader()
        reader.feed_data(self.response)
        reader.feed_eof()
        return reader, self.writer


def test_raw_transport_uses_pinned_ip_and_original_sni_without_ambient_headers(
    tmp_path: Path,
) -> None:
    response = (
        b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\n"
        + f"Content-Length: {len(PNG)}\r\n\r\n".encode()
        + PNG
    )
    connector = Connector(response)
    transport = AsyncioPinnedArchiveTransport(connector)
    target = archive_target(wms_spec())

    result = asyncio.run(
        transport.fetch(
            target,
            "93.184.216.34",
            _FetchRequest("image/png", len(PNG)),
            tmp_path / "capture.png",
        )
    )

    assert result.checksum_sha256 == CHECKSUM
    assert connector.calls == [("93.184.216.34", "maps.example.com", True)]
    request = connector.writer.request
    assert b"Host: maps.example.com\r\n" in request
    assert b"Accept-Encoding: identity\r\n" in request
    assert b"Authorization:" not in request
    assert b"Cookie:" not in request


@pytest.mark.parametrize(
    ("headers", "body", "code"),
    [
        (
            b"HTTP/1.1 302 Found\r\nLocation: https://other.example.com/\r\n\r\n",
            b"",
            "redirect_rejected",
        ),
        (
            b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 8\r\n\r\n",
            b"not png!",
            "response_media_rejected",
        ),
        (
            b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\n"
            b"Content-Encoding: gzip\r\nContent-Length: 8\r\n\r\n",
            PNG,
            "response_invalid",
        ),
        (
            b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 8\r\n\r\n",
            b"not png!",
            "response_magic_rejected",
        ),
        (b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n", b"", "upstream_rejected"),
        (
            b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 999\r\n\r\n",
            PNG,
            "response_too_large",
        ),
        (
            b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\n"
            b"Content-Type: image/png\r\nContent-Length: 8\r\n\r\n",
            PNG,
            "response_invalid",
        ),
    ],
)
def test_response_parser_rejects_redirect_media_encoding_magic_and_upstream(
    tmp_path: Path,
    headers: bytes,
    body: bytes,
    code: str,
) -> None:
    with pytest.raises(SourceArchiveFailure) as error:
        asyncio.run(
            _parse_response(
                headers + body,
                _FetchRequest("image/png", len(PNG)),
                tmp_path / "invalid.bin",
            )
        )
    assert error.value.code == code


def test_response_parser_streams_chunked_pmtiles_with_magic_and_hash(tmp_path: Path) -> None:
    first = PMTILES[:9]
    second = PMTILES[9:]
    response = (
        b"HTTP/1.1 200 OK\r\nContent-Type: application/vnd.pmtiles\r\n"
        b"Transfer-Encoding: chunked\r\n\r\n"
        + f"{len(first):x}\r\n".encode()
        + first
        + b"\r\n"
        + f"{len(second):x}\r\n".encode()
        + second
        + b"\r\n0\r\n\r\n"
    )
    result = asyncio.run(
        _parse_response(
            response,
            _FetchRequest("application/vnd.pmtiles", len(PMTILES)),
            tmp_path / "archive.pmtiles",
        )
    )

    assert result.size_bytes == len(PMTILES)
    assert result.checksum_sha256 == hashlib.sha256(PMTILES).hexdigest()
    assert (tmp_path / "archive.pmtiles").read_bytes() == PMTILES


async def _parse_response(
    response: bytes,
    request: _FetchRequest,
    destination: Path,
) -> FetchedArchive:
    reader = asyncio.StreamReader()
    reader.feed_data(response)
    reader.feed_eof()
    return await _read_response(reader, request, destination)


class Credentials:
    def load(self) -> AwsCredentials:
        return AwsCredentials("AKIDEXAMPLE", "secret-value", "session-token")


class S3Transport:
    def __init__(
        self,
        put_response: tuple[int, dict[str, str]],
        head_response: tuple[int, dict[str, str]] | None = None,
    ) -> None:
        self.put_response = put_response
        self.head_response = head_response
        self.put_calls: list[tuple[str, dict[str, str], bytes, float]] = []
        self.head_calls: list[tuple[str, dict[str, str], float]] = []
        self.get_calls: list[tuple[str, dict[str, str], int]] = []
        self.list_response: tuple[int, dict[str, str], bytes] | None = None

    async def put(self, url, headers, source, timeout_seconds):
        body = _read_bytes(source)
        self.put_calls.append((url, dict(headers), body, timeout_seconds))
        return self.put_response

    async def head(self, url, headers, timeout_seconds):
        self.head_calls.append((url, dict(headers), timeout_seconds))
        assert self.head_response is not None
        return self.head_response

    async def get(self, url, headers, timeout_seconds, maximum_bytes):
        self.get_call = (url, dict(headers), maximum_bytes)
        self.get_calls.append(self.get_call)
        parameters = dict(parse_qsl(urlsplit(url).query))
        if parameters.get("list-type") == "2":
            return self.list_response or (200, {}, metadata_listing(parameters["prefix"]))
        assert self.head_response is not None
        return self.head_response[0], self.head_response[1], getattr(self, "get_body", b"")


def metadata_listing(key: str, *, present: bool = True) -> bytes:
    contents = f"<Contents><Key>{key}</Key></Contents>" if present else ""
    return (
        '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
        f"<Prefix>{key}</Prefix><MaxKeys>1</MaxKeys><KeyCount>{int(present)}</KeyCount>"
        f"<IsTruncated>false</IsTruncated>{contents}</ListBucketResult>"
    ).encode()


def _write_bytes(path: Path, body: bytes) -> None:
    path.write_bytes(body)


def _read_bytes(path: Path) -> bytes:
    return path.read_bytes()


def storage(transport: S3Transport) -> AwsS3ArchiveStorage:
    return AwsS3ArchiveStorage(
        region="us-east-1",
        bucket="opengeo-geodata",
        kms_key_arn=KMS_ARN,
        credentials=Credentials(),
        transport=transport,
        now=lambda: NOW,
    )


def test_metadata_storage_keeps_exact_version_and_reconciles_first_response():
    from uuid import UUID

    from opengeo_api.source_archiver import discovery_metadata_key

    body = b" " * 32_769
    checksum = hashlib.sha256(body).hexdigest()
    key = discovery_metadata_key(*(UUID(f"10000000-0000-4000-8000-{n:012d}") for n in (1, 2, 3)))
    headers = {
        "x-amz-version-id": "first-version",
        "etag": '"' + "a" * 32 + '"',
        "content-length": str(len(body)),
        "content-type": "application/octet-stream",
        "x-amz-checksum-sha256": base64.b64encode(bytes.fromhex(checksum)).decode(),
        "x-amz-meta-opengeo-sha256": checksum,
        "x-amz-meta-opengeo-retrieved-at": NOW.isoformat(),
        "x-amz-server-side-encryption": "aws:kms",
        "x-amz-server-side-encryption-aws-kms-key-id": KMS_ARN,
    }
    transport = S3Transport((200, headers), (200, headers))
    transport.get_body = body
    store = storage(transport)
    raw, receipt = asyncio.run(store.store_discovery_document(key, body, NOW.isoformat()))
    assert raw == body and receipt["object"]["version_id"] == "first-version"
    assert transport.put_calls[0][1]["if-none-match"] == "*"
    assert "discovery-metadata/organizations/" in transport.put_calls[0][0]
    transport.put_response = (412, {})
    raw, reopened = asyncio.run(
        store.store_discovery_document(key, b"x" * len(body), NOW.isoformat())
    )
    assert raw == body and reopened == receipt
    assert "versionId=" not in transport.get_call[0]
    assert transport.get_call[2] == 2_097_152
    assert len(transport.get_calls) == 2 and transport.head_calls == []
    assert transport.get_call[1]["x-amz-checksum-mode"] == "ENABLED"
    listing_url, listing_headers, listing_cap = transport.get_calls[0]
    assert dict(parse_qsl(urlsplit(listing_url).query)) == {
        "list-type": "2",
        "max-keys": "1",
        "prefix": key,
    }
    assert urlsplit(listing_url).path == "/opengeo-geodata/"
    assert listing_cap == 16_384 and "authorization" in listing_headers
    transport.get_body = b"x" * len(body)
    with pytest.raises(SourceArchiveFailure, match="destination_integrity_failed"):
        asyncio.run(store.read_discovery_document(key))
    with pytest.raises(SourceArchiveFailure, match="destination_integrity_failed"):
        asyncio.run(
            store.store_discovery_document(
                "organizations/wrong/response.bin", body, NOW.isoformat()
            )
        )


def test_metadata_storage_authorized_absence_skips_head():
    from uuid import UUID

    from opengeo_api.source_archiver import discovery_metadata_key

    key = discovery_metadata_key(*(UUID(f"10000000-0000-4000-8000-{n:012d}") for n in (1, 2, 3)))
    transport = S3Transport((200, {}), (403, {}))
    transport.list_response = (200, {}, metadata_listing(key, present=False))
    assert asyncio.run(storage(transport).read_discovery_document(key)) is None
    assert len(transport.get_calls) == 1 and transport.head_calls == []


def test_metadata_storage_denied_listing_never_refetches_provider():
    from uuid import UUID

    from opengeo_api.source_discovery_runtime import (
        SourceDiscoveryClaim,
        SourceDiscoveryCommand,
        SourceDiscoveryDependencyUnavailable,
        SourceDiscoveryProcessor,
    )

    identities = [UUID(f"10000000-0000-4000-8000-{n:012d}") for n in (1, 2, 3)]
    organization_id, project_id, job_id = identities
    transport = S3Transport((200, {}), (403, {}))
    transport.list_response = (403, {}, b"AccessDenied")

    class Coordinator:
        def __init__(self):
            self.releases = []

        async def claim(self, *_):
            return SourceDiscoveryClaim(
                job_id,
                "arcgis",
                "catalog",
                "https://example.test/FeatureServer",
                None,
                2,
                organization_id,
                project_id,
            )

        async def release(self, *arguments):
            self.releases.append(arguments)
            return "queued"

    class Engine:
        async def discover(self, _):
            raise AssertionError("denied storage must never trigger provider refetch")

    coordinator = Coordinator()
    processor = SourceDiscoveryProcessor(coordinator, Engine(), document_storage=storage(transport))
    with pytest.raises(SourceDiscoveryDependencyUnavailable):
        asyncio.run(processor.process(SourceDiscoveryCommand(job_id)))
    assert coordinator.releases[-1][-1] == "upstream_unavailable"
    assert len(transport.get_calls) == 1 and transport.head_calls == []


def test_metadata_storage_present_listing_read_denial_stays_closed():
    from uuid import UUID

    from opengeo_api.source_archiver import discovery_metadata_key

    key = discovery_metadata_key(*(UUID(f"10000000-0000-4000-8000-{n:012d}") for n in (1, 2, 3)))
    transport = S3Transport((200, {}), (403, {}))
    with pytest.raises(SourceArchiveFailure, match="destination_unavailable"):
        asyncio.run(storage(transport).read_discovery_document(key))
    assert len(transport.get_calls) == 2 and transport.head_calls == []


@pytest.mark.parametrize("declared_length", ["5", "-1", "invalid"])
def test_metadata_get_rejects_invalid_size_before_reading_body(monkeypatch, declared_length):
    class Response:
        status_code = 200

        def __init__(self):
            self.headers = {"content-length": declared_length}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def aiter_raw(self):
            raise AssertionError("invalid or oversized response must not read its body")
            yield b""

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        def stream(self, *_args, **_kwargs):
            return Response()

    monkeypatch.setattr(httpx2, "AsyncClient", lambda **_kwargs: Client())
    with pytest.raises(SourceArchiveFailure, match="destination_integrity_failed"):
        asyncio.run(HttpxArchiveS3Transport().get("https://example.test", {}, 1, 4))


def test_metadata_get_keeps_streaming_limit_without_content_length(monkeypatch):
    class Response:
        status_code = 200

        def __init__(self):
            self.headers = {}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def aiter_raw(self):
            yield b"123"
            yield b"45"

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        def stream(self, *_args, **_kwargs):
            return Response()

    monkeypatch.setattr(httpx2, "AsyncClient", lambda **_kwargs: Client())
    with pytest.raises(SourceArchiveFailure, match="destination_integrity_failed"):
        asyncio.run(HttpxArchiveS3Transport().get("https://example.test", {}, 1, 4))


def test_s3_storage_conditionally_creates_exact_encrypted_checksummed_object(
    tmp_path: Path,
) -> None:
    source = tmp_path / "capture.png"
    source.write_bytes(PNG)
    fetched = FetchedArchive("image/png", len(PNG), CHECKSUM)
    transport = S3Transport((200, {"x-amz-version-id": "version-1", "etag": '"0123456789abcdef"'}))
    key = "organizations/o/projects/p/datasets/d/uploads/j/original/snapshot.png"

    stored = asyncio.run(storage(transport).store(key, source, fetched))

    assert stored.s3_version_id == "version-1"
    assert stored.checksum_sha256 == CHECKSUM
    assert len(transport.put_calls) == 1
    url, headers, body, timeout = transport.put_calls[0]
    assert url.endswith("/opengeo-geodata/" + key)
    assert body == PNG
    assert timeout == 120.0
    assert headers["if-none-match"] == "*"
    assert headers["x-amz-server-side-encryption"] == "aws:kms"
    assert headers["x-amz-server-side-encryption-aws-kms-key-id"] == KMS_ARN
    assert headers["x-amz-meta-opengeo-sha256"] == CHECKSUM
    assert base64.b64decode(headers["x-amz-checksum-sha256"]).hex() == CHECKSUM
    assert "secret-value" not in headers["authorization"]
    assert transport.head_calls == []


def test_s3_storage_reconciles_conditional_retry_only_when_exact_object_matches(
    tmp_path: Path,
) -> None:
    source = tmp_path / "capture.png"
    source.write_bytes(PNG)
    fetched = FetchedArchive("image/png", len(PNG), CHECKSUM)
    transport = S3Transport(
        (412, {}),
        (
            200,
            {
                "x-amz-version-id": "version-existing",
                "etag": '"fedcba9876543210"',
                "content-length": str(len(PNG)),
                "content-type": "image/png",
                "x-amz-meta-opengeo-sha256": CHECKSUM,
                "x-amz-checksum-sha256": base64.b64encode(bytes.fromhex(CHECKSUM)).decode(),
            },
        ),
    )

    stored = asyncio.run(
        storage(transport).store(
            "organizations/o/projects/p/datasets/d/uploads/j/original/snapshot.png",
            source,
            fetched,
        )
    )

    assert stored.s3_version_id == "version-existing"
    assert len(transport.put_calls) == 1
    assert len(transport.head_calls) == 1
    assert transport.head_calls[0][1]["x-amz-checksum-mode"] == "ENABLED"


def test_s3_storage_rejects_conflicting_preexisting_object(tmp_path: Path) -> None:
    source = tmp_path / "capture.png"
    source.write_bytes(PNG)
    fetched = FetchedArchive("image/png", len(PNG), CHECKSUM)
    transport = S3Transport(
        (412, {}),
        (
            200,
            {
                "x-amz-version-id": "version-existing",
                "etag": '"fedcba9876543210"',
                "content-length": str(len(PNG)),
                "content-type": "image/png",
                "x-amz-meta-opengeo-sha256": "0" * 64,
            },
        ),
    )

    with pytest.raises(SourceArchiveFailure) as error:
        asyncio.run(
            storage(transport).store(
                "organizations/o/projects/p/datasets/d/uploads/j/original/snapshot.png",
                source,
                fetched,
            )
        )
    assert error.value.code == "destination_conflict"
    assert error.value.retryable is False


@pytest.mark.parametrize("matched", [3, 8, "unknown", None])
@pytest.mark.parametrize("source", ["arcgis", "wfs"])
def test_capture_retains_provider_counts_with_bounded_scope(tmp_path, matched, source):
    pages = []
    for items in ([point_feature(1, "A"), point_feature(2, "B")], [point_feature(3, "C")]):
        payload = json.loads(feature_page(items))
        if source == "wfs":
            for item in payload["features"]:
                item["properties"]["facility_id"] = item["properties"].pop("OBJECTID")
        payload.update(numberMatched=matched, numberReturned=len(items))
        pages.append(json.dumps(payload).encode())
    transport = FeaturePageTransport(list(pages))
    destination = tmp_path / "counted.geojson"
    result = asyncio.run(
        AnonymousSourceFetcher(resolver=Resolver(("93.184.216.34",)), transport=transport).fetch(
            wfs_spec() if source == "wfs" else arcgis_spec(), destination
        )
    )
    evidence = json.loads(destination.read_text())["opengeo:capture"]
    assert evidence["fetchedCount"] == 3
    assert evidence["numberMatched"] == (matched if type(matched) is int else None)
    assert evidence["countStatus"] == (
        "matched_bounded_scope" if type(matched) is int else "unknown"
    )
    assert evidence["limitedByMaximumFeatures"] == (matched > 3 if type(matched) is int else None)
    assert evidence["pages"][0]["sha256"] == hashlib.sha256(pages[0]).hexdigest()
    assert evidence["pages"][0]["reported"]["numberMatched"] == matched
    assert len(transport.calls) == 2
    assert result.checksum_sha256 == hashlib.sha256(destination.read_bytes()).hexdigest()


@pytest.mark.parametrize(
    "counts,error_code",
    [
        ([(0, 2)], "source_count_mismatch"),  # provider total contradicts fetched content
        ([(3, 2), (4, 1)], "source_count_mismatch"),  # count changes between pages
        ([(3, 1)], "response_invalid"),  # returned count differs from actual two features
        ([(True, 2)], "response_invalid"),
        ([(3.0, 2)], "response_invalid"),
        ([(-1, 2)], "response_invalid"),
        ([("3", 2)], "response_invalid"),
        ([(3, False)], "response_invalid"),
    ],
)
@pytest.mark.parametrize("source", ["arcgis", "wfs"])
def test_capture_rejects_inconsistent_provider_count_and_removes_output(
    tmp_path, counts, error_code, source
):
    pages = []
    for i, (matched, returned) in enumerate(counts):
        items = (
            [point_feature(1, "A"), point_feature(2, "B")] if i == 0 else [point_feature(3, "C")]
        )
        payload = json.loads(feature_page(items))
        if source == "wfs":
            for item in payload["features"]:
                item["properties"]["facility_id"] = item["properties"].pop("OBJECTID")
        payload.update(numberMatched=matched, numberReturned=returned)
        pages.append(json.dumps(payload).encode())
    destination = tmp_path / "rejected.geojson"
    with pytest.raises(SourceArchiveFailure, match=error_code):
        asyncio.run(
            AnonymousSourceFetcher(
                resolver=Resolver(("93.184.216.34",)), transport=FeaturePageTransport(pages)
            ).fetch(wfs_spec() if source == "wfs" else arcgis_spec(), destination)
        )
    assert not destination.exists()
    assert not list(tmp_path.glob("*.page-*"))


def test_capture_rejects_short_page_when_provider_reports_more_matches(tmp_path):
    payload = json.loads(feature_page([point_feature(1, "A")]))
    payload.update(numberMatched=3, numberReturned=1)
    transport = FeaturePageTransport([json.dumps(payload).encode()])
    destination = tmp_path / "short.geojson"
    with pytest.raises(SourceArchiveFailure, match="source_count_mismatch"):
        asyncio.run(
            AnonymousSourceFetcher(
                resolver=Resolver(("93.184.216.34",)), transport=transport
            ).fetch(arcgis_spec(), destination)
        )
    assert len(transport.calls) == 1
    assert not destination.exists()


@pytest.mark.parametrize("declared", [3, 20])
def test_arcgis_independent_count_uses_scope_and_preserves_evidence(tmp_path, declared):
    body = json.dumps({"count": declared, "providerExtra": "x" * 5000}).encode()
    transport = FeaturePageTransport(
        [
            body,
            feature_page([point_feature(1, "a"), point_feature(2, "b")]),
            feature_page([point_feature(3, "c")]),
        ]
    )
    destination = tmp_path / "counted.geojson"
    result = asyncio.run(
        AnonymousSourceFetcher(resolver=Resolver(("93.184.216.34",)), transport=transport).fetch(
            arcgis_spec(maximum_requests=3), destination
        )
    )
    count_query = dict(parse_qsl(transport.calls[0][0].split("?", 1)[1]))
    feature_query = dict(parse_qsl(transport.calls[1][0].split("?", 1)[1]))
    assert count_query["returnCountOnly"] == "true"
    assert not {"resultOffset", "resultRecordCount", "outFields"} & count_query.keys()
    for field in ["where", "geometry", "geometryType", "inSR", "spatialRel"]:
        assert count_query[field] == feature_query[field]
    evidence = json.loads(destination.read_text())["opengeo:capture"]
    assert evidence["numberMatched"] == declared
    assert evidence["limitedByMaximumFeatures"] == (declared > 3)
    assert evidence["countQuery"]["reported"]["count"] == declared
    assert evidence["countQuery"]["reported"]["providerExtra"] == "x" * 5000
    assert len(json.dumps(result.count_evidence)) < 4096
    assert evidence["countQuery"]["sha256"] == hashlib.sha256(body).hexdigest()
    assert not list(tmp_path.glob("*.count"))


@pytest.mark.parametrize("response", [{"count": 3}, {"count": True}, {"error": {"code": 400}}])
def test_arcgis_count_mismatch_or_invalid_count_refuses_output(tmp_path, response):
    transport = FeaturePageTransport(
        [json.dumps(response).encode(), feature_page([point_feature(1, "a")])]
    )
    destination = tmp_path / "refused.geojson"
    with pytest.raises(SourceArchiveFailure):
        asyncio.run(
            AnonymousSourceFetcher(
                resolver=Resolver(("93.184.216.34",)), transport=transport
            ).fetch(arcgis_spec(maximum_requests=3), destination)
        )
    assert not destination.exists()
    assert not list(tmp_path.glob("*.count"))


@pytest.mark.parametrize("first,last", [(1, 1.0), (1.0, 1), (0, -0.0)])
def test_wfs_rejects_numeric_equivalent_identity_across_pages(tmp_path, first, last):
    pages = []
    for ids in ([first, 2], [last]):
        features = []
        for value in ids:
            item = point_feature(value, "same identifier")
            item["properties"]["facility_id"] = item["properties"].pop("OBJECTID")
            features.append(item)
        pages.append(
            json.dumps(
                {
                    "type": "FeatureCollection",
                    "features": features,
                    "numberMatched": 3,
                    "numberReturned": len(features),
                }
            ).encode()
        )
    destination = tmp_path / "numeric-duplicate.geojson"
    transport = FeaturePageTransport(pages)
    with pytest.raises(SourceArchiveFailure, match="response_invalid"):
        asyncio.run(
            AnonymousSourceFetcher(
                resolver=Resolver(("93.184.216.34",)), transport=transport
            ).fetch(wfs_spec(), destination)
        )
    assert len(transport.calls) == 2
    assert not destination.exists()
    assert not list(tmp_path.glob("*.page-*"))
