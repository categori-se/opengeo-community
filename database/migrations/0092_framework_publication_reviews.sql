BEGIN;

-- Operator-verified delivery grants. These are not inferred from a source
-- repository connection or an account's ability to edit a project.
CREATE TABLE app.framework_publication_origins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  hostname text NOT NULL UNIQUE CHECK (hostname ~ '^[a-z0-9][a-z0-9.-]{1,251}[a-z0-9]$'),
  bucket text NOT NULL,
  distribution_id text NOT NULL CHECK (distribution_id ~ '^[A-Z0-9]{1,32}$'),
  origin_id text NOT NULL,
  active_release_prefix text NOT NULL CHECK (active_release_prefix ~ '^releases/[A-Za-z0-9_-]+$'),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  enabled boolean NOT NULL DEFAULT false,
  verified_by uuid NOT NULL REFERENCES app.users(id),
  verified_at timestamptz NOT NULL,
  UNIQUE (organization_id, id)
);

CREATE TABLE app.framework_publication_mounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  source_project_id uuid NOT NULL,
  origin_id uuid NOT NULL,
  mount_path text NOT NULL CHECK (mount_path = '/' OR mount_path ~ '^/[a-z0-9][a-z0-9-]{0,79}(/[a-z0-9][a-z0-9-]{0,79}){0,7}/$'),
  enabled boolean NOT NULL DEFAULT false,
  verified_by uuid NOT NULL REFERENCES app.users(id),
  verified_at timestamptz NOT NULL,
  UNIQUE (origin_id, mount_path),
  UNIQUE (organization_id, project_id, source_project_id, id),
  FOREIGN KEY (organization_id, origin_id) REFERENCES app.framework_publication_origins(organization_id, id),
  FOREIGN KEY (organization_id, project_id, source_project_id)
    REFERENCES app.observable_source_projects(organization_id, project_id, id)
);

CREATE TABLE app.framework_publication_reviews (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES app.organizations(id),
  project_id uuid NOT NULL,
  source_project_id uuid NOT NULL,
  build_job_id uuid NOT NULL,
  mount_id uuid NOT NULL,
  result_checksum_sha256 text NOT NULL CHECK (result_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  output_tree_checksum_sha256 text NOT NULL CHECK (output_tree_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  expected_generation bigint NOT NULL CHECK (expected_generation > 0),
  previous_release_prefix text NOT NULL,
  hostname text NOT NULL,
  mount_path text NOT NULL,
  reviewed_by uuid NOT NULL REFERENCES app.users(id),
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '24 hours',
  UNIQUE (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id, source_project_id, mount_id)
    REFERENCES app.framework_publication_mounts(organization_id, project_id, source_project_id, id),
  FOREIGN KEY (organization_id, project_id, build_job_id)
    REFERENCES app.observable_build_jobs(organization_id, project_id, id)
);

CREATE FUNCTION app.guard_framework_publication_origin()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.organization_id, NEW.hostname, NEW.bucket, NEW.distribution_id, NEW.origin_id)
    IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.hostname, OLD.bucket, OLD.distribution_id, OLD.origin_id)
  THEN RAISE EXCEPTION 'Publication delivery identity is immutable'; END IF;
  IF NEW.generation < OLD.generation OR (
    ROW(NEW.active_release_prefix, NEW.enabled) IS DISTINCT FROM ROW(OLD.active_release_prefix, OLD.enabled)
    AND NEW.generation <= OLD.generation
  ) THEN RAISE EXCEPTION 'Publication changes must advance generation'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER framework_publication_origin_identity BEFORE UPDATE ON app.framework_publication_origins
  FOR EACH ROW EXECUTE FUNCTION app.guard_framework_publication_origin();

CREATE FUNCTION app.guard_framework_publication_mount()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Publication paths remain reserved'; END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW.id, NEW.organization_id, NEW.project_id, NEW.source_project_id, NEW.origin_id, NEW.mount_path)
    IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.project_id, OLD.source_project_id, OLD.origin_id, OLD.mount_path)
  THEN RAISE EXCEPTION 'Publication mount identity is immutable'; END IF;
  -- Adding or disabling a sibling changes the composition boundary. Invalidate
  -- any outstanding reviews, including those belonging to the root project.
  UPDATE app.framework_publication_origins SET generation = generation + 1 WHERE id = NEW.origin_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER framework_publication_mount_identity BEFORE INSERT OR UPDATE OR DELETE ON app.framework_publication_mounts
  FOR EACH ROW EXECUTE FUNCTION app.guard_framework_publication_mount();

CREATE TABLE app.framework_publication_approvals (
  review_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  approved_by uuid NOT NULL REFERENCES app.users(id),
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  preview_capability_id uuid NOT NULL REFERENCES app.observable_preview_capabilities(id),
  acknowledgment text NOT NULL CHECK (acknowledgment = 'publish-exact-previewed-output'),
  FOREIGN KEY (organization_id, project_id, review_id)
    REFERENCES app.framework_publication_reviews(organization_id, project_id, id)
);

CREATE TRIGGER framework_publication_reviews_immutable BEFORE UPDATE OR DELETE ON app.framework_publication_reviews
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();
CREATE TRIGGER framework_publication_approvals_immutable BEFORE UPDATE OR DELETE ON app.framework_publication_approvals
  FOR EACH ROW EXECUTE FUNCTION app.reject_governed_resource_history_mutation();

ALTER TABLE app.framework_publication_origins ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.framework_publication_origins FORCE ROW LEVEL SECURITY;
ALTER TABLE app.framework_publication_mounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.framework_publication_mounts FORCE ROW LEVEL SECURITY;
ALTER TABLE app.framework_publication_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.framework_publication_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE app.framework_publication_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.framework_publication_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY framework_publication_origins_tenant ON app.framework_publication_origins USING (organization_id = app.current_organization_id());
CREATE POLICY framework_publication_mounts_tenant ON app.framework_publication_mounts USING (organization_id = app.current_organization_id());
CREATE POLICY framework_publication_reviews_tenant ON app.framework_publication_reviews USING (organization_id = app.current_organization_id());
CREATE POLICY framework_publication_approvals_tenant ON app.framework_publication_approvals USING (organization_id = app.current_organization_id());
GRANT SELECT ON app.framework_publication_origins, app.framework_publication_mounts,
  app.framework_publication_reviews, app.framework_publication_approvals TO opengeo_runtime;
REVOKE ALL ON app.framework_publication_origins, app.framework_publication_mounts,
  app.framework_publication_reviews, app.framework_publication_approvals
  FROM PUBLIC, opengeo_worker, opengeo_connector, opengeo_observable_coordinator;

CREATE FUNCTION app.require_framework_publication_authority(p_org uuid, p_project uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app SET row_security = off AS $$
BEGIN
  IF p_org IS DISTINCT FROM app.current_organization_id() OR NOT EXISTS (
    SELECT 1 FROM app.organization_memberships member
    JOIN app.organizations organization ON organization.id = member.organization_id AND organization.status = 'active'
    JOIN app.projects project ON project.organization_id = organization.id AND project.id = p_project AND project.status = 'active'
    WHERE member.organization_id = p_org AND member.user_id = app.current_user_id()
      AND (member.role = 'admin' OR app.effective_project_role(project.id, member.user_id)::text IN ('owner', 'reviewer'))
  ) THEN RAISE EXCEPTION 'Framework publication authority required' USING ERRCODE = '42501'; END IF;
END;
$$;

CREATE FUNCTION app.review_framework_publication(p_id uuid, p_project uuid, p_build uuid, p_mount uuid, p_checksum text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE
  job app.observable_build_jobs%ROWTYPE;
  mount app.framework_publication_mounts%ROWTYPE;
  origin app.framework_publication_origins%ROWTYPE;
  prior app.framework_publication_reviews%ROWTYPE;
BEGIN
  PERFORM app.require_framework_publication_authority(app.current_organization_id(), p_project);
  PERFORM pg_advisory_xact_lock(hashtextextended('framework-review:' || p_id::text, 0));
  SELECT * INTO prior FROM app.framework_publication_reviews WHERE id = p_id;
  IF FOUND THEN
    IF prior.organization_id IS DISTINCT FROM app.current_organization_id() OR prior.project_id IS DISTINCT FROM p_project
      OR prior.build_job_id IS DISTINCT FROM p_build OR prior.mount_id IS DISTINCT FROM p_mount
      OR prior.result_checksum_sha256 IS DISTINCT FROM p_checksum OR prior.reviewed_by IS DISTINCT FROM app.current_user_id()
    THEN RAISE EXCEPTION 'Framework review request identity conflict' USING ERRCODE = '23514'; END IF;
    RETURN prior.id;
  END IF;
  SELECT * INTO job FROM app.observable_build_jobs WHERE id = p_build
    AND organization_id = app.current_organization_id() AND project_id = p_project;
  IF NOT FOUND OR job.state <> 'succeeded' OR job.result IS NULL OR job.result_checksum_sha256 IS DISTINCT FROM p_checksum
  THEN RAISE EXCEPTION 'Exact successful Framework output required' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.observable_source_revisions WHERE id = job.source_revision_id AND rights_status = 'approved')
  THEN RAISE EXCEPTION 'Source revision rights approval required' USING ERRCODE = '23514'; END IF;
  SELECT * INTO mount FROM app.framework_publication_mounts WHERE id = p_mount AND enabled
    AND organization_id = job.organization_id AND project_id = job.project_id AND source_project_id = job.source_project_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Publication destination unavailable' USING ERRCODE = '23514'; END IF;
  SELECT * INTO origin FROM app.framework_publication_origins WHERE id = mount.origin_id AND enabled FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Publication origin unavailable' USING ERRCODE = '23514'; END IF;
  INSERT INTO app.framework_publication_reviews
    (id, organization_id, project_id, source_project_id, build_job_id, mount_id, result_checksum_sha256,
     output_tree_checksum_sha256, expected_generation, previous_release_prefix, hostname, mount_path, reviewed_by)
  VALUES (p_id, job.organization_id, job.project_id, job.source_project_id, job.id, mount.id, job.result_checksum_sha256,
    job.result->>'outputTreeChecksumSha256', origin.generation, origin.active_release_prefix, origin.hostname, mount.mount_path, app.current_user_id());
  RETURN p_id;
END;
$$;

CREATE FUNCTION app.approve_framework_publication(p_review uuid, p_project uuid, p_acknowledgment text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app SET row_security = off AS $$
DECLARE
  review app.framework_publication_reviews%ROWTYPE;
  origin app.framework_publication_origins%ROWTYPE;
  mount app.framework_publication_mounts%ROWTYPE;
  preview uuid;
BEGIN
  PERFORM app.require_framework_publication_authority(app.current_organization_id(), p_project);
  IF p_acknowledgment IS DISTINCT FROM 'publish-exact-previewed-output'
  THEN RAISE EXCEPTION 'Explicit publication acknowledgment required' USING ERRCODE = '23514'; END IF;
  SELECT * INTO review FROM app.framework_publication_reviews WHERE id = p_review
    AND organization_id = app.current_organization_id() AND project_id = p_project FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Publication review unavailable' USING ERRCODE = '23514'; END IF;
  IF EXISTS (SELECT 1 FROM app.framework_publication_approvals WHERE review_id = p_review AND approved_by = app.current_user_id())
  THEN RETURN p_review; END IF;
  IF review.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'Publication review expired' USING ERRCODE = '23514'; END IF;
  SELECT * INTO mount FROM app.framework_publication_mounts WHERE id = review.mount_id AND enabled;
  IF NOT FOUND OR mount.mount_path <> review.mount_path THEN RAISE EXCEPTION 'Publication destination changed' USING ERRCODE = '23514'; END IF;
  SELECT * INTO origin FROM app.framework_publication_origins WHERE id = mount.origin_id AND enabled FOR SHARE;
  IF NOT FOUND OR origin.generation <> review.expected_generation OR origin.active_release_prefix <> review.previous_release_prefix
    OR origin.hostname <> review.hostname
  THEN RAISE EXCEPTION 'Public release changed; prepare a new review' USING ERRCODE = '23514'; END IF;
  SELECT id INTO preview FROM app.observable_preview_capabilities
    WHERE organization_id = review.organization_id AND project_id = review.project_id AND build_job_id = review.build_job_id
      AND requested_by = app.current_user_id() AND consumed_at > clock_timestamp() - interval '24 hours'
    ORDER BY consumed_at DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Open the exact private preview before approving publication' USING ERRCODE = '23514'; END IF;
  INSERT INTO app.framework_publication_approvals
    (review_id, organization_id, project_id, approved_by, preview_capability_id, acknowledgment)
  VALUES (review.id, review.organization_id, review.project_id, app.current_user_id(), preview, p_acknowledgment);
  RETURN p_review;
END;
$$;

REVOKE ALL ON FUNCTION app.require_framework_publication_authority(uuid, uuid),
  app.guard_framework_publication_origin(), app.guard_framework_publication_mount(),
  app.review_framework_publication(uuid, uuid, uuid, uuid, text),
  app.approve_framework_publication(uuid, uuid, text)
FROM PUBLIC, opengeo_worker, opengeo_connector, opengeo_observable_coordinator;
GRANT EXECUTE ON FUNCTION app.review_framework_publication(uuid, uuid, uuid, uuid, text),
  app.approve_framework_publication(uuid, uuid, text) TO opengeo_runtime;
COMMIT;
