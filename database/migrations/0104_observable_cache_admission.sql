BEGIN;

-- Operator-managed entitlement, absent by default. Each slot is one exact
-- tenant/project/source/compiler key, never a browser-provided storage prefix.
CREATE TABLE app.observable_cache_entitlements (
  organization_id uuid PRIMARY KEY REFERENCES app.organizations(id),
  enabled boolean NOT NULL DEFAULT false,
  max_entries integer NOT NULL CHECK (max_entries BETWEEN 1 AND 1000)
);
CREATE TABLE app.observable_cache_admissions (
  organization_id uuid NOT NULL REFERENCES app.observable_cache_entitlements(organization_id),
  project_id uuid NOT NULL,
  source_project_id uuid NOT NULL,
  compiler_image_digest text NOT NULL CHECK (compiler_image_digest ~ '^sha256:[0-9a-f]{64}$'),
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, project_id, source_project_id, compiler_image_digest),
  FOREIGN KEY (organization_id, project_id, source_project_id)
    REFERENCES app.observable_source_projects(organization_id, project_id, id)
);
ALTER TABLE app.observable_cache_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.observable_cache_admissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.observable_cache_entitlements, app.observable_cache_admissions
FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_connector,
  opengeo_observable_coordinator, opengeo_framework_publisher;

CREATE FUNCTION app.admit_observable_page_cache(p_job uuid, p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE
  job app.observable_build_jobs%ROWTYPE;
  entitlement app.observable_cache_entitlements%ROWTYPE;
  compiler text;
BEGIN
  -- Lock the existing job before the account quota, consistent with build
  -- completion. No caller can supply a tenant, source, image or destination.
  SELECT * INTO job FROM app.observable_build_jobs WHERE id = p_job FOR SHARE;
  IF NOT FOUND OR p_token IS NULL OR job.coordinator_token IS DISTINCT FROM p_token
    OR job.state <> 'running' OR job.lease_expires_at <= clock_timestamp()
  THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.projects p
    JOIN app.organizations o ON o.id = p.organization_id AND o.status = 'active'
    WHERE p.id = job.project_id AND p.organization_id = job.organization_id AND p.status = 'active')
  THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.observable_source_revisions r
    WHERE r.id = job.source_revision_id AND r.organization_id = job.organization_id
      AND r.project_id = job.project_id AND r.source_project_id = job.source_project_id
      AND r.entry_path ~* '\.md$')
  THEN RETURN NULL; END IF;
  compiler := job.request->>'compilerImageDigest';
  IF compiler IS NULL OR compiler !~ '^sha256:[0-9a-f]{64}$'
    OR job.request->>'frameworkVersion' IS DISTINCT FROM '1.13.4'
  THEN RETURN NULL; END IF;
  SELECT * INTO entitlement FROM app.observable_cache_entitlements
    WHERE organization_id = job.organization_id AND enabled FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.observable_cache_admissions
    WHERE organization_id = job.organization_id AND project_id = job.project_id
      AND source_project_id = job.source_project_id AND compiler_image_digest = compiler)
  THEN
    IF (SELECT count(*) FROM app.observable_cache_admissions
      WHERE organization_id = job.organization_id) >= entitlement.max_entries
    THEN RETURN NULL; END IF;
    INSERT INTO app.observable_cache_admissions
      (organization_id, project_id, source_project_id, compiler_image_digest)
    VALUES (job.organization_id, job.project_id, job.source_project_id, compiler);
  END IF;
  -- Slots are not recycled on time alone: retained S3 versions must be removed
  -- by reviewed lifecycle policy before storage capacity can be reclaimed.
  RETURN jsonb_build_object(
    'organizationId', job.organization_id, 'projectId', job.project_id,
    'sourceProjectId', job.source_project_id, 'compilerImageDigest', compiler,
    'frameworkVersion', '1.13.4', 'buildJobId', job.id,
    'sourceRevisionId', job.source_revision_id,
    'maxBytes', 33554432, 'maxAgeSeconds', 604800);
END;
$$;
REVOKE ALL ON FUNCTION app.admit_observable_page_cache(uuid, uuid)
FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_connector, opengeo_framework_publisher;
GRANT EXECUTE ON FUNCTION app.admit_observable_page_cache(uuid, uuid)
TO opengeo_observable_coordinator;

COMMIT;
