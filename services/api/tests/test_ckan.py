import asyncio
import copy
import json

import pytest

from opengeo_api.ckan import (
    CkanClient,
    CkanFailure,
    build_ckan_import_plan,
    canonical_ckan_url,
)
from opengeo_api.metadata_adapters import metadata_source_checksum
from opengeo_api.metadata_profiles import export_dcat_3
from opengeo_api.resources import PostgresResourceRepository
from opengeo_api.tenant_database import TenantContext
from test_metadata_adapters import resource_from_plan
from test_resources import (
    ORG_ID,
    PROJECT_ID,
    USER_ID,
    ScriptedExecutor,
    ScriptedTransaction,
    detail_row,
    source_row,
)

URL = "https://catalog.example.org"


def package(**changes):
    return {
        "id": "dataset-1",
        "name": "flood-risk",
        "title": "Flood risk — 洪水",
        "private": False,
        "state": "active",
        "notes": "Source observations.",
        "license_id": "cc-by",
        "license_url": "https://creativecommons.org/licenses/by/4.0/",
        "organization": {"id": "org-1", "name": "provider", "title": "Source provider"},
        "tags": [{"name": "flood", "vocabulary_id": "vocab-1"}, {"name": "FLOOD"}],
        "metadata_modified": "2026-10-10T00:00:00",
        "groups": [{"id": "group-1"}],
        "extras": [{"key": "spatial", "value": '{"type":"Polygon","coordinates":[]}'}],
        "resources": [
            {
                "id": "resource-1",
                "name": "Observations",
                "format": "CSV",
                "url": "https://data.example.org/table.csv",
                "datastore_active": True,
            }
        ],
        "custom": {"nested": [1, None, {"unknown": True}]},
        **changes,
    }


class Fetcher:
    def __init__(self, *results):
        self.results = list(results)
        self.calls = []

    async def fetch_document(self, url, **options):
        self.calls.append((url, options))
        value = self.results.pop(0)
        return value if isinstance(value, bytes) else json.dumps(value).encode()


def envelope(result):
    return {"success": True, "result": result}


def test_ckan_crosswalk_preserves_original_and_separates_metadata_from_access():
    original = package()
    retained = copy.deepcopy(original)
    plan = build_ckan_import_plan(URL, original)
    assert original == retained
    assert plan.source_document["ckan:source"]["package"] == retained
    assert plan.source_document["ckan:source"]["packageSha256"] == metadata_source_checksum(
        original
    )
    assert plan.source_document["dct:publisher"] == {
        "@type": "foaf:Agent",
        "foaf:name": "Source provider",
    }
    assert plan.source_format == "dcat_3" and plan.source_namespace == "ckan"
    assert plan.draft.kind == "dataset" and plan.draft.visibility == "restricted"
    assert plan.draft.state == "review" and plan.draft.dataset_id is None
    assert plan.draft.metadata.keywords == ("flood",)
    assert plan.draft.metadata.temporal_start is None and plan.draft.metadata.spatial_extent is None
    assert plan.draft.metadata.extensions["opengeo"]["contacts"] == [
        {"name": "Source provider", "role": "publisher"},
    ]
    distribution = plan.draft.metadata.extensions["opengeo"]["distributions"][0]
    assert "license" not in distribution and "downloadUrl" not in distribution
    assert distribution["accessUrl"] == retained["resources"][0]["url"]
    assert plan.conversion_report["ckan"]["conformanceClaimed"] is False
    exported = export_dcat_3(resource_from_plan(plan))["document"]
    assert exported["dct:license"] == retained["license_url"]
    assert "dct:license" not in exported["dcat:distribution"][0]
    assert "dcat:downloadURL" not in exported["dcat:distribution"][0]


def test_identity_is_scoped_to_catalog_and_stable_across_equivalent_urls():
    a = build_ckan_import_plan(URL, package())
    b = build_ckan_import_plan(URL + "/", package())
    c = build_ckan_import_plan("https://other.example.org", package())
    assert a.source_identifier == b.source_identifier and a.source_sha256 == b.source_sha256
    assert a.source_identifier != c.source_identifier and a.draft.slug != c.draft.slug
    changed = build_ckan_import_plan(URL, package(notes="Changed upstream"))
    assert (
        changed.source_identifier == a.source_identifier
        and changed.source_sha256 != a.source_sha256
    )
    assert build_ckan_import_plan(URL, package(license_url=None)).draft.metadata.license is None


@pytest.mark.parametrize(
    "url",
    [
        "http://catalog.example.org",
        "https://localhost",
        "https://127.0.0.1",
        "https://169.254.169.254",
        "https://[::1]",
        "https://x.internal",
        "https://x.local",
        "https://catalog.example.org:444",
        "https://u:p@catalog.example.org",
        "https://catalog.example.org?token=secret",
        "https://catalog.example.org#x",
        "https://catalog.example.org/a/../b",
        "https://catalog.example.org/%2e%2e",
    ],
)
def test_unsafe_catalogs_reject_before_network(url):
    with pytest.raises(CkanFailure, match="ckan_url_invalid"):
        canonical_ckan_url(url)


@pytest.mark.parametrize(
    "changes",
    [
        {"private": True},
        {"private": None},
        {"state": "deleted"},
        {"custom": {"access_token": "secret"}},
        {"notes": "x" * 8001},
        {"resources": [{"id": "r", "url": "https://example.org/?X-Amz-Signature=secret"}]},
        {"resources": [{"id": "r"}, {"id": "r"}]},
    ],
)
def test_private_malformed_or_sensitive_metadata_rejects(changes):
    with pytest.raises(CkanFailure):
        build_ckan_import_plan(URL, package(**changes))


def test_search_is_bounded_explicitly_paged_and_uses_versioned_api():
    fetcher = Fetcher(envelope({"count": 3, "results": [package()]}))
    page = asyncio.run(CkanClient(fetcher).search(URL, rows=1, organization="provider"))
    assert page["next_start"] == 1 and page["total"] == 3
    assert page["datasets"][0]["id"] == "dataset-1" and len(fetcher.calls) == 1
    url, options = fetcher.calls[0]
    assert url == URL + "/api/3/action/package_search"
    assert dict(options["parameters"]) == {
        "q": "*:*",
        "start": "0",
        "rows": "1",
        "sort": "id asc",
        "include_private": "false",
        "fq": "organization:provider",
    }
    assert options["maximum_bytes"] == 2_097_152


def test_ckan_200_error_envelope_and_foreign_identity_fail_without_error_body_leak():
    fetcher = Fetcher({"success": False, "error": {"message": "secret provider body"}})
    with pytest.raises(CkanFailure, match=r"^ckan_action_failed$"):
        asyncio.run(CkanClient(fetcher).package(URL, "dataset-1"))
    fetcher = Fetcher(envelope(package(id="other")))
    with pytest.raises(CkanFailure, match="ckan_identity_mismatch"):
        asyncio.run(CkanClient(fetcher).package(URL, "dataset-1"))


def test_datastore_preview_is_read_only_and_does_not_follow_provider_links():
    fetcher = Fetcher(
        envelope(
            {
                "resource_id": "resource-1",
                "fields": [{"id": "name"}, {"id": "value"}],
                "records": [{"name": "<script>unsafe()</script>", "value": 3}],
                "_links": {"next": "http://169.254.169.254/secret"},
            }
        )
    )
    result = asyncio.run(CkanClient(fetcher).preview(URL, "resource-1"))
    assert len(fetcher.calls) == 1 and result["limit"] == 20
    assert "_links" not in result
    assert dict(fetcher.calls[0][1]["parameters"])["limit"] == "20"
    assert fetcher.calls[0][0].endswith("/api/3/action/datastore_search")


def test_ckan_plan_uses_existing_atomic_resource_and_source_persistence():
    plan = build_ckan_import_plan(URL, package())
    transaction = ScriptedTransaction(
        one=[
            ("member",),
            (PROJECT_ID, "editor"),
            (None,),
            None,
            detail_row(),
            source_row(plan),
            (json.dumps(plan.source_document),),
        ],
        all_rows=[[], []],
    )
    result = asyncio.run(
        PostgresResourceRepository(ScriptedExecutor(transaction)).import_metadata_resource(
            TenantContext(USER_ID, ORG_ID),
            PROJECT_ID,
            plan,
            "ckan-import",
        )
    )
    assert result.source.source_document == plan.source_document
    assert result.source.source_namespace == "ckan" and result.idempotent is False
    insert = next(
        params
        for sql, params in transaction.executions
        if "INSERT INTO app.governed_metadata_source_documents" in sql
    )
    assert insert[7] == plan.source_identifier and insert[9] == plan.source_sha256
    assert insert[10].obj["ckan"]["custody"] == "referenced"
