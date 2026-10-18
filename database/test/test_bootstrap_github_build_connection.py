"""Offline registration, authority and recovery checks; owning SQL runs separately."""

from __future__ import annotations

import copy
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))
SPEC = importlib.util.spec_from_file_location("bootstrap_github_build_connection", SCRIPT_DIR / "bootstrap_github_build_connection.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

ACCOUNT = "333333333333"
USER = "10000000-0000-4000-8000-000000000001"
SUBJECT = "10000000-0000-4000-8000-000000000002"
EMAIL = "operator@example.org"
COMPILER = {
    "coordinatorDatabaseSecretArn": f"arn:aws:secretsmanager:us-east-1:{ACCOUNT}:secret:coordinator-AbCd12",
    "githubAppSecretArn": f"arn:aws:secretsmanager:us-east-1:{ACCOUNT}:secret:github-app-AbCd12",
    "repository": {"fullName": "operator/compiler-runtime", "id": 123, "ownerId": 456, "private": False},
    "runtimeSha": "a" * 40,
    "connection": {"id": "10000000-0000-4000-8000-000000000003",
                   "organizationId": "10000000-0000-4000-8000-000000000004", "installationId": 12, "workflowId": 34},
    "enabled": False, "freeExecutionVerified": False,
}
FOUNDATION = {
    "DatabaseClusterArn": f"arn:aws:rds:us-east-1:{ACCOUNT}:cluster:independent",
    "DatabaseSecretArn": f"arn:aws:secretsmanager:us-east-1:{ACCOUNT}:secret:admin-AbCd12",
    "RuntimeDatabaseSecretArn": f"arn:aws:secretsmanager:us-east-1:{ACCOUNT}:secret:runtime-AbCd12",
    "WorkerDatabaseSecretArn": f"arn:aws:secretsmanager:us-east-1:{ACCOUNT}:secret:worker-AbCd12",
    "CommunityApplicationKmsKeyArn": f"arn:aws:kms:us-east-1:{ACCOUNT}:key/11111111-2222-4333-8444-555555555555",
    "UserPoolId": "us-east-1_example",
    "GeodataBucketName": "independent-data",
}


def connection(**changes):
    value = COMPILER["connection"]
    return {"id": value["id"], "organization_id": value["organizationId"],
            "installation_id": value["installationId"], "repository_id": COMPILER["repository"]["id"],
            "repository": COMPILER["repository"]["fullName"], "build_workflow_id": value["workflowId"],
            "runtime_sha": COMPILER["runtimeSha"], "enabled": True, "verified_by": USER,
            "verified_at": "2026-10-17T00:00:00Z", **changes}


class Deployment:
    def __init__(self):
        self.cfg = {"account": ACCOUNT, "region": "us-east-1", "profile": "independent", "nativeGitHubBuild": copy.deepcopy(COMPILER)}
        self.env, self.calls = {}, []
        self.outputs = {"foundation.outputs.json": copy.deepcopy(FOUNDATION),
                        "images.json": {"api": "sha256:" + "b" * 64, "compiler": "sha256:" + "c" * 64}}
        self.user = {"Enabled": True, "UserAttributes": [{"Name": key, "Value": value} for key, value in
                    (("sub", SUBJECT), ("email", EMAIL), ("email_verified", "true"))]}
        self.secrets = {
            COMPILER["coordinatorDatabaseSecretArn"]: {"ARN": COMPILER["coordinatorDatabaseSecretArn"],
                "KmsKeyId": FOUNDATION["CommunityApplicationKmsKeyArn"]},
            COMPILER["githubAppSecretArn"]: {"ARN": COMPILER["githubAppSecretArn"]},
        }

    def need(self, name):
        return self.outputs[name]

    def identity(self):
        self.calls.append("identity")

    def aws(self, arguments):
        self.calls.append(arguments)
        if arguments[0:2] == ["secretsmanager", "describe-secret"]:
            return copy.deepcopy(self.secrets[arguments[-1]])
        return copy.deepcopy(self.user)


class GitHub:
    def __init__(self):
        self.calls = []
        self.repository = {"id": 123, "owner": {"id": 456}, "full_name": "operator/compiler-runtime",
                           "private": False, "archived": False, "disabled": False}
        self.workflow = {"id": 34, "state": "active", "path": ".github/workflows/studio-framework-build.yml"}
        self.ref = COMPILER["runtimeSha"]

    def _call(self, method, path):
        self.calls.append((method, path))
        if method != "GET":
            raise AssertionError("Registration cannot change GitHub content or dispatch")
        return copy.deepcopy(self.repository if path == "" else self.workflow)

    def _read_ref(self, path):
        self.calls.append(("GET", "/git/ref/" + path))
        return self.ref


class DataApiFixture:
    """Transport peer; the existing SQL suite executes the helper's actual queries."""
    def __init__(self, rows=None):
        self.connections = copy.deepcopy(rows or [])
        self.calls, self.snapshots = [], {}
        self.principal_role, self.authorized = "admin", True
        self.readback_mismatch = False
        self.commit_response_lost = False
        self.rollback_unavailable = False
        self.requests_used = 0

    def _base(self, secret=None):
        return {"secretArn": secret or "admin", "resourceArn": "cluster", "database": "opengeo"}

    def _transaction_base(self, secret=None):
        return {key: value for key, value in self._base(secret).items() if key != "database"}

    def _rds_call(self, operation, **arguments):
        self.requests_used += 1
        self.calls.append((operation, arguments))
        if operation == "begin_transaction":
            transaction = "tx-" + str(len(self.calls))
            self.snapshots[transaction] = copy.deepcopy(self.connections)
            return {"transactionId": transaction}
        if operation == "commit_transaction":
            self.snapshots.pop(arguments["transactionId"])
            if self.commit_response_lost:
                self.commit_response_lost = False
                raise RuntimeError("committed response unavailable")
            return {}
        if operation == "rollback_transaction":
            if self.rollback_unavailable:
                raise RuntimeError("rollback unavailable")
            self.connections = self.snapshots.pop(arguments["transactionId"])
            return {}
        sql = arguments["sql"]
        values = {item["name"]: next(iter(item["value"].values())) for item in arguments["parameters"]}
        if sql == MODULE.PRINCIPAL_SQL:
            rows = [{"user_id": USER, "email": EMAIL, "role": self.principal_role}]
        elif sql == MODULE.AUTHORITY_SQL:
            rows = [{"user_id": USER}] if self.authorized else []
        elif sql in (MODULE.CONNECTION_SQL, MODULE.READBACK_SQL):
            rows = copy.deepcopy(self.connections)
            if sql == MODULE.READBACK_SQL and self.readback_mismatch:
                rows = []
        elif sql == MODULE.INSERT_SQL:
            self.connections.append(connection())
            rows = copy.deepcopy(self.connections)
        else:
            rows = []
        return {"formattedRecords": json.dumps(rows)}

    def statements(self):
        return [arguments["sql"] for operation, arguments in self.calls if operation == "execute_statement"]


class GitHubBuildConnectionTests(unittest.TestCase):
    def apply(self, fixture):
        return MODULE.GitHubBuildConnectionBootstrap(fixture, "runtime").apply(COMPILER, subject=SUBJECT, email=EMAIL)

    def test_plan_uses_retained_inputs_without_commands_or_runtime_dependencies(self):
        deployment = Deployment()
        community = Mock()
        community.Deployment.return_value = deployment
        with patch.object(MODULE, "community_module", return_value=community), \
                patch.object(MODULE, "verify_identity", side_effect=AssertionError("cloud")), \
                patch.object(MODULE, "github_repository", side_effect=AssertionError("secret")), \
                patch.dict(sys.modules, {"boto3": None}), redirect_stdout(io.StringIO()) as output:
            self.assertEqual(MODULE.main(["--config", "operator.json", "--email", EMAIL]), 0)
        plan = json.loads(output.getvalue())
        self.assertEqual(plan["mode"], "offline-plan")
        self.assertEqual(plan["limits"]["awsMetadataRequests"], 4)
        self.assertEqual(plan["limits"]["githubRequests"], 4)
        self.assertEqual(deployment.calls, [])
        community.load_config.assert_called_once_with(Path("operator.json"))

    def test_retained_resources_and_credential_isolation_fail_before_cloud(self):
        for mutate in [
            lambda d: d.outputs["foundation.outputs.json"].update(DatabaseClusterArn=FOUNDATION["DatabaseClusterArn"].replace(ACCOUNT, "999999999999")),
            lambda d: d.outputs["foundation.outputs.json"].update(CommunityApplicationKmsKeyArn=FOUNDATION["CommunityApplicationKmsKeyArn"].replace(ACCOUNT, "999999999999")),
            lambda d: d.outputs["images.json"].update(compiler="latest"),
            lambda d: d.cfg["nativeGitHubBuild"].update(coordinatorDatabaseSecretArn=FOUNDATION["RuntimeDatabaseSecretArn"]),
            lambda d: d.cfg["nativeGitHubBuild"].update(githubAppSecretArn=COMPILER["coordinatorDatabaseSecretArn"]),
            lambda d: (d.cfg.update(nativePublication={"publisherDatabaseSecretArn": COMPILER["githubAppSecretArn"]})),
            lambda d: (d.cfg.update(nativePreview={"privateKeySecretArn": COMPILER["coordinatorDatabaseSecretArn"]})),
        ]:
            deployment = Deployment()
            mutate(deployment)
            with self.subTest(mutate=mutate), self.assertRaises(MODULE.MigrationError):
                MODULE.retained_inputs(deployment)
            self.assertEqual(deployment.calls, [])

    def test_existing_exact_enabled_verified_cognito_identity_is_required(self):
        deployment = Deployment()
        self.assertEqual(MODULE.verify_identity(deployment, FOUNDATION, EMAIL), SUBJECT)
        self.assertEqual(deployment.calls, ["identity", ["cognito-idp", "admin-get-user", "--user-pool-id", FOUNDATION["UserPoolId"], "--username", EMAIL]])
        for mutate in [lambda user: user.update(Enabled=False),
                       lambda user: user["UserAttributes"][1].update(Value="other@example.org"),
                       lambda user: user["UserAttributes"][2].update(Value="false")]:
            deployment = Deployment()
            mutate(deployment.user)
            with self.assertRaises(MODULE.MigrationError):
                MODULE.verify_identity(deployment, FOUNDATION, EMAIL)

    def test_secret_metadata_proves_exact_runtime_encryption_with_only_two_bounded_reads(self):
        for short_key in (False, True):
            deployment = Deployment()
            if short_key:
                deployment.secrets[COMPILER["coordinatorDatabaseSecretArn"]]["KmsKeyId"] = FOUNDATION["CommunityApplicationKmsKeyArn"].rsplit("/", 1)[-1]
            MODULE.verify_secret_encryption(deployment, FOUNDATION, COMPILER)
            self.assertEqual(deployment.calls, [
                ["secretsmanager", "describe-secret", "--secret-id", COMPILER["coordinatorDatabaseSecretArn"]],
                ["secretsmanager", "describe-secret", "--secret-id", COMPILER["githubAppSecretArn"]],
            ])
        deployment = Deployment()
        deployment.secrets[COMPILER["githubAppSecretArn"]]["KmsKeyId"] = "alias/aws/secretsmanager"
        MODULE.verify_secret_encryption(deployment, FOUNDATION, COMPILER)
        key = f"arn:aws:kms:us-east-1:{ACCOUNT}:key/22222222-3333-4444-8555-666666666666"
        for observed in (key, key.rsplit("/", 1)[-1]):
            deployment = Deployment()
            deployment.secrets[COMPILER["githubAppSecretArn"]]["KmsKeyId"] = observed
            MODULE.verify_secret_encryption(deployment, FOUNDATION, {**COMPILER, "githubAppSecretKeyArn": key})

    def test_wrong_or_mutable_secret_encryption_stops_before_secret_read_or_registration(self):
        for name, changes, declared_key in [
            ("coordinatorDatabaseSecretArn", {"ARN": COMPILER["githubAppSecretArn"]}, None),
            ("coordinatorDatabaseSecretArn", {"DeletedDate": "2026-10-18"}, None),
            ("githubAppSecretArn", {"DeletedDate": "2026-10-18"}, None),
            ("coordinatorDatabaseSecretArn", {"KmsKeyId": "alias/aws/secretsmanager"}, None),
            ("coordinatorDatabaseSecretArn", {"KmsKeyId": "alias/current"}, None),
            ("coordinatorDatabaseSecretArn", {"KmsKeyId": FOUNDATION["CommunityApplicationKmsKeyArn"].replace(ACCOUNT, "999999999999")}, None),
            ("githubAppSecretArn", {"KmsKeyId": FOUNDATION["CommunityApplicationKmsKeyArn"]}, None),
            ("githubAppSecretArn", {"KmsKeyId": "alias/current"}, None),
            ("githubAppSecretArn", {"KmsKeyId": "alias/aws/secretsmanager"}, FOUNDATION["CommunityApplicationKmsKeyArn"]),
            ("githubAppSecretArn", {"KmsKeyId": "22222222-3333-4444-8555-666666666666"}, FOUNDATION["CommunityApplicationKmsKeyArn"]),
        ]:
            deployment = Deployment()
            deployment.secrets[COMPILER[name]].update(changes)
            compiler = {**COMPILER, **({"githubAppSecretKeyArn": declared_key} if declared_key else {})}
            with self.subTest(name=name, changes=changes), self.assertRaises(MODULE.MigrationError):
                MODULE.verify_secret_encryption(deployment, FOUNDATION, compiler)
            self.assertTrue(all(call[:2] == ["secretsmanager", "describe-secret"] for call in deployment.calls))

    def test_apply_rejects_mismatched_encryption_before_loading_credentials_or_database(self):
        deployment = Deployment()
        deployment.secrets[COMPILER["coordinatorDatabaseSecretArn"]]["KmsKeyId"] = "alias/current"
        community = Mock()
        community.Deployment.return_value = deployment
        with patch.object(MODULE, "community_module", return_value=community), \
                patch.object(MODULE, "github_repository") as credentials, \
                patch.object(MODULE, "DataApiMigrator") as database, \
                patch.dict(sys.modules, {"boto3": None}), self.assertRaisesRegex(MODULE.MigrationError, "encryption"):
            MODULE.main(["--config", "operator.json", "--email", EMAIL, "--apply"])
        credentials.assert_not_called()
        database.assert_not_called()

    def test_github_checks_exact_repository_owner_privacy_workflow_and_ref_with_reads_only(self):
        github = GitHub()
        MODULE.verify_github(COMPILER, github)
        self.assertEqual(github.calls, [("GET", ""), ("GET", "/actions/workflows/34"),
                                       ("GET", "/git/ref/heads/studio-runtime-" + COMPILER["runtimeSha"])])
        for group, changes in [("repository", {"id": 124}), ("repository", {"owner": {"id": 457}}),
                               ("repository", {"full_name": "operator/renamed"}), ("repository", {"private": True}),
                               ("repository", {"disabled": True}), ("repository", {"archived": True}),
                               ("workflow", {"id": 35}), ("workflow", {"state": "disabled_manually"}),
                               ("workflow", {"path": ".github/workflows/other.yml"})]:
            github = GitHub()
            getattr(github, group).update(changes)
            with self.subTest(group=group, changes=changes), self.assertRaises(MODULE.MigrationError):
                MODULE.verify_github(COMPILER, github)
        github = GitHub()
        github.ref = "b" * 40
        with self.assertRaisesRegex(MODULE.MigrationError, "reference"):
            MODULE.verify_github(COMPILER, github)

    def test_runtime_secret_and_github_adapters_receive_only_the_explicit_operator_context(self):
        credentials = SimpleNamespace(access_key="HOST_KEY", secret_key="HOST_SECRET", token="HOST_TOKEN")
        session = Mock(region_name="us-east-1")
        session.get_credentials.return_value.get_frozen_credentials.return_value = credentials
        settings, secret_store, transport, tokens, repository = (Mock() for _ in range(5))
        async def read_secret():
            return 77, b"IN_MEMORY_PRIVATE_KEY"
        secret_store.return_value.get_github_app_credentials = read_secret
        tokens.return_value.issue.return_value = "IN_MEMORY_INSTALLATION_TOKEN"
        modules = {
            "opengeo_api.cognito_provisioning": SimpleNamespace(AwsCredentials=lambda access, secret, token: (access, secret, token)),
            "opengeo_api.config": SimpleNamespace(Settings=settings),
            "opengeo_api.connections": SimpleNamespace(AwsConnectionSecretStore=secret_store),
            "opengeo_api.github_publications": SimpleNamespace(GitHubConnection=lambda *args: args,
                GitHubHttpTransport=transport, GitHubInstallationTokens=tokens, GitHubPublicationRepository=repository),
        }
        with patch.dict(sys.modules, modules), redirect_stdout(io.StringIO()) as output:
            self.assertIs(MODULE.github_repository(COMPILER, FOUNDATION, session), repository.return_value)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(settings.call_args.kwargs, {"env": "dev", "aws_region": "us-east-1",
            "geodata_bucket": FOUNDATION["GeodataBucketName"], "geodata_kms_key_arn": FOUNDATION["CommunityApplicationKmsKeyArn"],
            "github_app_secret_arn": COMPILER["githubAppSecretArn"]})
        self.assertEqual(secret_store.call_args.kwargs["credentials"].load(), ("HOST_KEY", "HOST_SECRET", "HOST_TOKEN"))
        tokens.assert_called_once_with(77, b"IN_MEMORY_PRIVATE_KEY", transport.return_value)
        tokens.return_value.issue.assert_called_once_with((12, 123, "operator/compiler-runtime"), write_source=False)
        repository.assert_called_once_with((12, 123, "operator/compiler-runtime"), "IN_MEMORY_INSTALLATION_TOKEN", transport.return_value)

    def test_new_connection_has_actual_runtime_readback_without_membership_or_source_writes(self):
        fixture = DataApiFixture()
        result = self.apply(fixture)
        self.assertEqual(result, {"status": "registered", "connectionId": COMPILER["connection"]["id"],
                                  "organizationId": COMPILER["connection"]["organizationId"], "runtimeVerification": "passed"})
        self.assertEqual(fixture.statements().count(MODULE.INSERT_SQL), 1)
        readback = [arguments for operation, arguments in fixture.calls if arguments.get("sql") == MODULE.READBACK_SQL]
        self.assertEqual(readback[0]["secretArn"], "runtime")
        self.assertFalse(any("UPDATE " in sql or "INSERT INTO app.users" in sql or "observable_github_links" in sql
                             for sql in fixture.statements()))

    def test_exact_retry_is_read_only_and_preserves_verifier_and_timestamp(self):
        fixture = DataApiFixture([connection(verified_by=SUBJECT, verified_at="2026-09-01T00:00:00Z")])
        before = copy.deepcopy(fixture.connections)
        self.assertEqual(self.apply(fixture)["status"], "reused")
        self.assertEqual(fixture.connections, before)
        self.assertNotIn(MODULE.INSERT_SQL, fixture.statements())

    def test_conflicting_or_disabled_records_and_another_build_grant_preserve_history(self):
        conflicts = [{"id": USER}, {"organization_id": SUBJECT}, {"installation_id": 13}, {"repository_id": 124},
                     {"repository": "operator/renamed"}, {"build_workflow_id": 35}, {"runtime_sha": "b" * 40}, {"enabled": False}]
        for rows in [[connection(**changes)] for changes in conflicts] + [[connection(), connection(id=USER)]]:
            fixture = DataApiFixture(rows)
            before = copy.deepcopy(fixture.connections)
            with self.subTest(rows=rows), self.assertRaises(MODULE.MigrationError):
                self.apply(fixture)
            self.assertEqual(fixture.connections, before)
            self.assertNotIn(MODULE.INSERT_SQL, fixture.statements())

    def test_existing_admin_authority_is_checked_before_any_write(self):
        for attribute, value in [("principal_role", "member"), ("authorized", False)]:
            fixture = DataApiFixture()
            setattr(fixture, attribute, value)
            with self.subTest(attribute=attribute), self.assertRaisesRegex(MODULE.MigrationError, "administrator"):
                self.apply(fixture)
            self.assertEqual(fixture.connections, [])
            self.assertNotIn(MODULE.INSERT_SQL, fixture.statements())

    def test_committed_readback_failure_reconciles_without_another_insert(self):
        fixture = DataApiFixture()
        fixture.readback_mismatch = True
        with self.assertRaisesRegex(MODULE.MigrationError, "readback differs"):
            self.apply(fixture)
        self.assertEqual(fixture.connections, [connection()])
        fixture.readback_mismatch = False
        self.assertEqual(self.apply(fixture)["status"], "reused")
        self.assertEqual(fixture.statements().count(MODULE.INSERT_SQL), 1)

    def test_uncertain_committed_response_reuses_the_original_row_after_interruption(self):
        fixture = DataApiFixture()
        fixture.commit_response_lost = True
        with self.assertRaisesRegex(MODULE.MigrationError, "rollback could not be confirmed"):
            self.apply(fixture)
        self.assertEqual(self.apply(fixture)["status"], "reused")
        self.assertEqual(fixture.statements().count(MODULE.INSERT_SQL), 1)


if __name__ == "__main__":
    unittest.main()
