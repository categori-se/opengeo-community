\set ON_ERROR_STOP on

-- Exact synthetic target for the reviewed GeoServer 3.0.1 catalog import.
-- The parity runner replaces credential parameters and the SLD byte/hash
-- placeholders below in a private 0600 temporary copy. No credential or secret
-- belongs in this file.

ALTER ROLE opengeo_runtime PASSWORD :'runtime_password';
CREATE ROLE opengeo_geoserver_reader
  LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER NOBYPASSRLS
  PASSWORD :'geoserver_reader_password';

SELECT set_config('app.organization_id', '10000000-0000-4000-8000-000000000168', false);
SELECT set_config('app.user_id', '20000000-0000-4000-8000-000000000168', false);

BEGIN;
SET CONSTRAINTS ALL DEFERRED;

INSERT INTO app.users (id, cognito_subject, email, display_name) VALUES
  ('20000000-0000-4000-8000-000000000168', 'geoserver-import-owner',
   'catalog@example.test', 'Catalog Owner'),
  ('20000000-0000-4000-8000-000000000268', 'geoserver-import-other',
   'other@example.test', 'Other Owner');

INSERT INTO app.organizations (id, name, slug, created_by) VALUES
  ('10000000-0000-4000-8000-000000000168', 'Research', 'research',
   '20000000-0000-4000-8000-000000000168'),
  ('10000000-0000-4000-8000-000000000268', 'Other', 'other-research',
   '20000000-0000-4000-8000-000000000268');

INSERT INTO app.organization_memberships
  (organization_id, user_id, role, invited_by)
VALUES
  ('10000000-0000-4000-8000-000000000168',
   '20000000-0000-4000-8000-000000000168', 'admin',
   '20000000-0000-4000-8000-000000000168'),
  ('10000000-0000-4000-8000-000000000268',
   '20000000-0000-4000-8000-000000000268', 'admin',
   '20000000-0000-4000-8000-000000000268');

INSERT INTO app.projects (id, organization_id, name, created_by)
VALUES ('50000000-0000-4000-8000-000000000168',
        '10000000-0000-4000-8000-000000000168',
        'Research catalog import',
        '20000000-0000-4000-8000-000000000168');

INSERT INTO app.datasets
  (id, organization_id, name, classification, source_type, format, status,
   owner_user_id, created_by, updated_by)
VALUES ('80000000-0000-4000-8000-000000000168',
        '10000000-0000-4000-8000-000000000168',
        'Roads', 'internal', 'upload', 'geojson', 'active',
        '20000000-0000-4000-8000-000000000168',
        '20000000-0000-4000-8000-000000000168',
        '20000000-0000-4000-8000-000000000168');

INSERT INTO app.project_datasets
  (organization_id, project_id, dataset_id, linked_by)
VALUES ('10000000-0000-4000-8000-000000000168',
        '50000000-0000-4000-8000-000000000168',
        '80000000-0000-4000-8000-000000000168',
        '20000000-0000-4000-8000-000000000168');

INSERT INTO app.data_objects
  (id, organization_id, dataset_id, role, bucket, object_key, s3_version_id,
   etag, content_type, size_bytes, checksum_sha256, created_by)
VALUES ('81000000-0000-4000-8000-000000000168',
        '10000000-0000-4000-8000-000000000168',
        '80000000-0000-4000-8000-000000000168', 'original',
        'catalog-parity', 'roads.geojson', 'v1', '0123456789abcdef',
        'application/geo+json', 512, repeat('1', 64),
        '20000000-0000-4000-8000-000000000168');

INSERT INTO app.dataset_versions
  (id, organization_id, dataset_id, version_number, original_object_id, state,
   feature_count, extent, crs, geometry_type, schema_definition,
   quality_results, created_by)
VALUES ('82000000-0000-4000-8000-000000000168',
        '10000000-0000-4000-8000-000000000168',
        '80000000-0000-4000-8000-000000000168', 1,
        '81000000-0000-4000-8000-000000000168', 'active', 3,
        '[-77.1,38.8,-76.9,39.0]', 'EPSG:4326', 'LineString',
        '{"fields":[{"name":"name","type":"string"}]}', '{}',
        '20000000-0000-4000-8000-000000000168');

UPDATE app.datasets
SET current_version_id = '82000000-0000-4000-8000-000000000168'
WHERE organization_id = '10000000-0000-4000-8000-000000000168'
  AND id = '80000000-0000-4000-8000-000000000168';

INSERT INTO app.feature_collections
  (organization_id, dataset_id, geometry_type, schema_definition,
   generation, feature_count, created_by, updated_by)
VALUES ('10000000-0000-4000-8000-000000000168',
        '80000000-0000-4000-8000-000000000168', 'LineString',
        '{"schemaVersion":"1.0.0","fields":[{"name":"name","type":"string"}]}',
        1, 3,
        '20000000-0000-4000-8000-000000000168',
        '20000000-0000-4000-8000-000000000168');

INSERT INTO app.governed_resources
  (id, organization_id, project_id, kind, slug, dataset_id, visibility, state,
   current_version_id, owner_user_id, created_by, updated_by)
VALUES ('a0000000-0000-4000-8000-000000000168',
        '10000000-0000-4000-8000-000000000168',
        '50000000-0000-4000-8000-000000000168', 'dataset', 'roads',
        '80000000-0000-4000-8000-000000000168', 'organization', 'published',
        'a1000000-0000-4000-8000-000000000168',
        '20000000-0000-4000-8000-000000000168',
        '20000000-0000-4000-8000-000000000168',
        '20000000-0000-4000-8000-000000000168');

INSERT INTO app.governed_resource_versions
  (id, organization_id, resource_id, version_number, title, content,
   created_by)
VALUES ('a1000000-0000-4000-8000-000000000168',
        '10000000-0000-4000-8000-000000000168',
        'a0000000-0000-4000-8000-000000000168', 1, 'Roads',
        '{"blocks":[]}', '20000000-0000-4000-8000-000000000168');

INSERT INTO app.governed_resource_styles
  (id, organization_id, project_id, resource_id, slug, format,
   current_version_id, created_by, updated_by)
VALUES
  ('a2000000-0000-4000-8000-000000000168',
   '10000000-0000-4000-8000-000000000168',
   '50000000-0000-4000-8000-000000000168',
   'a0000000-0000-4000-8000-000000000168', 'roads-line', 'sld_1_0',
   'a3000000-0000-4000-8000-000000000168',
   '20000000-0000-4000-8000-000000000168',
   '20000000-0000-4000-8000-000000000168'),
  ('a2100000-0000-4000-8000-000000000168',
   '10000000-0000-4000-8000-000000000168',
   '50000000-0000-4000-8000-000000000168',
   'a0000000-0000-4000-8000-000000000168', 'roads-highlight', 'sld_1_0',
   'a3100000-0000-4000-8000-000000000168',
   '20000000-0000-4000-8000-000000000168',
   '20000000-0000-4000-8000-000000000168');

INSERT INTO app.governed_resource_style_versions
  (id, organization_id, style_id, version_number, title, media_type,
   definition, checksum_sha256, created_by)
VALUES
  ('a3000000-0000-4000-8000-000000000168',
   '10000000-0000-4000-8000-000000000168',
   'a2000000-0000-4000-8000-000000000168', 1, 'Roads line',
   'application/vnd.ogc.sld+xml',
   convert_from(decode('__ROADS_LINE_SLD_BASE64__', 'base64'), 'UTF8'),
   '__ROADS_LINE_SLD_SHA256__',
   '20000000-0000-4000-8000-000000000168'),
  ('a3100000-0000-4000-8000-000000000168',
   '10000000-0000-4000-8000-000000000168',
   'a2100000-0000-4000-8000-000000000168', 1, 'Roads highlight',
   'application/vnd.ogc.sld+xml',
   convert_from(decode('__ROADS_HIGHLIGHT_SLD_BASE64__', 'base64'), 'UTF8'),
   '__ROADS_HIGHLIGHT_SLD_SHA256__',
   '20000000-0000-4000-8000-000000000168');

INSERT INTO app.map_render_profiles
  (id, organization_id, project_id, resource_id, slug, current_version_id,
   created_by, updated_by)
VALUES
  ('a4000000-0000-4000-8000-000000000168',
   '10000000-0000-4000-8000-000000000168',
   '50000000-0000-4000-8000-000000000168',
   'a0000000-0000-4000-8000-000000000168', 'roads-line-map',
   'a5000000-0000-4000-8000-000000000168',
   '20000000-0000-4000-8000-000000000168',
   '20000000-0000-4000-8000-000000000168'),
  ('a4100000-0000-4000-8000-000000000168',
   '10000000-0000-4000-8000-000000000168',
   '50000000-0000-4000-8000-000000000168',
   'a0000000-0000-4000-8000-000000000168', 'roads-highlight-map',
   'a5100000-0000-4000-8000-000000000168',
   '20000000-0000-4000-8000-000000000168',
   '20000000-0000-4000-8000-000000000168');

INSERT INTO app.map_render_profile_versions
  (id, organization_id, profile_id, resource_id, resource_version_id,
   dataset_id, dataset_version_id, style_id, style_version_id,
   version_number, title, configuration, checksum_sha256, created_by)
VALUES
  ('a5000000-0000-4000-8000-000000000168',
   '10000000-0000-4000-8000-000000000168',
   'a4000000-0000-4000-8000-000000000168',
   'a0000000-0000-4000-8000-000000000168',
   'a1000000-0000-4000-8000-000000000168',
   '80000000-0000-4000-8000-000000000168',
   '82000000-0000-4000-8000-000000000168',
   'a2000000-0000-4000-8000-000000000168',
   'a3000000-0000-4000-8000-000000000168', 1, 'Roads line map',
   '{"schema":"opengeo.render.v1","geometry":{"type":"line"}}',
   repeat('3', 64), '20000000-0000-4000-8000-000000000168'),
  ('a5100000-0000-4000-8000-000000000168',
   '10000000-0000-4000-8000-000000000168',
   'a4100000-0000-4000-8000-000000000168',
   'a0000000-0000-4000-8000-000000000168',
   'a1000000-0000-4000-8000-000000000168',
   '80000000-0000-4000-8000-000000000168',
   '82000000-0000-4000-8000-000000000168',
   'a2100000-0000-4000-8000-000000000168',
   'a3100000-0000-4000-8000-000000000168', 1, 'Roads highlight map',
   '{"schema":"opengeo.render.v1","geometry":{"type":"line"}}',
   repeat('5', 64), '20000000-0000-4000-8000-000000000168');

INSERT INTO app.spatial_services
  (id, organization_id, project_id, slug, title, description, created_by,
   current_metadata_version_id, current_metadata_version_number,
   updated_by, updated_at)
VALUES ('60000000-0000-4000-8000-000000000168',
        '10000000-0000-4000-8000-000000000168',
        '50000000-0000-4000-8000-000000000168',
        'research', 'Research', 'Reviewed GeoServer import target',
        '20000000-0000-4000-8000-000000000168',
        'a8000000-0000-4000-8000-000000000168', 1,
        '20000000-0000-4000-8000-000000000168', clock_timestamp());

INSERT INTO app.spatial_service_metadata_versions
  (id, organization_id, project_id, service_id, version_number, title,
   abstract, namespace_uri, keywords, fees, access_constraints, contact,
   enabled_protocols, change_message, created_by)
VALUES ('a8000000-0000-4000-8000-000000000168',
        '10000000-0000-4000-8000-000000000168',
        '50000000-0000-4000-8000-000000000168',
        '60000000-0000-4000-8000-000000000168', 1, 'Research',
        'Initial service metadata', 'https://example.test/geoserver/research',
        ARRAY['research'], 'NONE', ARRAY['NONE'], '{}',
        ARRAY['wms_1_3','wfs_2_0'], 'Initial target',
        '20000000-0000-4000-8000-000000000168');

INSERT INTO app.spatial_service_stores
  (id, organization_id, project_id, service_id, slug, title, description,
   kind, created_by)
VALUES ('61000000-0000-4000-8000-000000000168',
        '10000000-0000-4000-8000-000000000168',
        '50000000-0000-4000-8000-000000000168',
        '60000000-0000-4000-8000-000000000168',
        'managed', 'Managed project datasets',
        'Governed datasets already linked to this project.',
        'managed_project', '20000000-0000-4000-8000-000000000168');

INSERT INTO app.spatial_service_collections
  (id, organization_id, project_id, service_id, collection_name, dataset_id,
   resource_id, default_profile_id, sealed_feature_generation,
   sealed_profile_version_id, sealed_profile_version_number, title,
   description, created_by, store_id)
VALUES ('70000000-0000-4000-8000-000000000168',
        '10000000-0000-4000-8000-000000000168',
        '50000000-0000-4000-8000-000000000168',
        '60000000-0000-4000-8000-000000000168', 'roads',
        '80000000-0000-4000-8000-000000000168',
        'a0000000-0000-4000-8000-000000000168',
        'a4000000-0000-4000-8000-000000000168', 1,
        'a5000000-0000-4000-8000-000000000168', 1, 'Roads',
        'Synthetic road segments for catalog synchronization.',
        '20000000-0000-4000-8000-000000000168',
        '61000000-0000-4000-8000-000000000168');

INSERT INTO app.external_connections
  (id, organization_id, project_id, provider, display_name, endpoint_host,
   database_name, allowed_schemas, secret_arn, configured_secret_fields,
   status, current_revision_number, last_verified_at, created_by, updated_by)
VALUES ('c1000000-0000-4000-8000-000000000168',
        '10000000-0000-4000-8000-000000000168',
        '50000000-0000-4000-8000-000000000168', 'postgresql',
        'Verified research PostGIS', 'db.example.test', 'research',
        ARRAY['public'],
        'arn:aws:secretsmanager:us-east-1:123456789012:secret:opengeo/catalog/parity',
        ARRAY['password','username'], 'credentials_verified', 1,
        clock_timestamp(), '20000000-0000-4000-8000-000000000168',
        '20000000-0000-4000-8000-000000000168');

INSERT INTO app.external_connection_revisions
  (organization_id, project_id, connection_id, revision_number,
   configuration, change_summary, created_by)
VALUES ('10000000-0000-4000-8000-000000000168',
        '50000000-0000-4000-8000-000000000168',
        'c1000000-0000-4000-8000-000000000168', 1,
        '{"provider":"postgresql","endpointHost":"db.example.test","endpointPort":5432,"databaseName":"research","allowedSchemas":["public"],"readOnly":true,"tlsMode":"verify_full","networkMode":"public_internet"}',
        'Reviewed verified connection',
        '20000000-0000-4000-8000-000000000168');

INSERT INTO app.external_connection_verifications
  (id, organization_id, project_id, connection_id,
   connection_revision_number, state, attempt_count, requested_by,
   request_id, network_reachable, tls_verified, credentials_verified,
   postgis_verified, duration_ms, started_at, finished_at)
VALUES ('c2000000-0000-4000-8000-000000000168',
        '10000000-0000-4000-8000-000000000168',
        '50000000-0000-4000-8000-000000000168',
        'c1000000-0000-4000-8000-000000000168', 1, 'succeeded', 1,
        '20000000-0000-4000-8000-000000000168',
        'geoserver-catalog-import-target', true, true, true, true, 25,
        clock_timestamp() - interval '1 second', clock_timestamp());

COMMIT;

CREATE TABLE public.roads (
  id integer PRIMARY KEY,
  name text NOT NULL,
  class text NOT NULL,
  geom geometry(LineString, 4326) NOT NULL
);
INSERT INTO public.roads (id, name, class, geom) VALUES
  (1, 'Western route', 'primary',
   ST_GeomFromText('LINESTRING(-77.10 38.82,-77.02 38.90)', 4326)),
  (2, 'Central route', 'secondary',
   ST_GeomFromText('LINESTRING(-77.02 38.90,-76.96 38.96)', 4326)),
  (3, 'Eastern route', 'local',
   ST_GeomFromText('LINESTRING(-76.98 38.84,-76.91 38.93)', 4326));
GRANT USAGE ON SCHEMA public TO opengeo_geoserver_reader;
GRANT SELECT ON TABLE public.roads TO opengeo_geoserver_reader;

RESET app.organization_id;
RESET app.user_id;
