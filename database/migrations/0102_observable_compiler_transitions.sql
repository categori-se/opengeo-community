-- Compiler servicing is separate from the immutable authored source revision.
-- No source is upgraded by applying this migration. The migration owner alone
-- may record a reviewed exact-image transition through the function below.
CREATE TABLE app.observable_compiler_transitions (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  source_project_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  previous_digest text NOT NULL CHECK (previous_digest ~ '^sha256:[0-9a-f]{64}$'),
  compiler_digest text NOT NULL CHECK (compiler_digest ~ '^sha256:[0-9a-f]{64}$'),
  approval_reference text NOT NULL CHECK (char_length(approval_reference) BETWEEN 1 AND 512),
  recorded_by name NOT NULL DEFAULT current_user,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, source_project_id, sequence),
  FOREIGN KEY (organization_id, project_id, source_project_id)
    REFERENCES app.observable_source_projects(organization_id, project_id, id),
  CHECK (previous_digest <> compiler_digest)
);

ALTER TABLE app.observable_compiler_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.observable_compiler_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY observable_compiler_transitions_tenant ON app.observable_compiler_transitions
  FOR SELECT USING (organization_id = app.current_organization_id());
REVOKE ALL ON app.observable_compiler_transitions FROM PUBLIC, opengeo_runtime,
  opengeo_worker, opengeo_connector, opengeo_observable_coordinator, opengeo_framework_publisher;
GRANT SELECT ON app.observable_compiler_transitions TO opengeo_runtime;

CREATE FUNCTION app.observable_effective_compiler_digest(p_organization uuid, p_source uuid)
RETURNS text LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, app AS $$
  SELECT coalesce((SELECT transition.compiler_digest FROM app.observable_compiler_transitions transition
    WHERE transition.organization_id = source.organization_id AND transition.source_project_id = source.id
    ORDER BY transition.sequence DESC LIMIT 1), source.compiler_image_digest)
  FROM app.observable_source_projects source
  WHERE source.organization_id = p_organization AND source.id = p_source
$$;
REVOKE ALL ON FUNCTION app.observable_effective_compiler_digest(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.observable_effective_compiler_digest(uuid, uuid) TO opengeo_runtime;

CREATE FUNCTION app.record_observable_compiler_transition(
  p_organization uuid, p_project uuid, p_source uuid,
  p_expected_digest text, p_compiler_digest text, p_approval_reference text
) RETURNS bigint LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, app AS $$
DECLARE current_digest text; next_sequence bigint;
BEGIN
  -- Serializes with source saves and API build creation; never edits that row.
  PERFORM 1 FROM app.observable_source_projects
    WHERE organization_id = p_organization AND project_id = p_project AND id = p_source FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Compiler transition source not found' USING ERRCODE = '23514'; END IF;
  current_digest := app.observable_effective_compiler_digest(p_organization, p_source);
  IF current_digest IS DISTINCT FROM p_expected_digest THEN
    RAISE EXCEPTION 'Compiler transition baseline changed' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(max(sequence), 0) + 1 INTO next_sequence FROM app.observable_compiler_transitions
    WHERE organization_id = p_organization AND source_project_id = p_source;
  INSERT INTO app.observable_compiler_transitions
    (organization_id, project_id, source_project_id, sequence, previous_digest, compiler_digest, approval_reference)
    VALUES (p_organization, p_project, p_source, next_sequence, current_digest, p_compiler_digest, p_approval_reference);
  RETURN next_sequence;
END;
$$;
REVOKE ALL ON FUNCTION app.record_observable_compiler_transition(uuid, uuid, uuid, text, text, text)
  FROM PUBLIC, opengeo_runtime, opengeo_worker, opengeo_connector,
  opengeo_observable_coordinator, opengeo_framework_publisher;

CREATE FUNCTION app.reject_observable_compiler_transition_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Compiler transition history is append-only' USING ERRCODE = '23514'; END;
$$;
REVOKE ALL ON FUNCTION app.reject_observable_compiler_transition_change() FROM PUBLIC;
CREATE TRIGGER observable_compiler_transition_immutable BEFORE UPDATE OR DELETE
  ON app.observable_compiler_transitions FOR EACH ROW
  EXECUTE FUNCTION app.reject_observable_compiler_transition_change();

-- Preserve every existing job check, including source rights, resource bounds,
-- exact input identity and checksums. Only the effective compiler lookup changes.
DO $$
DECLARE definition text; old_expression text := '''compilerImageDigest'', v_project.compiler_image_digest,';
BEGIN
  definition := pg_get_functiondef('app.enforce_observable_build_job_insert()'::regprocedure);
  IF (length(definition) - length(replace(definition, old_expression, ''))) / length(old_expression) <> 1 THEN
    RAISE EXCEPTION 'Unexpected Observable build compiler validation';
  END IF;
  EXECUTE replace(definition, old_expression,
    '''compilerImageDigest'', app.observable_effective_compiler_digest(NEW.organization_id, NEW.source_project_id),');
END;
$$;
