#!/usr/bin/env python3
"""Idempotently bootstrap one verified Cognito principal as an OpenGeo owner."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Sequence
from typing import Any

from apply_migrations import CLUSTER_ARN, SECRET_ARN, DataApiMigrator, MigrationError

COGNITO_SUBJECT = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
EMAIL = re.compile(r"^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}$")
SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
PROJECT_CODE = re.compile(r"^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$")


def string_parameter(name: str, value: str, *, type_hint: str | None = None) -> dict[str, Any]:
    parameter: dict[str, Any] = {"name": name, "value": {"stringValue": value}}
    if type_hint is not None:
        parameter["typeHint"] = type_hint
    return parameter


class OwnerBootstrap:
    def __init__(
        self,
        migrator: DataApiMigrator,
        *,
        runtime_secret_arn: str,
    ) -> None:
        self.migrator = migrator
        self.runtime_secret_arn = runtime_secret_arn

    def apply(
        self,
        *,
        subject: str,
        email: str,
        display_name: str,
        organization_name: str,
        organization_slug: str,
        project_name: str,
        project_code: str,
        project_description: str,
    ) -> dict[str, str]:
        transaction = self.migrator._rds_call(
            "begin_transaction", **self.migrator._base()
        )
        transaction_id = transaction.get("transactionId")
        if not isinstance(transaction_id, str) or not transaction_id:
            raise MigrationError("Data API did not return an owner-bootstrap transaction id")
        try:
            self.migrator._rds_call(
                "execute_statement",
                **self.migrator._base(),
                transactionId=transaction_id,
                sql="SELECT pg_advisory_xact_lock(hashtextextended(:lock_name, 0))",
                parameters=[
                    string_parameter(
                        "lock_name", f"opengeo-owner-bootstrap:{organization_slug}"
                    )
                ],
            )
            user_id = self._returning_id(
                transaction_id,
                """
                INSERT INTO app.users (cognito_subject, email, display_name)
                VALUES (:subject, :email, :display_name)
                ON CONFLICT (cognito_subject) DO UPDATE
                SET email = EXCLUDED.email,
                    display_name = EXCLUDED.display_name,
                    updated_at = clock_timestamp()
                RETURNING id
                """,
                [
                    string_parameter("subject", subject),
                    string_parameter("email", email),
                    string_parameter("display_name", display_name),
                ],
            )
            organization_id = self._existing_id(
                transaction_id,
                "SELECT id FROM app.organizations WHERE slug = :slug",
                [string_parameter("slug", organization_slug)],
            )
            if organization_id is None:
                organization_id = self._returning_id(
                    transaction_id,
                    """
                    INSERT INTO app.organizations (name, slug, created_by)
                    VALUES (:name, :slug, :user_id)
                    RETURNING id
                    """,
                    [
                        string_parameter("name", organization_name),
                        string_parameter("slug", organization_slug),
                        string_parameter("user_id", user_id, type_hint="UUID"),
                    ],
                )
            self._execute(
                transaction_id,
                """
                INSERT INTO app.organization_memberships
                  (organization_id, user_id, role, invited_by)
                VALUES (:organization_id, :user_id, 'admin', :user_id)
                ON CONFLICT (organization_id, user_id) DO UPDATE
                SET role = 'admin', updated_at = clock_timestamp()
                """,
                [
                    string_parameter("organization_id", organization_id, type_hint="UUID"),
                    string_parameter("user_id", user_id, type_hint="UUID"),
                ],
            )
            project_id = self._existing_id(
                transaction_id,
                """
                SELECT id FROM app.projects
                WHERE organization_id = :organization_id
                  AND client_id IS NULL
                  AND project_code = :project_code
                """,
                [
                    string_parameter("organization_id", organization_id, type_hint="UUID"),
                    string_parameter("project_code", project_code),
                ],
            )
            if project_id is None:
                project_id = self._returning_id(
                    transaction_id,
                    """
                    INSERT INTO app.projects
                      (organization_id, name, project_code, description, created_by)
                    VALUES
                      (:organization_id, :name, :project_code, :description, :user_id)
                    RETURNING id
                    """,
                    [
                        string_parameter(
                            "organization_id", organization_id, type_hint="UUID"
                        ),
                        string_parameter("name", project_name),
                        string_parameter("project_code", project_code),
                        string_parameter("description", project_description),
                        string_parameter("user_id", user_id, type_hint="UUID"),
                    ],
                )
            self._execute(
                transaction_id,
                """
                INSERT INTO app.project_memberships
                  (organization_id, project_id, user_id, role)
                VALUES (:organization_id, :project_id, :user_id, 'owner')
                ON CONFLICT (organization_id, project_id, user_id) DO UPDATE
                SET role = 'owner', updated_at = clock_timestamp()
                """,
                [
                    string_parameter("organization_id", organization_id, type_hint="UUID"),
                    string_parameter("project_id", project_id, type_hint="UUID"),
                    string_parameter("user_id", user_id, type_hint="UUID"),
                ],
            )
            self._execute(
                transaction_id,
                """
                INSERT INTO app.activity_events
                  (organization_id, actor_user_id, project_id, event_type,
                   resource_type, resource_id, request_id, payload)
                SELECT :organization_id, :user_id, :project_id,
                       'platform.owner_bootstrap', 'organization',
                       :organization_id, 'owner-bootstrap-opengeo-tools',
                       jsonb_build_object('project_id', :project_id)
                WHERE NOT EXISTS (
                  SELECT 1 FROM app.activity_events
                  WHERE organization_id = :organization_id
                    AND actor_user_id = :user_id
                    AND event_type = 'platform.owner_bootstrap'
                    AND request_id = 'owner-bootstrap-opengeo-tools'
                )
                """,
                [
                    string_parameter("organization_id", organization_id, type_hint="UUID"),
                    string_parameter("user_id", user_id, type_hint="UUID"),
                    string_parameter("project_id", project_id, type_hint="UUID"),
                ],
            )
            self.migrator._rds_call(
                "commit_transaction",
                **self.migrator._transaction_base(),
                transactionId=transaction_id,
            )
        except Exception as error:
            try:
                self.migrator._rds_call(
                    "rollback_transaction",
                    **self.migrator._transaction_base(),
                    transactionId=transaction_id,
                )
            except Exception as rollback_error:
                raise MigrationError(
                    "owner bootstrap failed and rollback could not be confirmed"
                ) from rollback_error
            if isinstance(error, MigrationError):
                raise
            raise MigrationError("owner bootstrap failed") from error

        self.verify(
            subject=subject,
            organization_id=organization_id,
            project_id=project_id,
        )
        return {
            "userId": user_id,
            "organizationId": organization_id,
            "projectId": project_id,
        }

    def _execute(
        self, transaction_id: str, sql: str, parameters: list[dict[str, Any]]
    ) -> dict[str, Any]:
        return self.migrator._rds_call(
            "execute_statement",
            **self.migrator._base(),
            transactionId=transaction_id,
            sql=sql.strip(),
            parameters=parameters,
            formatRecordsAs="JSON",
        )

    def _returning_id(
        self, transaction_id: str, sql: str, parameters: list[dict[str, Any]]
    ) -> str:
        value = self._existing_id(transaction_id, sql, parameters)
        if value is None:
            raise MigrationError("owner bootstrap statement did not return an id")
        return value

    def _existing_id(
        self, transaction_id: str, sql: str, parameters: list[dict[str, Any]]
    ) -> str | None:
        response = self._execute(transaction_id, sql, parameters)
        records = json.loads(response.get("formattedRecords", "[]"))
        if not isinstance(records, list) or len(records) > 1:
            raise MigrationError("owner bootstrap id query returned an invalid result")
        if not records:
            return None
        row = records[0]
        value = row.get("id") if isinstance(row, dict) else None
        if not isinstance(value, str) or not COGNITO_SUBJECT.fullmatch(value):
            raise MigrationError("owner bootstrap returned an invalid UUID")
        return value

    def verify(self, *, subject: str, organization_id: str, project_id: str) -> None:
        response = self.migrator._rds_call(
            "execute_statement",
            **self.migrator._base(self.runtime_secret_arn),
            sql="""
            SELECT organization_id, organization_role::text AS role
            FROM app.resolve_principal(:subject)
            WHERE organization_id = :organization_id
            """.strip(),
            parameters=[
                string_parameter("subject", subject),
                string_parameter("organization_id", organization_id, type_hint="UUID"),
            ],
            formatRecordsAs="JSON",
        )
        memberships = json.loads(response.get("formattedRecords", "[]"))
        if memberships != [{"organization_id": organization_id, "role": "admin"}]:
            raise MigrationError("runtime principal resolution did not return organization admin")

        transaction = self.migrator._rds_call(
            "begin_transaction",
            **self.migrator._base(self.runtime_secret_arn),
        )
        transaction_id = transaction.get("transactionId")
        if not isinstance(transaction_id, str) or not transaction_id:
            raise MigrationError("runtime owner verification transaction is unavailable")
        try:
            for setting, value in (
                ("app.organization_id", organization_id),
                (
                    "app.user_id",
                    self._runtime_user_id(subject, organization_id),
                ),
            ):
                self.migrator._rds_call(
                    "execute_statement",
                    **self.migrator._base(self.runtime_secret_arn),
                    transactionId=transaction_id,
                    sql="SELECT set_config(:setting, :value, true)",
                    parameters=[
                        string_parameter("setting", setting),
                        string_parameter("value", value),
                    ],
                )
            project = self.migrator._rds_call(
                "execute_statement",
                **self.migrator._base(self.runtime_secret_arn),
                transactionId=transaction_id,
                sql="""
                SELECT membership.role
                FROM app.project_memberships membership
                JOIN app.projects project
                  ON project.organization_id = membership.organization_id
                 AND project.id = membership.project_id
                WHERE membership.organization_id = :organization_id
                  AND membership.project_id = :project_id
                  AND membership.user_id = app.current_user_id()
                  AND project.status = 'active'
                """.strip(),
                parameters=[
                    string_parameter(
                        "organization_id", organization_id, type_hint="UUID"
                    ),
                    string_parameter("project_id", project_id, type_hint="UUID"),
                ],
                formatRecordsAs="JSON",
            )
            rows = json.loads(project.get("formattedRecords", "[]"))
            if rows != [{"role": "owner"}]:
                raise MigrationError("runtime tenant query did not return project owner")
            self.migrator._rds_call(
                "commit_transaction",
                **self.migrator._transaction_base(self.runtime_secret_arn),
                transactionId=transaction_id,
            )
        except Exception as error:
            try:
                self.migrator.rds_data.rollback_transaction(
                    resourceArn=self.migrator.cluster_arn,
                    secretArn=self.runtime_secret_arn,
                    transactionId=transaction_id,
                )
            except Exception as rollback_error:
                raise MigrationError(
                    "runtime owner verification failed and rollback was not confirmed"
                ) from rollback_error
            if isinstance(error, MigrationError):
                raise
            raise MigrationError("runtime owner verification failed") from error

    def _runtime_user_id(self, subject: str, organization_id: str) -> str:
        response = self.migrator._rds_call(
            "execute_statement",
            **self.migrator._base(self.runtime_secret_arn),
            sql="""
            SELECT user_id AS id FROM app.resolve_principal(:subject)
            WHERE organization_id = :organization_id
            """.strip(),
            parameters=[
                string_parameter("subject", subject),
                string_parameter("organization_id", organization_id, type_hint="UUID"),
            ],
            formatRecordsAs="JSON",
        )
        rows = json.loads(response.get("formattedRecords", "[]"))
        value = rows[0].get("id") if isinstance(rows, list) and len(rows) == 1 else None
        if not isinstance(value, str) or not COGNITO_SUBJECT.fullmatch(value):
            raise MigrationError("runtime principal resolution did not return a user id")
        return value


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--profile")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--expected-account")
    parser.add_argument("--cluster-arn")
    parser.add_argument("--admin-secret-arn")
    parser.add_argument("--runtime-secret-arn")
    parser.add_argument("--subject", required=True)
    parser.add_argument("--email", required=True)
    parser.add_argument("--display-name", required=True)
    parser.add_argument("--organization-name", default="OpenGeo.Tools")
    parser.add_argument("--organization-slug", default="opengeo-tools")
    parser.add_argument("--project-name", default="OpenGeo.Tools Site and Maps")
    parser.add_argument("--project-code", default="opengeo-tools-site")
    parser.add_argument(
        "--project-description",
        default=(
            "Observable Framework source, maps, tutorials, articles, and public "
            "site editions for opengeo.tools."
        ),
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    if not COGNITO_SUBJECT.fullmatch(args.subject):
        raise MigrationError("subject must be a lowercase UUID")
    if args.email != args.email.lower() or not EMAIL.fullmatch(args.email):
        raise MigrationError("email must be a normalized address")
    for label, value, maximum in (
        ("display name", args.display_name, 200),
        ("organization name", args.organization_name, 200),
        ("project name", args.project_name, 200),
        ("project description", args.project_description, 2000),
    ):
        if not isinstance(value, str) or not value.strip() or len(value) > maximum:
            raise MigrationError(f"invalid {label}")
    if not SLUG.fullmatch(args.organization_slug):
        raise MigrationError("invalid organization slug")
    if not PROJECT_CODE.fullmatch(args.project_code):
        raise MigrationError("invalid project code")

    plan = {
        "status": "validated",
        "mode": "apply" if args.apply else "plan",
        "subject": args.subject,
        "email": args.email,
        "organization": args.organization_name,
        "organizationRole": "admin",
        "project": args.project_name,
        "projectRole": "owner",
    }
    print(json.dumps(plan, indent=2))
    if not args.apply:
        return 0
    required = {
        "expected-account": args.expected_account,
        "cluster-arn": args.cluster_arn,
        "admin-secret-arn": args.admin_secret_arn,
        "runtime-secret-arn": args.runtime_secret_arn,
    }
    missing = [name for name, value in required.items() if not value]
    if missing:
        raise MigrationError(f"--apply requires: {', '.join('--' + item for item in missing)}")
    if not re.fullmatch(r"[0-9]{12}", args.expected_account):
        raise MigrationError("expected account must be a 12-digit AWS account id")
    cluster = CLUSTER_ARN.fullmatch(args.cluster_arn)
    secrets = [SECRET_ARN.fullmatch(args.admin_secret_arn), SECRET_ARN.fullmatch(args.runtime_secret_arn)]
    if cluster is None or any(match is None for match in secrets):
        raise MigrationError("invalid production database ARN")
    for match in [cluster, *secrets]:
        assert match is not None
        if match.group("account") != args.expected_account or match.group("region") != args.region:
            raise MigrationError("database ARN does not match the expected AWS boundary")

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
        admin_secret_arn=args.admin_secret_arn,
        database="opengeo",
    )
    result = OwnerBootstrap(
        migrator, runtime_secret_arn=args.runtime_secret_arn
    ).apply(
        subject=args.subject,
        email=args.email,
        display_name=args.display_name.strip(),
        organization_name=args.organization_name.strip(),
        organization_slug=args.organization_slug,
        project_name=args.project_name.strip(),
        project_code=args.project_code,
        project_description=args.project_description.strip(),
    )
    print(
        json.dumps(
            {
                "status": "applied",
                **result,
                "organizationRole": "admin",
                "projectRole": "owner",
                "runtimeVerification": "passed",
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except MigrationError as error:
        print(f"owner bootstrap error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
