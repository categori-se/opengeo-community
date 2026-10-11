"""Bounded, read-only PostGIS plans for explicitly requested vector previews."""

import hashlib
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

AnalysisOperation = Literal[
    "buffer",
    "centroid",
    "clip",
    "dissolve",
    "join",
    "intersection",
    "measure",
    "join-summary",
    "select-by-location",
]
MAX_FEATURES = 1000
MAX_COORDINATES = 50000
MAX_OUTPUT_BYTES = 2_097_152
PAIR_OPERATIONS = {"clip", "join", "intersection", "join-summary", "select-by-location"}
ANALYSIS_QUERY_MARKER = "/* opengeo analysis preview */"


@dataclass(frozen=True)
class AnalysisRequest:
    operation: AnalysisOperation
    source_generation: int
    target_dataset_id: UUID | None = None
    target_generation: int | None = None
    distance_meters: float | None = None
    preview_id: UUID | None = None


def analysis_application_name(
    organization_id: UUID,
    user_id: UUID,
    project_id: UUID,
    dataset_id: UUID,
    preview_id: UUID,
) -> str:
    """Bind an active preview to its caller without exposing identity or a backend PID."""
    identity = ":".join(
        str(value) for value in (organization_id, user_id, project_id, dataset_id, preview_id)
    )
    # PostgreSQL application_name is limited to 63 bytes. Retain 160 digest bits.
    return "opengeo-analysis-" + hashlib.sha256(identity.encode("ascii")).hexdigest()[:40]


def analysis_statement(
    organization_id: UUID,
    dataset_id: UUID,
    request: AnalysisRequest,
) -> tuple[str, tuple[Any, ...]]:
    import math

    if request.operation not in {
        "buffer",
        "centroid",
        "clip",
        "dissolve",
        "join",
        "intersection",
        "measure",
        "join-summary",
        "select-by-location",
    }:
        raise ValueError("unsupported analysis operation")
    paired = request.operation in PAIR_OPERATIONS
    if paired != (request.target_dataset_id is not None and request.target_generation is not None):
        raise ValueError("paired analysis requires a target dataset and generation")
    if not paired and (
        request.target_dataset_id is not None or request.target_generation is not None
    ):
        raise ValueError("operation does not use a target")
    if request.operation == "buffer":
        distance = request.distance_meters
        if (
            not isinstance(distance, (int, float))
            or isinstance(distance, bool)
            or not math.isfinite(distance)
            or not 0 < distance <= 100000
        ):
            raise ValueError("buffer distance must be 0 to 100000 meters, excluding zero")
    elif request.distance_meters is not None:
        raise ValueError("operation does not use a buffer distance")
    if request.source_generation < 1 or (paired and (request.target_generation or 0) < 1):
        raise ValueError("generation must be positive")
    target = request.target_dataset_id or dataset_id
    target_generation = request.target_generation if paired else request.source_generation
    operations = {
        "select-by-location": (
            "SELECT a.id::text AS id, a.geometry AS geom, a.properties FROM a "
            "WHERE EXISTS (SELECT 1 FROM b WHERE ST_Dimension(b.geometry)=2 "
            "AND ST_Intersects(a.geometry,b.geometry))"
        ),
        "join-summary": (
            "SELECT a.id::text AS id, a.geometry AS geom, "
            "jsonb_build_object('source',a.properties,'target',first.properties,"
            "'target_id',first.id,'join_count',matches.count) AS properties FROM a "
            "CROSS JOIN LATERAL (SELECT count(*) AS count FROM b "
            "WHERE ST_Intersects(a.geometry,b.geometry)) matches "
            "LEFT JOIN LATERAL (SELECT b.id,b.properties FROM b "
            "WHERE ST_Intersects(a.geometry,b.geometry) ORDER BY b.id LIMIT 1) first ON TRUE"
        ),
        "measure": (
            "SELECT id::text AS id, geometry AS geom, "
            "jsonb_build_object('source',properties,'measurement',jsonb_build_object("
            "'area_sqm',ST_Area(m.g),'length_m',ST_Length(m.g))) AS properties "
            "FROM a CROSS JOIN LATERAL "
            "(SELECT geometry::geography AS g OFFSET 0) m"
        ),
        "centroid": ("SELECT id::text AS id, ST_Centroid(geometry) AS geom, properties FROM a"),
        "buffer": (
            "SELECT id::text AS id, ST_Buffer(geometry::geography,%s)::geometry AS geom, "
            "properties FROM a"
        ),
        "dissolve": (
            "SELECT 'dissolved' AS id, ST_UnaryUnion(ST_Collect(geometry)) AS geom, "
            "'{}'::jsonb AS properties FROM a HAVING count(*)>0"
        ),
        "clip": (
            "SELECT a.id::text AS id, ST_CollectionExtract(ST_Intersection(a.geometry,b.geom), "
            "ST_Dimension(a.geometry)+1) AS geom, "
            "a.properties FROM a CROSS JOIN (SELECT "
            "ST_UnaryUnion(ST_Collect(ST_CollectionExtract(geometry,3))) "
            "AS geom FROM b WHERE ST_Dimension(geometry)=2) b "
            "WHERE ST_Intersects(a.geometry,b.geom)"
        ),
        "intersection": (
            "SELECT a.id::text || ':' || b.id::text AS id, "
            "ST_CollectionExtract(ST_Intersection(a.geometry,b.geometry), "
            "ST_Dimension(a.geometry)+1) AS geom, "
            "jsonb_build_object('source',a.properties,'target',b.properties) AS "
            "properties FROM a JOIN b ON ST_Dimension(b.geometry)=2 "
            "AND ST_Intersects(a.geometry,b.geometry)"
        ),
        "join": (
            "SELECT a.id::text || ':' || b.id::text AS id, a.geometry AS geom, "
            "jsonb_build_object('source',a.properties,'target',b.properties) AS "
            "properties FROM a JOIN b ON ST_Intersects(a.geometry,b.geometry)"
        ),
    }
    sql = f"""
    WITH source AS MATERIALIZED (
      SELECT id,geometry,properties FROM app.dataset_features
      WHERE organization_id=%s AND dataset_id=%s AND deleted_at IS NULL
      ORDER BY id LIMIT {MAX_FEATURES + 1}
    ), target AS MATERIALIZED (
      SELECT id,geometry,properties FROM app.dataset_features
      WHERE organization_id=%s AND dataset_id=%s AND deleted_at IS NULL
      ORDER BY id LIMIT {MAX_FEATURES + 1}
    ), facts AS MATERIALIZED (
      SELECT
        (SELECT generation FROM app.feature_collections
          WHERE organization_id=%s AND dataset_id=%s) AS source_generation,
        (SELECT generation FROM app.feature_collections
          WHERE organization_id=%s AND dataset_id=%s) AS target_generation,
        (SELECT count(*) FROM source) AS source_count,
        (SELECT count(*) FROM target) AS target_count,
        (SELECT coalesce(sum(ST_NPoints(geometry)),0) FROM source) AS source_points,
        (SELECT coalesce(sum(ST_NPoints(geometry)),0) FROM target) AS target_points,
        (SELECT coalesce(ST_XMax(ST_Extent(geometry))-ST_XMin(ST_Extent(geometry)),0)
          FROM source) AS longitude_span
    ), gate AS MATERIALIZED (
      SELECT *, source_generation=%s AND target_generation=%s
        AND source_count<={MAX_FEATURES} AND target_count<={MAX_FEATURES}
        AND source_points<={MAX_COORDINATES} AND target_points<={MAX_COORDINATES}
        AND (%s::boolean IS FALSE OR longitude_span<=6) AS allowed FROM facts
    ), a AS MATERIALIZED (SELECT source.* FROM source WHERE (SELECT allowed FROM gate)),
       b AS MATERIALIZED (SELECT target.* FROM target WHERE (SELECT allowed FROM gate)),
    result AS MATERIALIZED (
      SELECT * FROM ({operations[request.operation]}) candidates
      WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom) LIMIT {MAX_FEATURES + 1}
    ),
    bounded AS MATERIALIZED (
      SELECT * FROM result WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
      ORDER BY id LIMIT {MAX_FEATURES + 1}
    ), output_facts AS MATERIALIZED (
      SELECT count(*) AS count, coalesce(sum(ST_NPoints(geom)),0) AS points FROM bounded
    ), encoded AS MATERIALIZED (
      SELECT jsonb_build_object('type','Feature','id',id,'properties',properties,
        'geometry',ST_AsGeoJSON(geom)::jsonb) AS feature FROM bounded
      WHERE (SELECT count<={MAX_FEATURES} AND points<={MAX_COORDINATES} FROM output_facts)
      ORDER BY id
    ), bytes AS (SELECT coalesce(sum(octet_length(feature::text)),0) AS size FROM encoded)
    SELECT to_jsonb(gate), to_jsonb(output_facts), bytes.size,
      CASE WHEN bytes.size<={MAX_OUTPUT_BYTES}
        THEN coalesce((SELECT jsonb_agg(feature) FROM encoded),'[]'::jsonb) ELSE NULL END
      FROM gate CROSS JOIN output_facts CROSS JOIN bytes
    """
    parameters: tuple[Any, ...] = (
        organization_id,
        dataset_id,
        organization_id,
        target,
        organization_id,
        dataset_id,
        organization_id,
        target,
        request.source_generation,
        target_generation,
        request.operation == "buffer",
    )
    if request.operation == "buffer":
        parameters += (request.distance_meters,)
    return ANALYSIS_QUERY_MARKER + sql, parameters
