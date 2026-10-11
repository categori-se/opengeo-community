import asyncio
import base64
import hashlib
from xml.etree import ElementTree as ET

import pytest

from opengeo_api.portable_artifact_cleanup_aws import (
    AwsPortableCleanupStorage,
    PortableCleanupUnavailable,
)

ID = "11111111-1111-4111-8111-111111111111"
KEY = f"organizations/{ID}/projects/{ID}/artifacts/{ID}/uploads/{ID}/map.html"
BUCKET = "local.invalid"


class Aws:
    def __init__(self, body):
        self.body = body
        self.calls = []

    async def request(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return 200, {}, self.body


def test_bounded_version_inventory_and_explicit_delete_request():
    aws = Aws(
        f"<ListVersionsResult><Name>{BUCKET}</Name><Prefix>{KEY}</Prefix>"
        f"<IsTruncated>true</IsTruncated><Version><Key>{KEY}</Key><VersionId>v1</VersionId>"
        "</Version></ListVersionsResult>".encode()
    )
    adapter = AwsPortableCleanupStorage("us-east-1", BUCKET, aws=aws)
    page = asyncio.run(adapter.list_exact_versions(BUCKET, KEY, 16))
    assert page.has_more and page.versions[0].version_id == "v1"
    assert aws.calls[0][1]["query"] == {"versions": "", "prefix": KEY, "max-keys": "16"}
    assert aws.calls[0][1]["maximum"] == 65536
    aws.body = (
        f"<DeleteResult><Deleted><Key>{KEY}</Key><VersionId>v1</VersionId></Deleted></DeleteResult>"
    ).encode()
    asyncio.run(adapter.delete_exact_version(BUCKET, KEY, "v1"))
    args, kwargs = aws.calls[-1]
    assert args == ("s3", "POST", f"/{BUCKET}")
    assert kwargs["query"] == {"delete": ""}
    root = ET.fromstring(kwargs["body"])
    assert root.findtext("{*}Object/{*}VersionId") == "v1"
    assert (
        kwargs["headers"]["content-md5"]
        == base64.b64encode(hashlib.md5(kwargs["body"], usedforsecurity=False).digest()).decode()
    )


@pytest.mark.parametrize(
    "body",
    [
        b"<DeleteResult><Error><Code>AccessDenied</Code></Error></DeleteResult>",
        b"<DeleteResult/>",
        '<!DOCTYPE x [<!ENTITY x "bad">]><DeleteResult/>'.encode("utf-16-le"),
        b'<!DOCTYPE x [<!ENTITY x "bad">]><DeleteResult/>',
        b"x" * 65537,
    ],
)
def test_delete_requires_unambiguous_success(body):
    adapter = AwsPortableCleanupStorage("us-east-1", BUCKET, aws=Aws(body))
    with pytest.raises(PortableCleanupUnavailable):
        asyncio.run(adapter.delete_exact_version(BUCKET, KEY, "v1"))


def test_other_bucket_key_and_unversioned_deletion_never_reach_transport():
    aws = Aws(b"")
    adapter = AwsPortableCleanupStorage("us-east-1", BUCKET, aws=aws)
    for bucket, key, version in [
        ("other.invalid", KEY, "v1"),
        (BUCKET, "publication/file.html", "v1"),
        (BUCKET, KEY, "null"),
    ]:
        with pytest.raises(PortableCleanupUnavailable):
            asyncio.run(adapter.delete_exact_version(bucket, key, version))
    assert not aws.calls
