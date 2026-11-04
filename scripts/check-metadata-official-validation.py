import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from uuid import UUID

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "api" / "src"))

from jsonschema import Draft202012Validator
from opengeo_api.metadata_adapters import (
    build_metadata_import_plan,
    metadata_source_checksum,
)
from opengeo_api.metadata_catalog import (
    CatalogMetadataInvalid,
    validate_catalog_metadata,
)
from opengeo_api.metadata_profiles import (
    canonical_metadata_json,
    export_datacite_4_7_xml,
    export_geodcat_ap_3_1,
    export_iso_19115_3,
)
from pyshacl import validate as validate_shacl

FIXTURES = ROOT / "parity" / "fixtures" / "data"
SOURCE_LOCK = (
    ROOT
    / "parity"
    / "fixtures"
    / "data"
    / "metadata-007-official-validation-sources.json"
)
REPORT = ROOT / "parity" / "reports" / "metadata-003-official-validation.json"
NOW = datetime(2026, 8, 20, tzinfo=UTC)
RESOURCE_ID = UUID("a0000000-0000-4000-8000-0000000000c1")
PROJECT_ID = UUID("50000000-0000-4000-8000-0000000000c1")


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Replay official ISO, DataCite, and GeoDCAT metadata validators offline."
    )
    parser.add_argument("--iso-root", type=Path, required=True)
    parser.add_argument("--datacite-root", type=Path, required=True)
    parser.add_argument("--geodcat-root", type=Path, required=True)
    parser.add_argument("--xlink-schema", type=Path, required=True)
    parser.add_argument("--xml-schema", type=Path, required=True)
    parser.add_argument("--write-report", action="store_true")
    parser.add_argument("--print-report", action="store_true")
    return parser.parse_args()


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def assert_artifact(path: Path, expected: dict[str, Any]) -> None:
    if not path.is_file():
        raise AssertionError(f"official artifact is missing: {path}")
    if path.stat().st_size != expected["bytes"]:
        raise AssertionError(f"official artifact size drifted: {path}")
    if digest(path) != expected["sha256"]:
        raise AssertionError(f"official artifact checksum drifted: {path}")


def assert_commit(root: Path, expected: str) -> None:
    actual = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if actual != expected:
        raise AssertionError(f"official checkout commit drifted: {root}: {actual}")


def resource_from_plan(plan: Any) -> SimpleNamespace:
    draft = plan.draft
    metadata = draft.metadata
    return SimpleNamespace(
        summary=SimpleNamespace(
            resource_id=RESOURCE_ID,
            project_id=PROJECT_ID,
            kind=draft.kind,
            version_number=1,
            created_at=NOW,
            updated_at=NOW,
            title=metadata.title,
            abstract=metadata.abstract,
            language=metadata.language,
            license=metadata.license,
            attribution=metadata.attribution,
            keywords=metadata.keywords,
            spatial_extent=metadata.spatial_extent,
            temporal_start=metadata.temporal_start,
            temporal_end=metadata.temporal_end,
        ),
        translations=metadata.translations,
        metadata_extensions=metadata.extensions,
        provenance=draft.provenance,
        content=draft.content,
        relationships=(),
    )


def import_fixture(source_format: str, filename: str) -> tuple[Any, bytes]:
    raw = (FIXTURES / filename).read_bytes()
    document: Any = raw.decode() if source_format == "iso_19115_3" else json.loads(raw)
    plan = build_metadata_import_plan(
        source_format,
        "official.validation",
        f"{source_format.replace('_', '-')}-validation",
        "restricted",
        document,
        metadata_source_checksum(document),
    )
    return resource_from_plan(plan), raw


def catalog_text(iso_root: Path, xlink: Path, xml_schema: Path) -> str:
    iso_uri = iso_root.resolve().as_uri() + "/"
    gml_uri = (iso_root / "19136" / "-" / "gml" / "1.0").resolve().as_uri() + "/"
    xlink_uri = xlink.resolve().as_uri()
    xml_uri = xml_schema.resolve().as_uri()
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<catalog xmlns="urn:oasis:names:tc:entity:xmlns:xml:catalog">
  <rewriteSystem systemIdStartString="https://schemas.isotc211.org/" rewritePrefix="{iso_uri}"/>
  <rewriteURI uriStartString="https://schemas.isotc211.org/" rewritePrefix="{iso_uri}"/>
  <rewriteSystem systemIdStartString="http://schemas.opengis.net/gml/3.2.1/" rewritePrefix="{gml_uri}"/>
  <rewriteURI uriStartString="http://schemas.opengis.net/gml/3.2.1/" rewritePrefix="{gml_uri}"/>
  <rewriteSystem systemIdStartString="https://schemas.opengis.net/gml/3.2.1/" rewritePrefix="{gml_uri}"/>
  <rewriteURI uriStartString="https://schemas.opengis.net/gml/3.2.1/" rewritePrefix="{gml_uri}"/>
  <system systemId="http://www.w3.org/1999/xlink.xsd" uri="{xlink_uri}"/>
  <uri name="http://www.w3.org/1999/xlink.xsd" uri="{xlink_uri}"/>
  <system systemId="https://www.w3.org/1999/xlink.xsd" uri="{xlink_uri}"/>
  <uri name="https://www.w3.org/1999/xlink.xsd" uri="{xlink_uri}"/>
  <system systemId="http://www.w3.org/2001/xml.xsd" uri="{xml_uri}"/>
  <uri name="http://www.w3.org/2001/xml.xsd" uri="{xml_uri}"/>
</catalog>
'''


def xsd_validate(
    document: str | bytes, schema: Path, catalog: Path | None = None
) -> bool:
    environment = os.environ.copy()
    if catalog is not None:
        environment["XML_CATALOG_FILES"] = str(catalog)
    completed = subprocess.run(
        ["xmllint", "--noout", "--nonet", "--schema", str(schema), "-"],
        input=document.encode() if isinstance(document, str) else document,
        capture_output=True,
        check=False,
        env=environment,
    )
    if completed.returncode != 0 and os.environ.get("OPENGEO_VALIDATION_DEBUG") == "1":
        print(completed.stderr.decode(errors="replace"), file=sys.stderr)
    return completed.returncode == 0


def remove_first_local_element(document: str, local_name: str) -> bytes:
    root = ET.fromstring(document)
    for parent in root.iter():
        for child in list(parent):
            if child.tag.rsplit("}", 1)[-1] == local_name:
                parent.remove(child)
                return ET.tostring(root, encoding="utf-8", xml_declaration=True)
    raise AssertionError(f"control element was not found: {local_name}")


def remove_all_local_elements(document: str, local_name: str) -> bytes:
    root = ET.fromstring(document)
    removed = 0
    for parent in root.iter():
        for child in list(parent):
            if child.tag.rsplit("}", 1)[-1] == local_name:
                parent.remove(child)
                removed += 1
    if not removed:
        raise AssertionError(f"control elements were not found: {local_name}")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def shacl_conforms(document: dict[str, Any], shape: Path) -> bool:
    conforms, _, report = validate_shacl(
        data_graph=json.dumps(document),
        data_graph_format="json-ld",
        shacl_graph=str(shape),
        shacl_graph_format="turtle",
        inference="rdfs",
        advanced=True,
        allow_infos=False,
        allow_warnings=False,
    )
    if not conforms and os.environ.get("OPENGEO_VALIDATION_DEBUG") == "1":
        print(report, file=sys.stderr)
    return bool(conforms)


def main() -> None:
    args = arguments()
    source_lock = json.loads(SOURCE_LOCK.read_text())
    sources = source_lock["sources"]
    paths = {
        "iso19115_3": args.iso_root / sources["iso19115_3"]["artifact"],
        "datacite47": args.datacite_root / sources["datacite47"]["artifact"],
        "geodcatAp31": args.geodcat_root / sources["geodcatAp31"]["artifact"],
        "w3cXlink": args.xlink_schema,
        "w3cXml": args.xml_schema,
    }
    for name, path in paths.items():
        assert_artifact(path, sources[name])
    for root, name in (
        (args.iso_root, "iso19115_3"),
        (args.datacite_root, "datacite47"),
        (args.geodcat_root, "geodcatAp31"),
    ):
        assert_commit(root, sources[name]["commit"])

    iso_resource, iso_fixture = import_fixture(
        "iso_19115_3", "metadata-006-iso19115-3.xml"
    )
    datacite_resource, _ = import_fixture(
        "datacite_4_7", "metadata-004-datacite47.json"
    )
    geodcat_resource, _ = import_fixture(
        "geodcat_ap_3_1", "metadata-005-geodcat-ap31.json"
    )
    catalog_fields_10 = json.loads(
        (FIXTURES / "metadata-010-opengeo-catalog-fields.json").read_bytes()
    )
    catalog_fields_11 = json.loads(
        (FIXTURES / "metadata-011-opengeo-acquisition-funding.json").read_bytes()
    )
    catalog_fields_12 = json.loads(
        (FIXTURES / "metadata-012-opengeo-acquisition-planning.json").read_bytes()
    )
    catalog_fields_13 = json.loads(
        (FIXTURES / "metadata-013-opengeo-acquisition-events.json").read_bytes()
    )
    catalog_fields_14 = json.loads(
        (FIXTURES / "metadata-014-opengeo-acquisition-context.json").read_bytes()
    )
    catalog_schema_10_path = (
        ROOT / "schemas" / "opengeo-catalog-metadata-1.0.0.schema.json"
    )
    catalog_schema_11_path = (
        ROOT / "schemas" / "opengeo-catalog-metadata-1.1.0.schema.json"
    )
    catalog_schema_12_path = (
        ROOT / "schemas" / "opengeo-catalog-metadata-1.2.0.schema.json"
    )
    catalog_schema_13_path = (
        ROOT / "schemas" / "opengeo-catalog-metadata-1.3.0.schema.json"
    )
    catalog_schema_14_path = (
        ROOT / "schemas" / "opengeo-catalog-metadata-1.4.0.schema.json"
    )
    catalog_schema_10 = json.loads(catalog_schema_10_path.read_bytes())
    catalog_schema_11 = json.loads(catalog_schema_11_path.read_bytes())
    catalog_schema_12 = json.loads(catalog_schema_12_path.read_bytes())
    catalog_schema_13 = json.loads(catalog_schema_13_path.read_bytes())
    catalog_schema_14 = json.loads(catalog_schema_14_path.read_bytes())
    Draft202012Validator.check_schema(catalog_schema_10)
    Draft202012Validator.check_schema(catalog_schema_11)
    Draft202012Validator.check_schema(catalog_schema_12)
    Draft202012Validator.check_schema(catalog_schema_13)
    Draft202012Validator.check_schema(catalog_schema_14)
    catalog_validator_10 = Draft202012Validator(catalog_schema_10)
    catalog_validator_11 = Draft202012Validator(catalog_schema_11)
    catalog_validator_12 = Draft202012Validator(catalog_schema_12)
    catalog_validator_13 = Draft202012Validator(catalog_schema_13)
    catalog_validator_14 = Draft202012Validator(catalog_schema_14)
    native_catalog_json_schema = not list(
        catalog_validator_10.iter_errors(catalog_fields_10)
    )
    native_catalog_11_json_schema = not list(
        catalog_validator_11.iter_errors(catalog_fields_11)
    )
    native_catalog_12_json_schema = not list(
        catalog_validator_12.iter_errors(catalog_fields_12)
    )
    native_catalog_13_json_schema = not list(
        catalog_validator_13.iter_errors(catalog_fields_13)
    )
    native_catalog_14_json_schema = not list(
        catalog_validator_14.iter_errors(catalog_fields_14)
    )
    native_catalog_14_invalid_control_rejected = bool(
        list(
            catalog_validator_14.iter_errors({**catalog_fields_14, "unexpected": True})
        )
    )
    native_catalog_invalid_control_rejected = bool(
        list(
            catalog_validator_10.iter_errors({**catalog_fields_10, "unexpected": True})
        )
    )
    native_catalog_11_invalid_control_rejected = bool(
        list(
            catalog_validator_11.iter_errors({**catalog_fields_11, "unexpected": True})
        )
    )
    native_catalog_12_invalid_control_rejected = bool(
        list(
            catalog_validator_12.iter_errors({**catalog_fields_12, "unexpected": True})
        )
    )
    native_catalog_13_invalid_control_rejected = bool(
        list(
            catalog_validator_13.iter_errors({**catalog_fields_13, "unexpected": True})
        )
    )
    relational_control = json.loads(json.dumps(catalog_fields_11))
    relational_control["acquisition"]["platforms"][0]["instrumentIdentifiers"] = [
        "UNKNOWN-INSTRUMENT"
    ]
    try:
        validate_catalog_metadata(relational_control)
        native_catalog_11_relational_control_rejected = False
    except CatalogMetadataInvalid:
        native_catalog_11_relational_control_rejected = True
    planning_reference_control = json.loads(json.dumps(catalog_fields_12))
    planning_reference_control["acquisition"]["plans"][0]["operationIdentifiers"] = [
        "UNKNOWN-OPERATION"
    ]
    try:
        validate_catalog_metadata(planning_reference_control)
        native_catalog_12_relational_control_rejected = False
    except CatalogMetadataInvalid:
        native_catalog_12_relational_control_rejected = True
    planning_date_control = json.loads(json.dumps(catalog_fields_12))
    planning_date_control["acquisition"]["requirements"][0]["requestedDate"][
        "requestedDateOfCollection"
    ] = "2026-08-01T00:00:00Z"
    try:
        validate_catalog_metadata(planning_date_control)
        native_catalog_12_date_control_rejected = False
    except CatalogMetadataInvalid:
        native_catalog_12_date_control_rejected = True
    event_reference_control = json.loads(json.dumps(catalog_fields_13))
    event_reference_control["acquisition"]["events"][0]["passIdentifier"] = (
        "UNKNOWN-PASS"
    )
    try:
        validate_catalog_metadata(event_reference_control)
        native_catalog_13_relational_control_rejected = False
    except CatalogMetadataInvalid:
        native_catalog_13_relational_control_rejected = True
    event_time_control = json.loads(json.dumps(catalog_fields_13))
    event_time_control["acquisition"]["events"][0]["time"] = "2026-07-01T09:00:00"
    try:
        validate_catalog_metadata(event_time_control)
        native_catalog_13_time_control_rejected = False
    except CatalogMetadataInvalid:
        native_catalog_13_time_control_rejected = True
    enriched_catalog_fields_14 = json.loads(json.dumps(catalog_fields_12))
    enriched_catalog_fields_14.update(
        {
            "schemaVersion": "1.4.0",
            "acquisition": catalog_fields_14["acquisition"],
        }
    )
    iso_resource.metadata_extensions["opengeo"] = enriched_catalog_fields_14
    for resource in (datacite_resource, geodcat_resource):
        resource.metadata_extensions["opengeo"] = catalog_fields_12
    iso_export = export_iso_19115_3(iso_resource)
    datacite_export = export_datacite_4_7_xml(datacite_resource)
    geodcat_export = export_geodcat_ap_3_1(geodcat_resource)
    if any(
        result["document"] is None and result.get("documentText") is None
        for result in (iso_export, datacite_export, geodcat_export)
    ):
        raise AssertionError("an official-validation export failed closed unexpectedly")

    with tempfile.TemporaryDirectory(
        prefix="opengeo-metadata-validation-"
    ) as directory:
        catalog = Path(directory) / "catalog.xml"
        catalog.write_text(
            catalog_text(args.iso_root, args.xlink_schema, args.xml_schema)
        )
        iso_fixture_valid = xsd_validate(iso_fixture, paths["iso19115_3"], catalog)
        iso_export_valid = xsd_validate(
            iso_export["documentText"], paths["iso19115_3"], catalog
        )
        iso_control_rejected = not xsd_validate(
            remove_all_local_elements(iso_export["documentText"], "contact"),
            paths["iso19115_3"],
            catalog,
        )
        datacite_export_valid = xsd_validate(
            datacite_export["documentText"], paths["datacite47"]
        )
        datacite_control_rejected = not xsd_validate(
            remove_first_local_element(
                datacite_export["documentText"], "publicationYear"
            ),
            paths["datacite47"],
        )

    geodcat_document = geodcat_export["document"]
    geodcat_export_valid = shacl_conforms(geodcat_document, paths["geodcatAp31"])
    iso_export_root = ET.fromstring(iso_export["documentText"])
    iso_local_names = [
        element.tag.rsplit("}", 1)[-1] for element in iso_export_root.iter()
    ]
    iso_catalog_sections_mapped = (
        iso_local_names.count("contact") >= 2
        and "referenceSystemInfo" in iso_local_names
        and "distributionInfo" in iso_local_names
        and "dataQualityInfo" in iso_local_names
        and "DQ_UsabilityElement" in iso_local_names
        and "resourceLineage" in iso_local_names
        and "acquisitionInformation" in iso_local_names
        and "MI_Instrument" in iso_local_names
        and "MI_Operation" in iso_local_names
        and "MI_Platform" in iso_local_names
        and "MI_Plan" in iso_local_names
        and "MI_Objective" in iso_local_names
        and "MI_Requirement" in iso_local_names
        and "MI_RequestedDate" in iso_local_names
        and "MI_Event" in iso_local_names
        and "MI_PlatformPass" in iso_local_names
        and "MI_EnvironmentalRecord" in iso_local_names
        and "meterologicalConditions" in iso_local_names
        and "MI_TriggerCode" in iso_local_names
        and "MI_ContextCode" in iso_local_names
        and "MI_SequenceCode" in iso_local_names
        and any(
            element.attrib.get("{http://www.w3.org/1999/xlink}href")
            == "#opengeo-instrument-1"
            for element in iso_export_root.iter()
        )
        and {
            "#opengeo-instrument-1",
            "#opengeo-operation-1",
            "#opengeo-requirement-1",
            "#opengeo-event-1",
            "#opengeo-platform-pass-1",
        }.issubset(
            {
                href
                for element in iso_export_root.iter()
                if (href := element.attrib.get("{http://www.w3.org/1999/xlink}href"))
            }
        )
    )
    if (
        not iso_catalog_sections_mapped
        and os.environ.get("OPENGEO_VALIDATION_DEBUG") == "1"
    ):
        print(
            json.dumps(
                {
                    "isoLocalNames": sorted(set(iso_local_names)),
                    "isoHrefs": sorted(
                        {
                            href
                            for element in iso_export_root.iter()
                            if (
                                href := element.attrib.get(
                                    "{http://www.w3.org/1999/xlink}href"
                                )
                            )
                        }
                    ),
                },
                sort_keys=True,
            ),
            file=sys.stderr,
        )
    datacite_export_root = ET.fromstring(datacite_export["documentText"])
    datacite_local_names = {
        element.tag.rsplit("}", 1)[-1] for element in datacite_export_root.iter()
    }
    datacite_funding_mapped = {
        "fundingReferences",
        "fundingReference",
        "funderName",
        "funderIdentifier",
        "awardNumber",
        "awardTitle",
    }.issubset(datacite_local_names)
    geodcat_catalog_fields_mapped = all(
        field in geodcat_document
        for field in (
            "dcat:contactPoint",
            "dcat:distribution",
            "geodcatap:referenceSystem",
            "dct:provenance",
            "dqv:hasQualityMeasurement",
            "dct:accrualPeriodicity",
            "dct:accessRights",
        )
    )
    geodcat_control = {
        "@context": geodcat_document["@context"],
        "@id": geodcat_document["@id"],
        "@type": "dcat:Dataset",
        "dct:title": "Invalid control without the mandatory description",
    }
    geodcat_control_rejected = not shacl_conforms(geodcat_control, paths["geodcatAp31"])
    checks = {
        "isoFixtureXsd": iso_fixture_valid,
        "isoExportXsd": iso_export_valid,
        "isoInvalidControlRejected": iso_control_rejected,
        "dataciteExportXsd": datacite_export_valid,
        "dataciteInvalidControlRejected": datacite_control_rejected,
        "geodcatExportShacl": geodcat_export_valid,
        "geodcatInvalidControlRejected": geodcat_control_rejected,
        "isoCatalogSectionsMapped": iso_catalog_sections_mapped,
        "dataciteFundingMapped": datacite_funding_mapped,
        "geodcatCatalogFieldsMapped": geodcat_catalog_fields_mapped,
        "nativeCatalogJsonSchema": native_catalog_json_schema,
        "nativeCatalogInvalidControlRejected": native_catalog_invalid_control_rejected,
        "nativeCatalog11JsonSchema": native_catalog_11_json_schema,
        "nativeCatalog11InvalidControlRejected": native_catalog_11_invalid_control_rejected,
        "nativeCatalog11RelationalControlRejected": (
            native_catalog_11_relational_control_rejected
        ),
        "nativeCatalog12JsonSchema": native_catalog_12_json_schema,
        "nativeCatalog12InvalidControlRejected": native_catalog_12_invalid_control_rejected,
        "nativeCatalog12RelationalControlRejected": (
            native_catalog_12_relational_control_rejected
        ),
        "nativeCatalog12DateControlRejected": native_catalog_12_date_control_rejected,
        "nativeCatalog13JsonSchema": native_catalog_13_json_schema,
        "nativeCatalog13InvalidControlRejected": native_catalog_13_invalid_control_rejected,
        "nativeCatalog13RelationalControlRejected": (
            native_catalog_13_relational_control_rejected
        ),
        "nativeCatalog13TimeControlRejected": native_catalog_13_time_control_rejected,
        "nativeCatalog14JsonSchema": native_catalog_14_json_schema,
        "nativeCatalog14InvalidControlRejected": native_catalog_14_invalid_control_rejected,
    }
    failed = [name for name, passed in checks.items() if not passed]
    if failed:
        raise AssertionError(
            f"official metadata validation failed: {', '.join(failed)}"
        )

    report = {
        "schemaVersion": "1.3.0",
        "verifiedOn": source_lock["verifiedOn"],
        "sourceLockSha256": digest(SOURCE_LOCK),
        "catalogFixtureSha256": digest(
            FIXTURES / "metadata-010-opengeo-catalog-fields.json"
        ),
        "catalog11FixtureSha256": digest(
            FIXTURES / "metadata-011-opengeo-acquisition-funding.json"
        ),
        "catalog12FixtureSha256": digest(
            FIXTURES / "metadata-012-opengeo-acquisition-planning.json"
        ),
        "catalog13FixtureSha256": digest(
            FIXTURES / "metadata-013-opengeo-acquisition-events.json"
        ),
        "catalog14FixtureSha256": digest(
            FIXTURES / "metadata-014-opengeo-acquisition-context.json"
        ),
        "catalogSchemaSha256": digest(catalog_schema_10_path),
        "catalog11SchemaSha256": digest(catalog_schema_11_path),
        "catalog12SchemaSha256": digest(catalog_schema_12_path),
        "catalog13SchemaSha256": digest(catalog_schema_13_path),
        "catalog14SchemaSha256": digest(catalog_schema_14_path),
        "checks": checks,
        "exports": {
            "iso19115_3Sha256": hashlib.sha256(
                iso_export["documentText"].encode()
            ).hexdigest(),
            "datacite47XmlSha256": hashlib.sha256(
                datacite_export["documentText"].encode()
            ).hexdigest(),
            "geodcatAp31CanonicalSha256": hashlib.sha256(
                canonical_metadata_json(geodcat_document)
            ).hexdigest(),
        },
        "validators": source_lock["validators"],
        "limitations": {
            "isoSchematron": (
                "not run: the pinned mdb/2.0 package has no matching root Schematron; "
                "the available mri/1.0 rules target mdb/1.0"
            ),
            "runtimeValidation": (
                "not claimed: this is an offline release gate, not per-request validation"
            ),
            "recordsEts": "not covered by this gate",
            "catalogMappings": (
                "ISO online distributions and generic scalar quality measurements map "
                "with field-level losses; ISO acquisition instruments, operations, and "
                "platform references, plans, objectives, requirements, events, and "
                "platform passes plus DataCite funding map in both directions; specialized "
                "quality, objective/pass extents, plan/requirement citations and reverse "
                "links, environmental conditions, and target-specific fields remain "
                "explicit losses"
            ),
        },
        "cost": {
            "deployedResourcesAdded": 0,
            "idleMonthlyCostDeltaUsd": "0.000",
        },
    }
    encoded = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.print_report:
        print(encoded, end="")
        return
    if args.write_report:
        REPORT.write_text(encoded)
    elif not REPORT.is_file() or REPORT.read_text() != encoded:
        raise AssertionError(
            "official validation report drifted; replay with --write-report"
        )
    print(json.dumps({"status": "passed", "checks": checks}, sort_keys=True))


if __name__ == "__main__":
    main()
