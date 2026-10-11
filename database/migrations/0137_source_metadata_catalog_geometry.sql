BEGIN;
-- Retained provider extents belong to source observations, not hosted data versions.
CREATE FUNCTION app.knowledge_source_catalog_geometry(document jsonb)
RETURNS geometry LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
SET search_path=pg_catalog,public AS $$
DECLARE observation jsonb; bounds jsonb; reference jsonb; code text;
BEGIN
 SELECT item.value->'value' INTO observation
 FROM jsonb_array_elements(document->'metadata'->'normalized') WITH ORDINALITY item(value, ordinal)
 WHERE item.value->>'subject'='resource'
   AND item.value->>'property'='https://opengeo.tools/ns/arcgisLayerMetadata'
 ORDER BY item.ordinal DESC LIMIT 1;
 bounds:=COALESCE(observation->'extent',observation->'fullExtent');
 reference:=COALESCE(bounds->'spatialReference',observation->'spatialReference',observation->'sourceSpatialReference');
 code:=COALESCE(reference->>'latestWkid',reference->>'wkid');
 -- These Esri identifiers denote Web Mercator; other unsupported codes stay unknown.
 IF code IN ('102100','102113','900913') THEN code:='3857'; END IF;
 IF code IS NULL OR code !~ '^[1-9][0-9]{0,5}$' THEN RETURN NULL; END IF;
 RETURN app.catalog_extent_geometry(
   jsonb_build_array(bounds->'xmin',bounds->'ymin',bounds->'xmax',bounds->'ymax'), 'EPSG:'||code);
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
ALTER TABLE app.dataset_knowledge_revisions ADD COLUMN catalog_geometry geometry(Geometry,4326)
 GENERATED ALWAYS AS (app.knowledge_source_catalog_geometry(document)) STORED;
CREATE INDEX dataset_knowledge_catalog_geometry_idx ON app.dataset_knowledge_revisions USING gist(catalog_geometry)
 WHERE catalog_geometry IS NOT NULL;
COMMENT ON COLUMN app.dataset_knowledge_revisions.catalog_geometry IS
 'Derived extent of the retained provider observation; not exact feature coverage, current provider health, a hosted data version or an access grant.';
COMMIT;
