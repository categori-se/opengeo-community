import asyncio

import pytest
from pydantic import ValidationError

from opengeo_api.layer_archive_access import (
    ArchiveDescriptor,
    LayerArchiveRepository,
    ReadArchiveRequest,
)


def descriptor():
    return {
        "format": "geojson",
        "attribution": "Fixture",
        "rights": {},
        "provenance": {},
        "objects": [
            {
                "bucket": "fixture-bucket",
                "prefix": "private/",
                "expected_owner": "123456789012",
                "key": "private/copy.geojson",
                "version_id": "exact-version",
                "size_bytes": 42,
                "sha256": "a" * 64,
                "encoding": "identity",
                "decoded_size_bytes": 42,
                "decoded_sha256": "a" * 64,
                "feature_count": 0,
            }
        ],
    }


@pytest.mark.parametrize("value", [False, 1, "true", None])
def test_explicit_cost_boolean(value):
    with pytest.raises(ValidationError):
        ReadArchiveRequest.model_validate({"acknowledge_storage_cost": value})


def test_exact_empty_capture_and_acknowledgement():
    assert ArchiveDescriptor.model_validate(descriptor()).objects[0].feature_count == 0
    assert ReadArchiveRequest(acknowledge_storage_cost=True).acknowledge_storage_cost is True


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("key", "elsewhere/copy.geojson"),
        ("key", "private/../copy.geojson"),
        ("version_id", "null"),
        ("version_id", "bad\nversion"),
        ("decoded_sha256", "b" * 64),
        ("bucket", "another/bucket"),
    ],
)
def test_invalid_object_contract(field, value):
    data = descriptor()
    data["objects"][0][field] = value
    with pytest.raises(ValidationError):
        ArchiveDescriptor.model_validate(data)


def test_duplicate_object_is_not_double_counted():
    data = descriptor()
    data["objects"] *= 2
    with pytest.raises(ValidationError, match="Duplicate archive object"):
        ArchiveDescriptor.model_validate(data)


def test_large_copy_requires_rendering_derivative():
    data = descriptor()
    data["objects"][0]["feature_count"] = 100001
    with pytest.raises(ValidationError):
        ArchiveDescriptor.model_validate(data)


def test_total_download_bytes_are_bounded():
    data = descriptor()
    obj = data["objects"][0]
    obj.update(encoding="gzip", size_bytes=64 * 1024**2)
    data["objects"].append({**obj, "key": "private/second.gz"})
    with pytest.raises(ValidationError, match="bounded rendering derivative"):
        ArchiveDescriptor.model_validate(data)


def tiled_descriptor():
    data = descriptor()
    data.update(
        format="pmtiles",
        min_zoom=7,
        max_zoom=14,
        tile_layers=[
            {
                "source_layer": "transmission",
                "title": "Transmission lines",
                "geometry_type": "MultiLineString",
                "feature_count": 10,
                "geometry_method": "Quantized line display; original records retained.",
            }
        ],
    )
    data["objects"][0].update(
        size_bytes=128, decoded_size_bytes=128, feature_count=10, block_sha256=["c" * 64]
    )
    return data


def paired_descriptor():
    data = tiled_descriptor()
    data["tile_layers"][0]["geometry_type"] = "MultiPolygon"
    data["objects"].append(
        {**data["objects"][0], "key": "private/overview.pmtiles", "feature_count": 0}
    )
    data["raster_overview"] = {
        "object_index": 1,
        "min_zoom": 7,
        "max_zoom": 11,
        "vector_min_zoom": 12,
        "tile_size": 512,
        "description": "Classified display overview",
        "recipe": {
            "version": 1,
            "tile_size": 512,
            "zooms": [7, 8, 9, 10, 11],
            "sourceVectorSha256": "a" * 64,
        },
    }
    return data


def test_paired_overview_metadata_counts_capture_once_and_sums_storage():
    model = ArchiveDescriptor.model_validate(paired_descriptor())
    metadata = LayerArchiveRepository.metadata(["id", "title", None], model)
    assert metadata["feature_count"] == 10 and metadata["download_bytes"] == 256
    assert metadata["raster_overview"]["vector_min_zoom"] == 12
    assert metadata["range_limits"]["bytes"] == 64 * 1024**2


@pytest.mark.parametrize(
    "mutate",
    [
        lambda d: d["objects"][1].update(feature_count=10),
        lambda d: d["objects"][1].update(bucket="different-bucket"),
        lambda d: d["objects"][1].update(block_sha256=[]),
        lambda d: d["objects"].append({**d["objects"][1], "key": "private/third.pmtiles"}),
        lambda d: d["raster_overview"].update(vector_min_zoom=11),
        lambda d: d["raster_overview"].update(object_index=0),
        lambda d: d["raster_overview"]["recipe"].update(sourceVectorSha256="b" * 64),
        lambda d: d["raster_overview"]["recipe"].update(zooms=[7, 8]),
        lambda d: d["tile_layers"][0].update(geometry_type="Point"),
    ],
)
def test_paired_overview_rejects_ambiguous_or_unverified_objects(mutate):
    data = paired_descriptor()
    mutate(data)
    with pytest.raises(ValidationError):
        ArchiveDescriptor.model_validate(data)


def test_reviewed_tiles_require_complete_block_inventory_and_matching_sublayers():
    data = tiled_descriptor()
    assert ArchiveDescriptor.model_validate(data).format == "pmtiles"
    for mutation in [
        lambda d: d["objects"][0].update(block_sha256=[]),
        lambda d: d["objects"][0].update(block_sha256=["c" * 64, "d" * 64]),
        lambda d: d["objects"][0].update(encoding="gzip"),
        lambda d: d.update(min_zoom=15),
        lambda d: d["tile_layers"][0].update(feature_count=9),
        lambda d: d.update(tile_layers=[]),
        lambda d: d.update(format="geojson"),
    ]:
        candidate = tiled_descriptor()
        mutation(candidate)
        with pytest.raises(ValidationError):
            ArchiveDescriptor.model_validate(candidate)


def indexed_descriptor(size=2 * 1024**3, count=4_414_467):
    data = tiled_descriptor()
    obj = data["objects"][0]
    obj.pop("block_sha256")
    obj.update(
        size_bytes=size,
        decoded_size_bytes=size,
        feature_count=count,
        block_index={
            "key": "private/map.blocks",
            "version_id": "index-version",
            "size_bytes": ((size + 65535) // 65536) * 32,
            "sha256": "d" * 64,
        },
    )
    data["tile_layers"][0]["feature_count"] = count
    return data


def test_large_archive_inventory_does_not_expand_range_session_budget():
    from opengeo_api.layer_archive_access import LayerArchiveRepository

    parsed = ArchiveDescriptor.model_validate(indexed_descriptor())
    metadata = LayerArchiveRepository.metadata(("id", "title", None, {}), parsed)
    assert metadata["feature_count"] == 4_414_467
    assert metadata["verification_index_bytes"] == 1024**2
    assert metadata["range_limits"] == {
        "requests": 256,
        "bytes": 64 * 1024**2,
        "seconds": 300,
        "response_bytes": 8 * 1024**2,
    }
    assert "objects" not in metadata


@pytest.mark.parametrize(
    "mutation",
    [
        lambda d: d["objects"][0]["block_index"].update(key="outside/map.blocks"),
        lambda d: d["objects"][0]["block_index"].update(key="private/../map.blocks"),
        lambda d: d["objects"][0]["block_index"].update(key="private/copy.geojson"),
        lambda d: d["objects"][0]["block_index"].update(version_id="null"),
        lambda d: d["objects"][0]["block_index"].update(version_id="bad\nversion"),
        lambda d: d["objects"][0]["block_index"].update(size_bytes=32),
        lambda d: d["objects"][0].update(block_sha256=["a" * 64]),
        lambda d: d["objects"][0].update(
            size_bytes=2 * 1024**3 + 1, decoded_size_bytes=2 * 1024**3 + 1
        ),
        lambda d: d.update(format="geojson"),
    ],
)
def test_index_cannot_escape_scope_or_weaken_existing_format_bounds(mutation):
    data = indexed_descriptor()
    mutation(data)
    with pytest.raises(ValidationError):
        ArchiveDescriptor.model_validate(data)


def test_paired_listing_is_storage_free_and_explicit_read_signs_exact_versions():
    from types import SimpleNamespace

    calls = []

    class Storage:
        def __init__(self, bucket, prefix, owner):
            calls.append(("storage", bucket, prefix, owner))

        def sign_download(self, key, version):
            calls.append(("sign", key, version))
            return {"method": "GET", "url": "https://fixture.invalid/exact-version"}

    class Rows(LayerArchiveRepository):
        async def _read(self, context, project, dataset, archive=None):
            return SimpleNamespace(version_number=1, source_url="https://provider.invalid/0"), [
                ["archive", "Paired archive", None, paired_descriptor()]
            ]

    repository = Rows(None, storage_factory=Storage)
    listing = asyncio.run(repository.list(None, "project", "dataset"))
    assert calls == []
    assert "objects" not in listing["archives"][0]
    assert listing["archives"][0]["raster_overview"]["object_index"] == 1
    response = asyncio.run(repository.read_tickets(None, "project", "dataset", "archive"))
    assert [(x[1], x[2]) for x in calls if x[0] == "sign"] == [
        (obj["key"], obj["version_id"]) for obj in paired_descriptor()["objects"]
    ]
    assert len(response["objects"]) == 2
    assert response["feature_count"] == 10
    assert response["range_limits"]["requests"] == 256
