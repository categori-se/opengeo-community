"""Exercise actual local public copies and pointer fencing without a database/cloud."""

import asyncio
import importlib.util
import sys
import tempfile
import unittest
from collections import namedtuple
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

SCRIPT = Path(__file__).with_name("local_framework_publication.py")
SPEC = importlib.util.spec_from_file_location("local_framework_publication", SCRIPT)
publication = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publication)
PILOT_SPEC = importlib.util.spec_from_file_location(
    "local_publication_pilot", Path(__file__).with_name("run-integrated-pilot-local.py")
)
pilot = importlib.util.module_from_spec(PILOT_SPEC)
PILOT_SPEC.loader.exec_module(pilot)
BRIDGE_SPEC = importlib.util.spec_from_file_location(
    "local_publication_bridge", Path(__file__).with_name("local-publication-bridge.py")
)
bridge = importlib.util.module_from_spec(BRIDGE_SPEC)
BRIDGE_SPEC.loader.exec_module(bridge)
STUDIO_SPEC = importlib.util.spec_from_file_location(
    "local_publication_studio", Path(__file__).with_name("run-integrated-studio-local.py")
)
studio = importlib.util.module_from_spec(STUDIO_SPEC)
STUDIO_SPEC.loader.exec_module(studio)


class LocalArtifactProfileTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.work = Path(self.directory.name)
        for module in (pilot, studio.pilot):
            temporary = patch.object(module, "WORK", self.work)
            temporary.start()
            self.addCleanup(temporary.stop)
        pilot.save_json("publication-profile.json", {
            "compilerImageDigest": "sha256:" + "a" * 64,
            "previewOrigin": "http://127.0.0.1:58001",
            "previewKeyPairId": "LOCALPREVIEW123",
            "previewPrivateKeyPath": "publication-preview-private.pem",
        })
        key = self.work / "publication-preview-private.pem"
        key.write_bytes(b"local wiring fixture; signing is tested separately")
        key.chmod(0o600)
        signer = patch("opengeo_api.observable_previews.CloudFrontPreviewCookieSigner")
        signer.start()
        self.addCleanup(signer.stop)

    def test_artifacts_opt_in_uses_tenant_repository_and_local_transports(self):
        from opengeo_api.rendering import PostgresRenderRepository
        from opengeo_api.tenant_database import PostgresTenantQueryExecutor

        uploads, downloads = pilot.LocalObjects(), pilot.LocalObjects()
        app = pilot.local_app(page_source_upload_storage=uploads,
                              page_source_download_storage=downloads)
        self.assertTrue(app.state.settings.portable_artifacts_enabled)
        self.assertTrue(app.state.settings.publication_artifact_builds_enabled)
        repository = app.state.render_repository
        self.assertIsInstance(repository, PostgresRenderRepository)
        self.assertIsInstance(repository._executor, PostgresTenantQueryExecutor)
        self.assertIs(repository._artifact_uploads, uploads)
        self.assertIs(repository._artifact_downloads, downloads)
        self.assertIsNone(repository._artifact_cleanup, "Local mode must never select AWS cleanup")
        (self.work / "publication-profile.json").unlink()
        ordinary = pilot.local_app()
        self.assertFalse(ordinary.state.settings.portable_artifacts_enabled)
        self.assertFalse(ordinary.state.settings.publication_artifact_builds_enabled)
        self.assertIsNone(ordinary.state.render_repository._artifact_uploads)

    def test_portable_multipart_accepts_exact_large_html_and_rejects_other_custody(self):
        import httpx2
        from opengeo_api.s3_uploads import UploadSpec

        with patch("uvicorn.run") as server:
            studio.serve(restored=True)
        app = server.call_args.args[0]
        storage = app.state.render_repository._artifact_uploads
        identity = "10000000-0000-4000-8000-000000000001"
        prefix = f"organizations/{identity}/projects/{identity}/"
        body = b"<!doctype html><title>Local portable map</title>" + b" " * 2_097_152

        async def exercise():
            async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app),
                                          base_url="http://local.invalid") as client:
                key = f"{prefix}artifacts/{identity}/uploads/{identity}/map.html"
                form = await storage.create_upload_form(UploadSpec(
                    key, "text/html", len(body), pilot.digest(body)))
                response = await client.post("/__local/upload", data=form.fields,
                    files={"file": ("map.html", body, "text/html")})
                self.assertEqual(response.status_code, 204)
                records = pilot.read_json("objects.json", {})
                self.assertEqual(len(records), 1)
                record = next(iter(records.values()))
                self.assertEqual(storage.exact(pilot.BUCKET, key, record["version_id"])[1], body)
                self.assertEqual(pilot.read_json("queue.json", []), [], "Artifact HTML is not GIS ingestion")
                for other in (f"{prefix}datasets/{identity}/uploads/{identity}/original/map.html",
                              f"{prefix}source-projects/{identity}/uploads/{identity}/files/map.html"):
                    form = await storage.create_upload_form(UploadSpec(
                        other, "text/html", len(body), pilot.digest(body)))
                    with self.assertRaises(AssertionError):
                        await client.post("/__local/upload", data=form.fields,
                            files={"file": ("map.html", body, "text/html")})
                    self.assertIn(other, pilot.read_json("issued-uploads.json", {}))
                    self.assertEqual(pilot.read_json("objects.json", {}), records)
                oversized = b" " * (4_194_304 + 65_537)
                rejected = await client.post("/__local/upload", content=oversized,
                    headers={"Content-Type": "multipart/form-data; boundary=invalid"})
                self.assertEqual(rejected.status_code, 413)
                ordinary = await client.post("/ordinary-api-path", content=b" " * 524_289)
                self.assertEqual(ordinary.status_code, 413)
                self.assertEqual(pilot.read_json("objects.json", {}), records)

        asyncio.run(exercise())


class LocalArtifactLeaseBridgeTests(unittest.TestCase):
    def test_resolution_calls_canonical_repository_with_exact_actor_job_and_token(self):
        organization, user, job, token = (uuid4() for _ in range(4))
        context_type = namedtuple("TenantContext", "user_id organization_id")
        request = {
            "operation": "resolve-artifact-lease", "organizationId": str(organization),
            "userId": str(user), "buildJobId": str(job), "coordinatorToken": str(token),
        }
        files = [{"path": "maps/retained.html"}]
        resolve = AsyncMock(return_value=files)
        app = SimpleNamespace(state=SimpleNamespace(
            observable_source_repository=SimpleNamespace(resolve_artifact_lease=resolve)
        ))
        # Only transport forwarding is isolated here. Repository lease and source
        # authorization retain their existing database/HTTP acceptance checks.
        with (
            patch.dict(sys.modules, {"opengeo_api.tenant_database": SimpleNamespace(TenantContext=context_type)}),
            patch.object(bridge.pilot, "local_app", return_value=app) as local_app,
        ):
            self.assertEqual(bridge.operate(request), files)
            resolve.assert_awaited_once_with(context_type(user, organization), job, token)
            resolve.reset_mock()
            resolve.side_effect = PermissionError("publication_artifact_lease_unavailable")
            with self.assertRaises(PermissionError):
                bridge.operate(request)
            resolve.assert_awaited_once_with(context_type(user, organization), job, token)
            for invalid in ({**request, "objectKey": "arbitrary"}, {**request, "userId": "invalid"}):
                with self.assertRaises(ValueError):
                    bridge.operate(invalid)
            self.assertEqual(local_app.call_count, 2, "Malformed requests cannot reach the repository")


class LocalPublicationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.work = Path(self.directory.name)
        self.patch = patch.object(pilot, "WORK", self.work)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.storage = publication.LocalPublicationStorage(pilot)
        self.edge = publication.LocalPublicationEdge(pilot)
        self.origin = {
            "hostname": "publication.local.invalid",
            "bucket": publication.PUBLIC_BUCKET,
            "distribution_id": "LOCALPUBLICATION",
            "origin_id": "local-publication",
        }

    def source(self, body):
        key = f"organizations/{uuid4()}/projects/{uuid4()}/source-projects/{uuid4()}/builds/{uuid4()}/output/index.html"
        record = pilot.LocalObjects().put(key, body, "text/html")
        return {
            "bucket": record["bucket"],
            "objectKey": key,
            "s3VersionId": record["version_id"],
            "etag": record["etag"],
            "sizeBytes": len(body),
            "checksumSha256": record["checksum_sha256"],
            "contentType": "text/html",
        }

    def write(self, review, body):
        prefix = f"releases/framework-{review}"
        file = {"kind": "copy", "path": "index.html", "source": self.source(body)}
        asyncio.run(self.storage.apply(publication.PUBLIC_BUCKET, prefix, file))
        asyncio.run(
            self.storage.verify(
                {
                    "bucket": publication.PUBLIC_BUCKET,
                    "targetPrefix": prefix,
                    "files": [file],
                }
            )
        )
        return prefix, file

    def test_real_copies_separate_custody_atomic_activation_and_retained_editions(self):
        first, second = uuid4(), uuid4()
        first_prefix, first_file = self.write(first, b"<h1>First approved edition</h1>")
        self.assertIsNone(publication.read_publication(pilot, "/"))
        self.assertIsNone(publication.read_publication(pilot, "/", first))
        snapshot = asyncio.run(self.edge.prepare(self.origin, "releases/bootstrap"))
        receipt = asyncio.run(
            self.edge.activate(self.origin, snapshot, first_prefix, first)
        )
        self.assertEqual(receipt["delivery"], "local")
        self.assertEqual(receipt["invalidationId"], "local-no-cache")
        self.assertIn(
            b"First approved edition", publication.read_publication(pilot, "/")["body"]
        )
        second_prefix, _ = self.write(second, b"<h1>Second approved edition</h1>")
        snapshot = asyncio.run(self.edge.prepare(self.origin, first_prefix))
        asyncio.run(self.edge.activate(self.origin, snapshot, second_prefix, second))
        self.assertIn(
            b"Second approved edition", publication.read_publication(pilot, "/")["body"]
        )
        self.assertIn(
            b"First approved edition",
            publication.read_publication(pilot, "/", first)["body"],
        )
        objects = pilot.read_json("publication-objects.json", {})
        self.assertEqual(len(objects), 2)
        self.assertTrue(
            all(
                item["bucket"] == publication.PUBLIC_BUCKET for item in objects.values()
            )
        )
        self.assertNotIn(first_file["source"]["s3VersionId"], objects)

    def test_exact_write_reuse_preserves_version_and_rejects_conflicting_bytes(self):
        review = uuid4()
        prefix, file = self.write(review, b"first")
        before = pilot.read_json("publication-objects.json")
        asyncio.run(self.storage.apply(publication.PUBLIC_BUCKET, prefix, file))
        self.assertEqual(pilot.read_json("publication-objects.json"), before)
        changed = {**file, "source": self.source(b"second")}
        with self.assertRaisesRegex(
            publication.PublicationConflict, "immutable_collision"
        ):
            asyncio.run(self.storage.apply(publication.PUBLIC_BUCKET, prefix, changed))
        self.assertEqual(pilot.read_json("publication-objects.json"), before)

    def test_pointer_compare_and_swap_rejects_concurrent_change_and_resumes_exact_activation(
        self,
    ):
        review = uuid4()
        prefix, _ = self.write(review, b"approved")
        snapshot = asyncio.run(self.edge.prepare(self.origin, "releases/bootstrap"))
        active = pilot.read_json("publication-active.json")
        pilot.save_json("publication-active.json", {**active, "generation": 2})
        with self.assertRaisesRegex(publication.PublicationConflict, "pointer_changed"):
            asyncio.run(self.edge.activate(self.origin, snapshot, prefix, review))
        pilot.save_json("publication-active.json", active)
        receipt = asyncio.run(self.edge.activate(self.origin, snapshot, prefix, review))
        self.assertEqual(
            asyncio.run(self.edge.activate(self.origin, snapshot, prefix, review)),
            receipt,
        )

    def test_output_pins_wrong_buckets_paths_and_public_byte_tampering_fail_closed(
        self,
    ):
        pin = self.source(b"private exact bytes")
        file = {
            "kind": "copy",
            "path": "index.html",
            "source": {**pin, "checksumSha256": "0" * 64},
        }
        prefix = f"releases/framework-{uuid4()}"
        with self.assertRaisesRegex(publication.PublicationConflict, "source_mismatch"):
            asyncio.run(self.storage.apply(publication.PUBLIC_BUCKET, prefix, file))
        file["source"] = {**pin, "bucket": "other-bucket"}
        with self.assertRaisesRegex(publication.PublicationConflict, "source_bucket"):
            asyncio.run(self.storage.apply(publication.PUBLIC_BUCKET, prefix, file))
        review = uuid4()
        prefix, _ = self.write(review, b"public checked bytes")
        snapshot = asyncio.run(self.edge.prepare(self.origin, "releases/bootstrap"))
        asyncio.run(self.edge.activate(self.origin, snapshot, prefix, review))
        for path in (
            "/../objects/private",
            "/%2e%2e/private",
            "//private.invalid/index.html",
        ):
            with self.assertRaises(publication.PublicationConflict):
                publication.read_publication(pilot, path, review)
        record = next(iter(pilot.read_json("publication-objects.json").values()))
        (self.work / "publication-objects" / record["version_id"]).write_bytes(
            b"changed"
        )
        with self.assertRaisesRegex(
            publication.PublicationConflict, "checksum_mismatch"
        ):
            publication.read_publication(pilot, "/", review)

    def test_derived_redirect_inventory_and_local_origin_restrictions(self):
        review = uuid4()
        prefix, file = self.write(review, b"approved")
        redirect = {"kind": "redirect", "path": "home.html", "location": "/index.html"}
        asyncio.run(self.storage.apply(publication.PUBLIC_BUCKET, prefix, redirect))
        asyncio.run(
            self.storage.verify(
                {
                    "bucket": publication.PUBLIC_BUCKET,
                    "targetPrefix": prefix,
                    "files": [file, redirect],
                }
            )
        )
        snapshot = asyncio.run(self.edge.prepare(self.origin, "releases/bootstrap"))
        asyncio.run(self.edge.activate(self.origin, snapshot, prefix, review))
        value = publication.read_publication(pilot, "/home.html", review)
        self.assertEqual(value["redirect"], "/index.html")
        inventory = asyncio.run(
            self.storage.inventory(publication.PUBLIC_BUCKET, prefix)
        )
        self.assertEqual(len(inventory), 2)
        for field, value in (
            ("hostname", "production.example"),
            ("bucket", pilot.BUCKET),
            ("distribution_id", "PRODUCTION"),
        ):
            with self.assertRaisesRegex(
                publication.PublicationConflict, "origin_invalid"
            ):
                asyncio.run(
                    self.edge.prepare(
                        {**self.origin, field: value}, "releases/bootstrap"
                    )
                )

    def test_native_sql_client_rejects_unscoped_queries_before_connection(self):
        client = publication.LocalPublicationSqlClient()
        for statement in (
            "DELETE FROM app.framework_publication_jobs",
            "SELECT app.other_function()",
            "SELECT app.claim_framework_publication(%s,%s); SELECT 1",
        ):
            with self.assertRaises(publication.PublicationConflict):
                asyncio.run(client.execute(statement, ()))


if __name__ == "__main__":
    unittest.main()
