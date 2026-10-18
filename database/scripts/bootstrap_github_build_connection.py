#!/usr/bin/env python3
"""Register the standalone account's verified canonical-source GitHub build grant."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import re
import sys
import time

from apply_migrations import DataApiMigrator, MigrationError
from bootstrap_owner import COGNITO_SUBJECT, EMAIL
from bootstrap_publication_origin import community_module, database_boundary, parameters, require

ROOT = Path(__file__).resolve().parents[2]
AUTHORITY_SQL = """SELECT identity.id AS user_id
FROM app.users identity
JOIN app.organization_memberships member ON member.user_id = identity.id
JOIN app.organizations organization ON organization.id = member.organization_id
WHERE identity.cognito_subject = :subject AND identity.email = :email
  AND organization.id = CAST(:organization_id AS uuid)
  AND organization.status = 'active' AND member.role = 'admin'
FOR SHARE OF identity, member, organization"""
PRINCIPAL_SQL = """SELECT user_id, email, organization_role::text AS role
FROM app.resolve_principal(:subject)
WHERE organization_id = CAST(:organization_id AS uuid)"""
CONTEXT_SQL = """SELECT set_config('app.organization_id', :organization_id, true),
set_config('app.user_id', :user_id, true)"""
CONNECTION_SQL = """SELECT id, organization_id, installation_id, repository_id, repository,
enabled, verified_at, verified_by, build_workflow_id, runtime_sha
FROM app.github_publication_connections
WHERE id = CAST(:id AS uuid) OR (organization_id = CAST(:organization_id AS uuid)
  AND (repository_id = :repository_id OR
    (enabled AND build_workflow_id IS NOT NULL AND runtime_sha IS NOT NULL)))
ORDER BY id FOR UPDATE"""
INSERT_SQL = """INSERT INTO app.github_publication_connections
  (id, organization_id, installation_id, repository_id, repository, enabled,
   verified_at, verified_by, build_workflow_id, runtime_sha)
VALUES (CAST(:id AS uuid), CAST(:organization_id AS uuid), :installation_id,
  :repository_id, :repository, true, clock_timestamp(), CAST(:user_id AS uuid),
  :workflow_id, :runtime_sha)
RETURNING id, organization_id, installation_id, repository_id, repository,
enabled, verified_at, verified_by, build_workflow_id, runtime_sha"""
READBACK_SQL = """SELECT id, organization_id, installation_id, repository_id, repository,
enabled, verified_at, verified_by, build_workflow_id, runtime_sha
FROM app.github_publication_connections
WHERE organization_id = CAST(:organization_id AS uuid)
  AND (id = CAST(:id AS uuid) OR
    (enabled AND build_workflow_id IS NOT NULL AND runtime_sha IS NOT NULL))
ORDER BY id"""


def retained_inputs(deployment):
    require("nativeGitHubBuild" in deployment.cfg, "nativeGitHubBuild configuration is required")
    foundation = database_boundary(deployment)
    images = deployment.need("images.json")
    require(all(isinstance(images.get(key), str) and re.fullmatch(r"sha256:[0-9a-f]{64}", images[key])
                for key in ("api", "compiler")), "both retained immutable runtime images are required")
    compiler = deployment.cfg["nativeGitHubBuild"]
    key = foundation.get("CommunityApplicationKmsKeyArn", "")
    require(isinstance(key, str) and re.fullmatch(r"arn:aws:kms:us-east-1:" + deployment.cfg["account"]
            + r":key/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", key),
            "retained application key does not match the configured AWS boundary")
    protected_secrets = {foundation.get(key) for key in ("DatabaseSecretArn", "RuntimeDatabaseSecretArn", "WorkerDatabaseSecretArn")}
    protected_secrets.update({deployment.cfg.get("nativePublication", {}).get("publisherDatabaseSecretArn"),
                              deployment.cfg.get("nativePreview", {}).get("privateKeySecretArn")})
    require(compiler["coordinatorDatabaseSecretArn"] not in
            protected_secrets,
            "compiler requires a dedicated coordinator database credential")
    require(compiler["githubAppSecretArn"] not in
            protected_secrets | {compiler["coordinatorDatabaseSecretArn"]},
            "GitHub App credential must be separate from database credentials")
    return foundation, compiler


def verify_identity(deployment, foundation, email):
    deployment.identity()
    user = deployment.aws(["cognito-idp", "admin-get-user", "--user-pool-id", foundation["UserPoolId"], "--username", email])
    attributes = {item["Name"]: item["Value"] for item in user.get("UserAttributes", [])}
    subject = attributes.get("sub", "")
    require(user.get("Enabled") is True and attributes.get("email_verified") == "true"
            and attributes.get("email") == email and COGNITO_SUBJECT.fullmatch(subject),
            "registration requires an enabled principal with the exact verified email and subject")
    return subject


def verify_secret_encryption(deployment, foundation, compiler):
    for name, expected_key in (("coordinatorDatabaseSecretArn", foundation["CommunityApplicationKmsKeyArn"]),
                               ("githubAppSecretArn", compiler.get("githubAppSecretKeyArn"))):
        arn = compiler[name]
        metadata = deployment.aws(["secretsmanager", "describe-secret", "--secret-id", arn])
        require(metadata.get("ARN") == arn and "DeletedDate" not in metadata,
                "build credential secret identity differs or deletion is scheduled")
        if expected_key is None:
            require("KmsKeyId" not in metadata or metadata["KmsKeyId"] == "alias/aws/secretsmanager",
                    "GitHub App secret requires its declared exact customer-managed key")
        else:
            require(metadata.get("KmsKeyId") in {expected_key, expected_key.rsplit("/", 1)[-1]},
                    "build credential encryption differs from the exact runtime IAM key")


def github_repository(compiler, foundation, session):
    # Reuse the runtime secret parser, signing and fixed-origin GitHub client.
    # Credentials stay in memory; neither the compiler nor command output sees them.
    sys.path.insert(0, str(ROOT / "services/api/src"))
    from opengeo_api.cognito_provisioning import AwsCredentials
    from opengeo_api.config import Settings
    from opengeo_api.connections import AwsConnectionSecretStore
    from opengeo_api.github_publications import (
        GitHubConnection, GitHubHttpTransport, GitHubInstallationTokens, GitHubPublicationRepository,
    )

    class Credentials:
        def load(self):
            frozen = session.get_credentials().get_frozen_credentials()
            return AwsCredentials(frozen.access_key, frozen.secret_key, frozen.token)

    settings = Settings(env="dev", aws_region=session.region_name,
                        geodata_bucket=foundation["GeodataBucketName"],
                        geodata_kms_key_arn=foundation["CommunityApplicationKmsKeyArn"],
                        github_app_secret_arn=compiler["githubAppSecretArn"])
    app_id, private_key = asyncio.run(AwsConnectionSecretStore(settings, credentials=Credentials()).get_github_app_credentials())
    connection = GitHubConnection(compiler["connection"]["installationId"], compiler["repository"]["id"], compiler["repository"]["fullName"])
    transport = GitHubHttpTransport()
    token = GitHubInstallationTokens(app_id, private_key, transport).issue(connection, write_source=False)
    return GitHubPublicationRepository(connection, token, transport)


def verify_github(compiler, github):
    expected = compiler["repository"]
    repository = github._call("GET", "")
    require(repository.get("id") == expected["id"] and repository.get("owner", {}).get("id") == expected["ownerId"]
            and repository.get("full_name") == expected["fullName"] and repository.get("private") is expected["private"]
            and repository.get("archived") is False and repository.get("disabled") is False,
            "GitHub installation repository identity differs")
    workflow_id = compiler["connection"]["workflowId"]
    workflow = github._call("GET", f"/actions/workflows/{workflow_id}")
    require(workflow.get("id") == workflow_id and workflow.get("state") == "active"
            and workflow.get("path") == ".github/workflows/studio-framework-build.yml",
            "GitHub build workflow identity differs")
    require(github._read_ref("heads/studio-runtime-" + compiler["runtimeSha"]) == compiler["runtimeSha"],
            "GitHub build runtime reference differs")


class GitHubBuildConnectionBootstrap:
    def __init__(self, migrator, runtime_secret_arn):
        self.migrator, self.runtime_secret_arn = migrator, runtime_secret_arn

    def rows(self, sql, values, transaction=None, *, runtime=False):
        arguments = {**self.migrator._base(self.runtime_secret_arn if runtime else None),
                     "sql": sql, "parameters": parameters(values), "formatRecordsAs": "JSON"}
        if transaction is not None:
            arguments["transactionId"] = transaction
        records = json.loads(self.migrator._rds_call("execute_statement", **arguments).get("formattedRecords", "[]"))
        require(isinstance(records, list) and all(isinstance(row, dict) for row in records), "invalid GitHub registration query response")
        return records

    def transaction(self, *, runtime=False):
        response = self.migrator._rds_call("begin_transaction", **self.migrator._base(self.runtime_secret_arn if runtime else None))
        transaction = response.get("transactionId")
        require(isinstance(transaction, str) and transaction, "GitHub registration transaction unavailable")
        return transaction

    def finish(self, operation, transaction, *, runtime=False):
        return self.migrator._rds_call(operation, **self.migrator._transaction_base(self.runtime_secret_arn if runtime else None), transactionId=transaction)

    def rollback(self, transaction, *, runtime=False):
        try:
            self.finish("rollback_transaction", transaction, runtime=runtime)
        except Exception as error:
            raise MigrationError("GitHub registration failed and rollback could not be confirmed") from error

    def apply(self, compiler, *, subject, email):
        connection, repository = compiler["connection"], compiler["repository"]
        identity = {"id": connection["id"], "organization_id": connection["organizationId"],
                    "installation_id": connection["installationId"], "repository_id": repository["id"],
                    "repository": repository["fullName"], "build_workflow_id": connection["workflowId"],
                    "runtime_sha": compiler["runtimeSha"], "enabled": True}
        principal_values = {"subject": subject, "organization_id": identity["organization_id"]}
        principals = self.rows(PRINCIPAL_SQL, principal_values, runtime=True)
        require(len(principals) == 1 and principals[0].get("role") == "admin" and principals[0].get("email") == email,
                "runtime principal must already be an account administrator")
        user_id = principals[0].get("user_id")
        require(isinstance(user_id, str) and COGNITO_SUBJECT.fullmatch(user_id), "runtime principal user identity is invalid")
        transaction = self.transaction()
        try:
            require(self.rows(AUTHORITY_SQL, {**principal_values, "email": email}, transaction) == [{"user_id": user_id}],
                    "existing active account administrator required")
            self.rows("SELECT pg_advisory_xact_lock(hashtextextended(:lock_name, 0))",
                      {"lock_name": "opengeo-github-build-connection:" + identity["organization_id"]}, transaction)
            lookup = {key: identity[key] for key in ("id", "organization_id", "repository_id")}
            existing = self.rows(CONNECTION_SQL, lookup, transaction)
            require(len(existing) <= 1, "another account build grant or conflicting connection already exists")
            if existing:
                require(all(existing[0].get(key) == value for key, value in identity.items()),
                        "GitHub build connection identity or enabled state conflicts; existing history is preserved")
                expected, outcome = existing, "reused"
            else:
                values = {key: value for key, value in identity.items() if key not in {"enabled", "build_workflow_id"}}
                expected = self.rows(INSERT_SQL, {**values, "workflow_id": connection["workflowId"], "user_id": user_id}, transaction)
                outcome = "registered"
            require(len(expected) == 1, "GitHub registration write did not return one connection")
            self.finish("commit_transaction", transaction)
        except Exception:
            self.rollback(transaction)
            raise
        transaction = self.transaction(runtime=True)
        try:
            self.rows(CONTEXT_SQL, {"organization_id": identity["organization_id"], "user_id": user_id}, transaction, runtime=True)
            actual = self.rows(READBACK_SQL, {key: identity[key] for key in ("id", "organization_id")}, transaction, runtime=True)
            require(actual == expected, "committed GitHub connection runtime readback differs; reconcile without repeating writes")
            self.finish("commit_transaction", transaction, runtime=True)
        except Exception:
            self.rollback(transaction, runtime=True)
            raise
        return {"status": outcome, "connectionId": identity["id"], "organizationId": identity["organization_id"],
                "runtimeVerification": "passed"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--email", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    require(args.email == args.email.lower() and EMAIL.fullmatch(args.email), "email must be a normalized address")
    community = community_module()
    deployment = community.Deployment(community.load_config(args.config))
    deployment.env["AWS_MAX_ATTEMPTS"] = "1"
    foundation, compiler = retained_inputs(deployment)
    if not args.apply:
        print(json.dumps({"mode": "offline-plan", "account": deployment.cfg["account"],
                          "connectionId": compiler["connection"]["id"], "organizationId": compiler["connection"]["organizationId"],
                          "limits": {"awsMetadataRequests": 4, "secretReads": 1, "githubRequests": 4,
                                     "databaseRequests": 32, "databaseSeconds": 180},
                          "next": "Verify the existing administrator and exact App build grant; execution remains separately gated."}, indent=2))
        return 0
    subject = verify_identity(deployment, foundation, args.email)
    verify_secret_encryption(deployment, foundation, compiler)
    import boto3
    from botocore.config import Config
    session = boto3.Session(profile_name=deployment.cfg["profile"], region_name=deployment.cfg["region"])
    github = github_repository(compiler, foundation, session)
    verify_github(compiler, github)
    client_config = Config(connect_timeout=5, read_timeout=20, retries={"total_max_attempts": 1})
    migrator = DataApiMigrator(rds_data=session.client("rds-data", config=client_config), secrets_manager=None,
                              cluster_arn=foundation["DatabaseClusterArn"], admin_secret_arn=foundation["DatabaseSecretArn"],
                              database="opengeo", request_limit=32, deadline=time.monotonic() + 180, rollback_reserve=1)
    result = GitHubBuildConnectionBootstrap(migrator, foundation["RuntimeDatabaseSecretArn"]).apply(compiler, subject=subject, email=args.email)
    result.update({"account": deployment.cfg["account"], "metadataChecks": "passed", "databaseRequests": migrator.requests_used,
                   "serviceMediatedKmsRequests": "unavailable; Secrets Manager and Data API may invoke KMS"})
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except MigrationError as error:
        print(f"GitHub build registration stopped: {error}", file=sys.stderr)
        raise SystemExit(1) from error
    except Exception:
        print("GitHub build registration unavailable; preserve retained intent and reconcile before retrying.", file=sys.stderr)
        raise SystemExit(1) from None
