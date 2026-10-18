"""Local adapters for the existing fenced Framework publisher; no cloud delivery.

Private build outputs remain in LocalObjects. Only approved publisher plans copy
bytes into separate immutable public custody; one atomic pointer selects delivery.
"""

import hashlib
import json
import os
import re
import stat
from pathlib import Path
from uuid import UUID, uuid4

from opengeo_api.framework_publication_controller import DataApiPublicationRepository
from opengeo_api.framework_publisher import PublicationConflict, publish_step
from opengeo_api.rds_data import DataApiResult

PUBLIC_BUCKET = "local-publication.invalid"
MAXIMUM_BYTES = 50_000_000
MAXIMUM_FILES = 2048
_PREFIX = re.compile(r"releases/(?:bootstrap|framework-[0-9a-f-]{36})\Z")
_FUNCTIONS = {
    "claim_framework_publication",
    "authorize_framework_publication",
    "seal_framework_publication_plan",
    "checkpoint_framework_publication",
    "activate_framework_publication",
    "complete_framework_publication",
    "release_framework_publication",
}


def _require(condition, code="local_publication_invalid"):
    if not condition:
        raise PublicationConflict(code)


def _digest(body):
    return hashlib.sha256(body).hexdigest()


def _prefix(value):
    _require(isinstance(value, str) and _PREFIX.fullmatch(value))
    if value != "releases/bootstrap":
        _require(
            str(UUID(value.removeprefix("releases/framework-")))
            == value.removeprefix("releases/framework-")
        )
    return value


def _relative(value):
    _require(
        isinstance(value, str)
        and len(value) <= 1024
        and re.fullmatch(
            r"[A-Za-z0-9_@][A-Za-z0-9._@,-]{0,99}(?:/[A-Za-z0-9_@][A-Za-z0-9._@,-]{0,99}){0,15}/?",
            value,
        )
    )
    return value


def _custody(pilot):
    directory = Path(pilot.WORK) / "publication-objects"
    _require(not directory.is_symlink())
    directory.mkdir(mode=0o700, exist_ok=True)
    _require(directory.is_dir())
    return directory


def _read_public(pilot, record):
    _require(record["bucket"] == PUBLIC_BUCKET)
    version = str(UUID(record["version_id"]))
    _require(version == record["version_id"])
    fd = os.open(_custody(pilot) / version, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        details = os.fstat(fd)
        _require(
            stat.S_ISREG(details.st_mode) and 0 <= details.st_size <= MAXIMUM_BYTES
        )
        with os.fdopen(fd, "rb", closefd=False) as source:
            body = source.read(MAXIMUM_BYTES + 1)
    finally:
        os.close(fd)
    _require(
        len(body) == record["size_bytes"]
        and _digest(body) == record["checksum_sha256"],
        "local_publication_checksum_mismatch",
    )
    return body


def _public_records(pilot, prefix):
    _prefix(prefix)
    records = [
        record
        for record in pilot.read_json("publication-objects.json", {}).values()
        if record["bucket"] == PUBLIC_BUCKET and record["key"].startswith(prefix + "/")
    ]
    _require(
        len(records) <= MAXIMUM_FILES
        and sum(record["size_bytes"] for record in records) <= MAXIMUM_BYTES,
        "local_publication_inventory_limit",
    )
    _require(len({record["key"] for record in records}) == len(records))
    return records


class LocalPublicationSqlClient:
    """Run existing security-definer functions as the dedicated local role."""

    async def execute(self, sql, parameters):
        import psycopg

        calls = re.findall(r"app\.([a-z_]+)\(", sql)
        _require(
            sql.startswith("SELECT ")
            and ";" not in sql
            and len(calls) == 1
            and calls[0] in _FUNCTIONS
        )
        with psycopg.connect(
            "postgresql://opengeo_framework_publisher@127.0.0.1/opengeo?sslmode=disable"
        ) as connection:
            cursor = connection.execute(sql, parameters)
            return DataApiResult(
                tuple(tuple(row) for row in cursor.fetchall()), cursor.rowcount
            )


class LocalPublicationStorage:
    private_origin = False

    def __init__(self, pilot):
        _require(pilot.BUCKET != PUBLIC_BUCKET)
        self.pilot = pilot

    async def inventory(self, bucket, prefix, *, previous_release_plan=None):
        del (
            previous_release_plan
        )  # Plain Markdown/asset-tree scope; no localized HTML proofs.
        _require(bucket == PUBLIC_BUCKET)
        records = _public_records(self.pilot, prefix)
        _require(
            records or prefix == "releases/bootstrap",
            "local_publication_previous_release_empty",
        )
        result = []
        for record in records:
            _read_public(self.pilot, record)
            result.append(
                {
                    "path": record["key"][len(prefix) + 1 :],
                    "bucket": PUBLIC_BUCKET,
                    "objectKey": record["key"],
                    "s3VersionId": record["version_id"],
                    "etag": record["etag"],
                    "sizeBytes": record["size_bytes"],
                    "checksumSha256": record["checksum_sha256"],
                    "contentType": record["content_type"],
                    "delivery": record["delivery"],
                }
            )
        return result

    def _source(self, pin):
        bucket, key, version = pin["bucket"], pin["objectKey"], pin["s3VersionId"]
        if bucket == self.pilot.BUCKET:
            _require(
                key.startswith("organizations/")
                and "/builds/" in key
                and "/output/" in key
            )
            record, body = self.pilot.LocalObjects().exact(bucket, key, version)
        elif bucket == PUBLIC_BUCKET:
            record = self.pilot.read_json("publication-objects.json", {})[version]
            _require(record["key"] == key)
            body = _read_public(self.pilot, record)
        else:
            raise PublicationConflict("local_publication_source_bucket_invalid")
        _require(
            len(body) <= 33_554_432
            and len(body) == pin["sizeBytes"]
            and _digest(body) == pin["checksumSha256"]
            and record["content_type"] == pin["contentType"]
            and record["version_id"] == version
            and (not pin.get("etag") or pin["etag"] == record["etag"]),
            "local_publication_source_mismatch",
        )
        return body

    def _content(self, file):
        if file["kind"] == "copy":
            source = file["source"]
            body = self._source(source)
            delivery = dict(
                source.get(
                    "delivery",
                    {
                        "content-type": source["contentType"],
                        "cache-control": "no-cache",
                    },
                )
            )
        elif file["kind"] == "redirect":
            location = file["location"]
            _require(location.startswith("/") and not location.startswith("//"))
            _relative(location.lstrip("/"))
            body = b""
            delivery = {
                "content-type": "text/html",
                "cache-control": "no-cache",
                "x-amz-website-redirect-location": location,
            }
        else:
            raise PublicationConflict("local_publication_operation_invalid")
        return body, delivery

    async def apply(self, bucket, prefix, file):
        _require(bucket == PUBLIC_BUCKET and _prefix(prefix) != "releases/bootstrap")
        path = _relative(file["path"])
        body, delivery = self._content(file)
        key = prefix + "/" + path
        with self.pilot.local_state_lock("publication-public"):
            records = self.pilot.read_json("publication-objects.json", {})
            existing = [record for record in records.values() if record["key"] == key]
            if existing:
                _require(
                    len(existing) == 1
                    and _read_public(self.pilot, existing[0]) == body
                    and existing[0]["delivery"] == delivery,
                    "local_publication_immutable_collision",
                )
                return
            _require(len(body) <= MAXIMUM_BYTES)
            version = str(uuid4())
            with (_custody(self.pilot) / version).open("xb") as output:
                os.fchmod(output.fileno(), 0o600)
                output.write(body)
            records[version] = {
                "bucket": PUBLIC_BUCKET,
                "key": key,
                "version_id": version,
                "etag": hashlib.md5(body, usedforsecurity=False).hexdigest(),
                "size_bytes": len(body),
                "checksum_sha256": _digest(body),
                "content_type": delivery["content-type"],
                "delivery": delivery,
            }
            self.pilot.save_json("publication-objects.json", records)

    async def verify(self, plan):
        _require(plan["bucket"] == PUBLIC_BUCKET)
        prefix = _prefix(plan["targetPrefix"])
        records = _public_records(self.pilot, prefix)
        by_path = {record["key"][len(prefix) + 1 :]: record for record in records}
        _require(
            set(by_path) == {file["path"] for file in plan["files"]},
            "local_publication_inventory_mismatch",
        )
        for file in plan["files"]:
            body, delivery = self._content(file)
            record = by_path[file["path"]]
            _require(
                _read_public(self.pilot, record) == body
                and record["delivery"] == delivery,
                "local_publication_written_mismatch",
            )


def _origin_identity(origin):
    _require(
        origin["bucket"] == PUBLIC_BUCKET
        and origin["hostname"] == "publication.local.invalid"
        and origin["distribution_id"].startswith("LOCAL")
        and origin["origin_id"].startswith("local"),
        "local_publication_origin_invalid",
    )
    return {
        key: origin[key]
        for key in ("bucket", "hostname", "distribution_id", "origin_id")
    }


class LocalPublicationEdge:
    def __init__(self, pilot):
        self.pilot = pilot

    async def prepare(self, origin, previous):
        identity = _origin_identity(origin)
        _prefix(previous)
        with self.pilot.local_state_lock("publication-active"):
            active = self.pilot.read_json("publication-active.json")
            if active is None:
                _require(previous == "releases/bootstrap")
                active = {
                    "origin": identity,
                    "prefix": previous,
                    "generation": 1,
                    "releases": {},
                }
                self.pilot.save_json("publication-active.json", active)
            _require(
                active["origin"] == identity and active["prefix"] == previous,
                "local_publication_pointer_changed",
            )
            return {
                "etag": f"local-{active['generation']}",
                "previousPrefix": previous,
                "fingerprint": _digest(json.dumps(identity, sort_keys=True).encode()),
            }

    async def activate(self, origin, snapshot, target, review):
        identity = _origin_identity(origin)
        _require(target == f"releases/framework-{UUID(str(review))}")
        with self.pilot.local_state_lock("publication-active"):
            active = self.pilot.read_json("publication-active.json")
            _require(
                active is not None
                and active["origin"] == identity
                and snapshot["fingerprint"]
                == _digest(json.dumps(identity, sort_keys=True).encode())
            )
            if active["prefix"] == target:
                _require(active["receipt"]["reviewId"] == str(review))
                return active["receipt"]
            _require(
                active["prefix"] == snapshot["previousPrefix"]
                and snapshot["etag"] == f"local-{active['generation']}",
                "local_publication_pointer_changed",
            )
            _require(
                _public_records(self.pilot, target), "local_publication_output_missing"
            )
            receipt = {
                "delivery": "local",
                "reviewId": str(review),
                "distributionId": origin["distribution_id"],
                "originId": origin["origin_id"],
                "etag": f"local-{active['generation'] + 1}",
                "previousPrefix": snapshot["previousPrefix"],
                "targetPrefix": target,
                "status": "Deployed",
                "invalidationId": "local-no-cache",
                "invalidationStatus": "Completed",
            }
            self.pilot.save_json(
                "publication-active.json",
                {
                    "origin": identity,
                    "prefix": target,
                    "generation": active["generation"] + 1,
                    "receipt": receipt,
                    "releases": {**active.get("releases", {}), str(review): receipt},
                },
            )
            return receipt


async def publish_local_review(pilot, review_id, maximum_files=64):
    """One existing publisher step; caller resumes this exact review if needed."""
    return await publish_step(
        UUID(str(review_id)),
        repository=DataApiPublicationRepository(LocalPublicationSqlClient()),
        storage=LocalPublicationStorage(pilot),
        edge=LocalPublicationEdge(pilot),
        source_bucket=pilot.BUCKET,
        public_bucket=PUBLIC_BUCKET,
        maximum_files=maximum_files,
    )


def read_publication(pilot, path, review_id=None):
    """Read only admitted public custody, with no-store HTTP applied by the caller."""
    _require(
        isinstance(path, str) and path.startswith("/") and not path.startswith("//")
    )
    relative = path[1:]
    if not relative or relative.endswith("/"):
        relative += "index.html"
    _relative(relative)
    active = pilot.read_json("publication-active.json")
    if active is None:
        return None
    if review_id is None:
        prefix = _prefix(active["prefix"])
    else:
        review = str(UUID(str(review_id)))
        if review not in active.get("releases", {}):
            return None
        prefix = f"releases/framework-{review}"
    key = prefix + "/" + relative
    record = next(
        (item for item in _public_records(pilot, prefix) if item["key"] == key), None
    )
    if record is None:
        return None
    return {
        "body": _read_public(pilot, record),
        "content_type": record["content_type"],
        "redirect": record["delivery"].get("x-amz-website-redirect-location"),
        "release_prefix": prefix,
    }


def read_publications(pilot, requests):
    """Read a bounded public batch while fencing the active release pointer."""
    _require(
        type(requests) is list and 1 <= len(requests) <= 32,
        "local_publication_batch_invalid",
    )
    for request in requests:
        _require(
            isinstance(request, dict)
            and set(request) in ({"path"}, {"path", "reviewId"})
            and isinstance(request["path"], str)
            and ("reviewId" not in request or isinstance(request["reviewId"], str)),
            "local_publication_batch_invalid",
        )
    records, total_bytes = [], 0
    # Activation uses this same lock. Each item still passes the canonical
    # public-membership, exact-object and checksum checks; nothing is cached.
    with pilot.local_state_lock("publication-active"):
        for request in requests:
            try:
                record = read_publication(
                    pilot, request["path"], review_id=request.get("reviewId")
                )
            except (PublicationConflict, ValueError, OSError):
                # Match a failed individual HTTP read without hiding valid
                # siblings. Programming errors and the batch cap still fail.
                record = None
            if record is not None:
                total_bytes += len(record["body"])
                _require(
                    total_bytes <= MAXIMUM_BYTES,
                    "local_publication_batch_bytes_exceeded",
                )
            records.append(record)
    return records
