BEGIN;
-- Metadata inventory only: exact stored identities/edges/history/object facts.
-- Source/feature/provider bodies and object bytes are not a complete backup.
CREATE FUNCTION app.capture_account_recovery_inventory() RETURNS TABLE (
  snapshot_id text, organization_id uuid, total_bytes integer,
  checksum_sha256 text, chunk_index integer, body bytea
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $recovery$
DECLARE
  v_account uuid := app.current_organization_id();
  v_actor uuid := app.current_user_id();
  v_projections constant jsonb := '{
    "activity_events": ["actor_user_id", "id", "occurred_at", "organization_id", "project_id", "resource_id"],
    "archive_manifest_records": ["bucket", "destination_id", "first_ordinal", "object_key", "object_prefix", "organization_id", "project_id", "session_id"],
    "archive_upload_destinations": ["bucket", "enabled", "id", "object_prefix", "organization_id", "project_id", "region", "title"],
    "archive_upload_files": ["destination_id", "modified_milliseconds", "ordinal", "organization_id", "project_id", "relative_path", "session_id", "sha256", "size_bytes"],
    "archive_upload_objects": ["bucket", "object_key", "object_prefix", "ordinal", "organization_id", "project_id", "region", "session_id", "state"],
    "archive_upload_parts": ["ordinal", "organization_id", "part_number", "session_id", "sha256", "size_bytes"],
    "archive_upload_sessions": ["created_at", "created_by", "expires_at", "file_count", "id", "logical_bytes", "organization_id", "project_id", "sealed_at", "state", "upload_bytes"],
    "authored_resource_knowledge_revisions": ["collection_id", "created_at", "created_by", "kind", "map_id", "organization_id", "resource_id", "site_id", "version_number"],
    "client_memberships": ["client_id", "created_at", "organization_id", "role", "updated_at", "user_id"],
    "clients": ["created_at", "created_by", "id", "logo_object_id", "name", "organization_id", "status", "updated_at"],
    "data_objects": ["bucket", "checksum_sha256", "content_type", "created_at", "created_by", "dataset_id", "etag", "id", "object_key", "organization_id", "role", "s3_version_id", "size_bytes"],
    "dataset_feature_locks": ["acquired_at", "dataset_id", "expires_at", "feature_id", "feature_version", "locked_by", "organization_id"],
    "dataset_feature_revisions": ["change_message", "changed_by", "created_at", "dataset_id", "feature_id", "geometry_type", "id", "operation", "organization_id", "version_number"],
    "dataset_features": ["created_at", "created_by", "dataset_id", "deleted_at", "deleted_by", "geometry_type", "id", "organization_id", "updated_at", "updated_by", "version_number"],
    "dataset_knowledge_revisions": ["created_at", "created_by", "dataset_id", "organization_id", "version_number"],
    "dataset_permissions": ["created_at", "dataset_id", "granted_by", "organization_id", "role", "updated_at", "user_id"],
    "dataset_refresh_acceptances": ["accepted_at", "accepted_by", "dataset_id", "evidence_sha256", "id", "organization_id", "review_id"],
    "dataset_refresh_reviews": ["base_version_id", "candidate_version_id", "created_at", "created_by", "dataset_id", "evidence_sha256", "id", "organization_id", "source_revision"],
    "dataset_source_discoveries": ["created_at", "created_by", "dataset_id", "discovery_job_id", "organization_id", "source_type"],
    "dataset_tags": ["dataset_id", "organization_id", "tag_id", "tagged_at", "tagged_by"],
    "dataset_version_derivative_lineage": ["created_at", "dataset_id", "dataset_version_id", "organization_id", "output_object_id", "pmtiles_job_id", "source_object_id"],
    "dataset_version_external_source_lineage": ["destination_dataset_id", "destination_dataset_version_id", "organization_id", "retrieved_at", "snapshot_job_id", "source_dataset_id", "source_revision_number"],
    "dataset_version_objects": ["data_object_id", "dataset_id", "dataset_version_id", "organization_id"],
    "dataset_version_repository_object_lineage": ["copy_job_id", "destination_dataset_id", "destination_dataset_version_id", "organization_id", "retrieved_at", "source_dataset_id"],
    "dataset_versions": ["change_message", "created_at", "created_by", "dataset_id", "feature_count", "id", "organization_id", "original_object_id", "parent_version_id", "state", "updated_at", "version_number"],
    "datasets": ["classification", "created_at", "created_by", "current_version_id", "format", "id", "name", "organization_id", "owner_user_id", "source_type", "status", "updated_at", "updated_by"],
    "external_connection_revisions": ["change_summary", "connection_id", "created_at", "created_by", "id", "organization_id", "project_id", "revision_number"],
    "external_connection_verifications": ["attempt_count", "connection_id", "connection_revision_number", "created_at", "credentials_verified", "duration_ms", "finished_at", "id", "lease_expires_at", "network_reachable", "organization_id", "postgis_verified", "project_id", "requested_by", "started_at", "state", "tls_verified"],
    "external_connections": ["created_at", "created_by", "current_revision_number", "display_name", "endpoint_port", "id", "last_verified_at", "network_mode", "organization_id", "project_id", "provider", "read_only", "schema_fingerprint_sha256", "status", "tls_mode", "updated_at", "updated_by"],
    "external_source_copy_estimates": ["created_at", "created_by", "estimate_checksum_sha256", "expires_at", "id", "maximum_output_bytes", "maximum_requests", "organization_id", "output_format", "project_id", "source_dataset_id", "source_revision_number"],
    "external_source_discovery_jobs": ["attempt_count", "created_at", "created_by", "finished_at", "id", "idempotency_key", "lease_expires_at", "organization_id", "project_id", "request_checksum_sha256", "source_type", "started_at", "state"],
    "external_source_revisions": ["change_message", "created_at", "created_by", "dataset_id", "organization_id", "verification_state", "version_number"],
    "external_source_snapshot_jobs": ["attempt_count", "created_at", "created_by", "destination_dataset_id", "estimate_id", "finished_at", "id", "idempotency_key", "last_heartbeat_at", "lease_expires_at", "organization_id", "output_dataset_version_id", "output_object_id", "project_id", "request_checksum_sha256", "source_dataset_id", "source_revision_number", "staged_base_version_id", "started_at", "state"],
    "external_sources": ["access_mode", "created_at", "created_by", "credential_mode", "dataset_id", "organization_id", "source_type"],
    "feature_collections": ["created_at", "created_by", "dataset_id", "feature_count", "generation", "geometry_type", "organization_id", "updated_at", "updated_by"],
    "field_form_versions": ["collection_generation", "created_at", "created_by", "dataset_id", "form_id", "geometry_type", "organization_id", "title", "version_number"],
    "field_forms": ["created_at", "created_by", "current_version", "dataset_id", "id", "organization_id", "updated_at", "updated_by"],
    "field_submission_events": ["actor_user_id", "created_at", "dataset_id", "from_state", "id", "organization_id", "submission_id", "submission_version", "to_state"],
    "field_submissions": ["dataset_id", "form_id", "form_version", "geometry_type", "id", "operation", "organization_id", "payload_sha256", "promoted_feature_id", "review_version", "reviewed_at", "reviewed_by", "state", "submitted_at", "submitted_by", "supersedes_submission_id", "target_feature_id", "target_feature_version"],
    "framework_publication_approvals": ["approved_at", "approved_by", "organization_id", "preview_capability_id", "project_id", "review_id"],
    "framework_publication_jobs": ["completed_files", "created_at", "lease_expires_at", "organization_id", "origin_id", "project_id", "review_id", "updated_at"],
    "framework_publication_mounts": ["enabled", "id", "organization_id", "origin_id", "project_id", "source_project_id", "verified_at", "verified_by"],
    "framework_publication_origins": ["active_publication_id", "active_release_prefix", "bucket", "enabled", "generation", "id", "organization_id", "project_reservation_limit", "self_service_prefix", "verified_at", "verified_by"],
    "framework_publication_reviews": ["build_job_id", "expected_generation", "expires_at", "id", "mount_id", "organization_id", "output_tree_checksum_sha256", "previous_release_prefix", "project_id", "result_checksum_sha256", "reviewed_at", "reviewed_by", "source_project_id"],
    "geonode_federated_identities": ["current_payload_sha256", "current_version_number", "first_seen_at", "last_refreshed_at", "organization_id", "project_id", "remote_modified_at", "source_id", "status", "title", "withdrawn_at"],
    "geonode_federated_identity_versions": ["harvest_job_id", "observed_at", "organization_id", "payload_sha256", "remote_modified_at", "source_id", "title", "version_number"],
    "geonode_federation_sources": ["configuration_checksum_sha256", "created_at", "created_by", "disabled_at", "display_name", "id", "maximum_resources", "organization_id", "project_id", "refresh_interval_minutes", "scheduling_enabled", "source_fingerprint_sha256", "status"],
    "geonode_harvest_jobs": ["attempt_count", "created_at", "created_by", "finished_at", "id", "idempotency_key", "lease_expires_at", "organization_id", "project_id", "request_checksum_sha256", "source_configuration_checksum_sha256", "source_id", "started_at", "state"],
    "github_publication_connections": ["build_workflow_id", "enabled", "id", "installation_id", "organization_id", "repository_id", "verified_at", "verified_by"],
    "governed_metadata_source_documents": ["checksum_sha256", "id", "imported_at", "imported_by", "organization_id", "resource_id", "resource_version_id", "source_format"],
    "governed_resource_external_identifiers": ["imported_at", "imported_by", "organization_id", "resource_id", "source_payload_sha256"],
    "governed_resource_permissions": ["created_at", "granted_by", "organization_id", "resource_id", "role", "updated_at", "user_id"],
    "governed_resource_rating_revisions": ["actor_user_id", "created_at", "id", "organization_id", "project_id", "resource_id", "score", "user_id", "version_number"],
    "governed_resource_rating_summaries": ["organization_id", "project_id", "rating_count", "rating_sum", "resource_id", "updated_at"],
    "governed_resource_ratings": ["created_at", "organization_id", "project_id", "resource_id", "score", "updated_at", "user_id", "version_number", "withdrawn_at"],
    "governed_resource_relationships": ["created_at", "created_by", "id", "organization_id", "project_id", "relation", "source_resource_id", "target_resource_id"],
    "governed_resource_style_versions": ["change_message", "checksum_sha256", "created_at", "created_by", "id", "organization_id", "style_id", "title", "version_number"],
    "governed_resource_styles": ["created_at", "created_by", "current_version_id", "format", "id", "organization_id", "project_id", "resource_id", "slug", "updated_at", "updated_by"],
    "governed_resource_versions": ["change_message", "created_at", "created_by", "id", "metadata_profile_id", "metadata_profile_version_id", "organization_id", "resource_id", "temporal_end", "temporal_start", "title", "version_number"],
    "governed_resource_workflow_events": ["actor_user_id", "created_at", "id", "organization_id", "project_id", "resource_id", "source_state", "target_state"],
    "governed_resources": ["created_at", "created_by", "current_version_id", "dataset_id", "id", "kind", "map_id", "organization_id", "owner_user_id", "project_id", "slug", "state", "updated_at", "updated_by", "visibility"],
    "kml_network_link_request_slots": ["lease_expires_at", "organization_id", "project_id", "released_at", "request_id", "started_at", "user_id"],
    "layer_archive_distributions": ["captured_at", "dataset_id", "dataset_version_id", "enabled", "id", "organization_id", "project_id", "reviewed_at", "reviewed_by", "source_version", "title"],
    "map_creation_requests": ["created_at", "created_by", "map_id", "organization_id", "project_id", "request_sha256"],
    "map_render_job_bindings": ["definition_checksum_sha256", "organization_id", "recipe_checksum_sha256", "render_job_id", "resource_id", "resource_version_id"],
    "map_render_job_layers": ["created_at", "organization_id", "profile_id", "profile_version_id", "render_job_id", "resource_id"],
    "map_render_job_source_pins": ["dataset_id", "dataset_version_id", "organization_id", "render_job_id", "source_checksum_sha256", "source_object_id", "source_resource_id", "source_resource_version_id"],
    "map_render_jobs": ["attempt_count", "composition_sealed", "created_at", "created_by", "finished_at", "format", "height", "id", "idempotency_key", "last_heartbeat_at", "lease_expires_at", "organization_id", "output_object_id", "profile_id", "profile_version_id", "project_id", "request_checksum_sha256", "resource_id", "started_at", "state", "transparent", "updated_at", "width"],
    "map_render_profile_versions": ["change_message", "checksum_sha256", "created_at", "created_by", "dataset_id", "dataset_version_id", "id", "organization_id", "profile_id", "resource_id", "resource_version_id", "style_id", "style_version_id", "title", "version_number"],
    "map_render_profiles": ["created_at", "created_by", "current_version_id", "id", "organization_id", "project_id", "resource_id", "slug", "updated_at", "updated_by"],
    "map_resource_version_bindings": ["map_id", "map_version", "organization_id", "project_id", "resource_id", "resource_version_id"],
    "map_versions": ["change_message", "created_at", "created_by", "id", "map_id", "organization_id", "version"],
    "maps": ["created_at", "created_by", "id", "name", "organization_id", "project_id", "status", "updated_at", "updated_by", "version"],
    "membership_invitations": ["accepted_at", "created_at", "expires_at", "id", "invited_by", "invitee_user_id", "organization_id", "organization_role", "project_id", "project_role", "revoked_at", "state", "updated_at"],
    "metadata_profile_versions": ["change_message", "checksum_sha256", "created_at", "created_by", "id", "organization_id", "profile_id", "version_number"],
    "metadata_profiles": ["created_at", "created_by", "current_version_id", "id", "organization_id", "slug", "title", "updated_at", "updated_by"],
    "observable_build_jobs": ["attempt_count", "created_at", "created_by", "finished_at", "id", "last_heartbeat_at", "lease_expires_at", "organization_id", "output_prefix", "project_id", "purpose", "request_checksum_sha256", "result_checksum_sha256", "source_project_id", "source_revision_id", "source_revision_number", "started_at", "state", "updated_at"],
    "observable_cache_admissions": ["admitted_at", "compiler_image_digest", "organization_id", "project_id", "source_project_id"],
    "observable_cache_entitlements": ["enabled", "max_entries", "organization_id"],
    "observable_compiler_transitions": ["compiler_digest", "organization_id", "previous_digest", "project_id", "recorded_at", "sequence", "source_project_id"],
    "observable_data_attachments": ["checksum_sha256", "content_type", "created_at", "created_by", "data_object_id", "dataset_id", "dataset_version_id", "id", "organization_id", "project_id", "s3_version_id", "size_bytes", "source_project_id"],
    "observable_github_dispatches": ["build_job_id", "connection_id", "created_at", "dispatch_started_at", "lease_expires_at", "organization_id", "project_id", "run_attempt", "run_id", "source_project_id", "updated_at", "workflow_id"],
    "observable_github_links": ["connection_id", "created_at", "created_by", "organization_id", "project_id", "source_project_id"],
    "observable_github_revision_receipts": ["connection_id", "created_at", "created_by", "manifest_sha256", "organization_id", "project_id", "repository_id", "source_project_id", "source_revision_id"],
    "observable_github_syncs": ["connection_id", "created_at", "lease_expires_at", "organization_id", "project_id", "requested_by", "source_project_id", "source_revision_id", "updated_at"],
    "observable_preview_capabilities": ["build_job_id", "consumed_at", "created_at", "expires_at", "id", "organization_id", "project_id", "requested_by"],
    "observable_source_file_upload_intents": ["bucket", "completed_at", "completed_object_id", "created_at", "created_by", "expected_sha256", "expected_size_bytes", "expires_at", "id", "object_key", "organization_id", "project_id", "relative_path", "source_project_id", "state"],
    "observable_source_objects": ["bucket", "checksum_sha256", "content_type", "created_at", "created_by", "etag", "id", "object_key", "organization_id", "project_id", "relative_path", "s3_version_id", "size_bytes", "source_project_id", "upload_intent_id"],
    "observable_source_projects": ["compiler_image_digest", "created_at", "created_by", "current_revision_id", "current_revision_number", "id", "organization_id", "owner_user_id", "project_id", "rights_status", "site_id", "title", "updated_at", "updated_by"],
    "observable_source_revision_files": ["created_at", "created_by", "organization_id", "project_id", "relative_path", "source_object_id", "source_project_id", "source_revision_id"],
    "observable_source_revisions": ["change_summary", "created_at", "created_by", "entry_path", "id", "lockfile_path", "manifest_checksum_sha256", "organization_id", "parent_revision_id", "project_id", "revision_number", "rights_status", "source_project_id", "title"],
    "organization_memberships": ["created_at", "invited_by", "organization_id", "role", "updated_at", "user_id"],
    "page_source_objects": ["bucket", "checksum_sha256", "compiler_version", "content_type", "created_at", "created_by", "etag", "id", "object_key", "organization_id", "project_id", "resource_id", "resource_version_id", "s3_version_id", "size_bytes", "upload_intent_id"],
    "page_source_upload_intents": ["bucket", "completed_at", "completed_source_object_id", "created_at", "created_by", "expected_resource_version", "expected_sha256", "expected_size_bytes", "expires_at", "id", "object_key", "organization_id", "project_id", "resource_id", "state"],
    "page_working_draft_revisions": ["base_resource_version", "change_summary", "created_at", "document_checksum_sha256", "draft_id", "id", "organization_id", "owner_user_id", "project_id", "resource_id", "revision_number", "visibility"],
    "page_working_drafts": ["base_resource_version", "created_at", "current_document_checksum_sha256", "current_revision_number", "id", "organization_id", "owner_user_id", "project_id", "resource_id", "updated_at"],
    "pmtiles_derivative_jobs": ["attempt_count", "created_at", "created_by", "dataset_id", "dataset_version_id", "finished_at", "id", "idempotency_key", "last_heartbeat_at", "lease_expires_at", "maximum_zoom", "minimum_zoom", "organization_id", "output_checksum_sha256", "output_object_id", "output_size_bytes", "project_id", "request_checksum_sha256", "source_object_id", "started_at", "state"],
    "processing_execution_receipts": ["coverage_job_id", "id", "initiated_by", "organization_id", "output_checksum_sha256", "output_object_id", "pmtiles_job_id", "project_id", "receipt_checksum_sha256", "recorded_at", "request_checksum_sha256", "source_object_id"],
    "processing_jobs": ["attempt_count", "created_at", "created_by", "dataset_id", "dataset_version_id", "finished_at", "id", "last_heartbeat_at", "lease_expires_at", "organization_id", "project_id", "started_at", "state", "updated_at"],
    "project_artifact_cleanup_attempts": ["created_at", "created_by", "deleted_versions", "finished_at", "id", "more_versions", "observed_empty", "organization_id", "state", "upload_id"],
    "project_artifact_objects": ["artifact_id", "bucket", "checksum_sha256", "content_type", "created_at", "created_by", "etag", "id", "object_key", "organization_id", "s3_version_id", "size_bytes"],
    "project_artifact_releases": ["artifact_id", "created_at", "created_by", "id", "organization_id", "revoked_at", "revoked_by", "title", "version_number"],
    "project_artifact_upload_intents": ["artifact_id", "bucket", "completed_at", "completed_object_id", "created_at", "created_by", "expected_revision", "expected_sha256", "expected_size_bytes", "expires_at", "id", "object_key", "organization_id"],
    "project_artifact_versions": ["artifact_id", "created_at", "created_by", "manifest_checksum_sha256", "organization_id", "origin_map_id", "origin_map_version", "portable_object_id", "render_job_id", "version_number"],
    "project_artifacts": ["created_at", "created_by", "current_version_number", "id", "map_id", "organization_id", "representation", "resource_id", "revision", "updated_at", "updated_by"],
    "project_basemap_connection_bindings": ["connection_id", "created_at", "created_by", "display_name", "id", "organization_id", "project_id"],
    "project_dataset_connection_bindings": ["connection_id", "created_at", "created_by", "display_name", "id", "organization_id", "project_id"],
    "project_datasets": ["dataset_id", "linked_at", "linked_by", "organization_id", "project_id"],
    "project_discussion_comment_mentions": ["comment_id", "created_at", "discussion_id", "mentioned_by", "mentioned_user_id", "organization_id", "project_id"],
    "project_discussion_comment_moderations": ["action", "actor_user_id", "comment_id", "created_at", "discussion_id", "id", "organization_id", "project_id"],
    "project_discussion_comments": ["created_at", "created_by", "discussion_id", "id", "organization_id", "project_id"],
    "project_discussion_subscriptions": ["discussion_id", "organization_id", "project_id", "subscribed_at", "unsubscribed_at", "updated_at", "user_id", "version_number"],
    "project_discussions": ["assigned_at", "assigned_by", "assigned_to", "created_at", "created_by", "id", "initial_comment_id", "organization_id", "project_id", "resolved_at", "resolved_by", "state", "target_dataset_id", "target_feature_id", "target_kind", "target_map_id", "target_map_version", "target_object_id", "target_object_version", "title", "updated_at", "version_number"],
    "project_import_items": ["bound_at", "created_at", "dataset_id", "expected_format", "expected_source_type", "import_id", "kind", "organization_id", "state"],
    "project_import_operations": ["completed_at", "created_at", "created_by", "expected_map_version", "id", "idempotency_key", "map_id", "organization_id", "project_id", "source_sha256", "state", "updated_at"],
    "project_memberships": ["created_at", "organization_id", "project_id", "role", "updated_at", "user_id"],
    "project_notifications": ["actor_user_id", "comment_id", "created_at", "discussion_id", "discussion_version", "id", "kind", "organization_id", "project_id", "read_at", "recipient_user_id", "version_number"],
    "project_site_editions": ["edition_number", "id", "is_primary", "manifest_checksum_sha256", "organization_id", "project_id", "publication_reach", "published_at", "published_by", "revoked_at", "revoked_by", "site_id", "site_version_id", "site_version_number"],
    "project_site_pages": ["created_at", "created_by", "id", "is_home", "organization_id", "project_id", "resource_id", "resource_version_id", "resource_version_number", "site_id", "site_version_id", "site_version_number"],
    "project_site_publication_destination_events": ["actor_user_id", "created_at", "destination_revision", "id", "organization_id", "project_id", "site_id", "source_is_primary", "source_reach", "target_is_primary", "target_reach"],
    "project_site_publication_destinations": ["configured_at", "configured_by", "is_primary", "organization_id", "project_id", "reach", "revision", "site_id"],
    "project_site_versions": ["change_message", "created_at", "created_by", "id", "organization_id", "project_id", "site_id", "title", "version_number"],
    "project_site_workflow_events": ["actor_user_id", "created_at", "id", "organization_id", "project_id", "site_id", "site_version_id", "site_version_number", "source_state", "target_state"],
    "project_sites": ["created_at", "created_by", "current_version_id", "current_version_number", "id", "organization_id", "project_id", "slug", "state", "updated_at", "updated_by"],
    "project_team_grants": ["created_at", "created_by", "id", "organization_id", "project_id", "role", "team_id", "updated_at"],
    "projects": ["client_id", "created_at", "created_by", "id", "name", "organization_id", "published_at", "published_by", "status", "updated_at", "visibility"],
    "public_wms_services": ["created_at", "created_by", "disabled_at", "disabled_by", "id", "organization_id", "project_id", "title"],
    "publication_artifact_inputs": ["created_at", "created_by", "id", "manifest_checksum_sha256", "organization_id", "reference_revision", "source_project_id", "source_revision_id"],
    "publication_artifact_reference_sets": ["created_at", "created_by", "organization_id", "revision", "source_project_id"],
    "repository_object_copy_estimates": ["created_at", "created_by", "estimate_checksum_sha256", "expires_at", "id", "maximum_output_bytes", "maximum_requests", "organization_id", "output_format", "project_id", "source_dataset_id"],
    "repository_object_copy_jobs": ["attempt_count", "created_at", "created_by", "destination_dataset_id", "estimate_id", "finished_at", "id", "idempotency_key", "last_heartbeat_at", "lease_expires_at", "organization_id", "output_dataset_version_id", "output_object_id", "project_id", "request_checksum_sha256", "source_dataset_id", "started_at", "state"],
    "repository_object_sources": ["bucket_name", "connection_id", "connection_target_revision", "content_type", "created_at", "created_by", "dataset_id", "etag", "last_modified", "object_prefix", "organization_id", "provider", "provider_checksum_sha256", "provider_version_id", "region_name", "relative_path", "size_bytes"],
    "saved_map_render_reuse": ["created_at", "created_by", "idempotency_key", "organization_id", "render_job_id"],
    "source_capture_count_evidence": ["dataset_id", "dataset_version_id", "organization_id", "original_object_id", "recorded_at", "snapshot_job_id"],
    "source_discovery_documents": ["discovery_job_id", "organization_id", "project_id"],
    "spatial_coverage_derivative_jobs": ["attempt_count", "coverage_id", "created_at", "created_by", "finished_at", "id", "last_heartbeat_at", "lease_expires_at", "organization_id", "output_band_count", "output_checksum_sha256", "output_height", "output_object_id", "output_size_bytes", "output_width", "project_id", "request_checksum_sha256", "request_schema_version", "service_id", "started_at", "state", "target_height", "target_width"],
    "spatial_coverage_derivative_reclamations": ["attempt_count", "coverage_id", "created_at", "created_by", "delete_started_at", "derivative_job_id", "finished_at", "id", "last_heartbeat_at", "lease_expires_at", "organization_id", "output_object_id", "preview_checksum_sha256", "preview_expires_at", "project_id", "sealed_checksum_sha256", "sealed_size_bytes", "service_id", "started_at", "state"],
    "spatial_service_collection_ids": ["organization_id", "project_id", "reserved_at", "reserved_by", "resource_id", "service_id"],
    "spatial_service_collection_styles": ["collection_id", "created_at", "created_by", "id", "is_default", "organization_id", "project_id", "render_profile_id", "sealed_profile_version_id", "sealed_profile_version_number", "sealed_style_version_id", "sealed_style_version_number", "service_id", "style_id", "withdrawn_at", "withdrawn_by"],
    "spatial_service_collections": ["created_at", "created_by", "dataset_id", "default_profile_id", "id", "organization_id", "project_id", "resource_id", "sealed_feature_generation", "sealed_profile_version_id", "sealed_profile_version_number", "service_id", "store_id", "title", "withdrawn_at", "withdrawn_by"],
    "spatial_service_coverages": ["created_at", "created_by", "data_object_id", "dataset_id", "dataset_version_id", "id", "organization_id", "project_id", "sealed_band_count", "sealed_checksum_sha256", "sealed_dataset_version_number", "sealed_height", "sealed_size_bytes", "sealed_width", "service_id", "title", "withdrawn_at", "withdrawn_by"],
    "spatial_service_layer_group_versions": ["change_message", "created_at", "created_by", "group_id", "id", "mode", "organization_id", "project_id", "service_id", "title", "version_number"],
    "spatial_service_layer_groups": ["created_at", "created_by", "current_version_id", "current_version_number", "disabled_at", "disabled_by", "id", "organization_id", "project_id", "service_id", "slug", "updated_at", "updated_by"],
    "spatial_service_metadata_versions": ["change_message", "created_at", "created_by", "id", "organization_id", "project_id", "service_id", "title", "version_number"],
    "spatial_service_stores": ["created_at", "created_by", "dataset_id", "disabled_at", "disabled_by", "external_connection_id", "id", "kind", "organization_id", "project_id", "sealed_connection_revision_number", "sealed_source_revision_number", "service_id", "slug", "title"],
    "spatial_services": ["created_at", "created_by", "current_metadata_version_id", "current_metadata_version_number", "disabled_at", "disabled_by", "id", "organization_id", "project_id", "slug", "title", "updated_at", "updated_by"],
    "spatial_tile_cache_entries": ["cache_id", "cache_version_id", "cache_version_number", "id", "organization_id", "project_id", "render_job_id", "seeded_at", "seeded_by", "tile_col", "tile_matrix", "tile_row"],
    "spatial_tile_cache_reclamation_items": ["delete_started_at", "finished_at", "organization_id", "output_object_id", "reclamation_id", "render_job_id", "sealed_checksum_sha256", "sealed_size_bytes", "state"],
    "spatial_tile_cache_reclamations": ["attempt_count", "binding_id", "cache_id", "cache_version_id", "cache_version_number", "created_at", "created_by", "finished_at", "id", "last_heartbeat_at", "lease_expires_at", "organization_id", "preview_checksum_sha256", "preview_expires_at", "project_id", "service_id", "started_at", "state", "target_count", "target_size_bytes"],
    "spatial_tile_cache_versions": ["cache_id", "change_message", "created_at", "created_by", "id", "maximum_entries", "maximum_tile_matrix", "minimum_tile_matrix", "organization_id", "version_number"],
    "spatial_tile_caches": ["binding_id", "created_at", "created_by", "current_version_id", "current_version_number", "id", "organization_id", "project_id", "service_id", "updated_at", "updated_by"],
    "spatial_tile_seed_plan_items": ["cache_id", "cache_version_number", "created_at", "finished_at", "id", "organization_id", "plan_id", "render_job_id", "started_at", "state", "tile_col", "tile_matrix", "tile_row"],
    "spatial_tile_seed_plans": ["binding_id", "cache_id", "cache_version_id", "cache_version_number", "created_at", "created_by", "dispatch_started_at", "existing_count", "finished_at", "id", "maximum_tile_matrix", "minimum_tile_matrix", "mode", "organization_id", "preview_checksum_sha256", "preview_expires_at", "project_id", "requested_count", "service_id", "started_at", "state", "target_count"],
    "tags": ["created_at", "created_by", "id", "name", "organization_id"],
    "team_memberships": ["created_at", "created_by", "organization_id", "role", "team_id", "updated_at", "user_id"],
    "teams": ["created_at", "created_by", "id", "name", "organization_id", "status", "updated_at"],
    "upload_intents": ["bucket", "completed_at", "completed_object_id", "content_type", "created_at", "created_by", "dataset_id", "expected_sha256", "expected_size_bytes", "expires_at", "id", "object_key", "organization_id", "project_id", "staged_base_version_id", "state", "updated_at"],
    "user_basemap_connections": ["created_at", "credential_revision", "display_name", "id", "organization_id", "owner_user_id", "provider", "status", "updated_at"],
    "user_dataset_connection_verifications": ["attempt_count", "bucket_access_confirmed", "connection_id", "created_at", "credential_revision", "deny_canaries_confirmed", "duration_ms", "finished_at", "id", "lease_expires_at", "object_access_confirmed", "objects_observed", "organization_id", "owner_user_id", "requested_by", "started_at", "state", "target_revision"],
    "user_dataset_connections": ["bucket_name", "created_at", "credential_mode", "credential_revision", "display_name", "id", "last_verified_at", "object_prefix", "organization_id", "owner_user_id", "provider", "region_name", "status", "target_revision", "updated_at"],
    "wms_layer_publications": ["created_at", "created_by", "default_profile_id", "id", "organization_id", "project_id", "resource_id", "withdrawn_at", "withdrawn_by"],
    "workspace_collection_entries": ["collection_id", "id", "map_id", "organization_id", "position", "site_id"],
    "workspace_collection_grants": ["collection_id", "organization_id", "role", "user_id"],
    "workspace_collections": ["created_at", "created_by", "id", "organization_id", "owner_user_id", "revision", "title", "updated_at", "visibility"],
    "workspace_location_grants": ["location_id", "organization_id", "role", "user_id"],
    "workspace_location_link_entries": ["dataset_id", "entry_id", "location_id", "organization_id", "position", "revision"],
    "workspace_location_link_revisions": ["created_at", "created_by", "location_id", "organization_id", "revision"],
    "workspace_location_parent_revisions": ["created_at", "created_by", "location_id", "organization_id", "parent_id", "revision"],
    "workspace_location_revisions": ["created_at", "created_by", "location_id", "organization_id", "revision"],
    "workspace_locations": ["access_revision", "created_at", "created_by", "hierarchy_revision", "id", "links_revision", "organization_id", "owner_user_id", "parent_id", "revision", "updated_at"]
  }'::jsonb;
  v_extra constant jsonb := '{
    "activity_events": ["encode(sha256(convert_to(\"payload\"::text,''UTF8'')),''hex'') AS \"payload_sha256\""],
    "archive_manifest_records": ["encode(sha256(\"body\"),''hex'') AS \"body_sha256\"", "encode(sha256(convert_to(\"receipt\"::text,''UTF8'')),''hex'') AS \"receipt_sha256\"", "jsonb_build_object(''bucket'',receipt->''bucket'',''key'',receipt->''key'',''version_id'',receipt->''version_id'',''size_bytes'',receipt->''size_bytes'',''sha256'',receipt->''sha256'',''storage_checksum_sha256'',receipt->''storage_checksum_sha256'') AS stored_object_receipt"],
    "archive_upload_objects": ["encode(sha256(convert_to(\"receipt\"::text,''UTF8'')),''hex'') AS \"receipt_sha256\"", "jsonb_build_object(''bucket'',receipt->''bucket'',''key'',receipt->''key'',''version_id'',receipt->''version_id'',''size_bytes'',receipt->''size_bytes'',''sha256'',receipt->''sha256'',''storage_checksum_sha256'',receipt->''storage_checksum_sha256'') AS stored_object_receipt"],
    "authored_resource_knowledge_revisions": ["encode(sha256(convert_to(\"document\"::text,''UTF8'')),''hex'') AS \"document_sha256\""],
    "dataset_feature_revisions": ["encode(sha256(convert_to(\"properties\"::text,''UTF8'')),''hex'') AS \"properties_sha256\"", "encode(sha256(convert_to(\"geometry_geojson\"::text,''UTF8'')),''hex'') AS \"geometry_geojson_sha256\""],
    "dataset_features": ["encode(sha256(convert_to(\"properties\"::text,''UTF8'')),''hex'') AS \"properties_sha256\"", "encode(sha256(convert_to(\"geometry_geojson\"::text,''UTF8'')),''hex'') AS \"geometry_geojson_sha256\""],
    "dataset_knowledge_revisions": ["encode(sha256(convert_to(\"document\"::text,''UTF8'')),''hex'') AS \"document_sha256\""],
    "dataset_refresh_reviews": ["encode(sha256(convert_to(\"evidence\"::text,''UTF8'')),''hex'') AS \"evidence_sha256\""],
    "dataset_versions": ["encode(sha256(convert_to(\"extent\"::text,''UTF8'')),''hex'') AS \"extent_sha256\"", "encode(sha256(convert_to(\"schema_definition\"::text,''UTF8'')),''hex'') AS \"schema_definition_sha256\"", "encode(sha256(convert_to(\"quality_results\"::text,''UTF8'')),''hex'') AS \"quality_results_sha256\""],
    "external_connection_revisions": ["encode(sha256(convert_to(\"configuration\"::text,''UTF8'')),''hex'') AS \"configuration_sha256\""],
    "external_connections": ["(coalesce(cardinality(configured_secret_fields),0)>0) AS reconnection_required"],
    "external_source_copy_estimates": ["encode(sha256(convert_to(\"capture_scope\"::text,''UTF8'')),''hex'') AS \"capture_scope_sha256\""],
    "external_source_discovery_jobs": ["encode(sha256(convert_to(\"result\"::text,''UTF8'')),''hex'') AS \"result_sha256\""],
    "external_source_revisions": ["encode(sha256(convert_to(\"configuration\"::text,''UTF8'')),''hex'') AS \"configuration_sha256\""],
    "feature_collections": ["encode(sha256(convert_to(\"schema_definition\"::text,''UTF8'')),''hex'') AS \"schema_definition_sha256\""],
    "field_form_versions": ["encode(sha256(convert_to(\"schema_definition\"::text,''UTF8'')),''hex'') AS \"schema_definition_sha256\""],
    "field_submissions": ["encode(sha256(convert_to(\"properties\"::text,''UTF8'')),''hex'') AS \"properties_sha256\"", "encode(sha256(convert_to(\"geometry_geojson\"::text,''UTF8'')),''hex'') AS \"geometry_geojson_sha256\""],
    "framework_publication_jobs": ["encode(sha256(convert_to(\"plan\"::text,''UTF8'')),''hex'') AS \"plan_sha256\"", "encode(sha256(convert_to(\"edge_snapshot\"::text,''UTF8'')),''hex'') AS \"edge_snapshot_sha256\"", "encode(sha256(convert_to(\"receipt\"::text,''UTF8'')),''hex'') AS \"receipt_sha256\""],
    "geonode_federated_identity_versions": ["encode(sha256(convert_to(\"payload\"::text,''UTF8'')),''hex'') AS \"payload_sha256\""],
    "geonode_harvest_jobs": ["encode(sha256(convert_to(\"result\"::text,''UTF8'')),''hex'') AS \"result_sha256\""],
    "governed_metadata_source_documents": ["encode(sha256(convert_to(\"conversion_report\"::text,''UTF8'')),''hex'') AS \"conversion_report_sha256\""],
    "governed_resource_versions": ["encode(sha256(convert_to(\"spatial_extent\"::text,''UTF8'')),''hex'') AS \"spatial_extent_sha256\"", "encode(sha256(convert_to(\"metadata_extensions\"::text,''UTF8'')),''hex'') AS \"metadata_extensions_sha256\"", "encode(sha256(convert_to(\"content\"::text,''UTF8'')),''hex'') AS \"content_sha256\"", "encode(sha256(convert_to(\"provenance\"::text,''UTF8'')),''hex'') AS \"provenance_sha256\"", "encode(sha256(convert_to(\"metadata_validation\"::text,''UTF8'')),''hex'') AS \"metadata_validation_sha256\"", "encode(sha256(convert_to(\"localized_metadata\"::text,''UTF8'')),''hex'') AS \"localized_metadata_sha256\""],
    "layer_archive_distributions": ["encode(sha256(convert_to(\"descriptor\"::text,''UTF8'')),''hex'') AS \"descriptor_sha256\"", "(SELECT coalesce(jsonb_agg(jsonb_build_object(''bucket'',item->''bucket'',''key'',item->''key'',''version_id'',item->''version_id'',''size_bytes'',item->''size_bytes'',''sha256'',item->''sha256'',''decoded_size_bytes'',item->''decoded_size_bytes'',''decoded_sha256'',item->''decoded_sha256'',''encoding'',item->''encoding'',''block_index'',jsonb_build_object(''key'',item#>''{block_index,key}'',''version_id'',item#>''{block_index,version_id}'',''size_bytes'',item#>''{block_index,size_bytes}'',''sha256'',item#>''{block_index,sha256}''))), ''[]''::jsonb) FROM jsonb_array_elements(coalesce(descriptor->''objects'',''[]''::jsonb)) item) AS stored_distribution_objects"],
    "map_render_job_bindings": ["encode(sha256(convert_to(\"recipe\"::text,''UTF8'')),''hex'') AS \"recipe_sha256\""],
    "map_render_jobs": ["encode(sha256(convert_to(\"bbox\"::text,''UTF8'')),''hex'') AS \"bbox_sha256\""],
    "map_render_profile_versions": ["encode(sha256(convert_to(\"configuration\"::text,''UTF8'')),''hex'') AS \"configuration_sha256\""],
    "map_versions": ["encode(sha256(convert_to(\"definition\"::text,''UTF8'')),''hex'') AS \"definition_sha256\"", "(SELECT coalesce(jsonb_agg(jsonb_build_object(''dataset_id'',item->''datasetId'',''dataset_version_id'',item->''datasetVersionId'',''source_version'',item->''sourceVersion'',''source_type'',item->''sourceType'',''connection_binding_id'',item->''connectionBindingId'',''style_project_id'',item#>''{styleReference,projectId}'',''style_resource_id'',item#>''{styleReference,resourceId}'',''style_id'',item#>''{styleReference,styleId}'',''style_version'',item#>''{styleReference,versionNumber}'',''style_sha256'',item#>''{styleReference,checksumSha256}'')), ''[]''::jsonb) FROM jsonb_array_elements(coalesce(definition->''layers'',''[]''::jsonb)||coalesce(definition->''basemaps'',''[]''::jsonb)) item) AS definition_dependencies"],
    "maps": ["encode(sha256(convert_to(\"definition\"::text,''UTF8'')),''hex'') AS \"definition_sha256\"", "(SELECT coalesce(jsonb_agg(jsonb_build_object(''dataset_id'',item->''datasetId'',''dataset_version_id'',item->''datasetVersionId'',''source_version'',item->''sourceVersion'',''source_type'',item->''sourceType'',''connection_binding_id'',item->''connectionBindingId'',''style_project_id'',item#>''{styleReference,projectId}'',''style_resource_id'',item#>''{styleReference,resourceId}'',''style_id'',item#>''{styleReference,styleId}'',''style_version'',item#>''{styleReference,versionNumber}'',''style_sha256'',item#>''{styleReference,checksumSha256}'')), ''[]''::jsonb) FROM jsonb_array_elements(coalesce(definition->''layers'',''[]''::jsonb)||coalesce(definition->''basemaps'',''[]''::jsonb)) item) AS definition_dependencies"],
    "metadata_profile_versions": ["encode(sha256(convert_to(\"definition\"::text,''UTF8'')),''hex'') AS \"definition_sha256\""],
    "observable_build_jobs": ["encode(sha256(convert_to(\"request\"::text,''UTF8'')),''hex'') AS \"request_sha256\"", "encode(sha256(convert_to(\"result\"::text,''UTF8'')),''hex'') AS \"result_sha256\"", "(SELECT coalesce(jsonb_agg(jsonb_build_object(''path'',item->''path'',''bucket'',item->''bucket'',''object_key'',item->''objectKey'',''s3_version_id'',item->''s3VersionId'',''etag'',item->''etag'',''content_type'',item->''contentType'',''size_bytes'',item->''sizeBytes'',''sha256'',item->''checksumSha256'')),''[]''::jsonb) FROM jsonb_array_elements(coalesce(result#>''{outputManifest,files}'',''[]''::jsonb)) item) AS compiled_output_objects"],
    "observable_github_dispatches": ["encode(sha256(convert_to(\"retained_logs\"::text,''UTF8'')),''hex'') AS \"retained_logs_sha256\""],
    "observable_source_projects": ["encode(sha256(convert_to(\"resource_limits\"::text,''UTF8'')),''hex'') AS \"resource_limits_sha256\""],
    "observable_source_revisions": ["encode(sha256(convert_to(\"manifest\"::text,''UTF8'')),''hex'') AS \"manifest_sha256\"", "(SELECT coalesce(jsonb_agg(jsonb_build_object(''path'',item->''path'',''attachment_id'',item->''attachmentId'',''dataset_id'',item->''datasetId'',''dataset_version_id'',item->''datasetVersionId'',''data_object_id'',item->''dataObjectId'',''s3_version_id'',item->''s3VersionId'',''sha256'',item->''checksumSha256'',''size_bytes'',item->''sizeBytes'',''content_type'',item->''contentType'')),''[]''::jsonb) FROM jsonb_array_elements(coalesce(manifest->''dataAttachments'',''[]''::jsonb)) item) AS data_attachment_dependencies"],
    "page_working_draft_revisions": ["encode(sha256(convert_to(\"metadata\"::text,''UTF8'')),''hex'') AS \"metadata_sha256\"", "encode(sha256(convert_to(\"content\"::text,''UTF8'')),''hex'') AS \"content_sha256\"", "encode(sha256(convert_to(\"provenance\"::text,''UTF8'')),''hex'') AS \"provenance_sha256\""],
    "pmtiles_derivative_jobs": ["encode(sha256(convert_to(\"bounds\"::text,''UTF8'')),''hex'') AS \"bounds_sha256\""],
    "processing_execution_receipts": ["encode(sha256(convert_to(\"software\"::text,''UTF8'')),''hex'') AS \"software_sha256\"", "encode(sha256(convert_to(\"logs\"::text,''UTF8'')),''hex'') AS \"logs_sha256\""],
    "processing_jobs": ["encode(sha256(convert_to(\"parameters\"::text,''UTF8'')),''hex'') AS \"parameters_sha256\"", "encode(sha256(convert_to(\"result\"::text,''UTF8'')),''hex'') AS \"result_sha256\""],
    "project_artifact_upload_intents": ["encode(sha256(convert_to(\"manifest\"::text,''UTF8'')),''hex'') AS \"manifest_sha256\""],
    "project_artifact_versions": ["encode(sha256(convert_to(\"manifest\"::text,''UTF8'')),''hex'') AS \"manifest_sha256\""],
    "project_import_items": ["encode(sha256(convert_to(\"candidate\"::text,''UTF8'')),''hex'') AS \"candidate_sha256\""],
    "project_import_operations": ["encode(sha256(convert_to(\"map_definition\"::text,''UTF8'')),''hex'') AS \"map_definition_sha256\"", "encode(sha256(convert_to(\"conversion_report\"::text,''UTF8'')),''hex'') AS \"conversion_report_sha256\""],
    "project_site_editions": ["encode(sha256(convert_to(\"manifest\"::text,''UTF8'')),''hex'') AS \"manifest_sha256\""],
    "project_site_versions": ["encode(sha256(convert_to(\"theme_options\"::text,''UTF8'')),''hex'') AS \"theme_options_sha256\"", "encode(sha256(convert_to(\"print_layout\"::text,''UTF8'')),''hex'') AS \"print_layout_sha256\""],
    "publication_artifact_inputs": ["encode(sha256(convert_to(\"manifest\"::text,''UTF8'')),''hex'') AS \"manifest_sha256\"", "(SELECT coalesce(jsonb_agg(jsonb_build_object(''artifact_id'',item->''artifactId'',''version'',item->''version'',''output_object_id'',item->''outputObjectId'',''manifest_sha256'',item->''manifestChecksumSha256'',''path'',item->''path'')),''[]''::jsonb) FROM jsonb_array_elements(coalesce(manifest->''artifacts'',''[]''::jsonb)) item) AS artifact_dependencies"],
    "publication_artifact_reference_sets": ["encode(sha256(convert_to(\"references_json\"::text,''UTF8'')),''hex'') AS \"references_json_sha256\"", "(SELECT coalesce(jsonb_agg(jsonb_build_object(''artifact_id'',item->''artifact_id'',''mode'',item->''mode'',''version'',item->''version'',''path'',item->''path'')),''[]''::jsonb) FROM jsonb_array_elements(references_json) item) AS artifact_references"],
    "source_capture_count_evidence": ["encode(sha256(convert_to(\"evidence\"::text,''UTF8'')),''hex'') AS \"evidence_sha256\""],
    "source_discovery_documents": ["encode(sha256(convert_to(\"document\"::text,''UTF8'')),''hex'') AS \"document_sha256\"", "jsonb_build_object(''status'',document->''status'',''byte_length'',document->''byte_length'',''sha256'',document->''sha256'',''retrieved_at'',document->''retrieved_at'',''object'',document->''object'') AS stored_response_object"],
    "spatial_coverage_derivative_jobs": ["encode(sha256(convert_to(\"subset_extent\"::text,''UTF8'')),''hex'') AS \"subset_extent_sha256\"", "encode(sha256(convert_to(\"output_extent\"::text,''UTF8'')),''hex'') AS \"output_extent_sha256\"", "encode(sha256(convert_to(\"output_bands\"::text,''UTF8'')),''hex'') AS \"output_bands_sha256\"", "encode(sha256(convert_to(\"band_indexes\"::text,''UTF8'')),''hex'') AS \"band_indexes_sha256\"", "encode(sha256(convert_to(\"requested_resolution\"::text,''UTF8'')),''hex'') AS \"requested_resolution_sha256\""],
    "spatial_service_coverages": ["encode(sha256(convert_to(\"sealed_extent\"::text,''UTF8'')),''hex'') AS \"sealed_extent_sha256\"", "encode(sha256(convert_to(\"sealed_bands\"::text,''UTF8'')),''hex'') AS \"sealed_bands_sha256\""],
    "spatial_service_metadata_versions": ["encode(sha256(convert_to(\"contact\"::text,''UTF8'')),''hex'') AS \"contact_sha256\""],
    "spatial_service_stores": ["encode(sha256(convert_to(\"configuration\"::text,''UTF8'')),''hex'') AS \"configuration_sha256\""],
    "user_basemap_connections": ["(coalesce(cardinality(configured_secret_fields),0)>0) AS reconnection_required"],
    "user_dataset_connections": ["(coalesce(cardinality(configured_secret_fields),0)>0) AS reconnection_required"],
    "workspace_location_link_entries": ["encode(sha256(convert_to(\"evidence\"::text,''UTF8'')),''hex'') AS \"evidence_sha256\""],
    "workspace_location_parent_revisions": ["encode(sha256(convert_to(\"evidence\"::text,''UTF8'')),''hex'') AS \"evidence_sha256\""],
    "workspace_location_revisions": ["encode(sha256(convert_to(\"document\"::text,''UTF8'')),''hex'') AS \"document_sha256\""]
  }'::jsonb;
  v_table text;
  v_columns jsonb;
  v_omitted_columns jsonb;
  v_sql text;
  v_extra_sql text;
  v_rows jsonb;
  v_inventory jsonb := '{}'::jsonb;
  v_row_count integer := 0;
  v_principals jsonb;
  v_body bytea;
  v_snapshot text;
  v_digest text;
BEGIN
  IF v_account IS NULL OR v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM app.organization_memberships m
    WHERE m.organization_id=v_account AND m.user_id=v_actor AND m.role='admin'
  ) THEN
    RAISE EXCEPTION 'account_recovery_admin_required' USING ERRCODE='42501';
  END IF;
  IF current_setting('transaction_isolation') <> 'repeatable read'
    OR current_setting('transaction_read_only') <> 'on' THEN
    RAISE EXCEPTION 'account_recovery_snapshot_required' USING ERRCODE='25001';
  END IF;
  -- Fail closed on schema drift instead of silently omitting a new account table.
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id'
      AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname='app' AND c.relkind IN ('r','p')
      AND NOT v_projections ? c.relname
  ) THEN
    RAISE EXCEPTION 'account_recovery_schema_changed' USING ERRCODE='55000';
  END IF;
  FOR v_table,v_columns IN SELECT key,value FROM jsonb_each(v_projections) ORDER BY key LOOP
    IF to_regclass('app.' || v_table) IS NULL OR EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(v_columns) requested(name)
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid=to_regclass('app.' || v_table) AND a.attname=requested.name
          AND a.attnum>0 AND NOT a.attisdropped
      )
    ) THEN
      RAISE EXCEPTION 'account_recovery_schema_changed' USING ERRCODE='55000';
    END IF;
    SELECT string_agg(format('%I',name),',' ORDER BY name) INTO v_sql
    FROM jsonb_array_elements_text(v_columns) requested(name);
    SELECT string_agg(expression,',') INTO v_extra_sql
    FROM jsonb_array_elements_text(coalesce(v_extra->v_table,'[]'::jsonb)) facts(expression);
    IF v_extra_sql IS NOT NULL THEN v_sql := v_sql || ',' || v_extra_sql; END IF;
    -- No status/publication/owner filter: retain archived resources, hidden
    -- Collection edges, private upload history and reclaimed object metadata.
    EXECUTE format(
      'SELECT coalesce(jsonb_agg(to_jsonb(selected) ORDER BY to_jsonb(selected)::text),''[]''::jsonb) '
      'FROM (SELECT %s FROM app.%I WHERE organization_id=$1 LIMIT 20001) selected',
      v_sql,v_table
    ) INTO v_rows USING v_account;
    v_row_count := v_row_count + jsonb_array_length(v_rows);
    IF v_row_count > 20000 THEN
      RAISE EXCEPTION 'account_recovery_row_bound' USING ERRCODE='54000';
    END IF;
    SELECT coalesce(jsonb_agg(a.attname ORDER BY a.attnum),'[]'::jsonb) INTO v_omitted_columns
    FROM pg_attribute a WHERE a.attrelid=to_regclass('app.'||v_table)
      AND a.attnum>0 AND NOT a.attisdropped AND NOT v_columns ? a.attname;
    v_inventory := v_inventory || jsonb_build_object(v_table,jsonb_build_object(
      'count',jsonb_array_length(v_rows),'records',v_rows,'omitted_columns',v_omitted_columns
    ));
    IF octet_length(v_inventory::text) > 8000000 THEN
      RAISE EXCEPTION 'account_recovery_byte_bound' USING ERRCODE='54000';
    END IF;
  END LOOP;
  -- Historical actors keep their existing IDs. Do not disclose private identity
  -- details from a different account or an actor who has left this account.
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',u.id,'current_member',m.user_id IS NOT NULL,
    'display_name',CASE WHEN m.user_id IS NOT NULL THEN u.display_name END,
    'email',CASE WHEN m.user_id IS NOT NULL THEN u.email END) ORDER BY u.id),'[]'::jsonb)
    INTO v_principals
  FROM app.users u LEFT JOIN app.organization_memberships m
    ON m.organization_id=v_account AND m.user_id=u.id
  WHERE m.user_id IS NOT NULL OR u.id::text IN (
    SELECT item.value #>> '{}' FROM jsonb_each(v_inventory) section
    CROSS JOIN LATERAL jsonb_array_elements(section.value->'records') record
    CROSS JOIN LATERAL jsonb_each(record.value) item
    WHERE (item.key IN ('user_id','owner_user_id','recipient_user_id','actor_user_id',
      'mentioned_user_id','invitee_user_id') OR item.key LIKE '%\_by' ESCAPE '\')
      AND jsonb_typeof(item.value)='string'
  );
  v_snapshot := pg_current_snapshot()::text;
  v_body := convert_to(jsonb_build_object(
    'schema_version','opengeo.account-recovery-inventory.1.0.0',
    'organization_id',v_account,'captured_by',v_actor,'snapshot_id',v_snapshot,
    'captured_at',transaction_timestamp(),'record_count',v_row_count,
    'account',(SELECT jsonb_build_object('id',o.id,'name',o.name,'slug',o.slug,
      'status',o.status,'created_by',o.created_by,'created_at',o.created_at,
      'updated_at',o.updated_at) FROM app.organizations o WHERE o.id=v_account),
    'principals',v_principals,'tables',v_inventory,
    'limits',jsonb_build_object('metadata_inventory_only',true,'object_bytes_included',false,
      'payloads_included',false,'remote_references_fetched',false,
      'credentials_included',false,'connections_require_reauthentication',true,
      'unstored_project_history_fields',jsonb_build_array('name','description','status'),
      'historical_principal_details','current account members only')
  )::text,'UTF8');
  IF octet_length(v_body) > 8388608 THEN
    RAISE EXCEPTION 'account_recovery_byte_bound' USING ERRCODE='54000';
  END IF;
  v_digest := encode(sha256(v_body),'hex');
  RETURN QUERY SELECT v_snapshot,v_account,octet_length(v_body),v_digest,part,
    substring(v_body FROM part*24576+1 FOR 24576)
    FROM generate_series(0,(octet_length(v_body)-1)/24576) part;
END;
$recovery$;
REVOKE ALL ON FUNCTION app.capture_account_recovery_inventory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.capture_account_recovery_inventory() TO opengeo_runtime;
COMMENT ON FUNCTION app.capture_account_recovery_inventory() IS
  'Admin-only fixed complete account row inventory in a read-only repeatable snapshot; excludes credentials/payloads/object bytes and does not restore grants or publications.';
COMMIT;
