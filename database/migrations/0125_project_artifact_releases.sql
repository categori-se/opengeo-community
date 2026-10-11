BEGIN;
CREATE TABLE app.project_artifact_releases (
 organization_id uuid NOT NULL,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 artifact_id uuid NOT NULL,
 version_number integer NOT NULL,
 title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
 license text NOT NULL CHECK (license IN ('CC0-1.0','CC-BY-4.0','PDDL-1.0')),
 attribution text NOT NULL CHECK (char_length(attribution) BETWEEN 1 AND 2000),
 created_by uuid NOT NULL REFERENCES app.users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revoked_by uuid REFERENCES app.users(id),
 revoked_at timestamptz,
 PRIMARY KEY (organization_id,id),
 FOREIGN KEY (organization_id,artifact_id,version_number)
   REFERENCES app.project_artifact_versions(organization_id,artifact_id,version_number),
 CHECK ((revoked_by IS NULL) = (revoked_at IS NULL))
);
CREATE FUNCTION app.guard_project_artifact_release() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'release history is immutable'; END IF;
 IF (to_jsonb(NEW)-'revoked_by'-'revoked_at') IS DISTINCT FROM
    (to_jsonb(OLD)-'revoked_by'-'revoked_at') OR OLD.revoked_at IS NOT NULL
    OR NEW.revoked_at IS NULL THEN
   RAISE EXCEPTION 'only release revocation is allowed';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER artifact_release_history BEFORE UPDATE OR DELETE ON app.project_artifact_releases
 FOR EACH ROW EXECUTE FUNCTION app.guard_project_artifact_release();
ALTER TABLE app.project_artifact_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.project_artifact_releases FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_release_tenant ON app.project_artifact_releases
 USING (organization_id=app.current_organization_id())
 WITH CHECK (organization_id=app.current_organization_id());
GRANT SELECT,INSERT ON app.project_artifact_releases TO opengeo_runtime;
GRANT UPDATE(revoked_by,revoked_at) ON app.project_artifact_releases TO opengeo_runtime;
REVOKE ALL ON app.project_artifact_releases FROM opengeo_worker;
COMMIT;
