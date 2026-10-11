#!/usr/bin/env python3
"""Verify M1 project and collaboration behavior in the deployed dev database.

The verifier uses the request-serving ``opengeo_runtime`` role and one Aurora
Data API transaction. It creates a project, its first map, a synthetic team
member, and a team grant; exercises effective-role resolution, duplicate-grant
and stale-map conflicts, activity records, and a fresh repository reload; then
rolls the complete transaction back. It prints counts and outcomes only. No
credential, identity, token, email, or resource identifier is written to its
receipt.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

API_SOURCE = Path(__file__).resolve().parents[2] / "services" / "api" / "src"
SCRIPT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(API_SOURCE))
sys.path.insert(0, str(SCRIPT_ROOT))

from opengeo_api.config import Settings
from opengeo_api.rds_data import RdsDataApiClient, RdsDataApiUnavailable
from opengeo_api.teams import PostgresTeamRepository, TeamConflict
from opengeo_api.tenant_database import TenantContext
from opengeo_api.workspaces import (
    MapDraft,
    PostgresWorkspaceRepository,
    ProjectDraft,
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
    load_aws_credentials,
    set_context,
)

DEVELOPMENT_ACCOUNT = "222222222222"
CONFIRMATION = "verify-rollback-only-m1-collaboration-in-development"
REQUEST_ID = re.compile(r"^[a-z0-9][a-z0-9-]{2,119}$")


class M1VerificationError(VerificationError):
    """Raised when deployed M1 collaboration behavior violates its contract."""


class TrackedRollbackTransaction(RollbackTransaction):
    """Retain only a redacted operation/table label for failed live assertions."""

    last_operation = "none"

    @staticmethod
    def _operation(statement: str) -> str:
        verb = re.match(r"\s*([A-Za-z]+)", statement)
        relation = re.search(
            r"\b(?:FROM|INTO|UPDATE)\s+(app\.[a-z_]+)", statement, re.IGNORECASE
        )
        return " ".join(
            value
            for value in (
                verb.group(1).lower() if verb else "statement",
                relation.group(1).lower() if relation else "database",
            )
            if value
        )

    async def fetch_one(
        self, statement: str, parameters: Sequence[Any] = ()
    ) -> tuple[Any, ...] | None:
        self.last_operation = self._operation(statement)
        return await super().fetch_one(statement, parameters)

    async def fetch_all(
        self, statement: str, parameters: Sequence[Any] = ()
    ) -> list[tuple[Any, ...]]:
        self.last_operation = self._operation(statement)
        return await super().fetch_all(statement, parameters)

    async def execute(self, statement: str, parameters: Sequence[Any] = ()) -> int:
        self.last_operation = self._operation(statement)
        return await super().execute(statement, parameters)


def empty_map_definition(*, color_mode: str = "dark") -> dict[str, Any]:
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
        "colorMode": color_mode,
        "layers": [],
    }


async def verify(args: argparse.Namespace) -> dict[str, Any]:
    validate_scope(args)
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
    transaction = TrackedRollbackTransaction(client, transaction_id)
    executor = SharedRollbackExecutor(transaction)
    workspace = PostgresWorkspaceRepository(executor)
    teams = PostgresTeamRepository(executor)
    organization_id = UUID(args.organization_id)
    owner_id = UUID(args.user_id)
    request_nonce = uuid4().hex[:12]
    request_ids: list[str] = []
    rolled_back = False
    result: dict[str, Any] | None = None
    stage = "initialize"

    def request(label: str) -> str:
        value = f"m1-{request_nonce}-{label}"
        if REQUEST_ID.fullmatch(value) is None:
            raise M1VerificationError("generated request id is invalid")
        request_ids.append(value)
        return value

    try:
        owner = TenantContext(user_id=owner_id, organization_id=organization_id)
        stage = "owner membership"
        await set_context(transaction, owner)
        owner_role = await transaction.fetch_one(
            """
            SELECT role::text FROM app.organization_memberships
            WHERE organization_id = %s AND user_id = %s
            """,
            (organization_id, owner_id),
        )
        if owner_role != ("admin",):
            raise M1VerificationError(
                "the intended M1 user is not an organization admin"
            )

        stage = "member selection"
        existing_member = await transaction.fetch_one(
            """
            SELECT user_id
            FROM app.organization_memberships
            WHERE organization_id = %s AND user_id <> %s
            ORDER BY created_at, user_id
            LIMIT 1
            """,
            (organization_id, owner_id),
        )
        if existing_member is None:
            member_id = owner_id
            member_mode = "creator-team-owner"
        elif isinstance(existing_member[0], UUID):
            member_id = existing_member[0]
            member_mode = "existing-organization-member"
        else:
            raise M1VerificationError(
                "organization member lookup returned an invalid row"
            )

        stage = "project creation"
        project = await workspace.create_project(
            owner,
            ProjectDraft(
                client_id=None,
                name="M1 rollback collaboration acceptance",
                project_code=f"M1-{request_nonce.upper()}",
                description="Transaction-scoped development acceptance fixture.",
            ),
            request("project-created"),
        )
        stage = "first map creation"
        map_record = await workspace.create_map(
            owner,
            project.project_id,
            MapDraft(
                name="First acceptance map",
                description="Initial map for the rollback-only M1 journey.",
                definition=empty_map_definition(),
            ),
            request("map-created"),
        )
        if map_record.version != 1:
            raise M1VerificationError("the first map did not begin at version one")

        stage = "team creation"
        team = await teams.create_team(
            owner,
            f"M1 rollback collaboration team {request_nonce}",
            "Transaction-scoped team for deployed collaboration acceptance.",
            request("team-created"),
        )
        if member_id != owner_id:
            stage = "team member creation"
            await teams.add_member(
                owner,
                team.team_id,
                member_id,
                "member",
                request("team-member-created"),
            )
        stage = "team grant creation"
        grant = await teams.create_project_grant(
            owner,
            project.project_id,
            team.team_id,
            "editor",
            request("grant-created"),
        )
        if grant.role != "editor":
            raise M1VerificationError(
                "the project team grant did not persist as editor"
            )

        duplicate_conflict = False
        stage = "duplicate team grant conflict"
        try:
            await teams.create_project_grant(
                owner,
                project.project_id,
                team.team_id,
                "viewer",
                request("grant-duplicate"),
            )
        except TeamConflict as error:
            duplicate_conflict = error.code == "project_team_grant_exists"
        if not duplicate_conflict:
            raise M1VerificationError("duplicate project team grant did not conflict")

        stage = "direct project membership"
        if member_id == owner_id:
            direct_membership_change = await transaction.execute(
                """
                UPDATE app.project_memberships SET role = 'viewer'
                WHERE organization_id = %s AND project_id = %s AND user_id = %s
                """,
                (organization_id, project.project_id, member_id),
            )
        else:
            direct_membership_change = await transaction.execute(
                """
                INSERT INTO app.project_memberships
                  (organization_id, project_id, user_id, role)
                VALUES (%s, %s, %s, 'viewer')
                """,
                (organization_id, project.project_id, member_id),
            )
        if direct_membership_change != 1:
            raise M1VerificationError("direct viewer membership was not established")

        member = TenantContext(user_id=member_id, organization_id=organization_id)
        stage = "effective editor role"
        await set_context(transaction, member)
        effective_editor = await transaction.fetch_one(
            "SELECT app.effective_project_role(%s)::text",
            (project.project_id,),
        )
        if effective_editor != ("editor",):
            raise M1VerificationError("the strongest direct/team role was not editor")

        stage = "reviewer team grant"
        await teams.update_project_grant(
            owner,
            project.project_id,
            team.team_id,
            "reviewer",
            request("grant-reviewer"),
        )
        await set_context(transaction, member)
        effective_reviewer = await transaction.fetch_one(
            "SELECT app.effective_project_role(%s)::text",
            (project.project_id,),
        )
        if effective_reviewer != ("reviewer",):
            raise M1VerificationError("the strongest direct/team role was not reviewer")
        stage = "restored editor team grant"
        await teams.update_project_grant(
            owner,
            project.project_id,
            team.team_id,
            "editor",
            request("grant-editor"),
        )

        stage = "project and first map reload"
        member_project = await workspace.get_project(member, project.project_id)
        if member_project.caller_role != "editor":
            raise M1VerificationError(
                "team member did not reload the editor project role"
            )
        member_map = await workspace.get_map(
            member, project.project_id, map_record.map_id
        )
        if member_map.version != 1 or member_map.definition != empty_map_definition():
            raise M1VerificationError("the first map did not reload exactly")
        stage = "map update"
        updated = await workspace.update_map(
            member,
            project.project_id,
            map_record.map_id,
            1,
            {"definition": empty_map_definition(color_mode="light")},
            "M1 member presentation update",
            request("map-updated"),
        )
        if updated.version != 2:
            raise M1VerificationError("the member map update did not reach version two")

        stale_conflict = False
        stage = "stale map conflict"
        try:
            await workspace.update_map(
                member,
                project.project_id,
                map_record.map_id,
                1,
                {"description": "This stale write must not persist."},
                "Rejected stale M1 update",
                request("map-stale"),
            )
        except WorkspaceConflict as error:
            stale_conflict = (
                error.code == "map_version_conflict" and error.current_version == 2
            )
        if not stale_conflict:
            raise M1VerificationError(
                "the stale map update did not return version conflict"
            )

        stage = "fresh repository reload"
        fresh_workspace = PostgresWorkspaceRepository(
            SharedRollbackExecutor(transaction)
        )
        reloaded = await fresh_workspace.get_map(
            member, project.project_id, map_record.map_id
        )
        if reloaded.version != 2 or reloaded.definition.get("colorMode") != "light":
            raise M1VerificationError(
                "a fresh repository session did not reload version two"
            )

        stage = "map history inspection"
        state = await transaction.fetch_one(
            """
            SELECT
              (SELECT count(*) FROM app.map_versions
               WHERE organization_id = %s AND map_id = %s),
              (SELECT count(*) FROM app.activity_events
               WHERE organization_id = %s AND project_id = %s
                 AND event_type = 'map.updated')
            """,
            (organization_id, map_record.map_id, organization_id, project.project_id),
        )
        if state != (2, 1):
            raise M1VerificationError(
                "the stale conflict changed map history or activity"
            )

        stage = "team grant revocation"
        await teams.remove_project_grant(
            owner,
            project.project_id,
            team.team_id,
            request("grant-revoked"),
        )
        await set_context(transaction, member)
        effective_viewer = await transaction.fetch_one(
            "SELECT app.effective_project_role(%s)::text",
            (project.project_id,),
        )
        if effective_viewer != ("viewer",):
            raise M1VerificationError(
                "grant revocation did not restore the direct viewer role"
            )

        stage = "activity inspection"
        placeholders = ", ".join(["%s"] * len(request_ids))
        events = await transaction.fetch_all(
            f"""
            SELECT event_type, request_id
            FROM app.activity_events
            WHERE organization_id = %s AND request_id IN ({placeholders})
            ORDER BY occurred_at, id
            """,
            (organization_id, *request_ids),
        )
        event_types = [str(row[0]) for row in events]
        expected_events = [
            "project.created",
            "map.created",
            "team.created",
            "project.team_grant.created",
            "project.team_grant.updated",
            "project.team_grant.updated",
            "map.updated",
            "project.team_grant.revoked",
        ]
        if member_id != owner_id:
            expected_events.insert(3, "team.membership.created")
        if event_types != expected_events:
            raise M1VerificationError(
                "M1 activity records were incomplete or out of order"
            )

        stage = "tenant isolation"
        await set_context(
            transaction,
            TenantContext(
                user_id=member_id,
                organization_id=UUID("ffffffff-ffff-4fff-8fff-ffffffffffff"),
            ),
        )
        isolated = await transaction.fetch_one(
            "SELECT count(*) FROM app.projects WHERE id = %s",
            (project.project_id,),
        )
        if isolated != (0,):
            raise M1VerificationError("tenant isolation exposed the rollback project")

        stage = "result construction"
        result = {
            "status": "passed",
            "environment": "development",
            "databaseRole": "opengeo_runtime",
            "projectCreation": "passed",
            "firstMapCreation": "passed",
            "teamMembership": {"status": "passed", "mode": member_mode},
            "teamGrantLifecycle": ["created", "reviewer", "editor", "revoked"],
            "strongestEffectiveRoles": ["editor", "reviewer", "viewer"],
            "duplicateGrantConflict": "project_team_grant_exists",
            "staleMapConflict": {"code": "map_version_conflict", "currentVersion": 2},
            "freshRepositoryReload": "passed",
            "mapVersionCount": 2,
            "activityEvents": event_types,
            "tenantIsolation": "passed",
            "credentialMaterialRecorded": False,
            "identityMaterialRecorded": False,
            "infrastructureResourcesCreated": 0,
        }
    except RdsDataApiUnavailable as error:
        raise M1VerificationError(
            f"database operation failed during {stage} ({transaction.last_operation})"
        ) from error
    finally:
        await client.rollback(transaction_id)
        rolled_back = True

    if result is None:
        raise M1VerificationError("M1 acceptance did not produce a result")
    result["testTransactionRolledBack"] = rolled_back
    return result


def validate_scope(args: argparse.Namespace) -> None:
    if args.confirm != CONFIRMATION:
        raise M1VerificationError("the exact rollback-only confirmation is required")
    if args.expected_account != DEVELOPMENT_ACCOUNT:
        raise M1VerificationError(
            "M1 verification is restricted to the development account"
        )
    if (
        ACCOUNT.fullmatch(args.expected_account) is None
        or REGION.fullmatch(args.region) is None
    ):
        raise M1VerificationError("account or region is invalid")
    cluster = CLUSTER_ARN.fullmatch(args.cluster_arn)
    secret = SECRET_ARN.fullmatch(args.runtime_secret_arn)
    if cluster is None or secret is None:
        raise M1VerificationError("cluster or runtime secret ARN is invalid")
    for match in (cluster, secret):
        if (
            match.group("account") != args.expected_account
            or match.group("region") != args.region
        ):
            raise M1VerificationError(
                "AWS resource ARN is outside the development scope"
            )
    for value, label in (
        (args.organization_id, "organization"),
        (args.user_id, "user"),
    ):
        try:
            UUID(value)
        except (TypeError, ValueError) as error:
            raise M1VerificationError(f"{label} id is invalid") from error
    if (
        not args.profile
        or len(args.profile) > 64
        or not re.fullmatch(r"[A-Za-z0-9_-]+", args.profile)
    ):
        raise M1VerificationError("AWS profile is invalid")


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--expected-account", required=True)
    parser.add_argument("--cluster-arn", required=True)
    parser.add_argument("--runtime-secret-arn", required=True)
    parser.add_argument("--organization-id", required=True)
    parser.add_argument("--user-id", required=True)
    args = parser.parse_args(argv)
    validate_scope(args)
    return args


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = parse_args(sys.argv[1:] if argv is None else argv)
        print(json.dumps(asyncio.run(verify(args)), indent=2, sort_keys=True))
    except (M1VerificationError, RdsDataApiUnavailable) as error:
        print(json.dumps({"status": "failed", "error": str(error)}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
