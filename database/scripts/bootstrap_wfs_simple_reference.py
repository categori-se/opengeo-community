"""Bootstrap and verify the exact synthetic WFS Simple reference profile.

The default mode is offline and prints a validated plan. Database access is
allowed only through a mode-0600 file containing a loopback PostgreSQL DSN for
an explicitly named isolated database. ``verify-cycle`` creates the fixture,
proves an idempotent second bootstrap and exact readback, then rolls the whole
transaction back and proves that no profile rows remain.

The feature history tables are append-only, so a committed ``prepare`` is only
appropriate for a disposable database that will be destroyed as a whole after
the separately authorized official diagnostic.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import stat
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

import psycopg
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PROFILE = (
    ROOT / "parity" / "fixtures" / "ogc" / "wfs-2.0-simple-reference-profile.json"
)
DATABASE_RELEASE = 69
BASELINE_SQL = ROOT / "database" / "baselines" / "0069_opengeo_schema.sql"
BASELINE_MANIFEST = (
    ROOT / "database" / "baselines" / "0069_opengeo_schema.manifest.json"
)
EXPECTED_BASELINE_SHA256 = (
    "b61619c09fa0e9d5bb5b7d7e37098efa83faf680523119ae11c87d1d4108a984"
)
EXPECTED_BASELINE_MANIFEST_SHA256 = (
    "76c6296550e18dcbeb6e57b00153f351ef737dd47b826c535f73efddaaa8b26a"
)
EXPECTED_PROFILE_SHA256 = (
    "358f3adfad33f4544d33800a45047221c7977ae42b6f259f168b851c73f2a727"
)
DATABASE_NAME = re.compile(r"^opengeo_wfs_ets_[a-z0-9_]{1,40}$")
ALLOWED_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})
SOCKET_DIRECTORY = re.compile(r"^/tmp/opengeo-wfs-ets-[A-Za-z0-9_-]{1,64}$")
PROFILE_TABLES = (
    "users",
    "organizations",
    "organization_memberships",
    "projects",
    "project_memberships",
    "datasets",
    "project_datasets",
    "feature_collections",
    "dataset_features",
    "dataset_feature_revisions",
)


class BootstrapError(RuntimeError):
    """Raised when the isolated fixture boundary is not exact."""


@dataclass(frozen=True, slots=True)
class ReferencePlan:
    profile_sha256: str
    organization_id: UUID
    user_id: UUID
    project_id: UUID
    dataset_id: UUID
    feature_id: UUID
    created_at: datetime
    geometry_type: str
    fields: list[dict[str, Any]]
    geometry: dict[str, Any]
    properties: dict[str, Any]

    @property
    def schema_definition(self) -> dict[str, Any]:
        return {"schemaVersion": "1.0.0", "fields": self.fields}


def _exact_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    if set(value) != expected:
        raise BootstrapError(f"{label} keys differ from the exact reference profile")


def load_plan(path: Path, confirmation: str | None) -> ReferencePlan:
    try:
        profile_bytes = path.read_bytes()
        profile = json.loads(profile_bytes)
    except (OSError, json.JSONDecodeError) as error:
        raise BootstrapError("reference profile is unavailable or invalid") from error
    digest = hashlib.sha256(profile_bytes).hexdigest()
    if digest != EXPECTED_PROFILE_SHA256:
        raise BootstrapError("reference profile checksum is not the reviewed checksum")
    if confirmation is not None and confirmation != digest:
        raise BootstrapError("profile checksum confirmation does not match")
    if profile.get("profileId") != "opengeo.wfs.simple.reference.1":
        raise BootstrapError("reference profile identity is invalid")
    identity = profile.get("identity")
    bootstrap = profile.get("bootstrap")
    if not isinstance(identity, dict) or not isinstance(bootstrap, dict):
        raise BootstrapError("reference profile bootstrap is incomplete")
    _exact_keys(
        identity,
        {"organizationId", "userId", "projectId", "datasetId", "featureId"},
        "identity",
    )
    request = bootstrap.get("request")
    if not isinstance(request, dict):
        raise BootstrapError("reference profile request is invalid")
    _exact_keys(request, {"geometry_type", "fields", "features"}, "request")
    features = request.get("features")
    fields = request.get("fields")
    if (
        not isinstance(features, list)
        or len(features) != 1
        or not isinstance(fields, list)
    ):
        raise BootstrapError("reference profile must contain exactly one feature")
    feature = features[0]
    if not isinstance(feature, dict):
        raise BootstrapError("reference feature is invalid")
    _exact_keys(feature, {"type", "id", "geometry", "properties"}, "feature")
    try:
        created_at = datetime.fromisoformat(
            str(bootstrap["createdAt"]).replace("Z", "+00:00")
        )
        plan = ReferencePlan(
            profile_sha256=digest,
            organization_id=UUID(identity["organizationId"]),
            user_id=UUID(identity["userId"]),
            project_id=UUID(identity["projectId"]),
            dataset_id=UUID(identity["datasetId"]),
            feature_id=UUID(identity["featureId"]),
            created_at=created_at.astimezone(UTC),
            geometry_type=request["geometry_type"],
            fields=fields,
            geometry=feature["geometry"],
            properties=feature["properties"],
        )
    except (KeyError, TypeError, ValueError) as error:
        raise BootstrapError("reference profile values are invalid") from error
    if (
        feature.get("type") != "Feature"
        or feature.get("id") != str(plan.feature_id)
        or plan.geometry_type != "Point"
        or plan.geometry != {"type": "Point", "coordinates": [-77.03, 38.9]}
        or plan.properties != {"name": "Station", "count": 2}
        or plan.fields
        != [
            {"name": "name", "type": "string", "required": True},
            {"name": "count", "type": "integer", "required": False},
        ]
        or bootstrap.get("collectionGeneration") != 1
        or bootstrap.get("featureVersion") != 1
        or bootstrap.get("updatedAt") != bootstrap.get("createdAt")
    ):
        raise BootstrapError(
            "reference profile does not match the reviewed one-feature plan"
        )
    return plan


def load_dsn(path: Path) -> tuple[str, str]:
    resolved = path.resolve(strict=True)
    if not path.is_absolute() or path.is_symlink() or resolved != path:
        raise BootstrapError(
            "database URL file must be an exact absolute non-symlink path"
        )
    mode = stat.S_IMODE(resolved.stat().st_mode)
    if mode & 0o077:
        raise BootstrapError("database URL file must not be group or world accessible")
    if resolved.stat().st_size > 4096:
        raise BootstrapError("database URL file is too large")
    dsn = resolved.read_text(encoding="utf-8").strip()
    if not dsn or "\n" in dsn or "\r" in dsn:
        raise BootstrapError("database URL file must contain one non-empty DSN")
    try:
        values = conninfo_to_dict(dsn)
    except psycopg.Error as error:
        raise BootstrapError("database URL is invalid") from error
    host = values.get("host")
    database = values.get("dbname")
    allowed_host = host in ALLOWED_HOSTS or (
        isinstance(host, str) and SOCKET_DIRECTORY.fullmatch(host) is not None
    )
    if (
        not allowed_host
        or not isinstance(database, str)
        or not DATABASE_NAME.fullmatch(database)
    ):
        raise BootstrapError(
            "database must be an explicitly named loopback WFS ETS database"
        )
    return dsn, database


def _expected_ledger() -> list[tuple[str, str]]:
    try:
        baseline_bytes = BASELINE_SQL.read_bytes()
        manifest_bytes = BASELINE_MANIFEST.read_bytes()
        manifest = json.loads(manifest_bytes)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BootstrapError(
            "reviewed database baseline is unavailable or invalid"
        ) from error
    if (
        hashlib.sha256(baseline_bytes).hexdigest() != EXPECTED_BASELINE_SHA256
        or hashlib.sha256(manifest_bytes).hexdigest()
        != EXPECTED_BASELINE_MANIFEST_SHA256
    ):
        raise BootstrapError("reviewed database baseline checksum changed")
    expected_fields = {
        "schemaVersion",
        "release",
        "baseline",
        "baselineSha256",
        "migrationChainSha256",
        "postgresMajor",
        "postgisSeries",
        "generatorImage",
        "containsUserData",
        "migrations",
    }
    if not isinstance(manifest, dict) or set(manifest) != expected_fields:
        raise BootstrapError("reviewed database baseline manifest fields changed")
    migrations = manifest.get("migrations")
    if not isinstance(migrations, list) or len(migrations) != DATABASE_RELEASE:
        raise BootstrapError("reviewed database baseline migration count changed")
    ledger: list[tuple[str, str]] = []
    for item in migrations:
        if not isinstance(item, dict) or set(item) != {"name", "sha256"}:
            raise BootstrapError("reviewed database baseline ledger changed")
        name = item.get("name")
        digest = item.get("sha256")
        if not isinstance(name, str) or not isinstance(digest, str):
            raise BootstrapError("reviewed database baseline ledger changed")
        ledger.append((name, digest))
    if (
        manifest.get("schemaVersion") != "opengeo.database-baseline-manifest.1.0.0"
        or manifest.get("release") != DATABASE_RELEASE
        or manifest.get("baseline") != BASELINE_SQL.name
        or manifest.get("baselineSha256") != EXPECTED_BASELINE_SHA256
        or manifest.get("postgresMajor") != 16
        or manifest.get("postgisSeries") != "3.5"
        or manifest.get("containsUserData") is not False
    ):
        raise BootstrapError("reviewed database baseline contract changed")
    return ledger


def verify_database_boundary(cursor: psycopg.Cursor[Any]) -> dict[str, Any]:
    cursor.execute(
        "SELECT migration_name, sha256 FROM opengeo_deploy.schema_migrations "
        "ORDER BY migration_name"
    )
    ledger = [(str(row[0]), str(row[1])) for row in cursor.fetchall()]
    if ledger != _expected_ledger():
        raise BootstrapError(
            f"database migration ledger is not the exact release {DATABASE_RELEASE:04d} baseline"
        )
    cursor.execute("SHOW server_version_num")
    postgres_version = str(cursor.fetchone()[0])
    cursor.execute("SELECT extversion FROM pg_extension WHERE extname = 'postgis'")
    row = cursor.fetchone()
    postgis_version = str(row[0]) if row is not None else ""
    if not postgres_version.startswith("16") or not postgis_version.startswith("3.5"):
        raise BootstrapError("database runtime is outside PostgreSQL 16 / PostGIS 3.5")
    return {
        "schemaRelease": DATABASE_RELEASE,
        "migrationCount": len(ledger),
        "postgresMajor": 16,
        "postgisSeries": "3.5",
    }


def _state(cursor: psycopg.Cursor[Any], plan: ReferencePlan) -> dict[str, int]:
    queries = {
        "users": ("SELECT count(*) FROM app.users WHERE id = %s", (plan.user_id,)),
        "organizations": (
            "SELECT count(*) FROM app.organizations WHERE id = %s",
            (plan.organization_id,),
        ),
        "organization_memberships": (
            (
                "SELECT count(*) FROM app.organization_memberships "
                "WHERE organization_id = %s AND user_id = %s"
            ),
            (plan.organization_id, plan.user_id),
        ),
        "projects": (
            "SELECT count(*) FROM app.projects WHERE id = %s",
            (plan.project_id,),
        ),
        "project_memberships": (
            (
                "SELECT count(*) FROM app.project_memberships "
                "WHERE organization_id = %s AND project_id = %s AND user_id = %s"
            ),
            (plan.organization_id, plan.project_id, plan.user_id),
        ),
        "datasets": (
            "SELECT count(*) FROM app.datasets WHERE id = %s",
            (plan.dataset_id,),
        ),
        "project_datasets": (
            (
                "SELECT count(*) FROM app.project_datasets "
                "WHERE organization_id = %s AND project_id = %s AND dataset_id = %s"
            ),
            (plan.organization_id, plan.project_id, plan.dataset_id),
        ),
        "feature_collections": (
            (
                "SELECT count(*) FROM app.feature_collections "
                "WHERE organization_id = %s AND dataset_id = %s"
            ),
            (plan.organization_id, plan.dataset_id),
        ),
        "dataset_features": (
            (
                "SELECT count(*) FROM app.dataset_features "
                "WHERE organization_id = %s AND dataset_id = %s AND id = %s"
            ),
            (plan.organization_id, plan.dataset_id, plan.feature_id),
        ),
        "dataset_feature_revisions": (
            (
                "SELECT count(*) FROM app.dataset_feature_revisions "
                "WHERE organization_id = %s AND dataset_id = %s AND feature_id = %s"
            ),
            (plan.organization_id, plan.dataset_id, plan.feature_id),
        ),
    }
    result: dict[str, int] = {}
    for name, (sql, parameters) in queries.items():
        cursor.execute(sql, parameters)
        result[name] = int(cursor.fetchone()[0])
    return result


def _require_dedicated(cursor: psycopg.Cursor[Any], state: dict[str, int]) -> None:
    exact = all(value == 1 for value in state.values())
    absent = all(value == 0 for value in state.values())
    if not exact and not absent:
        raise BootstrapError("reference profile rows are partial or drifted")
    expected_rows = 1 if exact else 0
    for table in PROFILE_TABLES:
        cursor.execute(f"SELECT count(*) FROM app.{table}")
        if int(cursor.fetchone()[0]) != expected_rows:
            raise BootstrapError(
                "database is not dedicated to the WFS reference profile"
            )


def _insert(cursor: psycopg.Cursor[Any], plan: ReferencePlan) -> None:
    instant = plan.created_at
    cursor.execute(
        "INSERT INTO app.users (id, cognito_subject, email, display_name, created_at, updated_at) "
        "VALUES (%s, %s, %s, %s, %s, %s)",
        (
            plan.user_id,
            "opengeo-wfs-simple-reference-1",
            "wfs-simple-reference@example.test",
            "WFS Simple Reference Operator",
            instant,
            instant,
        ),
    )
    cursor.execute(
        "INSERT INTO app.organizations (id, name, slug, created_by, created_at, updated_at) "
        "VALUES (%s, %s, %s, %s, %s, %s)",
        (
            plan.organization_id,
            "OpenGeo WFS Simple Reference",
            "opengeo-wfs-simple-reference-1",
            plan.user_id,
            instant,
            instant,
        ),
    )
    cursor.execute(
        "INSERT INTO app.organization_memberships "
        "(organization_id, user_id, role, invited_by, created_at, updated_at) "
        "VALUES (%s, %s, 'admin', %s, %s, %s)",
        (plan.organization_id, plan.user_id, plan.user_id, instant, instant),
    )
    cursor.execute(
        "INSERT INTO app.projects "
        "(id, organization_id, name, project_code, description, created_by, created_at, updated_at) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
        (
            plan.project_id,
            plan.organization_id,
            "WFS Simple Reference",
            "WFS-SIMPLE-REFERENCE-1",
            "Synthetic disposable profile for an isolated official WFS diagnostic.",
            plan.user_id,
            instant,
            instant,
        ),
    )
    cursor.execute(
        "INSERT INTO app.project_memberships "
        "(organization_id, project_id, user_id, role, created_at, updated_at) "
        "VALUES (%s, %s, %s, 'owner', %s, %s)",
        (plan.organization_id, plan.project_id, plan.user_id, instant, instant),
    )
    cursor.execute(
        "INSERT INTO app.datasets "
        "(id, organization_id, name, description, classification, source_type, format, status, "
        "owner_user_id, created_by, updated_by, created_at, updated_at) "
        "VALUES (%s, %s, %s, %s, 'internal', 'upload', 'geojson', 'active', "
        "%s, %s, %s, %s, %s)",
        (
            plan.dataset_id,
            plan.organization_id,
            "WFS Simple Reference Point",
            "One synthetic non-personal feature for an isolated WFS diagnostic.",
            plan.user_id,
            plan.user_id,
            plan.user_id,
            instant,
            instant,
        ),
    )
    cursor.execute(
        "INSERT INTO app.project_datasets "
        "(organization_id, project_id, dataset_id, linked_by, linked_at) "
        "VALUES (%s, %s, %s, %s, %s)",
        (plan.organization_id, plan.project_id, plan.dataset_id, plan.user_id, instant),
    )
    cursor.execute(
        "INSERT INTO app.feature_collections "
        "(organization_id, dataset_id, geometry_type, schema_definition, generation, "
        "feature_count, created_by, created_at, updated_by, updated_at) "
        "VALUES (%s, %s, %s, %s, 1, 1, %s, %s, %s, %s)",
        (
            plan.organization_id,
            plan.dataset_id,
            plan.geometry_type,
            Jsonb(plan.schema_definition),
            plan.user_id,
            instant,
            plan.user_id,
            instant,
        ),
    )
    cursor.execute(
        "INSERT INTO app.dataset_features "
        "(id, organization_id, dataset_id, version_number, geometry_type, properties, "
        "geometry_geojson, geometry, created_by, created_at, updated_by, updated_at) "
        "VALUES (%s, %s, %s, 1, %s, %s, %s, "
        "ST_SetSRID(ST_GeomFromGeoJSON(%s::text), 4326), %s, %s, %s, %s)",
        (
            plan.feature_id,
            plan.organization_id,
            plan.dataset_id,
            plan.geometry_type,
            Jsonb(plan.properties),
            Jsonb(plan.geometry),
            Jsonb(plan.geometry),
            plan.user_id,
            instant,
            plan.user_id,
            instant,
        ),
    )
    cursor.execute(
        "INSERT INTO app.dataset_feature_revisions "
        "(organization_id, dataset_id, feature_id, version_number, operation, geometry_type, "
        "properties, geometry_geojson, geometry, changed_by, change_message, request_id, created_at) "
        "VALUES (%s, %s, %s, 1, 'create', %s, %s, %s, "
        "ST_SetSRID(ST_GeomFromGeoJSON(%s::text), 4326), %s, %s, %s, %s)",
        (
            plan.organization_id,
            plan.dataset_id,
            plan.feature_id,
            plan.geometry_type,
            Jsonb(plan.properties),
            Jsonb(plan.geometry),
            Jsonb(plan.geometry),
            plan.user_id,
            "WFS Simple reference bootstrap",
            "service-019-wfs-simple-reference-bootstrap",
            instant,
        ),
    )
    cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")


def readback(cursor: psycopg.Cursor[Any], plan: ReferencePlan) -> dict[str, Any]:
    state = _state(cursor, plan)
    _require_dedicated(cursor, state)
    if state != {name: 1 for name in PROFILE_TABLES}:
        raise BootstrapError("reference profile readback is incomplete")
    cursor.execute(
        """
        SELECT user_record.cognito_subject, user_record.email,
               organization.slug, membership.role::text,
               project.project_code, project.visibility::text, project_member.role::text,
               dataset.classification::text, dataset.source_type::text,
               dataset.format::text, dataset.status::text,
               collection.geometry_type::text, collection.schema_definition,
               collection.generation, collection.feature_count,
               feature.version_number, feature.geometry_type::text, feature.properties,
               feature.geometry_geojson, ST_AsGeoJSON(feature.geometry)::jsonb,
               feature.bbox, feature.created_at, feature.updated_at,
               revision.version_number, revision.operation::text, revision.request_id
        FROM app.users user_record
        JOIN app.organizations organization ON organization.id = %s
        JOIN app.organization_memberships membership
          ON membership.organization_id = organization.id AND membership.user_id = user_record.id
        JOIN app.projects project ON project.id = %s AND project.organization_id = organization.id
        JOIN app.project_memberships project_member
          ON project_member.organization_id = organization.id
         AND project_member.project_id = project.id AND project_member.user_id = user_record.id
        JOIN app.datasets dataset ON dataset.id = %s AND dataset.organization_id = organization.id
        JOIN app.project_datasets project_dataset
          ON project_dataset.organization_id = organization.id
         AND project_dataset.project_id = project.id AND project_dataset.dataset_id = dataset.id
        JOIN app.feature_collections collection
          ON collection.organization_id = organization.id AND collection.dataset_id = dataset.id
        JOIN app.dataset_features feature
          ON feature.organization_id = organization.id AND feature.dataset_id = dataset.id
         AND feature.id = %s AND feature.deleted_at IS NULL
        JOIN app.dataset_feature_revisions revision
          ON revision.organization_id = organization.id AND revision.dataset_id = dataset.id
         AND revision.feature_id = feature.id
        WHERE user_record.id = %s
        """,
        (
            plan.organization_id,
            plan.project_id,
            plan.dataset_id,
            plan.feature_id,
            plan.user_id,
        ),
    )
    row = cursor.fetchone()
    if row is None:
        raise BootstrapError("reference profile joined readback is missing")
    expected = (
        "opengeo-wfs-simple-reference-1",
        "wfs-simple-reference@example.test",
        "opengeo-wfs-simple-reference-1",
        "admin",
        "WFS-SIMPLE-REFERENCE-1",
        "internal",
        "owner",
        "internal",
        "upload",
        "geojson",
        "active",
        "Point",
        plan.schema_definition,
        1,
        1,
        1,
        "Point",
        plan.properties,
        plan.geometry,
        plan.geometry,
        [-77.03, 38.9, -77.03, 38.9],
        plan.created_at,
        plan.created_at,
        1,
        "create",
        "service-019-wfs-simple-reference-bootstrap",
    )
    comparable = tuple(row)
    comparable = (*comparable[:20], list(comparable[20]), *comparable[21:])
    if comparable != expected:
        raise BootstrapError("reference profile database values drifted")
    return {
        "organizationId": str(plan.organization_id),
        "projectId": str(plan.project_id),
        "datasetId": str(plan.dataset_id),
        "featureId": str(plan.feature_id),
        "collectionGeneration": 1,
        "featureVersion": 1,
        "featureCount": 1,
        "geometryType": "Point",
        "bbox": [-77.03, 38.9, -77.03, 38.9],
        "properties": plan.properties,
    }


def bootstrap_or_verify(
    cursor: psycopg.Cursor[Any], plan: ReferencePlan
) -> Literal["created", "already_exact"]:
    state = _state(cursor, plan)
    _require_dedicated(cursor, state)
    if all(value == 1 for value in state.values()):
        readback(cursor, plan)
        return "already_exact"
    _insert(cursor, plan)
    readback(cursor, plan)
    return "created"


def execute(mode: str, dsn: str, database: str, plan: ReferencePlan) -> dict[str, Any]:
    with (
        psycopg.connect(dsn, connect_timeout=5) as connection,
        connection.cursor() as cursor,
    ):
        boundary = verify_database_boundary(cursor)
        if mode == "readback":
            result = readback(cursor, plan)
            connection.rollback()
            return {
                "result": "exact_reference_profile_read_back",
                **boundary,
                **result,
            }
        if mode == "prepare":
            action = bootstrap_or_verify(cursor, plan)
            connection.commit()
            return {
                "result": "reference_profile_prepared_in_disposable_database",
                "action": action,
                "cleanupRequirement": "destroy_entire_isolated_database",
                **boundary,
                **readback_after_commit(dsn, plan),
            }
        if mode != "verify-cycle":
            raise BootstrapError("unsupported execution mode")
        if any(_state(cursor, plan).values()):
            raise BootstrapError(
                "verify-cycle requires an initially absent reference profile"
            )
        first_action = bootstrap_or_verify(cursor, plan)
        first_readback = readback(cursor, plan)
        second_action = bootstrap_or_verify(cursor, plan)
        second_readback = readback(cursor, plan)
        if first_readback != second_readback:
            raise BootstrapError("idempotent readback changed")
        connection.rollback()
    with (
        psycopg.connect(dsn, connect_timeout=5) as verification,
        verification.cursor() as cursor,
    ):
        boundary_after = verify_database_boundary(cursor)
        cleanup_state = _state(cursor, plan)
        verification.rollback()
    if any(cleanup_state.values()) or boundary_after != boundary:
        raise BootstrapError(
            "transaction rollback did not restore the database boundary"
        )
    return {
        "result": "reference_profile_cycle_passed_and_rolled_back",
        "database": database,
        "profileSha256": plan.profile_sha256,
        "firstAction": first_action,
        "secondAction": second_action,
        "readback": first_readback,
        "cleanupMethod": "transaction_rollback",
        "remainingProfileRows": sum(cleanup_state.values()),
        **boundary,
    }


def readback_after_commit(dsn: str, plan: ReferencePlan) -> dict[str, Any]:
    with (
        psycopg.connect(dsn, connect_timeout=5) as connection,
        connection.cursor() as cursor,
    ):
        value = readback(cursor, plan)
        connection.rollback()
        return value


def parse_args(values: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--mode",
        choices=("plan", "verify-cycle", "prepare", "readback"),
        default="plan",
    )
    parser.add_argument("--profile", type=Path, default=DEFAULT_PROFILE)
    parser.add_argument("--confirm-profile-sha256")
    parser.add_argument("--database-url-file", type=Path)
    return parser.parse_args(values)


def main() -> None:
    arguments = parse_args()
    confirmation = (
        arguments.confirm_profile_sha256 if arguments.mode != "plan" else None
    )
    plan = load_plan(arguments.profile.resolve(), confirmation)
    if arguments.mode == "plan":
        print(
            json.dumps(
                {
                    "result": "validated_offline_plan",
                    "profileSha256": plan.profile_sha256,
                    "schemaRelease": DATABASE_RELEASE,
                    "databaseAccess": False,
                    "allowedDatabasePattern": DATABASE_NAME.pattern,
                    "allowedHosts": [*sorted(ALLOWED_HOSTS), SOCKET_DIRECTORY.pattern],
                    "modes": ["verify-cycle", "prepare", "readback"],
                    "committedCleanup": "destroy_entire_isolated_database",
                },
                indent=2,
                sort_keys=True,
            )
        )
        return
    if arguments.database_url_file is None or arguments.confirm_profile_sha256 is None:
        raise BootstrapError(
            "database modes require --database-url-file and --confirm-profile-sha256"
        )
    dsn, database = load_dsn(arguments.database_url_file)
    print(
        json.dumps(
            execute(arguments.mode, dsn, database, plan), indent=2, sort_keys=True
        )
    )


if __name__ == "__main__":
    main()
