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
    from opengeo_api.framework_publisher import _jsonb_checksum
    from test_framework_publisher import native_fixture

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


class NativeEditionAws:
    """Distribution double retains accepted updates even when their response is lost."""

    def __init__(self):
        self.config = ET.fromstring(b"""<DistributionConfig xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/">
          <CallerReference>retained</CallerReference>
          <Aliases><Quantity>1</Quantity><Items><CNAME>pages.example.org</CNAME></Items></Aliases>
          <Origins><Quantity>1</Quantity><Items><Origin><Id>pages</Id>
            <DomainName>public.s3.us-east-1.amazonaws.com</DomainName>
            <OriginPath>/releases/bootstrap</OriginPath><OriginAccessControlId>EOAC</OriginAccessControlId>
            <S3OriginConfig><OriginAccessIdentity/></S3OriginConfig>
          </Origin></Items></Origins>
          <DefaultCacheBehavior><TargetOriginId>pages</TargetOriginId>
            <ViewerProtocolPolicy>redirect-to-https</ViewerProtocolPolicy>
            <CachePolicyId>retained-cache</CachePolicyId><ResponseHeadersPolicyId>retained-security</ResponseHeadersPolicyId>
            <FunctionAssociations><Quantity>0</Quantity></FunctionAssociations>
            <LambdaFunctionAssociations><Quantity>0</Quantity></LambdaFunctionAssociations>
          </DefaultCacheBehavior>
          <CacheBehaviors><Quantity>0</Quantity></CacheBehaviors>
          <Enabled>true</Enabled></DistributionConfig>""")
        self.writes = 0
        self.lose_response = False
        self.invalidation_mutation = None

    async def request(self, service, method, path, **kwargs):
        assert service == "cloudfront"
        if method == "PUT":
            assert kwargs["headers"]["if-match"] == str(self.writes)
            self.config = ET.fromstring(kwargs["body"])
            self.writes += 1
            if self.lose_response:
                self.lose_response = False
                raise TimeoutError("accepted update; response lost")
            return 200, {}, b""
        if path.endswith("/config"):
            return 200, {"etag": str(self.writes)}, ET.tostring(self.config)
        if method == "POST":
            if self.invalidation_mutation is not None:
                self.invalidation_mutation(self.config)
            return (
                201,
                {},
                b"<Invalidation><Id>one-per-review</Id><Status>Completed</Status></Invalidation>",
            )
        return 200, {}, b"<Distribution><Status>Deployed</Status></Distribution>"


def native_edge_fixture():
    origin = {
        "origin_id": "pages",
        "bucket": "public",
        "hostname": "pages.example.org",
        "distribution_id": "EPAGES",
    }
    aws = NativeEditionAws()
    return aws, origin, CloudFrontPublicationEdge(aws, "EPAGES", origin_access_control_id="EOAC")


def test_native_edition_exact_route_survives_replacement_and_lost_activation_response():
    async def run():
        aws, origin, edge = native_edge_fixture()
        previous = "releases/bootstrap"
        paths = []
        for number in (1, 2):
            review = UUID(int=number)
            target = f"releases/framework-{review}"
            path = f"/{target}/analysis/noaa/index.html"
            snapshot = await edge.prepare(origin, previous, edition_path=path)
            aws.lose_response = True
            with pytest.raises(TimeoutError):
                await edge.activate(origin, snapshot, target, review)
            receipt = await edge.activate(origin, snapshot, target, review)
            assert receipt["editionPath"] == path
            assert receipt["invalidationStatus"] == "Completed"
            paths.append(path)
            routes = edge._collection(aws.config, "CacheBehaviors", "CacheBehavior")
            assert [item.findtext("{*}PathPattern") for item in routes] == [
                p[1:] for p in reversed(paths)
            ]
            assert all(
                item.findtext("{*}ResponseHeadersPolicyId") == "retained-security"
                for item in routes
            )
            public = edge._collection(aws.config, "Origins", "Origin")
            assert len(public) == 2  # One existing origin plus one shared edition origin.
            assert public[1].findtext("{*}OriginPath") == ""
            assert public[1].findtext("{*}OriginAccessControlId") == "EOAC"
            assert all("*" not in p for p in paths)  # No sibling paths or staged releases exposed.
            previous = target
        assert aws.writes == 2
        assert aws.config.findtext("{*}Origins/{*}Items/{*}Origin/{*}OriginPath") == "/" + previous

    asyncio.run(run())


@pytest.mark.parametrize(
    "change", ["capacity", "quantity", "rewrite", "http", "origin", "path", "staging", "duplicate"]
)
def test_native_edition_preflight_rejects_unsafe_or_full_distribution_without_writes(change):
    async def run():
        aws, origin, edge = native_edge_fixture()
        path = f"/releases/framework-{UUID(int=1)}/analysis/noaa/index.html"
        ns = "{http://cloudfront.amazonaws.com/doc/2020-05-31/}"
        if change == "capacity":
            for index in range(25):
                behavior = ET.Element(ns + "CacheBehavior")
                ET.SubElement(behavior, ns + "PathPattern").text = f"retained-{index}/*"
                ET.SubElement(behavior, ns + "TargetOriginId").text = "pages"
                edge._append_configuration(aws.config, "CacheBehaviors", behavior)
        elif change == "quantity":
            aws.config.find("{*}Origins/{*}Quantity").text = "2"
        elif change == "rewrite":
            aws.config.find(
                "{*}DefaultCacheBehavior/{*}FunctionAssociations/{*}Quantity"
            ).text = "1"
        elif change == "http":
            aws.config.find("{*}DefaultCacheBehavior/{*}ViewerProtocolPolicy").text = "allow-all"
        elif change == "origin":
            duplicate = deepcopy(aws.config.find("{*}Origins/{*}Items/{*}Origin"))
            duplicate.find("{*}Id").text = edge._edition_origin_id(origin)
            duplicate.find("{*}DomainName").text = "private-source.s3.us-east-1.amazonaws.com"
            edge._append_configuration(aws.config, "Origins", duplicate)
        elif change in {"staging", "duplicate"}:
            retained = deepcopy(aws.config.find("{*}DefaultCacheBehavior"))
            retained.tag = ns + "CacheBehavior"
            pattern = ET.Element(ns + "PathPattern")
            pattern.text = "releases/*" if change == "staging" else "retained/*"
            retained.insert(0, pattern)
            if change == "staging":
                public = deepcopy(aws.config.find("{*}Origins/{*}Items/{*}Origin"))
                public.find("{*}Id").text = edge._edition_origin_id(origin)
                public.find("{*}OriginPath").text = ""
                retained.find("{*}TargetOriginId").text = edge._edition_origin_id(origin)
                edge._append_configuration(aws.config, "Origins", public)
            else:
                duplicate = deepcopy(retained)
                duplicate.find("{*}PathPattern").text = "/retained/*"
                edge._append_configuration(aws.config, "CacheBehaviors", duplicate)
            edge._append_configuration(aws.config, "CacheBehaviors", retained)
        else:
            path = path.replace("index.html", "*")
        with pytest.raises(PublicationConflict):
            await edge.prepare(origin, "releases/bootstrap", edition_path=path)
        assert aws.writes == 0

    asyncio.run(run())


@pytest.mark.parametrize(
    "change", ["route", "origin", "security", "missing", "final-missing", "shadow", "new-behavior"]
)
def test_native_edition_resume_and_final_readback_reject_configuration_drift(change):
    async def run():
        aws, origin, edge = native_edge_fixture()
        review = UUID(int=1)
        target = f"releases/framework-{review}"
        path = f"/{target}/analysis/noaa/index.html"
        if change == "shadow":
            retained = deepcopy(aws.config.find("{*}DefaultCacheBehavior"))
            retained.tag = "{http://cloudfront.amazonaws.com/doc/2020-05-31/}CacheBehavior"
            pattern = ET.Element("{http://cloudfront.amazonaws.com/doc/2020-05-31/}PathPattern")
            pattern.text = "releases/*"
            retained.insert(0, pattern)
            edge._append_configuration(aws.config, "CacheBehaviors", retained)
        elif change == "new-behavior":
            aws.config.remove(aws.config.find("{*}CacheBehaviors"))
        snapshot = await edge.prepare(origin, "releases/bootstrap", edition_path=path)
        assert await edge.activate(origin, snapshot, target, review) is None

        def mutate(config):
            routes = config.find("{*}CacheBehaviors/{*}Items")
            if change == "route":
                routes[0].find("{*}TargetOriginId").text = "pages"
            elif change == "origin":
                config.find("{*}Origins/{*}Items")[1].find("{*}DomainName").text = "other"
            elif change == "security":
                config.find("{*}DefaultCacheBehavior/{*}ResponseHeadersPolicyId").text = "changed"
            elif change == "shadow":
                retained = routes[0]
                routes.remove(retained)
                routes.append(retained)
            elif change == "new-behavior":
                retained = deepcopy(routes[0])
                retained.find("{*}PathPattern").text = "unrelated/*"
                retained.find("{*}TargetOriginId").text = "pages"
                edge._append_configuration(config, "CacheBehaviors", retained)
            else:
                routes.remove(routes[0])
                config.find("{*}CacheBehaviors/{*}Quantity").text = "0"
                config.find("{*}CacheBehaviors").remove(routes)

        if change == "final-missing":
            aws.invalidation_mutation = mutate
        else:
            mutate(aws.config)
        with pytest.raises(PublicationConflict):
            await edge.activate(origin, snapshot, target, review)
        assert aws.writes == 1

    asyncio.run(run())
