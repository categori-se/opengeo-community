"""Project ownership, route compatibility and interrupted publisher recovery."""

import asyncio
import hashlib
from copy import deepcopy
from uuid import UUID

import pytest

from opengeo_api.framework_publication_aws import S3PublicationStorage
from opengeo_api.framework_publisher import (
    PublicationConflict,
    _jsonb_checksum,
    plan_publication,
    publish_step,
)


def fixture():
    ids = [UUID(int=n) for n in range(1, 6)]
    review, build, source, organization, project = ids
    prefix = (
        f"organizations/{organization}/projects/{project}/"
        f"source-projects/{source}/builds/{build}/output/"
    )
    pin = {"checksumSha256": "a" * 64, "sizeBytes": 12, "contentType": "text/html"}
    result = {
        "buildJobId": str(build),
        "outputPrefix": prefix,
        "outputManifest": {
            "files": [
                {
                    **pin,
                    "path": "dist/index.html",
                    "bucket": "private",
                    "objectKey": prefix + "index.html",
                    "s3VersionId": "v1",
                }
            ]
        },
        "routeManifest": [{"file": "dist/index.html", "path": "/"}],
    }
    current = [
        {
            **pin,
            "path": path,
            "bucket": "public",
            "objectKey": "releases/old/" + path,
            "etag": '"old"',
        }
        for path in (
            "index.html",
            "about.html",
            "_observablehq/theme-near-midnight,wide.377480a2.css",
            "analysis/noaa/index.html",
            "analysis/noaa/stale.js",
            "bhutan/index.html",
        )
    ]
    return dict(
        review_id=review,
        build_id=build,
        source_project_id=source,
        organization_id=organization,
        project_id=project,
        source_bucket="private",
        public_bucket="public",
        previous_prefix="releases/old",
        mount_path="/analysis/noaa/",
        reserved_mounts=("/", "/analysis/noaa/", "/bhutan/"),
        build_result=result,
        current_files=current,
    )


def native_fixture(*, size=12, data=False, expanded=False):
    args = fixture()
    revision = {
        "schemaVersion": "opengeo.observable-source-revision.2.0.0"
        if data
        else "opengeo.observable-source-revision.1.0.0",
        "sourceProjectId": str(args["source_project_id"]),
        "revisionId": str(UUID(int=21)),
        "revisionNumber": 1,
        "entryPath": "index.md",
        "lockfilePath": None,
        "files": [{"path": "index.md", "sizeBytes": 12, "checksumSha256": "d" * 64}],
    }
    if data:
        revision["dataAttachments"] = [
            {"path": "data/original.tif", "sizeBytes": 64_912_721, "checksumSha256": "e" * 64}
        ]
    request = {
        "schemaVersion": "opengeo.observable-build-request.4.0.0",
        "outputRepresentation": "single-html",
        "sourceProjectId": str(args["source_project_id"]),
        "sourceRevisionId": revision["revisionId"],
        "sourceRevisionNumber": 1,
        "sourceManifestChecksumSha256": _jsonb_checksum(revision),
        "compilerImageDigest": "sha256:" + "a" * 64,
        "purpose": "preview",
        "outputProfile": "archive-96m" if expanded else "default-32m",
        "sizeAcknowledgment": "allow-up-to-96-mib-output" if expanded else None,
        "distributionApprovalId": None,
        "distributionApprovalChecksumSha256": None,
        "resourceLimits": {"maxOutputBytes": 33_554_432},
    }
    result = args["build_result"]
    output = result["outputManifest"]["files"][0]
    output["sizeBytes"] = size
    manifest_output = {
        key: output[key] for key in ("path", "sizeBytes", "contentType", "checksumSha256")
    }
    manifest = {
        "schemaVersion": "opengeo.framework-localized-output.1.0.0",
        "entryPath": "dist/index.html",
        "inputFiles": [{**manifest_output, "sizeBytes": 12}],
        "assets": [],
        "output": manifest_output,
        "outputBytes": size,
        "publicationAuthorized": False,
        "fontFallback": None,
        "sourceOutputTreeChecksumSha256": "f" * 64,
        "unsupportedLazyImports": [],
    }
    result.update(
        schemaVersion="opengeo.observable-build-result.2.0.0",
        outputRepresentation="single-html",
        requestChecksumSha256=_jsonb_checksum(request),
        compilerImageDigest=request["compilerImageDigest"],
        inputManifestChecksumSha256=request["sourceManifestChecksumSha256"],
        validationReport={"publicationAuthorized": False},
        localizedOutput={"manifest": manifest, "manifestChecksumSha256": _jsonb_checksum(manifest)},
    )
    approval = None
    if data:
        approved = {
            "schemaVersion": "opengeo.observable-input-distribution-approval.1.0.0",
            "organizationId": str(args["organization_id"]),
            "projectId": str(args["project_id"]),
            "sourceProjectId": str(args["source_project_id"]),
            "sourceRevisionId": revision["revisionId"],
            "compilerImageDigest": request["compilerImageDigest"],
            "sourceManifestChecksumSha256": request["sourceManifestChecksumSha256"],
            "outputProfile": request["outputProfile"],
            "artifactInputsChecksumSha256": None,
            "dataAttachments": revision["dataAttachments"],
            "archiveRights": [],
            "artifacts": [],
        }
        approval = {
            "id": str(UUID(int=22)),
            "manifest": approved,
            "manifest_checksum_sha256": _jsonb_checksum(approved),
        }
    args.update(build_request=request, source_manifest=revision, input_distribution=approval)
    return args


def referenced_fixture(*, native=True, expanded=True, archive=False):
    args = native_fixture(size=88_347_591 if native and expanded else 12, expanded=expanded)
    revision, request = args["source_manifest"], args["build_request"]
    revision["schemaVersion"] = "opengeo.observable-source-revision.3.0.0"
    revision["dataAttachments"] = (
        [
            {
                "path": "data/backup.tif",
                "attachmentId": str(UUID(int=31)),
                "sizeBytes": 16,
                "checksumSha256": "c" * 64,
            }
        ]
        if archive
        else []
    )
    revision["referencedFiles"] = [
        {
            "kind": "referenced-public-file",
            "custody": "referenced",
            "referenceId": str(UUID(int=32)),
            "path": "data/original.tif",
            "datasetId": str(UUID(int=33)),
            "sourceVersion": 1,
            "resourceId": str(UUID(int=34)),
            "resourceVersionId": str(UUID(int=35)),
            "resourceVersionNumber": 1,
            "distributionId": "tiff",
            "url": "https://catalog.example.test/original.tif",
            "contentType": "image/tiff",
            "sizeBytes": 64_912_721,
            "checksumSha256": "e" * 64,
        }
    ]
    request["purpose"] = "release_candidate"
    approved = {
        "schemaVersion": "opengeo.observable-input-distribution-approval.2.0.0",
        "organizationId": str(args["organization_id"]),
        "projectId": str(args["project_id"]),
        "sourceProjectId": str(args["source_project_id"]),
        "sourceRevisionId": revision["revisionId"],
        "compilerImageDigest": request["compilerImageDigest"],
        "outputProfile": request["outputProfile"],
        "artifactInputsChecksumSha256": None,
        "dataAttachments": deepcopy(revision["dataAttachments"]),
        "artifacts": [],
        "referencedFiles": deepcopy(revision["referencedFiles"]),
        "archiveRights": (
            [
                {
                    "path": "data/backup.tif",
                    "attachmentId": str(UUID(int=31)),
                    "resourceId": str(UUID(int=36)),
                    "resourceVersionId": str(UUID(int=37)),
                    "license": "CC-BY-4.0",
                    "attribution": "Archive owner",
                    "acknowledgment": "publish-exact-archive-file",
                }
            ]
            if archive
            else []
        ),
        "referenceRights": [
            {
                "referenceId": str(UUID(int=32)),
                "path": "data/original.tif",
                "resourceId": str(UUID(int=34)),
                "resourceVersionId": str(UUID(int=38)),
                "distributionId": "tiff",
                "license": "CC-BY-4.0",
                "attribution": "Catalog owner",
                "acknowledgment": "publish-exact-referenced-file",
            }
        ],
    }
    args["input_distribution"] = {"id": str(UUID(int=22)), "manifest": approved}
    if not native:
        request["schemaVersion"] = "opengeo.observable-build-request.3.0.0"
        del request["outputRepresentation"]
        result = args["build_result"]
        result["schemaVersion"] = "opengeo.observable-build-result.1.0.0"
        del result["outputRepresentation"], result["localizedOutput"]
        result["outputManifest"]["files"].append(
            {
                "path": "dist/data/original.tif",
                "bucket": "private",
                "objectKey": result["outputPrefix"] + "data/original.tif",
                "s3VersionId": "exact-tiff",
                "sizeBytes": 64_912_721,
                "checksumSha256": "e" * 64,
                "contentType": "image/tiff",
            }
        )
    reseal_referenced_fixture(args)
    return args


def reseal_referenced_fixture(args):
    revision, request, result = args["source_manifest"], args["build_request"], args["build_result"]
    approval = args["input_distribution"]
    request["sourceManifestChecksumSha256"] = _jsonb_checksum(revision)
    approval["manifest"]["sourceManifestChecksumSha256"] = request["sourceManifestChecksumSha256"]
    approval["manifest_checksum_sha256"] = _jsonb_checksum(approval["manifest"])
    request["distributionApprovalId"] = approval["id"]
    request["distributionApprovalChecksumSha256"] = approval["manifest_checksum_sha256"]
    result["requestChecksumSha256"] = _jsonb_checksum(request)
    result["inputManifestChecksumSha256"] = request["sourceManifestChecksumSha256"]


@pytest.mark.parametrize("native,expanded", [(True, True), (True, False), (False, True)])
@pytest.mark.parametrize("archive", [False, True])
def test_referenced_publication_plans_exact_approved_native_and_asset_tree_outputs(
    native, expanded, archive
):
    args = referenced_fixture(native=native, expanded=expanded, archive=archive)
    plan = plan_publication(**args, private_origin=True)
    outputs = [entry for entry in plan["files"] if entry["path"].startswith("analysis/noaa/")]
    if native:
        for entry in outputs:
            assert entry["source"]["localizedOutput"] == args["build_result"]["localizedOutput"]
            assert entry.get("maximumBytes") == (100_663_296 if expanded else None)
    else:
        tiff = next(entry for entry in outputs if entry["path"].endswith(".tif"))
        assert tiff["maximumBytes"] == 67_108_864
        assert tiff["source"]["s3VersionId"] == "exact-tiff"


@pytest.mark.parametrize("native", [False, True])
@pytest.mark.parametrize(
    "change",
    [
        "approval-missing",
        "approval-id",
        "approval-seal",
        "approval-v1",
        "pin",
        "rights",
        "rights-ack",
        "archive-rights",
        "preview",
        "source-only",
        "profile",
        "result-seal",
    ],
)
def test_referenced_publication_denies_missing_or_tampered_consent_and_source_only_shortcuts(
    native, change
):
    args = referenced_fixture(native=native, archive=True)
    request, approval = args["build_request"], args["input_distribution"]
    if change == "approval-missing":
        args["input_distribution"] = None
    elif change == "approval-id":
        request["distributionApprovalId"] = None
        args["build_result"]["requestChecksumSha256"] = _jsonb_checksum(request)
    elif change == "approval-seal":
        approval["manifest_checksum_sha256"] = "b" * 64
    elif change == "result-seal":
        args["build_result"]["requestChecksumSha256"] = "b" * 64
    else:
        if change == "approval-v1":
            approval["manifest"]["schemaVersion"] = (
                "opengeo.observable-input-distribution-approval.1.0.0"
            )
        elif change == "pin":
            approval["manifest"]["referencedFiles"][0]["checksumSha256"] = "b" * 64
        elif change == "rights":
            approval["manifest"]["referenceRights"][0]["resourceId"] = str(UUID(int=99))
        elif change == "rights-ack":
            approval["manifest"]["referenceRights"][0]["acknowledgment"] = (
                "publish-exact-archive-file"
            )
        elif change == "archive-rights":
            approval["manifest"]["archiveRights"] = []
        elif change == "preview":
            request["purpose"] = "preview"
        elif change == "source-only":
            args["source_manifest"]["schemaVersion"] = "opengeo.observable-source-revision.1.0.0"
            args["source_manifest"]["referencedFiles"] = []
        else:
            request["outputProfile"] = "default-32m"
        reseal_referenced_fixture(args)
    with pytest.raises(PublicationConflict, match="referenced_authority_invalid"):
        plan_publication(**args)


@pytest.mark.parametrize("change", ["size", "checksum", "extension", "default-profile"])
def test_referenced_asset_tree_large_tiff_requires_exact_bytes_suffix_and_expanded_profile(change):
    args = referenced_fixture(native=False)
    output = args["build_result"]["outputManifest"]["files"][1]
    if change == "size":
        output["sizeBytes"] += 1
    elif change == "checksum":
        output["checksumSha256"] = "b" * 64
    elif change == "extension":
        output.update(
            path="dist/data/original.html",
            objectKey=args["build_result"]["outputPrefix"] + "data/original.html",
        )
    else:
        args["build_request"].update(outputProfile="default-32m", sizeAcknowledgment=None)
        args["input_distribution"]["manifest"]["outputProfile"] = "default-32m"
        reseal_referenced_fixture(args)
    with pytest.raises(PublicationConflict, match="pin_invalid"):
        plan_publication(**args)


@pytest.mark.parametrize("private", [False, True])
def test_native_source_only_default32_retains_exact_proof_without_input_approval(private):
    args = native_fixture()
    plan = plan_publication(**args, private_origin=private)
    entries = [
        entry
        for entry in plan["files"]
        if entry["kind"] == "copy" and entry["path"].startswith("analysis/noaa/")
    ]
    assert len(entries) == (2 if private else 1)
    for entry in entries:
        assert entry["source"]["localizedOutput"] == args["build_result"]["localizedOutput"]
        assert "maximumBytes" not in entry


def test_native_archive96_permits_only_the_sealed_generated_index_and_canonical_alias():
    args = native_fixture(size=88_347_591, data=True, expanded=True)
    plan = plan_publication(**args, private_origin=True)
    entries = [entry for entry in plan["files"] if entry.get("maximumBytes") == 100_663_296]
    assert {entry["path"] for entry in entries} == {"analysis/noaa/index.html", "analysis/noaa/"}
    assert all(
        entry["source"]["localizedOutput"] == args["build_result"]["localizedOutput"]
        for entry in entries
    )


@pytest.mark.parametrize(
    "change",
    [
        "approval",
        "ack",
        "data",
        "profile",
        "proof",
        "output-hash",
        "mime",
        "path",
        "extra-output",
        "source",
        "request",
        "compiler",
        "artifact",
        "limit",
    ],
)
def test_native_publication_rejects_unbound_or_changed_proof_and_consents(change):
    args = native_fixture(size=88_347_591, data=True, expanded=True)
    if change == "approval":
        args["input_distribution"] = None
    elif change == "ack":
        args["build_request"]["sizeAcknowledgment"] = None
    elif change == "data":
        args["source_manifest"]["dataAttachments"] = []
    elif change == "profile":
        args["build_request"]["outputProfile"] = "default-32m"
    elif change == "proof":
        args["build_result"]["localizedOutput"]["manifestChecksumSha256"] = "b" * 64
    elif change == "output-hash":
        args["build_result"]["outputManifest"]["files"][0]["checksumSha256"] = "b" * 64
    elif change == "mime":
        args["build_result"]["outputManifest"]["files"][0]["contentType"] = (
            "application/octet-stream"
        )
    elif change == "path":
        args["build_result"]["outputManifest"]["files"][0]["path"] = "dist/other.html"
    elif change == "extra-output":
        args["build_result"]["outputManifest"]["files"].append(
            deepcopy(args["build_result"]["outputManifest"]["files"][0])
        )
    elif change == "source":
        args["source_manifest"]["revisionId"] = str(UUID(int=99))
    elif change == "request":
        args["build_result"]["requestChecksumSha256"] = "b" * 64
    elif change == "compiler":
        args["build_result"]["compilerImageDigest"] = "sha256:" + "b" * 64
    elif change == "artifact":
        args["build_request"]["artifactInputsChecksumSha256"] = "b" * 64
    else:
        args["build_request"]["resourceLimits"]["maxOutputBytes"] = 100_663_296
    with pytest.raises(PublicationConflict):
        plan_publication(**args)


def retained_native_plan(args, *, size=88_347_591):
    previous = native_fixture(size=size, data=True, expanded=True)
    source = deepcopy(previous["build_result"]["outputManifest"]["files"][0])
    source["localizedOutput"] = previous["build_result"]["localizedOutput"]
    return {
        "schema": "opengeo.framework-publication-plan.1.0.0",
        "bucket": "public",
        "targetPrefix": args["previous_prefix"],
        "files": [{"path": "bhutan/index.html", "kind": "copy", "source": source}],
    }


@pytest.mark.parametrize("change", [None, "missing", "prefix", "checksum", "type", "unsealed"])
def test_native_large_sibling_requires_previous_deployed_plan_and_exact_public_pin(change):
    args = fixture()
    plan = retained_native_plan(args)
    sibling = next(file for file in args["current_files"] if file["path"] == "bhutan/index.html")
    sibling["sizeBytes"] = 88_347_591
    args["previous_release_plan"] = plan
    if change == "missing":
        args["previous_release_plan"] = None
    elif change == "prefix":
        plan["targetPrefix"] = "releases/other"
    elif change == "checksum":
        sibling["checksumSha256"] = "b" * 64
    elif change == "type":
        sibling["contentType"] = "application/octet-stream"
    elif change == "unsealed":
        plan["files"][0]["source"]["localizedOutput"]["manifestChecksumSha256"] = "b" * 64
    if change:
        with pytest.raises(PublicationConflict):
            plan_publication(**args)
    else:
        kept = next(
            entry
            for entry in plan_publication(**args)["files"]
            if entry["path"] == "bhutan/index.html"
        )
        assert kept["maximumBytes"] == 100_663_296
        assert kept["source"]["objectKey"] == "releases/old/bhutan/index.html"
        assert kept["source"]["localizedOutput"] == plan["files"][0]["source"]["localizedOutput"]


def test_child_release_preserves_root_and_siblings_and_canonical_routes():
    args = fixture()
    files = {item["path"]: item for item in plan_publication(**args)["files"]}
    for path in (
        "index.html",
        "about.html",
        "bhutan/index.html",
        "_observablehq/theme-near-midnight,wide.377480a2.css",
    ):
        assert files[path]["source"]["objectKey"] == "releases/old/" + path
    assert "analysis/noaa/stale.js" not in files
    assert files["analysis/noaa/index.html"]["source"]["s3VersionId"] == "v1"
    for alias in ("analysis/noaa", "analysis/noaa.html"):
        assert files[alias] == {"path": alias, "kind": "redirect", "location": "/analysis/noaa/"}


def test_private_origin_serves_directory_keys_without_changing_relative_url_depth():
    args = fixture()
    built = args["build_result"]["outputManifest"]["files"]
    built.append(
        {
            **built[0],
            "path": "dist/guide/index.html",
            "objectKey": args["build_result"]["outputPrefix"] + "guide/index.html",
        }
    )
    args["build_result"]["routeManifest"].append(
        {"file": "dist/guide/index.html", "path": "/guide/"}
    )
    plan = plan_publication(**args, private_origin=True)
    assert plan["privateOrigin"] is True
    files = {item["path"]: item for item in plan["files"]}
    for directory in ("analysis/noaa/", "analysis/noaa/guide/"):
        assert files[directory]["kind"] == "copy"
        assert files[directory]["source"] == files[directory + "index.html"]["source"]
    assert files["bhutan/index.html"]["source"]["objectKey"] == "releases/old/bhutan/index.html"
    assert "analysis/noaa/" not in {item["path"] for item in plan_publication(**args)["files"]}


def test_root_release_preserves_children_and_cannot_supply_their_files():
    args = fixture()
    args["mount_path"] = "/"
    files = {item["path"]: item for item in plan_publication(**args)["files"]}
    assert "about.html" not in files
    for path in ("analysis/noaa/index.html", "analysis/noaa/stale.js", "bhutan/index.html"):
        assert files[path]["source"]["objectKey"] == "releases/old/" + path
    forged = deepcopy(args["build_result"]["outputManifest"]["files"][0])
    forged.update(
        path="dist/bhutan/index.html",
        objectKey=args["build_result"]["outputPrefix"] + "bhutan/index.html",
    )
    args["build_result"]["outputManifest"]["files"].append(forged)
    with pytest.raises(PublicationConflict, match="sibling_path_collision"):
        plan_publication(**args)


def test_approved_output_cannot_reference_another_projects_source():
    args = fixture()
    args["build_result"]["outputManifest"]["files"][0]["objectKey"] = "other/index.html"
    with pytest.raises(PublicationConflict, match="output_scope_invalid"):
        plan_publication(**args)


def test_large_archived_output_requires_bound_distribution_and_exact_unchanged_file():
    args = fixture()
    revision_id = str(UUID(int=21))
    pin = {"path": "data/original.tif", "checksumSha256": "e" * 64, "sizeBytes": 64912721}
    request = {
        "schemaVersion": "opengeo.observable-build-request.3.0.0",
        "outputProfile": "archive-96m",
        "sizeAcknowledgment": "allow-up-to-96-mib-output",
        "sourceRevisionId": revision_id,
        "compilerImageDigest": "sha256:" + "a" * 64,
        "sourceManifestChecksumSha256": "b" * 64,
    }
    args.update(
        build_request=request,
        source_manifest={"dataAttachments": [pin]},
        input_distribution={
            "manifest_checksum_sha256": "c" * 64,
            "manifest": {
                "schemaVersion": "opengeo.observable-input-distribution-approval.1.0.0",
                "organizationId": str(args["organization_id"]),
                "projectId": str(args["project_id"]),
                "sourceProjectId": str(args["source_project_id"]),
                "sourceRevisionId": revision_id,
                "outputProfile": "archive-96m",
                "compilerImageDigest": request["compilerImageDigest"],
                "sourceManifestChecksumSha256": request["sourceManifestChecksumSha256"],
                "dataAttachments": [pin],
            },
        },
    )
    output = {
        **args["build_result"]["outputManifest"]["files"][0],
        **pin,
        "path": "dist/data/original.tif",
        "contentType": "application/octet-stream",
        "objectKey": args["build_result"]["outputPrefix"] + "data/original.tif",
    }
    args["build_result"]["outputManifest"]["files"].append(output)
    result = next(
        file for file in plan_publication(**args)["files"] if file["path"].endswith(".tif")
    )
    assert result["maximumBytes"] == 67_108_864
    for change in ("approval", "profile", "checksum", "extension", "size"):
        invalid = deepcopy(args)
        if change == "approval":
            invalid["input_distribution"] = None
        elif change == "profile":
            invalid["build_request"]["outputProfile"] = "default-32m"
        elif change == "checksum":
            invalid["build_result"]["outputManifest"]["files"][1]["checksumSha256"] = "f" * 64
        elif change == "extension":
            invalid["build_result"]["outputManifest"]["files"][1].update(
                path="dist/data/original.html",
                objectKey=args["build_result"]["outputPrefix"] + "data/original.html",
            )
        else:
            invalid["build_result"]["outputManifest"]["files"][1]["sizeBytes"] += 1
        with pytest.raises(PublicationConflict, match=r"size_limit|pin_invalid"):
            plan_publication(**invalid)


def test_already_public_large_sibling_is_preserved_with_exact_inventory_scope():
    args = fixture()
    args["current_files"].append(
        {
            "path": "bhutan/original.tif",
            "bucket": "public",
            "objectKey": "releases/old/bhutan/original.tif",
            "etag": "already-public",
            "checksumSha256": "e" * 64,
            "contentType": "image/tiff",
            "sizeBytes": 64912721,
        }
    )
    kept = next(file for file in plan_publication(**args)["files"] if file["path"].endswith(".tif"))
    assert kept["source"]["bucket"] == "public" and kept["maximumBytes"] == 67_108_864
    args["current_files"][-1]["sizeBytes"] = 67_108_865
    with pytest.raises(PublicationConflict, match="pin_invalid"):
        plan_publication(**args)


@pytest.mark.parametrize(
    "difference",
    [
        None,
        "checksumSha256",
        "sizeBytes",
        "contentType",
        "encoding",
        "cache",
        "redirect",
    ],
)
def test_output_reuse_requires_same_path_bytes_and_delivery(difference):
    args = fixture()
    previous = next(
        file for file in args["current_files"] if file["path"] == "analysis/noaa/index.html"
    )
    previous["delivery"] = {"content-type": "text/html", "cache-control": "no-cache"}
    if difference == "checksumSha256":
        previous[difference] = "b" * 64
    elif difference == "sizeBytes":
        previous[difference] += 1
    elif difference == "contentType":
        previous[difference] = "text/plain"
    elif difference == "encoding":
        previous["delivery"]["content-encoding"] = "gzip"
    elif difference == "cache":
        previous["delivery"]["cache-control"] = "max-age=3600"
    elif difference == "redirect":
        previous["delivery"]["x-amz-website-redirect-location"] = "/elsewhere/"
    plan = plan_publication(**args)
    output = next(file for file in plan["files"] if file["path"] == previous["path"])
    assert output["source"]["bucket"] == ("public" if difference is None else "private")
    if difference is None:
        assert output["source"] == previous
    assert plan["targetPrefix"] != plan["previousPrefix"]
    assert not any(file["path"] == "analysis/noaa/stale.js" for file in plan["files"])


def test_reused_output_still_validates_new_build_identity_and_cannot_take_a_sibling_path():
    args = fixture()
    for file in args["current_files"]:
        file["delivery"] = {"content-type": "text/html", "cache-control": "no-cache"}
    output = args["build_result"]["outputManifest"]["files"][0]
    output["objectKey"] = "unrelated/object"
    with pytest.raises(PublicationConflict, match="output_scope_invalid"):
        plan_publication(**args)
    output["objectKey"] = args["build_result"]["outputPrefix"] + "index.html"
    args["reserved_mounts"] += ("/analysis/noaa/index/",)
    # index.html is owned by the more specific child mount's alias.
    with pytest.raises(PublicationConflict, match="sibling_path_collision"):
        plan_publication(**args)


def test_reused_output_delivery_does_not_read_private_staging():
    args = fixture()
    body = b"<h1>Kept</h1>"
    previous = next(
        file for file in args["current_files"] if file["path"] == "analysis/noaa/index.html"
    )
    previous["delivery"] = {"content-type": "text/html", "cache-control": "no-cache"}
    for file in (previous, args["build_result"]["outputManifest"]["files"][0]):
        file.update(sizeBytes=len(body), checksumSha256=hashlib.sha256(body).hexdigest())
    plan = plan_publication(**args)
    output = next(file for file in plan["files"] if file["path"] == previous["path"])
    requests = []

    class Aws:
        async def request(self, service, method, path, **kwargs):
            requests.append((method, path))
            assert service == "s3" and path.startswith("/public/")
            if method == "PUT":
                assert kwargs["body"] == body
                assert kwargs["headers"]["if-none-match"] == "*"
                return 200, {}, b""
            if path.startswith("/public/releases/old/"):
                assert kwargs["headers"] == {"if-match": previous["etag"]}
                return 200, previous["delivery"], body
            return (
                200,
                {
                    **previous["delivery"],
                    "x-amz-meta-opengeo-release": plan["targetPrefix"].split("/")[1],
                },
                body,
            )

    asyncio.run(
        S3PublicationStorage(Aws(), "private", "public").apply(
            "public",
            plan["targetPrefix"],
            output,
        )
    )
    assert len(requests) == 3  # Exact public read, conditional write, target verification.


class Repository:
    def __init__(self, args):
        self.state = {
            key: str(args[key]) for key in ("source_project_id", "organization_id", "project_id")
        }
        self.state.update(
            status="claimed",
            build_job_id=str(args["build_id"]),
            origin={"bucket": "public"},
            previous_release_prefix="releases/old",
            mount_path=args["mount_path"],
            reserved_mounts=args["reserved_mounts"],
            build_result=args["build_result"],
            completed_files=0,
        )
        self.released = 0
        self.allowed = True

    async def claim(self, review, token):
        return deepcopy(self.state)

    async def authorize(self, review, token):
        return self.allowed

    async def save_plan(self, review, token, plan, edge):
        self.state.update(plan=plan, edge_snapshot=edge)
        return True

    async def checkpoint(self, review, token, position):
        self.state["completed_files"] = position
        return True

    async def activating(self, review, token):
        return True

    async def complete(self, review, token, receipt):
        self.state.update(status="deployed", receipt=receipt)
        return True

    async def attention(self, review, token, code):
        self.state["error"] = code

    async def release(self, review, token):
        self.released += 1


class Storage:
    def __init__(self, args):
        self.current = args["current_files"]
        self.written = {}
        self.lose_response = True

    async def inventory(self, bucket, prefix):
        return self.current

    async def apply(self, bucket, prefix, file):
        key = (prefix, file["path"])
        assert self.written.setdefault(key, file) == file
        if self.lose_response:
            self.lose_response = False
            raise TimeoutError("Write succeeded but response was lost")

    async def verify(self, plan):
        assert len(self.written) == len(plan["files"])


class Edge:
    def __init__(self):
        self.target = None
        self.calls = 0

    async def prepare(self, origin, previous):
        return {"etag": "old-edge", "previousPrefix": previous}

    async def activate(self, origin, snapshot, target, review):
        self.calls += 1
        if self.target is None:
            self.target = target
            raise TimeoutError("Activation succeeded but response was lost")
        assert self.target == target
        return {"targetPrefix": target, "status": "Deployed"}


@pytest.mark.parametrize("withdrawal", [None, "before-copy", "after-copy"])
def test_referenced_publisher_rechecks_current_authority_before_copy_and_activation(
    withdrawal,
):
    async def run():
        args = referenced_fixture()
        repository, storage, edge = Repository(args), Storage(args), Edge()
        repository.state.update(
            {key: args[key] for key in ("build_request", "source_manifest", "input_distribution")}
        )
        storage.lose_response = False
        edge.target = f"releases/framework-{args['review_id']}"
        repository.allowed = withdrawal != "before-copy"
        apply = storage.apply

        async def copy(bucket, prefix, entry):
            await apply(bucket, prefix, entry)
            if withdrawal == "after-copy":
                # The repository predicate includes current resource authority
                # and approval revocation, including after a durable checkpoint.
                repository.allowed = False

        storage.apply = copy
        status = await publish_step(
            args["review_id"],
            repository=repository,
            storage=storage,
            edge=edge,
            source_bucket="private",
            public_bucket="public",
        )
        if withdrawal:
            assert status == "needs_attention"
            assert len(storage.written) == (1 if withdrawal == "after-copy" else 0)
            assert edge.calls == 0
            assert repository.state["error"] == "publication_authority_or_lease_lost"
        else:
            assert status == "deployed" and edge.calls == 1
            index = next(
                entry
                for entry in repository.state["plan"]["files"]
                if entry["path"] == "analysis/noaa/index.html"
            )
            assert index["maximumBytes"] == 100_663_296
            assert index["source"]["localizedOutput"] == args["build_result"]["localizedOutput"]
            assert len(storage.written) == len(repository.state["plan"]["files"])
        assert repository.released == 1

    asyncio.run(run())


def test_native_publisher_passes_current_origin_deployed_plan_to_inventory_and_seals_proof():
    async def run():
        args = native_fixture()
        previous = retained_native_plan(args)
        repository, storage, edge = Repository(args), Storage(args), Edge()
        repository.state.update(
            build_request=args["build_request"],
            source_manifest=args["source_manifest"],
            input_distribution=args["input_distribution"],
            previous_release_plan=previous,
        )
        storage.lose_response = False
        edge.target = f"releases/framework-{args['review_id']}"
        original_inventory = storage.inventory

        async def inventory(bucket, prefix, **options):
            assert options == {"previous_release_plan": previous}
            return await original_inventory(bucket, prefix)

        # Use the actual current pin selected by that previous deployed plan.
        sibling = next(file for file in storage.current if file["path"] == "bhutan/index.html")
        sibling["sizeBytes"] = 88_347_591
        storage.inventory = inventory
        assert (
            await publish_step(
                args["review_id"],
                repository=repository,
                storage=storage,
                edge=edge,
                source_bucket="private",
                public_bucket="public",
            )
            == "deployed"
        )
        inherited = next(
            file
            for file in repository.state["plan"]["files"]
            if file["path"] == "bhutan/index.html"
        )
        assert inherited["maximumBytes"] == 100_663_296
        assert (
            inherited["source"]["localizedOutput"]
            == previous["files"][0]["source"]["localizedOutput"]
        )

    asyncio.run(run())


@pytest.mark.parametrize("routed", [False, True])
def test_chunks_resume_after_lost_storage_and_activation_responses(routed):
    async def run():
        args = fixture()
        repository, storage, edge = Repository(args), Storage(args), Edge()
        options = dict(
            repository=repository,
            storage=storage,
            edge=edge,
            source_bucket="private",
            public_bucket="public",
            maximum_files=2,
        )
        if routed:

            class Router:
                def resolve(self, origin):
                    assert origin == repository.state["origin"]
                    return "public", storage, edge

            options.update(
                destination_router=Router(),
                public_bucket="unused-default",
                storage=object(),
                edge=object(),
            )
        statuses = []
        for _ in range(10):
            try:
                status = await publish_step(args["review_id"], **options)
            except TimeoutError:
                continue
            statuses.append(status)
            if status == "deployed":
                break
        assert statuses[-1] == "deployed"
        assert "retry" in statuses
        assert edge.calls == 2
        assert repository.released >= 4
        assert {prefix for prefix, path in storage.written} == {
            f"releases/framework-{args['review_id']}"
        }
        assert await publish_step(args["review_id"], **options) == "deployed"
        assert edge.calls == 2

    asyncio.run(run())


def test_revoked_authority_stops_before_any_remote_write():
    async def run():
        args = fixture()
        repository, storage, edge = Repository(args), Storage(args), Edge()
        repository.allowed = False

        class ForbiddenRouter:
            def resolve(self, origin):
                pytest.fail("Revoked claim must not resolve a destination")

        assert (
            await publish_step(
                args["review_id"],
                repository=repository,
                storage=storage,
                edge=edge,
                source_bucket="private",
                public_bucket="public",
                destination_router=ForbiddenRouter(),
            )
            == "needs_attention"
        )
        assert not storage.written
        assert edge.calls == 0

    asyncio.run(run())
