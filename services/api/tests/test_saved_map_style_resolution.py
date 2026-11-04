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


def test_public_style_resolution_uses_no_caller_roles_and_deduplicates_exact_pins():
    from copy import deepcopy
    from opengeo_api.saved_map_style_resolution import resolve_public_saved_map_styles
    from test_saved_map_publication import public_style_row, style_bound_rows
    from test_saved_map_jobs import CONTEXT

    binding, rows, style, reference = style_bound_rows()
    definition = deepcopy(binding[5])
    definition["layers"].append({**definition["layers"][0], "layerId": "second"})
    publication = public_style_row(style, reference, rows[0][3])

    class Transaction:
        def __init__(self): self.calls = []
        async def fetch_one(self, sql, parameters):
            self.calls.append((sql, parameters))
            return publication

    tx = Transaction()
    resolved, dependencies = asyncio.run(resolve_public_saved_map_styles(tx, CONTEXT, definition))
    assert set(resolved) == {"areas", "second"} and len(dependencies) == 2
    assert len(tx.calls) == 1
    assert "resource.state = 'published'" in tx.calls[0][0]
    assert "metadata.metadata_extensions" in tx.calls[0][0]
    assert dependencies[0]["publication"] == dependencies[1]["publication"]


def test_public_style_resolution_supports_deployed_thirteen_column_style_parser(monkeypatch):
    from types import SimpleNamespace
    from opengeo_api.resources import PostgresResourceRepository
    from opengeo_api.saved_map_style_resolution import resolve_public_saved_map_styles
    from test_saved_map_publication import public_style_row, style_bound_rows
    from test_saved_map_jobs import CONTEXT

    binding, rows, style, reference = style_bound_rows()
    publication = public_style_row(style, reference, rows[0][3])[:-1]
    selected = PostgresResourceRepository._style_select(current=False).replace(
        ", style.archived_at IS NOT NULL", ""
    )
    fields = ("style_id", "resource_id", "slug", "format", "version_number", "title",
              "media_type", "definition", "checksum_sha256", "change_message",
              "created_by", "created_at", "updated_at")
    parsed = []

    def deployed_parser(row):
        assert len(row) == 13
        value = SimpleNamespace(**dict(zip(fields, row, strict=True)))
        assert not hasattr(value, "archived")
        parsed.append(value)
        return value

    monkeypatch.setattr(PostgresResourceRepository, "_style_select", staticmethod(lambda *, current=True: selected))
    monkeypatch.setattr(PostgresResourceRepository, "_style", staticmethod(deployed_parser))

    class Transaction:
        async def fetch_one(self, sql, parameters):
            assert "style.archived_at IS NULL" in sql
            assert "style.archived_at IS NOT NULL" not in sql
            assert "resource.state = 'published'" in sql
            assert "resource.visibility = 'public'" in sql
            return publication

    resolved, dependencies = asyncio.run(
        resolve_public_saved_map_styles(Transaction(), CONTEXT, binding[5])
    )
    assert resolved["areas"] is parsed[0]
    assert dependencies[0]["reference"] == reference
    assert dependencies[0]["publication"]["metadataVersionNumber"] == 4
