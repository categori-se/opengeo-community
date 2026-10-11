BEGIN;

-- Schema 1.4 adds bounded numeric calculations to immutable field definitions.
-- Keep prior immutable schemas valid; API validation owns detailed field rules.
ALTER TABLE app.feature_collections
  DROP CONSTRAINT feature_collections_schema_object,
  ADD CONSTRAINT feature_collections_schema_object CHECK (
    (jsonb_typeof(schema_definition) = 'object') IS TRUE
    AND ((schema_definition->>'schemaVersion') IN ('1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0')) IS TRUE
    AND (jsonb_typeof(schema_definition->'fields') = 'array') IS TRUE
    AND (jsonb_array_length(schema_definition->'fields') <= 64) IS TRUE
  );

ALTER TABLE app.field_form_versions
  DROP CONSTRAINT field_form_versions_schema_object,
  ADD CONSTRAINT field_form_versions_schema_object CHECK (
    (jsonb_typeof(schema_definition) = 'object') IS TRUE
    AND ((schema_definition->>'schemaVersion') IN ('1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0')) IS TRUE
    AND (jsonb_typeof(schema_definition->'fields') = 'array') IS TRUE
    AND (jsonb_array_length(schema_definition->'fields') <= 64) IS TRUE
  );

COMMENT ON CONSTRAINT feature_collections_schema_object
  ON app.feature_collections IS
  'Accepts scalar schema 1.0, conditional schema 1.1, bounded nested/repeating schema 1.2, or typed comparison schema 1.3, or calculated schema 1.4.';
COMMENT ON CONSTRAINT field_form_versions_schema_object
  ON app.field_form_versions IS
  'Accepts immutable form snapshots for scalar 1.0, conditional 1.1, nested/repeating 1.2, or typed comparison 1.3, or calculated 1.4 schemas.';

COMMIT;
