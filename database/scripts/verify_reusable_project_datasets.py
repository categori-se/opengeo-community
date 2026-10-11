#!/usr/bin/env python3
"""Verify reusable project datasets against a deployed Aurora database.

The check uses the same Data API client, tenant transaction contract, and
repository implementation as the request-serving API. It creates bounded test
records inside one database transaction and always rolls that transaction
back. No password, session credential, token, or test record is printed or
written to disk.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
from collections.abc import Awaitable, Callable, Sequence
from pathlib import Path
from typing import Any, TypeVar, cast
from uuid import UUID, uuid4

API_SOURCE = Path(__file__).resolve().parents[2] / "services" / "api" / "src"
sys.path.insert(0, str(API_SOURCE))

from opengeo_api.cognito_provisioning import AwsCredentials
from opengeo_api.config import Settings
from opengeo_api.ingestion import (
    IngestionConflict,
    PostgresIngestionRepository,
)
from opengeo_api.rds_data import RdsDataApiClient
from opengeo_api.tenant_database import (
    TenantContext,
    TenantTransaction,
)
from opengeo_api.workspaces import MapDraft, PostgresWorkspaceRepository

ACCOUNT = re.compile(r"^[0-9]{12}$")
REGION = re.compile(r"^[a-z]{2}(?:-gov)?-[a-z0-9-]+-[0-9]+$")
CLUSTER_ARN = re.compile(
    r"^arn:aws(?:-us-gov)?:rds:(?P<region>[^:]+):(?P<account>[0-9]{12}):"
    r"cluster:[A-Za-z0-9][A-Za-z0-9-]{0,62}$"
)
SECRET_ARN = re.compile(
    r"^arn:aws(?:-us-gov)?:secretsmanager:(?P<region>[^:]+):"
    r"(?P<account>[0-9]{12}):secret:[A-Za-z0-9/_+=.@-]+$"
)
ResultT = TypeVar("ResultT")


class VerificationError(RuntimeError):
    """Raised when deployed reusable-dataset behavior violates its contract."""


class FrozenCredentialProvider:
    def __init__(self, credentials: AwsCredentials) -> None:
        self._credentials = credentials

    def load(self) -> AwsCredentials:
        return self._credentials


def load_aws_credentials(
    profile: str, region: str, expected_account: str
) -> AwsCredentials:
    environment = {
        **os.environ,
        "AWS_PROFILE": profile,
        "AWS_REGION": region,
        "AWS_DEFAULT_REGION": region,
    }
    identity = aws_json(["sts", "get-caller-identity"], environment, "AWS identity")
    if identity.get("Account") != expected_account:
        raise VerificationError("active AWS identity does not match --expected-account")
    exported = aws_json(
        [
            "configure",
            "export-credentials",
            "--profile",
            profile,
            "--format",
            "process",
        ],
        environment,
        "AWS session credentials",
    )
    try:
        access_key = exported["AccessKeyId"]
        secret_key = exported["SecretAccessKey"]
        session_token = exported.get("SessionToken")
    except KeyError as error:
        raise VerificationError("AWS session credentials are incomplete") from error
    if not isinstance(access_key, str) or not isinstance(secret_key, str):
        raise VerificationError("AWS session credentials are invalid")
    if session_token is not None and not isinstance(session_token, str):
        raise VerificationError("AWS session token is invalid")
    return AwsCredentials(access_key, secret_key, session_token)


def aws_json(
    arguments: list[str], environment: dict[str, str], label: str
) -> dict[str, Any]:
    try:
        completed = subprocess.run(
            ["aws", *arguments, "--output", "json"],
            env=environment,
            check=True,
            capture_output=True,
            text=True,
            timeout=20,
        )
        result = json.loads(completed.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        raise VerificationError(f"{label} could not be loaded") from error
    if not isinstance(result, dict):
        raise VerificationError(f"{label} response is invalid")
    return cast(dict[str, Any], result)


class RollbackTransaction:
    def __init__(self, client: RdsDataApiClient, transaction_id: str) -> None:
        self.client = client
        self.transaction_id = transaction_id

    async def fetch_one(
        self, statement: str, parameters: Sequence[Any] = ()
    ) -> tuple[Any, ...] | None:
        result = await self.client.execute(statement, parameters, self.transaction_id)
        return result.records[0] if result.records else None

    async def fetch_all(
        self, statement: str, parameters: Sequence[Any] = ()
    ) -> list[tuple[Any, ...]]:
        result = await self.client.execute(statement, parameters, self.transaction_id)
        return list(result.records)

    async def execute(self, statement: str, parameters: Sequence[Any] = ()) -> int:
        result = await self.client.execute(statement, parameters, self.transaction_id)
        return result.updated


class SharedRollbackExecutor:
    """Run API repository operations in one externally rolled-back transaction."""

    def __init__(self, transaction: RollbackTransaction) -> None:
        self.transaction = transaction

    async def fetch_one(
        self,
        context: TenantContext,
        statement: str,
        parameters: Sequence[Any] = (),
    ) -> tuple[Any, ...] | None:
        async def operation(
            transaction: TenantTransaction,
        ) -> tuple[Any, ...] | None:
            return await transaction.fetch_one(statement, parameters)

        return await self.run(context, operation)

    async def run(
        self,
        context: TenantContext,
        operation: Callable[[TenantTransaction], Awaitable[ResultT]],
    ) -> ResultT:
        await set_context(self.transaction, context)
        return await operation(self.transaction)


async def set_context(transaction: RollbackTransaction, context: TenantContext) -> None:
    row = await transaction.fetch_one(
        """
        SELECT set_config('app.user_id', %s, true),
               set_config('app.organization_id', %s, true),
               set_config('statement_timeout', '10000ms', true),
               set_config('timezone', 'UTC', true)
        """,
        (str(context.user_id), str(context.organization_id)),
    )
    if row is None:
        raise VerificationError("tenant context was not established")


async def discover_owner(
    transaction: RollbackTransaction,
    organization_id: UUID,
    project_id: UUID,
) -> UUID:
    await set_context(
        transaction,
        TenantContext(
            user_id=UUID("00000000-0000-4000-8000-000000000001"),
            organization_id=organization_id,
        ),
    )
    row = await transaction.fetch_one(
        """
        SELECT membership.user_id
        FROM app.project_memberships membership
        JOIN app.organization_memberships organization_membership
          ON organization_membership.organization_id = membership.organization_id
         AND organization_membership.user_id = membership.user_id
        WHERE membership.organization_id = %s
          AND membership.project_id = %s
          AND membership.role = 'owner'
          AND organization_membership.role = 'admin'
        ORDER BY membership.created_at, membership.user_id
        LIMIT 1
        """,
        (organization_id, project_id),
    )
    if row is None or not isinstance(row[0], UUID):
        raise VerificationError("the reviewed dev project has no admin owner")
    return row[0]


async def verify(args: argparse.Namespace) -> dict[str, Any]:
    credentials = load_aws_credentials(args.profile, args.region, args.expected_account)

    settings = Settings(
        env="dev",
        data_api_region=args.region,
        data_api_cluster_arn=args.cluster_arn,
        data_api_secret_arn=args.runtime_secret_arn,
        db_name="opengeo",
        readiness_timeout_seconds=10,
        data_api_resume_timeout_seconds=20,
    )
    client = RdsDataApiClient(
        settings,
        credentials=FrozenCredentialProvider(credentials),
    )
    transaction_id = await client.begin()
    transaction = RollbackTransaction(client, transaction_id)
    dataset_id = uuid4()
    external_dataset_id = uuid4()
    second_project_id = uuid4()
    first_map_id = uuid4()
    second_map_id = uuid4()
    organization_id = UUID(args.organization_id)
    first_project_id = UUID(args.project_id)
    rolled_back = False
    result: dict[str, Any] | None = None
    try:
        owner_id = await discover_owner(transaction, organization_id, first_project_id)
        context = TenantContext(user_id=owner_id, organization_id=organization_id)
        await set_context(transaction, context)
        for statement, parameters in (
            (
                """
                INSERT INTO app.projects (id, organization_id, name, created_by)
                VALUES (%s, %s, 'Reusable dataset acceptance B', %s)
                """,
                (second_project_id, organization_id, owner_id),
            ),
            (
                """
                INSERT INTO app.project_memberships
                  (organization_id, project_id, user_id, role)
                VALUES (%s, %s, %s, 'owner')
                """,
                (organization_id, second_project_id, owner_id),
            ),
            (
                """
                INSERT INTO app.datasets
                  (id, organization_id, name, classification, format,
                   owner_user_id, created_by, updated_by)
                VALUES (%s, %s, 'Reusable dataset acceptance', 'internal',
                        'geojson', %s, %s, %s)
                """,
                (dataset_id, organization_id, owner_id, owner_id, owner_id),
            ),
            (
                """
                INSERT INTO app.project_datasets
                  (organization_id, project_id, dataset_id, linked_by)
                VALUES (%s, %s, %s, %s)
                """,
                (organization_id, first_project_id, dataset_id, owner_id),
            ),
        ):
            if await transaction.execute(statement, parameters) != 1:
                raise VerificationError(
                    "acceptance fixture insert did not affect one row"
                )

        unused_storage: Any = object()
        repository = PostgresIngestionRepository(
            SharedRollbackExecutor(transaction), storage=unused_storage
        )
        attached = await repository.attach_dataset(
            context, second_project_id, dataset_id, "accept-reusable-attach-1"
        )
        if (
            attached.dataset_id != dataset_id
            or attached.project_id != second_project_id
        ):
            raise VerificationError("repository returned the wrong attached dataset")
        await repository.detach_dataset(
            context, second_project_id, dataset_id, "accept-reusable-detach"
        )
        await repository.attach_dataset(
            context, second_project_id, dataset_id, "accept-reusable-attach-2"
        )

        for map_id, project_id, color in (
            (first_map_id, first_project_id, "#b42318"),
            (second_map_id, second_project_id, "#175cd3"),
        ):
            updated = await transaction.execute(
                """
                INSERT INTO app.maps
                  (id, organization_id, project_id, name, definition,
                   created_by, updated_by)
                VALUES (
                  %s, %s, %s, 'Reusable dataset acceptance map',
                  jsonb_build_object(
                    'layers', jsonb_build_array(
                      jsonb_build_object(
                        'datasetId', %s::text,
                        'style', jsonb_build_object('color', %s::text)
                      )
                    ),
                    'bookmarks', '[]'::jsonb
                  ),
                  %s, %s
                )
                """,
                (
                    map_id,
                    organization_id,
                    project_id,
                    dataset_id,
                    color,
                    owner_id,
                    owner_id,
                ),
            )
            if updated != 1:
                raise VerificationError("acceptance map insert did not affect one row")

        shared = await transaction.fetch_one(
            """
            SELECT
              (SELECT count(*) FROM app.datasets WHERE id = %s),
              (SELECT count(*) FROM app.project_datasets WHERE dataset_id = %s),
              (SELECT array_agg(map.definition #>> '{layers,0,style,color}'
                                ORDER BY map.project_id)
               FROM app.maps map
               WHERE map.id IN (%s, %s))
            """,
            (dataset_id, dataset_id, first_map_id, second_map_id),
        )
        if shared is None or shared[0] != 1 or shared[1] != 2:
            raise VerificationError(
                "one dataset was not referenced by exactly two projects"
            )
        if sorted(shared[2]) != ["#175cd3", "#b42318"]:
            raise VerificationError("project-specific styles were not independent")

        try:
            await repository.detach_dataset(
                context, second_project_id, dataset_id, "accept-reusable-guard"
            )
        except IngestionConflict as error:
            if str(error) != "project_dataset_in_use":
                raise VerificationError("detach returned the wrong conflict") from error
        else:
            raise VerificationError(
                "detach succeeded while a saved map used the dataset"
            )

        events = await transaction.fetch_all(
            """
            SELECT event_type
            FROM app.activity_events
            WHERE resource_id = %s
            ORDER BY occurred_at, id
            """,
            (dataset_id,),
        )
        event_types = [str(row[0]) for row in events]
        if event_types != [
            "project.dataset.attached",
            "project.dataset.detached",
            "project.dataset.attached",
        ]:
            raise VerificationError("attach/detach activity events were incomplete")

        revision_one_url = "https://tiles.example.test/v1/{z}/{x}/{y}.png"
        revision_two_url = "https://tiles.example.test/v2/{z}/{x}/{y}.png"
        revision_one_configuration = {
            "min_zoom": 0,
            "max_zoom": 18,
            "tile_size": 256,
            "scheme": "xyz",
            "attribution": "OpenGeo acceptance revision one",
        }
        revision_two_configuration = {
            **revision_one_configuration,
            "attribution": "OpenGeo acceptance revision two",
        }
        for statement, parameters in (
            (
                """
                INSERT INTO app.datasets
                  (id, organization_id, name, classification, source_type, format,
                   status, owner_user_id, created_by, updated_by)
                VALUES (%s, %s, 'Historical source revision acceptance', 'internal',
                        'xyz', 'xyz', 'active', %s, %s, %s)
                """,
                (
                    external_dataset_id,
                    organization_id,
                    owner_id,
                    owner_id,
                    owner_id,
                ),
            ),
            (
                """
                INSERT INTO app.project_datasets
                  (organization_id, project_id, dataset_id, linked_by)
                VALUES (%s, %s, %s, %s)
                """,
                (organization_id, first_project_id, external_dataset_id, owner_id),
            ),
            (
                """
                INSERT INTO app.external_sources
                  (organization_id, dataset_id, source_type, created_by)
                VALUES (%s, %s, 'xyz', %s)
                """,
                (organization_id, external_dataset_id, owner_id),
            ),
            (
                """
                INSERT INTO app.external_source_revisions
                  (organization_id, dataset_id, version_number, source_url,
                   configuration, change_message, created_by)
                VALUES (%s, %s, 1, %s, %s::jsonb, 'Initial source', %s)
                """,
                (
                    organization_id,
                    external_dataset_id,
                    revision_one_url,
                    json.dumps(revision_one_configuration),
                    owner_id,
                ),
            ),
            (
                """
                INSERT INTO app.external_source_revisions
                  (organization_id, dataset_id, version_number, source_url,
                   configuration, change_message, created_by)
                VALUES (%s, %s, 2, %s, %s::jsonb, 'Advanced source', %s)
                """,
                (
                    organization_id,
                    external_dataset_id,
                    revision_two_url,
                    json.dumps(revision_two_configuration),
                    owner_id,
                ),
            ),
        ):
            if await transaction.execute(statement, parameters) != 1:
                raise VerificationError(
                    "historical source acceptance insert did not affect one row"
                )

        historical_definition = {
            "schemaVersion": "opengeo.map-definition.1.3.0",
            "mapViews": [],
            "basemaps": [],
            "bookmarks": [],
            "activeLayerId": "historical_xyz",
            "activeProcessingModelId": None,
            "models": [],
            "processingHistory": [],
            "measurements": [],
            "projection": "mercator",
            "colorMode": "dark",
            "layers": [
                {
                    "layerId": "historical_xyz",
                    "datasetId": str(external_dataset_id),
                    "title": "Historical XYZ revision",
                    "sourceType": "xyz-raster",
                    "sourceVersion": 1,
                    "sourceUrl": revision_one_url,
                    "sourceConfiguration": {
                        "minZoom": 0,
                        "maxZoom": 18,
                        "tileSize": 256,
                        "scheme": "xyz",
                        "attribution": "OpenGeo acceptance revision one",
                    },
                    "visible": True,
                    "opacity": 1,
                    "order": 0,
                    "style": {},
                    "labels": {"enabled": False, "field": None},
                }
            ],
        }
        workspace = PostgresWorkspaceRepository(SharedRollbackExecutor(transaction))
        historical_map = await workspace.create_map(
            context,
            first_project_id,
            MapDraft(
                name="Historical source revision acceptance map",
                description=None,
                definition=historical_definition,
            ),
            "accept-historical-source-revision",
        )
        reloaded_historical_map = await workspace.get_map(
            context, first_project_id, historical_map.map_id
        )
        source_state = await transaction.fetch_one(
            """
            SELECT max(version_number), count(*)
            FROM app.external_source_revisions
            WHERE organization_id = %s AND dataset_id = %s
            """,
            (organization_id, external_dataset_id),
        )
        reloaded_layer = reloaded_historical_map.definition["layers"][0]
        if source_state != (2, 2):
            raise VerificationError(
                "the governed source did not advance to revision two"
            )
        if (
            reloaded_layer.get("sourceVersion") != 1
            or reloaded_layer.get("sourceUrl") != revision_one_url
            or reloaded_layer.get("sourceConfiguration")
            != historical_definition["layers"][0]["sourceConfiguration"]
        ):
            raise VerificationError(
                "the saved map did not retain its exact historical source revision"
            )

        privileges = await transaction.fetch_one(
            """
            SELECT
              has_table_privilege('opengeo_runtime', 'app.project_datasets', 'DELETE'),
              has_table_privilege('opengeo_worker', 'app.project_datasets', 'DELETE'),
              has_table_privilege('opengeo_connector', 'app.project_datasets', 'DELETE'),
              has_table_privilege(
                'opengeo_observable_coordinator', 'app.project_datasets', 'DELETE'
              ),
              has_table_privilege(
                'opengeo_dataset_verifier', 'app.project_datasets', 'DELETE'
              ),
              has_column_privilege(
                'opengeo_runtime', 'app.project_datasets', 'linked_at', 'UPDATE'
              ),
              has_column_privilege(
                'opengeo_worker', 'app.project_datasets', 'linked_at', 'UPDATE'
              ),
              has_column_privilege(
                'opengeo_connector', 'app.project_datasets', 'linked_at', 'UPDATE'
              ),
              has_column_privilege(
                'opengeo_observable_coordinator',
                'app.project_datasets',
                'linked_at',
                'UPDATE'
              ),
              has_column_privilege(
                'opengeo_dataset_verifier',
                'app.project_datasets',
                'linked_at',
                'UPDATE'
              )
            """
        )
        if privileges != (
            True,
            False,
            False,
            False,
            False,
            True,
            False,
            False,
            False,
            False,
        ):
            raise VerificationError(
                "deployed detach privileges exceed the reviewed roles"
            )

        different_context = TenantContext(
            user_id=owner_id,
            organization_id=UUID("ffffffff-ffff-4fff-8fff-ffffffffffff"),
        )
        await set_context(transaction, different_context)
        isolated = await transaction.fetch_one(
            "SELECT count(*) FROM app.datasets WHERE id = %s", (dataset_id,)
        )
        if isolated != (0,):
            raise VerificationError("tenant isolation exposed the acceptance dataset")
        await set_context(transaction, context)

        result = {
            "status": "passed",
            "databaseRole": "opengeo_runtime",
            "singleDatasetRecord": True,
            "projectReferenceCount": 2,
            "independentProjectStyles": True,
            "reloadQueryMatched": True,
            "detachWithoutDependency": "passed",
            "detachWithSavedMap": "project_dataset_in_use",
            "activityEvents": event_types,
            "tenantIsolation": "passed",
            "historicalSourceRevision": {
                "catalogCurrentRevision": 2,
                "savedMapRevision": 1,
                "exactSnapshotReload": "passed",
            },
            "leastPrivilegeDelete": {
                "runtime": True,
                "worker": False,
                "connector": False,
                "observableCoordinator": False,
                "datasetVerifier": False,
            },
            "leastPrivilegeDetachLock": {
                "runtimeLinkedAt": True,
                "workerLinkedAt": False,
                "connectorLinkedAt": False,
                "observableCoordinatorLinkedAt": False,
                "datasetVerifierLinkedAt": False,
            },
            "credentialMaterialRecorded": False,
        }
    finally:
        await client.rollback(transaction_id)
        rolled_back = True

    if result is None:
        raise VerificationError("acceptance did not produce a result")
    result["testTransactionRolledBack"] = rolled_back
    return result


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--expected-account", required=True)
    parser.add_argument("--cluster-arn", required=True)
    parser.add_argument("--runtime-secret-arn", required=True)
    parser.add_argument("--organization-id", required=True)
    parser.add_argument("--project-id", required=True)
    args = parser.parse_args(argv)
    if ACCOUNT.fullmatch(args.expected_account) is None:
        raise VerificationError("expected account must be a 12-digit AWS account id")
    if REGION.fullmatch(args.region) is None:
        raise VerificationError("region is invalid")
    cluster = CLUSTER_ARN.fullmatch(args.cluster_arn)
    secret = SECRET_ARN.fullmatch(args.runtime_secret_arn)
    if cluster is None or secret is None:
        raise VerificationError("cluster or runtime secret ARN is invalid")
    for match in (cluster, secret):
        if (
            match.group("account") != args.expected_account
            or match.group("region") != args.region
        ):
            raise VerificationError(
                "AWS resource ARN does not match account and region"
            )
    for value, label in (
        (args.organization_id, "organization"),
        (args.project_id, "project"),
    ):
        try:
            UUID(value)
        except ValueError as error:
            raise VerificationError(f"{label} id is not a UUID") from error
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    print(json.dumps(asyncio.run(verify(args)), indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except VerificationError as error:
        print(f"verification error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
