"""Focused boundaries for the populated local recovery checkpoint."""

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from scripts import integrated_studio_restore as restore


class ObjectRestoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="opengeo-restore-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        (self.source / "objects").mkdir(parents=True)
        self.version = str(uuid4())
        self.body = b"exact original bytes"
        (self.source / "objects" / self.version).write_bytes(self.body)
        self.record = {
            "version_id": self.version,
            "size_bytes": len(self.body),
            "checksum_sha256": restore.digest(self.body),
            "key": "../../not-a-filesystem-path",
        }
        self.index = {self.version: self.record}
        self.write_index()

    def write_index(self):
        (self.source / "objects.json").write_text(json.dumps(self.index))

    def test_snapshot_and_restored_objects_keep_exact_version_and_bytes(self):
        snapshot, target = self.root / "snapshot", self.root / "restored"
        proof = restore.copy_objects(self.source, snapshot)
        self.assertEqual(restore.copy_objects(snapshot, target), proof)
        self.assertEqual((target / "objects" / self.version).read_bytes(), self.body)
        self.assertEqual(
            (target / "objects.json").read_bytes(),
            (self.source / "objects.json").read_bytes(),
        )
        self.assertEqual(
            proof["objects"],
            [
                {
                    "version": self.version,
                    "sha256": restore.digest(self.body),
                    "bytes": len(self.body),
                }
            ],
        )
        self.assertFalse((self.root / "not-a-filesystem-path").exists())

    def test_changed_bytes_stop_before_creating_destination(self):
        (self.source / "objects" / self.version).write_bytes(b"changed bytes")
        with self.assertRaisesRegex(ValueError, "sealed version"):
            restore.copy_objects(self.source, self.root / "target")
        self.assertFalse((self.root / "target").exists())

    def test_missing_extra_and_symlinked_versions_are_not_silently_skipped(self):
        object_path = self.source / "objects" / self.version
        object_path.unlink()
        with self.assertRaisesRegex(ValueError, "regular local files"):
            restore.copy_objects(self.source, self.root / "missing")
        object_path.symlink_to(self.source / "objects.json")
        with self.assertRaisesRegex(ValueError, "regular local files"):
            restore.copy_objects(self.source, self.root / "linked")
        object_path.unlink()
        object_path.write_bytes(self.body)
        (self.source / "objects" / str(uuid4())).write_bytes(b"unindexed")
        with self.assertRaisesRegex(ValueError, "unindexed"):
            restore.copy_objects(self.source, self.root / "extra")

    def test_version_identity_and_existing_destination_cannot_be_replaced(self):
        target = self.root / "existing"
        target.mkdir()
        (target / "keep").write_text("preserve")
        with self.assertRaises(FileExistsError):
            restore.copy_objects(self.source, target)
        self.assertEqual((target / "keep").read_text(), "preserve")
        self.record["version_id"] = str(uuid4())
        self.write_index()
        with self.assertRaisesRegex(ValueError, "identity"):
            restore.copy_objects(self.source, self.root / "bad-version")

    def test_unowned_or_noncanonical_work_cannot_start_a_restore(self):
        for path in [Path("/tmp"), self.root, self.source, Path("relative")]:
            with self.assertRaises(ValueError):
                restore.checked_work(path)


class DatabaseRestoreTests(unittest.TestCase):
    def test_non_test_targets_and_unexpected_programs_never_execute(self):
        with patch.object(restore.subprocess, "run") as run:
            for name in [
                "OpenGeo-demo-Foundation",
                "postgres",
                "opengeo-baseline-integrated-studio;bad",
                "opengeo-baseline-integrated-studio-1-abc",
            ]:
                with self.assertRaisesRegex(ValueError, "non-test"):
                    restore.dump_command(
                        SimpleNamespace(name=name), "pg_restore", "--clean"
                    )
            with self.assertRaisesRegex(ValueError, "Only native"):
                restore.dump_command(
                    SimpleNamespace(
                        name="opengeo-baseline-integrated-studio-1-12345678"
                    ),
                    "sh",
                )
            run.assert_not_called()

    def test_exact_native_restore_command_keeps_archive_on_stdin(self):
        with patch.object(
            restore.subprocess, "run", return_value=SimpleNamespace(stdout=b"")
        ) as run:
            restore.dump_command(
                SimpleNamespace(
                    name="opengeo-baseline-integrated-studio-restore-1-12345678"
                ),
                "pg_restore",
                "--dbname=postgres",
                "--exit-on-error",
                body=b"sealed dump",
            )
            self.assertEqual(
                run.call_args.args[0],
                [
                    "podman",
                    "exec",
                    "--interactive",
                    "opengeo-baseline-integrated-studio-restore-1-12345678",
                    "pg_restore",
                    "--username=postgres",
                    "--dbname=postgres",
                    "--exit-on-error",
                ],
            )
            self.assertEqual(run.call_args.kwargs["input"], b"sealed dump")
            self.assertTrue(run.call_args.kwargs["check"])
            self.assertEqual(run.call_args.kwargs["timeout"], 90)


if __name__ == "__main__":
    unittest.main()
