"""ImageServer admission is distinct from feature capture and original ingestion."""

from dataclasses import replace

import pytest
from pydantic import ValidationError

from opengeo_api.external_source_routes import CreateExternalSourceRequest
from opengeo_api.map_definitions import external_map_configuration
from test_external_source_routes import (
    DATASET_ID,
    PROJECT_ID,
    FakeSourceRepository,
    api_client,
    headers,
    xyz_source,
)

URL = "https://coast.noaa.gov/arcgis/rest/services/Imagery/3Band_CIR_16Bit_Imagery/ImageServer"


def payload(**changes):
    return {"name": "NOAA CIR 16-bit", "source": {"type": "imageserver", "url": URL, **changes}}


def test_imageserver_defaults_are_display_only():
    source = CreateExternalSourceRequest.model_validate(payload()).source
    config = source.configuration()
    assert config == {
        "service_kind": "imageserver",
        "tile_size": 256,
        "image_format": "png32",
        "interpolation": "RSP_NearestNeighbor",
        "band_ids": [],
        "min_zoom": 0,
        "max_zoom": 22,
        "attribution": None,
    }
    assert external_map_configuration("imageserver", config)["serviceKind"] == "imageserver"
    assert "rasterIds" not in external_map_configuration("imageserver", config)
    empty = CreateExternalSourceRequest.model_validate(payload(raster_ids=[])).source
    assert empty.configuration() == config


def test_imageserver_raster_selection_is_bounded_and_preserved():
    source = CreateExternalSourceRequest.model_validate(
        payload(raster_ids=[2, 0, 2147483647])
    ).source
    config = source.configuration()
    assert config["raster_ids"] == [2, 0, 2147483647]
    assert external_map_configuration("imageserver", config)["rasterIds"] == [2, 0, 2147483647]


@pytest.mark.parametrize(
    "changes",
    [
        {"url": URL + "/exportImage"},
        {"url": URL + "?token=secret"},
        {"url": URL + "#secret"},
        {"url": URL.replace("https:", "http:")},
        {"url": "https://127.0.0.1/ImageServer"},
        {"url": "https://user:secret@example.org/ImageServer"},
        {"url": "https://localhost/ImageServer"},
        {"url": URL.replace("ImageServer", "FeatureServer/0")},
        {"band_ids": [-1]},
        {"band_ids": [256]},
        {"band_ids": [True]},
        {"band_ids": [0, 1]},
        {"band_ids": [0, 1, 2, 3]},
        {"raster_ids": [-1]},
        {"raster_ids": [2147483648]},
        {"raster_ids": [True]},
        {"raster_ids": [2.0]},
        {"raster_ids": ["2"]},
        {"raster_ids": [2, 2]},
        {"raster_ids": list(range(33))},
        {"raster_ids": None},
        {"tile_size": 4096},
        {"image_format": "tiff"},
        {"min_zoom": 10, "max_zoom": 2},
        {"rendering_rule": {"rasterFunction": "arbitrary"}},
        {"mosaic_rule": {"where": "arbitrary"}},
        {"query": {"where": "arbitrary"}},
        {"credentials": {"token": "secret"}},
        {"token": "secret"},
    ],
)
def test_imageserver_rejects_unsafe_or_unbounded_display_inputs(changes):
    with pytest.raises(ValidationError):
        CreateExternalSourceRequest.model_validate(payload(**changes))


def test_authenticated_registration_retains_imageserver_identity():
    class ImageRepository(FakeSourceRepository):
        async def create_source(self, context, project_id, draft, request_id):
            self.calls.append((context, project_id, draft, request_id))
            return replace(
                xyz_source(),
                source_type="imageserver",
                source_url=draft.source_url,
                configuration=draft.configuration,
            )

    repository = ImageRepository()
    with api_client(repository) as client:
        response = client.post(
            f"/projects/{PROJECT_ID}/sources",
            json=payload(band_ids=[2, 1, 0], raster_ids=[2]),
            headers=headers(),
        )
    assert response.status_code == 201, response.text
    assert response.json()["source_type"] == "imageserver"
    assert response.json()["dataset_id"] == str(DATASET_ID)
    assert response.json()["verification_state"] == "syntax_only"
    assert repository.calls[0][2].configuration["band_ids"] == [2, 1, 0]
    assert repository.calls[0][2].configuration["raster_ids"] == [2]
    assert response.json()["configuration"]["raster_ids"] == [2]


def test_registration_requires_authentication():
    repository = FakeSourceRepository()
    with api_client(repository) as client:
        response = client.post(f"/projects/{PROJECT_ID}/sources", json=payload())
    assert response.status_code == 401
    assert not repository.calls
