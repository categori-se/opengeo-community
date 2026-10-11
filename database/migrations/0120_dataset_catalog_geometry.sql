BEGIN;
-- Derived discovery geometry only. Original source extent and CRS remain authoritative.
CREATE FUNCTION app.catalog_extent_geometry(bounds jsonb, reference text)
RETURNS geometry LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
SET search_path=pg_catalog,public AS $$
DECLARE west double precision; south double precision; east double precision; north double precision;
 code integer; shape geometry;
BEGIN
 IF jsonb_typeof(bounds)<>'array' OR jsonb_array_length(bounds)<>4 THEN RETURN NULL; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(bounds) v WHERE jsonb_typeof(v)<>'number') THEN RETURN NULL; END IF;
 west:=(bounds->>0)::double precision; south:=(bounds->>1)::double precision;
 east:=(bounds->>2)::double precision; north:=(bounds->>3)::double precision;
 IF NOT (west BETWEEN -1e15 AND 1e15 AND east BETWEEN -1e15 AND 1e15
   AND south BETWEEN -1e15 AND 1e15 AND north BETWEEN -1e15 AND 1e15) OR south>north THEN RETURN NULL; END IF;
 IF upper(reference) IN ('OGC:CRS84','CRS84','EPSG:4326') THEN code:=4326;
 ELSIF upper(reference) ~ '^EPSG:[1-9][0-9]{0,5}$' THEN code:=split_part(reference,':',2)::integer;
 ELSE RETURN NULL; END IF;
 IF code=4326 THEN
  IF west < -180 OR west > 180 OR east < -180 OR east > 180 OR south < -90 OR north > 90 THEN RETURN NULL; END IF;
  IF west>east THEN
   RETURN ST_Collect(
    ST_Envelope(ST_Collect(ST_SetSRID(ST_Point(west,south),4326),ST_SetSRID(ST_Point(180,north),4326))),
    ST_Envelope(ST_Collect(ST_SetSRID(ST_Point(-180,south),4326),ST_SetSRID(ST_Point(east,north),4326))));
  END IF;
 END IF;
 IF west>east THEN RETURN NULL; END IF;
 shape:=ST_Envelope(ST_Collect(ST_SetSRID(ST_Point(west,south),code),ST_SetSRID(ST_Point(east,north),code)));
 IF code<>4326 THEN
  -- At most 256 boundary segments per rectangle, not a per-page transform.
  IF greatest(east-west,north-south)>0 THEN shape:=ST_Segmentize(shape,greatest(east-west,north-south)/64); END IF;
  shape:=ST_Transform(shape,4326);
 END IF;
 IF NOT ST_IsValid(shape) OR ST_XMin(Box3D(shape)) < -180 OR ST_XMax(Box3D(shape)) > 180
   OR ST_YMin(Box3D(shape)) < -90 OR ST_YMax(Box3D(shape)) > 90 THEN RETURN NULL; END IF;
 RETURN shape;
EXCEPTION WHEN OTHERS THEN RETURN NULL; -- Missing CRS/grid or invalid extent is unknown, never a failed ingest.
END $$;
ALTER TABLE app.dataset_versions ADD COLUMN catalog_geometry geometry(Geometry,4326)
 GENERATED ALWAYS AS (app.catalog_extent_geometry(extent,crs)) STORED;
CREATE INDEX dataset_versions_catalog_geometry_idx ON app.dataset_versions USING gist(catalog_geometry)
 WHERE catalog_geometry IS NOT NULL;
COMMENT ON COLUMN app.dataset_versions.catalog_geometry IS 'Derived bounded source-extent geometry for discovery, not feature coverage or rights evidence. Recompute after projection database changes.';
COMMIT;
