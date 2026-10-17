import asyncio
import base64
import hashlib
from datetime import UTC, datetime
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import pytest

from opengeo_api.archive_upload_storage import (
    PART_BYTES,
    ArchiveS3Storage,
    ArchiveStorageError,
    checksum,
    part_length,
    part_size,
)

SHA = "a" * 64
KEY = "bhutan/private/uploads/test/originals/a file.json"


class Aws:
    region = "us-east-1"
    credentials = SimpleNamespace(
        load=lambda: SimpleNamespace(
            access_key_id="test", secret_access_key="not-a-real-secret", session_token="session"
        )
    )

    def __init__(self, result=None):
        self.result = result
        self.calls = []

    async def request(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return self.result


def storage(aws=None):
    return ArchiveS3Storage(
        "example-geodata",
        "bhutan/private/",
        "111111111111",
        aws=aws or Aws(),
        now=lambda: datetime(2026, 9, 20, tzinfo=UTC),
    )


def test_part_layout_handles_originals_over_five_gb_and_s3_part_limit():
    for size in [1, PART_BYTES, PART_BYTES + 1, 9_487_000_000, 5 * 1024**4]:
        chunk = part_size(size)
        count = (size + chunk - 1) // chunk
        assert count <= 10_000
        assert sum(part_length(size, number) for number in range(1, count + 1)) == size
    with pytest.raises(ArchiveStorageError):
        part_length(0, 1)


def test_part_signature_binds_checksum_size_owner_and_upload_identity():
    value = storage().sign_part(KEY, "upload+id=", PART_BYTES + 3, 2, SHA)
    url = urlsplit(value["url"])
    query = parse_qs(url.query)
    assert url.hostname == "s3.us-east-1.amazonaws.com"
    assert "%20" in url.path
    assert query["partNumber"] == ["2"]
    assert query["uploadId"] == ["upload+id="]
    assert query["X-Amz-Expires"] == ["300"]
    # Independently generated with botocore S3SigV4QueryAuth 1.43.34,
    # the same synthetic credentials, fixed clock and exact request.
    assert query["X-Amz-Signature"] == [
        "3c327cf8f2a4638b199d8464039d9553194a29c1bdd2e73d2605916f55d5ce27"
    ]
    assert "content-length" in query["X-Amz-SignedHeaders"][0]
    assert value["headers"]["x-amz-checksum-sha256"] == checksum(SHA)
    assert value["headers"]["x-amz-expected-bucket-owner"] == "111111111111"
    assert "content-length" not in value["headers"]
    assert storage().sign_part(KEY, "upload+id=", PART_BYTES + 4, 2, SHA)["url"] != value["url"]


def test_zero_byte_single_upload_is_conditional_and_checksum_bound():
    sha = hashlib.sha256(b"").hexdigest()
    value = storage().sign_single(KEY, 0, sha)
    assert value["headers"]["if-none-match"] == "*"
    assert value["headers"]["x-amz-checksum-sha256"] == checksum(sha)


@pytest.mark.parametrize("key", ["bhutan/private2/a", "bhutan/private/../a", "bhutan/private/a\\b"])
def test_boundary_cannot_escape(key):
    with pytest.raises(ArchiveStorageError):
        storage().sign_single(key, 1, SHA)


def test_create_retains_upload_id_without_automatic_retry():
    body = (
        f"<InitiateMultipartUploadResult><Bucket>example-geodata</Bucket>"
        f"<Key>{KEY}</Key><UploadId>abc</UploadId></InitiateMultipartUploadResult>"
    ).encode()
    aws = Aws((200, {}, body))
    assert asyncio.run(storage(aws).create(KEY, SHA)) == "abc"
    assert len(aws.calls) == 1
    assert aws.calls[0][1]["headers"]["x-amz-checksum-type"] == "COMPOSITE"


def test_http_200_error_is_not_successful_completion():
    aws = Aws((200, {}, b"<Error><Code>InternalError</Code></Error>"))
    with pytest.raises(ArchiveStorageError):
        asyncio.run(
            storage(aws).complete(
                KEY, "abc", 1, [{"number": 1, "size": 1, "sha256": SHA, "etag": "etag"}]
            )
        )
    assert aws.calls[0][1]["headers"]["if-none-match"] == "*"


def test_completion_checks_composite_checksum_and_exact_version():
    composite = base64.b64encode(hashlib.sha256(bytes.fromhex(SHA)).digest()).decode() + "-1"
    body = (
        f"<CompleteMultipartUploadResult><Bucket>example-geodata</Bucket>"
        f"<Key>{KEY}</Key><ChecksumSHA256>{composite}</ChecksumSHA256>"
        "</CompleteMultipartUploadResult>"
    ).encode()
    aws = Aws((200, {"x-amz-version-id": "immutable-version"}, body))
    result = asyncio.run(
        storage(aws).complete(
            KEY, "abc", 1, [{"number": 1, "size": 1, "sha256": SHA, "etag": "etag"}]
        )
    )
    assert result["version_id"] == "immutable-version"
    assert result["storage_checksum_sha256"] == composite


def test_lost_completion_reconciles_by_head_without_writing_again():
    aws = Aws(
        (
            200,
            {
                "x-amz-version-id": "version",
                "content-length": "1",
                "x-amz-meta-sha256": SHA,
                "x-amz-checksum-sha256": checksum(SHA),
                "x-amz-server-side-encryption": "AES256",
            },
            b"",
        )
    )
    result = asyncio.run(storage(aws).inspect(KEY, 1, SHA, checksum(SHA), "version"))
    assert result["version_id"] == "version"
    assert aws.calls[0][0][1] == "HEAD"
    assert aws.calls[0][1]["query"] == {"versionId": "version"}
    aws.result[1]["content-length"] = "2"
    with pytest.raises(ArchiveStorageError, match="archive_verification_failed"):
        asyncio.run(storage(aws).inspect(KEY, 1, SHA, checksum(SHA)))


def test_list_parts_rejects_duplicate_ids_and_xml_entities():
    part = (
        "<Part><PartNumber>1</PartNumber><Size>1</Size><ETag>etag</ETag>"
        f"<ChecksumSHA256>{checksum(SHA)}</ChecksumSHA256></Part>"
    )
    body = (
        f"<ListPartsResult><Bucket>example-geodata</Bucket>"
        f"<Key>{KEY}</Key><UploadId>abc</UploadId>"
        f"<IsTruncated>false</IsTruncated>{part}{part}</ListPartsResult>"
    ).encode()
    with pytest.raises(ArchiveStorageError):
        asyncio.run(storage(Aws((200, {}, body))).list_parts(KEY, "abc"))
    with pytest.raises(ArchiveStorageError):
        asyncio.run(
            storage(Aws((200, {}, b"<!DOCTYPE a><ListPartsResult/>"))).list_parts(KEY, "abc")
        )


def test_reconcile_matches_exact_key_and_rejects_ambiguous_listing():
    def body(uploads, truncated="false"):
        return (
            f"<ListMultipartUploadsResult><Bucket>example-geodata</Bucket><Prefix>{KEY}</Prefix>"
            f"<IsTruncated>{truncated}</IsTruncated>{uploads}</ListMultipartUploadsResult>"
        ).encode()

    exact = f"<Upload><Key>{KEY}</Key><UploadId>original</UploadId></Upload>"
    other = f"<Upload><Key>{KEY}.other</Key><UploadId>unrelated</UploadId></Upload>"
    assert asyncio.run(storage(Aws((200, {}, body(exact + other)))).find_uploads(KEY)) == [
        "original"
    ]
    for response in [body(exact + exact), body(exact, "true")]:
        with pytest.raises(ArchiveStorageError, match="archive_upload_inventory_ambiguous"):
            asyncio.run(storage(Aws((200, {}, response))).find_uploads(KEY))


def test_abort_verification_requires_explicit_no_such_upload():
    response = b"<Error><Code>NoSuchUpload</Code></Error>"
    assert asyncio.run(storage(Aws((404, {}, response))).upload_absent(KEY, "original"))
    with pytest.raises(ArchiveStorageError):
        asyncio.run(
            storage(Aws((404, {}, b"<Error><Code>NoSuchBucket</Code></Error>"))).upload_absent(
                KEY, "original"
            )
        )


def test_manifest_put_is_conditional_and_reconciles_lost_response():
    body = b'{"schema":"fixture"}'
    digest = hashlib.sha256(body).hexdigest()
    headers = {
        "x-amz-version-id": "manifest-v1",
        "content-length": str(len(body)),
        "x-amz-meta-sha256": digest,
        "x-amz-checksum-sha256": checksum(digest),
        "x-amz-server-side-encryption": "AES256",
    }

    class Lost(Aws):
        stored = False

        async def request(self, service, method, path, **kwargs):
            self.calls.append((method, kwargs))
            if method == "HEAD":
                return (200, headers, b"") if self.stored else (404, {}, b"")
            assert method == "PUT" and kwargs["body"] == body
            assert kwargs["headers"]["if-none-match"] == "*"
            assert kwargs["headers"]["x-amz-checksum-sha256"] == checksum(digest)
            self.stored = True
            raise TimeoutError("lost successful PUT response")

    aws = Lost()
    with pytest.raises(TimeoutError):
        asyncio.run(storage(aws).preserve_manifest(KEY, body))
    receipt = asyncio.run(storage(aws).preserve_manifest(KEY, body))
    assert receipt["version_id"] == "manifest-v1"
    assert [method for method, _ in aws.calls] == ["HEAD", "PUT", "HEAD"]


def test_manifest_put_verifies_exact_returned_version():
    body = b"{}"
    digest = hashlib.sha256(body).hexdigest()

    class Created(Aws):
        async def request(self, service, method, path, **kwargs):
            self.calls.append((method, kwargs))
            if len(self.calls) == 1:
                return 404, {}, b""
            if method == "PUT":
                return 200, {"x-amz-version-id": "exact"}, b""
            assert kwargs["query"] == {"versionId": "exact"}
            return (
                200,
                {
                    "x-amz-version-id": "exact",
                    "content-length": "2",
                    "x-amz-meta-sha256": digest,
                    "x-amz-checksum-sha256": checksum(digest),
                    "x-amz-server-side-encryption": "AES256",
                },
                b"",
            )

    aws = Created()
    assert asyncio.run(storage(aws).preserve_manifest(KEY, body))["sha256"] == digest
    assert [method for method, _ in aws.calls] == ["HEAD", "PUT", "HEAD"]
    with pytest.raises(ArchiveStorageError):
        asyncio.run(storage(aws).preserve_manifest(KEY, b"x" * (256 * 1024 + 1)))


def test_restore_ticket_binds_exact_version_and_never_reads_storage():
    aws = Aws()
    ticket = storage(aws).sign_download(KEY, "version+1/=")
    query = parse_qs(urlsplit(ticket["url"]).query)
    assert ticket["method"] == "GET"
    assert query["versionId"] == ["version+1/="]
    assert query["X-Amz-SignedHeaders"] == ["host;x-amz-expected-bucket-owner"]
    assert not aws.calls
    assert ticket["url"] != storage(aws).sign_download(KEY, "other-version")["url"]
    with pytest.raises(ArchiveStorageError):
        storage(aws).sign_download(KEY, "null")


class HeadDeniedLookup(Aws):
    def __init__(self, lookup):
        super().__init__()
        self.lookup = lookup

    async def request(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return (403, {}, b"") if args[1] == "HEAD" else self.lookup


def empty_current_lookup(**overrides):
    fields = {
        "Name": "example-geodata",
        "Prefix": KEY,
        "MaxKeys": "1",
        "KeyCount": "0",
        "IsTruncated": "false",
    }
    fields.update(overrides)
    return (
        "<ListBucketResult>"
        + "".join(f"<{name}>{value}</{name}>" for name, value in fields.items())
        + "</ListBucketResult>"
    ).encode()


def test_missing_current_object_can_use_exact_prefix_lookup_without_bucket_wide_listing():
    aws = HeadDeniedLookup((200, {}, empty_current_lookup()))
    assert asyncio.run(storage(aws).inspect(KEY, 1, SHA, checksum(SHA))) is None
    assert len(aws.calls) == 2
    args, options = aws.calls[1]
    assert args == ("s3", "GET", "/example-geodata")
    assert options["query"] == {"list-type": "2", "prefix": KEY, "max-keys": "1"}
    assert options["headers"] == {"x-amz-expected-bucket-owner": "111111111111"}
    assert storage().sign_single(KEY, 1, SHA)["headers"]["if-none-match"] == "*"


@pytest.mark.parametrize(
    "lookup",
    [
        (403, {}, b""),
        (200, {}, empty_current_lookup(Name="other-bucket")),
        (200, {}, empty_current_lookup(Prefix="bhutan/private/")),
        (200, {}, empty_current_lookup(MaxKeys="1000")),
        (200, {}, empty_current_lookup(IsTruncated="true")),
        (200, {}, empty_current_lookup(KeyCount="1")),
        (
            200,
            {},
            empty_current_lookup().replace(
                b"</ListBucketResult>",
                f"<Contents><Key>{KEY}</Key></Contents></ListBucketResult>".encode(),
            ),
        ),
        (200, {}, b"<Error><Code>AccessDenied</Code></Error>"),
    ],
)
def test_denied_or_ambiguous_lookup_never_proves_missing_object(lookup):
    aws = HeadDeniedLookup(lookup)
    with pytest.raises(ArchiveStorageError):
        asyncio.run(storage(aws).inspect(KEY, 1, SHA, checksum(SHA)))
    assert len(aws.calls) == 2


def test_denied_exact_version_never_falls_back_to_current_object_listing():
    aws = HeadDeniedLookup((200, {}, empty_current_lookup()))
    with pytest.raises(ArchiveStorageError, match="archive_verification_unavailable"):
        asyncio.run(storage(aws).inspect(KEY, 1, SHA, checksum(SHA), "retained-version"))
    assert len(aws.calls) == 1
