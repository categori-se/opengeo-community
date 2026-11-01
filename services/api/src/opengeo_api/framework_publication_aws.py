"""Bounded AWS adapters for immutable Framework releases, with no compiler authority."""

import asyncio
import copy
import hashlib
import hmac
import html
import json
import re
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID
from xml.etree import ElementTree as ET

from opengeo_api.cognito_provisioning import AwsCredentialProvider
from opengeo_api.framework_publisher import (
    PublicationConflict,
    checksum,
    localized_output_proof,
    retained_localized_files,
)


class PublicationDependencyUnavailable(RuntimeError):
    pass


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


class PublicationAws:
    def __init__(self, region: str, credentials: Any = None) -> None:
        if region != "us-east-1":
            raise ValueError("Publication delivery must use the reviewed region")
        self.region = region
        self.credentials = credentials or AwsCredentialProvider()

    async def request(
        self,
        service: str,
        method: str,
        path: str,
        *,
        query: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
        body: bytes = b"",
        maximum: int = 1_048_576,
    ) -> tuple[int, dict[str, str], bytes]:
        return await asyncio.to_thread(
            self._request, service, method, path, query or {}, headers or {}, body, maximum
        )

    def _request(
        self,
        service: str,
        method: str,
        path: str,
        query: dict[str, str],
        headers: dict[str, str],
        body: bytes,
        maximum: int,
    ) -> tuple[int, dict[str, str], bytes]:
        if (
            service not in {"s3", "cloudfront"}
            or method not in {"GET", "HEAD", "PUT", "POST", "DELETE"}
            or not path.startswith("/")
        ):
            raise ValueError("Invalid publication AWS request")
        host = f"s3.{self.region}.amazonaws.com" if service == "s3" else "cloudfront.amazonaws.com"
        credential = self.credentials.load()
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        encoded_path = quote(path, safe="/-_.~")
        encoded_query = "&".join(
            f"{quote(k, safe='-_.~')}={quote(v, safe='-_.~')}" for k, v in sorted(query.items())
        )
        signed = {k.lower(): " ".join(v.split()) for k, v in headers.items()}
        signed.update(
            {
                "host": host,
                "x-amz-date": stamp,
                "x-amz-content-sha256": hashlib.sha256(body).hexdigest(),
            }
        )
        if credential.session_token:
            signed["x-amz-security-token"] = credential.session_token
        names = ";".join(sorted(signed))
        canonical = "\n".join(
            (
                method,
                encoded_path,
                encoded_query,
                "".join(f"{k}:{signed[k]}\n" for k in sorted(signed)),
                names,
                signed["x-amz-content-sha256"],
            )
        )
        scope = f"{stamp[:8]}/{self.region}/{service}/aws4_request"
        signing = ("AWS4" + credential.secret_access_key).encode()
        for part in (stamp[:8], self.region, service, "aws4_request"):
            signing = hmac.new(signing, part.encode(), hashlib.sha256).digest()
        to_sign = (
            f"AWS4-HMAC-SHA256\n{stamp}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}"
        )
        signature = hmac.new(signing, to_sign.encode(), hashlib.sha256).hexdigest()
        signed["authorization"] = (
            f"AWS4-HMAC-SHA256 Credential={credential.access_key_id}/{scope}, "
            f"SignedHeaders={names}, Signature={signature}"
        )
        request = Request(
            f"https://{host}{encoded_path}" + (f"?{encoded_query}" if encoded_query else ""),
            method=method,
            headers=signed,
            data=body if method in {"PUT", "POST"} else None,
        )
        try:
            try:
                response = build_opener(_NoRedirect()).open(request, timeout=30)
            except HTTPError as error:
                response = error
            with response:
                data = response.read(maximum + 1)
                if len(data) > maximum:
                    raise PublicationDependencyUnavailable("publication_response_limit")
                return response.status, {k.lower(): v for k, v in response.headers.items()}, data
        except (OSError, TimeoutError) as error:
            raise PublicationDependencyUnavailable("publication_aws_unavailable") from error


def _xml(body: bytes) -> ET.Element:
    try:
        if b"<!DOCTYPE" in body or b"<!ENTITY" in body:
            raise ValueError("XML declarations not accepted")
        return ET.fromstring(body)
    except (ValueError, ET.ParseError) as error:
        raise PublicationDependencyUnavailable("publication_xml_invalid") from error


def _ok(status: int) -> None:
    if not 200 <= status < 300:
        if status in {400, 401, 403, 404, 409, 412}:
            raise PublicationConflict(f"publication_aws_rejected_{status}")
        raise PublicationDependencyUnavailable("publication_aws_unavailable")


class S3PublicationStorage:
    def __init__(
        self,
        aws: PublicationAws,
        source_bucket: str,
        public_bucket: str,
        *,
        private_origin: bool = False,
    ) -> None:
        self.aws, self.source_bucket, self.public_bucket = aws, source_bucket, public_bucket
        self.private_origin = private_origin

    def _redirect_body(self, location: str) -> bytes:
        if not self.private_origin:
            return b""
        if not location.startswith("/") or location.startswith("//") or "\\" in location:
            raise PublicationConflict("publication_redirect_invalid")
        target = json.dumps(location).replace("<", "\\u003c").replace(">", "\\u003e")
        escaped = html.escape(location, quote=True)
        return (
            f'<!doctype html><meta charset="utf-8"><title>Redirect</title>'
            f"<script>location.replace({target}+location.search+location.hash)</script>"
            f'<noscript><meta http-equiv="refresh" content="0;url={escaped}"></noscript>'
            f'<a href="{escaped}">Continue</a>'
        ).encode()

    async def _listing(self, bucket: str, prefix: str) -> list[dict[str, Any]]:
        if bucket != self.public_bucket or not prefix.startswith("releases/") or ".." in prefix:
            raise PublicationConflict("publication_inventory_scope_invalid")
        files: list[dict[str, Any]] = []
        token = None
        for _ in range(3):
            query = {"list-type": "2", "prefix": prefix + "/", "max-keys": "1000"}
            if token:
                query["continuation-token"] = token
            status, _, body = await self.aws.request("s3", "GET", f"/{bucket}", query=query)
            _ok(status)
            xml = _xml(body)
            for item in xml.findall("{*}Contents"):
                key = item.findtext("{*}Key", "")
                if not key.startswith(prefix + "/"):
                    raise PublicationConflict("publication_inventory_scope_invalid")
                files.append(
                    {
                        "path": key[len(prefix) + 1 :],
                        "bucket": bucket,
                        "objectKey": key,
                        "etag": item.findtext("{*}ETag"),
                        "sizeBytes": int(item.findtext("{*}Size", "-1")),
                    }
                )
            if len(files) > 2048 or sum(file["sizeBytes"] for file in files) > 1_073_741_824:
                raise PublicationConflict("publication_inventory_limit")
            if xml.findtext("{*}IsTruncated") == "false":
                return files
            token = xml.findtext("{*}NextContinuationToken")
            if not token:
                break
        raise PublicationConflict("publication_inventory_limit")

    async def _read(
        self, file: dict[str, Any], *, maximum_bytes: int = 33_554_432
    ) -> tuple[dict[str, str], bytes]:
        bucket, key = file["bucket"], file["objectKey"]
        if bucket == self.public_bucket:
            valid = key.startswith("releases/")
        else:
            valid = (
                bucket == self.source_bucket
                and key.startswith("organizations/")
                and "/builds/" in key
                and "/output/" in key
            )
        native = maximum_bytes == 100_663_296
        if native:
            localized_output_proof(file.get("localizedOutput"), file)
            if bucket == self.source_bucket and not key.endswith("/output/index.html"):
                raise PublicationConflict("publication_read_scope_invalid")
        if (
            maximum_bytes not in {33_554_432, 67_108_864, 100_663_296}
            or not valid
            or ".." in key
            or not 0 <= file["sizeBytes"] <= maximum_bytes
        ):
            raise PublicationConflict("publication_read_scope_invalid")
        query = {"versionId": file["s3VersionId"]} if file.get("s3VersionId") else {}
        headers = {"if-match": file["etag"]} if file.get("etag") else {}
        status, metadata, body = await self.aws.request(
            "s3", "GET", f"/{bucket}/{key}", query=query, headers=headers, maximum=file["sizeBytes"]
        )
        _ok(status)
        if (
            len(body) != file["sizeBytes"]
            or file.get("checksumSha256", hashlib.sha256(body).hexdigest())
            != hashlib.sha256(body).hexdigest()
            or (native and metadata.get("content-type") != "text/html")
        ):
            raise PublicationConflict("publication_object_checksum_mismatch")
        return metadata, body

    async def inventory(
        self, bucket: str, prefix: str, *, previous_release_plan: Mapping[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        retained = retained_localized_files(previous_release_plan, prefix, bucket)
        files = await self._listing(bucket, prefix)
        # A newly provisioned, explicitly paired OAC host has no prior objects.
        # Never relax this check for an established release or website origin.
        if not files and not (self.private_origin and prefix == "releases/bootstrap"):
            raise PublicationConflict("publication_previous_release_empty")
        for file in files:
            proof = retained.get(file["path"])
            if proof is not None:
                if proof["sizeBytes"] != file["sizeBytes"]:
                    raise PublicationConflict("publication_retained_object_mismatch")
                file.update(
                    {
                        key: proof[key]
                        for key in ("contentType", "checksumSha256", "localizedOutput")
                    }
                )
            metadata, body = await self._read(
                file, maximum_bytes=100_663_296 if proof is not None else 67_108_864
            )
            file.update(
                {
                    "s3VersionId": metadata.get("x-amz-version-id"),
                    "checksumSha256": hashlib.sha256(body).hexdigest(),
                    "contentType": metadata.get("content-type", "application/octet-stream"),
                    "delivery": {
                        key: metadata[key]
                        for key in (
                            "content-type",
                            "content-encoding",
                            "cache-control",
                            "x-amz-website-redirect-location",
                        )
                        if key in metadata
                    },
                }
            )
        return files

    async def apply(self, bucket: str, prefix: str, file: dict[str, Any]) -> None:
        if bucket != self.public_bucket or not prefix.startswith("releases/framework-"):
            raise PublicationConflict("publication_write_scope_invalid")
        UUID(prefix.removeprefix("releases/framework-"))
        if file["kind"] == "copy":
            metadata, body = await self._read(
                file["source"], maximum_bytes=file.get("maximumBytes", 33_554_432)
            )
            if metadata.get("content-encoding") and "delivery" not in file["source"]:
                # Build manifests currently describe unencoded bytes. Do not
                # silently add delivery semantics absent from approved output.
                raise PublicationConflict("publication_output_encoding_unreviewed")
            headers = dict(
                file["source"].get(
                    "delivery",
                    {"content-type": file["source"]["contentType"], "cache-control": "no-cache"},
                )
            )
            # Preserve content encoding when copying built or inherited objects.
            if metadata.get("content-encoding"):
                headers["content-encoding"] = metadata["content-encoding"]
        elif (
            file["kind"] == "redirect"
            and file["location"].startswith("/")
            and not file["location"].startswith("//")
        ):
            body = self._redirect_body(file["location"])
            headers = {
                "content-type": "text/html",
                "cache-control": "no-cache",
                "x-amz-website-redirect-location": file["location"],
            }
        else:
            raise PublicationConflict("publication_operation_invalid")
        headers.update(
            {
                "if-none-match": "*",
                "x-amz-meta-opengeo-sha256": hashlib.sha256(body).hexdigest(),
                "x-amz-meta-opengeo-release": prefix.rsplit("/", 1)[1],
            }
        )
        status, _, _ = await self.aws.request(
            "s3", "PUT", f"/{bucket}/{prefix}/{file['path']}", headers=headers, body=body
        )
        if status != 412:
            _ok(status)
        # Also reconciles a lost successful PUT response; never replace another object.
        await self._verify_file(bucket, prefix, file)

    async def _verify_file(self, bucket: str, prefix: str, file: dict[str, Any]) -> None:
        source = file.get("source", {})
        if file.get("maximumBytes") == 100_663_296:
            localized_output_proof(source.get("localizedOutput"), source)
        redirect_body = self._redirect_body(file["location"]) if file["kind"] == "redirect" else b""
        size = source.get("sizeBytes", len(redirect_body))
        status, headers, body = await self.aws.request(
            "s3", "GET", f"/{bucket}/{prefix}/{file['path']}", maximum=size
        )
        _ok(status)
        expected = source.get("checksumSha256", hashlib.sha256(redirect_body).hexdigest())
        redirect = (
            source.get("delivery", {}).get("x-amz-website-redirect-location")
            if file["kind"] == "copy"
            else file["location"]
        )
        delivery = (
            source.get(
                "delivery", {"content-type": source["contentType"], "cache-control": "no-cache"}
            )
            if file["kind"] == "copy"
            else {"content-type": "text/html", "cache-control": "no-cache"}
        )
        if (
            len(body) != size
            or hashlib.sha256(body).hexdigest() != expected
            or headers.get("x-amz-meta-opengeo-release") != prefix.rsplit("/", 1)[1]
            or headers.get("x-amz-website-redirect-location") != redirect
            or any(
                headers.get(name) != delivery.get(name)
                for name in ("content-type", "content-encoding", "cache-control")
            )
        ):
            raise PublicationConflict("publication_written_object_mismatch")

    async def verify(self, plan: dict[str, Any]) -> None:
        listing = await self._listing(plan["bucket"], plan["targetPrefix"])
        if sorted(file["path"] for file in listing) != sorted(
            file["path"] for file in plan["files"]
        ):
            raise PublicationConflict("publication_written_inventory_mismatch")
        for file in plan["files"]:
            await self._verify_file(plan["bucket"], plan["targetPrefix"], file)


class CloudFrontPublicationEdge:
    def __init__(
        self, aws: PublicationAws, distribution_id: str, *, origin_access_control_id: str = ""
    ) -> None:
        self.aws, self.distribution_id = aws, distribution_id
        self.origin_access_control_id = origin_access_control_id

    @staticmethod
    def _required(element: ET.Element, name: str) -> ET.Element:
        child = element.find("{*}" + name)
        if child is None:
            raise PublicationConflict("publication_distribution_collection_invalid")
        return child

    @staticmethod
    def _collection(config: ET.Element, name: str, child: str) -> list[ET.Element]:
        collection = config.find("{*}" + name)
        if collection is None and name == "CacheBehaviors":
            return []
        if collection is None:
            raise PublicationConflict("publication_distribution_collection_invalid")
        entries = collection.findall("{*}Items/{*}" + child)
        if collection.findtext("{*}Quantity") != str(len(entries)):
            raise PublicationConflict("publication_distribution_collection_invalid")
        return entries

    @staticmethod
    def _edition_origin_id(origin: dict[str, Any]) -> str:
        return "opengeo-editions-" + hashlib.sha256(origin["origin_id"].encode()).hexdigest()[:16]

    def _edition_configuration(
        self, config: ET.Element, selected: ET.Element, origin: dict[str, Any], path: str
    ) -> tuple[ET.Element, ET.Element, bool]:
        if not self.origin_access_control_id:
            raise PublicationConflict("publication_edition_requires_private_origin")
        if not re.fullmatch(
            r"/releases/framework-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/"
            r"(?:[a-z0-9][a-z0-9-]{0,79}/){0,8}index\.html",
            path,
        ):
            raise PublicationConflict("publication_edition_path_invalid")
        origins = self._collection(config, "Origins", "Origin")
        behaviors = self._collection(config, "CacheBehaviors", "CacheBehavior")
        ids = [item.findtext("{*}Id") for item in origins]
        patterns = [(item.findtext("{*}PathPattern") or "").lstrip("/") for item in behaviors]
        if len(set(ids)) != len(ids) or len(set(patterns)) != len(patterns):
            raise PublicationConflict("publication_distribution_collection_invalid")
        # These are conservative application limits, not claims about AWS quotas.
        # Never remove an older route to make room for another edition.
        edition_id = self._edition_origin_id(origin)
        exists = edition_id in ids
        for item, existing_pattern in zip(behaviors, patterns, strict=True):
            destination = item.findtext("{*}TargetOriginId")
            if destination != origin["origin_id"] and (
                destination != edition_id
                or not re.fullmatch(
                    r"releases/framework-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/"
                    r"(?:[a-z0-9][a-z0-9-]{0,79}/){0,8}index\.html",
                    existing_pattern,
                )
            ):
                raise PublicationConflict("publication_edition_existing_route_unsupported")
            for association in ("FunctionAssociations", "LambdaFunctionAssociations"):
                attached = item.find("{*}" + association)
                if attached is not None and (
                    attached.findtext("{*}Quantity") != "0" or attached.find("{*}Items") is not None
                ):
                    raise PublicationConflict("publication_edition_rewrite_unsupported")
        if len(behaviors) >= 25 and path.lstrip("/") not in patterns:
            raise PublicationConflict("publication_edition_route_capacity")
        if len(origins) >= 5 and not exists:
            raise PublicationConflict("publication_edition_origin_capacity")
        public = copy.deepcopy(selected)
        self._required(public, "Id").text = edition_id
        origin_path = public.find("{*}OriginPath")
        if origin_path is None:
            raise PublicationConflict("publication_distribution_path_missing")
        origin_path.text = ""
        if exists and self._fingerprint(origins[ids.index(edition_id)], "") != self._fingerprint(
            public, ""
        ):
            raise PublicationConflict("publication_edition_origin_conflict")
        default = config.find("{*}DefaultCacheBehavior")
        if default is None or default.findtext("{*}ViewerProtocolPolicy") not in {
            "https-only",
            "redirect-to-https",
        }:
            raise PublicationConflict("publication_edition_behavior_invalid")
        for association in ("FunctionAssociations", "LambdaFunctionAssociations"):
            entries = default.find("{*}" + association)
            if entries is not None and (
                entries.findtext("{*}Quantity") != "0" or entries.find("{*}Items") is not None
            ):
                raise PublicationConflict("publication_edition_rewrite_unsupported")
        behavior = copy.deepcopy(default)
        namespace = config.tag.split("}")[0] + "}" if "}" in config.tag else ""
        behavior.tag = namespace + "CacheBehavior"
        pattern = ET.Element(namespace + "PathPattern")
        pattern.text = path.lstrip("/")
        behavior.insert(0, pattern)
        target = behavior.find("{*}TargetOriginId")
        if target is None:
            raise PublicationConflict("publication_edition_behavior_invalid")
        target.text = edition_id
        if pattern.text in patterns and self._fingerprint(
            behaviors[patterns.index(pattern.text)], ""
        ) != self._fingerprint(behavior, ""):
            raise PublicationConflict("publication_edition_route_conflict")
        if pattern.text in patterns and patterns.index(pattern.text) != 0:
            raise PublicationConflict("publication_edition_route_shadowed")
        return public, behavior, exists

    @staticmethod
    def _append_configuration(
        config: ET.Element, name: str, entry: ET.Element, *, first: bool = False
    ) -> None:
        namespace = config.tag.split("}")[0] + "}" if "}" in config.tag else ""
        collection = config.find("{*}" + name)
        if collection is None:
            collection = ET.Element(namespace + name)
            ET.SubElement(collection, namespace + "Quantity").text = "0"
            default = config.find("{*}DefaultCacheBehavior")
            if default is None:
                raise PublicationConflict("publication_edition_behavior_invalid")
            config.insert(list(config).index(default) + 1, collection)
        items = collection.find("{*}Items")
        if items is None:
            items = ET.SubElement(collection, namespace + "Items")
        items.insert(0 if first else len(items), entry)
        CloudFrontPublicationEdge._required(collection, "Quantity").text = str(len(items))

    def _activation_fingerprint(
        self,
        config: ET.Element,
        selected: ET.Element,
        origin: dict[str, Any],
        snapshot: dict[str, Any],
    ) -> str:
        path = snapshot.get("editionPath")
        if path is None:
            return self._fingerprint(config, origin["origin_id"])
        public, _, _ = self._edition_configuration(config, selected, origin, path)
        frozen = copy.deepcopy(config)
        collection = frozen.find("{*}CacheBehaviors")
        if collection is not None:
            items = collection.find("{*}Items")
            if items is not None:
                for item in list(items):
                    if item.findtext("{*}PathPattern") == path.lstrip("/"):
                        items.remove(item)
                self._required(collection, "Quantity").text = str(len(items))
                if not len(items) and snapshot["editionItemsAbsent"]:
                    collection.remove(items)
            if snapshot["editionBehaviorsAbsent"] and not collection.findall(
                "{*}Items/{*}CacheBehavior"
            ):
                frozen.remove(collection)
        if not snapshot["editionOriginExisted"]:
            origins = self._required(frozen, "Origins")
            items = self._required(origins, "Items")
            for item in list(items):
                if item.findtext("{*}Id") == public.findtext("{*}Id"):
                    items.remove(item)
            self._required(origins, "Quantity").text = str(len(items))
        return self._fingerprint(frozen, origin["origin_id"])

    async def _config(self, origin: dict[str, Any]) -> tuple[str, ET.Element, ET.Element]:
        if origin["distribution_id"] != self.distribution_id:
            raise PublicationConflict("publication_distribution_scope_invalid")
        status, headers, body = await self.aws.request(
            "cloudfront", "GET", f"/2020-05-31/distribution/{self.distribution_id}/config"
        )
        _ok(status)
        config = _xml(body)
        candidates = [
            item
            for item in config.findall("{*}Origins/{*}Items/{*}Origin")
            if item.findtext("{*}Id") == origin["origin_id"]
        ]
        if (
            len(candidates) != 1
            or config.findtext("{*}DefaultCacheBehavior/{*}TargetOriginId") != origin["origin_id"]
            or origin["hostname"]
            not in [item.text for item in config.findall("{*}Aliases/{*}Items/{*}CNAME")]
            or config.findtext("{*}Enabled") != "true"
        ):
            raise PublicationConflict("publication_distribution_identity_invalid")
        selected = candidates[0]
        if self.origin_access_control_id:
            expected_domain = f"{origin['bucket']}.s3.us-east-1.amazonaws.com"
            if (
                selected.findtext("{*}DomainName") != expected_domain
                or selected.findtext("{*}OriginAccessControlId") != self.origin_access_control_id
                or selected.find("{*}S3OriginConfig") is None
                or selected.findtext("{*}S3OriginConfig/{*}OriginAccessIdentity") not in (None, "")
            ):
                raise PublicationConflict("publication_private_origin_mismatch")
        elif selected.findtext("{*}DomainName") not in {
            f"{origin['bucket']}.s3-website-us-east-1.amazonaws.com",
            f"{origin['bucket']}.s3-website.us-east-1.amazonaws.com",
        }:
            raise PublicationConflict("publication_requires_reviewed_website_origin")
        if not headers.get("etag"):
            raise PublicationConflict("publication_distribution_etag_missing")
        return headers["etag"], config, selected

    @staticmethod
    def _fingerprint(config: ET.Element, origin_id: str) -> str:
        frozen = copy.deepcopy(config)
        for origin in frozen.findall("{*}Origins/{*}Items/{*}Origin"):
            if origin.findtext("{*}Id") == origin_id:
                path = origin.find("{*}OriginPath")
                if path is not None:
                    path.text = ""

        def value(element: ET.Element) -> Any:
            return [
                element.tag,
                sorted(element.attrib.items()),
                (element.text or "").strip(),
                [value(child) for child in element],
            ]

        return checksum(value(frozen))

    async def prepare(
        self, origin: dict[str, Any], previous: str, *, edition_path: str | None = None
    ) -> dict[str, Any]:
        etag, config, selected = await self._config(origin)
        if selected.findtext("{*}OriginPath") != "/" + previous:
            raise PublicationConflict("publication_public_pointer_changed")
        snapshot: dict[str, Any] = {
            "etag": etag,
            "fingerprint": self._fingerprint(config, origin["origin_id"]),
            "previousPrefix": previous,
        }
        if edition_path is not None:
            _, _, existed = self._edition_configuration(config, selected, origin, edition_path)
            if any(
                item.findtext("{*}PathPattern") == edition_path.lstrip("/")
                for item in self._collection(config, "CacheBehaviors", "CacheBehavior")
            ):
                raise PublicationConflict("publication_edition_route_already_exists")
            snapshot.update(
                editionPath=edition_path,
                editionOriginExisted=existed,
                editionBehaviorsAbsent=config.find("{*}CacheBehaviors") is None,
                editionItemsAbsent=config.find("{*}CacheBehaviors/{*}Items") is None,
            )
        return snapshot

    async def activate(
        self, origin: dict[str, Any], snapshot: dict[str, Any], target: str, review: UUID
    ) -> dict[str, Any] | None:
        etag, config, selected = await self._config(origin)
        edition_path = snapshot.get("editionPath")
        if edition_path is not None and not edition_path.startswith(f"/{target}/"):
            raise PublicationConflict("publication_edition_path_invalid")
        if target != f"releases/framework-{review}":
            raise PublicationConflict("publication_plan_identity_invalid")
        if (
            self._activation_fingerprint(config, selected, origin, snapshot)
            != snapshot["fingerprint"]
        ):
            raise PublicationConflict("publication_distribution_changed")
        path = selected.find("{*}OriginPath")
        if path is None:
            raise PublicationConflict("publication_distribution_path_missing")
        if path.text != "/" + target:
            if path.text != "/" + snapshot["previousPrefix"] or etag != snapshot["etag"]:
                raise PublicationConflict("publication_public_pointer_changed")
            path.text = "/" + target
            if edition_path is not None:
                public, behavior, existed = self._edition_configuration(
                    config, selected, origin, edition_path
                )
                if not existed:
                    self._append_configuration(config, "Origins", public)
                self._append_configuration(config, "CacheBehaviors", behavior, first=True)
            status, _, _ = await self.aws.request(
                "cloudfront",
                "PUT",
                f"/2020-05-31/distribution/{self.distribution_id}/config",
                headers={"if-match": etag, "content-type": "application/xml"},
                body=ET.tostring(config, encoding="utf-8"),
            )
            if status == 412:
                return None  # Reobserve, never adopt a fresh ETag for another update.
            _ok(status)
            return None
        if edition_path is not None and not any(
            item.findtext("{*}PathPattern") == edition_path.lstrip("/")
            for item in self._collection(config, "CacheBehaviors", "CacheBehavior")
        ):
            raise PublicationConflict("publication_edition_route_missing")
        status, _, body = await self.aws.request(
            "cloudfront", "GET", f"/2020-05-31/distribution/{self.distribution_id}"
        )
        _ok(status)
        if _xml(body).findtext("{*}Status") != "Deployed":
            return None
        invalidation = ET.Element(
            "InvalidationBatch", xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/"
        )
        paths = ET.SubElement(invalidation, "Paths")
        ET.SubElement(paths, "Quantity").text = "1"
        ET.SubElement(ET.SubElement(paths, "Items"), "Path").text = "/*"
        ET.SubElement(invalidation, "CallerReference").text = f"studio-framework-{review}"
        status, _, body = await self.aws.request(
            "cloudfront",
            "POST",
            f"/2020-05-31/distribution/{self.distribution_id}/invalidation",
            headers={"content-type": "application/xml"},
            body=ET.tostring(invalidation, encoding="utf-8"),
        )
        _ok(status)
        document = _xml(body)
        if document.findtext("{*}Status") != "Completed":
            return None
        current_etag, current_config, current_origin = await self._config(origin)
        if (
            current_origin.findtext("{*}OriginPath") != "/" + target
            or self._activation_fingerprint(current_config, current_origin, origin, snapshot)
            != snapshot["fingerprint"]
            or (
                edition_path is not None
                and not any(
                    item.findtext("{*}PathPattern") == edition_path.lstrip("/")
                    for item in self._collection(current_config, "CacheBehaviors", "CacheBehavior")
                )
            )
        ):
            raise PublicationConflict("publication_public_pointer_changed")
        receipt = {
            "distributionId": self.distribution_id,
            "originId": origin["origin_id"],
            "etag": current_etag,
            "previousPrefix": snapshot["previousPrefix"],
            "targetPrefix": target,
            "status": "Deployed",
            "invalidationId": document.findtext("{*}Id"),
            "invalidationStatus": "Completed",
        }
        if edition_path is not None:
            receipt["editionPath"] = edition_path
        return receipt
