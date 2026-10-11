"""Map rendering retains selected IDs without copying source pixels."""

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

URL = "https://geoapps.icimod.org/icimodarcgis/rest/services/Bhutan/Landcover/MapServer"


def payload(**changes):
    return {
        "name": "Landcover 1990",
        "source": {"type": "mapserver", "url": URL, "layer_ids": [2], **changes},
    }


@pytest.mark.parametrize(
    "changes",
    [
        {"url": URL + "/2"},
        {"url": URL + "/export"},
        {"url": URL + "?token=x"},
        {"url": "https://127.0.0.1/MapServer"},
        {"layer_ids": []},
        {"layer_ids": [True]},
        {"layer_ids": [-1]},
        {"layer_ids": [2, 2]},
        {"layer_ids": list(range(33))},
        {"tile_size": 4096},
        {"image_format": "tiff"},
        {"min_zoom": 8, "max_zoom": 2},
        {"dynamic_layers": []},
        {"archive_fallback": True},
    ],
)
def test_rejects_unbounded_or_implicit_display(changes):
    with pytest.raises(ValidationError):
        CreateExternalSourceRequest.model_validate(payload(**changes))


def test_authenticated_registration_retains_source_and_selected_layer():
    class Repository(FakeSourceRepository):
        async def create_source(self, context, project_id, draft, request_id):
            self.calls.append((context, project_id, draft, request_id))
            return replace(
                xyz_source(),
                source_type="mapserver",
                source_url=draft.source_url,
                configuration=draft.configuration,
            )

    repository = Repository()
    with api_client(repository) as client:
        assert client.post(f"/projects/{PROJECT_ID}/sources", json=payload()).status_code == 401
        assert not repository.calls
        response = client.post(f"/projects/{PROJECT_ID}/sources", json=payload(), headers=headers())
    assert response.status_code == 201, response.text
    value = response.json()
    assert value["source_type"] == "mapserver"
    assert value["dataset_id"] == str(DATASET_ID)
    assert value["verification_state"] == "syntax_only"
    config = external_map_configuration("mapserver", value["configuration"])
    assert config["layerIds"] == [2]
    assert config["serviceKind"] == "mapserver"
    assert len(repository.calls) == 1
