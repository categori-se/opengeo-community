#!/usr/bin/env python3
"""Create one MassGIS MassEnviroScreen showcase over the governed archive.

The checked-in project description remains the source of presentation metadata.
The dataset body stays in the versioned ``example-geodata/usa/ma`` S3 archive;
this bootstrap writes only project, source-revision, and map-definition records.
Existing maps are preserved so rerunning the bootstrap cannot overwrite edits.
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

CONFIG = (
    Path(__file__).resolve().parents[2]
    / "app"
    / "src"
    / "data"
    / "massgis-enviroscreen.json"
)
CONFIRMATION = "seed-massgis-massenviroscreen"
PROJECT_CODE = "MASSGIS-MASSENVIROSCREEN-DEMO"
PROJECT_NAME = "MassGIS · MassEnviroScreen"
SOURCE_NAME = "MassGIS MassEnviroScreen · 2026-04-18 archive"
ARCHIVE_BOUNDS = [-73.6, 41.1, -69.7, 43.0]
PROJECT_SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def load_plan(path: Path = CONFIG) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise MigrationError(
            "MassGIS project metadata is unavailable or invalid"
        ) from error
    try:
        project = value["project"]
        collection = value["collection"]
        source = value["sources"][0]
        archive = source["archive"]
        view = value["viewConfigurations"][0]
        indicator_groups = value["indicatorGroups"]
        combined = value["combinedAnalysis"]
        presets = {preset["id"]: preset for preset in value["stylePresets"]}
    except (KeyError, IndexError, TypeError) as error:
        raise MigrationError("MassGIS project metadata is incomplete") from error
    if (
        value.get("schemaVersion") != "opengeo.massgis-enviroscreen-demo.1.3.0"
        or project.get("title") != PROJECT_NAME
        or project.get("presentationCount") != 31
        or collection.get("license", {}).get("name") != "LicenseRef-Public-Domain"
        or source.get("type") != "arcgis-feature-layer"
        or archive.get("schemaVersion") != "opengeo.reference-archive.1.1.0"
        or archive.get("featureCount") != 5_109
        or archive.get("compressedSha256")
        != "7e280ab1f9ea003ebf699526d281938182214c2c4acce42524da956e58049bb2"
        or archive.get("uncompressedSha256")
        != "72003a49bbd98780cd4ae6767cb4b45b0951d0f921a5c0e80830db3a2d89dc11"
        or not isinstance(indicator_groups, list)
        or sum(len(group.get("maps", [])) for group in indicator_groups) != 30
        or not isinstance(combined.get("layers"), list)
        or len(combined["layers"]) != 3
    ):
        raise MigrationError(
            "MassGIS project metadata does not match the reviewed release"
        )
    if source.get("attribution") != collection.get("attribution"):
        raise MigrationError("MassGIS source attribution does not match the collection")

    source_url = (
        f"https://s3.{archive['region']}.amazonaws.com/"
        f"{archive['bucket']}/{archive['objectKey']}"
    )
    source_configuration = {
        "content_encoding": "gzip",
        "object_sha256": archive["compressedSha256"],
        "decoded_sha256": archive["uncompressedSha256"],
        "size_bytes": archive["compressedBytes"],
        "decoded_size_bytes": archive["uncompressedBytes"],
        "feature_count": archive["featureCount"],
        "geometry_type": "MultiPolygon",
        "bounds": ARCHIVE_BOUNDS,
        "attribution": source["attribution"],
        "license": collection["license"]["name"],
        "authoritative_url": source["layerUrl"],
        "rights_url": collection["license"]["url"],
    }
    presentations: list[dict[str, Any]] = []
    presentations.append(
        {
            "slug": combined["slug"],
            "name": combined["title"],
            "description": combined["summary"],
            "view": view,
            "layers": combined["layers"],
            "combined": True,
            "group": "combined-analysis",
        }
    )
    for group in indicator_groups:
        for presentation in group["maps"]:
            presentations.append(
                {
                    "slug": presentation["slug"],
                    "name": presentation["title"],
                    "description": presentation["summary"],
                    "view": view,
                    "layers": [presentation],
                    "combined": False,
                    "group": group["slug"],
                }
            )
    if len(presentations) != 31 or any(
        not PROJECT_SLUG.fullmatch(item["slug"]) for item in presentations
    ):
        raise MigrationError("MassGIS presentation inventory is invalid")
    return {
        "project": project,
        "collection": collection,
        "source": source,
        "archive": archive,
        "sourceUrl": source_url,
        "sourceConfiguration": source_configuration,
        "presets": presets,
        "indicatorGroups": indicator_groups,
        "combinedAnalysis": combined,
        "presentations": presentations,
        "savedPresentations": [item for item in presentations if item["combined"]],
    }


def _map_definition(
    plan: dict[str, Any],
    presentation: dict[str, Any],
    *,
    dataset_id: str,
    source_version: int,
    complete_catalog: bool,
) -> dict[str, Any]:
    configuration = plan["sourceConfiguration"]
    map_configuration = {
        "contentEncoding": configuration["content_encoding"],
        "objectSha256": configuration["object_sha256"],
        "decodedSha256": configuration["decoded_sha256"],
        "sizeBytes": configuration["size_bytes"],
        "decodedSizeBytes": configuration["decoded_size_bytes"],
        "featureCount": configuration["feature_count"],
        "geometryType": configuration["geometry_type"],
        "bounds": list(configuration["bounds"]),
        "attribution": configuration["attribution"],
        "license": configuration["license"],
        "authoritativeUrl": configuration["authoritative_url"],
        "rightsUrl": configuration["rights_url"],
    }
    combined_layers = list(reversed(plan["combinedAnalysis"]["layers"]))
    indicator_layers = [
        item for group in plan["indicatorGroups"] for item in group["maps"]
    ]
    catalog_layers = combined_layers + indicator_layers
    selected_slugs = {item["slug"] for item in presentation["layers"]}
    definitions = (
        catalog_layers if complete_catalog else list(reversed(presentation["layers"]))
    )
    layers = []
    for index, item in enumerate(definitions):
        style = item["style"]
        preset = plan["presets"][style["presetId"]]
        line = preset["geometry"] == "line"
        layer_id = f"massgis_{item['slug'].replace('-', '_')}"
        layers.append(
            {
                "layerId": layer_id,
                "datasetId": dataset_id,
                "title": item["title"],
                "description": style["fieldAlias"],
                "sourceType": "geojson-archive",
                "sourceVersion": source_version,
                "sourceUrl": plan["sourceUrl"],
                "sourceConfiguration": map_configuration,
                "sharedSourceId": dataset_id,
                "geometryType": "MultiPolygon",
                "bbox": list(ARCHIVE_BOUNDS),
                "visible": item["slug"] in selected_slugs,
                "opacity": preset["opacity"],
                "order": index,
                "attribution": plan["source"]["attribution"],
                "style": {
                    "renderer": "graduated",
                    "graduated": {
                        "field": style["field"],
                        "breaks": list(preset["breaks"]),
                        "colors": list(preset["colors"]),
                        "noDataColor": preset["nullColor"],
                        "noDataLabel": "No data",
                    },
                    "legendTitle": style["fieldAlias"],
                    "fill": preset["colors"][0],
                    "fillOpacityFactor": 0 if line else 1,
                    "polygonMode": "line" if line else "fill",
                    "stroke": preset["outlineColor"],
                    "strokeWidth": preset["outlineWidth"],
                    "combinedAnalysis": presentation["combined"],
                },
                "labels": {"enabled": False, "field": "NAME"},
            }
        )
    view = presentation["view"]
    active_layer_id = next(layer["layerId"] for layer in layers if layer["visible"])
    layer_tree = [
        {
            "kind": "group",
            "id": "combined-analysis",
            "title": "Combined screening layers",
            "open": presentation["combined"],
            "children": [
                {
                    "kind": "layer",
                    "layerId": f"massgis_{item['slug'].replace('-', '_')}",
                }
                for item in combined_layers
            ],
        },
        *[
            {
                "kind": "group",
                "id": group["slug"],
                "title": group["title"],
                "open": presentation["group"] == group["slug"],
                "children": [
                    {
                        "kind": "layer",
                        "layerId": f"massgis_{item['slug'].replace('-', '_')}",
                    }
                    for item in group["maps"]
                ],
            }
            for group in plan["indicatorGroups"]
        ],
    ]
    definition = {
        "schemaVersion": "opengeo.map-definition.1.3.0",
        "mapViews": [
            {
                "center": list(view["center"]),
                "zoom": view["zoom"],
                "pitch": view["pitch"],
                "bearing": view["bearing"],
            }
        ],
        "basemaps": [],
        "bookmarks": [
            {
                "bookmarkId": "massachusetts_statewide",
                "title": "Massachusetts statewide",
                "center": list(view["center"]),
                "zoom": view["zoom"],
            }
        ],
        "activeLayerId": active_layer_id,
        "activeProcessingModelId": None,
        "models": [],
        "processingHistory": [],
        "measurements": [],
        "projection": "mercator",
        "colorMode": "dark",
        "layers": layers,
    }
    if complete_catalog:
        definition["layerTree"] = layer_tree
    return definition


def map_definition(
    plan: dict[str, Any],
    presentation: dict[str, Any],
    *,
    dataset_id: str,
    source_version: int,
) -> dict[str, Any]:
    """Build one visibility preset over the complete project layer catalog."""

    return _map_definition(
        plan,
        presentation,
        dataset_id=dataset_id,
        source_version=source_version,
        complete_catalog=True,
    )


def legacy_map_definition(
    plan: dict[str, Any],
    presentation: dict[str, Any],
    *,
    dataset_id: str,
    source_version: int,
) -> dict[str, Any]:
    """Reproduce the old one-preset definition for a guarded data repair."""

    return _map_definition(
        plan,
        presentation,
        dataset_id=dataset_id,
        source_version=source_version,
        complete_catalog=False,
    )


class MassgisProjectBootstrap:
    def __init__(self, migrator: DataApiMigrator, runtime_secret_arn: str) -> None:
        self.migrator = migrator
        self.runtime_secret_arn = runtime_secret_arn

    def apply(
        self,
        *,
        subject: str,
        organization_slug: str,
        plan: dict[str, Any],
        visibility: str = "internal",
    ) -> dict[str, Any]:
        if visibility not in {"internal", "published"}:
            raise MigrationError("MassGIS project visibility is invalid")
        transaction = self.migrator._rds_call(
            "begin_transaction", **self.migrator._base()
        )
        transaction_id = transaction.get("transactionId")
        if not isinstance(transaction_id, str) or not transaction_id:
            raise MigrationError(
                "Data API did not return a MassGIS bootstrap transaction id"
            )
        try:
            self._execute(
                transaction_id,
                "SELECT pg_advisory_xact_lock(hashtextextended(:lock_name, 0))",
                [string_parameter("lock_name", f"opengeo-massgis:{organization_slug}")],
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
                isinstance(item, str) and COGNITO_SUBJECT.fullmatch(item)
                for item in (user_id, organization_id)
            ):
                raise MigrationError(
                    "MassGIS bootstrap owner is not an organization administrator"
                )

            project = self._one(
                transaction_id,
                """
                WITH inserted AS (
                  INSERT INTO app.projects
                    (organization_id, name, project_code, description, created_by)
                  VALUES (:organization_id, :name, :project_code, :description, :user_id)
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
                    string_parameter("description", plan["project"]["summary"]),
                    string_parameter("user_id", user_id, type_hint="UUID"),
                ],
            )
            project_id = project.get("id")
            if (
                not isinstance(project_id, str)
                or not COGNITO_SUBJECT.fullmatch(project_id)
                or project.get("name") != PROJECT_NAME
            ):
                raise MigrationError(
                    "MassGIS project upsert returned an invalid identity"
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
                    string_parameter(
                        "organization_id", organization_id, type_hint="UUID"
                    ),
                    string_parameter("project_id", project_id, type_hint="UUID"),
                    string_parameter("user_id", user_id, type_hint="UUID"),
                ],
            )
            project_visibility_supported = self._set_project_visibility(
                transaction_id,
                organization_id=organization_id,
                project_id=project_id,
                user_id=user_id,
                visibility=visibility,
            )

            configuration_json = json.dumps(
                plan["sourceConfiguration"], separators=(",", ":")
            )
            dataset = self._one(
                transaction_id,
                """
                WITH existing AS (
                  SELECT dataset.id
                  FROM app.datasets dataset
                  JOIN app.project_datasets project_dataset
                    ON project_dataset.organization_id = dataset.organization_id
                   AND project_dataset.dataset_id = dataset.id
                   AND project_dataset.project_id = :project_id
                  JOIN app.external_sources source
                    ON source.organization_id = dataset.organization_id
                   AND source.dataset_id = dataset.id
                   AND source.source_type = 'geojson'
                  JOIN LATERAL (
                    SELECT source_url, configuration
                    FROM app.external_source_revisions revision
                    WHERE revision.organization_id = dataset.organization_id
                      AND revision.dataset_id = dataset.id
                    ORDER BY version_number DESC LIMIT 1
                  ) revision ON true
                  WHERE dataset.organization_id = :organization_id
                    AND dataset.name = :name
                    AND dataset.source_type = 'geojson'
                    AND revision.source_url = :source_url
                    AND revision.configuration = CAST(:configuration AS jsonb)
                  ORDER BY dataset.created_at LIMIT 1
                ), inserted AS (
                  INSERT INTO app.datasets
                    (organization_id, name, description, classification, source_type,
                     format, status, owner_user_id, created_by, updated_by)
                  SELECT :organization_id, :name, :description, 'public', 'geojson',
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
                    string_parameter("name", SOURCE_NAME),
                    string_parameter("description", plan["collection"]["summary"]),
                    string_parameter("source_url", plan["sourceUrl"]),
                    string_parameter("configuration", configuration_json),
                    string_parameter("user_id", user_id, type_hint="UUID"),
                ],
            )
            dataset_id = dataset.get("id")
            if not isinstance(dataset_id, str) or not COGNITO_SUBJECT.fullmatch(
                dataset_id
            ):
                raise MigrationError(
                    "MassGIS dataset upsert returned an invalid identity"
                )
            self._execute(
                transaction_id,
                """
                INSERT INTO app.project_datasets
                  (organization_id, project_id, dataset_id, linked_by)
                VALUES (:organization_id, :project_id, :dataset_id, :user_id)
                ON CONFLICT DO NOTHING
                """,
                self._scope_parameters(
                    organization_id, project_id, dataset_id, user_id
                ),
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
            existing_map_source_version = self._existing_map_source_version(
                transaction_id,
                organization_id=organization_id,
                project_id=project_id,
                dataset_id=dataset_id,
            )
            revision_created = False
            if (
                current
                and current[0].get("source_url") == plan["sourceUrl"]
                and current[0].get("configuration") == plan["sourceConfiguration"]
            ):
                latest_source_version = int(current[0]["version_number"])
                source_version = existing_map_source_version or latest_source_version
            elif existing_map_source_version is not None:
                source_version = existing_map_source_version
            else:
                source_version = int(current[0]["version_number"]) + 1 if current else 1
                self._execute(
                    transaction_id,
                    """
                    INSERT INTO app.external_source_revisions
                      (organization_id, dataset_id, version_number, source_url,
                       configuration, verification_state, change_message, created_by)
                    VALUES (:organization_id, :dataset_id, :source_version, :source_url,
                            CAST(:configuration AS jsonb), 'syntax_only',
                            'Reviewed immutable MassGIS archive', :user_id)
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
                revision_created = True

            created_maps = 0
            repaired_maps = 0
            for presentation in plan["savedPresentations"]:
                definition = json.dumps(
                    map_definition(
                        plan,
                        presentation,
                        dataset_id=dataset_id,
                        source_version=source_version,
                    ),
                    separators=(",", ":"),
                )
                legacy_definition = json.dumps(
                    legacy_map_definition(
                        plan,
                        presentation,
                        dataset_id=dataset_id,
                        source_version=source_version,
                    ),
                    separators=(",", ":"),
                )
                marker = f"OpenGeo managed MassGIS presentation: {presentation['slug']}"
                record = self._one(
                    transaction_id,
                    """
                    WITH inserted AS (
                      INSERT INTO app.maps
                        (organization_id, project_id, name, description, definition,
                         created_by, updated_by)
                      SELECT :organization_id, :project_id, :name, :description,
                             CAST(:definition AS jsonb), :user_id, :user_id
                      WHERE NOT EXISTS (
                        SELECT 1 FROM app.maps
                        WHERE organization_id = :organization_id
                          AND project_id = :project_id AND description = :description
                      )
                      RETURNING id, version, definition, true AS created
                    )
                    SELECT id, version, definition, created FROM inserted
                    UNION ALL
                    SELECT id, version, definition, false AS created FROM app.maps
                    WHERE organization_id = :organization_id
                      AND project_id = :project_id AND description = :description
                    LIMIT 1
                    """,
                    [
                        string_parameter(
                            "organization_id", organization_id, type_hint="UUID"
                        ),
                        string_parameter("project_id", project_id, type_hint="UUID"),
                        string_parameter("name", presentation["name"]),
                        string_parameter("description", marker),
                        string_parameter("definition", definition),
                        string_parameter("user_id", user_id, type_hint="UUID"),
                    ],
                )
                if record.get("created") is True:
                    created_maps += 1
                    self._execute(
                        transaction_id,
                        """
                        INSERT INTO app.map_versions
                          (organization_id, map_id, version, definition,
                           change_message, created_by)
                        VALUES (:organization_id, :map_id, 1, CAST(:definition AS jsonb),
                                'Initial reviewed MassGIS presentation', :user_id)
                        """,
                        [
                            string_parameter(
                                "organization_id", organization_id, type_hint="UUID"
                            ),
                            string_parameter("map_id", record["id"], type_hint="UUID"),
                            string_parameter("definition", definition),
                            string_parameter("user_id", user_id, type_hint="UUID"),
                        ],
                    )
                elif self._repair_untouched_bootstrap_map(
                    transaction_id,
                    organization_id=organization_id,
                    project_id=project_id,
                    map_id=record["id"],
                    definition=definition,
                    legacy_definition=legacy_definition,
                    user_id=user_id,
                ):
                    repaired_maps += 1

            self._execute(
                transaction_id,
                """
                INSERT INTO app.activity_events
                  (organization_id, actor_user_id, project_id, event_type,
                   resource_type, resource_id, request_id, payload)
                SELECT :organization_id, :user_id, :project_id,
                       'project.massgis_prepared', 'project', :project_id,
                       :request_id,
                       jsonb_build_object('dataset_id', :dataset_id,
                                          'source_version', :source_version,
                                          'presentations', 1)
                WHERE NOT EXISTS (
                  SELECT 1 FROM app.activity_events
                  WHERE organization_id = :organization_id AND request_id = :request_id
                )
                """,
                [
                    *self._scope_parameters(
                        organization_id, project_id, dataset_id, user_id
                    ),
                    string_parameter(
                        "request_id", f"massgis-bootstrap-v{source_version}"
                    ),
                    long_parameter("source_version", source_version),
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
                    "MassGIS bootstrap failed and rollback was not confirmed"
                ) from rollback_error
            if isinstance(error, MigrationError):
                raise
            raise MigrationError("MassGIS project bootstrap failed") from error

        self.verify(
            subject=subject,
            organization_id=organization_id,
            expected_user_id=user_id,
            project_id=project_id,
            dataset_id=dataset_id,
            visibility=visibility,
            project_visibility_supported=project_visibility_supported,
            presentation_marker=f"OpenGeo managed MassGIS presentation: {plan['savedPresentations'][0]['slug']}",
        )
        return {
            "projectId": project_id,
            "datasetId": dataset_id,
            "sourceVersion": source_version,
            "createdProject": project.get("created") is True,
            "createdDataset": dataset.get("created") is True,
            "createdSourceRevision": revision_created,
            "createdMaps": created_maps,
            "visibility": visibility,
            "projectVisibilitySupported": project_visibility_supported,
            "repairedMaps": repaired_maps,
            "presentationCount": 31,
        }

    def _repair_untouched_bootstrap_map(
        self,
        transaction_id: str,
        *,
        organization_id: str,
        project_id: str,
        map_id: str,
        definition: str,
        legacy_definition: str,
        user_id: str,
    ) -> bool:
        """Upgrade an untouched empty or legacy preset without replacing edits."""

        rows = self._rows(
            transaction_id,
            """
            WITH eligible AS (
              SELECT map.id
              FROM app.maps map
              WHERE map.organization_id = :organization_id
                AND map.project_id = :project_id
                AND map.id = :map_id
                AND map.version = 1
                AND (
                  (
                    jsonb_typeof(map.definition -> 'layers') = 'array'
                    AND jsonb_array_length(map.definition -> 'layers') = 0
                  )
                  OR map.definition = CAST(:legacy_definition AS jsonb)
                )
                AND (
                  SELECT count(*)
                  FROM app.map_versions history
                  WHERE history.organization_id = map.organization_id
                    AND history.map_id = map.id
                ) = 1
                AND EXISTS (
                  SELECT 1
                  FROM app.map_versions history
                  WHERE history.organization_id = map.organization_id
                    AND history.map_id = map.id
                    AND history.version = 1
                    AND (
                      (
                        jsonb_typeof(history.definition -> 'layers') = 'array'
                        AND jsonb_array_length(history.definition -> 'layers') = 0
                      )
                      OR history.definition = CAST(:legacy_definition AS jsonb)
                    )
                )
              FOR UPDATE
            ), updated AS (
              UPDATE app.maps map
              SET definition = CAST(:definition AS jsonb),
                  version = 2,
                  updated_by = :user_id
              FROM eligible
              WHERE map.organization_id = :organization_id
                AND map.project_id = :project_id
                AND map.id = eligible.id
              RETURNING map.id
            ), history AS (
              INSERT INTO app.map_versions
                (organization_id, map_id, version, definition,
                 change_message, created_by)
              SELECT :organization_id, updated.id, 2, CAST(:definition AS jsonb),
                     'Restore complete reviewed MassGIS layer catalog', :user_id
              FROM updated
              RETURNING id
            )
            SELECT EXISTS (SELECT 1 FROM history) AS repaired
            """,
            [
                string_parameter("organization_id", organization_id, type_hint="UUID"),
                string_parameter("project_id", project_id, type_hint="UUID"),
                string_parameter("map_id", map_id, type_hint="UUID"),
                string_parameter("definition", definition),
                string_parameter("legacy_definition", legacy_definition),
                string_parameter("user_id", user_id, type_hint="UUID"),
            ],
        )
        return rows == [{"repaired": True}]

    def _existing_map_source_version(
        self,
        transaction_id: str,
        *,
        organization_id: str,
        project_id: str,
        dataset_id: str,
    ) -> int | None:
        rows = self._rows(
            transaction_id,
            """
            SELECT count(DISTINCT map.id)::int AS maps,
                   count(DISTINCT layer ->> 'datasetId')::int AS datasets,
                   min(layer ->> 'datasetId') AS dataset_id,
                   count(DISTINCT (layer ->> 'sourceVersion')::int)::int
                     AS source_versions,
                   min((layer ->> 'sourceVersion')::int)::int AS source_version
            FROM app.maps map
            LEFT JOIN LATERAL jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(map.definition -> 'layers') = 'array'
                THEN map.definition -> 'layers'
                ELSE '[]'::jsonb
              END
            ) layer ON true
            WHERE map.organization_id = :organization_id
              AND map.project_id = :project_id
              AND map.status = 'active'
              AND map.description LIKE 'OpenGeo managed MassGIS presentation: %'
            """,
            [
                string_parameter("organization_id", organization_id, type_hint="UUID"),
                string_parameter("project_id", project_id, type_hint="UUID"),
            ],
        )
        if len(rows) != 1:
            raise MigrationError("MassGIS map source inventory is invalid")
        row = rows[0]
        map_count = row.get("maps")
        source_versions = row.get("source_versions")
        if not isinstance(map_count, int) or not 0 <= map_count <= 31:
            raise MigrationError("MassGIS map inventory is invalid")
        if map_count == 0 or source_versions == 0:
            return None
        if (
            row.get("datasets") != 1
            or row.get("dataset_id") != dataset_id
            or source_versions != 1
            or not isinstance(row.get("source_version"), int)
            or row["source_version"] < 1
        ):
            raise MigrationError(
                "MassGIS maps do not share one governed source revision"
            )
        return row["source_version"]

    def _set_project_visibility(
        self,
        transaction_id: str,
        *,
        organization_id: str,
        project_id: str,
        user_id: str,
        visibility: str,
    ) -> bool:
        rows = self._rows(
            transaction_id,
            """
            SELECT EXISTS (
              SELECT 1
              FROM pg_attribute attribute
              JOIN pg_class relation ON relation.oid = attribute.attrelid
              JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = 'app'
                AND relation.relname = 'projects'
                AND attribute.attname = 'visibility'
                AND attribute.attnum > 0
                AND NOT attribute.attisdropped
            ) AS supported
            """,
            [],
        )
        supported = rows == [{"supported": True}]
        if not supported:
            if visibility != "internal":
                raise MigrationError(
                    "published MassGIS visibility requires schema release 0063"
                )
            return False
        self._execute(
            transaction_id,
            """
            UPDATE app.projects
            SET visibility = CAST(:visibility AS app.project_visibility),
                published_at = CASE WHEN :visibility = 'published'
                  THEN clock_timestamp() ELSE NULL END,
                published_by = CASE WHEN :visibility = 'published'
                  THEN :user_id ELSE NULL END
            WHERE organization_id = :organization_id AND id = :project_id
            """,
            [
                string_parameter("organization_id", organization_id, type_hint="UUID"),
                string_parameter("project_id", project_id, type_hint="UUID"),
                string_parameter("user_id", user_id, type_hint="UUID"),
                string_parameter("visibility", visibility),
            ],
        )
        return True

    def verify(
        self,
        *,
        subject: str,
        organization_id: str,
        expected_user_id: str,
        project_id: str,
        dataset_id: str,
        visibility: str = "internal",
        project_visibility_supported: bool = True,
        presentation_marker: str = "OpenGeo managed MassGIS presentation: combined-cumulative-burden-analysis",
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
        if rows != [{"user_id": expected_user_id, "organization_id": organization_id}]:
            raise MigrationError(
                "runtime MassGIS verification could not resolve the owner"
            )

        transaction = self.migrator._rds_call(
            "begin_transaction", **self.migrator._base(self.runtime_secret_arn)
        )
        transaction_id = transaction.get("transactionId")
        if not isinstance(transaction_id, str) or not transaction_id:
            raise MigrationError(
                "runtime MassGIS verification transaction is unavailable"
            )
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
            visibility_projection = (
                "min(project.visibility::text)"
                if project_visibility_supported
                else "'internal'::text"
            )
            response = self._runtime_execute(
                transaction_id,
                f"""
                SELECT count(DISTINCT map.id)::int AS maps,
                       count(DISTINCT source.dataset_id)::int AS sources,
                       count(DISTINCT map.id) FILTER (
                         WHERE jsonb_typeof(map.definition -> 'layers') = 'array'
                           AND jsonb_array_length(map.definition -> 'layers') = 33
                       )::int AS maps_with_layers,
                       sum(jsonb_array_length(map.definition -> 'layers'))::int
                         AS layers,
                       {visibility_projection} AS visibility
                FROM app.projects project
                JOIN app.project_memberships membership
                  ON membership.organization_id = project.organization_id
                 AND membership.project_id = project.id
                 AND membership.user_id = app.current_user_id()
                 AND membership.role = 'owner'
                JOIN app.maps map
                  ON map.organization_id = project.organization_id
                 AND map.project_id = project.id
                 AND map.status = 'active'
                 AND map.description = :presentation_marker
                JOIN app.external_sources source
                  ON source.organization_id = project.organization_id
                 AND source.dataset_id = :dataset_id
                 AND source.source_type = 'geojson'
                WHERE project.organization_id = app.current_organization_id()
                  AND project.id = :project_id
                  AND project.status = 'active'
                """,
                [
                    string_parameter("project_id", project_id, type_hint="UUID"),
                    string_parameter("dataset_id", dataset_id, type_hint="UUID"),
                    string_parameter("presentation_marker", presentation_marker),
                ],
            )
            result = json.loads(response.get("formattedRecords", "[]"))
            if result != [
                {
                    "maps": 1,
                    "sources": 1,
                    "maps_with_layers": 1,
                    "layers": 33,
                    "visibility": visibility,
                }
            ]:
                raise MigrationError(
                    "runtime MassGIS project did not match the reviewed plan"
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
                    "runtime MassGIS verification failed and rollback was not confirmed"
                ) from rollback_error
            if isinstance(error, MigrationError):
                raise
            raise MigrationError("runtime MassGIS verification failed") from error

    @staticmethod
    def _scope_parameters(
        organization_id: str, project_id: str, dataset_id: str, user_id: str
    ) -> list[dict[str, Any]]:
        return [
            string_parameter("organization_id", organization_id, type_hint="UUID"),
            string_parameter("project_id", project_id, type_hint="UUID"),
            string_parameter("dataset_id", dataset_id, type_hint="UUID"),
            string_parameter("user_id", user_id, type_hint="UUID"),
        ]

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
            raise MigrationError("MassGIS bootstrap returned invalid records")
        return rows

    def _one(
        self, transaction_id: str, sql: str, parameters: list[dict[str, Any]]
    ) -> dict[str, Any]:
        rows = self._rows(transaction_id, sql, parameters)
        if len(rows) != 1:
            raise MigrationError("MassGIS bootstrap expected one record")
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
    parser.add_argument("--organization-slug", default="opengeo-tools")
    parser.add_argument(
        "--visibility", choices=("internal", "published"), default="internal"
    )
    parser.add_argument("--config", type=Path, default=CONFIG)
    return parser.parse_args(argv)


def long_parameter(name: str, value: int) -> dict[str, Any]:
    return {"name": name, "value": {"longValue": value}}


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    if not COGNITO_SUBJECT.fullmatch(args.subject):
        raise MigrationError("subject must be a lowercase UUID")
    if not PROJECT_SLUG.fullmatch(args.organization_slug):
        raise MigrationError("organization slug is invalid")
    plan = load_plan(args.config)
    print(
        json.dumps(
            {
                "status": "validated",
                "mode": "apply" if args.apply else "plan",
                "projectCode": PROJECT_CODE,
                "projectName": PROJECT_NAME,
                "datasets": 1,
                "sourceRevisions": 1,
                "presentations": len(plan["savedPresentations"]),
                "availablePreviewPresets": len(plan["presentations"]),
                "layersPerPresentation": 33,
                "totalPresentationLayerBindings": 33,
                "datasetBodyStoredInDatabase": False,
                "archiveStorageUri": plan["archive"]["storageUri"],
                "visibility": args.visibility,
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
    result = MassgisProjectBootstrap(migrator, args.runtime_secret_arn).apply(
        subject=args.subject,
        organization_slug=args.organization_slug,
        plan=plan,
        visibility=args.visibility,
    )
    print(json.dumps({"status": "applied", **result}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except MigrationError as error:
        print(f"MassGIS project bootstrap error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
