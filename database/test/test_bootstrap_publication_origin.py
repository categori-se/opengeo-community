"""Offline guards for explicit origin verification and restartable registration."""

from __future__ import annotations

import copy
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from contextlib import redirect_stdout

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))
SPEC = importlib.util.spec_from_file_location("bootstrap_publication_origin", SCRIPT_DIR / "bootstrap_publication_origin.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

ACCOUNT = "123456789012"
USER = "10000000-0000-4000-8000-000000000001"
SUBJECT = "10000000-0000-4000-8000-000000000002"
EMAIL = "operator@example.org"
REGISTRATION = {"id": "10000000-0000-4000-8000-000000000003",
                "organizationId": "10000000-0000-4000-8000-000000000004", "hostname": "pages.example.org",
                "selfServicePrefix": "/p/", "projectReservationLimit": 5, "enabled": True}
TARGET = {"hostname": REGISTRATION["hostname"], "bucket": "operator-public-pages", "distribution_id": "EDELIVERY",
          "origin_id": "publication-pages", "origin_access_control_id": "EXAMPLEOAC"}
FOUNDATION = {"DatabaseClusterArn": f"arn:aws:rds:us-east-1:{ACCOUNT}:cluster:example",
              "DatabaseSecretArn": f"arn:aws:secretsmanager:us-east-1:{ACCOUNT}:secret:admin-AbCd12",
              "RuntimeDatabaseSecretArn": f"arn:aws:secretsmanager:us-east-1:{ACCOUNT}:secret:runtime-AbCd12",
              "UserPoolId": "us-east-1_example"}


class MetadataDeployment:
    def __init__(self):
        self.cfg = {"account": ACCOUNT, "region": "us-east-1", "nativePublication": {"destinations": [TARGET]}}
        self.calls = []
        self.responses = {
            "get-caller-identity": {"Account": ACCOUNT},
            "admin-get-user": {"Enabled": True, "UserAttributes": [
                {"Name": key, "Value": value} for key, value in
                (("sub", SUBJECT), ("email", EMAIL), ("email_verified", "true"))]},
            "get-bucket-versioning": {"Status": "Enabled"},
            "get-bucket-encryption": {"ServerSideEncryptionConfiguration": {"Rules": [
                {"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]}},
            "get-public-access-block": {"PublicAccessBlockConfiguration": {key: True for key in
                ("BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets")}},
            "get-distribution": {"Distribution": {"Id": TARGET["distribution_id"],
                "ARN": f"arn:aws:cloudfront::{ACCOUNT}:distribution/{TARGET['distribution_id']}",
                "Status": "Deployed", "DistributionConfig": {"Enabled": True,
                "Aliases": {"Items": [TARGET["hostname"]]}, "DefaultCacheBehavior": {"TargetOriginId": TARGET["origin_id"]},
                "Origins": {"Items": [{"Id": TARGET["origin_id"], "DomainName": TARGET["bucket"] + ".s3.us-east-1.amazonaws.com",
                    "OriginAccessControlId": TARGET["origin_access_control_id"], "S3OriginConfig": {"OriginAccessIdentity": ""},
                    "OriginPath": "/releases/existing"}]}}}},
            "get-origin-access-control": {"OriginAccessControl": {"Id": TARGET["origin_access_control_id"],
                "OriginAccessControlConfig": {"SigningBehavior": "always", "SigningProtocol": "sigv4", "OriginAccessControlOriginType": "s3"}}},
        }

    def aws(self, arguments):
        self.calls.append(arguments)
        return copy.deepcopy(self.responses[arguments[1]])

    def identity(self):
        MODULE.require(self.aws(["sts", "get-caller-identity"])["Account"] == ACCOUNT, "account differs")


def origin(**changes):
    return {"id": REGISTRATION["id"], "organization_id": REGISTRATION["organizationId"],
            **{key: TARGET[key] for key in ("hostname", "bucket", "distribution_id", "origin_id")},
            "active_release_prefix": "releases/existing", "generation": 3, "enabled": True,
            "self_service_prefix": "/p/", "project_reservation_limit": 5,
            "active_publication_id": None, "verified_by": USER, **changes}


class DataApiFixture:
    """Transport peer; actual query bodies are exercised by the existing SQL suite."""
    def __init__(self, row=None):
        self.row = copy.deepcopy(row)
        self.calls = []
        self.snapshots = {}
        self.mounts = 0
        self.authorized = True
        self.principal_role = "admin"
        self.readback_mismatch = False
        self.fail_commit = False
        self.fail_rollback = False

    def _base(self, secret=None):
        return {"secretArn": secret or "admin", "resourceArn": "cluster", "database": "opengeo"}

    def _transaction_base(self, secret=None):
        return {key: value for key, value in self._base(secret).items() if key != "database"}

    def _rds_call(self, operation, **arguments):
        self.calls.append((operation, arguments))
        if operation == "begin_transaction":
            transaction = "tx-" + str(len(self.calls))
            self.snapshots[transaction] = copy.deepcopy(self.row)
            return {"transactionId": transaction}
        if operation == "commit_transaction":
            if self.fail_commit:
                self.fail_commit = False
                raise RuntimeError("commit response unavailable")
            self.snapshots.pop(arguments["transactionId"])
            return {}
        if operation == "rollback_transaction":
            if self.fail_rollback:
                raise RuntimeError("rollback unavailable")
            self.row = self.snapshots.pop(arguments["transactionId"])
            return {}
        sql = arguments["sql"]
        values = {item["name"]: next(iter(item["value"].values())) for item in arguments["parameters"]}
        if sql == MODULE.PRINCIPAL_SQL:
            rows = [{"user_id": USER, "email": EMAIL, "role": self.principal_role}]
        elif sql == MODULE.AUTHORITY_SQL:
            rows = [{"user_id": USER}] if self.authorized else []
        elif sql in (MODULE.ORIGIN_SQL, MODULE.READBACK_SQL):
            rows = [] if self.row is None else [copy.deepcopy(self.row)]
            if sql == MODULE.READBACK_SQL and self.readback_mismatch:
                rows[0]["generation"] += 1
        elif sql == MODULE.MOUNTS_SQL:
            rows = [{"count": self.mounts}]
        elif sql == MODULE.INSERT_SQL:
            self.row = origin(generation=1, active_release_prefix=values["release_prefix"],
                              enabled=values["enabled"], self_service_prefix=values["self_service_prefix"],
                              project_reservation_limit=values["project_reservation_limit"])
            rows = [copy.deepcopy(self.row)]
        elif sql == MODULE.UPDATE_SQL:
            self.row.update({key: values[key] for key in ("enabled", "self_service_prefix", "project_reservation_limit")})
            self.row["generation"] += 1
            rows = [copy.deepcopy(self.row)]
        else:
            rows = []
        return {"formattedRecords": json.dumps(rows)}

    def statements(self):
        return [arguments["sql"] for operation, arguments in self.calls if operation == "execute_statement"]


class PublicationOriginTests(unittest.TestCase):
    def apply(self, fixture, registration=None, prefix="releases/existing"):
        return MODULE.PublicationOriginBootstrap(fixture, "runtime").apply(
            registration or REGISTRATION, TARGET, subject=SUBJECT, email=EMAIL, release_prefix=prefix)

    def test_closed_registration_and_explicit_oac_required(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "registration.json"
            path.write_text(json.dumps(REGISTRATION))
            self.assertEqual(MODULE.load_registration(path, [TARGET]), (REGISTRATION, TARGET))
            for changes in ({"secret": "excluded"}, {"id": "invalid"}, {"organizationId": 1},
                            {"hostname": "other.example.org"}, {"selfServicePrefix": "/../"},
                            {"selfServicePrefix": "/a/b/c/d/e/f/g/h/"}, {"projectReservationLimit": True},
                            {"projectReservationLimit": 1001}, {"enabled": 1}, {"expectedGeneration": False}):
                with self.subTest(changes=changes), self.assertRaises(MODULE.MigrationError):
                    path.write_text(json.dumps({**REGISTRATION, **changes}))
                    MODULE.load_registration(path, [TARGET])
            path.write_text(json.dumps(REGISTRATION))
            with self.assertRaisesRegex(MODULE.MigrationError, "OAC"):
                MODULE.load_registration(path, [{key: value for key, value in TARGET.items() if key != "origin_access_control_id"}])

    def test_plan_cannot_call_cloud_or_import_boto3(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "registration.json"
            path.write_text(json.dumps(REGISTRATION))
            deployment = Mock(cfg={"account": ACCOUNT, "region": "us-east-1", "nativePublication": {"destinations": [TARGET]}}, env={})
            deployment.need.return_value = FOUNDATION
            community = Mock()
            community.Deployment.return_value = deployment
            with patch.object(MODULE, "community_module", return_value=community), patch.object(MODULE, "verify_metadata", side_effect=AssertionError("cloud")), redirect_stdout(io.StringIO()) as output:
                self.assertEqual(MODULE.main(["--config", "config.json", "--registration", str(path), "--email", EMAIL]), 0)
            self.assertEqual(json.loads(output.getvalue())["mode"], "offline-plan")
            deployment.identity.assert_not_called()
            deployment.aws.assert_not_called()
            deployment.need.assert_called_once_with("foundation.outputs.json")

    def test_apply_requires_retained_dormant_role_before_cloud(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "registration.json"
            path.write_text(json.dumps(REGISTRATION))
            deployment = Mock(cfg={"account": ACCOUNT, "region": "us-east-1", "nativePublication": {"destinations": [TARGET]}}, env={})
            deployment.need.side_effect = lambda name: FOUNDATION if name == "foundation.outputs.json" else {"databaseConfigured": False}
            community = Mock()
            community.Deployment.return_value = deployment
            with patch.object(MODULE, "community_module", return_value=community), self.assertRaisesRegex(MODULE.MigrationError, "dormant"):
                MODULE.main(["--config", "config.json", "--registration", str(path), "--email", EMAIL, "--apply"])
            deployment.identity.assert_not_called()

    def test_metadata_verifies_exact_existing_resources_without_writes(self):
        deployment = MetadataDeployment()
        self.assertEqual(MODULE.verify_metadata(deployment, TARGET, EMAIL, FOUNDATION), (SUBJECT, "releases/existing"))
        self.assertEqual(len(deployment.calls), 7)
        for arguments in deployment.calls:
            if arguments[0] == "s3api":
                self.assertIn("--expected-bucket-owner", arguments)
                self.assertEqual(arguments[-1], ACCOUNT)
        self.assertTrue(all(arguments[1].startswith(("get-", "admin-get-")) for arguments in deployment.calls))

    def test_metadata_failures_stop_before_registration(self):
        changes = [
            ("get-caller-identity", lambda row: row.update(Account="999999999999")),
            ("admin-get-user", lambda row: row.update(Enabled=False)),
            ("admin-get-user", lambda row: row["UserAttributes"][1].update(Value="other@example.org")),
            ("get-bucket-versioning", lambda row: row.update(Status="Suspended")),
            ("get-bucket-encryption", lambda row: row["ServerSideEncryptionConfiguration"]["Rules"][0]["ApplyServerSideEncryptionByDefault"].update(SSEAlgorithm="aws:kms")),
            ("get-public-access-block", lambda row: row["PublicAccessBlockConfiguration"].update(BlockPublicPolicy=False)),
            ("get-distribution", lambda row: row["Distribution"].update(ARN="arn:aws:cloudfront::999999999999:distribution/EDELIVERY")),
            ("get-distribution", lambda row: row["Distribution"].update(Status="InProgress")),
            ("get-distribution", lambda row: row["Distribution"]["DistributionConfig"]["Aliases"].update(Items=[])),
            ("get-distribution", lambda row: row["Distribution"]["DistributionConfig"]["DefaultCacheBehavior"].update(TargetOriginId="other")),
            ("get-distribution", lambda row: row["Distribution"]["DistributionConfig"].update(CacheBehaviors={"Quantity": 1, "Items": [{"PathPattern": "publications/*", "TargetOriginId": "other"}]})),
            ("get-distribution", lambda row: row["Distribution"]["DistributionConfig"]["Origins"]["Items"][0].update(OriginAccessControlId="OTHER")),
            ("get-distribution", lambda row: row["Distribution"]["DistributionConfig"]["Origins"]["Items"][0].update(DomainName="other.s3.us-east-1.amazonaws.com")),
            ("get-distribution", lambda row: row["Distribution"]["DistributionConfig"]["Origins"]["Items"][0].update(OriginPath="/releases/../private")),
            ("get-origin-access-control", lambda row: row["OriginAccessControl"]["OriginAccessControlConfig"].update(SigningBehavior="never")),
        ]
        for operation, change in changes:
            with self.subTest(operation=operation, change=change):
                deployment = MetadataDeployment()
                change(deployment.responses[operation])
                with self.assertRaises(MODULE.MigrationError):
                    MODULE.verify_metadata(deployment, TARGET, EMAIL, FOUNDATION)

    def test_database_arns_cannot_cross_account_before_cloud(self):
        for key in ("DatabaseClusterArn", "DatabaseSecretArn", "RuntimeDatabaseSecretArn"):
            deployment = MetadataDeployment()
            deployment.need = Mock(return_value={**FOUNDATION, key: FOUNDATION[key].replace(ACCOUNT, "999999999999")})
            with self.subTest(key=key), self.assertRaisesRegex(MODULE.MigrationError, "boundary"):
                MODULE.database_boundary(deployment)
            self.assertEqual(deployment.calls, [])

    def test_insert_uses_observed_prefix_and_runtime_readback(self):
        fixture = DataApiFixture()
        result = self.apply(fixture)
        self.assertEqual(result["status"], "registered")
        self.assertEqual(result["activeReleasePrefix"], "releases/existing")
        self.assertEqual(result["generation"], 1)
        self.assertEqual(result["runtimeVerification"], "passed")
        self.assertEqual(fixture.statements().count(MODULE.INSERT_SQL), 1)
        readbacks = [args for operation, args in fixture.calls if args.get("sql") == MODULE.READBACK_SQL]
        self.assertEqual(readbacks[0]["secretArn"], "runtime")
        self.assertFalse(any("INSERT INTO app.users" in sql or "UPDATE app.organization_memberships" in sql for sql in fixture.statements()))

    def test_exact_retry_preserves_advanced_release_generation_and_verifier(self):
        fixture = DataApiFixture(origin(active_release_prefix="releases/advanced", generation=20, verified_by=SUBJECT))
        before = copy.deepcopy(fixture.row)
        result = self.apply(fixture, {**REGISTRATION, "expectedGeneration": 1}, prefix="releases/advanced")
        self.assertEqual(result["status"], "reused")
        self.assertEqual(fixture.row, before)
        self.assertNotIn(MODULE.UPDATE_SQL, fixture.statements())
        self.assertNotIn(MODULE.INSERT_SQL, fixture.statements())

    def test_changed_entitlement_advances_once_without_changing_delivery(self):
        fixture = DataApiFixture(origin())
        result = self.apply(fixture, {**REGISTRATION, "projectReservationLimit": 10, "expectedGeneration": 3})
        self.assertEqual(result["status"], "updated")
        self.assertEqual(result["generation"], 4)
        self.assertEqual(fixture.row["project_reservation_limit"], 10)
        self.assertEqual(fixture.row["active_release_prefix"], "releases/existing")
        self.assertEqual(fixture.statements().count(MODULE.UPDATE_SQL), 1)

    def test_conflict_busy_stale_and_prefix_change_roll_back_without_writes(self):
        cases = [(origin(bucket="other-bucket"), REGISTRATION, "identity conflict"),
                 (origin(active_publication_id=SUBJECT), REGISTRATION, "busy"),
                 (origin(active_release_prefix="releases/advanced"), REGISTRATION, "pointer differs"),
                 (origin(), {**REGISTRATION, "enabled": False}, "expected generation"),
                 (origin(), {**REGISTRATION, "enabled": False, "expectedGeneration": 2}, "expected generation"),
                 (origin(), {**REGISTRATION, "selfServicePrefix": "/other/", "expectedGeneration": 3}, "reserved")]
        for row, registration, error in cases:
            with self.subTest(error=error):
                fixture = DataApiFixture(row)
                fixture.mounts = 1
                with self.assertRaisesRegex(MODULE.MigrationError, error):
                    self.apply(fixture, registration)
                self.assertEqual(fixture.row, row)
                self.assertEqual(fixture.calls[-1][0], "rollback_transaction")
                self.assertNotIn(MODULE.UPDATE_SQL, fixture.statements())
                self.assertNotIn(MODULE.INSERT_SQL, fixture.statements())

    def test_missing_authority_never_creates_users_or_grants(self):
        fixture = DataApiFixture()
        fixture.principal_role = "member"
        with self.assertRaisesRegex(MODULE.MigrationError, "already"):
            self.apply(fixture)
        self.assertEqual(fixture.statements(), [MODULE.PRINCIPAL_SQL])
        fixture = DataApiFixture()
        fixture.authorized = False
        with self.assertRaisesRegex(MODULE.MigrationError, "active account"):
            self.apply(fixture)
        self.assertEqual(fixture.calls[-1][0], "rollback_transaction")
        self.assertIsNone(fixture.row)

    def test_failed_readback_retains_committed_origin_and_retry_reuses_it(self):
        fixture = DataApiFixture()
        fixture.readback_mismatch = True
        with self.assertRaisesRegex(MODULE.MigrationError, "reconcile without repeating"):
            self.apply(fixture)
        committed = copy.deepcopy(fixture.row)
        fixture.readback_mismatch = False
        self.assertEqual(self.apply(fixture)["status"], "reused")
        self.assertEqual(fixture.row, committed)
        self.assertEqual(fixture.statements().count(MODULE.INSERT_SQL), 1)

    def test_commit_failure_is_not_retried_and_rollback_failure_is_explicit(self):
        fixture = DataApiFixture()
        fixture.fail_commit = True
        with self.assertRaisesRegex(RuntimeError, "commit response"):
            self.apply(fixture)
        self.assertIsNone(fixture.row)
        self.assertEqual(fixture.statements().count(MODULE.INSERT_SQL), 1)
        fixture = DataApiFixture(origin(active_publication_id=SUBJECT))
        fixture.fail_rollback = True
        with self.assertRaisesRegex(MODULE.MigrationError, "rollback could not be confirmed"):
            self.apply(fixture)


if __name__ == "__main__":
    unittest.main()
