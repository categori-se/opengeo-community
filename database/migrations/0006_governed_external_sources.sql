BEGIN;

CREATE TYPE app.external_source_access_mode AS ENUM ('direct_browser');
CREATE TYPE app.external_source_credential_mode AS ENUM ('none');
CREATE TYPE app.external_source_verification_state AS ENUM ('syntax_only');

CREATE TABLE app.external_sources (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  dataset_id uuid NOT NULL,
  source_type app.dataset_source_type NOT NULL,
  access_mode app.external_source_access_mode NOT NULL DEFAULT 'direct_browser',
  credential_mode app.external_source_credential_mode NOT NULL DEFAULT 'none',
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, dataset_id),
  CONSTRAINT external_sources_supported_type CHECK (source_type IN ('xyz', 'wms')),
  FOREIGN KEY (organization_id, dataset_id)
    REFERENCES app.datasets (organization_id, id)
);

CREATE TABLE app.external_source_revisions (
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  dataset_id uuid NOT NULL,
  version_number bigint NOT NULL,
  source_url text NOT NULL,
  configuration jsonb NOT NULL,
  verification_state app.external_source_verification_state NOT NULL DEFAULT 'syntax_only',
  change_message text,
  created_by uuid NOT NULL REFERENCES app.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, dataset_id, version_number),
  CONSTRAINT external_source_revision_number_positive CHECK (version_number > 0),
  CONSTRAINT external_source_revision_url_bounded CHECK (
    char_length(source_url) BETWEEN 9 AND 2048
    AND left(source_url, 8) = 'https://'
    AND source_url !~ '[[:cntrl:]\\]'
  ),
  CONSTRAINT external_source_revision_configuration_object CHECK (
    jsonb_typeof(configuration) = 'object'
    AND octet_length(configuration::text) <= 16384
  ),
  CONSTRAINT external_source_revision_message_bounded CHECK (
    change_message IS NULL OR char_length(change_message) BETWEEN 1 AND 500
  ),
  FOREIGN KEY (organization_id, dataset_id)
    REFERENCES app.external_sources (organization_id, dataset_id)
);

CREATE INDEX external_source_revisions_current_idx
  ON app.external_source_revisions
  (organization_id, dataset_id, version_number DESC);

CREATE FUNCTION app.enforce_external_source_dataset()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  dataset_source_type app.dataset_source_type;
  dataset_format app.dataset_format;
BEGIN
  SELECT source_type, format
  INTO dataset_source_type, dataset_format
  FROM app.datasets
  WHERE organization_id = NEW.organization_id AND id = NEW.dataset_id;

  IF dataset_source_type IS NULL
    OR dataset_source_type <> NEW.source_type
    OR dataset_format::text <> NEW.source_type::text
  THEN
    RAISE EXCEPTION 'external source identity must match an XYZ or WMS dataset';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION app.reject_external_source_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'external source identities and revisions are append-only';
END;
$$;

CREATE TRIGGER external_sources_match_dataset
  BEFORE INSERT ON app.external_sources
  FOR EACH ROW EXECUTE FUNCTION app.enforce_external_source_dataset();
CREATE TRIGGER external_sources_are_immutable
  BEFORE UPDATE OR DELETE ON app.external_sources
  FOR EACH ROW EXECUTE FUNCTION app.reject_external_source_mutation();
CREATE TRIGGER external_source_revisions_are_immutable
  BEFORE UPDATE OR DELETE ON app.external_source_revisions
  FOR EACH ROW EXECUTE FUNCTION app.reject_external_source_mutation();

ALTER TABLE app.external_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.external_source_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.external_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE app.external_source_revisions FORCE ROW LEVEL SECURITY;

CREATE POLICY external_sources_tenant_isolation ON app.external_sources
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());
CREATE POLICY external_source_revisions_tenant_isolation ON app.external_source_revisions
  USING (organization_id = app.current_organization_id())
  WITH CHECK (organization_id = app.current_organization_id());

GRANT SELECT, INSERT ON
  app.external_sources,
  app.external_source_revisions
TO opengeo_runtime;

REVOKE ALL ON
  app.external_sources,
  app.external_source_revisions
FROM opengeo_worker;

REVOKE EXECUTE ON FUNCTION
  app.enforce_external_source_dataset(),
  app.reject_external_source_mutation()
FROM PUBLIC, opengeo_runtime, opengeo_worker;

COMMENT ON TABLE app.external_sources IS
  'Tenant-scoped identity for an anonymous, browser-direct XYZ or WMS catalog reference.';
COMMENT ON TABLE app.external_source_revisions IS
  'Append-only validated source definitions; syntax_only explicitly means OpenGeo did not fetch the URL.';

COMMIT;
