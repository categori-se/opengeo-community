#!/usr/bin/env python3
"""Provision the bounded development data used by managed-login acceptance.

The fixture is intentionally durable and idempotent: one governed LineString
dataset is linked to two projects whose saved maps keep independent styles.
The script accepts only the dedicated OpenGeo development account and writes
through the runtime database identity with tenant row-level security enabled.
It never prints user, project, map, dataset, feature, or credential values.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID, uuid5

DEVELOPMENT_ACCOUNT = "222222222222"
CONFIRMATION = "provision-development-managed-login-browser-fixture"
FIXTURE_SCHEMA = "opengeo.managed-login-fixture.1.0.0"
MAP_SCHEMA = "opengeo.map-definition.1.3.0"
CLUSTER_ARN = re.compile(
    r"^arn:aws:rds:(?P<region>[^:]+):(?P<account>[0-9]{12}):"
    r"cluster:[A-Za-z0-9][A-Za-z0-9-]{0,62}$"
)
SECRET_ARN = re.compile(
    r"^arn:aws:secretsmanager:(?P<region>[^:]+):(?P<account>[0-9]{12}):"
    r"secret:[A-Za-z0-9/_+=.@-]+$"
)
HEX_COLOR = re.compile(r"^#[0-9a-f]{6}$")
PROJECT_CODE = re.compile(r"^[A-Z0-9]+(?:-[A-Z0-9]+)*$")
DEFAULT_FIXTURE = (
    Path(__file__).resolve().parents[1] / "fixtures" / "auth-browser-dev.json"
)


class FixtureError(RuntimeError):
    """Raised when the development fixture is unsafe or inconsistent."""


@dataclass(frozen=True, slots=True)
class ProjectFixture:
    name: str
    code: str
    map_name: str
    strokes: tuple[str, str]


@dataclass(frozen=True, slots=True)
class FeatureFixture:
    name: str
    segment: int
    coordinates: tuple[tuple[float, float], ...]


@dataclass(frozen=True, slots=True)
class ManagedLoginFixture:
    projects: tuple[ProjectFixture, ProjectFixture]
    dataset_name: str
    dataset_description: str
    fields: tuple[dict[str, Any], ...]
    features: tuple[FeatureFixture, ...]
    narrow_viewport_width: int
    narrow_viewport_height: int
    minimum_status_contrast_ratio: int


@dataclass(frozen=True, slots=True)
class FixtureIds:
    projects: tuple[UUID, UUID]
    maps: tuple[UUID, UUID]
    dataset: UUID
    features: tuple[UUID, ...]
    revisions: tuple[UUID, ...]
    map_versions: tuple[UUID, UUID]


def load_fixture(path: Path) -> ManagedLoginFixture:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise FixtureError("managed-login fixture could not be loaded") from error
    if not isinstance(raw, dict) or set(raw) != {
        "schemaVersion",
        "environment",
        "projects",
        "dataset",
        "acceptance",
    }:
        raise FixtureError("managed-login fixture fields are invalid")
    if raw["schemaVersion"] != FIXTURE_SCHEMA or raw["environment"] != "development":
        raise FixtureError(
            "managed-login fixture is outside its reviewed development scope"
        )

    raw_projects = raw["projects"]
    if not isinstance(raw_projects, list) or len(raw_projects) != 2:
        raise FixtureError("managed-login fixture requires exactly two projects")
    projects: list[ProjectFixture] = []
    identities: set[str] = set()
    all_strokes: set[str] = set()
    for index, value in enumerate(raw_projects, start=1):
        if not isinstance(value, dict) or set(value) != {
            "name",
            "code",
            "mapName",
            "strokes",
        }:
            raise FixtureError(f"managed-login project {index} fields are invalid")
        name = bounded_text(value["name"], f"managed-login project {index} name", 120)
        map_name = bounded_text(
            value["mapName"], f"managed-login map {index} name", 120
        )
        code = value["code"]
        strokes = value["strokes"]
        if not isinstance(code, str) or PROJECT_CODE.fullmatch(code) is None:
            raise FixtureError(f"managed-login project {index} code is invalid")
        if (
            not isinstance(strokes, list)
            or len(strokes) != 2
            or any(
                not isinstance(color, str) or HEX_COLOR.fullmatch(color) is None
                for color in strokes
            )
            or strokes[0] == strokes[1]
        ):
            raise FixtureError(f"managed-login project {index} strokes are invalid")
        identities.update((name, map_name, code))
        all_strokes.update(strokes)
        projects.append(ProjectFixture(name, code, map_name, (strokes[0], strokes[1])))
    if len(identities) != 6 or len(all_strokes) != 4:
        raise FixtureError(
            "managed-login project identities and styles must be independent"
        )

    dataset = raw["dataset"]
    if not isinstance(dataset, dict) or set(dataset) != {
        "name",
        "description",
        "geometryType",
        "fields",
        "features",
    }:
        raise FixtureError("managed-login dataset fields are invalid")
    if dataset["geometryType"] != "LineString":
        raise FixtureError("managed-login dataset geometry is invalid")
    dataset_name = bounded_text(dataset["name"], "managed-login dataset name", 120)
    dataset_description = bounded_text(
        dataset["description"], "managed-login dataset description", 500
    )
    fields = dataset["fields"]
    if not isinstance(fields, list) or fields != [
        {"name": "name", "type": "string", "required": True},
        {"name": "segment", "type": "integer", "required": True},
    ]:
        raise FixtureError("managed-login dataset schema is invalid")

    raw_features = dataset["features"]
    if not isinstance(raw_features, list) or len(raw_features) != 6:
        raise FixtureError("managed-login dataset requires exactly six features")
    features: list[FeatureFixture] = []
    for index, value in enumerate(raw_features, start=1):
        if not isinstance(value, dict) or set(value) != {
            "name",
            "segment",
            "coordinates",
        }:
            raise FixtureError(f"managed-login feature {index} fields are invalid")
        if value["segment"] != index:
            raise FixtureError(f"managed-login feature {index} segment is invalid")
        name = bounded_text(value["name"], f"managed-login feature {index} name", 120)
        raw_coordinates = value["coordinates"]
        if (
            not isinstance(raw_coordinates, list)
            or not 2 <= len(raw_coordinates) <= 100
        ):
            raise FixtureError(f"managed-login feature {index} coordinates are invalid")
        coordinates: list[tuple[float, float]] = []
        for coordinate in raw_coordinates:
            if (
                not isinstance(coordinate, list)
                or len(coordinate) != 2
                or isinstance(coordinate[0], bool)
                or isinstance(coordinate[1], bool)
                or not isinstance(coordinate[0], int | float)
                or not isinstance(coordinate[1], int | float)
                or not -180 <= coordinate[0] <= 180
                or not -90 <= coordinate[1] <= 90
            ):
                raise FixtureError(
                    f"managed-login feature {index} coordinate is invalid"
                )
            coordinates.append((float(coordinate[0]), float(coordinate[1])))
        features.append(FeatureFixture(name, index, tuple(coordinates)))

    acceptance = raw["acceptance"]
    expected_acceptance = {
        "sharedDatasetProjectCount": 2,
        "governedFeatureCount": 6,
        "narrowViewportWidth": 390,
        "narrowViewportHeight": 844,
        "minimumStatusContrastRatio": 7,
    }
    if acceptance != expected_acceptance:
        raise FixtureError("managed-login acceptance limits are invalid")
    serialized = json.dumps(raw, sort_keys=True, separators=(",", ":"))
    if re.search(
        r"(?:access.?key|authorization|credential|password|secret|session.?token)",
        serialized,
        re.IGNORECASE,
    ):
        raise FixtureError(
            "managed-login fixture contains credential-oriented material"
        )
    return ManagedLoginFixture(
        projects=(projects[0], projects[1]),
        dataset_name=dataset_name,
        dataset_description=dataset_description,
        fields=tuple(dict(field) for field in fields),
        features=tuple(features),
        narrow_viewport_width=390,
        narrow_viewport_height=844,
        minimum_status_contrast_ratio=7,
    )


def bounded_text(value: Any, label: str, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > maximum
        or re.search(r"[\x00-\x1f\x7f]", value)
    ):
        raise FixtureError(f"{label} is invalid")
    return value


def fixture_ids(organization_id: UUID, fixture: ManagedLoginFixture) -> FixtureIds:
    projects = tuple(
        uuid5(organization_id, f"managed-login-project:{item.code}")
        for item in fixture.projects
    )
    maps = tuple(
        uuid5(project_id, f"managed-login-map:{item.map_name}")
        for project_id, item in zip(projects, fixture.projects, strict=True)
    )
    dataset = uuid5(organization_id, f"managed-login-dataset:{fixture.dataset_name}")
    features = tuple(
        uuid5(dataset, f"managed-login-feature:{item.segment}")
        for item in fixture.features
    )
    revisions = tuple(
        uuid5(feature_id, "managed-login-revision:1") for feature_id in features
    )
    map_versions = tuple(
        uuid5(map_id, "managed-login-map-version:1") for map_id in maps
    )
    return FixtureIds(
        projects=(projects[0], projects[1]),
        maps=(maps[0], maps[1]),
        dataset=dataset,
        features=features,
        revisions=revisions,
        map_versions=(map_versions[0], map_versions[1]),
    )


def initial_map_definition(
    project: ProjectFixture, dataset_name: str, dataset_id: UUID
) -> dict[str, Any]:
    layer_id = f"dataset_{dataset_id}"
    return {
        "schemaVersion": MAP_SCHEMA,
        "mapViews": [],
        "basemaps": [],
        "bookmarks": [],
        "activeLayerId": layer_id,
        "activeProcessingModelId": None,
        "models": [],
        "processingHistory": [],
        "measurements": [],
        "projection": "mercator",
        "colorMode": "dark",
        "layers": [
            {
                "layerId": layer_id,
                "datasetId": str(dataset_id),
                "title": dataset_name,
                "sourceType": "governed-dataset",
                "geometryType": "LineString",
                "visible": True,
                "opacity": 0.9,
                "order": 1,
                "style": {"stroke": project.strokes[0], "strokeWidth": 3},
                "labels": {"enabled": False, "field": None},
            }
        ],
    }


def validate_scope(args: argparse.Namespace) -> tuple[re.Match[str], re.Match[str]]:
    if args.confirm != CONFIRMATION:
        raise FixtureError(f"fixture provisioning requires --confirm {CONFIRMATION}")
    if args.expected_account != DEVELOPMENT_ACCOUNT:
        raise FixtureError(
            "managed-login fixture accepts only the dedicated development account"
        )
    cluster = CLUSTER_ARN.fullmatch(args.cluster_arn)
    runtime_secret = SECRET_ARN.fullmatch(args.runtime_secret_arn)
    if cluster is None or runtime_secret is None:
        raise FixtureError("managed-login fixture resource ARN is invalid")
    for match in (cluster, runtime_secret):
        if (
            match.group("account") != DEVELOPMENT_ACCOUNT
            or match.group("region") != args.region
        ):
            raise FixtureError(
                "managed-login fixture resource is outside the development account or region"
            )
    try:
        UUID(args.organization_id)
        UUID(args.user_id)
    except ValueError as error:
        raise FixtureError(
            "managed-login fixture tenant identity is invalid"
        ) from error
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", args.profile):
        raise FixtureError("managed-login fixture AWS profile is invalid")
    return cluster, runtime_secret


async def provision(
    args: argparse.Namespace, fixture: ManagedLoginFixture
) -> dict[str, Any]:
    # These application imports stay inside the mutating path so fixture
    # validation remains available without a provisioned API environment.
    api_source = Path(__file__).resolve().parents[2] / "services" / "api" / "src"
    sys.path.insert(0, str(api_source))
    from opengeo_api.config import Settings
    from opengeo_api.rds_data import RdsDataApiClient, RdsDataApiUnavailable
    from opengeo_api.tenant_database import TenantContext
    from psycopg.types.json import Jsonb
    from pydantic import ValidationError
    from verify_reusable_project_datasets import (
        FrozenCredentialProvider,
        RollbackTransaction,
        VerificationError,
        load_aws_credentials,
        set_context,
    )

    try:
        credentials = load_aws_credentials(
            args.profile, args.region, args.expected_account
        )
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
            settings, credentials=FrozenCredentialProvider(credentials)
        )
        transaction_id = await client.begin()
    except (
        RdsDataApiUnavailable,
        ValidationError,
        VerificationError,
        ValueError,
    ) as error:
        raise FixtureError(
            "managed-login fixture transaction could not be started"
        ) from error
    transaction = RollbackTransaction(client, transaction_id)
    organization_id = UUID(args.organization_id)
    user_id = UUID(args.user_id)
    ids = fixture_ids(organization_id, fixture)
    committed = False
    try:
        await set_context(
            transaction, TenantContext(user_id=user_id, organization_id=organization_id)
        )
        lock = await transaction.fetch_one(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
            (f"opengeo-managed-login-fixture:{organization_id}",),
        )
        if lock is None:
            raise FixtureError("managed-login fixture lock was not established")
        membership = await transaction.fetch_one(
            """
            SELECT role::text FROM app.organization_memberships
            WHERE organization_id = %s AND user_id = %s
            """,
            (organization_id, user_id),
        )
        if membership is None or membership[0] != "admin":
            raise FixtureError(
                "managed-login fixture user is not an organization administrator"
            )

        for project, project_id in zip(fixture.projects, ids.projects, strict=True):
            await transaction.execute(
                """
                INSERT INTO app.projects
                  (id, organization_id, name, project_code, description, status, created_by)
                VALUES (%s, %s, %s, %s,
                        'Development-only managed-login browser acceptance project.',
                        'active', %s)
                ON CONFLICT DO NOTHING
                """,
                (project_id, organization_id, project.name, project.code, user_id),
            )
            row = await transaction.fetch_one(
                """
                SELECT name, project_code, status::text, created_by
                FROM app.projects WHERE organization_id = %s AND id = %s
                """,
                (organization_id, project_id),
            )
            if row != (project.name, project.code, "active", user_id):
                raise FixtureError(
                    "managed-login project identity conflicts with existing data"
                )
            await transaction.execute(
                """
                INSERT INTO app.project_memberships
                  (organization_id, project_id, user_id, role)
                VALUES (%s, %s, %s, 'owner')
                ON CONFLICT DO NOTHING
                """,
                (organization_id, project_id, user_id),
            )
            project_membership = await transaction.fetch_one(
                """
                SELECT role::text FROM app.project_memberships
                WHERE organization_id = %s AND project_id = %s AND user_id = %s
                """,
                (organization_id, project_id, user_id),
            )
            if project_membership != ("owner",):
                raise FixtureError(
                    "managed-login project ownership conflicts with existing data"
                )

        await transaction.execute(
            """
            INSERT INTO app.datasets
              (id, organization_id, name, description, classification, source_type,
               format, status, owner_user_id, created_by, updated_by)
            VALUES (%s, %s, %s, %s, 'internal', 'upload', 'geojson', 'active',
                    %s, %s, %s)
            ON CONFLICT DO NOTHING
            """,
            (
                ids.dataset,
                organization_id,
                fixture.dataset_name,
                fixture.dataset_description,
                user_id,
                user_id,
                user_id,
            ),
        )
        dataset = await transaction.fetch_one(
            """
            SELECT name, description, classification::text, source_type::text,
                   format::text, status::text, owner_user_id
            FROM app.datasets WHERE organization_id = %s AND id = %s
            """,
            (organization_id, ids.dataset),
        )
        if dataset != (
            fixture.dataset_name,
            fixture.dataset_description,
            "internal",
            "upload",
            "geojson",
            "active",
            user_id,
        ):
            raise FixtureError(
                "managed-login dataset identity conflicts with existing data"
            )

        for project_id in ids.projects:
            await transaction.execute(
                """
                INSERT INTO app.project_datasets
                  (organization_id, project_id, dataset_id, linked_by)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT DO NOTHING
                """,
                (organization_id, project_id, ids.dataset, user_id),
            )

        schema_definition = {"schemaVersion": "1.0.0", "fields": list(fixture.fields)}
        await transaction.execute(
            """
            INSERT INTO app.feature_collections
              (organization_id, dataset_id, geometry_type, schema_definition,
               generation, feature_count, created_by, updated_by)
            VALUES (%s, %s, 'LineString', %s, 1, %s, %s, %s)
            ON CONFLICT DO NOTHING
            """,
            (
                organization_id,
                ids.dataset,
                Jsonb(schema_definition),
                len(fixture.features),
                user_id,
                user_id,
            ),
        )
        collection = await transaction.fetch_one(
            """
            SELECT geometry_type::text, schema_definition, generation, feature_count
            FROM app.feature_collections
            WHERE organization_id = %s AND dataset_id = %s
            """,
            (organization_id, ids.dataset),
        )
        if collection != ("LineString", schema_definition, 1, len(fixture.features)):
            raise FixtureError(
                "managed-login feature collection conflicts with existing data"
            )

        for feature, feature_id, revision_id in zip(
            fixture.features, ids.features, ids.revisions, strict=True
        ):
            properties = {"name": feature.name, "segment": feature.segment}
            geometry = {"type": "LineString", "coordinates": feature.coordinates}
            await transaction.execute(
                """
                INSERT INTO app.dataset_features
                  (id, organization_id, dataset_id, version_number, geometry_type,
                   properties, geometry_geojson, geometry, created_by, updated_by)
                VALUES (%s, %s, %s, 1, 'LineString', %s, %s,
                        ST_SetSRID(ST_GeomFromGeoJSON(%s::text), 4326), %s, %s)
                ON CONFLICT DO NOTHING
                """,
                (
                    feature_id,
                    organization_id,
                    ids.dataset,
                    Jsonb(properties),
                    Jsonb(geometry),
                    Jsonb(geometry),
                    user_id,
                    user_id,
                ),
            )
            await transaction.execute(
                """
                INSERT INTO app.dataset_feature_revisions
                  (id, organization_id, dataset_id, feature_id, version_number,
                   operation, geometry_type, properties, geometry_geojson, geometry,
                   changed_by, change_message, request_id)
                VALUES (%s, %s, %s, %s, 1, 'create', 'LineString', %s, %s,
                        ST_SetSRID(ST_GeomFromGeoJSON(%s::text), 4326), %s,
                        'Created for managed-login browser acceptance.', %s)
                ON CONFLICT DO NOTHING
                """,
                (
                    revision_id,
                    organization_id,
                    ids.dataset,
                    feature_id,
                    Jsonb(properties),
                    Jsonb(geometry),
                    Jsonb(geometry),
                    user_id,
                    f"managed-login-fixture-feature-{feature.segment}",
                ),
            )

        for project, project_id, map_id, map_version_id in zip(
            fixture.projects, ids.projects, ids.maps, ids.map_versions, strict=True
        ):
            definition = initial_map_definition(
                project, fixture.dataset_name, ids.dataset
            )
            await transaction.execute(
                """
                INSERT INTO app.maps
                  (id, organization_id, project_id, name, description, status,
                   definition, version, created_by, updated_by)
                VALUES (%s, %s, %s, %s,
                        'Development-only managed-login browser acceptance map.',
                        'active', %s, 1, %s, %s)
                ON CONFLICT DO NOTHING
                """,
                (
                    map_id,
                    organization_id,
                    project_id,
                    project.map_name,
                    Jsonb(definition),
                    user_id,
                    user_id,
                ),
            )
            await transaction.execute(
                """
                INSERT INTO app.map_versions
                  (id, organization_id, map_id, version, definition,
                   change_message, created_by)
                VALUES (%s, %s, %s, 1, %s,
                        'Created for managed-login browser acceptance.', %s)
                ON CONFLICT DO NOTHING
                """,
                (map_version_id, organization_id, map_id, Jsonb(definition), user_id),
            )

        await verify_transaction(transaction, fixture, ids, organization_id, user_id)
        await client.commit(transaction_id)
        committed = True
    except Exception as error:
        if not committed:
            try:
                await client.rollback(transaction_id)
            except Exception as rollback_error:
                raise FixtureError(
                    "managed-login fixture failed and rollback could not be confirmed"
                ) from rollback_error
        if isinstance(error, (FixtureError, VerificationError)):
            raise
        raise FixtureError("managed-login fixture provisioning failed") from error

    return fixture_receipt(fixture, ids)


async def verify_transaction(
    transaction: Any,
    fixture: ManagedLoginFixture,
    ids: FixtureIds,
    organization_id: UUID,
    user_id: UUID,
) -> None:
    counts = await transaction.fetch_one(
        """
        SELECT
          (SELECT count(*) FROM app.projects WHERE organization_id = %s AND id IN (%s, %s)),
          (SELECT count(*) FROM app.project_memberships WHERE organization_id = %s
             AND user_id = %s AND role = 'owner' AND project_id IN (%s, %s)),
          (SELECT count(*) FROM app.project_datasets WHERE organization_id = %s
             AND dataset_id = %s AND project_id IN (%s, %s)),
          (SELECT count(*) FROM app.maps WHERE organization_id = %s AND id IN (%s, %s)),
          (SELECT count(*) FROM app.dataset_features WHERE organization_id = %s
             AND dataset_id = %s AND deleted_at IS NULL),
          (SELECT count(*) FROM app.dataset_feature_revisions WHERE organization_id = %s
             AND dataset_id = %s)
        """,
        (
            organization_id,
            ids.projects[0],
            ids.projects[1],
            organization_id,
            user_id,
            ids.projects[0],
            ids.projects[1],
            organization_id,
            ids.dataset,
            ids.projects[0],
            ids.projects[1],
            organization_id,
            ids.maps[0],
            ids.maps[1],
            organization_id,
            ids.dataset,
            organization_id,
            ids.dataset,
        ),
    )
    if counts != (2, 2, 2, 2, 6, 6):
        raise FixtureError("managed-login fixture cardinality is invalid")

    observed_strokes: list[str] = []
    for project, project_id, map_id in zip(
        fixture.projects, ids.projects, ids.maps, strict=True
    ):
        row = await transaction.fetch_one(
            """
            SELECT project_id, name, status::text, definition, version,
                   (SELECT count(*) FROM app.map_versions version
                    WHERE version.organization_id = map.organization_id
                      AND version.map_id = map.id)
            FROM app.maps map
            WHERE organization_id = %s AND id = %s
            """,
            (organization_id, map_id),
        )
        if (
            row is None
            or row[0] != project_id
            or row[1] != project.map_name
            or row[2] != "active"
        ):
            raise FixtureError(
                "managed-login map identity conflicts with existing data"
            )
        definition = row[3]
        if (
            not isinstance(definition, dict)
            or definition.get("schemaVersion") != MAP_SCHEMA
        ):
            raise FixtureError("managed-login map definition is invalid")
        layers = definition.get("layers")
        if not isinstance(layers, list) or len(layers) != 1:
            raise FixtureError("managed-login map must contain exactly one layer")
        layer = layers[0]
        if (
            not isinstance(layer, dict)
            or layer.get("datasetId") != str(ids.dataset)
            or layer.get("sourceType") != "governed-dataset"
            or layer.get("geometryType") != "LineString"
            or not isinstance(layer.get("style"), dict)
            or layer["style"].get("stroke") not in project.strokes
        ):
            raise FixtureError("managed-login map dataset binding or style is invalid")
        if not isinstance(row[4], int) or row[4] < 1 or row[5] != row[4]:
            raise FixtureError("managed-login map history is incomplete")
        observed_strokes.append(layer["style"]["stroke"])
    if observed_strokes[0] == observed_strokes[1]:
        raise FixtureError("managed-login map styles are not independent")

    feature_rows = await transaction.fetch_all(
        """
        SELECT properties, geometry_geojson
        FROM app.dataset_features
        WHERE organization_id = %s AND dataset_id = %s AND deleted_at IS NULL
        ORDER BY (properties->>'segment')::integer
        """,
        (organization_id, ids.dataset),
    )
    expected_features = [
        (
            {"name": feature.name, "segment": feature.segment},
            {
                "type": "LineString",
                "coordinates": [list(value) for value in feature.coordinates],
            },
        )
        for feature in fixture.features
    ]
    if feature_rows != expected_features:
        raise FixtureError(
            "managed-login governed features conflict with existing data"
        )


def fixture_receipt(fixture: ManagedLoginFixture, ids: FixtureIds) -> dict[str, Any]:
    digest = lambda value: hashlib.sha256(str(value).encode("utf-8")).hexdigest()
    return {
        "schemaVersion": "opengeo.managed-login-fixture-provisioning.1.0.0",
        "environment": "development",
        "status": "passed",
        "projectCount": len(fixture.projects),
        "mapCount": len(fixture.projects),
        "datasetCount": 1,
        "sharedDatasetProjectCount": 2,
        "governedFeatureCount": len(fixture.features),
        "projectIdSha256": [digest(value) for value in ids.projects],
        "mapIdSha256": [digest(value) for value in ids.maps],
        "datasetIdSha256": digest(ids.dataset),
        "newInfrastructureResources": 0,
        "credentialMaterialRecorded": False,
        "productionAccountsModified": False,
    }


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    result.add_argument("--validate-only", action="store_true")
    result.add_argument("--profile", default="opengeo-dev-operator")
    result.add_argument("--region", default="us-east-1")
    result.add_argument("--expected-account", default=DEVELOPMENT_ACCOUNT)
    result.add_argument("--cluster-arn")
    result.add_argument("--runtime-secret-arn")
    result.add_argument("--organization-id")
    result.add_argument("--user-id")
    result.add_argument("--confirm")
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        fixture = load_fixture(args.fixture.resolve())
        if args.validate_only:
            print(
                json.dumps(
                    {
                        "schemaVersion": FIXTURE_SCHEMA,
                        "environment": "development",
                        "status": "valid",
                        "projectCount": 2,
                        "sharedDatasetProjectCount": 2,
                        "governedFeatureCount": 6,
                        "credentialMaterialRecorded": False,
                    },
                    sort_keys=True,
                )
            )
            return 0
        required = {
            "--cluster-arn": args.cluster_arn,
            "--runtime-secret-arn": args.runtime_secret_arn,
            "--organization-id": args.organization_id,
            "--user-id": args.user_id,
            "--confirm": args.confirm,
        }
        missing = [name for name, value in required.items() if value is None]
        if missing:
            raise FixtureError(
                f"managed-login provisioning requires {', '.join(missing)}"
            )
        validate_scope(args)
        print(
            json.dumps(asyncio.run(provision(args, fixture)), sort_keys=True, indent=2)
        )
        return 0
    except FixtureError as error:
        print(
            json.dumps(
                {
                    "status": "failed",
                    "detail": str(error),
                    "credentialMaterialRecorded": False,
                    "productionAccountsModified": False,
                },
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
