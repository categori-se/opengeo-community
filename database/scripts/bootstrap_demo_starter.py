#!/usr/bin/env python3
"""Create the published, editable starter project for a managed demo site.

The five synthetic community-facility features remain a sealed Studio asset. The
database stores a governed source revision and presentation, not a second copy of
the feature body. Existing project, dataset, and map edits are preserved.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from apply_migrations import CLUSTER_ARN, SECRET_ARN, DataApiMigrator, MigrationError
from bootstrap_massgis_project import MassgisProjectBootstrap, long_parameter
from bootstrap_owner import COGNITO_SUBJECT, string_parameter

ASSET = (
    Path(__file__).resolve().parents[2]
    / "app"
    / "src"
    / "data"
    / "sample-public-facilities.geojson"
)
CONFIRMATION = "seed-opengeo-demo-starter"
PROJECT_CODE = "OPEN-GEO-STARTER"
PROJECT_NAME = "OpenGeo starter project"
SOURCE_NAME = "OpenGeo synthetic community facilities"
SOURCE_URL = (
    "https://demo.studio.opengeo.tools/_file/data/"
    "sample-public-facilities.b384b099.geojson"
)
ASSET_SHA256 = "b384b0990bc62a8a5339e801098f995989bd6a770fdbf5fe7f58025a2351c96c"
ASSET_BYTES = 1472
ASSET_BOUNDS = [-77.061, 38.898, -77.018, 38.923]
SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def load_plan(path: Path = ASSET) -> dict[str, Any]:
    try:
        body = path.read_bytes()
        geojson = json.loads(body)
    except (OSError, json.JSONDecodeError) as error:
        raise MigrationError("demo starter asset is unavailable or invalid") from error
    if (
        hashlib.sha256(body).hexdigest() != ASSET_SHA256
        or len(body) != ASSET_BYTES
        or geojson.get("type") != "FeatureCollection"
        or len(geojson.get("features", [])) != 5
        or any(
            feature.get("geometry", {}).get("type") != "Point"
            for feature in geojson["features"]
        )
    ):
        raise MigrationError("demo starter asset does not match the reviewed release")
    configuration = {
        "content_encoding": "identity",
        "object_sha256": ASSET_SHA256,
        "decoded_sha256": ASSET_SHA256,
        "size_bytes": ASSET_BYTES,
        "decoded_size_bytes": ASSET_BYTES,
        "feature_count": 5,
        "geometry_type": "Point",
        "bounds": ASSET_BOUNDS,
        "attribution": "OpenGeo.tools synthetic demonstration data",
        "license": "CC0-1.0",
        "authoritative_url": SOURCE_URL,
        "rights_url": "https://creativecommons.org/publicdomain/zero/1.0/",
    }
    return {"configuration": configuration, "sourceUrl": SOURCE_URL}


def map_definition(
    dataset_id: str, source_version: int, plan: dict[str, Any]
) -> dict[str, Any]:
    configuration = plan["configuration"]
    return {
        "schemaVersion": "opengeo.map-definition.1.3.0",
        "mapViews": [
            {"center": [-77.038, 38.91], "zoom": 12, "pitch": 0, "bearing": 0}
        ],
        "basemaps": [],
        "bookmarks": [
            {
                "bookmarkId": "demo_extent",
                "title": "Demo extent",
                "center": [-77.038, 38.91],
                "zoom": 12,
            }
        ],
        "activeLayerId": "opengeo_community_facilities",
        "activeProcessingModelId": None,
        "models": [],
        "processingHistory": [],
        "measurements": [],
        "projection": "mercator",
        "colorMode": "dark",
        "layers": [
            {
                "layerId": "opengeo_community_facilities",
                "datasetId": dataset_id,
                "title": "Public community facilities",
                "description": "Five synthetic points for safe public exploration.",
                "sourceType": "geojson-archive",
                "sourceVersion": source_version,
                "sourceUrl": plan["sourceUrl"],
                "sourceConfiguration": {
                    "contentEncoding": configuration["content_encoding"],
                    "objectSha256": configuration["object_sha256"],
                    "decodedSha256": configuration["decoded_sha256"],
                    "sizeBytes": configuration["size_bytes"],
                    "decodedSizeBytes": configuration["decoded_size_bytes"],
                    "featureCount": configuration["feature_count"],
                    "geometryType": configuration["geometry_type"],
                    "bounds": configuration["bounds"],
                    "attribution": configuration["attribution"],
                    "license": configuration["license"],
                    "authoritativeUrl": configuration["authoritative_url"],
                    "rightsUrl": configuration["rights_url"],
                },
                "sharedSourceId": dataset_id,
                "geometryType": "Point",
                "bbox": ASSET_BOUNDS,
                "visible": True,
                "opacity": 0.95,
                "order": 0,
                "attribution": configuration["attribution"],
                "style": {"circleColor": "#f97316", "circleRadius": 7},
                "labels": {"enabled": True, "field": "name"},
            }
        ],
    }


class DemoStarterBootstrap(MassgisProjectBootstrap):
    def apply(
        self, *, subject: str, organization_slug: str, plan: dict[str, Any]
    ) -> dict[str, Any]:
        transaction = self.migrator._rds_call(
            "begin_transaction", **self.migrator._base()
        )
        transaction_id = transaction.get("transactionId")
        if not isinstance(transaction_id, str) or not transaction_id:
            raise MigrationError(
                "Data API did not return a demo bootstrap transaction id"
            )
        try:
            self._execute(
                transaction_id,
                "SELECT pg_advisory_xact_lock(hashtextextended(:lock_name, 0))",
                [
                    string_parameter(
                        "lock_name", f"opengeo-demo-starter:{organization_slug}"
                    )
                ],
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
                raise MigrationError(
                    "demo starter owner is not an organization administrator"
                )

            project = self._one(
                transaction_id,
                """
                WITH inserted AS (
                  INSERT INTO app.projects
                    (organization_id, name, project_code, description, created_by,
                     visibility, published_at, published_by)
                  VALUES (:organization_id, :name, :project_code, :description, :user_id,
                          'published', clock_timestamp(), :user_id)
                  ON CONFLICT DO NOTHING
                  RETURNING id, name, true AS created
                )
                SELECT id, name, created FROM inserted
                UNION ALL
                SELECT id, name, false AS created FROM app.projects
                WHERE organization_id = :organization_id
                  AND client_id IS NULL AND project_code = :project_code
                LIMIT 1
                """,
                [
                    string_parameter(
                        "organization_id", organization_id, type_hint="UUID"
                    ),
                    string_parameter("name", PROJECT_NAME),
                    string_parameter("project_code", PROJECT_CODE),
                    string_parameter(
                        "description",
                        "A safe, editable introduction to map layers and project styling.",
                    ),
                    string_parameter("user_id", user_id, type_hint="UUID"),
                ],
            )
            project_id = project.get("id")
            if not isinstance(project_id, str) or project.get("name") != PROJECT_NAME:
                raise MigrationError(
                    "demo starter project upsert returned an invalid identity"
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
                self._project_parameters(organization_id, project_id, user_id),
            )
            self._execute(
                transaction_id,
                """
                UPDATE app.projects
                SET visibility = 'published',
                    published_at = COALESCE(published_at, clock_timestamp()),
                    published_by = COALESCE(published_by, :user_id)
                WHERE organization_id = :organization_id AND id = :project_id
                """,
                self._project_parameters(organization_id, project_id, user_id),
            )

            configuration_json = json.dumps(
                plan["configuration"], separators=(",", ":")
            )
            dataset = self._one(
                transaction_id,
                """
                WITH existing AS (
                  SELECT dataset.id
                  FROM app.datasets dataset
                  JOIN app.project_datasets link
                    ON link.organization_id = dataset.organization_id
                   AND link.dataset_id = dataset.id AND link.project_id = :project_id
                  WHERE dataset.organization_id = :organization_id
                    AND dataset.name = :source_name AND dataset.source_type = 'geojson'
                  ORDER BY dataset.created_at LIMIT 1
                ), inserted AS (
                  INSERT INTO app.datasets
                    (organization_id, name, description, classification, source_type,
                     format, status, owner_user_id, created_by, updated_by)
                  SELECT :organization_id, :source_name, :description, 'public', 'geojson',
                         'geojson', 'active', :user_id, :user_id, :user_id
                  WHERE NOT EXISTS (SELECT 1 FROM existing)
                  RETURNING id, true AS created
                )
                SELECT id, created FROM inserted
                UNION ALL SELECT id, false AS created FROM existing
                LIMIT 1
                """,
                [
                    string_parameter(
                        "organization_id", organization_id, type_hint="UUID"
                    ),
                    string_parameter("project_id", project_id, type_hint="UUID"),
                    string_parameter("source_name", SOURCE_NAME),
                    string_parameter("description", "Synthetic CC0 starter data."),
                    string_parameter("user_id", user_id, type_hint="UUID"),
                ],
            )
            dataset_id = dataset.get("id")
            if not isinstance(dataset_id, str) or not COGNITO_SUBJECT.fullmatch(
                dataset_id
            ):
                raise MigrationError(
                    "demo starter dataset upsert returned an invalid identity"
                )
            scope = self._scope_parameters(
                organization_id, project_id, dataset_id, user_id
            )
            self._execute(
                transaction_id,
                """
                INSERT INTO app.project_datasets
                  (organization_id, project_id, dataset_id, linked_by)
                VALUES (:organization_id, :project_id, :dataset_id, :user_id)
                ON CONFLICT DO NOTHING
                """,
                scope,
            )
            self._execute(
                transaction_id,
                """
                INSERT INTO app.external_sources
                  (organization_id, dataset_id, source_type, created_by)
                VALUES (:organization_id, :dataset_id, 'geojson', :user_id)
                ON CONFLICT DO NOTHING
                """,
                [
                    string_parameter(
                        "organization_id", organization_id, type_hint="UUID"
                    ),
                    string_parameter("dataset_id", dataset_id, type_hint="UUID"),
                    string_parameter("user_id", user_id, type_hint="UUID"),
                ],
            )
            current = self._rows(
                transaction_id,
                """
                SELECT version_number::int AS version_number, source_url, configuration
                FROM app.external_source_revisions
                WHERE organization_id = :organization_id AND dataset_id = :dataset_id
                ORDER BY version_number DESC LIMIT 1
                """,
                [
                    string_parameter(
                        "organization_id", organization_id, type_hint="UUID"
                    ),
                    string_parameter("dataset_id", dataset_id, type_hint="UUID"),
                ],
            )
            revision_created = not (
                current
                and current[0].get("source_url") == plan["sourceUrl"]
                and current[0].get("configuration") == plan["configuration"]
            )
            source_version = (
                int(current[0]["version_number"])
                if not revision_created
                else int(current[0]["version_number"]) + 1
                if current
                else 1
            )
            if revision_created:
                self._execute(
                    transaction_id,
                    """
                    INSERT INTO app.external_source_revisions
                      (organization_id, dataset_id, version_number, source_url,
                       configuration, verification_state, change_message, created_by)
                    VALUES (:organization_id, :dataset_id, :source_version, :source_url,
                            CAST(:configuration AS jsonb), 'syntax_only',
                            'Sealed OpenGeo demo starter asset', :user_id)
                    """,
                    [
                        string_parameter(
                            "organization_id", organization_id, type_hint="UUID"
                        ),
                        string_parameter("dataset_id", dataset_id, type_hint="UUID"),
                        string_parameter("user_id", user_id, type_hint="UUID"),
                        long_parameter("source_version", source_version),
                        string_parameter("source_url", plan["sourceUrl"]),
                        string_parameter("configuration", configuration_json),
                    ],
                )

            definition = json.dumps(
                map_definition(dataset_id, source_version, plan), separators=(",", ":")
            )
            marker = "OpenGeo managed demo presentation: starter"
            map_record = self._one(
                transaction_id,
                """
                WITH inserted AS (
                  INSERT INTO app.maps
                    (organization_id, project_id, name, description, definition,
                     created_by, updated_by)
                  SELECT :organization_id, :project_id, :name, :marker,
                         CAST(:definition AS jsonb), :user_id, :user_id
                  WHERE NOT EXISTS (
                    SELECT 1 FROM app.maps
                    WHERE organization_id = :organization_id
                      AND project_id = :project_id AND description = :marker
                  )
                  RETURNING id, true AS created
                )
                SELECT id, created FROM inserted
                UNION ALL
                SELECT id, false AS created FROM app.maps
                WHERE organization_id = :organization_id
                  AND project_id = :project_id AND description = :marker
                LIMIT 1
                """,
                [
                    *self._project_parameters(organization_id, project_id, user_id),
                    string_parameter("name", "Community facilities starter map"),
                    string_parameter("marker", marker),
                    string_parameter("definition", definition),
                ],
            )
            if map_record.get("created") is True:
                self._execute(
                    transaction_id,
                    """
                    INSERT INTO app.map_versions
                      (organization_id, map_id, version, definition,
                       change_message, created_by)
                    VALUES (:organization_id, :map_id, 1, CAST(:definition AS jsonb),
                            'Initial managed demo presentation', :user_id)
                    """,
                    [
                        string_parameter(
                            "organization_id", organization_id, type_hint="UUID"
                        ),
                        string_parameter("map_id", map_record["id"], type_hint="UUID"),
                        string_parameter("definition", definition),
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
                       'project.demo_starter_prepared', 'project', :project_id,
                       'demo-starter-bootstrap-v1',
                       jsonb_build_object('dataset_id', :dataset_id, 'maps', 1, 'layers', 1)
                WHERE NOT EXISTS (
                  SELECT 1 FROM app.activity_events
                  WHERE organization_id = :organization_id
                    AND request_id = 'demo-starter-bootstrap-v1'
                )
                """,
                scope,
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
                    "demo starter bootstrap failed and rollback was not confirmed"
                ) from rollback_error
            if isinstance(error, MigrationError):
                raise
            raise MigrationError("demo starter bootstrap failed") from error

        self.verify(
            subject=subject,
            organization_id=organization_id,
            expected_user_id=user_id,
            project_id=project_id,
            dataset_id=dataset_id,
        )
        return {
            "projectId": project_id,
            "datasetId": dataset_id,
            "sourceVersion": source_version,
            "createdProject": project.get("created") is True,
            "createdDataset": dataset.get("created") is True,
            "createdSourceRevision": revision_created,
            "createdMap": map_record.get("created") is True,
            "visibility": "published",
        }

    def verify(
        self,
        *,
        subject: str,
        organization_id: str,
        expected_user_id: str,
        project_id: str,
        dataset_id: str,
    ) -> None:
        identity = self.migrator._rds_call(
            "execute_statement",
            **self.migrator._base(self.runtime_secret_arn),
            sql="""
            SELECT user_id, organization_id FROM app.resolve_principal(:subject)
            WHERE organization_id = :organization_id
            """.strip(),
            parameters=[
                string_parameter("subject", subject),
                string_parameter("organization_id", organization_id, type_hint="UUID"),
            ],
            formatRecordsAs="JSON",
        )
        if json.loads(identity.get("formattedRecords", "[]")) != [
            {"user_id": expected_user_id, "organization_id": organization_id}
        ]:
            raise MigrationError(
                "runtime demo verification could not resolve the owner"
            )
        transaction = self.migrator._rds_call(
            "begin_transaction", **self.migrator._base(self.runtime_secret_arn)
        )
        transaction_id = transaction.get("transactionId")
        if not isinstance(transaction_id, str) or not transaction_id:
            raise MigrationError("runtime demo verification transaction is unavailable")
        try:
            for setting, value in (
                ("app.organization_id", organization_id),
                ("app.user_id", expected_user_id),
            ):
                self._runtime_execute(
                    transaction_id,
                    "SELECT set_config(:setting, :value, true)",
                    [
                        string_parameter("setting", setting),
                        string_parameter("value", value),
                    ],
                )
            response = self._runtime_execute(
                transaction_id,
                """
                SELECT count(DISTINCT map.id)::int AS maps,
                       sum(jsonb_array_length(map.definition -> 'layers'))::int AS layers,
                       min(project.visibility::text) AS visibility,
                       min(membership.role::text) AS role
                FROM app.projects project
                JOIN app.project_memberships membership
                  ON membership.organization_id = project.organization_id
                 AND membership.project_id = project.id
                 AND membership.user_id = app.current_user_id()
                JOIN app.maps map
                  ON map.organization_id = project.organization_id
                 AND map.project_id = project.id AND map.status = 'active'
                JOIN app.external_sources source
                  ON source.organization_id = project.organization_id
                 AND source.dataset_id = :dataset_id AND source.source_type = 'geojson'
                WHERE project.organization_id = app.current_organization_id()
                  AND project.id = :project_id AND project.status = 'active'
                """,
                [
                    string_parameter("project_id", project_id, type_hint="UUID"),
                    string_parameter("dataset_id", dataset_id, type_hint="UUID"),
                ],
            )
            result = json.loads(response.get("formattedRecords", "[]"))
            if result != [
                {"maps": 1, "layers": 1, "visibility": "published", "role": "owner"}
            ]:
                raise MigrationError(
                    "runtime demo starter did not match the reviewed plan"
                )
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
                    "runtime demo verification failed and rollback was not confirmed"
                ) from rollback_error
            if isinstance(error, MigrationError):
                raise
            raise MigrationError("runtime demo verification failed") from error

    @staticmethod
    def _project_parameters(
        organization_id: str, project_id: str, user_id: str
    ) -> list[dict[str, Any]]:
        return [
            string_parameter("organization_id", organization_id, type_hint="UUID"),
            string_parameter("project_id", project_id, type_hint="UUID"),
            string_parameter("user_id", user_id, type_hint="UUID"),
        ]


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
    parser.add_argument("--organization-slug", default="opengeo-demo")
    parser.add_argument("--asset", type=Path, default=ASSET)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    if not COGNITO_SUBJECT.fullmatch(args.subject):
        raise MigrationError("subject must be a lowercase UUID")
    if not SLUG.fullmatch(args.organization_slug):
        raise MigrationError("organization slug is invalid")
    plan = load_plan(args.asset)
    print(
        json.dumps(
            {
                "status": "validated",
                "mode": "apply" if args.apply else "plan",
                "projectCode": PROJECT_CODE,
                "projectName": PROJECT_NAME,
                "visibility": "published",
                "datasets": 1,
                "maps": 1,
                "layers": 1,
                "features": 5,
                "sourceUrl": plan["sourceUrl"],
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
        raise MigrationError(
            f"--apply requires: {', '.join('--' + item for item in missing)}"
        )
    if not re.fullmatch(r"[0-9]{12}", args.expected_account):
        raise MigrationError("expected account must be a 12-digit AWS account id")
    cluster = CLUSTER_ARN.fullmatch(args.cluster_arn)
    secrets = [
        SECRET_ARN.fullmatch(args.admin_secret_arn),
        SECRET_ARN.fullmatch(args.runtime_secret_arn),
    ]
    if cluster is None or any(match is None for match in secrets):
        raise MigrationError("invalid database ARN")
    for match in [cluster, *secrets]:
        assert match is not None
        if (
            match.group("account") != args.expected_account
            or match.group("region") != args.region
        ):
            raise MigrationError(
                "database ARN does not match the expected AWS boundary"
            )
    try:
        import boto3
    except ImportError as error:
        raise MigrationError("boto3 is required for --apply") from error
    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    if (
        session.client("sts").get_caller_identity().get("Account")
        != args.expected_account
    ):
        raise MigrationError("active AWS identity does not match --expected-account")
    migrator = DataApiMigrator(
        rds_data=session.client("rds-data"),
        secrets_manager=session.client("secretsmanager"),
        cluster_arn=args.cluster_arn,
        admin_secret_arn=args.admin_secret_arn,
        database="opengeo",
    )
    result = DemoStarterBootstrap(migrator, args.runtime_secret_arn).apply(
        subject=args.subject,
        organization_slug=args.organization_slug,
        plan=plan,
    )
    print(json.dumps({"status": "applied", **result}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except MigrationError as error:
        print(f"demo starter bootstrap error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
