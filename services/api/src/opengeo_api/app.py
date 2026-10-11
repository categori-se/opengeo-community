from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from opengeo_api.archive_upload_routes import router as archive_upload_router
from opengeo_api.artifact_release_routes import router as artifact_release_router
from opengeo_api.artifact_share_routes import router as artifact_share_router
from opengeo_api.auth_routes import router as auth_router
from opengeo_api.auth_tokens import (
    CognitoTokenVerifier,
    TokenVerifier,
    UnavailableTokenVerifier,
)
from opengeo_api.authored_knowledge import PostgresAuthoredKnowledgeRepository
from opengeo_api.authored_knowledge_routes import router as authored_knowledge_router
from opengeo_api.catalog import CatalogRepository, PostgresCatalogRepository
from opengeo_api.catalog_routes import router as catalog_router
from opengeo_api.ckan_routes import router as ckan_router
from opengeo_api.cognito_provisioning import (
    AwsCognitoIdentityProvisioner,
    IdentityProvisioner,
    UnavailableIdentityProvisioner,
)
from opengeo_api.collection_routes import router as collection_router
from opengeo_api.config import Settings, get_settings
from opengeo_api.connection_routes import router as connection_router
from opengeo_api.connections import (
    AwsConnectionSecretStore,
    ExternalConnectionRepository,
    PostgresExternalConnectionRepository,
    UnavailableConnectionSecretStore,
)
from opengeo_api.coverage_routes import router as coverage_router
from opengeo_api.coverages import (
    CoverageRepository,
    PostgresCoverageRepository,
)
from opengeo_api.data_preservation import (
    DataPreservationRepository,
    PostgresDataPreservationRepository,
)
from opengeo_api.data_preservation_routes import router as data_preservation_router
from opengeo_api.dataset_repository_browser import (
    AwsLambdaUserDatasetRepositoryBrowser,
    UnavailableUserDatasetRepositoryBrowser,
    UserDatasetRepositoryBrowser,
)
from opengeo_api.discussion_routes import router as discussion_router
from opengeo_api.discussions import DiscussionRepository, PostgresDiscussionRepository
from opengeo_api.external_source_routes import router as external_source_router
from opengeo_api.external_sources import (
    ExternalSourceRepository,
    PostgresExternalSourceRepository,
)
from opengeo_api.feature_routes import router as feature_router
from opengeo_api.features import FeatureRepository, PostgresFeatureRepository
from opengeo_api.field_capture import (
    FieldCaptureRepository,
    PostgresFieldCaptureRepository,
)
from opengeo_api.field_capture_routes import router as field_capture_router
from opengeo_api.geonode_federation_routes import router as geonode_federation_router
from opengeo_api.geonode_federations import (
    GeoNodeFederationRepository,
    PostgresGeoNodeFederationRepository,
)
from opengeo_api.health import router as health_router
from opengeo_api.http_app import configure_http_boundary
from opengeo_api.ingestion import IngestionRepository, PostgresIngestionRepository
from opengeo_api.ingestion_routes import router as ingestion_router
from opengeo_api.kml_network_link_routes import (
    NetworkLinkGate,
    NetworkLinkRequestGate,
    PostgresNetworkLinkRequestGate,
)
from opengeo_api.kml_network_link_routes import (
    router as kml_network_link_router,
)
from opengeo_api.kml_network_links import NetworkLinkFetcher
from opengeo_api.layer_archive_access import router as layer_archive_router
from opengeo_api.location_links import PostgresLocationLinksRepository
from opengeo_api.location_routes import router as location_router
from opengeo_api.logging import configure_logging
from opengeo_api.managed_display_access import router as managed_display_router
from opengeo_api.membership_routes import router as membership_router
from opengeo_api.memberships import (
    MembershipRepository,
    PostgresMembershipRepository,
)
from opengeo_api.metadata_profiles import (
    MetadataProfileRepository,
    PostgresMetadataProfileRepository,
)
from opengeo_api.metadata_routes import router as metadata_router
from opengeo_api.observable_previews import (
    PreviewCookieSigner,
    SecretsManagerPreviewCookieSigner,
    UnavailablePreviewCookieSigner,
)
from opengeo_api.observable_source_routes import router as observable_source_router
from opengeo_api.observable_sources import (
    ObservableSourceRepository,
    PostgresObservableSourceRepository,
)
from opengeo_api.ogc_feature_routes import router as ogc_feature_router
from opengeo_api.organization_routes import router as organization_router
from opengeo_api.organizations import (
    OrganizationRepository,
    PostgresOrganizationRepository,
    UnavailableOrganizationRepository,
)
from opengeo_api.portable_artifact_cleanup_aws import AwsPortableCleanupStorage
from opengeo_api.principals import (
    PostgresPrincipalRepository,
    PrincipalRepository,
    RdsDataApiPrincipalRepository,
    UnavailablePrincipalRepository,
)
from opengeo_api.processing_dispatch import (
    AwsSqsConnectionVerificationDispatcher,
    AwsSqsExternalSourceDiscoveryDispatcher,
    AwsSqsExternalSourceSnapshotDispatcher,
    AwsSqsGeoNodeHarvestDispatcher,
    AwsSqsObservableBuildDispatcher,
    AwsSqsPmtilesDerivativeDispatcher,
    AwsSqsRenderDispatcher,
    AwsSqsRepositoryObjectCopyDispatcher,
    AwsSqsUserDatasetVerificationDispatcher,
    ConnectionVerificationDispatcher,
    ExternalSourceDiscoveryDispatcher,
    ExternalSourceSnapshotDispatcher,
    GeoNodeHarvestDispatcher,
    ObservableBuildDispatcher,
    PmtilesDerivativeDispatcher,
    RenderDispatcher,
    RepositoryObjectCopyDispatcher,
    UnavailableConnectionVerificationDispatcher,
    UnavailableExternalSourceDiscoveryDispatcher,
    UnavailableExternalSourceSnapshotDispatcher,
    UnavailableGeoNodeHarvestDispatcher,
    UnavailableObservableBuildDispatcher,
    UnavailablePmtilesDerivativeDispatcher,
    UnavailableRenderDispatcher,
    UnavailableRepositoryObjectCopyDispatcher,
    UnavailableUserDatasetVerificationDispatcher,
    UserDatasetVerificationDispatcher,
)
from opengeo_api.processing_routes import router as processing_router
from opengeo_api.project_import_routes import router as project_import_router
from opengeo_api.project_imports import (
    PostgresProjectImportRepository,
    ProjectImportRepository,
)
from opengeo_api.public_catalog import (
    PostgresPublicCatalogRepository,
    PublicCatalogRepository,
)
from opengeo_api.public_catalog_routes import router as public_catalog_router
from opengeo_api.rds_data import RdsDataApiClient
from opengeo_api.readiness import DatabaseReadinessProbe, RdsDataApiReadinessProbe, ReadinessProbe
from opengeo_api.record_routes import router as record_router
from opengeo_api.render_routes import router as render_router
from opengeo_api.rendering import PostgresRenderRepository, RenderRepository
from opengeo_api.resource_rating_routes import router as resource_rating_router
from opengeo_api.resource_ratings import (
    PostgresResourceRatingRepository,
    ResourceRatingRepository,
)
from opengeo_api.resource_routes import router as resource_router
from opengeo_api.resources import PostgresResourceRepository, ResourceRepository
from opengeo_api.s3_downloads import (
    AwsS3DownloadStorage,
    DownloadStorage,
    UnavailableDownloadStorage,
)
from opengeo_api.s3_uploads import AwsS3UploadStorage, UnavailableUploadStorage, UploadStorage
from opengeo_api.site_publications import (
    PostgresSitePublicationRepository,
    SitePublicationRepository,
)
from opengeo_api.site_routes import router as site_router
from opengeo_api.source_discoveries import (
    PostgresSourceDiscoveryRepository,
    SourceDiscoveryRepository,
)
from opengeo_api.source_discovery_routes import router as source_discovery_router
from opengeo_api.spatial_catalog_admin import (
    PostgresSpatialCatalogRepository,
    SpatialCatalogRepository,
)
from opengeo_api.spatial_catalog_routes import router as spatial_catalog_router
from opengeo_api.spatial_service_routes import router as spatial_service_router
from opengeo_api.spatial_services import (
    PostgresSpatialServiceRepository,
    SpatialServiceRepository,
)
from opengeo_api.stac_routes import router as stac_router
from opengeo_api.team_routes import router as team_router
from opengeo_api.teams import PostgresTeamRepository, TeamRepository
from opengeo_api.tenant_database import (
    PostgresTenantQueryExecutor,
    PostgresUserQueryExecutor,
    RdsDataApiTenantQueryExecutor,
    RdsDataApiUserQueryExecutor,
    TenantTransactionExecutor,
    UserQueryExecutor,
)
from opengeo_api.tile_cache_routes import router as tile_cache_router
from opengeo_api.user_basemap_connection_routes import router as user_basemap_connection_router
from opengeo_api.user_basemap_connections import (
    PostgresUserBasemapConnectionRepository,
    UserBasemapConnectionRepository,
)
from opengeo_api.user_connection_routes import router as user_connection_router
from opengeo_api.user_connections import (
    PostgresUserDatasetConnectionRepository,
    UserDatasetConnectionRepository,
)
from opengeo_api.version import __version__
from opengeo_api.wfs_routes import router as wfs_router
from opengeo_api.workspace_collections import PostgresCollectionRepository
from opengeo_api.workspace_locations import PostgresLocationRepository
from opengeo_api.workspace_routes import router as workspace_router
from opengeo_api.workspaces import PostgresWorkspaceRepository, WorkspaceRepository


def create_app(
    settings: Settings | None = None,
    readiness_probe: ReadinessProbe | None = None,
    token_verifier: TokenVerifier | None = None,
    principal_repository: PrincipalRepository | None = None,
    organization_repository: OrganizationRepository | None = None,
    workspace_repository: WorkspaceRepository | None = None,
    membership_repository: MembershipRepository | None = None,
    identity_provisioner: IdentityProvisioner | None = None,
    ingestion_repository: IngestionRepository | None = None,
    external_source_repository: ExternalSourceRepository | None = None,
    project_import_repository: ProjectImportRepository | None = None,
    upload_storage: UploadStorage | None = None,
    catalog_repository: CatalogRepository | None = None,
    download_storage: DownloadStorage | None = None,
    resource_repository: ResourceRepository | None = None,
    resource_rating_repository: ResourceRatingRepository | None = None,
    public_catalog_repository: PublicCatalogRepository | None = None,
    page_source_upload_storage: UploadStorage | None = None,
    page_source_download_storage: DownloadStorage | None = None,
    metadata_profile_repository: MetadataProfileRepository | None = None,
    feature_repository: FeatureRepository | None = None,
    field_capture_repository: FieldCaptureRepository | None = None,
    spatial_service_repository: SpatialServiceRepository | None = None,
    spatial_catalog_repository: SpatialCatalogRepository | None = None,
    coverage_repository: CoverageRepository | None = None,
    data_preservation_repository: DataPreservationRepository | None = None,
    render_repository: RenderRepository | None = None,
    render_dispatcher: RenderDispatcher | None = None,
    external_source_snapshot_dispatcher: ExternalSourceSnapshotDispatcher | None = None,
    repository_object_copy_dispatcher: RepositoryObjectCopyDispatcher | None = None,
    source_discovery_repository: SourceDiscoveryRepository | None = None,
    external_source_discovery_dispatcher: ExternalSourceDiscoveryDispatcher | None = None,
    geonode_federation_repository: GeoNodeFederationRepository | None = None,
    geonode_harvest_dispatcher: GeoNodeHarvestDispatcher | None = None,
    pmtiles_derivative_dispatcher: PmtilesDerivativeDispatcher | None = None,
    site_publication_repository: SitePublicationRepository | None = None,
    observable_source_repository: ObservableSourceRepository | None = None,
    observable_build_dispatcher: ObservableBuildDispatcher | None = None,
    observable_preview_cookie_signer: PreviewCookieSigner | None = None,
    connection_repository: ExternalConnectionRepository | None = None,
    connection_verification_dispatcher: ConnectionVerificationDispatcher | None = None,
    user_dataset_verification_dispatcher: UserDatasetVerificationDispatcher | None = None,
    team_repository: TeamRepository | None = None,
    discussion_repository: DiscussionRepository | None = None,
    user_connection_repository: UserDatasetConnectionRepository | None = None,
    user_dataset_repository_browser: UserDatasetRepositoryBrowser | None = None,
    user_basemap_connection_repository: UserBasemapConnectionRepository | None = None,
    kml_network_link_fetcher: NetworkLinkFetcher | None = None,
    kml_network_link_request_gate: NetworkLinkGate | None = None,
) -> FastAPI:
    runtime_settings = settings or get_settings()
    configure_logging(runtime_settings.log_level)

    data_api_client = (
        RdsDataApiClient(runtime_settings) if runtime_settings.data_api_configured else None
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        if data_api_client is None:
            yield
        else:
            async with data_api_client.connection_scope():
                yield

    app = FastAPI(
        lifespan=lifespan,
        title="OpenGeo API",
        version=__version__,
        docs_url="/docs" if runtime_settings.expose_docs else None,
        redoc_url=None,
        openapi_url="/openapi.json" if runtime_settings.expose_docs else None,
    )
    app.state.settings = runtime_settings
    if data_api_client is not None:
        tenant_executor: TenantTransactionExecutor = RdsDataApiTenantQueryExecutor(
            runtime_settings, data_api_client
        )
        user_executor: UserQueryExecutor = RdsDataApiUserQueryExecutor(
            runtime_settings, data_api_client
        )
        default_readiness: ReadinessProbe = RdsDataApiReadinessProbe(
            runtime_settings, data_api_client
        )
        default_principal: PrincipalRepository = RdsDataApiPrincipalRepository(
            runtime_settings, data_api_client
        )
    else:
        tenant_executor = PostgresTenantQueryExecutor(runtime_settings)
        user_executor = PostgresUserQueryExecutor(runtime_settings)
        default_readiness = DatabaseReadinessProbe(runtime_settings)
        default_principal = (
            PostgresPrincipalRepository(runtime_settings)
            if runtime_settings.direct_database_configured
            else UnavailablePrincipalRepository()
        )
    app.state.readiness_probe = readiness_probe or default_readiness
    app.state.token_verifier = token_verifier or (
        CognitoTokenVerifier(runtime_settings)
        if runtime_settings.auth_configured
        else UnavailableTokenVerifier()
    )
    app.state.principal_repository = principal_repository or default_principal
    app.state.organization_repository = organization_repository or (
        PostgresOrganizationRepository(tenant_executor)
        if runtime_settings.database_configured
        else UnavailableOrganizationRepository()
    )
    app.state.collection_repository = PostgresCollectionRepository(tenant_executor)
    app.state.authored_knowledge_repository = PostgresAuthoredKnowledgeRepository(
        tenant_executor, app.state.collection_repository
    )
    app.state.location_repository = PostgresLocationRepository(tenant_executor)
    app.state.workspace_repository = workspace_repository or PostgresWorkspaceRepository(
        tenant_executor
    )
    provisioner = identity_provisioner or (
        AwsCognitoIdentityProvisioner(runtime_settings)
        if runtime_settings.auth_configured and runtime_settings.cognito_provisioning_enabled
        else UnavailableIdentityProvisioner()
    )
    app.state.membership_repository = membership_repository or PostgresMembershipRepository(
        tenant_executor,
        user_executor,
        provisioner,
    )
    storage = upload_storage or (
        AwsS3UploadStorage(runtime_settings)
        if runtime_settings.upload_configured
        else UnavailableUploadStorage()
    )
    app.state.ingestion_repository = ingestion_repository or PostgresIngestionRepository(
        tenant_executor, storage
    )
    app.state.location_links_repository = PostgresLocationLinksRepository(
        tenant_executor,
        app.state.location_repository,
        app.state.collection_repository,
        app.state.ingestion_repository,
    )
    app.state.external_source_repository = (
        external_source_repository or PostgresExternalSourceRepository(tenant_executor)
    )
    app.state.project_import_repository = (
        project_import_repository or PostgresProjectImportRepository(tenant_executor)
    )
    downloads = download_storage or (
        AwsS3DownloadStorage(runtime_settings)
        if runtime_settings.upload_configured
        else UnavailableDownloadStorage()
    )
    app.state.download_storage = downloads
    app.state.catalog_repository = catalog_repository or PostgresCatalogRepository(
        tenant_executor, downloads
    )
    source_uploads = page_source_upload_storage or (
        AwsS3UploadStorage(runtime_settings, bucket=runtime_settings.application_bucket)
        if runtime_settings.source_upload_configured
        else UnavailableUploadStorage()
    )
    source_downloads = page_source_download_storage or (
        AwsS3DownloadStorage(runtime_settings, bucket=runtime_settings.application_bucket)
        if runtime_settings.source_upload_configured
        else UnavailableDownloadStorage()
    )
    app.state.resource_repository = resource_repository or PostgresResourceRepository(
        tenant_executor, source_uploads, source_downloads
    )
    app.state.resource_rating_repository = (
        resource_rating_repository or PostgresResourceRatingRepository(tenant_executor)
    )
    app.state.public_catalog_repository = (
        public_catalog_repository or PostgresPublicCatalogRepository(tenant_executor, downloads)
    )
    app.state.metadata_profile_repository = (
        metadata_profile_repository or PostgresMetadataProfileRepository(tenant_executor)
    )
    app.state.feature_repository = feature_repository or PostgresFeatureRepository(tenant_executor)
    app.state.field_capture_repository = field_capture_repository or PostgresFieldCaptureRepository(
        tenant_executor
    )
    app.state.spatial_service_repository = (
        spatial_service_repository or PostgresSpatialServiceRepository(tenant_executor)
    )
    app.state.spatial_catalog_repository = (
        spatial_catalog_repository or PostgresSpatialCatalogRepository(tenant_executor)
    )
    app.state.coverage_repository = coverage_repository or PostgresCoverageRepository(
        tenant_executor, downloads
    )
    app.state.data_preservation_repository = (
        data_preservation_repository
        or PostgresDataPreservationRepository(tenant_executor, runtime_settings.geodata_bucket)
    )
    app.state.render_repository = render_repository or PostgresRenderRepository(
        tenant_executor,
        downloads,
        artifact_uploads=source_uploads if runtime_settings.portable_artifacts_enabled else None,
        artifact_downloads=source_downloads
        if runtime_settings.portable_artifacts_enabled
        else None,
        artifact_cleanup=(
            AwsPortableCleanupStorage("us-east-1", runtime_settings.application_bucket or "")
            if runtime_settings.portable_artifacts_enabled
            else None
        ),
        saved_map_gl_enabled=runtime_settings.saved_map_gl_enabled,
        saved_map_gl_runtime_reference=runtime_settings.saved_map_gl_runtime_reference,
    )
    app.state.render_dispatcher = render_dispatcher or (
        AwsSqsRenderDispatcher(runtime_settings)
        if runtime_settings.render_dispatch_configured
        else UnavailableRenderDispatcher()
    )
    app.state.external_source_snapshot_dispatcher = external_source_snapshot_dispatcher or (
        AwsSqsExternalSourceSnapshotDispatcher(runtime_settings)
        if runtime_settings.external_source_snapshot_dispatch_configured
        else UnavailableExternalSourceSnapshotDispatcher()
    )
    app.state.repository_object_copy_dispatcher = repository_object_copy_dispatcher or (
        AwsSqsRepositoryObjectCopyDispatcher(runtime_settings)
        if runtime_settings.repository_object_copy_dispatch_configured
        else UnavailableRepositoryObjectCopyDispatcher()
    )
    app.state.source_discovery_repository = (
        source_discovery_repository or PostgresSourceDiscoveryRepository(tenant_executor)
    )
    app.state.external_source_discovery_dispatcher = external_source_discovery_dispatcher or (
        AwsSqsExternalSourceDiscoveryDispatcher(runtime_settings)
        if runtime_settings.external_source_discovery_dispatch_configured
        else UnavailableExternalSourceDiscoveryDispatcher()
    )
    app.state.geonode_federation_repository = (
        geonode_federation_repository or PostgresGeoNodeFederationRepository(tenant_executor)
    )
    app.state.geonode_harvest_dispatcher = geonode_harvest_dispatcher or (
        AwsSqsGeoNodeHarvestDispatcher(runtime_settings)
        if runtime_settings.external_source_snapshot_dispatch_configured
        else UnavailableGeoNodeHarvestDispatcher()
    )
    app.state.pmtiles_derivative_dispatcher = pmtiles_derivative_dispatcher or (
        AwsSqsPmtilesDerivativeDispatcher(runtime_settings)
        if runtime_settings.render_dispatch_configured
        else UnavailablePmtilesDerivativeDispatcher()
    )
    app.state.site_publication_repository = (
        site_publication_repository or PostgresSitePublicationRepository(tenant_executor)
    )
    app.state.observable_source_repository = (
        observable_source_repository
        or PostgresObservableSourceRepository(
            tenant_executor,
            source_uploads,
            runtime_settings.observable_builder_image_digest,
            source_downloads,
            github_builds=runtime_settings.observable_build_provider == "github",
            artifact_builds=runtime_settings.publication_artifact_builds_enabled,
        )
    )
    app.state.observable_build_dispatcher = observable_build_dispatcher or (
        AwsSqsObservableBuildDispatcher(runtime_settings)
        if runtime_settings.observable_build_dispatch_configured
        else UnavailableObservableBuildDispatcher()
    )
    app.state.observable_preview_cookie_signer = observable_preview_cookie_signer or (
        SecretsManagerPreviewCookieSigner(runtime_settings)
        if runtime_settings.observable_preview_signing_configured
        else UnavailablePreviewCookieSigner()
    )
    connection_secret_store = (
        AwsConnectionSecretStore(runtime_settings)
        if runtime_settings.upload_configured
        else UnavailableConnectionSecretStore()
    )
    app.state.connection_repository = connection_repository or (
        PostgresExternalConnectionRepository(tenant_executor, connection_secret_store)
    )
    app.state.user_connection_repository = user_connection_repository or (
        PostgresUserDatasetConnectionRepository(tenant_executor, connection_secret_store)
    )
    app.state.user_dataset_repository_browser = user_dataset_repository_browser or (
        AwsLambdaUserDatasetRepositoryBrowser(runtime_settings)
        if runtime_settings.user_dataset_repository_browser_configured
        else UnavailableUserDatasetRepositoryBrowser()
    )
    app.state.user_basemap_connection_repository = user_basemap_connection_repository or (
        PostgresUserBasemapConnectionRepository(tenant_executor, connection_secret_store)
    )
    app.state.connection_verification_dispatcher = connection_verification_dispatcher or (
        AwsSqsConnectionVerificationDispatcher(runtime_settings)
        if runtime_settings.connection_verification_dispatch_configured
        else UnavailableConnectionVerificationDispatcher()
    )
    app.state.user_dataset_verification_dispatcher = user_dataset_verification_dispatcher or (
        AwsSqsUserDatasetVerificationDispatcher(runtime_settings)
        if runtime_settings.user_dataset_verification_dispatch_configured
        else UnavailableUserDatasetVerificationDispatcher()
    )
    app.state.team_repository = team_repository or PostgresTeamRepository(tenant_executor)
    app.state.discussion_repository = discussion_repository or PostgresDiscussionRepository(
        tenant_executor
    )
    app.state.kml_network_link_fetcher = kml_network_link_fetcher or NetworkLinkFetcher()
    app.state.kml_network_link_request_gate = kml_network_link_request_gate or (
        PostgresNetworkLinkRequestGate(tenant_executor)
        if runtime_settings.database_configured
        else NetworkLinkRequestGate()
    )

    configure_http_boundary(app)
    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(processing_router)
    app.include_router(organization_router)
    app.include_router(workspace_router)
    app.include_router(collection_router)
    app.include_router(authored_knowledge_router)
    app.include_router(location_router)
    app.include_router(membership_router)
    app.include_router(team_router)
    app.include_router(discussion_router)
    app.include_router(user_connection_router)
    app.include_router(user_basemap_connection_router)
    app.include_router(ingestion_router)
    app.include_router(external_source_router)
    app.include_router(data_preservation_router)
    app.include_router(source_discovery_router)
    app.include_router(geonode_federation_router)
    app.include_router(connection_router)
    app.include_router(project_import_router)
    app.include_router(catalog_router)
    app.include_router(ckan_router)
    app.include_router(resource_router)
    app.include_router(resource_rating_router)
    app.include_router(public_catalog_router)
    app.include_router(artifact_release_router)
    app.include_router(artifact_share_router)
    app.include_router(metadata_router)
    app.include_router(record_router)
    app.include_router(stac_router)
    app.include_router(feature_router)
    app.include_router(field_capture_router)
    app.include_router(archive_upload_router)
    app.include_router(layer_archive_router)
    app.include_router(managed_display_router)
    app.include_router(ogc_feature_router)
    app.include_router(spatial_service_router)
    app.include_router(spatial_catalog_router)
    app.include_router(coverage_router)
    app.include_router(tile_cache_router)
    app.include_router(wfs_router)
    app.include_router(render_router)
    app.include_router(site_router)
    app.include_router(observable_source_router)
    if runtime_settings.kml_network_link_fetch_enabled:
        app.include_router(kml_network_link_router)
    return app
