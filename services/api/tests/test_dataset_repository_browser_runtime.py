import asyncio
import json
from datetime import UTC, datetime
from uuid import UUID

import pytest

from opengeo_api.cognito_provisioning import AwsCredentials
from opengeo_api.dataset_repository_browser import (
    AwsLambdaUserDatasetRepositoryBrowser,
    DatasetRepositoryAccessDenied,
    DatasetRepositoryObjectNotFound,
    DatasetRepositoryResponseInvalid,
)
from opengeo_api.dataset_repository_browser_runtime import (
    RdsDataRepositoryTargetResolver,
    RepositoryBrowserAccessDenied,
    RepositoryBrowserCommand,
    RepositoryBrowserCommandInvalid,
    RepositoryBrowserProcessor,
    RepositoryBrowserTarget,
    RepositoryBrowserUnavailable,
    RepositoryObjectInspectionCommand,
    RepositoryObjectNotFound,
    RepositoryObjectVersionInspectionCommand,
    RepositoryObjectVersionsCommand,
    S3RepositoryLister,
    _decode_cursor,
    _decode_version_cursor,
    handle_event,
    parse_command,
    parse_object_command,
    parse_object_version_command,
    parse_object_versions_command,
)
from opengeo_api.rds_data import DataApiResult

ORG_ID = UUID("10000000-0000-4000-8000-000000000064")
OWNER_ID = UUID("20000000-0000-4000-8000-000000000064")
CONNECTION_ID = UUID("a0000000-0000-4000-8000-000000000064")
NOW = datetime(2026, 8, 31, 12, tzinfo=UTC)
TASK_CREDENTIALS = AwsCredentials("TASKACCESS", "task-secret", "task-token")
ASSUMED_CREDENTIALS = AwsCredentials("ASSUMEDACCESS", "assumed-secret", "assumed-token")


def command(**changes) -> RepositoryBrowserCommand:
    values = {
        "organization_id": ORG_ID,
        "owner_user_id": OWNER_ID,
        "connection_id": CONNECTION_ID,
        "prefix": "ma/",
        "cursor": None,
        "limit": 25,
    }
    values.update(changes)
    return RepositoryBrowserCommand(**values)


def target(**changes) -> RepositoryBrowserTarget:
    values = {
        "organization_id": ORG_ID,
        "owner_user_id": OWNER_ID,
        "connection_id": CONNECTION_ID,
        "target_revision": 3,
        "credential_revision": 2,
        "bucket_name": "example-geodata",
        "region_name": "us-east-1",
        "object_prefix": "usa/",
        "credential_mode": "assume_role",
        "role_arn": "arn:aws:iam::111111111111:role/opengeo/OpenGeoDatasetReader",
        "secret_reference": (
            "arn:aws:secretsmanager:us-east-1:222222222222:secret:opengeo/dev/"
            f"user-connections/{ORG_ID}/{OWNER_ID}/{CONNECTION_ID}/version-AbCd12"
        ),
    }
    values.update(changes)
    return RepositoryBrowserTarget(**values)


def event(**changes):
    values = {
        "schema": "opengeo.dataset-repository-browser.command.v1",
        "organization_id": str(ORG_ID),
        "owner_user_id": str(OWNER_ID),
        "connection_id": str(CONNECTION_ID),
        "prefix": "ma/",
        "cursor": None,
        "limit": 25,
    }
    values.update(changes)
    return values


def object_event(**changes):
    values = {
        "schema": "opengeo.dataset-repository-object.command.v1",
        "organization_id": str(ORG_ID),
        "owner_user_id": str(OWNER_ID),
        "connection_id": str(CONNECTION_ID),
        "relative_path": "ma/roads.geojson",
    }
    values.update(changes)
    return values


def versions_event(**changes):
    values = {
        "schema": "opengeo.dataset-repository-object-versions.command.v1",
        "organization_id": str(ORG_ID),
        "owner_user_id": str(OWNER_ID),
        "connection_id": str(CONNECTION_ID),
        "relative_path": "ma/roads.geojson",
        "cursor": None,
        "limit": 25,
    }
    values.update(changes)
    return values


def version_event(**changes):
    values = {
        "schema": "opengeo.dataset-repository-object-version.command.v1",
        "organization_id": str(ORG_ID),
        "owner_user_id": str(OWNER_ID),
        "connection_id": str(CONNECTION_ID),
        "relative_path": "ma/roads.geojson",
        "version_id": "version-3",
    }
    values.update(changes)
    return values


class DataApi:
    def __init__(self, records):
        self.records = records
        self.calls = []

    async def execute(self, statement, parameters=(), transaction_id=None):
        self.calls.append((statement, parameters, transaction_id))
        return DataApiResult(tuple(self.records), 0)


class Credentials:
    def load(self):
        return TASK_CREDENTIALS


class Transport:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def call(self, method, url, headers, body, timeout_seconds, maximum_bytes):
        self.calls.append((method, url, headers, body, timeout_seconds, maximum_bytes))
        return self.response


class Resolver:
    async def resolve(self, browser_command):
        assert browser_command.connection_id == CONNECTION_ID
        return target()


class SecretLoader:
    async def load(self, claim):
        assert claim.target_revision == 3
        return type("Loaded", (), {"values": {"external_id": "scoped-external-id"}})()


class RoleAssumer:
    def __init__(self):
        self.calls = []

    async def assume(self, role_arn, external_id):
        self.calls.append((role_arn, external_id))
        return ASSUMED_CREDENTIALS


class Lister:
    async def list(self, credentials, resolved, prefix, cursor, limit):
        assert credentials == ASSUMED_CREDENTIALS
        assert resolved.bucket_name == "example-geodata"
        assert (prefix, cursor, limit) == ("ma/", None, 25)
        return {
            "prefix": "ma/",
            "parent_prefix": "",
            "entries": [],
            "truncated": False,
            "next_cursor": None,
        }

    async def inspect(self, credentials, resolved, relative_path, version_id=None):
        assert credentials == ASSUMED_CREDENTIALS
        assert resolved.bucket_name == "example-geodata"
        assert relative_path == "ma/roads.geojson"
        assert version_id in {None, "version-3"}
        return {
            "relative_path": relative_path,
            "name": "roads.geojson",
            "size_bytes": 2048,
            "last_modified": "2026-08-31T12:00:00Z",
            "content_type": "application/geo+json",
            "etag": '"etag-value"',
            "storage_class": "STANDARD",
            "version_id": version_id or "version-4",
            "checksum_sha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        }

    async def versions(self, credentials, resolved, relative_path, cursor, limit):
        assert credentials == ASSUMED_CREDENTIALS
        assert resolved.bucket_name == "example-geodata"
        assert (relative_path, cursor, limit) == ("ma/roads.geojson", None, 25)
        return {
            "relative_path": relative_path,
            "entries": [
                {
                    "version_id": "version-4",
                    "is_latest": True,
                    "is_delete_marker": False,
                    "last_modified": "2026-08-31T12:00:00Z",
                    "size_bytes": 2048,
                    "etag": '"etag-value"',
                    "storage_class": "STANDARD",
                }
            ],
            "truncated": False,
            "next_cursor": None,
        }


def test_command_is_identity_only_bounded_and_rejects_navigation() -> None:
    parsed = parse_command(event())
    assert parsed == command()
    for invalid in (
        event(prefix="../"),
        event(limit=101),
        event(cursor="not+base64"),
        {**event(), "bucket": "must-not-cross-the-boundary"},
    ):
        with pytest.raises(RepositoryBrowserCommandInvalid):
            parse_command(invalid)

    assert parse_object_command(object_event()) == RepositoryObjectInspectionCommand(
        ORG_ID, OWNER_ID, CONNECTION_ID, "ma/roads.geojson"
    )
    for invalid in (
        object_event(relative_path="../private"),
        object_event(relative_path="ma/"),
        {**object_event(), "bucket": "must-not-cross-the-boundary"},
    ):
        with pytest.raises(RepositoryBrowserCommandInvalid):
            parse_object_command(invalid)

    assert parse_object_versions_command(versions_event()) == RepositoryObjectVersionsCommand(
        ORG_ID, OWNER_ID, CONNECTION_ID, "ma/roads.geojson", None, 25
    )
    assert parse_object_version_command(
        version_event()
    ) == RepositoryObjectVersionInspectionCommand(
        ORG_ID, OWNER_ID, CONNECTION_ID, "ma/roads.geojson", "version-3"
    )
    for invalid, parser in (
        (versions_event(relative_path="../private"), parse_object_versions_command),
        (versions_event(limit=101), parse_object_versions_command),
        (version_event(version_id="line\nbreak"), parse_object_version_command),
    ):
        with pytest.raises(RepositoryBrowserCommandInvalid):
            parser(invalid)


def test_database_resolver_requires_one_exact_verified_owner_target() -> None:
    row = (
        ORG_ID,
        OWNER_ID,
        CONNECTION_ID,
        3,
        2,
        "example-geodata",
        "us-east-1",
        "usa/",
        "assume_role",
        "arn:aws:iam::111111111111:role/opengeo/OpenGeoDatasetReader",
        target().secret_reference,
    )
    data_api = DataApi((row,))
    resolved = asyncio.run(RdsDataRepositoryTargetResolver(data_api).resolve(command()))
    assert resolved == target()
    assert data_api.calls[0][1] == (ORG_ID, OWNER_ID, CONNECTION_ID)
    with pytest.raises(RepositoryBrowserAccessDenied):
        asyncio.run(RdsDataRepositoryTargetResolver(DataApi(())).resolve(command()))


def test_s3_listing_returns_relative_metadata_and_opaque_cursor_only() -> None:
    xml = b"""<?xml version="1.0" encoding="UTF-8"?>
    <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
      <Name>example-geodata</Name><Prefix>usa%2Fma%2F</Prefix><KeyCount>2</KeyCount><MaxKeys>25</MaxKeys>
      <IsTruncated>true</IsTruncated>
      <Contents><Key>usa/ma/roads.geojson</Key><LastModified>2026-08-30T12:00:00Z</LastModified><Size>2048</Size><StorageClass>STANDARD</StorageClass></Contents>
      <CommonPrefixes><Prefix>usa/ma/aerial/</Prefix></CommonPrefixes>
      <NextContinuationToken>provider-token-secret-shape</NextContinuationToken>
    </ListBucketResult>"""
    transport = Transport((200, {}, xml))
    page = asyncio.run(
        S3RepositoryLister(transport=transport, now=lambda: NOW).list(
            ASSUMED_CREDENTIALS, target(), "ma/", None, 25
        )
    )
    assert page["prefix"] == "ma/"
    assert page["parent_prefix"] == ""
    assert [entry["relative_path"] for entry in page["entries"]] == [
        "ma/roads.geojson",
        "ma/aerial/",
    ]
    assert page["entries"][0]["size_bytes"] == 2048
    assert page["entries"][0]["version_id"] is None
    assert page["next_cursor"] != "provider-token-secret-shape"
    assert _decode_cursor(page["next_cursor"]) == "provider-token-secret-shape"
    assert "prefix=usa%2Fma%2F" in transport.calls[0][1]
    assert "max-keys=25" in transport.calls[0][1]


def test_s3_object_inspection_returns_current_metadata_without_a_body() -> None:
    transport = Transport(
        (
            200,
            {
                "Content-Length": "2048",
                "Last-Modified": "Sun, 31 Aug 2026 12:00:00 GMT",
                "Content-Type": "application/geo+json",
                "ETag": '"etag-value"',
                "x-amz-storage-class": "STANDARD",
                "x-amz-version-id": "version-4",
                "x-amz-checksum-sha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            },
            b"",
        )
    )
    record = asyncio.run(
        S3RepositoryLister(transport=transport, now=lambda: NOW).inspect(
            ASSUMED_CREDENTIALS, target(), "ma/roads.geojson"
        )
    )
    assert record == {
        "relative_path": "ma/roads.geojson",
        "name": "roads.geojson",
        "size_bytes": 2048,
        "last_modified": "2026-08-31T12:00:00Z",
        "content_type": "application/geo+json",
        "etag": '"etag-value"',
        "storage_class": "STANDARD",
        "version_id": "version-4",
        "checksum_sha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    }
    assert transport.calls[0][0] == "HEAD"
    assert transport.calls[0][1].endswith("/example-geodata/usa/ma/roads.geojson")
    assert transport.calls[0][3] == b""
    assert transport.calls[0][5] == 0

    missing = S3RepositoryLister(transport=Transport((404, {}, b"")), now=lambda: NOW)
    with pytest.raises(RepositoryObjectNotFound):
        asyncio.run(missing.inspect(ASSUMED_CREDENTIALS, target(), "ma/missing.geojson"))


def test_s3_object_versions_are_exact_bounded_and_use_opaque_pagination() -> None:
    xml = b"""<?xml version="1.0" encoding="UTF-8"?>
    <ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
      <Name>example-geodata</Name><Prefix>usa%2Fma%2Froads.geojson</Prefix>
      <MaxKeys>25</MaxKeys><IsTruncated>true</IsTruncated>
      <Version><Key>usa/ma/roads.geojson</Key><VersionId>version-4</VersionId>
        <IsLatest>true</IsLatest><LastModified>2026-08-31T12:00:00Z</LastModified>
        <ETag>&quot;etag-4&quot;</ETag><Size>2048</Size><StorageClass>STANDARD</StorageClass>
      </Version>
      <DeleteMarker><Key>usa/ma/roads.geojson</Key><VersionId>delete-3</VersionId>
        <IsLatest>false</IsLatest><LastModified>2026-08-30T12:00:00Z</LastModified>
      </DeleteMarker>
      <Version><Key>usa/ma/roads.geojson.bak</Key><VersionId>sibling</VersionId>
        <IsLatest>true</IsLatest><LastModified>2026-08-29T12:00:00Z</LastModified>
        <ETag>&quot;sibling&quot;</ETag><Size>10</Size><StorageClass>STANDARD</StorageClass>
      </Version>
      <NextKeyMarker>usa/ma/roads.geojson</NextKeyMarker>
      <NextVersionIdMarker>delete-3</NextVersionIdMarker>
    </ListVersionsResult>"""
    transport = Transport((200, {}, xml))
    page = asyncio.run(
        S3RepositoryLister(transport=transport, now=lambda: NOW).versions(
            ASSUMED_CREDENTIALS, target(), "ma/roads.geojson", None, 25
        )
    )
    assert [entry["version_id"] for entry in page["entries"]] == ["version-4", "delete-3"]
    assert page["entries"][1]["is_delete_marker"] is True
    assert page["entries"][1]["size_bytes"] is None
    assert page["truncated"] is True
    assert (
        _decode_version_cursor(page["next_cursor"], f"{CONNECTION_ID}/ma/roads.geojson")
        == "delete-3"
    )
    assert "prefix=usa%2Fma%2Froads.geojson" in transport.calls[0][1]
    assert "versions=" in transport.calls[0][1]
    assert "sibling" not in json.dumps(page)

    with pytest.raises(RepositoryBrowserCommandInvalid):
        _decode_version_cursor(page["next_cursor"], f"{CONNECTION_ID}/ma/other.geojson")


def test_pre_versioning_null_version_remains_exactly_selectable() -> None:
    assert parse_object_version_command(version_event(version_id="null")).version_id == "null"
    response = (
        200,
        {
            "Content-Length": "12",
            "Last-Modified": "Sat, 30 Aug 2026 12:00:00 GMT",
            "ETag": '"pre-versioning"',
            "x-amz-version-id": "null",
        },
        b"",
    )
    record = asyncio.run(
        S3RepositoryLister(transport=Transport(response), now=lambda: NOW).inspect(
            ASSUMED_CREDENTIALS, target(), "ma/roads.geojson", "null"
        )
    )
    assert record["version_id"] == "null"


def test_exact_s3_object_version_is_pinned_and_identity_checked() -> None:
    response = (
        200,
        {
            "Content-Length": "1024",
            "Last-Modified": "Sat, 30 Aug 2026 12:00:00 GMT",
            "Content-Type": "application/geo+json",
            "ETag": '"etag-3"',
            "x-amz-version-id": "version-3",
        },
        b"",
    )
    transport = Transport(response)
    record = asyncio.run(
        S3RepositoryLister(transport=transport, now=lambda: NOW).inspect(
            ASSUMED_CREDENTIALS, target(), "ma/roads.geojson", "version-3"
        )
    )
    assert record["version_id"] == "version-3"
    assert transport.calls[0][1].endswith("?versionId=version-3")
    mismatched = S3RepositoryLister(
        transport=Transport((200, {**response[1], "x-amz-version-id": "version-4"}, b"")),
        now=lambda: NOW,
    )
    with pytest.raises(RepositoryBrowserUnavailable, match="version identity changed"):
        asyncio.run(
            mismatched.inspect(ASSUMED_CREDENTIALS, target(), "ma/roads.geojson", "version-3")
        )


def test_processor_resolves_credentials_without_returning_authority() -> None:
    roles = RoleAssumer()
    processor = RepositoryBrowserProcessor(
        Resolver(), SecretLoader(), roles, Credentials(), Lister()
    )
    page = asyncio.run(processor.browse(command()))
    assert page["prefix"] == "ma/"
    assert roles.calls == [(target().role_arn, "scoped-external-id")]
    assert "external" not in json.dumps(page)
    inspected = asyncio.run(
        processor.inspect(
            RepositoryObjectInspectionCommand(ORG_ID, OWNER_ID, CONNECTION_ID, "ma/roads.geojson")
        )
    )
    assert inspected["version_id"] == "version-4"
    versions = asyncio.run(
        processor.versions(
            RepositoryObjectVersionsCommand(
                ORG_ID, OWNER_ID, CONNECTION_ID, "ma/roads.geojson", None, 25
            )
        )
    )
    assert versions["entries"][0]["version_id"] == "version-4"
    exact = asyncio.run(
        processor.inspect_version(
            RepositoryObjectVersionInspectionCommand(
                ORG_ID, OWNER_ID, CONNECTION_ID, "ma/roads.geojson", "version-3"
            )
        )
    )
    assert exact["version_id"] == "version-3"


def test_handler_sanitizes_denial_and_unexpected_runtime_failures() -> None:
    class DeniedProcessor:
        async def browse(self, browser_command):
            del browser_command
            raise RepositoryBrowserAccessDenied("credential=value")

    denied = asyncio.run(handle_event(event(), DeniedProcessor()))
    assert denied == {
        "schema": "opengeo.dataset-repository-browser.response.v1",
        "ok": False,
        "error": "access_denied",
    }
    assert "credential" not in json.dumps(denied)


def test_handler_routes_version_history_and_exact_version_without_authority() -> None:
    processor = RepositoryBrowserProcessor(
        Resolver(), SecretLoader(), RoleAssumer(), Credentials(), Lister()
    )
    versions = asyncio.run(handle_event(versions_event(), processor))
    exact = asyncio.run(handle_event(version_event(), processor))
    assert versions["schema"] == "opengeo.dataset-repository-object-versions.response.v1"
    assert versions["ok"] is True
    assert versions["page"]["entries"][0]["version_id"] == "version-4"
    assert exact["schema"] == "opengeo.dataset-repository-object.response.v1"
    assert exact["object"]["version_id"] == "version-3"
    assert "role_arn" not in json.dumps({"versions": versions, "exact": exact})


def test_api_lambda_adapter_signs_exact_function_and_decodes_page() -> None:
    response = {
        "schema": "opengeo.dataset-repository-browser.response.v1",
        "ok": True,
        "page": {
            "prefix": "",
            "parent_prefix": None,
            "entries": [],
            "truncated": False,
            "next_cursor": None,
        },
    }
    transport = Transport((200, {}, json.dumps(response).encode()))
    settings = type(
        "Settings",
        (),
        {
            "user_dataset_repository_browser_configured": True,
            "aws_region": "us-east-1",
            "user_dataset_repository_browser_function_name": (
                "opengeo-dev-user-dataset-repository-browser"
            ),
        },
    )()
    browser = AwsLambdaUserDatasetRepositoryBrowser(
        settings, credentials=Credentials(), transport=transport, now=lambda: NOW
    )
    envelope = browser._invoke(
        event(prefix="", limit=100),
        "opengeo.dataset-repository-browser.response.v1",
    )
    page = browser._decode_page(envelope)
    assert page.prefix == ""
    assert transport.calls[0][0] == "POST"
    assert transport.calls[0][1].endswith(
        "/functions/opengeo-dev-user-dataset-repository-browser/invocations"
    )
    assert "authorization" in transport.calls[0][2]


def test_api_lambda_adapter_maps_only_sanitized_errors() -> None:
    denied = Transport(
        (
            200,
            {},
            json.dumps(
                {
                    "schema": "opengeo.dataset-repository-browser.response.v1",
                    "ok": False,
                    "error": "access_denied",
                }
            ).encode(),
        )
    )
    browser = AwsLambdaUserDatasetRepositoryBrowser(
        type(
            "Settings",
            (),
            {
                "user_dataset_repository_browser_configured": True,
                "aws_region": "us-east-1",
                "user_dataset_repository_browser_function_name": "exact-browser",
            },
        )(),
        credentials=Credentials(),
        transport=denied,
        now=lambda: NOW,
    )
    with pytest.raises(DatasetRepositoryAccessDenied):
        browser._invoke(event(), "opengeo.dataset-repository-browser.response.v1")

    denied.response = (
        200,
        {},
        json.dumps(
            {
                "schema": "opengeo.dataset-repository-object.response.v1",
                "ok": False,
                "error": "not_found",
            }
        ).encode(),
    )
    with pytest.raises(DatasetRepositoryObjectNotFound):
        browser._invoke(object_event(), "opengeo.dataset-repository-object.response.v1")

    denied.response = (
        200,
        {},
        json.dumps(
            {
                "schema": "opengeo.dataset-repository-browser.response.v1",
                "ok": False,
                "error": "access_denied",
                "detail": "must-not-cross-the-boundary",
            }
        ).encode(),
    )
    with pytest.raises(DatasetRepositoryResponseInvalid):
        browser._invoke(event(), "opengeo.dataset-repository-browser.response.v1")
