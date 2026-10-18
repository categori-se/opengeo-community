#!/usr/bin/env python3
"""Register one verified public origin through the standalone installer; plan offline."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys
import time
from uuid import UUID

from apply_migrations import CLUSTER_ARN, SECRET_ARN, DataApiMigrator, MigrationError
from bootstrap_owner import COGNITO_SUBJECT, EMAIL, string_parameter

ROOT = Path(__file__).resolve().parents[2]
PREFIX = re.compile(r"^/[a-z0-9][a-z0-9-]{0,79}(/[a-z0-9][a-z0-9-]{0,79}){0,6}/$")
RELEASE = re.compile(r"^/releases/[A-Za-z0-9_-]+$")
AUTHORITY_SQL = """
SELECT identity.id AS user_id
FROM app.users identity
JOIN app.organization_memberships member ON member.user_id = identity.id
JOIN app.organizations organization ON organization.id = member.organization_id
WHERE identity.cognito_subject = :subject AND identity.email = :email
  AND organization.id = CAST(:organization_id AS uuid)
  AND organization.status = 'active' AND member.role = 'admin'
FOR SHARE OF identity, member, organization
"""
ORIGIN_SQL = """SELECT id, organization_id, hostname, bucket, distribution_id, origin_id,
active_release_prefix, generation, enabled, self_service_prefix,
project_reservation_limit, active_publication_id, verified_by FROM app.framework_publication_origins
WHERE hostname = :hostname OR id = CAST(:id AS uuid) FOR UPDATE"""
MOUNTS_SQL = """SELECT count(*)::integer AS count FROM app.framework_publication_mounts
WHERE origin_id = CAST(:id AS uuid)"""
INSERT_SQL = """
INSERT INTO app.framework_publication_origins
  (id, organization_id, hostname, bucket, distribution_id, origin_id,
   active_release_prefix, enabled, verified_by, verified_at,
   self_service_prefix, project_reservation_limit)
VALUES (CAST(:id AS uuid), CAST(:organization_id AS uuid), :hostname, :bucket,
  :distribution_id, :origin_id, :release_prefix, :enabled, CAST(:user_id AS uuid),
  clock_timestamp(), :self_service_prefix, :project_reservation_limit)
RETURNING id, organization_id, hostname, bucket, distribution_id, origin_id,
active_release_prefix, generation, enabled, self_service_prefix,
project_reservation_limit, active_publication_id, verified_by
"""
UPDATE_SQL = """
UPDATE app.framework_publication_origins
SET enabled = :enabled, self_service_prefix = :self_service_prefix,
  project_reservation_limit = :project_reservation_limit, generation = generation + 1,
  verified_by = CAST(:user_id AS uuid), verified_at = clock_timestamp()
WHERE id = CAST(:id AS uuid) AND generation = :expected_generation
  AND active_publication_id IS NULL AND active_release_prefix = :release_prefix
RETURNING id, organization_id, hostname, bucket, distribution_id, origin_id,
active_release_prefix, generation, enabled, self_service_prefix,
project_reservation_limit, active_publication_id, verified_by
"""
PRINCIPAL_SQL = """SELECT user_id, email, organization_role::text AS role
FROM app.resolve_principal(:subject)
WHERE organization_id = CAST(:organization_id AS uuid)"""
CONTEXT_SQL = """SELECT set_config('app.organization_id', :organization_id, true),
set_config('app.user_id', :user_id, true)"""
READBACK_SQL = """SELECT id, organization_id, hostname, bucket, distribution_id, origin_id,
active_release_prefix, generation, enabled, self_service_prefix,
project_reservation_limit, active_publication_id, verified_by FROM app.framework_publication_origins
WHERE id = CAST(:id AS uuid) AND organization_id = CAST(:organization_id AS uuid)"""


def require(condition, message):
    if not condition:
        raise MigrationError(message)


def community_module():
    spec = importlib.util.spec_from_file_location("publication_community_aws", ROOT / "scripts/community-aws.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_registration(path, destinations):
    value = json.loads(path.read_text())
    fields = {"id", "organizationId", "hostname", "selfServicePrefix", "projectReservationLimit", "enabled"}
    require(isinstance(value, dict) and fields <= value.keys()
            and not value.keys() - (fields | {"expectedGeneration"}), "invalid publication registration fields")
    for key in ("id", "organizationId"):
        try:
            require(type(value[key]) is str and str(UUID(value[key])) == value[key], "registration IDs must be canonical UUIDs")
        except (ValueError, TypeError, AttributeError) as error:
            raise MigrationError("registration IDs must be canonical UUIDs") from error
    require(type(value["selfServicePrefix"]) is str and PREFIX.fullmatch(value["selfServicePrefix"]), "invalid self-service prefix")
    require(type(value["projectReservationLimit"]) is int and 0 <= value["projectReservationLimit"] <= 1000,
            "project reservation limit must be an integer from 0 to 1000")
    require(type(value["enabled"]) is bool, "origin enabled must be a boolean")
    if "expectedGeneration" in value:
        require(type(value["expectedGeneration"]) is int and 0 < value["expectedGeneration"] <= 9223372036854775807,
                "expected generation must be a positive bigint")
    targets = [target for target in destinations if target["hostname"] == value["hostname"]]
    require(len(targets) == 1, "registration hostname must select one configured publication destination")
    require(bool(targets[0].get("origin_access_control_id")), "registration requires a private REST/OAC origin; website origins are unsupported")
    return value, targets[0]


def database_boundary(deployment):
    foundation = deployment.need("foundation.outputs.json")
    for key, pattern in (("DatabaseClusterArn", CLUSTER_ARN), ("DatabaseSecretArn", SECRET_ARN),
                         ("RuntimeDatabaseSecretArn", SECRET_ARN)):
        match = pattern.fullmatch(foundation.get(key, ""))
        require(match is not None and match.group("account") == deployment.cfg["account"]
                and match.group("region") == deployment.cfg["region"], "database ARN does not match the configured AWS boundary")
    require(foundation["DatabaseSecretArn"] != foundation["RuntimeDatabaseSecretArn"], "runtime verification requires its own database credential")
    pool = foundation.get("UserPoolId", "")
    require(isinstance(pool, str) and re.fullmatch(r"us-east-1_[A-Za-z0-9]+", pool), "configured Cognito pool is required")
    return foundation


def verify_metadata(deployment, target, email, foundation):
    deployment.identity()
    user = deployment.aws(["cognito-idp", "admin-get-user", "--user-pool-id", foundation["UserPoolId"], "--username", email])
    attributes = {item["Name"]: item["Value"] for item in user.get("UserAttributes", [])}
    subject = attributes.get("sub", "")
    require(user.get("Enabled") is True and attributes.get("email_verified") == "true"
            and attributes.get("email") == email and COGNITO_SUBJECT.fullmatch(subject),
            "registration requires an enabled principal with the exact verified email and subject")
    bucket_args = ["--bucket", target["bucket"], "--expected-bucket-owner", deployment.cfg["account"]]
    versioning = deployment.aws(["s3api", "get-bucket-versioning", *bucket_args])
    require(versioning.get("Status") == "Enabled", "publication bucket versioning must be enabled")
    encryption = deployment.aws(["s3api", "get-bucket-encryption", *bucket_args])
    rules = encryption.get("ServerSideEncryptionConfiguration", {}).get("Rules", [])
    require(len(rules) == 1 and rules[0].get("ApplyServerSideEncryptionByDefault") == {"SSEAlgorithm": "AES256"},
            "publication bucket must use SSE-S3 for this profile")
    blocked = deployment.aws(["s3api", "get-public-access-block", *bucket_args]).get("PublicAccessBlockConfiguration", {})
    require(all(blocked.get(key) is True for key in
                ("BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets")),
            "publication bucket must block all public access")
    distribution = deployment.aws(["cloudfront", "get-distribution", "--id", target["distribution_id"]]).get("Distribution", {})
    expected_arn = f"arn:aws:cloudfront::{deployment.cfg['account']}:distribution/{target['distribution_id']}"
    config = distribution.get("DistributionConfig", {})
    require(distribution.get("ARN") == expected_arn and distribution.get("Id") == target["distribution_id"]
            and distribution.get("Status") == "Deployed" and config.get("Enabled") is True
            and target["hostname"] in config.get("Aliases", {}).get("Items", [])
            and config.get("DefaultCacheBehavior", {}).get("TargetOriginId") == target["origin_id"],
            "publication distribution identity, alias or deployed state differs")
    behaviors = config.get("CacheBehaviors", {})
    require(behaviors.get("Quantity", 0) == 0 and not behaviors.get("Items"),
            "publication registration requires default-only routing; path behaviors are unsupported")
    origins = [item for item in config.get("Origins", {}).get("Items", []) if item.get("Id") == target["origin_id"]]
    require(len(origins) == 1, "publication distribution must select one configured origin")
    origin = origins[0]
    require(origin.get("DomainName") == f"{target['bucket']}.s3.us-east-1.amazonaws.com"
            and origin.get("OriginAccessControlId") == target["origin_access_control_id"]
            and isinstance(origin.get("S3OriginConfig"), dict)
            and origin["S3OriginConfig"].get("OriginAccessIdentity", "") == ""
            and "CustomOriginConfig" not in origin, "publication origin must match the configured REST bucket and OAC")
    path = origin.get("OriginPath", "")
    require(isinstance(path, str) and RELEASE.fullmatch(path), "publication origin requires a canonical active release prefix")
    control = deployment.aws(["cloudfront", "get-origin-access-control", "--id", target["origin_access_control_id"]]).get("OriginAccessControl", {})
    control_config = control.get("OriginAccessControlConfig", {})
    require(control.get("Id") == target["origin_access_control_id"]
            and control_config.get("SigningBehavior") == "always" and control_config.get("SigningProtocol") == "sigv4"
            and control_config.get("OriginAccessControlOriginType") == "s3", "publication OAC must always sign S3 requests with sigv4")
    return subject, path.removeprefix("/")


def parameters(values):
    output = []
    for name, value in values.items():
        if type(value) is bool:
            output.append({"name": name, "value": {"booleanValue": value}})
        elif type(value) is int:
            output.append({"name": name, "value": {"longValue": value}})
        else:
            output.append(string_parameter(name, value))
    return output


class PublicationOriginBootstrap:
    def __init__(self, migrator, runtime_secret_arn):
        self.migrator = migrator
        self.runtime_secret_arn = runtime_secret_arn

    def rows(self, sql, values, transaction=None, *, runtime=False):
        arguments = {**self.migrator._base(self.runtime_secret_arn if runtime else None),
                     "sql": sql, "parameters": parameters(values), "formatRecordsAs": "JSON"}
        if transaction is not None:
            arguments["transactionId"] = transaction
        result = self.migrator._rds_call("execute_statement", **arguments)
        records = json.loads(result.get("formattedRecords", "[]"))
        require(isinstance(records, list) and all(isinstance(row, dict) for row in records), "invalid publication registration query response")
        return records

    def transaction(self, *, runtime=False):
        result = self.migrator._rds_call("begin_transaction", **self.migrator._base(self.runtime_secret_arn if runtime else None))
        transaction = result.get("transactionId")
        require(isinstance(transaction, str) and transaction, "publication registration transaction unavailable")
        return transaction

    def finish(self, operation, transaction, *, runtime=False):
        return self.migrator._rds_call(operation, **self.migrator._transaction_base(self.runtime_secret_arn if runtime else None), transactionId=transaction)

    def rollback(self, transaction, *, runtime=False):
        try:
            self.finish("rollback_transaction", transaction, runtime=runtime)
        except Exception as error:
            raise MigrationError("publication registration failed and rollback could not be confirmed") from error

    def apply(self, registration, target, *, subject, email, release_prefix):
        identity = {"id": registration["id"], "organization_id": registration["organizationId"],
                    **{key: target[key] for key in ("hostname", "bucket", "distribution_id", "origin_id")}}
        principal_values = {"subject": subject, "organization_id": identity["organization_id"]}
        principals = self.rows(PRINCIPAL_SQL, principal_values, runtime=True)
        require(len(principals) == 1 and principals[0].get("role") == "admin" and principals[0].get("email") == email,
                "runtime principal must already be an account administrator")
        user_id = principals[0].get("user_id")
        require(isinstance(user_id, str) and COGNITO_SUBJECT.fullmatch(user_id), "runtime principal user identity is invalid")
        transaction = self.transaction()
        try:
            authority = self.rows(AUTHORITY_SQL, {**principal_values, "email": email}, transaction)
            require(authority == [{"user_id": user_id}], "existing active account administrator required")
            self.rows("SELECT pg_advisory_xact_lock(hashtextextended(:lock_name, 0))",
                      {"lock_name": "opengeo-publication-origin:" + target["hostname"]}, transaction)
            existing = self.rows(ORIGIN_SQL, {"id": identity["id"], "hostname": target["hostname"]}, transaction)
            require(len(existing) <= 1, "publication origin identity conflict")
            values = {**identity, "release_prefix": release_prefix, "user_id": user_id,
                      "enabled": registration["enabled"], "self_service_prefix": registration["selfServicePrefix"],
                      "project_reservation_limit": registration["projectReservationLimit"]}
            if not existing:
                require("expectedGeneration" not in registration, "expected generation requires an existing origin")
                expected = self.rows(INSERT_SQL, values, transaction)
                outcome = "registered"
            else:
                current = existing[0]
                require(all(current.get(key) == value for key, value in identity.items()), "publication origin identity conflict")
                require(current.get("active_publication_id") is None, "publication delivery is busy")
                require(current.get("active_release_prefix") == release_prefix, "observed publication release pointer differs from the database")
                changed = any(current.get(key) != values[key] for key in ("enabled", "self_service_prefix", "project_reservation_limit"))
                if not changed:
                    expected, outcome = existing, "reused"
                else:
                    require(registration.get("expectedGeneration") == current["generation"], "changed origin requires its current expected generation")
                    if current.get("self_service_prefix") != values["self_service_prefix"]:
                        require(self.rows(MOUNTS_SQL, {"id": identity["id"]}, transaction) == [{"count": 0}],
                                "delegated prefix cannot change after addresses are reserved")
                    values["expected_generation"] = registration["expectedGeneration"]
                    expected = self.rows(UPDATE_SQL, {key: values[key] for key in
                        ("id", "enabled", "self_service_prefix", "project_reservation_limit", "user_id", "expected_generation", "release_prefix")}, transaction)
                    outcome = "updated"
            require(len(expected) == 1, "publication origin guarded write did not return one origin")
            self.finish("commit_transaction", transaction)
        except Exception:
            self.rollback(transaction)
            raise
        transaction = self.transaction(runtime=True)
        try:
            self.rows(CONTEXT_SQL, {"organization_id": identity["organization_id"], "user_id": user_id}, transaction, runtime=True)
            actual = self.rows(READBACK_SQL, {"id": identity["id"], "organization_id": identity["organization_id"]}, transaction, runtime=True)
            require(actual == expected, "committed publication origin runtime readback differs; reconcile without repeating writes")
            self.finish("commit_transaction", transaction, runtime=True)
        except Exception:
            self.rollback(transaction, runtime=True)
            raise
        row = expected[0]
        return {"status": outcome, "originId": row["id"], "organizationId": row["organization_id"],
                "hostname": row["hostname"], "generation": row["generation"],
                "activeReleasePrefix": row["active_release_prefix"], "runtimeVerification": "passed"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--registration", required=True, type=Path)
    parser.add_argument("--email", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    require(args.email == args.email.lower() and EMAIL.fullmatch(args.email), "email must be a normalized address")
    community = community_module()
    deployment = community.Deployment(community.load_config(args.config))
    deployment.env["AWS_MAX_ATTEMPTS"] = "1"
    deployment.prepare_publication()
    registration, target = load_registration(args.registration, deployment.cfg["nativePublication"]["destinations"])
    foundation = database_boundary(deployment)
    if not args.apply:
        print(json.dumps({"mode": "offline-plan", "registration": registration,
                          "account": deployment.cfg["account"], "destination": target,
                          "limits": {"metadataRequests": 7, "databaseRequests": 32, "databaseSeconds": 180},
                          "next": "Complete owner and dormant publication setup; --apply verifies existing hosting and account authority."}, indent=2))
        return 0
    require(deployment.need("publication.intent.json").get("databaseConfigured") is True,
            "complete the explicit dormant publication role setup before origin registration")
    subject, prefix = verify_metadata(deployment, target, args.email, foundation)
    import boto3
    from botocore.config import Config
    session = boto3.Session(profile_name=deployment.cfg["profile"], region_name=deployment.cfg["region"])
    client_config = Config(connect_timeout=5, read_timeout=20, retries={"total_max_attempts": 1})
    migrator = DataApiMigrator(rds_data=session.client("rds-data", config=client_config), secrets_manager=None,
                              cluster_arn=foundation["DatabaseClusterArn"], admin_secret_arn=foundation["DatabaseSecretArn"],
                              database="opengeo", request_limit=32, deadline=time.monotonic() + 180, rollback_reserve=1)
    result = PublicationOriginBootstrap(migrator, foundation["RuntimeDatabaseSecretArn"]).apply(
        registration, target, subject=subject, email=args.email, release_prefix=prefix)
    result.update({"account": deployment.cfg["account"], "metadataChecks": "passed"})
    result["databaseRequests"] = migrator.requests_used
    result["serviceMediatedKmsRequests"] = "unavailable; S3 metadata and Data API may invoke KMS"
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (MigrationError, ValueError) as error:
        print(f"publication origin setup error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
