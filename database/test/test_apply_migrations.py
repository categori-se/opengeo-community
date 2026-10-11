from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch
import contextlib
import io
import types

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "apply_migrations.py"
SPEC = importlib.util.spec_from_file_location("opengeo_apply_migrations", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class SqlSplitterTests(unittest.TestCase):
    def test_preserves_dollar_quoted_functions_and_semicolons(self) -> None:
        source = """
        BEGIN;
        CREATE FUNCTION app.example() RETURNS trigger LANGUAGE plpgsql AS $body$
        BEGIN
          NEW.value := 'semi;colon';
          -- a comment ; stays in the body
          RETURN NEW;
        END;
        $body$;
        COMMIT;
        """
        statements = MODULE.split_sql(source)
        self.assertEqual(len(statements), 3)
        self.assertEqual(MODULE.statement_command(statements[0]), "BEGIN")
        self.assertIn("NEW.value := 'semi;colon';", statements[1])
        self.assertEqual(MODULE.statement_command(statements[2]), "COMMIT")

    def test_handles_nested_comments_and_quoted_identifiers(self) -> None:
        statements = MODULE.split_sql(
            "/* outer; /* nested; */ done */ BEGIN; SELECT \"a;b\", 'c;d'; COMMIT;"
        )
        self.assertEqual(len(statements), 3)
        self.assertEqual(MODULE.validate_transactions("example.sql", statements), 1)

    def test_rejects_unterminated_input(self) -> None:
        with self.assertRaisesRegex(MODULE.MigrationError, "unterminated SQL dollar"):
            MODULE.split_sql("BEGIN; SELECT $$missing;")


class MigrationPlanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.database_root = Path(__file__).resolve().parents[1]
        cls.migrations = MODULE.load_migrations(cls.database_root / "migrations")
        cls.baseline = MODULE.load_baseline(
            cls.database_root / "baselines" / "0089_opengeo_schema.sql",
            cls.database_root / "baselines" / "0089_opengeo_schema.manifest.json",
            cls.migrations,
        )

    def test_loads_exact_contiguous_167_migrations(self) -> None:
        self.assertEqual(len(self.migrations), 167)
        self.assertEqual(self.migrations[0].name, "0001_platform_foundation.sql")
        self.assertEqual(
            self.migrations[-1].name,
            "0167_observable_catalog_reference_workspaces.sql",
        )
        self.assertEqual([item.number for item in self.migrations], list(range(1, 168)))

    def test_implicit_migration_is_atomic_and_retains_its_source_checksum(self):
        with tempfile.TemporaryDirectory() as directory:
            source = b"-- legacy file without outer transaction\nSELECT 1; SELECT $$semi;colon$$;\n"
            path = Path(directory) / "0001_example.sql"
            path.write_bytes(source)
            migration = MODULE.load_migrations(path.parent)[0]
            self.assertEqual(migration.statements, ("BEGIN", "-- legacy file without outer transaction\nSELECT 1", "SELECT $$semi;colon$$", "COMMIT"))
            self.assertEqual(migration.transaction_count, 1)
            self.assertEqual(migration.sha256, MODULE.hashlib.sha256(source).hexdigest())
            self.assertEqual(path.read_bytes(), source)

    def test_partially_explicit_migration_still_fails_before_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "0001_example.sql"
            path.write_text("SELECT 1; BEGIN; SELECT 2; COMMIT;")
            with self.assertRaisesRegex(MODULE.MigrationError, "outside an explicit transaction"):
                MODULE.load_migrations(path.parent)

    def test_all_statements_fit_the_data_api_limit(self) -> None:
        largest = max(
            len(statement)
            for migration in self.migrations
            for statement in migration.statements
        )
        self.assertLessEqual(largest, MODULE.MAX_DATA_API_SQL_CHARS)

    def test_verified_baseline_matches_release_89_and_the_migration_chain(self) -> None:
        self.assertEqual(self.baseline.release, 89)
        self.assertEqual(self.baseline.transaction_count, 1)
        self.assertEqual(len(self.baseline.migrations), 89)
        self.assertEqual(
            self.baseline.sha256,
            "e0d9445ff482873ce4bd05df6fb19c2560fada27c4e1dbcbd7977395becb6d9a",
        )
        self.assertLessEqual(
            max(len(statement) for statement in self.baseline.statements),
            MODULE.MAX_DATA_API_SQL_CHARS,
        )

    def test_older_baseline_still_rejects_changes_to_its_recorded_prefix(self) -> None:
        changed = [replace(self.migrations[0], sha256="0" * 64), *self.migrations[1:]]
        with self.assertRaisesRegex(MODULE.MigrationError, "does not match the migration chain"):
            MODULE.load_baseline(self.baseline.path, self.baseline.manifest_path, changed)

    def test_rejects_a_stale_baseline_manifest(self) -> None:
        manifest_path = (
            self.database_root / "baselines" / "0089_opengeo_schema.manifest.json"
        )
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["baselineSha256"] = "0" * 64
        with tempfile.TemporaryDirectory() as temporary:
            tampered = Path(temporary) / "manifest.json"
            tampered.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(
                MODULE.MigrationError,
                "does not match the migration chain",
            ):
                MODULE.load_baseline(self.baseline.path, tampered, self.migrations)

    def test_rejects_unreviewed_baseline_generator_provenance(self) -> None:
        manifest_path = (
            self.database_root / "baselines" / "0089_opengeo_schema.manifest.json"
        )
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["generatorImage"] = "docker.io/postgis/postgis:latest"
        with tempfile.TemporaryDirectory() as temporary:
            tampered = Path(temporary) / "manifest.json"
            tampered.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(
                MODULE.MigrationError,
                "does not match the migration chain",
            ):
                MODULE.load_baseline(self.baseline.path, tampered, self.migrations)

    def test_preserves_enum_commits_before_new_values_are_referenced(self) -> None:
        expected_two_transaction_migrations = {
            "0007_governed_pmtiles_sources.sql",
            "0060_governed_geojson_archives.sql",
            "0061_bounded_feature_source_archives.sql",
            "0065_exact_repository_object_sources.sql",
            "0078_deleted_feature_restoration.sql",
            "0079_project_collaboration.sql",
            "0089_imageserver_sources.sql",
            "0129_mapserver_sources.sql",
            "0156_referenced_cog_sources.sql",
        }
        actual = {
            migration.name
            for migration in self.migrations
            if migration.transaction_count == 2
        }
        self.assertEqual(actual, expected_two_transaction_migrations)
        self.assertEqual(sum(item.transaction_count for item in self.migrations), 176)

    def test_connector_password_configuration_is_explicit_and_optional(self) -> None:
        self.assertIn("opengeo_connector", MODULE.ALLOWED_DATABASE_ROLES)
        without_connector = MODULE.parse_args([])
        self.assertIsNone(without_connector.connector_secret_arn)
        connector_arn = (
            "arn:aws:secretsmanager:us-east-1:111111111111:"
            "secret:opengeo/dev/connector-AbCd12"
        )
        with_connector = MODULE.parse_args(
            [
                "--connector-secret-arn",
                connector_arn,
            ]
        )
        self.assertIn("opengeo/dev/connector", with_connector.connector_secret_arn)

    def test_observable_coordinator_configuration_is_explicit_and_optional(
        self,
    ) -> None:
        self.assertIn("opengeo_observable_coordinator", MODULE.ALLOWED_DATABASE_ROLES)
        without_coordinator = MODULE.parse_args([])
        self.assertIsNone(without_coordinator.observable_coordinator_secret_arn)
        coordinator_arn = (
            "arn:aws:secretsmanager:us-east-1:111111111111:"
            "secret:opengeo/dev/observable-coordinator-AbCd12"
        )
        configured = MODULE.parse_args(
            ["--observable-coordinator-secret-arn", coordinator_arn]
        )
        self.assertEqual(configured.observable_coordinator_secret_arn, coordinator_arn)

    def test_dataset_verifier_configuration_is_explicit_and_optional(self) -> None:
        self.assertIn("opengeo_dataset_verifier", MODULE.ALLOWED_DATABASE_ROLES)
        without_verifier = MODULE.parse_args([])
        self.assertIsNone(without_verifier.dataset_verifier_secret_arn)
        verifier_arn = (
            "arn:aws:secretsmanager:us-east-1:111111111111:"
            "secret:opengeo/dev/dataset-verifier-AbCd12"
        )
        configured = MODULE.parse_args(["--dataset-verifier-secret-arn", verifier_arn])
        self.assertEqual(configured.dataset_verifier_secret_arn, verifier_arn)

    def test_framework_publisher_configuration_is_explicit_and_optional(self) -> None:
        self.assertIn("opengeo_framework_publisher", MODULE.ALLOWED_DATABASE_ROLES)
        self.assertIsNone(MODULE.parse_args([]).framework_publisher_secret_arn)
        secret = (
            "arn:aws:secretsmanager:us-east-1:111111111111:"
            "secret:opengeo/production/framework-publisher-AbCd12"
        )
        configured = MODULE.parse_args(["--framework-publisher-secret-arn", secret])
        self.assertEqual(configured.framework_publisher_secret_arn, secret)

    def test_source_archiver_configuration_is_explicit_and_optional(self) -> None:
        self.assertIn("opengeo_source_archiver", MODULE.ALLOWED_DATABASE_ROLES)
        without_archiver = MODULE.parse_args([])
        self.assertIsNone(without_archiver.source_archiver_secret_arn)
        archiver_arn = (
            "arn:aws:secretsmanager:us-east-1:111111111111:"
            "secret:opengeo/dev/source-archiver-AbCd12"
        )
        configured = MODULE.parse_args(
            ["--source-archiver-secret-arn", archiver_arn]
        )
        self.assertEqual(configured.source_archiver_secret_arn, archiver_arn)

    def test_repository_copier_configuration_is_explicit_and_optional(self) -> None:
        self.assertIn("opengeo_repository_copier", MODULE.ALLOWED_DATABASE_ROLES)
        without_copier = MODULE.parse_args([])
        self.assertIsNone(without_copier.repository_copier_secret_arn)
        copier_arn = (
            "arn:aws:secretsmanager:us-east-1:111111111111:"
            "secret:opengeo/dev/repository-copier-AbCd12"
        )
        configured = MODULE.parse_args(
            ["--repository-copier-secret-arn", copier_arn]
        )
        self.assertEqual(configured.repository_copier_secret_arn, copier_arn)


class ColdResumeTests(unittest.TestCase):
    def test_retries_only_the_explicit_pre_acceptance_resume_error(self) -> None:
        class ResumeError(Exception):
            def __init__(self) -> None:
                self.response = {"Error": {"Code": "DatabaseResumingException"}}

        class RdsData:
            calls = 0

            def execute_statement(self, **_kwargs):
                self.calls += 1
                if self.calls < 3:
                    raise ResumeError()
                return {"numberOfRecordsUpdated": 0}

        rds_data = RdsData()
        migrator = MODULE.DataApiMigrator(
            rds_data=rds_data,
            secrets_manager=object(),
            cluster_arn="cluster",
            admin_secret_arn="secret",
            database="opengeo",
        )
        sleeps = []
        original_sleep = MODULE.time.sleep
        MODULE.time.sleep = sleeps.append
        try:
            response = migrator._rds_call("execute_statement", sql="SELECT 1")
        finally:
            MODULE.time.sleep = original_sleep

        self.assertEqual(response, {"numberOfRecordsUpdated": 0})
        self.assertEqual(rds_data.calls, 3)
        self.assertEqual(sleeps, [2, 4])

    def test_commit_uses_the_data_api_transaction_shape_without_database(self) -> None:
        class StrictRdsData:
            def __init__(self) -> None:
                self.commits = []

            def begin_transaction(self, **kwargs):
                self._assert_statement_shape(kwargs)
                return {"transactionId": "transaction-1"}

            def execute_statement(self, **kwargs):
                self._assert_statement_shape(kwargs)
                return {"numberOfRecordsUpdated": 0}

            def commit_transaction(self, **kwargs):
                self.assert_transaction_shape(kwargs)
                self.commits.append(kwargs)
                return {"transactionStatus": "Transaction Committed"}

            @staticmethod
            def _assert_statement_shape(kwargs) -> None:
                if "database" not in kwargs:
                    raise AssertionError("statement request must include database")

            @staticmethod
            def assert_transaction_shape(kwargs) -> None:
                if "database" in kwargs:
                    raise AssertionError("commit request must not include database")

        rds_data = StrictRdsData()
        migrator = MODULE.DataApiMigrator(
            rds_data=rds_data,
            secrets_manager=object(),
            cluster_arn="cluster",
            admin_secret_arn="secret",
            database="opengeo",
        )
        migration = MODULE.Migration(
            path=Path("0001_example.sql"),
            name="0001_example.sql",
            number=1,
            sha256="a" * 64,
            statements=("BEGIN", "SELECT 1", "COMMIT"),
            transaction_count=1,
        )

        migrator._apply_one(migration)

        self.assertEqual(len(rds_data.commits), 1)


class FreshDatabaseBaselineTests(unittest.TestCase):
    def test_applies_one_direct_baseline_and_verifies_its_complete_ledger(self) -> None:
        digest = "a" * 64

        class RdsData:
            def __init__(self) -> None:
                self.executed = []
                self.commits = []

            def begin_transaction(self, **kwargs):
                self.executed.append(("begin", kwargs))
                return {"transactionId": "baseline-transaction"}

            def execute_statement(self, **kwargs):
                sql = kwargs["sql"]
                if "to_regnamespace('app')" in sql:
                    return {
                        "formattedRecords": json.dumps(
                            [{"app_schema": False, "migration_ledger": False}]
                        )
                    }
                if "SELECT migration_name, sha256" in sql:
                    return {
                        "formattedRecords": json.dumps(
                            [{"migration_name": "0001_example.sql", "sha256": digest}]
                        )
                    }
                self.executed.append(("statement", kwargs))
                return {"numberOfRecordsUpdated": 0}

            def commit_transaction(self, **kwargs):
                if "database" in kwargs:
                    raise AssertionError("commit request must not include database")
                self.commits.append(kwargs)
                return {"transactionStatus": "Transaction Committed"}

            def rollback_transaction(self, **_kwargs):
                raise AssertionError("passing baseline must not roll back")

        baseline = MODULE.Baseline(
            path=Path("0001_opengeo_schema.sql"),
            manifest_path=Path("0001_opengeo_schema.manifest.json"),
            name="0001_opengeo_schema.sql",
            release=1,
            sha256="b" * 64,
            migration_chain_sha256="c" * 64,
            migrations=(("0001_example.sql", digest),),
            statements=("BEGIN", "CREATE SCHEMA app", "COMMIT"),
            transaction_count=1,
        )
        rds_data = RdsData()
        migrator = MODULE.DataApiMigrator(
            rds_data=rds_data,
            secrets_manager=object(),
            cluster_arn="cluster",
            admin_secret_arn="secret",
            database="opengeo",
        )

        applied = migrator.apply_baseline(baseline)

        self.assertEqual(applied, ["0001_example.sql"])
        self.assertEqual(len(rds_data.commits), 1)
        self.assertEqual(
            [kind for kind, _request in rds_data.executed],
            ["begin", "statement"],
        )

    def test_rejects_a_partial_schema_or_ledger_state(self) -> None:
        class RdsData:
            @staticmethod
            def execute_statement(**_kwargs):
                return {
                    "formattedRecords": json.dumps(
                        [{"app_schema": True, "migration_ledger": False}]
                    )
                }

        migrator = MODULE.DataApiMigrator(
            rds_data=RdsData(),
            secrets_manager=object(),
            cluster_arn="cluster",
            admin_secret_arn="secret",
            database="opengeo",
        )
        with self.assertRaisesRegex(MODULE.MigrationError, "inconsistent"):
            migrator.database_initialization_state()


class BoundedSchemaUpgradeTests(unittest.TestCase):
    def fixture(self):
        return [MODULE.Migration(path=Path(f"{number:04d}_example.sql"),
            name=f"{number:04d}_example.sql", number=number, sha256=str(number)*64,
            statements=("BEGIN", "SELECT 1", "COMMIT"), transaction_count=1)
            for number in (1, 2)]

    def migrator(self, ledger=None, *, state="managed", retain_writes=True):
        migrations = self.fixture()
        class MemoryLedger(MODULE.DataApiMigrator):
            def __init__(self):
                self.ledger = dict(ledger if ledger is not None else {migrations[0].name:migrations[0].sha256})
                self.writes = []
            def database_initialization_state(self): return state
            def ensure_ledger(self): raise AssertionError("schema-only must not initialize a ledger")
            def applied(self): return dict(self.ledger)
            def _apply_one(self, migration):
                self.writes.append(migration.name)
                if retain_writes: self.ledger[migration.name] = migration.sha256
        return MemoryLedger()

    def test_bounded_prefix_does_not_parse_later_sql_and_rejects_missing_or_invalid_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for number in (1, 2): (root/f"{number:04d}_example.sql").write_text("BEGIN; SELECT 1; COMMIT;")
            (root/"0003_later.sql").write_text("SELECT $$invalid later migration")
            self.assertEqual([m.number for m in MODULE.load_migrations(root, through_version=2)], [1, 2])
            for bound in (0, True, 10000, 4):
                with self.subTest(bound=bound), self.assertRaises(MODULE.MigrationError):
                    MODULE.load_migrations(root, through_version=bound)
            (root/"0001_example.sql").unlink()
            with self.assertRaises(MODULE.MigrationError): MODULE.load_migrations(root, through_version=2)

    def test_schema_upgrade_skips_committed_rows_and_verifies_final_ledger(self):
        migrator = self.migrator()
        self.assertEqual(migrator.apply(self.fixture(), through_version=2, schema_only=True),
                         (["0002_example.sql"], ["0001_example.sql"]))
        self.assertEqual(migrator.writes, ["0002_example.sql"])
        self.assertEqual(migrator.apply(self.fixture(), through_version=2, schema_only=True),
                         ([], ["0001_example.sql", "0002_example.sql"]))
        self.assertEqual(migrator.writes, ["0002_example.sql"])

    def test_schema_upgrade_refuses_changed_missing_or_later_history_before_writes(self):
        for ledger in [{"0001_example.sql":"f"*64}, {"0002_example.sql":"2"*64},
                       {"0001_example.sql":"1"*64, "0003_later.sql":"3"*64}]:
            migrator = self.migrator(ledger)
            with self.subTest(ledger=ledger), self.assertRaises(MODULE.MigrationError):
                migrator.apply(self.fixture(), through_version=2, schema_only=True)
            self.assertEqual(migrator.writes, [])
        migrator = self.migrator(state="fresh")
        with self.assertRaises(MODULE.MigrationError): migrator.apply(self.fixture(), through_version=2, schema_only=True)
        self.assertEqual(migrator.writes, [])

    def test_unconfirmed_final_ledger_stops_instead_of_repeating_a_write(self):
        migrator = self.migrator(retain_writes=False)
        with self.assertRaisesRegex(MODULE.MigrationError, "readback differs"):
            migrator.apply(self.fixture(), through_version=2, schema_only=True)
        self.assertEqual(migrator.writes, ["0002_example.sql"])

    def test_schema_only_requires_bound_and_rejects_role_secret_arguments_before_credentials(self):
        with self.assertRaises(MODULE.MigrationError): MODULE.main(["--schema-only"])
        for role in ("runtime", "worker", "connector", "dataset-verifier", "observable-coordinator",
                     "framework-publisher", "source-archiver", "repository-copier"):
            with self.subTest(role=role), self.assertRaises(MODULE.MigrationError):
                MODULE.main(["--schema-only", "--through-version", "167", f"--{role}-secret-arn", "secret"])

    def test_schema_only_main_uses_no_secret_client_or_role_password_changes(self):
        clients=[]
        class Config:
            def __init__(self, **kwargs): self.kwargs=kwargs
        class Session:
            def __init__(self, **kwargs): pass
            def client(self, name, **kwargs):
                clients.append((name, kwargs["config"].kwargs))
                return types.SimpleNamespace(get_caller_identity=lambda:{"Account":"111111111111"})
        class Migrator:
            def __init__(self, **kwargs):
                self.assert_no_secret = kwargs["secrets_manager"] is None
                if not self.assert_no_secret: raise AssertionError("unexpected secret client")
                if (kwargs["request_limit"], kwargs["initial_requests"], kwargs["rollback_reserve"]) != (150, 1, 2):
                    raise AssertionError("schema execution was not finitely bounded")
                if not 0 < kwargs["deadline"] - MODULE.time.monotonic() <= 600:
                    raise AssertionError("schema execution deadline is invalid")
                self.requests_used = kwargs["initial_requests"]
            def apply(self, migrations, **kwargs):
                if kwargs != {"through_version":167,"schema_only":True,"after_version":160}: raise AssertionError(kwargs)
                if len(migrations) != 167 or any(item.statements for item in migrations[:160]):
                    raise AssertionError("retained history was parsed or omitted")
                if any(not item.statements for item in migrations[160:]):
                    raise AssertionError("new migrations were not parsed")
                return [], ["existing"]
        cluster="arn:aws:rds:us-east-1:111111111111:cluster:opengeo-production"
        secret="arn:aws:secretsmanager:us-east-1:111111111111:secret:admin-abcdef"
        with patch.dict(sys.modules, {"boto3":types.SimpleNamespace(Session=Session),
                                      "botocore.config":types.SimpleNamespace(Config=Config)}), \
             patch.object(MODULE, "DataApiMigrator", Migrator), contextlib.redirect_stdout(io.StringIO()):
            result=MODULE.main(["--schema-only","--after-version","160","--through-version","167","--apply",
                "--expected-account","111111111111","--cluster-arn",cluster,"--admin-secret-arn",secret])
        self.assertEqual(result,0)
        self.assertEqual([name for name,_ in clients],["sts","rds-data"])
        self.assertTrue(all(config=={"retries":{"total_max_attempts":1},"connect_timeout":10,"read_timeout":35}
                            for _,config in clients))

    def test_after_version_hashes_historical_sql_without_parsing_or_executing_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            history = b"SELECT $$unterminated historical SQL\xff"
            (root/"0001_example.sql").write_bytes(history)
            (root/"0002_example.sql").write_text("BEGIN; SELECT 1; COMMIT;")
            migrations = MODULE.load_migrations(root, through_version=2, after_version=1)
            self.assertEqual(migrations[0].sha256, MODULE.hashlib.sha256(history).hexdigest())
            self.assertEqual(migrations[0].statements, ())
            self.assertEqual(migrations[0].transaction_count, 0)
            self.assertEqual(migrations[1].statements, ("BEGIN", "SELECT 1", "COMMIT"))
            with self.assertRaises(MODULE.MigrationError):
                MODULE.load_migrations(root, through_version=2)
            migrator = self.migrator(ledger={})
            with self.assertRaisesRegex(MODULE.MigrationError, "metadata-only"):
                migrator.apply(migrations, through_version=2, schema_only=True)
            self.assertEqual(migrator.writes, [])

    def test_after_version_requires_the_exact_complete_historical_ledger_before_writes(self):
        migrations = self.fixture()
        migrations[0] = replace(migrations[0], statements=(), transaction_count=0)
        for ledger in ({}, {migrations[0].name:"f"*64},
                       {migrations[1].name:migrations[1].sha256}):
            migrator = self.migrator(ledger=ledger)
            with self.subTest(ledger=ledger), self.assertRaises(MODULE.MigrationError):
                migrator.apply(migrations, through_version=2, schema_only=True, after_version=1)
            self.assertEqual(migrator.writes, [])
        migrator = self.migrator()
        self.assertEqual(migrator.apply(migrations, through_version=2, schema_only=True, after_version=1),
                         ([migrations[1].name], [migrations[0].name]))
        self.assertEqual(migrator.writes, [migrations[1].name])

    def test_after_158_applies_missing_159_and_161_through_167_while_skipping_exact_160(self):
        migrations = MODULE.load_migrations(
            MODULE_PATH.parent.parent / "migrations", through_version=167, after_version=158
        )
        ledger = {item.name: item.sha256 for item in migrations if item.number <= 158 or item.number == 160}
        self.assertEqual(len(ledger), 159)
        migrator = self.migrator(ledger=ledger)
        applied, skipped = migrator.apply(
            migrations, through_version=167, schema_only=True, after_version=158
        )
        expected = [item.name for item in migrations if item.number == 159 or 161 <= item.number <= 167]
        retained_160 = next(item.name for item in migrations if item.number == 160)
        self.assertEqual(applied, expected)
        self.assertEqual(len(applied), 8)
        self.assertEqual(migrator.writes, expected)
        self.assertIn(retained_160, skipped)
        self.assertNotIn(retained_160, migrator.writes)
        self.assertTrue(all(not item.statements for item in migrations[:158]))
        self.assertEqual(migrator.ledger, {item.name: item.sha256 for item in migrations})
        missing_history = dict(ledger)
        del missing_history[migrations[157].name]
        migrator = self.migrator(ledger=missing_history)
        with self.assertRaisesRegex(MODULE.MigrationError, "retained migration history is incomplete"):
            migrator.apply(migrations, through_version=167, schema_only=True, after_version=158)
        self.assertEqual(migrator.writes, [])

    def test_after_version_is_rejected_outside_a_larger_bounded_schema_only_upgrade(self):
        invalid_arguments = [
            ["--after-version","160","--through-version","167"],
            ["--schema-only","--after-version","160"],
            ["--schema-only","--after-version","0","--through-version","167"],
            ["--schema-only","--after-version","167","--through-version","167"],
        ]
        for arguments in invalid_arguments:
            with self.subTest(arguments=arguments), self.assertRaises(MODULE.MigrationError):
                MODULE.main(arguments)
        with tempfile.TemporaryDirectory() as directory:
            for after in (0, True, 2, 3):
                with self.subTest(after=after), self.assertRaises(MODULE.MigrationError):
                    MODULE.load_migrations(Path(directory), through_version=2, after_version=after)
        migrator = self.migrator()
        with self.assertRaises(MODULE.MigrationError):
            migrator.apply(self.fixture(), through_version=2, after_version=1)
        self.assertEqual(migrator.writes, [])

    def budget_migrator(self, rds, *, request_limit=5):
        return MODULE.DataApiMigrator(rds_data=rds, secrets_manager=None,
            cluster_arn="cluster", admin_secret_arn="admin", database="opengeo",
            request_limit=request_limit, deadline=600, initial_requests=1, rollback_reserve=2)

    def test_schema_request_budget_reserves_rollback_without_resetting_after_failure(self):
        events=[]
        rds=types.SimpleNamespace(
            begin_transaction=lambda **kwargs: events.append("begin") or {"transactionId":"tx"},
            execute_statement=lambda **kwargs: events.append("execute") or {},
            commit_transaction=lambda **kwargs: events.append("commit") or {},
            rollback_transaction=lambda **kwargs: events.append("rollback") or {})
        with patch.object(MODULE.time, "monotonic", return_value=0):
            migrator=self.budget_migrator(rds)
            with self.assertRaisesRegex(MODULE.MigrationError, "request budget"):
                migrator._apply_one(self.fixture()[0])
            self.assertEqual(events,["begin","execute","rollback"])
            self.assertEqual(migrator.requests_used,4)
            with self.assertRaises(MODULE.MigrationError): migrator._rds_call("execute_statement")
            migrator._rds_call("rollback_transaction")
            self.assertEqual(migrator.requests_used,5)
            with self.assertRaises(MODULE.MigrationError): migrator._rds_call("rollback_transaction")
            self.assertEqual(events,["begin","execute","rollback","rollback"])

    def test_schema_resume_attempts_share_budget_and_uncertain_commits_are_not_retried(self):
        attempts=[]
        resuming=RuntimeError("resuming")
        resuming.response={"Error":{"Code":"DatabaseResumingException","Message":"resuming"}}
        def execute(**kwargs):
            attempts.append("resume")
            raise resuming
        def commit(**kwargs):
            attempts.append("commit")
            raise TimeoutError("unknown commit")
        with patch.object(MODULE.time,"monotonic",return_value=0), \
             patch.object(MODULE.time,"sleep"), contextlib.redirect_stderr(io.StringIO()):
            migrator=self.budget_migrator(types.SimpleNamespace(execute_statement=execute))
            with self.assertRaisesRegex(MODULE.MigrationError,"request budget"):
                migrator._rds_call("execute_statement")
            self.assertEqual(attempts,["resume","resume"])
            self.assertEqual(migrator.requests_used,3)
            migrator=self.budget_migrator(types.SimpleNamespace(commit_transaction=commit))
            with self.assertRaises(TimeoutError): migrator._rds_call("commit_transaction")
            self.assertEqual(attempts.count("commit"),1)
            self.assertEqual(migrator.requests_used,2)

    def test_schema_deadline_bounds_continued_ddl_and_preserves_final_rollback_time(self):
        clock=[0.0]; attempts=[]
        timeout=RuntimeError("accepted DDL")
        timeout.response={"Error":{"Code":"StatementTimeoutException","Message":"accepted DDL"}}
        running=RuntimeError("running")
        running.response={"Error":{"Code":"DatabaseErrorException","Message":"still running a query"}}
        def execute(**kwargs):
            attempts.append(kwargs["sql"])
            raise timeout if kwargs["sql"] != "SELECT 1" else running
        def sleep(seconds): clock[0] += seconds
        rds=types.SimpleNamespace(execute_statement=execute,
            rollback_transaction=lambda **kwargs: attempts.append("rollback") or {})
        with patch.object(MODULE.time,"monotonic",side_effect=lambda:clock[0]), \
             patch.object(MODULE.time,"sleep",side_effect=sleep), contextlib.redirect_stderr(io.StringIO()):
            migrator=self.budget_migrator(rds,request_limit=150)
            clock[0]=450
            with self.assertRaisesRegex(MODULE.MigrationError,"time budget"):
                migrator._execute_migration_statement(transaction_id="tx",statement="CREATE TABLE exact_input()",label="fixture")
            self.assertEqual(attempts.count("CREATE TABLE exact_input()"),1)
            self.assertEqual(attempts.count("SELECT 1"),3)
            self.assertEqual(migrator.requests_used,5)
            migrator._rds_call("rollback_transaction")
            self.assertEqual(migrator.requests_used,6)
            clock[0]=556
            with self.assertRaisesRegex(MODULE.MigrationError,"time budget"):
                migrator._rds_call("rollback_transaction")
            self.assertEqual(attempts.count("rollback"),1)


if __name__ == "__main__":
    unittest.main()
