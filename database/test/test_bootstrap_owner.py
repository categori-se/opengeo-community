from __future__ import annotations

import importlib.util
import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))
MODULE_PATH = SCRIPT_DIR / "bootstrap_owner.py"
SPEC = importlib.util.spec_from_file_location("opengeo_bootstrap_owner", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class BootstrapOwnerPlanTest(unittest.TestCase):
    def test_accepts_existing_uppercase_project_code_contract(self) -> None:
        output = io.StringIO()
        with redirect_stdout(output):
            result = MODULE.main(
                [
                    "--subject",
                    "347824f8-10e1-7084-5885-5ad00327cb12",
                    "--email",
                    "2301690+aaronkyle@users.noreply.github.com",
                    "--display-name",
                    "Aaron Dennis",
                    "--organization-name",
                    "OpenGeo public demo",
                    "--organization-slug",
                    "opengeo-demo",
                    "--project-name",
                    "OpenGeo starter project",
                    "--project-code",
                    "OPEN-GEO-STARTER",
                ]
            )
        self.assertEqual(result, 0)
        plan = json.loads(output.getvalue())
        self.assertEqual(plan["mode"], "plan")
        self.assertEqual(plan["project"], "OpenGeo starter project")

    def test_rejects_project_code_with_path_punctuation(self) -> None:
        with self.assertRaisesRegex(MODULE.MigrationError, "invalid project code"):
            MODULE.main(
                [
                    "--subject",
                    "347824f8-10e1-7084-5885-5ad00327cb12",
                    "--email",
                    "2301690+aaronkyle@users.noreply.github.com",
                    "--display-name",
                    "Aaron Dennis",
                    "--project-code",
                    "../OPEN-GEO-STARTER",
                ]
            )


if __name__ == "__main__":
    unittest.main()
