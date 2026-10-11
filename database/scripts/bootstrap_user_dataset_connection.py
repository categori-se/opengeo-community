#!/usr/bin/env python3
"""Idempotently seed one unverified, secret-free S3 connection in OpenGeo dev."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Sequence
from typing import Any
from uuid import UUID, uuid5

from apply_migrations import CLUSTER_ARN, SECRET_ARN, DataApiMigrator, MigrationError

BOOTSTRAP_NAMESPACE = UUID("9cb6cae2-bdaf-4855-93ba-280304fb5c2b")
BUCKET = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
REGION = re.compile(r"^[a-z]{2}(?:-gov)?-[a-z0-9-]+-[0-9]+$")
ROLE_ARN = re.compile(
    r"^arn:aws(?:-us-gov)?:iam::(?P<account>[0-9]{12}):"
    r"role/[A-Za-z0-9_+=,.@/-]+$"
)


def string_parameter(name: str, value: str, *, type_hint: str | None = None) -> dict[str, Any]:
    parameter: dict[str, Any] = {"name": name, "value": {"stringValue": value}}
    if type_hint is not None:
        parameter["typeHint"] = type_hint
    return parameter


def stable_ids(
    organization_id: UUID,
    user_id: UUID,
    project_id: UUID,
    bucket_name: str,
    region_name: str,
    object_prefix: str,
) -> tuple[UUID, UUID]:
    connection = uuid5(
        BOOTSTRAP_NAMESPACE,
        f"{organization_id}:{user_id}:s3:{bucket_name}:{region_name}:{object_prefix}",
    )
    binding = uuid5(BOOTSTRAP_NAMESPACE, f"{project_id}:{connection}:binding")
    return connection, binding


class UserConnectionBootstrap:
    def __init__(self, migrator: DataApiMigrator, *, runtime_secret_arn: str) -> None:
        self.migrator = migrator
        self.runtime_secret_arn = runtime_secret_arn

    def apply(
        self,
        *,
        user_id: UUID,
        organization_id: UUID,
        project_id: UUID,
        display_name: str,
        bucket_name: str,
        region_name: str,
        object_prefix: str,
        role_arn: str,
    ) -> dict[str, str | bool]:
        connection_id, binding_id = stable_ids(
            organization_id,
            user_id,
            project_id,
            bucket_name,
            region_name,
            object_prefix,
        )
        transaction = self.migrator._rds_call(
            "begin_transaction", **self.migrator._base(self.runtime_secret_arn)
        )
        transaction_id = transaction.get("transactionId")
        if not isinstance(transaction_id, str) or not transaction_id:
            raise MigrationError("Data API did not return a connection-bootstrap transaction id")
        created_connection = False
        created_binding = False
        phase = "set runtime context"
        try:
            self._execute(
                transaction_id,
                """
                SELECT set_config(
                         'app.user_id', CAST(:user_id AS text), true
                       ) AS user_context,
                       set_config(
                         'app.organization_id', CAST(:organization_id AS text), true
                       ) AS organization_context,
                       set_config(
                         'statement_timeout', '10000ms', true
                       ) AS timeout_context
                """,
                self._context_parameters(user_id, organization_id),
            )
            phase = "verify owner context"
            access = self._rows(
                self._execute(
                    transaction_id,
                    """
                    SELECT membership.role::text AS organization_role,
                           project_membership.role::text AS project_role
                    FROM app.organization_memberships membership
                    JOIN app.project_memberships project_membership
                      ON project_membership.organization_id = membership.organization_id
                     AND project_membership.user_id = membership.user_id
                    JOIN app.projects project
                      ON project.organization_id = project_membership.organization_id
                     AND project.id = project_membership.project_id
                    WHERE membership.organization_id = :organization_id
                      AND membership.user_id = :user_id
                      AND project.id = :project_id
                      AND project.status = 'active'
                    """,
                    [
                        *self._context_parameters(user_id, organization_id),
                        string_parameter("project_id", str(project_id), type_hint="UUID"),
                    ],
                )
            )
            if access != [{"organization_role": "admin", "project_role": "owner"}]:
                raise MigrationError("connection bootstrap requires the exact dev owner context")

            phase = "create connection metadata"
            inserted = self._rows(
                self._execute(
                    transaction_id,
                    """
                    INSERT INTO app.user_dataset_connections
                      (id, organization_id, owner_user_id, provider, display_name,
                       bucket_name, region_name, object_prefix, credential_mode,
                       role_arn, status)
                    VALUES
                      (:connection_id, :organization_id, :user_id, 's3', :display_name,
                       :bucket_name, :region_name, :object_prefix, 'assume_role',
                       :role_arn, 'unverified')
                    ON CONFLICT (id) DO NOTHING
                    RETURNING id
                    """,
                    self._connection_parameters(
                        connection_id=connection_id,
                        user_id=user_id,
                        organization_id=organization_id,
                        display_name=display_name,
                        bucket_name=bucket_name,
                        region_name=region_name,
                        object_prefix=object_prefix,
                        role_arn=role_arn,
                    ),
                )
            )
            created_connection = bool(inserted)
            connection = self._connection_row(
                transaction_id,
                connection_id=connection_id,
                user_id=user_id,
                organization_id=organization_id,
            )
            expected_connection = {
                "id": str(connection_id),
                "provider": "s3",
                "display_name": display_name,
                "bucket_name": bucket_name,
                "region_name": region_name,
                "object_prefix": object_prefix,
                "credential_mode": "assume_role",
                "role_arn": role_arn,
                "configured_secret_fields": [],
                "credential_revision": 0,
                "status": "unverified",
            }
            if connection != expected_connection:
                raise MigrationError("existing connection does not match the reviewed bootstrap plan")

            phase = "create project binding"
            inserted_binding = self._rows(
                self._execute(
                    transaction_id,
                    """
                    INSERT INTO app.project_dataset_connection_bindings
                      (id, organization_id, project_id, connection_id,
                       display_name, created_by)
                    VALUES
                      (:binding_id, :organization_id, :project_id, :connection_id,
                       :display_name, :user_id)
                    ON CONFLICT (id) DO NOTHING
                    RETURNING id
                    """,
                    [
                        string_parameter("binding_id", str(binding_id), type_hint="UUID"),
                        string_parameter(
                            "organization_id", str(organization_id), type_hint="UUID"
                        ),
                        string_parameter("project_id", str(project_id), type_hint="UUID"),
                        string_parameter(
                            "connection_id", str(connection_id), type_hint="UUID"
                        ),
                        string_parameter("display_name", display_name),
                        string_parameter("user_id", str(user_id), type_hint="UUID"),
                    ],
                )
            )
            created_binding = bool(inserted_binding)
            binding = self._rows(
                self._execute(
                    transaction_id,
                    """
                    SELECT id, project_id, connection_id, display_name
                    FROM app.project_dataset_connection_bindings
                    WHERE organization_id = :organization_id
                      AND id = :binding_id
                    """,
                    [
                        string_parameter(
                            "organization_id", str(organization_id), type_hint="UUID"
                        ),
                        string_parameter("binding_id", str(binding_id), type_hint="UUID"),
                    ],
                )
            )
            if binding != [
                {
                    "id": str(binding_id),
                    "project_id": str(project_id),
                    "connection_id": str(connection_id),
                    "display_name": display_name,
                }
            ]:
                raise MigrationError("existing project binding does not match the bootstrap plan")

            phase = "record audit event"
            self._execute(
                transaction_id,
                """
                INSERT INTO app.activity_events
                  (organization_id, actor_user_id, project_id, event_type,
                   resource_type, resource_id, request_id, payload)
                SELECT :organization_id, :user_id, :project_id,
                       'user_dataset_connection.bootstrap_configured',
                       'dataset_connection', :connection_id,
                       'bootstrap-user-dataset-connection-v1',
                       jsonb_build_object(
                         'provider', 's3',
                         'credential_mode', 'assume_role',
                         'verification_available', false
                       )
                WHERE NOT EXISTS (
                  SELECT 1 FROM app.activity_events
                  WHERE organization_id = :organization_id
                    AND actor_user_id = :user_id
                    AND resource_id = :connection_id
                    AND request_id = 'bootstrap-user-dataset-connection-v1'
                )
                """,
                [
                    string_parameter(
                        "organization_id", str(organization_id), type_hint="UUID"
                    ),
                    string_parameter("user_id", str(user_id), type_hint="UUID"),
                    string_parameter("project_id", str(project_id), type_hint="UUID"),
                    string_parameter(
                        "connection_id", str(connection_id), type_hint="UUID"
                    ),
                ],
            )
            phase = "commit transaction"
            self.migrator._rds_call(
                "commit_transaction",
                **self.migrator._transaction_base(self.runtime_secret_arn),
                transactionId=transaction_id,
            )
        except Exception as error:
            try:
                self.migrator._rds_call(
                    "rollback_transaction",
                    **self.migrator._transaction_base(self.runtime_secret_arn),
                    transactionId=transaction_id,
                )
            except Exception as rollback_error:
                raise MigrationError(
                    "connection bootstrap failed and rollback could not be confirmed"
                ) from rollback_error
            if isinstance(error, MigrationError):
                raise
            error_code, error_message = self.migrator._error_summary(error)
            safe_message = re.sub(
                r"arn:aws[^ ]+|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}",
                "[redacted-identifier]",
                error_message,
                flags=re.IGNORECASE,
            )
            raise MigrationError(
                f"connection bootstrap failed during {phase}: "
                f"{error_code or type(error).__name__}: {safe_message}"
            ) from error

        self.verify(
            user_id=user_id,
            organization_id=organization_id,
            project_id=project_id,
            connection_id=connection_id,
            binding_id=binding_id,
        )
        return {
            "connectionId": str(connection_id),
            "bindingId": str(binding_id),
            "createdConnection": created_connection,
            "createdBinding": created_binding,
            "connectionStatus": "unverified",
        }

    def verify(
        self,
        *,
        user_id: UUID,
        organization_id: UUID,
        project_id: UUID,
        connection_id: UUID,
        binding_id: UUID,
    ) -> None:
        transaction = self.migrator._rds_call(
            "begin_transaction", **self.migrator._base(self.runtime_secret_arn)
        )
        transaction_id = transaction.get("transactionId")
        if not isinstance(transaction_id, str) or not transaction_id:
            raise MigrationError("runtime connection verification transaction is unavailable")
        try:
            self._execute(
                transaction_id,
                """
                SELECT set_config(
                         'app.user_id', CAST(:user_id AS text), true
                       ) AS user_context,
                       set_config(
                         'app.organization_id', CAST(:organization_id AS text), true
                       ) AS organization_context,
                       set_config(
                         'statement_timeout', '10000ms', true
                       ) AS timeout_context
                """,
                self._context_parameters(user_id, organization_id),
            )
            rows = self._rows(
                self._execute(
                    transaction_id,
                    """
                    SELECT connection.id AS connection_id,
                           binding.id AS binding_id,
                           connection.status::text AS status,
                           connection.configured_secret_fields
                    FROM app.user_dataset_connections connection
                    JOIN app.project_dataset_connection_bindings binding
                      ON binding.organization_id = connection.organization_id
                     AND binding.connection_id = connection.id
                    WHERE connection.organization_id = :organization_id
                      AND connection.owner_user_id = :user_id
                      AND connection.id = :connection_id
                      AND binding.project_id = :project_id
                      AND binding.id = :binding_id
                    """,
                    [
                        *self._context_parameters(user_id, organization_id),
                        string_parameter(
                            "connection_id", str(connection_id), type_hint="UUID"
                        ),
                        string_parameter("project_id", str(project_id), type_hint="UUID"),
                        string_parameter("binding_id", str(binding_id), type_hint="UUID"),
                    ],
                )
            )
            if rows != [
                {
                    "connection_id": str(connection_id),
                    "binding_id": str(binding_id),
                    "status": "unverified",
                    "configured_secret_fields": [],
                }
            ]:
                raise MigrationError("runtime RLS connection verification failed")
            self.migrator._rds_call(
                "commit_transaction",
                **self.migrator._transaction_base(self.runtime_secret_arn),
                transactionId=transaction_id,
            )
        except Exception as error:
            try:
                self.migrator._rds_call(
                    "rollback_transaction",
                    **self.migrator._transaction_base(self.runtime_secret_arn),
                    transactionId=transaction_id,
                )
            except Exception as rollback_error:
                raise MigrationError(
                    "runtime verification failed and rollback could not be confirmed"
                ) from rollback_error
            if isinstance(error, MigrationError):
                raise
            raise MigrationError("runtime RLS connection verification failed") from error

    def _connection_row(
        self,
        transaction_id: str,
        *,
        connection_id: UUID,
        user_id: UUID,
        organization_id: UUID,
    ) -> dict[str, Any] | None:
        rows = self._rows(
            self._execute(
                transaction_id,
                """
                SELECT id, provider::text, display_name, bucket_name, region_name,
                       object_prefix, credential_mode::text, role_arn,
                       configured_secret_fields, credential_revision,
                       status::text
                FROM app.user_dataset_connections
                WHERE organization_id = :organization_id
                  AND owner_user_id = :user_id
                  AND id = :connection_id
                """,
                [
                    *self._context_parameters(user_id, organization_id),
                    string_parameter("connection_id", str(connection_id), type_hint="UUID"),
                ],
            )
        )
        if len(rows) != 1:
            return None
        return rows[0]

    def _execute(
        self, transaction_id: str, sql: str, parameters: list[dict[str, Any]]
    ) -> dict[str, Any]:
        return self.migrator._rds_call(
            "execute_statement",
            **self.migrator._base(self.runtime_secret_arn),
            transactionId=transaction_id,
            sql=sql.strip(),
            parameters=parameters,
            formatRecordsAs="JSON",
        )

    @staticmethod
    def _rows(response: dict[str, Any]) -> list[dict[str, Any]]:
        rows = json.loads(response.get("formattedRecords", "[]"))
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise MigrationError("Data API returned invalid formatted records")
        return rows

    @staticmethod
    def _context_parameters(user_id: UUID, organization_id: UUID) -> list[dict[str, Any]]:
        return [
            string_parameter("user_id", str(user_id), type_hint="UUID"),
            string_parameter("organization_id", str(organization_id), type_hint="UUID"),
        ]

    @staticmethod
    def _connection_parameters(
        *,
        connection_id: UUID,
        user_id: UUID,
        organization_id: UUID,
        display_name: str,
        bucket_name: str,
        region_name: str,
        object_prefix: str,
        role_arn: str,
    ) -> list[dict[str, Any]]:
        return [
            string_parameter("connection_id", str(connection_id), type_hint="UUID"),
            string_parameter("organization_id", str(organization_id), type_hint="UUID"),
            string_parameter("user_id", str(user_id), type_hint="UUID"),
            string_parameter("display_name", display_name),
            string_parameter("bucket_name", bucket_name),
            string_parameter("region_name", region_name),
            string_parameter("object_prefix", object_prefix),
            string_parameter("role_arn", role_arn),
        ]


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--profile")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--expected-account")
    parser.add_argument("--cluster-arn")
    parser.add_argument("--runtime-secret-arn")
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--organization-id", required=True)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--display-name", default="Geospatial data")
    parser.add_argument("--bucket-name", required=True)
    parser.add_argument("--region-name", default="us-east-1")
    parser.add_argument("--object-prefix", default="")
    parser.add_argument("--role-arn", required=True)
    return parser.parse_args(argv)


def validated_uuid(label: str, value: str) -> UUID:
    try:
        parsed = UUID(value)
    except ValueError as error:
        raise MigrationError(f"{label} must be a UUID") from error
    if str(parsed) != value.lower() or parsed.version not in {4, 5}:
        raise MigrationError(f"{label} must be a canonical UUIDv4 or UUIDv5")
    return parsed


def validate_target(args: argparse.Namespace) -> None:
    if (
        BUCKET.fullmatch(args.bucket_name) is None
        or ".." in args.bucket_name
        or ".-" in args.bucket_name
        or "-." in args.bucket_name
        or args.bucket_name.startswith(("xn--", "sthree-", "amzn-s3-demo-"))
        or args.bucket_name.endswith(
            ("-s3alias", "--ol-s3", ".mrap", "--x-s3", "--table-s3")
        )
    ):
        raise MigrationError("bucket name is not a supported S3 general-purpose bucket")
    if REGION.fullmatch(args.region_name) is None:
        raise MigrationError("invalid target region")
    if (
        len(args.object_prefix.encode()) > 1024
        or args.object_prefix.startswith(("/", "\\"))
        or "\\" in args.object_prefix
        or any(ord(character) < 32 or ord(character) == 127 for character in args.object_prefix)
    ):
        raise MigrationError("invalid S3 object prefix")
    if not args.display_name.strip() or args.display_name != args.display_name.strip():
        raise MigrationError("display name must be non-empty and trimmed")
    if len(args.display_name) > 200 or ROLE_ARN.fullmatch(args.role_arn) is None:
        raise MigrationError("display name or role ARN is invalid")


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    validate_target(args)
    user_id = validated_uuid("user id", args.user_id)
    organization_id = validated_uuid("organization id", args.organization_id)
    project_id = validated_uuid("project id", args.project_id)
    connection_id, binding_id = stable_ids(
        organization_id,
        user_id,
        project_id,
        args.bucket_name,
        args.region_name,
        args.object_prefix,
    )
    plan = {
        "status": "validated",
        "mode": "apply" if args.apply else "plan",
        "connectionId": str(connection_id),
        "bindingId": str(binding_id),
        "target": f"s3://{args.bucket_name}/{args.object_prefix}",
        "credentialMode": "assume_role",
        "credentialSecretCreated": False,
        "verificationStatus": "unverified",
    }
    print(json.dumps(plan, indent=2))
    if not args.apply:
        return 0

    required = {
        "expected-account": args.expected_account,
        "cluster-arn": args.cluster_arn,
        "runtime-secret-arn": args.runtime_secret_arn,
    }
    missing = [name for name, value in required.items() if not value]
    if missing:
        raise MigrationError(f"--apply requires: {', '.join('--' + item for item in missing)}")
    if not re.fullmatch(r"[0-9]{12}", args.expected_account):
        raise MigrationError("expected account must be a 12-digit AWS account id")
    cluster = CLUSTER_ARN.fullmatch(args.cluster_arn)
    runtime_secret = SECRET_ARN.fullmatch(args.runtime_secret_arn)
    if cluster is None or runtime_secret is None:
        raise MigrationError("invalid dev database ARN")
    for match in (cluster, runtime_secret):
        if (
            match.group("account") != args.expected_account
            or match.group("region") != args.region
        ):
            raise MigrationError("database ARN does not match the expected dev boundary")

    try:
        import boto3
    except ImportError as error:
        raise MigrationError("boto3 is required for --apply") from error
    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    if session.client("sts").get_caller_identity().get("Account") != args.expected_account:
        raise MigrationError("active AWS identity does not match --expected-account")
    migrator = DataApiMigrator(
        rds_data=session.client("rds-data"),
        secrets_manager=session.client("secretsmanager"),
        cluster_arn=args.cluster_arn,
        admin_secret_arn=args.runtime_secret_arn,
        database="opengeo",
    )
    result = UserConnectionBootstrap(
        migrator, runtime_secret_arn=args.runtime_secret_arn
    ).apply(
        user_id=user_id,
        organization_id=organization_id,
        project_id=project_id,
        display_name=args.display_name,
        bucket_name=args.bucket_name,
        region_name=args.region_name,
        object_prefix=args.object_prefix,
        role_arn=args.role_arn,
    )
    print(
        json.dumps(
            {
                "status": "applied",
                **result,
                "runtimeRlsVerification": "passed",
                "credentialSecretCreated": False,
                "liveS3RequestMade": False,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except MigrationError as error:
        print(f"connection bootstrap error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
