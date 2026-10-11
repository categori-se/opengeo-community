BEGIN;

CREATE FUNCTION app.resolve_user_dataset_repository_target(
  p_organization_id uuid,
  p_owner_user_id uuid,
  p_connection_id uuid
)
RETURNS TABLE (
  organization_id uuid,
  owner_user_id uuid,
  connection_id uuid,
  target_revision bigint,
  credential_revision bigint,
  bucket_name text,
  region_name text,
  object_prefix text,
  credential_mode text,
  role_arn text,
  secret_arn text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
  SELECT connection.organization_id,
         connection.owner_user_id,
         connection.id,
         connection.target_revision,
         connection.credential_revision,
         connection.bucket_name,
         connection.region_name,
         connection.object_prefix,
         connection.credential_mode::text,
         connection.role_arn,
         connection.secret_arn
  FROM app.user_dataset_connections connection
  WHERE p_organization_id IS NOT NULL
    AND p_owner_user_id IS NOT NULL
    AND p_connection_id IS NOT NULL
    AND connection.organization_id = p_organization_id
    AND connection.owner_user_id = p_owner_user_id
    AND connection.id = p_connection_id
    AND connection.provider = 's3'
    AND connection.status = 'verified'
    AND connection.last_verified_at IS NOT NULL
    AND (
      connection.credential_mode = 'workload_identity'
      OR (
        connection.credential_revision > 0
        AND connection.secret_arn IS NOT NULL
      )
    );
$$;

REVOKE EXECUTE ON FUNCTION
  app.resolve_user_dataset_repository_target(uuid, uuid, uuid)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  app.resolve_user_dataset_repository_target(uuid, uuid, uuid)
TO opengeo_dataset_verifier;

COMMENT ON FUNCTION
  app.resolve_user_dataset_repository_target(uuid, uuid, uuid)
IS 'Returns one current verified caller-owned S3 target to the isolated metadata browser; unavailable targets return no row.';

COMMIT;
