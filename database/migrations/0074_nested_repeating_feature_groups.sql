BEGIN;

-- Schema 1.2 keeps feature properties in the existing bounded JSON object while
-- allowing the API to validate nested objects and ordered repeated records. The
-- detailed depth, field-count, and repeat limits remain enforced by the API;
-- these constraints prevent unsupported schema versions or missing structure
-- from entering either the authoritative collection or an immutable form copy.
ALTER TABLE app.feature_collections
  DROP CONSTRAINT feature_collections_schema_object,
  ADD CONSTRAINT feature_collections_schema_object CHECK (
    (jsonb_typeof(schema_definition) = 'object') IS TRUE
    AND ((schema_definition->>'schemaVersion') IN ('1.0.0', '1.1.0', '1.2.0')) IS TRUE
    AND (jsonb_typeof(schema_definition->'fields') = 'array') IS TRUE
    AND (jsonb_array_length(schema_definition->'fields') <= 64) IS TRUE
  );

ALTER TABLE app.field_form_versions
  DROP CONSTRAINT field_form_versions_schema_object,
  ADD CONSTRAINT field_form_versions_schema_object CHECK (
    (jsonb_typeof(schema_definition) = 'object') IS TRUE
    AND ((schema_definition->>'schemaVersion') IN ('1.0.0', '1.1.0', '1.2.0')) IS TRUE
    AND (jsonb_typeof(schema_definition->'fields') = 'array') IS TRUE
    AND (jsonb_array_length(schema_definition->'fields') <= 64) IS TRUE
  );

COMMENT ON CONSTRAINT feature_collections_schema_object
  ON app.feature_collections IS
  'Accepts scalar schema 1.0, conditional schema 1.1, or bounded nested/repeating schema 1.2.';
COMMENT ON CONSTRAINT field_form_versions_schema_object
  ON app.field_form_versions IS
  'Accepts immutable form snapshots for scalar 1.0, conditional 1.1, or nested/repeating 1.2 schemas.';

COMMIT;
