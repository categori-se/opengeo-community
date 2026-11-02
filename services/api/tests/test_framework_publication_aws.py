import asyncio
import base64
import hashlib
import json
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


def native_withdrawal_fixture(*, current=True):
    from opengeo_api.framework_publisher import plan_publication
    from test_framework_publisher import native_fixture

    args = native_fixture()
    args["reserved_mounts"] += ("/analysis/noaa/nested/",)
    args["current_files"].append(
        {
            **args["current_files"][-1],
            "path": "analysis/noaa/nested/index.html",
            "objectKey": args["previous_prefix"] + "/analysis/noaa/nested/index.html",
        }
    )
    full = plan_publication(**args, private_origin=True)
    owned = {"analysis/noaa", "analysis/noaa.html", "analysis/noaa/", "analysis/noaa/index.html"}
    target = {key: value for key, value in full.items() if key != "files"}
    target["files"] = [deepcopy(entry) for entry in full["files"] if entry["path"] in owned]
    for entry in target["files"]:
        if entry["kind"] == "copy" and entry["path"] != "analysis/noaa/index.html":
            entry["source"].pop("localizedOutput", None)
    active = deepcopy(target)
    active.update(
        reviewId=str(UUID(int=9)),
        targetPrefix=f"releases/framework-{UUID(int=9)}",
        mountPath="/bhutan/",
        editionPath=f"/releases/framework-{UUID(int=9)}/bhutan/index.html",
    )
    for entry in active["files"]:
        if entry["kind"] == "copy":
            entry["source"].pop("localizedOutput", None)
            entry["source"].update(
                bucket="public",
                objectKey=target["targetPrefix"] + "/" + entry["path"],
                s3VersionId="copied-edition-version",
            )
    return {
        "review_id": str(args["review_id"]),
        "target_prefix": target["targetPrefix"],
        "mount_path": args["mount_path"],
        "reserved_mounts": list(args["reserved_mounts"]),
        "current_mount_review_id": str(args["review_id"] if current else UUID(int=8)),
        "is_current_mount_edition": current,
        "target_plan": target,
        "current_release_plan": active,
        "origin": {
            "id": str(UUID(int=14)),
            "origin_id": "pages",
            "bucket": "public",
            "distribution_id": "EPAGES",
            "hostname": "pages.example.org",
            "active_release_prefix": active["targetPrefix"],
        },
    }


class NativeWithdrawalAws(NativeEditionAws):
    """Metadata-only S3 peer; full object access and distribution mutation are errors."""

    distribution_arn = "arn:aws:cloudfront::111111111111:distribution/EPAGES"
    publisher_role_arn = "arn:aws:iam::111111111111:role/exact-publisher"

    def __init__(self, claim):
        from opengeo_api.framework_publication_aws import withdrawal_policy_statements

        super().__init__()
        self.calls = []
        self.tag_puts = []
        self.tags = {}
        self.objects = {}
        self.invalidation_requests = []
        self.invalidation_status = "Completed"
        self.lose_tag_response = False
        self.tag_version_mismatch = False
        self.query_behavior = {"cachepolicy": "none", "originrequestpolicy": "none"}
        self.public_access_block = {
            key: True
            for key in (
                "BlockPublicAcls",
                "IgnorePublicAcls",
                "BlockPublicPolicy",
                "RestrictPublicBuckets",
            )
        }
        self.policy = {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Sid": "RetainedCloudFrontRead",
                    "Effect": "Allow",
                    "Principal": {"Service": "cloudfront.amazonaws.com"},
                    "Action": "s3:GetObject",
                    "Resource": "arn:aws:s3:::public/*",
                    "Condition": {"StringEquals": {"AWS:SourceArn": self.distribution_arn}},
                },
                *withdrawal_policy_statements(
                    "public", self.distribution_arn, self.publisher_role_arn
                ),
            ],
        }
        origin = claim["origin"]
        selected = self.config.find("{*}Origins/{*}Items/{*}Origin")
        selected.find("{*}OriginPath").text = "/" + origin["active_release_prefix"]
        edge = CloudFrontPublicationEdge(self, "EPAGES", origin_access_control_id="EOAC")
        public, behavior, _ = edge._edition_configuration(
            self.config, selected, origin, claim["target_plan"]["editionPath"]
        )
        edge._append_configuration(self.config, "Origins", public)
        edge._append_configuration(self.config, "CacheBehaviors", behavior)
        storage = S3PublicationStorage(self, "private", "public", private_origin=True)
        for plan in (claim["target_plan"], claim["current_release_plan"]):
            for entry in plan["files"]:
                if entry["kind"] == "copy":
                    digest, size = entry["source"]["checksumSha256"], entry["source"]["sizeBytes"]
                else:
                    body = storage._redirect_body(entry["location"])
                    digest, size = hashlib.sha256(body).hexdigest(), len(body)
                path = "/public/" + plan["targetPrefix"] + "/" + entry["path"]
                self.objects[path] = {
                    "content-type": "text/html",
                    "content-length": str(size),
                    "x-amz-meta-opengeo-sha256": digest,
                    "x-amz-meta-opengeo-release": plan["targetPrefix"].split("/")[1],
                    "etag": f'"sealed-{len(self.objects)}"',
                    "x-amz-version-id": f"version-{len(self.objects)}",
                }
                self.tags[path] = {}
        self.protected_paths = {
            f"/public/{origin['active_release_prefix']}/{path}"
            for path in ("index.html", "bhutan/index.html", "analysis/noaa/nested/index.html")
        } - self.objects.keys()
        for path in self.protected_paths:
            self.objects[path] = {"retained": "protected root or separately owned mount"}
            self.tags[path] = {"retained-custody": "preserve"}

    async def request(self, service, method, path, **kwargs):
        self.calls.append((service, method, path, deepcopy(kwargs)))
        query = kwargs.get("query", {})
        if service == "s3":
            if path == "/public" and method == "GET":
                if query == {"policy": ""}:
                    return 200, {}, json.dumps(self.policy).encode()
                assert query == {"publicAccessBlock": ""}
                document = ET.Element("PublicAccessBlockConfiguration")
                for key, value in self.public_access_block.items():
                    ET.SubElement(document, key).text = str(value).lower()
                return 200, {}, ET.tostring(document)
            metadata = self.objects[path]
            if method == "HEAD":
                assert not query or query == {"versionId": metadata["x-amz-version-id"]}
                assert not any("checksum" in key.lower() for key in kwargs.get("headers", {}))
                return 200, dict(metadata), b""
            assert query == {"tagging": "", "versionId": metadata["x-amz-version-id"]}
            version = (
                "unexpected-version" if self.tag_version_mismatch else metadata["x-amz-version-id"]
            )
            if method == "GET":
                document = ET.Element("Tagging")
                tag_set = ET.SubElement(document, "TagSet")
                for key, value in self.tags[path].items():
                    tag = ET.SubElement(tag_set, "Tag")
                    ET.SubElement(tag, "Key").text = key
                    ET.SubElement(tag, "Value").text = value
                return 200, {"x-amz-version-id": version}, ET.tostring(document)
            assert method == "PUT"
            document = ET.fromstring(kwargs["body"])
            tags = {
                tag.findtext("{*}Key"): tag.findtext("{*}Value")
                for tag in document.findall("{*}TagSet/{*}Tag")
            }
            assert tags == {"opengeo-withdrawn": "true"}
            headers = {key.lower(): value for key, value in kwargs["headers"].items()}
            assert (
                headers["content-md5"]
                == base64.b64encode(
                    hashlib.md5(kwargs["body"], usedforsecurity=False).digest()
                ).decode()
            )
            self.tag_puts.append((path, metadata["x-amz-version-id"]))
            self.tags[path] = tags
            if self.lose_tag_response:
                self.lose_tag_response = False
                raise TimeoutError("Tag update accepted; response lost")
            return 200, {"x-amz-version-id": version}, b""
        assert service == "cloudfront" and method in {"GET", "POST"}
        if path.endswith("/config"):
            return 200, {"etag": "retained-config"}, ET.tostring(self.config)
        for policy_type, query_kind in (
            ("cache-policy", "cachepolicy"),
            ("origin-request-policy", "originrequestpolicy"),
        ):
            if f"/{policy_type}/" in path:
                name = "CachePolicy" if query_kind == "cachepolicy" else "OriginRequestPolicy"
                document = ET.Element(name)
                policy = ET.SubElement(document, name + "Config")
                if query_kind == "cachepolicy":
                    policy = ET.SubElement(policy, "ParametersInCacheKeyAndForwardedToOrigin")
                query_config = ET.SubElement(policy, "QueryStringsConfig")
                ET.SubElement(query_config, "QueryStringBehavior").text = self.query_behavior[
                    query_kind
                ]
                return 200, {"etag": "retained-policy"}, ET.tostring(document)
        if method == "POST":
            assert path.endswith("/invalidation")
            document = ET.fromstring(kwargs["body"])
            self.invalidation_requests.append(
                (
                    document.findtext("{*}CallerReference"),
                    tuple(item.text for item in document.findall("{*}Paths/{*}Items/{*}Path")),
                )
            )
            if self.invalidation_mutation:
                self.invalidation_mutation(self.config)
            return (
                201,
                {},
                (
                    "<Invalidation><Id>one-withdrawal</Id>"
                    f"<Status>{self.invalidation_status}</Status></Invalidation>"
                ).encode(),
            )
        assert path == "/2020-05-31/distribution/EPAGES"
        return (
            200,
            {},
            (
                f"<Distribution><Id>EPAGES</Id><ARN>{self.distribution_arn}</ARN>"
                "<Status>Deployed</Status></Distribution>"
            ).encode(),
        )


@pytest.mark.parametrize("current", [False, True])
def test_native_withdrawal_tags_exact_aliases_without_reading_or_republishing_content(current):
    claim = native_withdrawal_fixture(current=current)
    aws = NativeWithdrawalAws(claim)
    before_objects, before_config = deepcopy(aws.objects), ET.tostring(aws.config)
    before_tags = deepcopy(aws.tags)
    edge = CloudFrontPublicationEdge(aws, "EPAGES", origin_access_control_id="EOAC")
    receipt = asyncio.run(edge.withdraw(claim))
    prefixes = [claim["target_prefix"]]
    if current:
        prefixes.append(claim["origin"]["active_release_prefix"])
    aliases = {"analysis/noaa", "analysis/noaa.html", "analysis/noaa/", "analysis/noaa/index.html"}
    expected = {f"/public/{prefix}/{alias}" for prefix in prefixes for alias in aliases}
    assert {path for path, _ in aws.tag_puts} == expected
    assert len(aws.tag_puts) == len(expected)
    assert aws.objects == before_objects and ET.tostring(aws.config) == before_config
    assert receipt["schema"] == "opengeo.framework-publication-revocation-receipt.1.0.0"
    assert receipt["confirmed"] is True and receipt["reviewId"] == claim["review_id"]
    assert (
        receipt["targetPrefix"] == claim["target_prefix"]
        and receipt["originId"] == claim["origin"]["id"]
    )
    assert receipt["invalidationStatus"] == "Completed"
    assert {(item["key"], item["versionId"]) for item in receipt["objects"]} == {
        (path.removeprefix("/public/"), version) for path, version in aws.tag_puts
    }
    assert len(aws.calls) < 120
    for service, method, path, kwargs in aws.calls:
        if service == "s3":
            assert method == "HEAD" or "tagging" in kwargs.get("query", {}) or path == "/public"
        else:
            assert method == "GET" or (method == "POST" and path.endswith("/invalidation"))
    assert all(tags == before_tags[path] for path, tags in aws.tags.items() if path not in expected)
    assert not expected & aws.protected_paths
    assert all(
        "nested" not in path and not path.endswith("/bhutan/index.html") for path in expected
    )


def test_native_withdrawal_lost_tag_response_resumes_without_duplicate_tag_writes():
    from opengeo_api.framework_publication_aws import PublicationDependencyUnavailable

    claim = native_withdrawal_fixture()
    aws = NativeWithdrawalAws(claim)
    aws.lose_tag_response = True
    edge = CloudFrontPublicationEdge(aws, "EPAGES", origin_access_control_id="EOAC")
    with pytest.raises((TimeoutError, PublicationDependencyUnavailable)):
        asyncio.run(edge.withdraw(claim))
    accepted = aws.tag_puts[0]
    assert asyncio.run(edge.withdraw(claim))["confirmed"] is True
    assert len(aws.tag_puts) == len(set(aws.tag_puts)) == 8
    assert aws.tag_puts.count(accepted) == 1


def test_native_withdrawal_pending_invalidation_resumes_same_request_without_retagging():
    claim = native_withdrawal_fixture()
    aws = NativeWithdrawalAws(claim)
    edge = CloudFrontPublicationEdge(aws, "EPAGES", origin_access_control_id="EOAC")
    aws.invalidation_status = "InProgress"
    assert asyncio.run(edge.withdraw(claim)) is None
    accepted = list(aws.tag_puts)
    aws.invalidation_status = "Completed"
    assert asyncio.run(edge.withdraw(claim))["confirmed"] is True
    assert aws.tag_puts == accepted
    assert len(aws.invalidation_requests) == 2
    assert aws.invalidation_requests[0] == aws.invalidation_requests[1]
    assert aws.invalidation_requests[0][0]


def test_native_withdrawal_preserves_unknown_tags_and_stops_before_any_write():
    claim = native_withdrawal_fixture()
    aws = NativeWithdrawalAws(claim)
    last_owned = next(path for path in reversed(aws.tags) if path not in aws.protected_paths)
    aws.tags[last_owned] = {"retained-custody": "preserve"}
    retained = deepcopy(aws.tags)
    with pytest.raises(PublicationConflict):
        asyncio.run(
            CloudFrontPublicationEdge(aws, "EPAGES", origin_access_control_id="EOAC").withdraw(
                claim
            )
        )
    assert not aws.tag_puts and not aws.invalidation_requests and aws.tags == retained


@pytest.mark.parametrize(
    "change",
    [
        "missing-policy",
        "policy-scope",
        "foreign-writer",
        "anonymous-allow",
        "bpa-disabled",
        "bpa-missing",
        "cache-query",
        "origin-query",
        "legacy-query",
        "oac",
        "pointer",
        "distribution",
        "object-sha",
        "object-length",
        "object-type",
        "object-release",
        "invalid-version",
        "tag-version",
    ],
)
def test_native_withdrawal_rejects_unsafe_policy_delivery_or_object_identity_before_writes(change):
    claim = native_withdrawal_fixture()
    aws = NativeWithdrawalAws(claim)
    statements = aws.policy["Statement"]
    metadata = next(iter(aws.objects.values()))
    if change == "missing-policy":
        statements.pop(1)
    elif change == "policy-scope":
        statements[1]["Resource"] = "arn:aws:s3:::other/releases/framework-*/*"
    elif change == "foreign-writer":
        statements[2]["Condition"]["ArnNotEquals"]["aws:PrincipalArn"] = (
            "arn:aws:iam::222222222222:role/foreign"
        )
    elif change == "anonymous-allow":
        statements.append(
            {
                "Effect": "Allow",
                "Principal": "*",
                "Action": "s3:GetObject",
                "Resource": "arn:aws:s3:::public/*",
            }
        )
    elif change == "bpa-disabled":
        aws.public_access_block["IgnorePublicAcls"] = False
    elif change == "bpa-missing":
        aws.public_access_block.pop("BlockPublicPolicy")
    elif change == "cache-query":
        aws.query_behavior["cachepolicy"] = "all"
    elif change == "origin-query":
        default = aws.config.find("{*}DefaultCacheBehavior")
        ET.SubElement(default, "OriginRequestPolicyId").text = "retained-origin-policy"
        aws.query_behavior["originrequestpolicy"] = "all"
    elif change == "legacy-query":
        default = aws.config.find("{*}DefaultCacheBehavior")
        default.remove(default.find("{*}CachePolicyId"))
        ET.SubElement(ET.SubElement(default, "ForwardedValues"), "QueryString").text = "true"
    elif change == "oac":
        aws.config.find("{*}Origins/{*}Items/{*}Origin/{*}OriginAccessControlId").text = "OTHER"
    elif change == "pointer":
        aws.config.find("{*}Origins/{*}Items/{*}Origin/{*}OriginPath").text = "/releases/other"
    elif change == "distribution":
        aws.distribution_arn = "arn:aws:cloudfront::222222222222:distribution/OTHER"
    elif change == "object-sha":
        metadata["x-amz-meta-opengeo-sha256"] = "b" * 64
    elif change == "object-length":
        metadata["content-length"] = str(int(metadata["content-length"]) + 1)
    elif change == "object-type":
        metadata["content-type"] = "text/plain"
    elif change == "object-release":
        metadata["x-amz-meta-opengeo-release"] = "framework-other"
    elif change == "invalid-version":
        metadata["x-amz-version-id"] = "!invalid!"
    else:
        aws.tag_version_mismatch = True
    with pytest.raises(PublicationConflict):
        asyncio.run(
            CloudFrontPublicationEdge(aws, "EPAGES", origin_access_control_id="EOAC").withdraw(
                claim
            )
        )
    assert not aws.tag_puts and not aws.invalidation_requests


@pytest.mark.parametrize("change", ["configuration", "version"])
def test_native_withdrawal_rejects_configuration_or_version_drift_after_invalidation(change):
    claim = native_withdrawal_fixture()
    aws = NativeWithdrawalAws(claim)
    if change == "configuration":
        aws.invalidation_mutation = lambda config: setattr(
            config.find("{*}DefaultCacheBehavior/{*}ResponseHeadersPolicyId"), "text", "changed"
        )
    else:
        aws.invalidation_mutation = lambda config: next(iter(aws.objects.values())).update(
            {"x-amz-version-id": "replacement-version"}
        )
    with pytest.raises(PublicationConflict):
        asyncio.run(
            CloudFrontPublicationEdge(aws, "EPAGES", origin_access_control_id="EOAC").withdraw(
                claim
            )
        )
    assert len(aws.tag_puts) == 8 and len(aws.invalidation_requests) == 1


@pytest.mark.parametrize(
    "change", ["nested-owner", "missing-alias", "changed-seal", "invalid-proof", "current-prefix"]
)
def test_native_withdrawal_rejects_unsealed_or_foreign_mount_projections_without_aws_calls(change):
    from opengeo_api.framework_publication_aws import _withdrawal_objects

    claim = native_withdrawal_fixture()
    files = claim["target_plan"]["files"]
    if change == "nested-owner":
        files.append({**files[-1], "path": "analysis/noaa/nested/index.html"})
    elif change == "missing-alias":
        files.pop(0)
    elif change == "changed-seal":
        next(entry for entry in files if entry["path"] == "analysis/noaa/")["source"][
            "checksumSha256"
        ] = "b" * 64
    elif change == "invalid-proof":
        next(entry for entry in files if entry["path"] == "analysis/noaa/index.html")["source"][
            "localizedOutput"
        ]["manifestChecksumSha256"] = "b" * 64
    else:
        claim["current_release_plan"]["targetPrefix"] = f"releases/framework-{UUID(int=99)}"
    with pytest.raises(PublicationConflict):
        _withdrawal_objects(claim)


@pytest.mark.parametrize("current", [False, True])
def test_native_withdrawal_root_mount_tags_only_original_and_current_index(current):
    from opengeo_api.framework_publisher import plan_publication
    from test_framework_publisher import native_fixture

    claim = native_withdrawal_fixture(current=current)
    args = native_fixture()
    args["mount_path"] = "/"
    full = plan_publication(**args, private_origin=True)
    target = {key: value for key, value in full.items() if key != "files"}
    target["files"] = [deepcopy(entry) for entry in full["files"] if entry["path"] == "index.html"]
    active = claim["current_release_plan"]
    active["files"] = deepcopy(target["files"])
    for entry in active["files"]:
        entry["source"].pop("localizedOutput", None)
        entry["source"].update(
            bucket="public",
            objectKey=target["targetPrefix"] + "/index.html",
            s3VersionId="copied-edition-version",
        )
    claim.update(mount_path="/", target_plan=target)
    aws = NativeWithdrawalAws(claim)
    retained = deepcopy(aws.objects)
    edge = CloudFrontPublicationEdge(aws, "EPAGES", origin_access_control_id="EOAC")
    receipt = asyncio.run(edge.withdraw(claim))
    prefixes = [claim["target_prefix"]]
    if current:
        prefixes.append(claim["origin"]["active_release_prefix"])
    expected = {f"/public/{prefix}/index.html" for prefix in prefixes}
    assert receipt["confirmed"] is True and len(receipt["objects"]) == len(expected)
    assert {path for path, _ in aws.tag_puts} == expected
    assert len(aws.tag_puts) == len(expected) and not expected & aws.protected_paths
    assert aws.objects == retained
    assert all(aws.tags[path] == {"retained-custody": "preserve"} for path in aws.protected_paths)


def test_native_withdrawal_already_omitted_current_mount_tags_only_original_aliases():
    claim = native_withdrawal_fixture()
    claim["current_release_plan"]["files"] = []
    aws = NativeWithdrawalAws(claim)
    edge = CloudFrontPublicationEdge(aws, "EPAGES", origin_access_control_id="EOAC")
    receipt = asyncio.run(edge.withdraw(claim))
    assert receipt["confirmed"] is True and len(receipt["objects"]) == 4
    assert len(aws.tag_puts) == 4
    assert all(
        path.startswith("/public/" + claim["target_prefix"] + "/") for path, _ in aws.tag_puts
    )
    assert all(
        claim["origin"]["active_release_prefix"] not in path
        for service, _, path, _ in aws.calls
        if service == "s3"
    )


def test_native_withdrawal_missing_integrity_metadata_cannot_write_or_acknowledge():
    claim = native_withdrawal_fixture()
    aws = NativeWithdrawalAws(claim)
    path = f"/public/{claim['target_prefix']}/analysis/noaa/index.html"
    aws.objects[path].pop("x-amz-meta-opengeo-sha256")
    with pytest.raises(PublicationConflict, match="publication_withdrawal_object_changed"):
        asyncio.run(
            CloudFrontPublicationEdge(aws, "EPAGES", origin_access_control_id="EOAC").withdraw(
                claim
            )
        )
    assert not aws.tag_puts and not aws.invalidation_requests


def test_native_withdrawal_nonstring_version_fails_closed_before_writes():
    claim = native_withdrawal_fixture()
    aws = NativeWithdrawalAws(claim)
    next(iter(aws.objects.values()))["x-amz-version-id"] = None
    with pytest.raises(PublicationConflict, match="publication_withdrawal_object_changed"):
        asyncio.run(
            CloudFrontPublicationEdge(aws, "EPAGES", origin_access_control_id="EOAC").withdraw(
                claim
            )
        )
    assert not aws.tag_puts and not aws.invalidation_requests


def test_native_withdrawal_final_metadata_deadline_keeps_acknowledgement_pending(monkeypatch):
    async def run():
        claim = native_withdrawal_fixture()
        aws = NativeWithdrawalAws(claim)
        edge = CloudFrontPublicationEdge(aws, "EPAGES", origin_access_control_id="EOAC")
        final_path = f"/public/{claim['origin']['active_release_prefix']}/analysis/noaa/index.html"
        request = aws.request
        reads = 0
        clock = [asyncio.get_running_loop().time()]

        async def final_read_exceeds_deadline(service, method, path, **kwargs):
            nonlocal reads
            result = await request(service, method, path, **kwargs)
            if (service, method, path) == ("s3", "GET", final_path) and "tagging" in kwargs.get(
                "query", {}
            ):
                reads += 1
                if reads == 3:  # Preflight, write readback, final acknowledgement readback.
                    clock[0] += 181
            return result

        aws.request = final_read_exceeds_deadline
        with monkeypatch.context() as patch:
            patch.setattr(asyncio.get_running_loop(), "time", lambda: clock[0])
            assert await edge.withdraw(claim) is None
        assert reads == 3 and len(aws.tag_puts) == 8
        assert len(aws.invalidation_requests) == 1

    asyncio.run(run())


def test_inventory_excludes_withdrawn_aliases_before_reads_and_preserves_other_owners():
    prefix = f"releases/framework-{UUID(int=1)}"
    omitted = {"analysis/noaa", "analysis/noaa.html", "analysis/noaa/", "analysis/noaa/index.html"}
    retained = {
        "index.html",
        "bhutan/index.html",
        "analysis/noaa/nested/index.html",
        "analysis/noaa-neighbor/index.html",
    }
    body = b"retained"
    files = [
        {
            "path": path,
            "bucket": "public",
            "objectKey": prefix + "/" + path,
            "etag": '"sealed"',
            "sizeBytes": len(body),
        }
        for path in sorted(omitted | retained)
    ]
    request = AsyncMock()
    storage = S3PublicationStorage(SimpleNamespace(request=request), "private", "public")
    storage._listing = AsyncMock(return_value=files)
    storage._read = AsyncMock(
        return_value=({"content-type": "text/html", "x-amz-version-id": "retained-version"}, body)
    )
    result = asyncio.run(
        storage.inventory(
            "public",
            prefix,
            excluded_mounts=("/analysis/noaa/",),
            reserved_mounts=("/", "/analysis/noaa/", "/analysis/noaa/nested/", "/bhutan/"),
        )
    )
    assert {entry["path"] for entry in result} == retained
    assert {call.args[0]["path"] for call in storage._read.await_args_list} == retained
    assert storage._read.await_count == len(retained)
    storage._listing.assert_awaited_once_with("public", prefix)
    request.assert_not_awaited()
