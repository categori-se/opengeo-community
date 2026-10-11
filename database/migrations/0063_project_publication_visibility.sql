BEGIN;

-- A project remains an internal authoring and collaboration scope even when a
-- reviewed presentation is publicly visible. This field records that intended
-- audience in the project directory; public delivery still requires a sealed
-- site edition or another reviewed publication artifact.

CREATE TYPE app.project_visibility AS ENUM ('internal', 'published');

ALTER TABLE app.projects
  ADD COLUMN visibility app.project_visibility NOT NULL DEFAULT 'internal',
  ADD COLUMN published_at timestamptz,
  ADD COLUMN published_by uuid REFERENCES app.users(id),
  ADD CONSTRAINT projects_publication_state_consistent CHECK (
    (visibility = 'internal' AND published_at IS NULL AND published_by IS NULL)
    OR
    (visibility = 'published' AND published_at IS NOT NULL AND published_by IS NOT NULL)
  );

CREATE INDEX projects_organization_visibility_idx
  ON app.projects (organization_id, visibility, updated_at DESC);

COMMENT ON COLUMN app.projects.visibility IS
  'Directory-level publication intent. Authoring access remains role-scoped; public delivery requires a reviewed immutable publication artifact.';
COMMENT ON COLUMN app.projects.published_at IS
  'Time at which a project owner last marked the project published.';
COMMENT ON COLUMN app.projects.published_by IS
  'Verified OpenGeo user who last marked the project published.';

COMMIT;
