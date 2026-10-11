import json
import tempfile
import unittest
from pathlib import Path

from scripts.integrated_studio_qgis import checked_input, compare_geometry


class QgisInputTests(unittest.TestCase):
    def test_native_serialization_tolerance_does_not_hide_topology_or_coordinate_errors(
        self,
    ):
        expected = {"type": "Point", "coordinates": [-72.10000000000001, 42.0]}
        self.assertLess(
            compare_geometry({"type": "Point", "coordinates": [-72.1, 42]}, expected),
            1e-12,
        )
        for actual in [
            {"type": "Point", "coordinates": [-72.101, 42]},
            {"type": "Point", "coordinates": [-72.1, 42, 0]},
            {"type": "LineString", "coordinates": [-72.1, 42]},
        ]:
            with self.assertRaises(AssertionError):
                compare_geometry(actual, expected)

    def setUp(self):
        self.work = tempfile.TemporaryDirectory(prefix="opengeo-integrated-studio-")
        self.addCleanup(self.work.cleanup)
        self.path = Path(self.work.name) / "qgis-read.json"
        self.value = {
            "baseUrl": "http://127.0.0.1:12345/api/projects/50000000-0000-4000-8000-000000000001/services/watershed-pilot/ogc",
            "projectId": "50000000-0000-4000-8000-000000000001",
            "organizationId": "10000000-0000-4000-8000-000000000001",
            "token": "synthetic-local-owner",
            "collection": "watersheds",
            "denied": False,
        }

    def write(self):
        self.path.write_text(json.dumps(self.value))
        self.path.chmod(0o600)

    def test_owned_exact_loopback_input(self):
        self.write()
        value, origin, project = checked_input(self.path)
        self.assertEqual(value, self.value)
        self.assertEqual(origin, "http://127.0.0.1:12345")
        self.assertEqual(project, self.value["projectId"])

    def test_real_credentials_and_foreign_targets_rejected(self):
        for key, value in [
            ("token", "real-token"),
            (
                "baseUrl",
                self.value["baseUrl"].replace("127.0.0.1", "studio.opengeo.tools"),
            ),
            ("baseUrl", self.value["baseUrl"] + "?token=secret"),
            ("collection", "other"),
            ("denied", "false"),
            ("tiles", "false"),
            ("maps", "false"),
        ]:
            original = self.value.get(key)
            self.value[key] = value
            self.write()
            with self.assertRaises(ValueError):
                checked_input(self.path)
            if original is None:
                self.value.pop(key)
            else:
                self.value[key] = original

    def test_shared_or_symlinked_input_rejected(self):
        self.write()
        self.path.chmod(0o644)
        with self.assertRaises(ValueError):
            checked_input(self.path)
        self.path.chmod(0o600)
        link = self.path.parent / "linked.json"
        link.symlink_to(self.path)
        with self.assertRaises(ValueError):
            checked_input(link)


if __name__ == "__main__":
    unittest.main()
