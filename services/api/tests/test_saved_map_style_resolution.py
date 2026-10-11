import asyncio
from datetime import UTC, datetime
from hashlib import sha256
from uuid import UUID

import pytest

from opengeo_api.saved_map_rendering import SavedMapRenderUnsupported
from opengeo_api.saved_map_style_resolution import resolve_saved_map_styles
from opengeo_api.tenant_database import TenantContext


def test_resolution_rechecks_access_and_dataset_and_deduplicates_exact_references():
    uid = UUID("d0000000-0000-4000-8000-000000000002")
    now = datetime.now(UTC)
    definition = '{"version":8,"sources":{},"layers":[]}'
    checksum = sha256(definition.encode()).hexdigest()
    reference = {
        "projectId": str(uid),
        "resourceId": str(uid),
        "styleId": str(uid),
        "versionNumber": 2,
        "checksumSha256": checksum,
        "format": "maplibre",
    }
    layer = {
        "layerId": "one",
        "datasetId": str(uid),
        "sourceType": "governed-dataset",
        "title": "Roads",
        "visible": True,
        "opacity": 1,
        "order": 0,
        "style": {},
        "labels": {},
        "styleReference": reference,
    }
    document = {
        "schemaVersion": "opengeo.map-definition.1.4.0",
        "mapViews": [],
        "basemaps": [],
        "bookmarks": [],
        "activeLayerId": None,
        "activeProcessingModelId": None,
        "models": [],
        "processingHistory": [],
        "measurements": [],
        "projection": "mercator",
        "colorMode": "dark",
        "layers": [layer, {**layer, "layerId": "two"}],
    }
    row = (
        uid,
        uid,
        "roads",
        "maplibre",
        2,
        "Roads",
        "application/json",
        definition,
        checksum,
        None,
        uid,
        now,
        now,
        True,
    )

    class Transaction:
        def __init__(self, roles, style_row):
            self.responses = iter([roles, style_row])
            self.calls = []

        async def fetch_one(self, statement, parameters=()):
            self.calls.append((statement, parameters))
            return next(self.responses)

    transaction = Transaction(("member", "viewer", None, False), row)
    resolved = asyncio.run(resolve_saved_map_styles(transaction, TenantContext(uid, uid), document))
    assert set(resolved) == {"one", "two"}
    assert len(transaction.calls) == 2
    assert resolved["one"].archived is True
    assert "archived_at IS NULL" not in transaction.calls[1][0]
    assert "resource.dataset_id = %s" in transaction.calls[1][0]
    assert transaction.calls[1][1] == (uid, uid, uid, uid, 2, checksum, "maplibre", uid)
    for roles, data in [
        (("member", None, None, False), row),
        (("member", "viewer", None, False), None),
        (("member", "viewer", None, False), (*row[:7], "tampered", *row[8:])),
    ]:
        with pytest.raises(SavedMapRenderUnsupported) as error:
            asyncio.run(
                resolve_saved_map_styles(
                    Transaction(roles, data), TenantContext(uid, uid), document
                )
            )
        assert error.value.code == "saved_map_style_unavailable"
