"""One offline database check using the existing temporary-database harness."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "database/scripts"))
from build_baseline import TemporaryDatabase


@unittest.skipUnless(
    os.environ.get("OPEN_GEO_CONTROLLER_POSTGRES") == "1",
    "explicit local database check",
)
class LedgerPostgresTests(unittest.TestCase):
    def test_lease_budget_scope_and_queued_work(self):
        with tempfile.TemporaryDirectory(prefix="opengeo-worker-control-") as directory:
            init = Path(directory)
            # The cached image initializes as its unprivileged postgres user.
            # This directory contains only synthetic SQL, never credentials.
            init.chmod(0o755)
            roles = [
                "opengeo_worker",
                "opengeo_runtime",
                "opengeo_connector",
                "opengeo_observable_coordinator",
            ]
            tables = [
                "processing_jobs",
                "map_render_jobs",
                "spatial_coverage_derivative_jobs",
                "pmtiles_derivative_jobs",
                "spatial_coverage_derivative_reclamations",
                "spatial_tile_cache_reclamations",
            ]
            sql = "CREATE SCHEMA app;\n" + "".join(
                f"CREATE ROLE {role};\n" for role in roles
            )
            sql += "GRANT USAGE ON SCHEMA app TO opengeo_worker,opengeo_runtime;\n"
            sql += "".join(
                f"CREATE TABLE app.{table}(state text NOT NULL); ALTER TABLE app.{table} ENABLE ROW LEVEL SECURITY; ALTER TABLE app.{table} FORCE ROW LEVEL SECURITY;\n"
                for table in tables
            )
            (init / "01-shape.sql").write_text(sql)
            (init / "02-control.sql").write_text(
                (
                    ROOT / "database/migrations/0151_worker_runtime_control.sql"
                ).read_text()
            )
            with TemporaryDatabase("podman", init, "worker-control") as db:
                token, other = str(uuid4()), str(uuid4())
                scope = "a" * 64

                def call(t=token, work=True):
                    return json.loads(
                        db.query(
                            f"SET ROLE opengeo_worker; SELECT app.claim_worker_runtime('{t}','{scope}',{str(work).lower()});"
                        ).splitlines()[-1]
                    )

                def retain(claim, window, t=token):
                    value = json.dumps(window).replace("'", "''")
                    return db.query(
                        f"SET ROLE opengeo_worker; SELECT app.advance_worker_runtime('{t}',{claim['revision']},'{value}'::jsonb);"
                    ).splitlines()[-1]

                config = {
                    "enabled": False,
                    "scopeHash": scope,
                    "windowSeconds": 300,
                    "cleanupSeconds": 300,
                    "dailyWindows": 1,
                    "totalWindows": 2,
                    "endpointHash": "b" * 64,
                    "workerHash": "c" * 64,
                }
                db.query(
                    "UPDATE app.worker_runtime_control SET configuration='"
                    + json.dumps(config)
                    + "'::jsonb;"
                )
                self.assertEqual(call()["status"], "disabled")
                db.query(
                    "UPDATE app.worker_runtime_control SET configuration=jsonb_set(configuration,'{enabled}','true');"
                )
                self.assertEqual(call(work=False)["status"], "idle")
                first = call()
                self.assertEqual(first["status"], "claimed")
                self.assertEqual(first["total_windows"], 1)
                self.assertEqual(first["reserved_seconds"], 600)
                self.assertEqual(call(other)["status"], "busy")
                # A retained window cannot extend its deadline or clear an ID.
                with self.assertRaises(subprocess.CalledProcessError):
                    retain(
                        first,
                        {
                            **first["window"],
                            "deadline": first["window"]["deadline"] + 1,
                        },
                    )
                self.assertEqual(
                    db.query(
                        f"SET ROLE opengeo_worker; SELECT app.release_worker_runtime('{other}',{first['revision']});"
                    ).splitlines()[-1],
                    "f",
                )

                self.assertEqual(retain(first, first["window"]), "t")
                self.assertEqual(retain(first, first["window"], other), "f")
                db.query(
                    "UPDATE app.worker_runtime_control SET lease_until=clock_timestamp()-interval '1 second';"
                )
                recovered = call(other)
                self.assertEqual(recovered["window"], first["window"])
                self.assertEqual(recovered["total_windows"], 1)
                self.assertEqual(retain(first, first["window"]), "f")
                final = {
                    **recovered["window"],
                    "phase": "complete",
                    "outcome": "drained",
                }
                self.assertEqual(retain(recovered, final, other), "t")
                self.assertEqual(
                    db.query(
                        f"SET ROLE opengeo_worker; SELECT app.release_worker_runtime('{other}',{recovered['revision']});"
                    ).splitlines()[-1],
                    "t",
                )
                self.assertEqual(call()["status"], "budget_exhausted")
                db.query(
                    "UPDATE app.worker_runtime_control SET lease_until=clock_timestamp()-interval '1 second';"
                )
                self.assertEqual(call()["status"], "budget_exhausted")
                # A different day may replenish the daily count, not cumulative usage.
                db.query(
                    "UPDATE app.worker_runtime_control SET budget_day=current_date-1;"
                )
                second = call()
                self.assertEqual(second["total_windows"], 2)
                self.assertEqual(second["reserved_seconds"], 1200)
                self.assertEqual(
                    retain(
                        second,
                        {
                            **second["window"],
                            "phase": "complete",
                            "outcome": "deadline-abort",
                        },
                    ),
                    "t",
                )
                db.query(
                    "UPDATE app.worker_runtime_control SET lease_until=clock_timestamp()-interval '1 second',budget_day=current_date-1;"
                )
                self.assertEqual(call()["status"], "budget_exhausted")
                db.query(
                    "INSERT INTO app.processing_jobs VALUES ('queued'),('running'),('completed');"
                )
                counts = json.loads(
                    db.query(
                        "SET ROLE opengeo_worker; SELECT app.worker_runtime_unfinished();"
                    ).splitlines()[-1]
                )
                self.assertEqual(len(counts), 6)
                self.assertEqual(counts["ingest"], 2)
                self.assertEqual(
                    db.query(
                        "SELECT has_table_privilege('opengeo_worker','app.worker_runtime_control','UPDATE');"
                    ),
                    "f",
                )
                self.assertEqual(
                    db.query(
                        "SELECT has_function_privilege('opengeo_runtime','app.claim_worker_runtime(uuid,text,boolean)','EXECUTE');"
                    ),
                    "f",
                )


if __name__ == "__main__":
    unittest.main()
