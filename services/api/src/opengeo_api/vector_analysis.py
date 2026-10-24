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
    "building-reconcile",
]
MAX_FEATURES = 1000
MAX_COORDINATES = 50000
MAX_OUTPUT_BYTES = 2_097_152
PAIR_OPERATIONS = {
    "clip",
    "join",
    "intersection",
    "join-summary",
    "select-by-location",
    "building-reconcile",
}
BUILDING_IOU_THRESHOLD = 0.5
BUILDING_SPAN_DEGREES = 6
BUILDING_MAX_ABSOLUTE_LATITUDE = 80
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
        "building-reconcile",
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
    reconcile = request.operation == "building-reconcile"
    if reconcile and request.target_dataset_id == dataset_id:
        raise ValueError("building reconciliation requires two distinct inventories")
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
    inventory_extent = ""
    inventory_facts = ""
    inventory_gate = ""
    reconciliation = ""
    if reconcile:
        inventory_extent = """inventory_extent AS MATERIALIZED (
          SELECT ST_Extent(geometry) AS bounds FROM (
            SELECT geometry FROM source UNION ALL SELECT geometry FROM target
          ) inventories
        ), """
        inventory_facts = """,
          (SELECT coalesce(bool_and(ST_GeometryType(geometry) IN
            ('ST_Polygon','ST_MultiPolygon') AND NOT ST_IsEmpty(geometry)
            AND ST_IsValid(geometry) AND ST_Area(geometry)>0),true)
            FROM (SELECT geometry FROM source UNION ALL SELECT geometry FROM target)
              inventories) AS building_polygon_inputs,
          (SELECT coalesce(ST_XMax(bounds)-ST_XMin(bounds),0)
            FROM inventory_extent) AS building_longitude_span,
          (SELECT coalesce(ST_YMax(bounds)-ST_YMin(bounds),0)
            FROM inventory_extent) AS building_latitude_span,
          (SELECT coalesce(ST_YMin(bounds),0) FROM inventory_extent) AS building_min_latitude,
          (SELECT coalesce(ST_YMax(bounds),0) FROM inventory_extent) AS building_max_latitude
        """
        inventory_gate = f"""
          AND building_polygon_inputs AND source_count+target_count<={MAX_FEATURES}
          AND building_longitude_span<={BUILDING_SPAN_DEGREES}
          AND building_latitude_span<={BUILDING_SPAN_DEGREES}
          AND building_min_latitude>=-{BUILDING_MAX_ABSOLUTE_LATITUDE}
          AND building_max_latitude<={BUILDING_MAX_ABSOLUTE_LATITUDE}
        """
        reconciliation = _building_reconciliation_ctes()
        operations["building-reconcile"] = "SELECT id,geom,properties FROM building_result"
    geometry_json = "ST_AsGeoJSON(geom,17)" if reconcile else "ST_AsGeoJSON(geom)"
    sql = f"""
    WITH source AS MATERIALIZED (
      SELECT id,geometry,properties FROM app.dataset_features
      WHERE organization_id=%s AND dataset_id=%s AND deleted_at IS NULL
      ORDER BY id LIMIT {MAX_FEATURES + 1}
    ), target AS MATERIALIZED (
      SELECT id,geometry,properties FROM app.dataset_features
      WHERE organization_id=%s AND dataset_id=%s AND deleted_at IS NULL
      ORDER BY id LIMIT {MAX_FEATURES + 1}
    ), {inventory_extent}facts AS MATERIALIZED (
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
          FROM source) AS longitude_span {inventory_facts}
    ), gate AS MATERIALIZED (
      SELECT *, source_generation=%s AND target_generation=%s
        AND source_count<={MAX_FEATURES} AND target_count<={MAX_FEATURES}
        AND source_points<={MAX_COORDINATES} AND target_points<={MAX_COORDINATES}
        AND (%s::boolean IS FALSE OR longitude_span<=6) {inventory_gate} AS allowed FROM facts
    ), a AS MATERIALIZED (SELECT source.* FROM source WHERE (SELECT allowed FROM gate)),
       b AS MATERIALIZED (SELECT target.* FROM target WHERE (SELECT allowed FROM gate)),
    {reconciliation}result AS MATERIALIZED (
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
        'geometry',{geometry_json}::jsonb) AS feature FROM bounded
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


def _building_reconciliation_ctes() -> str:
    """Preserve every footprint; positive-area adjacency exposes splits and merges.

    Geography intersection chooses PostGIS's local projected overlay; its returned
    geography and original footprints use spheroidal area. The separate input gate
    limits this profile to small, nonpolar inventories without date-line crossings.
    Neither a candidate nor a source confidence value establishes a validated count.
    """
    return f"""
    building_a AS MATERIALIZED (
      SELECT *, ST_Area(geometry::geography) AS area FROM a
    ), building_b AS MATERIALIZED (
      SELECT *, ST_Area(geometry::geography) AS area FROM b
    ), building_overlaps AS MATERIALIZED (
      SELECT a.id AS source_id,b.id AS target_id,a.area AS source_area,b.area AS target_area,
        ST_Area(ST_Intersection(a.geometry::geography,b.geometry::geography)) AS overlap_area
      FROM building_a a JOIN building_b b ON ST_Intersects(a.geometry,b.geometry)
    ), building_edges AS MATERIALIZED (
      SELECT source_id,target_id,
        least(1.0,overlap_area/nullif(source_area+target_area-overlap_area,0)) AS iou
      FROM building_overlaps WHERE overlap_area>0
    ), building_degrees AS MATERIALIZED (
      SELECT 'source' AS side,source_id AS id,count(*) AS degree
        FROM building_edges GROUP BY source_id
      UNION ALL
      SELECT 'target' AS side,target_id AS id,count(*) AS degree
        FROM building_edges GROUP BY target_id
    ), building_inventory AS MATERIALIZED (
      SELECT 'source' AS side,id,geometry,properties FROM a
      UNION ALL SELECT 'target' AS side,id,geometry,properties FROM b
    ), building_neighbors AS MATERIALIZED (
      SELECT 'source' AS side,e.source_id AS id,e.target_id AS neighbor_id,e.iou,d.degree
      FROM building_edges e JOIN building_degrees d ON d.side='target' AND d.id=e.target_id
      UNION ALL
      SELECT 'target' AS side,e.target_id AS id,e.source_id AS neighbor_id,e.iou,d.degree
      FROM building_edges e JOIN building_degrees d ON d.side='source' AND d.id=e.source_id
    ), building_result AS MATERIALIZED (
      SELECT i.side || ':' || i.id::text AS id,i.geometry AS geom,
        jsonb_build_object(
          'input',jsonb_build_object('side',i.side,'featureId',i.id,'properties',i.properties),
          'reconciliation',jsonb_build_object(
            'status',CASE WHEN n.count=0 THEN 'unmatched'
              WHEN n.count>1 OR n.max_degree>1 THEN 'ambiguous'
              WHEN n.max_iou>={BUILDING_IOU_THRESHOLD} THEN 'one-to-one-candidate'
              ELSE 'boundary-disagreement' END,
            'reviewStatus','unreviewed','neighbors',n.neighbors)) AS properties
      FROM building_inventory i CROSS JOIN LATERAL (
        SELECT count(*) AS count,max(degree) AS max_degree,max(iou) AS max_iou,
          coalesce(jsonb_agg(jsonb_build_object('featureId',neighbor_id,
            'intersectionOverUnion',iou,'overlapCount',degree) ORDER BY neighbor_id),
            '[]'::jsonb) AS neighbors
        FROM building_neighbors WHERE side=i.side AND id=i.id
      ) n
    ),
    """
