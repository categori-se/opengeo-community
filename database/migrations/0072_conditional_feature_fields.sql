BEGIN;

-- Release 0072 aligns the stored immutable feature-schema version with the API.
-- Version 1.1 adds typed earlier-field equality visibility. The replacement
-- constraints also make missing structural keys fail rather than pass through
-- PostgreSQL's NULL check semantics; detailed field validation remains in the API.
ALTER TABLE app.feature_collections
  DROP CONSTRAINT feature_collections_schema_object,
  ADD CONSTRAINT feature_collections_schema_object CHECK (
    (jsonb_typeof(schema_definition) = 'object') IS TRUE
    AND ((schema_definition->>'schemaVersion') IN ('1.0.0', '1.1.0')) IS TRUE
    AND (jsonb_typeof(schema_definition->'fields') = 'array') IS TRUE
    AND (jsonb_array_length(schema_definition->'fields') <= 64) IS TRUE
  );

ALTER TABLE app.field_form_versions
  DROP CONSTRAINT field_form_versions_schema_object,
  ADD CONSTRAINT field_form_versions_schema_object CHECK (
    (jsonb_typeof(schema_definition) = 'object') IS TRUE
    AND ((schema_definition->>'schemaVersion') IN ('1.0.0', '1.1.0')) IS TRUE
    AND (jsonb_typeof(schema_definition->'fields') = 'array') IS TRUE
    AND (jsonb_array_length(schema_definition->'fields') <= 64) IS TRUE
  );

COMMENT ON CONSTRAINT feature_collections_schema_object
  ON app.feature_collections IS
  'Accepts immutable scalar schema 1.0 or typed earlier-field visibility schema 1.1.';
COMMENT ON CONSTRAINT field_form_versions_schema_object
  ON app.field_form_versions IS
  'Accepts immutable form snapshots for scalar schema 1.0 or conditional schema 1.1.';

COMMIT;
