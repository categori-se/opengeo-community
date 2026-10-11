#!/usr/bin/env python3
"""Prepare private access containers from the reviewed publication import catalog.

This bootstrap creates legacy app.projects access containers and owner memberships.
It does not create product Projects (app.maps), copy source directories, publish
content, or claim source conversion has completed. Existing maps are preserved.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from apply_migrations import CLUSTER_ARN, SECRET_ARN, DataApiMigrator, MigrationError
from bootstrap_owner import COGNITO_SUBJECT, string_parameter


PROJECT_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
CONFIRMATION = "seed-private-opengeo-projects"
DEFAULT_CATALOG = (
    Path(__file__).resolve().parents[2] / "imports" / "observable-framework-projects.json"
)


def empty_map_definition() -> dict[str, Any]:
    """Historical bootstrap definition retained for compatibility/audit only."""
    return {
        "schemaVersion": "opengeo.map-definition.1.3.0",
        "mapViews": [],
        "basemaps": [],
        "bookmarks": [],
        "activeLayerId": None,
        "activeProcessingModelId": None,
        "models": [],
        "processingHistory": [],
        "measurements": [],
        "projection": "mercator",
        "colorMode": "dark",
        "layers": [],
    }


def load_catalog(path: Path, expected_email: str) -> list[dict[str, str]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise MigrationError("private project catalog is unavailable or invalid") from error
    if payload.get("schemaVersion") != "opengeo.observable-import-catalog.1.0.0":
        raise MigrationError("private project catalog has an unsupported schema")
    if payload.get("projectVisibility") != "private":
        raise MigrationError("private project catalog must remain private")
    owner = payload.get("owner")
    if not isinstance(owner, dict) or owner.get("email") != expected_email:
        raise MigrationError("private project catalog owner does not match --email")
    sources = payload.get("sources")
    if not isinstance(sources, list) or not sources or len(sources) > 50:
        raise MigrationError("private project catalog must contain 1 to 50 sources")
    reviewed: list[dict[str, str]] = []
    seen: set[str] = set()
    for source in sources:
        if not isinstance(source, dict):
            raise MigrationError("private project catalog source must be an object")
        source_id = source.get("id")
        title = source.get("title")
        classification = source.get("classification")
        conversion_plan = source.get("conversionPlan")
        route_namespace = source.get("routeNamespace")
        if (
            not isinstance(source_id, str)
            or not PROJECT_ID.fullmatch(source_id)
            or source_id in seen
            or not isinstance(title, str)
            or not title.strip()
            or len(title) > 200
            or not isinstance(classification, str)
            or not PROJECT_ID.fullmatch(classification)
            or not isinstance(conversion_plan, str)
            or not re.fullmatch(r"[a-z0-9]+(?:_[a-z0-9]+)*", conversion_plan)
            or not isinstance(route_namespace, str)
            or route_namespace != f"projects/{source_id}"
        ):
            raise MigrationError("private project catalog contains an invalid source")
        seen.add(source_id)
        reviewed.append(
            {
                "id": source_id,
                "title": title.strip(),
                "classification": classification,
                "conversionPlan": conversion_plan,
                "routeNamespace": route_namespace,
            }
        )
    return reviewed


class PrivateProjectBootstrap:
    def __init__(self, migrator: DataApiMigrator, runtime_secret_arn: str) -> None:
        self.migrator = migrator
        self.runtime_secret_arn = runtime_secret_arn

    def apply(
        self,
        *,
        subject: str,
        organization_slug: str,
        sources: list[dict[str, str]],
    ) -> dict[str, int]:
        transaction = self.migrator._rds_call("begin_transaction", **self.migrator._base())
        transaction_id = transaction.get("transactionId")
        if not isinstance(transaction_id, str) or not transaction_id:
            raise MigrationError("Data API did not return a project-bootstrap transaction id")
        created_projects = 0
        try:
            self._execute(
                transaction_id,
                "SELECT pg_advisory_xact_lock(hashtextextended(:lock_name, 0))",
                [string_parameter("lock_name", f"opengeo-private-projects:{organization_slug}")],
            )
            identity = self._one(
                transaction_id,
                """
                SELECT u.id AS user_id, o.id AS organization_id
                FROM app.users u
                JOIN app.organization_memberships membership ON membership.user_id = u.id
                JOIN app.organizations o ON o.id = membership.organization_id
                WHERE u.cognito_subject = :subject
                  AND o.slug = :organization_slug
                  AND membership.role = 'admin'
                """,
                [
                    string_parameter("subject", subject),
                    string_parameter("organization_slug", organization_slug),
                ],
            )
            user_id = identity.get("user_id")
            organization_id = identity.get("organization_id")
            if not all(
                isinstance(value, str) and COGNITO_SUBJECT.fullmatch(value)
                for value in (user_id, organization_id)
            ):
                raise MigrationError("catalog owner is not an organization administrator")

            for source in sources:
                project_code = f"observable-{source['id']}"
                description = (
                    f"Private {source['classification']} workspace prepared from the reviewed "
                    f"Observable import catalog. Source conversion is pending under "
                    f"{source['routeNamespace']} using {source['conversionPlan']}."
                )
                project = self._rows(
                    transaction_id,
                    """
                    WITH inserted AS (
                      INSERT INTO app.projects
                        (organization_id, name, project_code, description, created_by)
                      VALUES (:organization_id, :name, :project_code, :description, :user_id)
                      ON CONFLICT DO NOTHING
                      RETURNING id, true AS created
                    )
                    SELECT id, created FROM inserted
                    UNION ALL
                    SELECT id, false AS created
                    FROM app.projects
                    WHERE organization_id = :organization_id
                      AND client_id IS NULL
                      AND project_code = :project_code
                    LIMIT 1
                    """,
                    [
                        string_parameter("organization_id", organization_id, type_hint="UUID"),
                        string_parameter("name", source["title"]),
                        string_parameter("project_code", project_code),
                        string_parameter("description", description),
                        string_parameter("user_id", user_id, type_hint="UUID"),
                    ],
                )
                if len(project) != 1 or not isinstance(project[0].get("id"), str):
                    raise MigrationError("private project upsert did not return one project")
                project_id = project[0]["id"]
                created_projects += int(project[0].get("created") is True)
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
                           'project.catalog_prepared', 'project', :project_id,
                           :request_id,
                           jsonb_build_object('source_id', :source_id,
                                              'conversion_status', 'pending')
                    WHERE NOT EXISTS (
                      SELECT 1 FROM app.activity_events
                      WHERE organization_id = :organization_id
                        AND request_id = :request_id
                    )
                    """,
                    [
                        string_parameter("organization_id", organization_id, type_hint="UUID"),
                        string_parameter("user_id", user_id, type_hint="UUID"),
                        string_parameter("project_id", project_id, type_hint="UUID"),
                        string_parameter("request_id", f"private-catalog-{source['id']}"),
                        string_parameter("source_id", source["id"]),
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
                    "private project bootstrap failed and rollback was not confirmed"
                ) from rollback_error
            if isinstance(error, MigrationError):
                raise
            raise MigrationError("private project bootstrap failed") from error

        self.verify(subject, organization_id, user_id, len(sources))
        return {
            "catalogProjects": len(sources),
            "createdProjects": created_projects,
            "createdMaps": 0,
            "accessContainers": len(sources),
        }

    def verify(
        self,
        subject: str,
        organization_id: str,
        expected_user_id: str,
        expected: int,
    ) -> None:
        identity = self.migrator._rds_call(
            "execute_statement",
            **self.migrator._base(self.runtime_secret_arn),
            sql="""
            SELECT user_id, organization_id
            FROM app.resolve_principal(:subject)
            WHERE organization_id = :organization_id
            """.strip(),
            parameters=[
                string_parameter("subject", subject),
                string_parameter("organization_id", organization_id, type_hint="UUID"),
            ],
            formatRecordsAs="JSON",
        )
        rows = json.loads(identity.get("formattedRecords", "[]"))
        if len(rows) != 1:
            raise MigrationError("runtime project verification could not resolve the owner")
        user_id = rows[0]["user_id"]
        if user_id != expected_user_id or rows[0]["organization_id"] != organization_id:
            raise MigrationError("runtime project verification resolved the wrong owner")
        transaction = self.migrator._rds_call(
            "begin_transaction", **self.migrator._base(self.runtime_secret_arn)
        )
        transaction_id = transaction.get("transactionId")
        if not isinstance(transaction_id, str) or not transaction_id:
            raise MigrationError("runtime project verification transaction is unavailable")
        try:
            for setting, value in (
                ("app.organization_id", organization_id),
                ("app.user_id", user_id),
            ):
                self._runtime_execute(
                    transaction_id,
                    "SELECT set_config(:setting, :value, true)",
                    [string_parameter("setting", setting), string_parameter("value", value)],
                )
            count = self._runtime_execute(
                transaction_id,
                """
                SELECT count(*)::int AS projects
                FROM app.projects project
                JOIN app.project_memberships membership
                  ON membership.organization_id = project.organization_id
                 AND membership.project_id = project.id
                 AND membership.user_id = app.current_user_id()
                 AND membership.role = 'owner'
                WHERE project.organization_id = app.current_organization_id()
                  AND project.project_code LIKE 'observable-%'
                  AND project.status = 'active'
                """,
                [],
            )
            result = json.loads(count.get("formattedRecords", "[]"))
            if result != [{"projects": expected}]:
                raise MigrationError("runtime project catalog count did not match the plan")
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
                    "runtime project verification failed and rollback was not confirmed"
                ) from rollback_error
            if isinstance(error, MigrationError):
                raise
            raise MigrationError("runtime project verification failed") from error

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

    def _runtime_execute(
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

    def _rows(
        self, transaction_id: str, sql: str, parameters: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        response = self._execute(transaction_id, sql, parameters)
        rows = json.loads(response.get("formattedRecords", "[]"))
        if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
            raise MigrationError("private project bootstrap returned invalid records")
        return rows

    def _one(
        self, transaction_id: str, sql: str, parameters: list[dict[str, Any]]
    ) -> dict[str, Any]:
        rows = self._rows(transaction_id, sql, parameters)
        if len(rows) != 1:
            raise MigrationError("private project bootstrap expected one identity")
        return rows[0]


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm")
    parser.add_argument("--profile")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--expected-account")
    parser.add_argument("--cluster-arn")
    parser.add_argument("--admin-secret-arn")
    parser.add_argument("--runtime-secret-arn")
    parser.add_argument("--subject", required=True)
    parser.add_argument("--email", required=True)
    parser.add_argument("--organization-slug", default="opengeo-tools")
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    if not COGNITO_SUBJECT.fullmatch(args.subject):
        raise MigrationError("subject must be a lowercase UUID")
    if args.email != args.email.lower() or len(args.email) > 320 or "@" not in args.email:
        raise MigrationError("email must be a normalized address")
    if not PROJECT_ID.fullmatch(args.organization_slug):
        raise MigrationError("organization slug is invalid")
    sources = load_catalog(args.catalog, args.email)
    print(
        json.dumps(
            {
                "status": "validated",
                "mode": "apply" if args.apply else "plan",
                "visibility": "private",
                "publicationAudience": "authenticated_project_members",
                "catalogProjects": len(sources),
                "accessContainers": len(sources),
                "initialMaps": 0,
                "sourceCopies": 0,
                "sourceConversionStatus": "pending",
            },
            indent=2,
        )
    )
    if not args.apply:
        return 0
    if args.confirm != CONFIRMATION:
        raise MigrationError(f"--apply requires --confirm {CONFIRMATION}")
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
    result = PrivateProjectBootstrap(migrator, args.runtime_secret_arn).apply(
        subject=args.subject,
        organization_slug=args.organization_slug,
        sources=sources,
    )
    print(
        json.dumps(
            {
                "status": "applied",
                **result,
                "runtimeVerification": "passed",
                "sourceCopies": 0,
                "sourceConversionStatus": "pending",
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except MigrationError as error:
        print(f"private project bootstrap error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
