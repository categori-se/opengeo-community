#!/usr/bin/env python3
"""Verify project-dataset save/detach races against deployed Aurora.

The check commits one disposable fixture so two independent runtime
transactions can contend for the same project-dataset row. Acceptance-only
repository subclasses suppress audit/version side effects; the ordinary
repository authorization, reads, row locks, dependency checks, map update, and
detach statements remain unchanged. A separately authorized database-admin
secret removes the exact disposable records in a finally block. No database
password, AWS credential, access token, or transaction identifier is printed
or written to disk.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

API_SOURCE = Path(__file__).resolve().parents[2] / "services" / "api" / "src"
sys.path.insert(0, str(API_SOURCE))

from opengeo_api.config import Settings
from opengeo_api.ingestion import IngestionConflict, PostgresIngestionRepository
from opengeo_api.rds_data import RdsDataApiClient, RdsDataApiUnavailable
from opengeo_api.tenant_database import TenantContext, TenantTransaction
from opengeo_api.workspaces import (
    MapRecord,
    PostgresWorkspaceRepository,
    WorkspaceConflict,
)
from verify_reusable_project_datasets import (
    ACCOUNT,
    CLUSTER_ARN,
    REGION,
    SECRET_ARN,
    FrozenCredentialProvider,
    RollbackTransaction,
    SharedRollbackExecutor,
    VerificationError,
    discover_owner,
    load_aws_credentials,
    set_context,
)


class ConcurrencyWorkspaceRepository(PostgresWorkspaceRepository):
    """Exercise production map locking without durable acceptance audit rows."""

    async def _record_map_version(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        map_record: MapRecord,
        change_message: str | None,
    ) -> None:
        del transaction, context, map_record, change_message

    async def _record_event(
        self,
        transaction: TenantTransaction,
        context: TenantContext,
        request_id: str,
        event_type: str,
        resource_type: str,
        resource_id: UUID,
        project_id: UUID | None,
        payload: Mapping[str, Any],
    ) -> None:
        del (
            transaction,
            context,
            request_id,
            event_type,
            resource_type,
            resource_id,
            project_id,
            payload,
        )


class ConcurrencyIngestionRepository(PostgresIngestionRepository):
    """Exercise production detach locking without durable acceptance audit rows."""

    @staticmethod
    async def _record_event(
        transaction: TenantTransaction,
        context: TenantContext,
        project_id: UUID,
        event_type: str,
        dataset_id: UUID,
        request_id: str,
        payload: dict[str, Any],
    ) -> None:
        del (
            transaction,
            context,
            project_id,
            event_type,
            dataset_id,
            request_id,
            payload,
        )


def empty_definition() -> dict[str, Any]:
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


def dataset_definition(dataset_id: UUID) -> dict[str, Any]:
    return {
        **empty_definition(),
        "activeLayerId": "concurrent_dataset",
        "layers": [
            {
                "layerId": "concurrent_dataset",
                "datasetId": str(dataset_id),
                "title": "Concurrent project dataset",
                "sourceType": "geojson-object",
                "visible": True,
                "opacity": 1,
                "order": 0,
                "style": {"color": "#175cd3"},
                "labels": {"enabled": False, "field": None},
            }
        ],
    }


def data_api_client(
    args: argparse.Namespace,
    credentials: FrozenCredentialProvider,
    secret_arn: str,
) -> RdsDataApiClient:
    settings = Settings(
        env="dev",
        data_api_region=args.region,
        data_api_cluster_arn=args.cluster_arn,
        data_api_secret_arn=secret_arn,
        db_name="opengeo",
        readiness_timeout_seconds=10,
        data_api_resume_timeout_seconds=20,
    )
    return RdsDataApiClient(settings, credentials=credentials)


async def open_transaction(
    client: RdsDataApiClient,
    context: TenantContext,
    application_name: str,
    active_transactions: set[str],
) -> tuple[str, RollbackTransaction]:
    transaction_id = await client.begin()
    active_transactions.add(transaction_id)
    transaction = RollbackTransaction(client, transaction_id)
    await set_context(transaction, context)
    row = await transaction.fetch_one(
        "SELECT set_config('application_name', %s, true)",
        (application_name,),
    )
    if row is None:
        raise VerificationError("concurrency transaction name was not established")
    return transaction_id, transaction


async def commit(
    client: RdsDataApiClient,
    transaction_id: str,
    active_transactions: set[str],
) -> None:
    await client.commit(transaction_id)
    active_transactions.discard(transaction_id)


async def rollback(
    client: RdsDataApiClient,
    transaction_id: str,
    active_transactions: set[str],
) -> None:
    await client.rollback(transaction_id)
    active_transactions.discard(transaction_id)


async def wait_for_database_lock(
    admin_client: RdsDataApiClient,
    application_name: str,
    task: asyncio.Task[Any],
) -> str:
    deadline = asyncio.get_running_loop().time() + 8
    while asyncio.get_running_loop().time() < deadline:
        if task.done():
            try:
                await task
            except Exception as error:
                raise VerificationError(
                    "the losing transaction failed before waiting for the row lock"
                ) from error
            raise VerificationError(
                "the losing transaction completed instead of waiting for the row lock"
            )
        result = await admin_client.execute(
            """
            SELECT wait_event
            FROM pg_catalog.pg_stat_activity
            WHERE application_name = %s
              AND wait_event_type = 'Lock'
            ORDER BY backend_start DESC
            LIMIT 1
            """,
            (application_name,),
        )
        if result.records:
            return str(result.records[0][0])
        await asyncio.sleep(0.2)
    raise VerificationError(
        "the losing transaction did not expose a database lock wait"
    )


async def cleanup_fixture(
    admin_client: RdsDataApiClient,
    context: TenantContext,
    project_id: UUID,
    map_id: UUID,
    dataset_id: UUID,
) -> None:
    transaction_id = await admin_client.begin()
    transaction = RollbackTransaction(admin_client, transaction_id)
    try:
        await set_context(transaction, context)
        audit_count = await transaction.fetch_one(
            """
            SELECT count(*)
            FROM app.activity_events
            WHERE organization_id = %s
              AND (
                project_id = %s
                OR resource_id IN (%s, %s, %s)
              )
            """,
            (context.organization_id, project_id, project_id, map_id, dataset_id),
        )
        if audit_count != (0,):
            raise VerificationError(
                "disposable concurrency records unexpectedly produced immutable audit rows"
            )
        history_count = await transaction.fetch_one(
            """
            SELECT count(*) FROM app.map_versions
            WHERE organization_id = %s AND map_id = %s
            """,
            (context.organization_id, map_id),
        )
        if history_count != (0,):
            raise VerificationError(
                "disposable concurrency records unexpectedly produced immutable map history"
            )
        for statement, parameters in (
            (
                "DELETE FROM app.maps WHERE organization_id = %s AND id = %s",
                (context.organization_id, map_id),
            ),
            (
                """
                DELETE FROM app.project_datasets
                WHERE organization_id = %s AND project_id = %s AND dataset_id = %s
                """,
                (context.organization_id, project_id, dataset_id),
            ),
            (
                """
                DELETE FROM app.project_memberships
                WHERE organization_id = %s AND project_id = %s
                """,
                (context.organization_id, project_id),
            ),
            (
                "DELETE FROM app.datasets WHERE organization_id = %s AND id = %s",
                (context.organization_id, dataset_id),
            ),
            (
                "DELETE FROM app.projects WHERE organization_id = %s AND id = %s",
                (context.organization_id, project_id),
            ),
        ):
            await transaction.execute(statement, parameters)
        remaining = await transaction.fetch_one(
            """
            SELECT
              (SELECT count(*) FROM app.projects
               WHERE organization_id = %s AND id = %s)
              + (SELECT count(*) FROM app.datasets
                 WHERE organization_id = %s AND id = %s)
              + (SELECT count(*) FROM app.maps
                 WHERE organization_id = %s AND id = %s)
              + (SELECT count(*) FROM app.project_datasets
                 WHERE organization_id = %s AND project_id = %s AND dataset_id = %s)
            """,
            (
                context.organization_id,
                project_id,
                context.organization_id,
                dataset_id,
                context.organization_id,
                map_id,
                context.organization_id,
                project_id,
                dataset_id,
            ),
        )
        if remaining != (0,):
            raise VerificationError("disposable concurrency records were not removed")
    except BaseException:
        await admin_client.rollback(transaction_id)
        raise
    await admin_client.commit(transaction_id)


async def verify(args: argparse.Namespace) -> dict[str, Any]:
    aws_credentials = load_aws_credentials(
        args.profile, args.region, args.expected_account
    )
    credentials = FrozenCredentialProvider(aws_credentials)
    runtime_client = data_api_client(args, credentials, args.runtime_secret_arn)
    admin_client = data_api_client(args, credentials, args.admin_secret_arn)
    active_transactions: set[str] = set()
    organization_id = UUID(args.organization_id)
    reviewed_project_id = UUID(args.project_id)
    project_id = uuid4()
    map_id = uuid4()
    dataset_id = uuid4()
    context: TenantContext | None = None
    setup_committed = False
    fixture_removed = False
    rollback_error: RdsDataApiUnavailable | None = None
    result: dict[str, Any] | None = None
    try:
        discovery_id = await runtime_client.begin()
        active_transactions.add(discovery_id)
        discovery = RollbackTransaction(runtime_client, discovery_id)
        owner_id = await discover_owner(discovery, organization_id, reviewed_project_id)
        await rollback(runtime_client, discovery_id, active_transactions)
        context = TenantContext(user_id=owner_id, organization_id=organization_id)

        setup_id, setup = await open_transaction(
            runtime_client,
            context,
            f"opengeo-concurrency-setup-{project_id.hex[:8]}",
            active_transactions,
        )
        for statement, parameters in (
            (
                """
                INSERT INTO app.projects (id, organization_id, name, created_by)
                VALUES (%s, %s, 'OpenGeo concurrency acceptance', %s)
                """,
                (project_id, organization_id, owner_id),
            ),
            (
                """
                INSERT INTO app.project_memberships
                  (organization_id, project_id, user_id, role)
                VALUES (%s, %s, %s, 'owner')
                """,
                (organization_id, project_id, owner_id),
            ),
            (
                """
                INSERT INTO app.datasets
                  (id, organization_id, name, classification, source_type, format,
                   status, owner_user_id, created_by, updated_by)
                VALUES (%s, %s, 'OpenGeo concurrency acceptance', 'internal',
                        'upload', 'geojson', 'active', %s, %s, %s)
                """,
                (dataset_id, organization_id, owner_id, owner_id, owner_id),
            ),
            (
                """
                INSERT INTO app.project_datasets
                  (organization_id, project_id, dataset_id, linked_by)
                VALUES (%s, %s, %s, %s)
                """,
                (organization_id, project_id, dataset_id, owner_id),
            ),
            (
                """
                INSERT INTO app.maps
                  (id, organization_id, project_id, name, definition,
                   created_by, updated_by)
                VALUES (%s, %s, %s, 'OpenGeo concurrency acceptance map',
                        %s::jsonb, %s, %s)
                """,
                (
                    map_id,
                    organization_id,
                    project_id,
                    json.dumps(empty_definition()),
                    owner_id,
                    owner_id,
                ),
            ),
        ):
            if await setup.execute(statement, parameters) != 1:
                raise VerificationError(
                    "concurrency fixture insert did not affect one row"
                )
        await commit(runtime_client, setup_id, active_transactions)
        setup_committed = True

        save_id, save_transaction = await open_transaction(
            runtime_client,
            context,
            f"opengeo-save-winner-{project_id.hex[:8]}",
            active_transactions,
        )
        save_repository = ConcurrencyWorkspaceRepository(
            SharedRollbackExecutor(save_transaction)
        )
        saved = await save_repository.update_map(
            context,
            project_id,
            map_id,
            1,
            {"definition": dataset_definition(dataset_id)},
            "Concurrent save wins",
            "accept-concurrent-save-winner",
        )
        if saved.version != 2:
            raise VerificationError("save-winner map version did not advance")

        detach_wait_name = f"opengeo-detach-wait-{project_id.hex[:8]}"
        detach_wait_id, detach_wait_transaction = await open_transaction(
            runtime_client,
            context,
            detach_wait_name,
            active_transactions,
        )
        detach_wait_repository = ConcurrencyIngestionRepository(
            SharedRollbackExecutor(detach_wait_transaction), storage=object()
        )
        detach_wait_task = asyncio.create_task(
            detach_wait_repository.detach_dataset(
                context,
                project_id,
                dataset_id,
                "accept-concurrent-detach-loser",
            )
        )
        save_winner_wait = await wait_for_database_lock(
            admin_client, detach_wait_name, detach_wait_task
        )
        await commit(runtime_client, save_id, active_transactions)
        try:
            await detach_wait_task
        except IngestionConflict as error:
            if error.code != "project_dataset_in_use":
                raise VerificationError(
                    "save-winner detach returned the wrong conflict"
                ) from error
        else:
            raise VerificationError(
                "detach succeeded after the concurrent save committed"
            )
        await rollback(runtime_client, detach_wait_id, active_transactions)

        reset_id, reset_transaction = await open_transaction(
            runtime_client,
            context,
            f"opengeo-concurrency-reset-{project_id.hex[:8]}",
            active_transactions,
        )
        reset_repository = ConcurrencyWorkspaceRepository(
            SharedRollbackExecutor(reset_transaction)
        )
        reset = await reset_repository.update_map(
            context,
            project_id,
            map_id,
            2,
            {"definition": empty_definition()},
            "Prepare detach-winner race",
            "accept-concurrent-reset",
        )
        if reset.version != 3:
            raise VerificationError("race reset did not advance the map version")
        await commit(runtime_client, reset_id, active_transactions)

        detach_id, detach_transaction = await open_transaction(
            runtime_client,
            context,
            f"opengeo-detach-winner-{project_id.hex[:8]}",
            active_transactions,
        )
        detach_repository = ConcurrencyIngestionRepository(
            SharedRollbackExecutor(detach_transaction), storage=object()
        )
        await detach_repository.detach_dataset(
            context,
            project_id,
            dataset_id,
            "accept-concurrent-detach-winner",
        )

        save_wait_name = f"opengeo-save-wait-{project_id.hex[:8]}"
        save_wait_id, save_wait_transaction = await open_transaction(
            runtime_client,
            context,
            save_wait_name,
            active_transactions,
        )
        save_wait_repository = ConcurrencyWorkspaceRepository(
            SharedRollbackExecutor(save_wait_transaction)
        )
        save_wait_task = asyncio.create_task(
            save_wait_repository.update_map(
                context,
                project_id,
                map_id,
                3,
                {"definition": dataset_definition(dataset_id)},
                "Concurrent detach wins",
                "accept-concurrent-save-loser",
            )
        )
        detach_winner_wait = await wait_for_database_lock(
            admin_client, save_wait_name, save_wait_task
        )
        await commit(runtime_client, detach_id, active_transactions)
        try:
            await save_wait_task
        except WorkspaceConflict as error:
            if error.code != "map_dataset_not_linked":
                raise VerificationError(
                    "detach-winner save returned the wrong conflict"
                ) from error
        else:
            raise VerificationError(
                "save succeeded after the concurrent detach committed"
            )
        await rollback(runtime_client, save_wait_id, active_transactions)

        verify_id, verify_transaction = await open_transaction(
            runtime_client,
            context,
            f"opengeo-concurrency-read-{project_id.hex[:8]}",
            active_transactions,
        )
        final_state = await verify_transaction.fetch_one(
            """
            SELECT map.version,
                   jsonb_array_length(map.definition->'layers'),
                   EXISTS (
                     SELECT 1 FROM app.project_datasets link
                     WHERE link.organization_id = %s
                       AND link.project_id = %s
                       AND link.dataset_id = %s
                   )
            FROM app.maps map
            WHERE map.organization_id = %s AND map.project_id = %s AND map.id = %s
            """,
            (
                organization_id,
                project_id,
                dataset_id,
                organization_id,
                project_id,
                map_id,
            ),
        )
        await rollback(runtime_client, verify_id, active_transactions)
        if final_state != (3, 0, False):
            raise VerificationError("detach-winner final state was not atomic")

        result = {
            "status": "passed",
            "databaseRole": "opengeo_runtime",
            "saveWinner": {
                "losingDetachObservedWaiting": save_winner_wait,
                "mapVersion": 2,
                "detachResult": "project_dataset_in_use",
            },
            "detachWinner": {
                "losingSaveObservedWaiting": detach_winner_wait,
                "mapVersion": 3,
                "projectDatasetLinked": False,
                "saveResult": "map_dataset_not_linked",
            },
            "productionRepositoryLocking": True,
            "acceptanceAuditHooksSuppressed": True,
            "credentialMaterialRecorded": False,
        }
    finally:
        for transaction_id in tuple(active_transactions):
            try:
                await runtime_client.rollback(transaction_id)
            except RdsDataApiUnavailable as error:
                rollback_error = error
            active_transactions.discard(transaction_id)
        if setup_committed and context is not None:
            await cleanup_fixture(admin_client, context, project_id, map_id, dataset_id)
            fixture_removed = True
        if rollback_error is not None:
            raise VerificationError(
                "an acceptance transaction could not be rolled back"
            ) from rollback_error

    if result is None:
        raise VerificationError("concurrency acceptance did not produce a result")
    result["disposableFixtureRemoved"] = fixture_removed
    return result


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--expected-account", required=True)
    parser.add_argument("--cluster-arn", required=True)
    parser.add_argument("--runtime-secret-arn", required=True)
    parser.add_argument("--admin-secret-arn", required=True)
    parser.add_argument("--organization-id", required=True)
    parser.add_argument("--project-id", required=True)
    args = parser.parse_args(argv)
    if ACCOUNT.fullmatch(args.expected_account) is None:
        raise VerificationError("expected account must be a 12-digit AWS account id")
    if REGION.fullmatch(args.region) is None:
        raise VerificationError("region is invalid")
    cluster = CLUSTER_ARN.fullmatch(args.cluster_arn)
    secrets = [
        SECRET_ARN.fullmatch(args.runtime_secret_arn),
        SECRET_ARN.fullmatch(args.admin_secret_arn),
    ]
    if cluster is None or any(secret is None for secret in secrets):
        raise VerificationError("cluster or database secret ARN is invalid")
    for match in (cluster, *secrets):
        assert match is not None
        if (
            match.group("account") != args.expected_account
            or match.group("region") != args.region
        ):
            raise VerificationError(
                "AWS resource ARN does not match account and region"
            )
    if args.runtime_secret_arn == args.admin_secret_arn:
        raise VerificationError("runtime and admin database secrets must differ")
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
