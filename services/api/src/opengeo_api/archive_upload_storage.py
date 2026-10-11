"""Exact private archive transfers. Callers must persist intent before mutations.

No retries: lost create/complete responses require durable reconciliation. Ordinary
browser traffic uploads to signed S3 URLs, never through the application server.
"""

import base64
import hashlib
import hmac
import re
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, TypedDict
from urllib.parse import quote
from xml.etree import ElementTree as ET

from opengeo_api.framework_publication_aws import PublicationAws
from opengeo_api.s3_endpoints import object_path, regional_s3_host

PART_BYTES = 64 * 1024 * 1024
MAX_PARTS = 10_000


class ArchiveStorageError(RuntimeError):
    pass


def part_size(size: int) -> int:
    if type(size) is not int or not 0 <= size <= 5 * 1024**4:
        raise ArchiveStorageError("archive_size_invalid")
    # Round up to whole MiB, preserving the 10,000-part S3 ceiling for large files.
    return max(PART_BYTES, ((size + MAX_PARTS - 1) // MAX_PARTS + 1024**2 - 1) // 1024**2 * 1024**2)


def part_length(size: int, number: int) -> int:
    chunk = part_size(size)
    count = (size + chunk - 1) // chunk
    if type(number) is not int or not 1 <= number <= count:
        raise ArchiveStorageError("archive_part_invalid")
    return min(chunk, size - (number - 1) * chunk)


def checksum(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch("[a-f0-9]{64}", value):
        raise ArchiveStorageError("archive_checksum_invalid")
    return base64.b64encode(bytes.fromhex(value)).decode()


def parse_xml(body: bytes, expected: str) -> ET.Element:
    if (
        len(body) > 1_048_576
        or b"\x00" in body
        or b"<!DOCTYPE" in body.upper()
        or b"<!ENTITY" in body.upper()
    ):
        raise ArchiveStorageError("archive_storage_response_invalid")
    try:
        root = ET.fromstring(body)
    except ET.ParseError as error:
        raise ArchiveStorageError("archive_storage_response_invalid") from error
    for element in root.iter():
        element.tag = element.tag.rsplit("}", 1)[-1]
    if root.tag != expected:
        # CompleteMultipartUpload can return an Error body with HTTP 200.
        raise ArchiveStorageError("archive_storage_response_invalid")
    return root


class ArchivePart(TypedDict):
    number: int
    size: int
    sha256: str
    etag: str


class ArchiveS3Storage:
    def __init__(
        self,
        bucket: str,
        prefix: str,
        owner: str,
        *,
        aws: PublicationAws | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        if (
            not re.fullmatch("[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket)
            or not re.fullmatch("[0-9]{12}", owner)
            or not prefix
            or not prefix.endswith("/")
            or prefix.startswith("/")
            or any(p in ("", ".", "..") for p in prefix[:-1].split("/"))
            or re.search(r"[\\\x00-\x1f\x7f]", prefix)
        ):
            raise ArchiveStorageError("archive_destination_invalid")
        self.bucket, self.prefix, self.owner = bucket, prefix, owner
        self.aws = aws or PublicationAws("us-east-1")
        self.now = now or (lambda: datetime.now(UTC))

    def path(self, key: str) -> str:
        if (
            not key.startswith(self.prefix)
            or len(key.encode("utf-8")) > 1024
            or any(p in ("", ".", "..") for p in key.split("/"))
            or re.search(r"[\\\x00-\x1f\x7f]", key)
        ):
            raise ArchiveStorageError("archive_key_outside_destination")
        return f"/{self.bucket}/{key}"

    @staticmethod
    def upload_id(value: object) -> str:
        if (
            not isinstance(value, str)
            or not 1 <= len(value) <= 2048
            or re.search(r"[\x00-\x20\x7f]", value)
        ):
            raise ArchiveStorageError("archive_upload_id_invalid")
        return value

    async def create(self, key: str, sha256: str) -> str:
        checksum(sha256)
        status, _, body = await self.aws.request(
            "s3",
            "POST",
            self.path(key),
            query={"uploads": ""},
            headers={
                "x-amz-expected-bucket-owner": self.owner,
                "x-amz-server-side-encryption": "AES256",
                "x-amz-checksum-algorithm": "SHA256",
                "x-amz-checksum-type": "COMPOSITE",
                "x-amz-meta-sha256": sha256,
                "content-type": "application/octet-stream",
            },
        )
        if status != 200:
            raise ArchiveStorageError("archive_multipart_create_failed")
        root = parse_xml(body, "InitiateMultipartUploadResult")
        if root.findtext("Bucket") != self.bucket or root.findtext("Key") != key:
            raise ArchiveStorageError("archive_storage_scope_mismatch")
        return self.upload_id(root.findtext("UploadId"))

    def sign_part(
        self, key: str, upload_id: str, size: int, number: int, sha256: str
    ) -> dict[str, Any]:
        return self._sign(
            key,
            {"uploadId": self.upload_id(upload_id), "partNumber": str(number)},
            {
                "content-length": str(part_length(size, number)),
                "x-amz-checksum-sha256": checksum(sha256),
            },
        )

    def sign_single(self, key: str, size: int, sha256: str) -> dict[str, Any]:
        if type(size) is not int or not 0 <= size <= PART_BYTES:
            raise ArchiveStorageError("archive_single_size_invalid")
        return self._sign(
            key,
            {},
            {
                "content-length": str(size),
                "x-amz-checksum-sha256": checksum(sha256),
                "if-none-match": "*",
                "x-amz-server-side-encryption": "AES256",
                "x-amz-meta-sha256": sha256,
            },
        )

    async def preserve_manifest(self, key: str, body: bytes) -> dict[str, Any]:
        """Preserve one bounded reconstruction record; retry reconciles exact bytes.

        The repository commits the immutable key/hash intent before calling this.
        A timeout propagates, without another PUT. A later deliberate retry first
        checks the existing object. Never replace another object's bytes.
        """
        return await self._preserve_record(key, body, 256 * 1024)

    async def preserve_index(self, key: str, body: bytes) -> dict[str, Any]:
        # At most 4,000 page receipts for a destination's 100,000 originals.
        return await self._preserve_record(key, body, 32 * 1024 * 1024)

    async def _preserve_record(self, key: str, body: bytes, maximum: int) -> dict[str, Any]:
        if not isinstance(body, bytes) or not 1 <= len(body) <= maximum:
            raise ArchiveStorageError("archive_manifest_size_invalid")
        sha256 = hashlib.sha256(body).hexdigest()
        digest = checksum(sha256)
        existing = await self.inspect(key, len(body), sha256, digest)
        if existing:
            return existing
        status, headers, _ = await self.aws.request(
            "s3",
            "PUT",
            self.path(key),
            body=body,
            headers={
                "content-type": "application/json",
                "if-none-match": "*",
                "x-amz-expected-bucket-owner": self.owner,
                "x-amz-server-side-encryption": "AES256",
                "x-amz-meta-sha256": sha256,
                "x-amz-checksum-sha256": digest,
            },
        )
        if status not in {200, 412}:
            raise ArchiveStorageError("archive_manifest_upload_failed")
        version = headers.get("x-amz-version-id") if status == 200 else None
        if status == 200 and (not version or version == "null"):
            raise ArchiveStorageError("archive_version_invalid")
        receipt = await self.inspect(key, len(body), sha256, digest, version_id=version)
        if receipt is None:
            raise ArchiveStorageError("archive_manifest_verification_failed")
        return receipt

    def sign_download(self, key: str, version_id: str) -> dict[str, Any]:
        if (
            not isinstance(version_id, str)
            or not version_id
            or version_id == "null"
            or len(version_id) > 1024
            or re.search(r"[\x00-\x1f\x7f]", version_id)
        ):
            raise ArchiveStorageError("archive_version_invalid")
        return self._sign(key, {"versionId": version_id}, {}, method="GET")

    def _sign(
        self, key: str, query: dict[str, str], headers: dict[str, str], *, method: str = "PUT"
    ) -> dict[str, Any]:
        self.path(key)
        credentials = self.aws.credentials.load()
        stamp = self.now().astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")
        host = regional_s3_host(self.aws.region)
        scope = f"{stamp[:8]}/{self.aws.region}/s3/aws4_request"
        signed = {**headers, "host": host, "x-amz-expected-bucket-owner": self.owner}
        names = ";".join(sorted(signed))
        params = {
            **query,
            "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
            "X-Amz-Credential": f"{credentials.access_key_id}/{scope}",
            "X-Amz-Date": stamp,
            "X-Amz-Expires": "300",
            "X-Amz-SignedHeaders": names,
        }
        if credentials.session_token:
            params["X-Amz-Security-Token"] = credentials.session_token
        encoded = "&".join(
            f"{quote(k, safe='-_.~')}={quote(v, safe='-_.~')}" for k, v in sorted(params.items())
        )
        canonical = "\n".join(
            [
                method,
                object_path(self.bucket, key),
                encoded,
                "".join(f"{k}:{signed[k]}\n" for k in sorted(signed)),
                names,
                "UNSIGNED-PAYLOAD",
            ]
        )
        signing = ("AWS4" + credentials.secret_access_key).encode()
        for value in (stamp[:8], self.aws.region, "s3", "aws4_request"):
            signing = hmac.new(signing, value.encode(), hashlib.sha256).digest()
        signature = hmac.new(
            signing,
            f"AWS4-HMAC-SHA256\n{stamp}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}".encode(),
            hashlib.sha256,
        ).hexdigest()
        return {
            "url": (
                f"https://{host}{object_path(self.bucket, key)}?{encoded}"
                f"&X-Amz-Signature={signature}"
            ),
            "method": method,
            "expires_in": 300,
            # Fetch sets the signed length from the Blob; JS cannot set this header.
            "headers": {k: v for k, v in signed.items() if k not in {"host", "content-length"}},
        }

    async def list_parts(self, key: str, upload_id: str, after: int = 0) -> dict[str, Any]:
        if type(after) is not int or not 0 <= after <= MAX_PARTS:
            raise ArchiveStorageError("archive_part_invalid")
        status, _, body = await self.aws.request(
            "s3",
            "GET",
            self.path(key),
            query={
                "uploadId": self.upload_id(upload_id),
                "part-number-marker": str(after),
                "max-parts": "100",
            },
            headers={"x-amz-expected-bucket-owner": self.owner},
        )
        if status != 200:
            raise ArchiveStorageError("archive_parts_unavailable")
        root = parse_xml(body, "ListPartsResult")
        if (
            root.findtext("Bucket") != self.bucket
            or root.findtext("Key") != key
            or root.findtext("UploadId") != upload_id
        ):
            raise ArchiveStorageError("archive_storage_scope_mismatch")
        parts: list[ArchivePart] = []
        try:
            for item in root.findall("Part"):
                number, size = (
                    int(item.findtext("PartNumber") or ""),
                    int(item.findtext("Size") or ""),
                )
                digest = base64.b64decode(item.findtext("ChecksumSHA256") or "", validate=True)
                etag = item.findtext("ETag")
                if (
                    not after < number <= MAX_PARTS
                    or len(digest) != 32
                    or not etag
                    or len(etag) > 256
                    or not 1 <= size <= 5 * 1024**3
                    or (parts and number <= parts[-1]["number"])
                ):
                    raise ValueError("invalid part")
                parts.append({"number": number, "size": size, "sha256": digest.hex(), "etag": etag})
        except (ValueError, TypeError) as error:
            raise ArchiveStorageError("archive_parts_invalid") from error
        truncated = root.findtext("IsTruncated")
        if (
            len(parts) > 100
            or truncated not in {"true", "false"}
            or (truncated == "true" and not parts)
        ):
            raise ArchiveStorageError("archive_parts_invalid")
        return {"parts": parts, "next_after": parts[-1]["number"] if truncated == "true" else None}

    async def complete(
        self, key: str, upload_id: str, size: int, parts: list[dict[str, Any]]
    ) -> dict[str, Any]:
        chunk = part_size(size)
        if not parts or len(parts) != (size + chunk - 1) // chunk:
            raise ArchiveStorageError("archive_parts_incomplete")
        root = ET.Element(
            "CompleteMultipartUpload", xmlns="http://s3.amazonaws.com/doc/2006-03-01/"
        )
        digests = []
        for number, part in enumerate(parts, 1):
            if (
                part["number"] != number
                or part["size"] != part_length(size, number)
                or not isinstance(part["etag"], str)
                or not 1 <= len(part["etag"]) <= 256
            ):
                raise ArchiveStorageError("archive_parts_invalid")
            digest = checksum(part["sha256"])
            digests.append(bytes.fromhex(part["sha256"]))
            node = ET.SubElement(root, "Part")
            for tag, value in [
                ("PartNumber", str(number)),
                ("ETag", part["etag"]),
                ("ChecksumSHA256", digest),
            ]:
                ET.SubElement(node, tag).text = value
        composite = (
            base64.b64encode(hashlib.sha256(b"".join(digests)).digest()).decode() + f"-{len(parts)}"
        )
        status, headers, body = await self.aws.request(
            "s3",
            "POST",
            self.path(key),
            query={"uploadId": self.upload_id(upload_id)},
            body=ET.tostring(root, encoding="utf-8"),
            headers={
                "x-amz-expected-bucket-owner": self.owner,
                "if-none-match": "*",
                "content-type": "application/xml",
                "x-amz-mp-object-size": str(size),
            },
        )
        if status != 200:
            raise ArchiveStorageError("archive_completion_unresolved")
        result = parse_xml(body, "CompleteMultipartUploadResult")
        version = headers.get("x-amz-version-id")
        if (
            result.findtext("Bucket") != self.bucket
            or result.findtext("Key") != key
            or result.findtext("ChecksumSHA256") != composite
            or not version
            or version == "null"
        ):
            raise ArchiveStorageError("archive_completion_unresolved")
        return {"version_id": version, "storage_checksum_sha256": composite, "size_bytes": size}

    async def abort(self, key: str, upload_id: str) -> None:
        status, _, _ = await self.aws.request(
            "s3",
            "DELETE",
            self.path(key),
            query={"uploadId": self.upload_id(upload_id)},
            headers={"x-amz-expected-bucket-owner": self.owner},
        )
        if status not in {204, 404}:
            raise ArchiveStorageError("archive_abort_unresolved")

    async def inspect(
        self, key: str, size: int, sha256: str, storage_checksum: str, version_id: str | None = None
    ) -> dict[str, Any] | None:
        part_size(size)
        checksum(sha256)
        if not re.fullmatch(r"[A-Za-z0-9+/]{43}=(-[1-9][0-9]{0,4})?", storage_checksum):
            raise ArchiveStorageError("archive_checksum_invalid")
        if version_id is not None and (
            not version_id or version_id == "null" or len(version_id) > 1024
        ):
            raise ArchiveStorageError("archive_version_invalid")
        status, headers, _ = await self.aws.request(
            "s3",
            "HEAD",
            self.path(key),
            query={"versionId": version_id} if version_id else {},
            headers={"x-amz-expected-bucket-owner": self.owner, "x-amz-checksum-mode": "ENABLED"},
        )
        if status == 404:
            return None
        if status == 403 and version_id is None and await self._current_object_absent(key):
            return None
        if status != 200:
            raise ArchiveStorageError("archive_verification_unavailable")
        version = headers.get("x-amz-version-id")
        if (
            not version
            or version == "null"
            or (version_id and version != version_id)
            or headers.get("content-length") != str(size)
            or headers.get("x-amz-meta-sha256") != sha256
            or headers.get("x-amz-checksum-sha256") != storage_checksum
            or headers.get("x-amz-server-side-encryption") != "AES256"
        ):
            raise ArchiveStorageError("archive_verification_failed")
        return {
            "bucket": self.bucket,
            "key": key,
            "version_id": version,
            "size_bytes": size,
            "sha256": sha256,
            "storage_checksum_sha256": storage_checksum,
        }

    async def _current_object_absent(self, key: str) -> bool:
        """Resolve an ambiguous HEAD through one exact-prefix, one-key lookup.

        HEAD can return 403 for a missing object when bucket-wide listing is not
        granted. A separately authorized empty lookup proves absence; a denial,
        unreadable existing object or ambiguous response never does. Versioned
        reads never use this path. The subsequent PUT remains conditional.
        """
        self.path(key)
        status, _, body = await self.aws.request(
            "s3",
            "GET",
            f"/{self.bucket}",
            query={"list-type": "2", "prefix": key, "max-keys": "1"},
            headers={"x-amz-expected-bucket-owner": self.owner},
        )
        if status != 200:
            raise ArchiveStorageError("archive_verification_unavailable")
        root = parse_xml(body, "ListBucketResult")
        if (
            root.findtext("Name") != self.bucket
            or root.findtext("Prefix") != key
            or root.findtext("MaxKeys") != "1"
            or root.findtext("IsTruncated") != "false"
            or root.findtext("KeyCount") != "0"
            or root.findall("Contents")
            or root.findall("CommonPrefixes")
        ):
            raise ArchiveStorageError("archive_verification_unavailable")
        return True

    async def find_uploads(self, key: str) -> list[str]:
        self.path(key)
        status, _, body = await self.aws.request(
            "s3",
            "GET",
            f"/{self.bucket}",
            query={"uploads": "", "prefix": key, "max-uploads": "2"},
            headers={"x-amz-expected-bucket-owner": self.owner},
        )
        if status != 200:
            raise ArchiveStorageError("archive_upload_inventory_unavailable")
        root = parse_xml(body, "ListMultipartUploadsResult")
        if (
            root.findtext("Bucket") != self.bucket
            or root.findtext("Prefix") != key
            or root.findtext("IsTruncated") != "false"
        ):
            raise ArchiveStorageError("archive_upload_inventory_ambiguous")
        uploads = []
        for item in root.findall("Upload"):
            # Prefix filtering may include a different longer key; never adopt it.
            if item.findtext("Key") == key:
                uploads.append(self.upload_id(item.findtext("UploadId")))
        if len(uploads) > 1:
            raise ArchiveStorageError("archive_upload_inventory_ambiguous")
        return uploads

    async def upload_absent(self, key: str, upload_id: str) -> bool:
        status, _, body = await self.aws.request(
            "s3",
            "GET",
            self.path(key),
            query={"uploadId": self.upload_id(upload_id), "max-parts": "1"},
            headers={"x-amz-expected-bucket-owner": self.owner},
        )
        if status == 404:
            root = parse_xml(body, "Error")
            if root.findtext("Code") == "NoSuchUpload":
                return True
        if status == 200:
            root = parse_xml(body, "ListPartsResult")
            if (
                root.findtext("Bucket") == self.bucket
                and root.findtext("Key") == key
                and root.findtext("UploadId") == upload_id
            ):
                return False
        raise ArchiveStorageError("archive_abort_verification_unavailable")
