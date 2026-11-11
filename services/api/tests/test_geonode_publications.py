"""Offline conversion/rendering and HTTP wiring; repositories here are test doubles.

These checks do not establish database persistence or real-account authorization.
"""

import json
from copy import deepcopy
from dataclasses import replace
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile

import pytest

import test_resource_routes as resource_routes
import test_site_routes as site_routes
from opengeo_api.geonode_adapter import (
    build_geonode_import_plan,
    geonode_import_readback_report,
)
from opengeo_api.geonode_publications import convert_publication
from opengeo_api.resource_routes import GeoNodeImportRequest, ResourceContentRequest
from opengeo_api.resources import ResourceImportPlan
from opengeo_api.site_export import build_static_package, render_page_html
from opengeo_api.site_publications import PublishedSite

FIXTURES = Path(__file__).resolve().parents[3] / "parity" / "fixtures" / "geonode"
PROFILE = "geonode-5.1-mapstore-geostory-text.1"


def payload() -> dict:
    return json.loads((FIXTURES / "geonode-5.1-publication.json").read_text())


def import_plan(document: dict) -> ResourceImportPlan:
    request = GeoNodeImportRequest.model_validate(document)
    return build_geonode_import_plan(
        source_url=request.source_url,
        resources=tuple(resource.model_dump(mode="python") for resource in request.resources),
        relationships=tuple(
            relationship.model_dump(mode="python") for relationship in request.relationships
        ),
        normalized_metadata=tuple(
            resource.to_resource_metadata() for resource in request.resources
        ),
    )


def publication(content: dict, title: str = "Imported GeoStory") -> PublishedSite:
    base = site_routes.site()
    page = replace(base.pages[0], resource_content=content, resource_title=title)
    edition = site_routes.edition()
    return PublishedSite(
        site=replace(base, pages=(page,), state="published", active_edition=edition),
        edition=edition,
        references=(),
    )


def render(release: PublishedSite) -> str:
    return render_page_html(
        release,
        release.site.pages[0],
        page_urls={"home": "index.html"},
        css_url="assets/site.css",
        js_url="assets/site.js",
        public_project_root="/public/fixture",
    ).decode()


def test_pinned_native_fixture_becomes_valid_visible_content_and_portable_zip() -> None:
    document = payload()
    source = document["resources"][0]
    upstream_bytes = (FIXTURES / "mapstore-0f351873-sampleStory_1.json").read_bytes()
    upstream = json.loads(upstream_bytes)
    provenance = source["source_fixture"]
    assert len(upstream_bytes) == provenance["bytes"]
    assert sha256(upstream_bytes).hexdigest() == provenance["sha256"]
    assert provenance["commit"] == "0f3518737f29f4049b131247ce981e94519d9ab0"
    assert source["data"]["sections"][0] == upstream["sections"][2]
    assert source["data"]["sections"][1]["contents"][0]["contents"] == [
        upstream["sections"][0]["contents"][0]["contents"][0]
    ]

    plan = import_plan(document)
    draft = plan.resources[0].draft
    validated = ResourceContentRequest.model_validate(draft.content)
    native = [
        block for block in draft.content["blocks"] if block["type"] in {"heading", "markdown"}
    ]
    assert [block["type"] for block in native] == ["heading", "markdown", "heading", "markdown"]
    assert [block["text"] for block in native if block["type"] == "heading"] == [
        "Abstract",
        "Abstract",
    ]
    assert [block["markdown"] for block in native if block["type"] == "markdown"] == [
        "this is some html content",
        "this is some html content",
    ]
    assert len({block.id for block in validated.blocks}) == len(validated.blocks)
    report = plan.report["publications"][0]
    assert report["resourceIdentifier"] == source["uuid"]
    assert report["profile"] == PROFILE
    assert report["offlineReady"] is True
    assert report["runtimeDependencies"] == []
    assert report["losses"] == []
    assert report["normalizations"]
    assert report["blocks"] == [
        {"sourcePath": path, "blockId": block["id"], "type": block["type"]}
        for path, block in zip(
            [
                "data.sections[0].title",
                "data.sections[0].contents[0].html",
                "data.sections[1].title",
                "data.sections[1].contents[0].contents[0].html",
            ],
            native,
            strict=True,
        )
    ]
    assert draft.metadata.extensions["geonode"]["data"] == source["data"]
    assert plan.report["summary"]["convertedPublications"] == 1
    assert plan.report["summary"]["publicationLosses"] == 0

    release = publication(draft.content, draft.metadata.title)
    live = render(release)
    assert live.count("this is some html content") == 2
    assert "<h2" in live and "Abstract" in live
    package = build_static_package(release, public_project_root="/public/fixture")
    with ZipFile(BytesIO(package)) as archive:
        assert archive.read("index.html").decode() == live
        assert json.loads(archive.read("metadata/pages.json"))[0]["content"] == draft.content
        assert "assets/site.css" in archive.namelist()
        assert "assets/site.js" in archive.namelist()
        assert "checksums.sha256" in archive.namelist()


def test_json_string_carrier_converts_identically_and_keeps_original_source() -> None:
    document = payload()
    original = deepcopy(document)
    object_plan = import_plan(document)
    encoded = json.dumps(document["resources"][0]["data"], indent=2)
    document["resources"][0]["data"] = encoded
    string_plan = import_plan(document)

    assert string_plan.resources[0].draft.content == object_plan.resources[0].draft.content
    assert string_plan.report["publications"] == object_plan.report["publications"]
    assert string_plan.resources[0].draft.metadata.extensions["geonode"]["data"] == encoded
    assert (
        object_plan.resources[0].draft.metadata.extensions["geonode"]["data"]
        == (original["resources"][0]["data"])
    )


def test_full_upstream_story_preserves_unsupported_media_and_reports_precise_losses() -> None:
    document = payload()
    source = json.loads((FIXTURES / "mapstore-0f351873-sampleStory_1.json").read_text())
    document["resources"][0]["data"] = deepcopy(source)
    plan = import_plan(document)
    draft = plan.resources[0].draft
    ResourceContentRequest.model_validate(draft.content)
    report = plan.report["publications"][0]
    losses = {item["path"]: item for item in report["losses"]}

    assert draft.metadata.extensions["geonode"]["data"] == source
    assert report["offlineReady"] is False
    assert report["runtimeDependencies"] == []
    assert losses["data.sections[0].contents[0].contents[1]"]["code"] == "unsupported_content"
    assert {"data.sections[1]", "data.sections[3]", "data.sections[4]"} <= losses.keys()
    assert all(item["detail"] for item in report["losses"])
    assert plan.report["summary"]["publicationLosses"] == len(report["losses"])
    html = render(publication(draft.content))
    assert "this is some html content" in html
    assert "data:image/png;base64" not in html
    assert document["resources"][0]["data"] == source


def test_active_html_is_inert_and_format_link_and_layout_losses_are_disclosed() -> None:
    document = payload()
    source = {
        "type": "cascade",
        "sections": [
            {
                "type": "paragraph",
                "title": "Safe & visible",
                "contents": [
                    {
                        "type": "column",
                        "size": "half",
                        "align": "left",
                        "contents": [
                            {
                                "type": "text",
                                "html": (
                                    '<p onclick="steal()">Fish &amp; Chips <strong>today</strong> '
                                    '<a href="javascript:steal()">source</a></p>'
                                    "<script>window.stolen = true</script>"
                                    '<iframe src="https://remote.example.test/private">hidden</iframe>'
                                ),
                            }
                        ],
                    }
                ],
            }
        ],
    }
    document["resources"][0]["data"] = deepcopy(source)
    plan = import_plan(document)
    draft = plan.resources[0].draft
    ResourceContentRequest.model_validate(draft.content)
    report = plan.report["publications"][0]
    assert {
        "active_or_embedded_html",
        "html_formatting",
        "html_attributes",
        "link_target",
        "column_layout",
    } <= {loss["code"] for loss in report["losses"]}
    assert report["offlineReady"] is False
    assert draft.metadata.extensions["geonode"]["data"] == source
    html = render(publication(draft.content))
    assert "Fish &amp; Chips today source" in html
    assert "Safe &amp; visible" in html
    for unsafe in ("onclick=", "javascript:", "window.stolen", "<iframe", "<strong>today</strong>"):
        assert unsafe not in html


def test_unsupported_dashboard_stays_in_custody_without_claiming_readiness() -> None:
    document = payload()
    source = document["resources"][0]
    source["resource_type"] = "dashboard"
    source["data"] = {"widgets": [{"type": "map", "url": "https://remote.example.test/map"}]}
    plan = import_plan(document)
    draft = plan.resources[0].draft
    report = plan.report["publications"][0]

    assert draft.kind == "dashboard"
    assert draft.metadata.extensions["geonode"]["data"] == source["data"]
    assert not any(block["type"] in {"heading", "markdown"} for block in draft.content["blocks"])
    assert report["blocks"] == []
    assert report["losses"][0]["code"] == "unsupported_publication"
    assert report["offlineReady"] is False
    assert plan.report["summary"]["convertedPublications"] == 0


def test_literal_html_text_that_looks_like_markdown_stays_in_source_with_explicit_loss() -> None:
    document = payload()
    source = {
        "type": "cascade",
        "sections": [
            {
                "type": "paragraph",
                "contents": [
                    {
                        "type": "text",
                        "html": (
                            "<p>[Visible text](https://example.com)</p>"
                            "<p># Heading</p><p>- item</p>"
                        ),
                    }
                ],
            }
        ],
    }
    document["resources"][0]["data"] = deepcopy(source)
    plan = import_plan(document)
    draft = plan.resources[0].draft
    report = plan.report["publications"][0]

    assert draft.metadata.extensions["geonode"]["data"] == source
    assert not any(block["type"] in {"heading", "markdown"} for block in draft.content["blocks"])
    assert report["blocks"] == []
    assert report["offlineReady"] is False
    assert any(
        loss["code"] == "literal_markdown" and loss["path"] == "data.sections[0].contents[0].html"
        for loss in report["losses"]
    )
    assert 'href="https://example.com"' not in render(publication(draft.content))


def test_converter_limits_leave_space_for_native_source_and_preserved_blocks() -> None:
    document = payload()
    data = {
        "type": "cascade",
        "sections": [
            {
                "type": "paragraph",
                "contents": [{"type": "text", "html": "<p>Text</p>"} for _ in range(22)],
            }
        ],
    }
    document["resources"][0]["data"] = data
    draft = import_plan(document).resources[0].draft
    assert len(ResourceContentRequest.model_validate(draft.content).blocks) == 24
    data["sections"][0]["contents"].append({"type": "text", "html": "<p>Overflow</p>"})
    with pytest.raises(ValueError, match="22 converted block limit"):
        GeoNodeImportRequest.model_validate(document)

    blocks, report = convert_publication(
        "story",
        {
            "type": "cascade",
            "sections": [
                {
                    "type": "paragraph",
                    "contents": [{"type": "text", "html": "x" * 8_000}],
                }
            ],
        },
    )
    assert len(blocks[0]["markdown"]) == 8_000
    assert report["offlineReady"] is True
    with pytest.raises(ValueError, match="8000 characters"):
        convert_publication(
            "story",
            {
                "type": "cascade",
                "sections": [
                    {
                        "type": "paragraph",
                        "contents": [{"type": "text", "html": "x" * 8_001}],
                    }
                ],
            },
        )


@pytest.mark.parametrize("data", ["{invalid", '{"type":"cascade","access_token":"private"}'])
def test_invalid_or_secret_json_carrier_is_rejected_before_repository_calls(data: str) -> None:
    document = payload()
    document["resources"][0]["data"] = data
    repository = resource_routes.FakeResourceRepository()
    response = resource_routes.api_client(repository).post(
        f"/projects/{resource_routes.PROJECT_ID}/resources/imports/geonode",
        headers=resource_routes.headers(),
        json=document,
    )
    assert response.status_code == 422
    assert repository.calls == []


def test_import_route_passes_native_blocks_and_held_publication_to_fake_repository() -> None:
    class ConvertingResourceRepository(resource_routes.FakeResourceRepository):
        async def import_resources(self, context, project_id, plan, request_id):
            result = await super().import_resources(context, project_id, plan, request_id)
            return replace(
                result,
                resources=(
                    replace(result.resources[0], content=deepcopy(plan.resources[0].draft.content)),
                ),
            )

    document = payload()
    document["resources"][0]["is_published"] = True
    repository = ConvertingResourceRepository()
    response = resource_routes.api_client(repository).post(
        f"/projects/{resource_routes.PROJECT_ID}/resources/imports/geonode",
        headers=resource_routes.headers(),
        json=document,
    )
    assert response.status_code == 201
    call = repository.calls[0]
    assert call[0] == "import"
    assert call[1].organization_id == resource_routes.ORG_ID
    assert call[1].user_id == resource_routes.USER_ID
    plan = call[3]
    draft = plan.resources[0].draft
    assert draft.state == "review"
    assert draft.visibility == "restricted"
    assert ResourceContentRequest.model_validate(draft.content).blocks
    expected_report = deepcopy(plan.report)
    expected_report["publications"][0]["conversionApplied"] = True
    assert response.json()["report"] == expected_report
    assert response.json()["report"]["publications"][0]["offlineReady"] is True


def test_idempotent_import_readback_preserves_legacy_content_and_reports_not_applied() -> None:
    plan = import_plan(payload())
    proposed = plan.resources[0]
    base = resource_routes.resource(version=3)
    existing = replace(
        base,
        summary=replace(base.summary, origin_identifier=proposed.identifier),
        external_identifiers=(
            replace(
                base.external_identifiers[0],
                identifier=proposed.identifier,
                source_payload_sha256=proposed.source_payload_sha256,
            ),
        ),
    )
    saved_content = deepcopy(existing.content)
    saved_version_id = existing.current_version_id
    first = geonode_import_readback_report(plan, (existing,))
    second = geonode_import_readback_report(plan, (existing,))

    assert first == second
    report = first["publications"][0]
    assert report["conversionApplied"] is False
    assert report["offlineReady"] is False
    assert [loss["code"] for loss in report["losses"]] == ["existing_content_preserved"]
    assert first["summary"]["convertedPublications"] == 0
    assert first["summary"]["publicationLosses"] == 1
    assert existing.content == saved_content
    assert existing.summary.resource_id == base.summary.resource_id
    assert existing.summary.version_number == 3
    assert existing.current_version_id == saved_version_id
    assert plan.report["publications"][0]["offlineReady"] is True
    assert plan.report["publications"][0]["losses"] == []
    assert plan.report["summary"]["convertedPublications"] == 1


def test_native_import_content_passes_in_memory_site_review_publish_and_zip_routes() -> None:
    draft = import_plan(payload()).resources[0].draft
    # This repository supplies an already approved/public resource version. It
    # exercises site routes/rendering, not database resource publication checks.
    repository = site_routes.MemorySiteRepository()
    release = publication(draft.content, draft.metadata.title)
    repository.record = replace(release.site, state="draft", active_edition=None)
    client = site_routes.api_client(repository)
    root = f"/projects/{site_routes.PROJECT_ID}/sites/{site_routes.SITE_ID}"
    configured = client.put(
        f"{root}/publication-destination",
        headers=site_routes.headers(),
        json={
            "expected_revision": 1,
            "reach": "listed",
            "listed_slug": "field-report",
            "is_primary": False,
        },
    )
    assert configured.status_code == 200
    reviewed = client.post(
        f"{root}/review",
        headers=site_routes.headers(),
        json={"expected_version": 1, "reason": "Text and loss report reviewed"},
    )
    assert reviewed.status_code == 200
    assert reviewed.json()["state"] == "review"
    published = client.post(
        f"{root}/publish",
        headers=site_routes.headers(),
        json={"expected_version": 1, "reason": "Approved native text edition"},
    )
    assert published.status_code == 200
    assert published.json()["state"] == "published"
    public_root = (
        f"/public/organizations/{site_routes.ORG_ID}/projects/{site_routes.PROJECT_ID}"
        "/sites/field-report"
    )
    live = client.get(public_root)
    assert live.status_code == 200
    assert live.text.count("this is some html content") == 2
    package = client.get(f"{public_root}/export.zip")
    assert package.status_code == 200
    assert package.headers["X-OpenGeo-Checksum-SHA256"] == sha256(package.content).hexdigest()
    with ZipFile(BytesIO(package.content)) as archive:
        assert archive.read("index.html").decode().count("this is some html content") == 2
        assert json.loads(archive.read("metadata/pages.json"))[0]["content"] == draft.content
    assert [call[0] for call in repository.calls if call[0] in {"review", "publish"}] == [
        "review",
        "publish",
    ]
