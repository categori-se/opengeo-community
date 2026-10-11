import asyncio
import hashlib
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID
from xml.etree import ElementTree as ET

import pytest

from opengeo_api.framework_publication_aws import CloudFrontPublicationEdge, S3PublicationStorage
from opengeo_api.framework_publisher import PublicationConflict


@pytest.mark.parametrize("change", [None, "missing", "prefix", "path", "size", "proof"])
def test_native_inventory_reads_only_matching_previous_sealed_release_proof(change):
    from test_framework_publisher import fixture, retained_native_plan

    args = fixture()
    plan = retained_native_plan(args)
    file = {
        "path": "bhutan/index.html",
        "bucket": "public",
        "objectKey": "releases/old/bhutan/index.html",
        "etag": '"listed"',
        "sizeBytes": 88_347_591,
    }
    if change == "missing":
        plan = None
    elif change == "prefix":
        plan["targetPrefix"] = "releases/other"
    elif change == "path":
        file.update(path="other/index.html", objectKey="releases/old/other/index.html")
    elif change == "size":
        file["sizeBytes"] += 1
    elif change == "proof":
        plan["files"][0]["source"]["localizedOutput"]["manifestChecksumSha256"] = "b" * 64
    # The bounded request is exercised without allocating or reading a real archive.
    # A deliberately truncated synthetic response must still fail byte verification.
    request = AsyncMock(return_value=(200, {"content-type": "text/html"}, b"truncated"))
    storage = S3PublicationStorage(SimpleNamespace(request=request), "private", "public")
    storage._listing = AsyncMock(return_value=[file])
    with pytest.raises(PublicationConflict):
        asyncio.run(storage.inventory("public", "releases/old", previous_release_plan=plan))
    assert request.await_count == int(change is None)
    if change is None:
        assert request.await_args.kwargs["maximum"] == 88_347_591
        assert request.await_args.kwargs["headers"] == {"if-match": '"listed"'}


@pytest.mark.parametrize("change", [None, "path", "proof", "mime"])
def test_native_storage_bounded_copy_checks_fixed_index_proof_and_exact_html_delivery(change):
    from test_framework_publisher import native_fixture
    from opengeo_api.framework_publisher import _jsonb_checksum

    body = b"<h1>Native proof</h1>"
    args = native_fixture(size=len(body), data=True, expanded=True)
    source = deepcopy(args["build_result"]["outputManifest"]["files"][0])
    source["checksumSha256"] = hashlib.sha256(body).hexdigest()
    proof = deepcopy(args["build_result"]["localizedOutput"])
    proof["manifest"]["output"]["checksumSha256"] = source["checksumSha256"]
    proof["manifestChecksumSha256"] = _jsonb_checksum(proof["manifest"])
    source["localizedOutput"] = proof
    if change == "path":
        source["objectKey"] = source["objectKey"].replace("index.html", "other.html")
    elif change == "proof":
        proof["manifestChecksumSha256"] = "b" * 64
    metadata = {"content-type": "application/octet-stream" if change == "mime" else "text/html"}
    request = AsyncMock(return_value=(200, metadata, body))
    storage = S3PublicationStorage(SimpleNamespace(request=request), "private", "public")
    operation = storage._read(source, maximum_bytes=100_663_296)
    if change:
        with pytest.raises(PublicationConflict):
            asyncio.run(operation)
    else:
        assert asyncio.run(operation)[1] == body
    assert request.await_count == int(change in {None, "mime"})


@pytest.mark.parametrize(
    "private,prefix,allowed",
    [
        (True, "releases/bootstrap", True),
        (False, "releases/bootstrap", False),
        (True, "releases/framework-established", False),
        (True, "releases/bootstrap-other", False),
    ],
)
def test_empty_inventory_only_allowed_for_initial_private_bootstrap(private, prefix, allowed):
    class Aws:
        async def request(self, service, method, path, **kwargs):
            assert (service, method, path) == ("s3", "GET", "/public")
            assert kwargs["query"]["prefix"] == prefix + "/"
            return 200, {}, b"<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>"

    storage = S3PublicationStorage(Aws(), "private", "public", private_origin=private)
    if allowed:
        assert asyncio.run(storage.inventory("public", prefix)) == []
    else:
        with pytest.raises(PublicationConflict, match="publication_previous_release_empty"):
            asyncio.run(storage.inventory("public", prefix))


def test_private_redirect_writes_verified_html_fallback_without_website_service():
    async def run():
        objects = {}

        class Aws:
            async def request(self, service, method, path, **kwargs):
                if method == "PUT":
                    objects[path] = (kwargs["headers"], kwargs["body"])
                    return 200, {}, b""
                headers, body = objects[path]
                return 200, headers, body

        storage = S3PublicationStorage(Aws(), "private", "public", private_origin=True)
        await storage.apply(
            "public",
            f"releases/framework-{UUID(int=1)}",
            {"kind": "redirect", "path": "article", "location": "/article/"},
        )
        headers, body = next(iter(objects.values()))
        assert b'location.replace("/article/"+location.search+location.hash)' in body
        assert b'<a href="/article/">' in body
        assert headers["x-amz-website-redirect-location"] == "/article/"
        assert S3PublicationStorage(Aws(), "private", "public")._redirect_body("/article/") == b""

    asyncio.run(run())


@pytest.mark.parametrize("oac", ["EEXPECTED", "EWRONG", ""])
def test_private_edge_requires_exact_reviewed_oac(oac):
    class Aws:
        async def request(self, *args, **kwargs):
            return (
                200,
                {"etag": "etag"},
                f"""<DistributionConfig>
              <Enabled>true</Enabled><Aliases><Items><CNAME>pages.example.org</CNAME></Items></Aliases>
              <DefaultCacheBehavior><TargetOriginId>pages</TargetOriginId></DefaultCacheBehavior>
              <Origins><Items><Origin><Id>pages</Id><DomainName>public.s3.us-east-1.amazonaws.com</DomainName>
              <OriginAccessControlId>{oac}</OriginAccessControlId><S3OriginConfig><OriginAccessIdentity/></S3OriginConfig>
              <OriginPath>/releases/bootstrap</OriginPath></Origin></Items></Origins>
              </DistributionConfig>""".encode(),
            )

    origin = {
        "hostname": "pages.example.org",
        "distribution_id": "EPAGES",
        "bucket": "public",
        "origin_id": "pages",
    }
    edge = CloudFrontPublicationEdge(Aws(), "EPAGES", origin_access_control_id="EEXPECTED")
    if oac == "EEXPECTED":
        assert asyncio.run(edge.prepare(origin, "releases/bootstrap"))["etag"] == "etag"
    else:
        with pytest.raises(PublicationConflict, match="private_origin_mismatch"):
            asyncio.run(edge.prepare(origin, "releases/bootstrap"))
    with pytest.raises(PublicationConflict, match="reviewed_website_origin"):
        asyncio.run(
            CloudFrontPublicationEdge(Aws(), "EPAGES").prepare(origin, "releases/bootstrap")
        )


def test_conditional_object_replay_checks_bytes_and_delivery_metadata():
    async def run():
        body = b"<h1>Exact output</h1>"
        digest = hashlib.sha256(body).hexdigest()
        prefix = f"releases/framework-{UUID(int=1)}"
        file = {
            "path": "analysis/noaa/index.html",
            "kind": "copy",
            "source": {
                "bucket": "private",
                "objectKey": "organizations/o/builds/b/output/index.html",
                "s3VersionId": "v1",
                "sizeBytes": len(body),
                "checksumSha256": digest,
                "contentType": "text/html",
            },
        }

        class Aws:
            def __init__(self):
                self.metadata = {
                    "content-type": "text/html",
                    "cache-control": "no-cache",
                    "x-amz-meta-opengeo-release": prefix.split("/")[1],
                }

            async def request(self, service, method, path, **kwargs):
                assert service == "s3"
                if path.startswith("/private/"):
                    assert kwargs["query"] == {"versionId": "v1"}
                    return 200, {"content-type": "text/html"}, body
                if method == "PUT":
                    assert kwargs["headers"]["if-none-match"] == "*"
                    assert kwargs["body"] == body
                    return 412, {}, b""  # Previous write succeeded; reconcile, do not overwrite.
                return 200, self.metadata, body

        aws = Aws()
        storage = S3PublicationStorage(aws, "private", "public")
        await storage.apply("public", prefix, file)
        aws.metadata["content-type"] = "text/plain"
        with pytest.raises(PublicationConflict, match="written_object_mismatch"):
            await storage.apply("public", prefix, file)

    asyncio.run(run())


def test_edge_activation_recovers_lost_response_and_preserves_unrelated_configuration():
    async def run():
        origin = {
            "origin_id": "root",
            "bucket": "opengeo.tools",
            "hostname": "opengeo.tools",
            "distribution_id": "EXAMPLE",
        }
        review = UUID(int=1)
        target = f"releases/framework-{review}"

        class Aws:
            config = b"""<DistributionConfig><CallerReference>original</CallerReference>
              <Aliases><Items><CNAME>opengeo.tools</CNAME></Items></Aliases>
              <Origins><Items><Origin><Id>root</Id>
                <DomainName>opengeo.tools.s3-website-us-east-1.amazonaws.com</DomainName>
                <OriginPath>/releases/old</OriginPath></Origin></Items></Origins>
              <DefaultCacheBehavior><TargetOriginId>root</TargetOriginId>
                <ViewerProtocolPolicy>redirect-to-https</ViewerProtocolPolicy></DefaultCacheBehavior>
              <Enabled>true</Enabled></DistributionConfig>"""
            etag = "old"
            writes = 0

            async def request(self, service, method, path, **kwargs):
                assert service == "cloudfront"
                if method == "PUT":
                    assert kwargs["headers"]["if-match"] == "old"
                    self.config, self.etag = kwargs["body"], "new"
                    self.writes += 1
                    raise TimeoutError("CloudFront accepted update, but response was lost")
                if path.endswith("/config"):
                    return 200, {"etag": self.etag}, self.config
                if method == "POST":
                    xml = ET.fromstring(kwargs["body"])
                    assert xml.findtext("{*}CallerReference") == f"studio-framework-{review}"
                    return (
                        201,
                        {},
                        b"<Invalidation><Id>retained</Id><Status>Completed</Status></Invalidation>",
                    )
                return 200, {}, b"<Distribution><Status>Deployed</Status></Distribution>"

        aws = Aws()
        edge = CloudFrontPublicationEdge(aws, "EXAMPLE")
        snapshot = await edge.prepare(origin, "releases/old")
        with pytest.raises(TimeoutError):
            await edge.activate(origin, snapshot, target, review)
        receipt = await edge.activate(origin, snapshot, target, review)
        assert receipt["targetPrefix"] == target
        assert aws.writes == 1
        assert b"redirect-to-https" in aws.config and b"original" in aws.config
        aws.config = aws.config.replace(b"redirect-to-https", b"allow-all")
        with pytest.raises(PublicationConflict, match="distribution_changed"):
            await edge.activate(origin, snapshot, target, review)
        assert aws.writes == 1

    asyncio.run(run())
