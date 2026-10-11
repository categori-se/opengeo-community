import copy
import json
import subprocess
from pathlib import Path

import pytest

from opengeo_api.ckan_export import export_stac_ckan, validate_ckan_create_subset
from opengeo_api.metadata_adapters import MetadataImportInvalid, metadata_source_checksum

ROOT = Path(__file__).parents[3]
FIXTURE = ROOT / "docs/api/fixtures/stac-ckan-collection.json"
NAMESPACE = "example.synthetic"


def fixture():
    return json.loads(FIXTURE.read_text())


def test_stac_ckan_preserves_source_and_normalized_values_with_explicit_losses():
    document = fixture()
    original = copy.deepcopy(document)
    result = export_stac_ckan(document, namespace=NAMESPACE)
    payload = result["payload"]
    extras = {extra["key"]: extra["value"] for extra in payload["extras"]}
    assert document == original == result["source"]["document"]
    assert result["source"]["sourceSha256"] == metadata_source_checksum(document)
    assert result["source"]["checksumBasis"] == "canonical_json"
    assert result["importReport"]["preservedSource"]["syntacticIdentity"] is False
    assert payload["title"] == document["title"] and payload["notes"] == document["description"]
    assert payload["tags"] == [{"name": value} for value in document["keywords"]]
    assert payload["url"] == document["links"][0]["href"]
    assert payload["resources"][0]["url"] == document["links"][1]["href"]
    assert json.loads(extras["opengeo:publishers"]) == [document["providers"][0]]
    assert json.loads(extras["opengeo:stac_links"]) == document["links"]
    assert json.loads(extras["opengeo:spatial_extent"]) == [84, 27, 86, 29]
    assert extras["opengeo:temporal_start"] == "2026-01-01T00:00:00+00:00"
    assert "opengeo:temporal_end" not in extras
    assert "unioned" not in " ".join(result["report"]["losses"])
    assert extras["opengeo:declared_license"] == "other"
    assert {"id", "license_id", "owner_org", "private", "state", "groups"}.isdisjoint(payload)
    assert result["report"]["unmapped"] == ["providers[1]", "stac_extensions", "summaries"]
    assert result["mode"] == "dry_run" and result["report"]["remoteWritePerformed"] is False


def test_identity_survives_changes_and_is_namespace_scoped():
    document = fixture()
    a = export_stac_ckan(document, namespace=NAMESPACE)
    document["title"] = "Changed title"
    b = export_stac_ckan(document, namespace=NAMESPACE)
    assert a["payload"]["name"] == b["payload"]["name"]
    assert a["source"]["sourceSha256"] != b["source"]["sourceSha256"]
    assert a["payload"]["name"] != export_stac_ckan(document, namespace="other")["payload"]["name"]
    assert export_stac_ckan(document, namespace=NAMESPACE) == b


def test_importer_text_and_date_normalization_is_disclosed_with_original_retained():
    document = fixture()
    original_name = export_stac_ckan(document, namespace=NAMESPACE)["payload"]["name"]
    for key in ("id", "title", "description", "license"):
        document[key] = f"  {document[key]}  "
    document["keywords"] = [" facilities "]
    result = export_stac_ckan(document, namespace=NAMESPACE)
    assert result["payload"]["name"] == original_name
    assert result["payload"]["title"] == "Synthetic public facilities"
    assert result["payload"]["tags"] == [{"name": "facilities"}]
    assert result["source"]["document"] == document
    assert "strips surrounding core text whitespace" in " ".join(result["report"]["losses"])


def test_optional_missing_values_remain_unknown():
    document = fixture()
    for key in ("title", "keywords", "providers"):
        document.pop(key)
    document["links"] = []
    document["extent"]["temporal"]["interval"] = [[None, None]]
    result = export_stac_ckan(document, namespace=NAMESPACE)
    payload = result["payload"]
    assert payload["title"] == document["id"] and payload["tags"] == []
    assert "url" not in payload and "resources" not in payload
    assert "title=id" in result["importReport"]["defaulted"]
    extra_keys = {extra["key"] for extra in payload["extras"]}
    assert {"opengeo:publishers", "opengeo:temporal_start", "opengeo:temporal_end"}.isdisjoint(
        extra_keys
    )


@pytest.mark.parametrize(
    "change",
    [
        {"api_key": "synthetic-secret"},
        {"sensitivity": "restricted"},
        {"private": True},
        {"links": [{"rel": "self", "href": "https://example.test/?token=synthetic-secret"}]},
        {"links": [{"rel": "self", "href": "https://user:password@example.test/"}]},
        {"type": "Feature"},
        {"stac_version": "1.0.0"},
        {"keywords": ["slash/tag"]},
    ],
)
def test_sensitive_and_unsupported_inputs_reject(change):
    document = fixture()
    document.update(change)
    with pytest.raises(MetadataImportInvalid):
        export_stac_ckan(document, namespace=NAMESPACE)


def test_derived_validator_refuses_ownership_fields_and_duplicate_extras():
    payload = export_stac_ckan(fixture(), namespace=NAMESPACE)["payload"]
    payload["owner_org"] = "upstream-organization"
    with pytest.raises(MetadataImportInvalid):
        validate_ckan_create_subset(payload)
    payload.pop("owner_org")
    payload["extras"].append(payload["extras"][0])
    with pytest.raises(MetadataImportInvalid):
        validate_ckan_create_subset(payload)


def test_cli_matches_selected_output_and_rejects_without_leaking_input(tmp_path):
    import sys

    script = ROOT / "services/api/scripts/export_stac_ckan.py"
    command = [sys.executable, str(script), "--input", str(FIXTURE), "--namespace", NAMESPACE]
    result = subprocess.run(command, capture_output=True, text=True, check=True)
    expected = (ROOT / "docs/api/evidence/stac-ckan-export.json").read_text()
    assert result.stdout == expected
    secret = tmp_path / "sensitive.json"
    document = fixture()
    document["password"] = "never-echo-this-value"
    secret.write_text(json.dumps(document))
    denied = subprocess.run(
        [sys.executable, str(script), "--input", str(secret), "--namespace", NAMESPACE],
        capture_output=True,
        text=True,
        check=False,
    )
    assert denied.returncode == 2 and denied.stdout == ""
    assert "never-echo-this-value" not in denied.stderr and str(secret) not in denied.stderr
    secret.write_text("[" * 1_200 + "0" + "]" * 1_200)
    nested = subprocess.run(
        [sys.executable, str(script), "--input", str(secret), "--namespace", NAMESPACE],
        capture_output=True,
        text=True,
        check=False,
    )
    assert nested.returncode == 2 and nested.stdout == ""
    assert "Traceback" not in nested.stderr and str(secret) not in nested.stderr
