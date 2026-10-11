"""Exact-version portable cleanup using the existing bounded AWS request signer."""

import base64
import hashlib
import re
from typing import Any
from xml.etree import ElementTree as ET

from opengeo_api.framework_publication_aws import PublicationAws
from opengeo_api.portable_artifact_cleanup import UploadObjectVersion, UploadVersionPage

_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_KEY = re.compile(
    rf"organizations/{_UUID}/projects/{_UUID}/artifacts/{_UUID}/uploads/{_UUID}/map\.html"
)


class PortableCleanupUnavailable(RuntimeError):
    pass


def _xml(body: bytes, root_name: str) -> ET.Element:
    if (
        len(body) > 65_536
        or b"\x00" in body
        or b"<!DOCTYPE" in body.upper()
        or b"<!ENTITY" in body.upper()
    ):
        raise PortableCleanupUnavailable("invalid cleanup response")
    try:
        root = ET.fromstring(body)
    except ET.ParseError as error:
        raise PortableCleanupUnavailable("invalid cleanup XML") from error
    for element in root.iter():
        element.tag = element.tag.rsplit("}", 1)[-1]
    if root.tag != root_name:
        raise PortableCleanupUnavailable("unexpected cleanup response")
    return root


class AwsPortableCleanupStorage:
    def __init__(self, region: str, bucket: str, *, aws: Any = None) -> None:
        if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket):
            raise ValueError("invalid Artifact bucket")
        self.bucket = bucket
        self.aws = aws if aws is not None else PublicationAws(region)

    def _boundary(self, bucket: str, key: str) -> None:
        if bucket != self.bucket or not _KEY.fullmatch(key):
            raise PortableCleanupUnavailable("cleanup outside portable upload boundary")

    async def list_exact_versions(self, bucket: str, key: str, limit: int) -> UploadVersionPage:
        self._boundary(bucket, key)
        if type(limit) is not int or not 1 <= limit <= 16:
            raise PortableCleanupUnavailable("cleanup inventory limit invalid")
        status, _, body = await self.aws.request(
            "s3",
            "GET",
            f"/{bucket}",
            query={"versions": "", "prefix": key, "max-keys": str(limit)},
            maximum=65_536,
        )
        if status != 200:
            raise PortableCleanupUnavailable("cleanup inventory unavailable")
        root = _xml(body, "ListVersionsResult")
        if root.findtext("Name") != bucket or root.findtext("Prefix") != key:
            raise PortableCleanupUnavailable("cleanup inventory scope mismatch")
        truncated = root.findtext("IsTruncated")
        if truncated not in {"true", "false"}:
            raise PortableCleanupUnavailable("cleanup inventory truncation missing")
        versions = []
        for entry in root:
            if entry.tag not in {"Version", "DeleteMarker"}:
                continue
            version_id = entry.findtext("VersionId")
            if (
                entry.findtext("Key") != key
                or not version_id
                or version_id == "null"
                or len(version_id) > 1024
            ):
                raise PortableCleanupUnavailable("cleanup inventory identity invalid")
            versions.append(UploadObjectVersion(key, version_id))
        if len(versions) > limit or len({v.version_id for v in versions}) != len(versions):
            raise PortableCleanupUnavailable("cleanup inventory exceeds boundary")
        return UploadVersionPage(tuple(versions), truncated == "true")

    async def delete_exact_version(self, bucket: str, key: str, version_id: str) -> None:
        self._boundary(bucket, key)
        if (
            not isinstance(version_id, str)
            or not 0 < len(version_id) <= 1024
            or version_id == "null"
        ):
            raise PortableCleanupUnavailable("cleanup version invalid")
        root = ET.Element("Delete", xmlns="http://s3.amazonaws.com/doc/2006-03-01/")
        item = ET.SubElement(root, "Object")
        ET.SubElement(item, "Key").text = key
        ET.SubElement(item, "VersionId").text = version_id
        ET.SubElement(root, "Quiet").text = "false"
        body = ET.tostring(root, encoding="utf-8")
        # S3 DeleteObjects requires a transport checksum, not a security digest.
        checksum = base64.b64encode(hashlib.md5(body, usedforsecurity=False).digest()).decode()
        status, _, response = await self.aws.request(
            "s3",
            "POST",
            f"/{bucket}",
            query={"delete": ""},
            headers={"content-type": "application/xml", "content-md5": checksum},
            body=body,
            maximum=65_536,
        )
        if status != 200:
            raise PortableCleanupUnavailable("cleanup delete unavailable")
        result = _xml(response, "DeleteResult")
        deleted = result.findall("Deleted")
        if (
            result.findall("Error")
            or len(deleted) != 1
            or deleted[0].findtext("Key") != key
            or deleted[0].findtext("VersionId") != version_id
        ):
            raise PortableCleanupUnavailable("cleanup version deletion unconfirmed")
