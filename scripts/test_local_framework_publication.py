"""Exercise actual local public copies and pointer fencing without a database/cloud."""

import asyncio
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
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
