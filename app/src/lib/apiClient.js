import {pendingSessionRequest} from "./pendingSessionRequest.js";
import {ckanUrl, ckanId, parseCkanSearch, parseCkanInspection, parseCkanPreview} from "./ckan.js";
import {validateCalculation, evaluateCalculation} from "./fieldCalculations.js";
import {featureFieldVisible} from "./featureFieldVisibility.js";
import {archiveUploadApi} from "./archiveUploadApi.js";
import {emptyMapDefinition} from "./mapDefinition.js";
import {collectionDefinitionFromApi, collectionOwnerFromApi} from "./collectionReferences.js";
import {staticHtmlPublishingEnabled, jupyterPublishingEnabled, observableNotebookPublishingEnabled} from "./publicationDrafts.js";
import {
  assertFeatureQuerySha256,
  featureQuerySha256,
  normalizeFeatureQuery,
  parseFeatureQueryReceipt
} from "./featureQuery.js";

/**
 * @typedef {{organizationId: string, role: "admin" | "member" | "guest"}} OrganizationMembership
 * @typedef {{userId: string, email: string, displayName: string, memberships: OrganizationMembership[], selectedOrganizationId: string | null, selectedOrganizationRole: string | null}} Session
 * @typedef {{id: string, name: string, slug: string, status: "active" | "archived", callerRole: "admin" | "member" | "guest"}} Organization
 * @typedef {{id: string, name: string, clientCode: string | null, description: string | null, status: "active" | "archived", createdAt: string, updatedAt: string}} Client
 * @typedef {{id: string, clientId: string | null, name: string, projectCode: string | null, description: string | null, status: "active" | "archived", createdAt: string, updatedAt: string, callerRole: "owner" | "editor" | "reviewer" | "viewer" | null}} Project
 * @typedef {{id: string, projectId: string, name: string, description: string | null, status: "active" | "archived", definition: Record<string, unknown>, version: number, createdAt: string, updatedAt: string, ownerUserId: string | null}} MapRecord
 * @typedef {Project & {lastActivityAt: string, lastEventType: string}} RecentProject
 * @typedef {{code: string, status: string | null}} QualityFinding
 * @typedef {{valid: boolean | null, checks: QualityFinding[], warnings: QualityFinding[], errors: QualityFinding[]}} QualityResults
 * @typedef {{read: boolean, edit: boolean, download: boolean, managePermissions: boolean}} DatasetCapabilities
 * @typedef {{id: string, projectId: string, name: string, description: string | null, classification: "public" | "internal" | "confidential" | "restricted", sourceType: "upload" | "xyz" | "wms" | "pmtiles" | "geojson" | "arcgis" | "wfs", format: "geojson" | "csv" | "shapefile" | "geopackage" | "geoparquet" | "cog" | "pmtiles" | "png" | "jpeg" | "pdf" | "odt" | "kml" | "xyz" | "wms" | "arcgis" | "wfs", status: "draft" | "processing" | "active" | "failed" | "archived", ownerUserId: string, currentVersionId: string | null, currentVersionNumber: number | null, currentVersionState: "queued" | "processing" | "active" | "failed" | null, featureCount: number | null, extent: number[] | null, crs: string | null, geometryType: string | null, qualityResults: QualityResults, processingJobState: "queued" | "running" | "completed" | "failed" | "cancelled" | null, processingErrorCode: string | null, tags: string[], createdAt: string, updatedAt: string, capabilities: DatasetCapabilities}} Dataset
 * @typedef {{datasetId: string, projectId: string, name: string, description: string | null, classification: "public" | "internal" | "confidential" | "restricted", status: "draft" | "processing" | "active" | "failed" | "archived", ownerUserId: string, sourceType: "xyz" | "wms" | "pmtiles" | "geojson" | "arcgis" | "wfs", accessMode: "direct_browser", credentialMode: "none", versionNumber: number, sourceUrl: string, configuration: Record<string, unknown>, verificationState: "syntax_only", createdAt: string, updatedAt: string, capabilities: {read: boolean, edit: boolean}}} ExternalSource
 * @typedef {{estimateId: string, projectId: string, sourceDatasetId: string, sourceRevisionNumber: number, sourceType: "wms" | "pmtiles" | "arcgis" | "wfs", copyMethod: "bounded_map_capture" | "exact_object_copy" | "bounded_feature_capture", captureScope: Record<string, unknown>, outputFormat: "png" | "pmtiles" | "geojson", outputContentType: "image/png" | "application/vnd.pmtiles" | "application/geo+json", maximumRequests: number, maximumOutputBytes: number, estimatedCostUsd: number, estimateChecksumSha256: string, createdAt: string, expiresAt: string}} ExternalSourceCopyEstimate
 * @typedef {{jobId: string, projectId: string, estimateId: string, sourceDatasetId: string, sourceRevisionNumber: number, destinationDatasetId: string, destinationName: string, destinationClassification: "public" | "internal" | "confidential" | "restricted", copyMethod: "bounded_map_capture" | "exact_object_copy" | "bounded_feature_capture", captureScope: Record<string, unknown>, outputFormat: "png" | "pmtiles" | "geojson", outputContentType: "image/png" | "application/vnd.pmtiles" | "application/geo+json", maximumRequests: number, maximumOutputBytes: number, estimatedCostUsd: number, estimateChecksumSha256: string, estimateExpiresAt: string, rightsBasis: string, attribution: string, requestChecksumSha256: string, idempotencyKey: string, state: "queued" | "running" | "completed" | "failed" | "cancelled", outputObjectId: string | null, outputDatasetVersionId: string | null, errorCode: string | null, attemptCount: number, createdBy: string, createdAt: string, startedAt: string | null, finishedAt: string | null, cancellable: boolean}} ProtectedCopyJob
 * @typedef {{jobId: string, projectId: string, datasetId: string, datasetVersionId: string, sourceObjectId: string, bounds: [number, number, number, number], minZoom: number, maxZoom: number, sourceLayer: string, requestChecksumSha256: string, idempotencyKey: string, state: "queued" | "running" | "completed" | "failed" | "cancelled", outputObjectId: string | null, outputSizeBytes: number | null, outputChecksumSha256: string | null, errorCode: string | null, attemptCount: number, createdBy: string, createdAt: string, startedAt: string | null, finishedAt: string | null, cancellable: boolean}} PmtilesDerivativeJob
 * @typedef {{id: string, role: "original" | "working" | "published" | "tile" | "derived" | "thumbnail", filename: string, contentType: string, sizeBytes: number, checksumSha256: string, createdAt: string}} DatasetObject
 * @typedef {{id: string, versionNumber: number, parentVersionId: string | null, state: "queued" | "processing" | "active" | "failed", changeMessage: string | null, featureCount: number | null, extent: number[] | null, crs: string | null, geometryType: string | null, schemaDefinition: Record<string, unknown>, qualityResults: QualityResults, createdBy: string, createdAt: string, current: boolean, objects: DatasetObject[]}} DatasetVersion
 * @typedef {{kind: "managed_upload" | "external_source_archive" | "repository_object_copy", operationId: string, sourceDatasetId: string | null, sourceDatasetName: string | null, sourceRevisionNumber: number | null, inputObjectId: string, acquiredAt: string}} DatasetLineageOrigin
 * @typedef {{kind: "pmtiles", operationId: string, recipe: "gdal-pmtiles-v1", sourceObjectId: string, outputObjectId: string, bounds: [number, number, number, number], minimumZoom: number, maximumZoom: number, sourceLayer: string, requestChecksumSha256: string, createdAt: string}} DatasetDerivativeLineage
 * @typedef {{schemaVersion: "opengeo.dataset-version-lineage.1.0.0", datasetId: string, versionId: string, versionNumber: number, origins: DatasetLineageOrigin[], derivatives: DatasetDerivativeLineage[], derivativesTruncated: boolean}} DatasetVersionLineage
 * @typedef {{schemaVersion: "opengeo.spatial-preview.1.0.0", datasetVersionId: string, numberReturned: number, numberMatched: number | null, mayBeTruncated: boolean, geojson: {type: "FeatureCollection", features: object[]}}} SpatialPreview
 * @typedef {({schemaVersion: "opengeo.document-preview.1.0.0", sourceFormat: "odt", odfVersion: "1.2" | "1.3" | "1.4"} | {schemaVersion: "opengeo.document-preview.2.0.0" | "opengeo.document-preview.3.0.0" | "opengeo.pdf-visual-presentation.1.0.0" | "opengeo.pdf-visual-presentation.2.0.0", sourceFormat: "pdf", pdfVersion: "1.0" | "1.1" | "1.2" | "1.3" | "1.4" | "1.5" | "1.6" | "1.7" | "2.0", extraction: Record<string, unknown>, rendering?: {engine: "poppler-pdftoppm", mediaType: "image/jpeg", annotationsHidden: true, colorSpace: "rgb", pageCount: number, targetMaximumDimension: number, totalPixels: number, totalImageBytes: number}}) & {title: string | null, language: string | null, pages: {number: number, textSource?: "embedded" | "ocr" | "none", width?: number, height?: number, imageBase64?: string, imageSha256?: string, blocks: Record<string, unknown>[]}[]}} DocumentPreview
 * @typedef {{userId: string, email: string, displayName: string, role: "manage" | "edit" | "view" | "download", grantedBy: string, createdAt: string, updatedAt: string}} DatasetPermission
 * @typedef {{field: string, equals?: string | number | boolean, value_field?: string, operator?: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"}} FeatureFieldCondition
 * @typedef {{name: string, type: "string" | "integer" | "number" | "boolean", required: boolean, label: string | null, description: string | null, choices: string[], minimum: number | null, maximum: number | null, minLength: number | null, maxLength: number | null, visibleWhen: FeatureFieldCondition | null}} FeatureField
 * @typedef {{datasetId: string, geometryType: "Point" | "MultiPoint" | "LineString" | "MultiLineString" | "Polygon" | "MultiPolygon", fields: FeatureField[], generation: number, featureCount: number, createdBy: string, createdAt: string, updatedBy: string, updatedAt: string}} FeatureCollectionMetadata
 * @typedef {{type: "Feature", id: string, bbox: number[], geometry: Record<string, unknown>, properties: Record<string, unknown>, version: number, collectionGeneration: number | null, createdBy: string, createdAt: string, updatedBy: string, updatedAt: string}} GovernedFeature
 * @typedef {{featureId: string, featureVersion: number, lockToken: string | null, heldByCurrentUser: boolean, acquiredAt: string, expiresAt: string}} FeatureLock
 * @typedef {{featureId: string, deletedVersion: number, deletedBy: string, deletedAt: string, updatedAt: string}} FeatureTombstone
 * @typedef {{id: string, datasetId: string, version: number, title: string, instructions: string | null, collectionGeneration: number, geometryType: "Point" | "MultiPoint" | "LineString" | "MultiLineString" | "Polygon" | "MultiPolygon", fields: FeatureField[], createdBy: string, createdAt: string, updatedBy: string, updatedAt: string}} FieldForm
 * @typedef {{id: string, datasetId: string, formId: string, formVersion: number, supersedesSubmissionId: string | null, operation: "create" | "update", targetFeatureId: string | null, targetFeatureVersion: number | null, payloadSha256: string, feature: {type: "Feature", id: string, geometry: Record<string, unknown>, properties: Record<string, unknown>}, state: "submitted" | "in_review" | "changes_requested" | "rejected" | "accepted", reviewVersion: number, submittedBy: string, submittedAt: string, reviewedBy: string | null, reviewedAt: string | null, reviewMessage: string | null, promotedFeatureId: string | null}} FieldSubmission
 * @typedef {{url: string, method: "GET", expiresAt: string}} DownloadTicket
 * @typedef {{url: string, method: "POST", fields: Record<string, string>}} UploadInstructions
 * @typedef {{uploadId: string, dataset: Dataset, expiresAt: string, upload: UploadInstructions}} UploadTicket
 * @typedef {{dataset: Dataset, datasetVersionId: string, versionNumber: number, processingJobId: string, processingJobState: "queued" | "running" | "completed" | "failed" | "cancelled"}} UploadCompletion
 * @typedef {{importRef: string, kind: "external_source" | "embedded_dataset", expectedSourceType: string, expectedFormat: string, candidate: Record<string, unknown>, state: "pending" | "bound", datasetId: string | null, boundAt: string | null}} ProjectImportItem
 * @typedef {{importId: string, projectId: string, mapId: string, idempotencyKey: string, sourceProduct: "geolibre", sourceVersion: string, sourceSha256: string, planDigest: string, expectedMapVersion: number, state: "open" | "completed", ready: boolean, unresolvedImportRefs: string[], items: ProjectImportItem[], createdBy: string, createdAt: string, updatedAt: string, completedAt: string | null, finalMapVersion: number | null}} ProjectImport
 * @typedef {{id: string, projectId: string, kind: "dataset" | "map" | "document" | "story" | "dashboard" | "service", slug: string, datasetId: string | null, mapId: string | null, visibility: "restricted" | "organization" | "public", state: "draft" | "review" | "published" | "archived", versionNumber: number, title: string, abstract: string | null, language: string, license: string | null, attribution: string | null, keywords: string[], spatialExtent: number[] | null, temporalStart: string | null, temporalEnd: string | null, ownerUserId: string, originNamespace: string | null, originIdentifier: string | null, relationshipCount: number, createdAt: string, updatedAt: string}} ResourceSummary
 * @typedef {{mapId: string, mapVersionId: string, mapVersion: number, definitionChecksumSha256: string}} ResourceMapSnapshot
 * @typedef {ResourceSummary & {currentVersionId?: string | null, mapSnapshot: ResourceMapSnapshot | null, metadataProfile: string, metadataExtensions: Record<string, unknown>, translations: Record<string, Record<string, unknown>>, managedMetadataProfileId: string | null, managedMetadataProfileVersion: number | null, metadataValidation: Record<string, unknown> | null, content: Record<string, unknown>, provenance: Record<string, unknown>, changeMessage: string | null, versionCreatedBy: string, versionCreatedAt: string, externalIdentifiers: Record<string, unknown>[], relationships: Record<string, unknown>[]}} GovernedResource
 * @typedef {{id: string, kind: "dataset" | "map" | "document" | "story" | "dashboard" | "service", slug: string, versionNumber: number, title: string, abstract: string | null, language: string, license: string | null, attribution: string | null, keywords: string[], spatialExtent: number[] | null, temporalStart: string | null, temporalEnd: string | null, createdAt: string, community: {organizationId: string, organizationSlug: string, organizationName: string, projectId: string, projectName: string}, preview: {kind: "map" | "dataset" | "dataset-document" | "document" | "metadata", href: string}, freshness: {catalogUpdatedAt: string, sourceObservedAt: string | null, sourceVersion: string | null}, provenance: {namespace: string | null, identifier: string | null}, relationships: {publicCount: number, detailHref: string}, ratings: {count: number, average: number | null}} PublicCatalogRecord
 * @typedef {{schemaVersion: "opengeo.public-catalog.1.5.0", numberReturned: number, numberMatched: number, limit: number, offset: number, nextOffset: number | null, facetSampleSize: number, facetsTruncated: boolean, facets: Record<string, {value: string, label: string, count: number}[]>, records: PublicCatalogRecord[]}} PublicCatalogPage
 * @typedef {{schemaVersion: "opengeo.public-spatial-preview.1.0.0", resourceId: string, resourceVersionNumber: number, numberReturned: number, numberMatched: number | null, mayBeTruncated: boolean, geojson: {type: "FeatureCollection", features: object[]}} PublicSpatialPreview
 * @typedef {{schemaVersion: "opengeo.public-document-preview.1.0.0", resourceId: string, resourceVersionNumber: number, resourceKind: "document" | "story" | "dashboard", rendererVersion: "opengeo-page-renderer-1.1.0", dependencyReferencesOmitted: number, html: string}} PublicDocumentPreview
 * @typedef {{schemaVersion: "opengeo.public-dataset-document-preview.1.0.0", resourceId: string, resourceVersionNumber: number, datasetVersionNumber: number, sourceFormat: "pdf" | "odt", presentationKind: "semantic" | "visual", presentation: DocumentPreview}} PublicDatasetDocumentPreview
 * @typedef {{schemaVersion: "opengeo.public-map-preview.1.0.0", resourceId: string, resourceVersionNumber: number, mapVersion: number, projection: "mercator" | "globe", colorMode: "light" | "dark", layers: {layerId: string, title: string, visible: boolean, opacity: number, order: number, style: Record<string, unknown>, labels: Record<string, unknown>, numberReturned: number, numberMatched: number | null, mayBeTruncated: boolean, geojson: {type: "FeatureCollection", features: object[]}}[]}} PublicMapPreview
 * @typedef {{projectId: string, projectName: string, siteId: string, editionId: string, listedSlug: string, title: string, description: string | null, language: string, theme: "paper" | "atlas" | "minimal", pageCount: number, publishedAt: string, isPrimary: boolean, href: string, primaryHref: string | null}} PublicSiteDirectoryRecord
 * @typedef {{schemaVersion: "opengeo.public-site-directory.1.0.0", numberReturned: number, numberMatched: number, limit: number, offset: number, nextOffset: number | null, records: PublicSiteDirectoryRecord[]}} PublicSiteDirectoryPage
 * @typedef {{id: string, resourceId: string, resourceVersionId: string, resourceVersionNumber: number, parentVersionNumber: number | null, sourceBlockId: string, bucket: string, objectKey: string, s3VersionId: string, etag: string, contentType: "text/markdown", sizeBytes: number, checksumSha256: string, dialect: "opengeo-markdown", dialectVersion: string, compilerVersion: string, changeSummary: string, createdBy: string, createdAt: string, sourceMarkdown: string | null}} PageSource
 * @typedef {{id: string, resourceId: string, ownerUserId: string, baseResourceVersion: number, revisionNumber: number, visibility: "restricted" | "organization", metadata: Record<string, unknown>, content: Record<string, unknown>, provenance: Record<string, unknown>, sourceBlockId: string | null, sourceMarkdown: string, changeSummary: string | null, documentChecksumSha256: string, createdAt: string, updatedAt: string}} PageWorkingDraft
 * @typedef {{rendererVersion: "opengeo-page-renderer-1.1.0", contentChecksumSha256: string, html: string, dependencies: Array<Record<string, unknown>>}} PagePreview
 * @typedef {{id: string, slug: string, title: string, description: string | null, versionNumber: number, definition: Record<string, unknown>, checksumSha256: string, changeMessage: string | null, createdBy: string, versionCreatedBy: string, createdAt: string, updatedAt: string, versionCreatedAt: string}} MetadataProfile
 * @typedef {{id: string, resourceId: string, resourceVersionId: string, sourceFormat: "dcat_3" | "stac_1_1" | "iso_19115_3" | "schema_org_dataset" | "datacite_4_7" | "geodcat_ap_3_1", sourceVersion: string, sourceNamespace: string, sourceIdentifier: string, document: Record<string, unknown> | string, sourceSha256: string, checksumBasis: "canonical_json" | "raw_utf8", canonicalJsonSha256: string | null, conversionReport: Record<string, unknown>, importedBy: string, importedAt: string}} MetadataSource
 * @typedef {{userId: string, email: string, displayName: string, role: "admin" | "member" | "guest"}} OrganizationMember
 * @typedef {{userId: string, email: string, displayName: string, role: "owner" | "editor" | "reviewer" | "viewer"}} ProjectMember
 * @typedef {{mapId: string, mapVersion: number, layerId: string, datasetId: string, featureId: string}} FeatureDiscussionTarget
 * @typedef {{kind: "map" | "dataset" | "resource" | "site", objectId: string, version: number}} ObjectDiscussionTarget
 * @typedef {FeatureDiscussionTarget | ObjectDiscussionTarget} DiscussionTarget
 * @typedef {{userId: string, displayName: string, projectRole: "administrator" | "owner" | "editor" | "reviewer" | "viewer"}} ProjectDiscussionParticipant
 * @typedef {{userId: string, displayName: string}} ProjectDiscussionMention
 * @typedef {{id: string, projectId: string, initialCommentId: string, title: string, state: "open" | "resolved", versionNumber: number, createdBy: string, createdByName: string, resolvedBy: string | null, resolvedByName: string | null, resolvedAt: string | null, createdAt: string, updatedAt: string, commentCount: number, latestCommentAt: string, canModerate: boolean, target: DiscussionTarget | null, assignedTo: string | null, assignedToName: string | null, assignedBy: string | null, assignedByName: string | null, assignedAt: string | null}} ProjectDiscussion
 * @typedef {{id: string, action: "redact", reason: string, actorUserId: string, actorName: string, createdAt: string}} ProjectDiscussionModeration
 * @typedef {{id: string, projectId: string, discussionId: string, body: string, createdBy: string, createdByName: string, createdAt: string, mentions: ProjectDiscussionMention[], moderation: ProjectDiscussionModeration | null}} ProjectDiscussionComment
 * @typedef {{discussionId: string, subscribed: boolean, versionNumber: number, subscribedAt: string, unsubscribedAt: string | null}} ProjectDiscussionSubscription
 * @typedef {{id: string, projectId: string, discussionId: string, discussionTitle: string, discussionVersion: number, commentId: string | null, kind: "assignment" | "mention" | "reply" | "state", actorUserId: string, actorName: string, versionNumber: number, readAt: string | null, createdAt: string}} ProjectDiscussionNotification
 * @typedef {{projectId: string, resourceId: string, ratingCount: number, ratingAverage: number | null, callerScore: number | null, callerVersion: number | null, callerWithdrawn: boolean, updatedAt: string | null}} ResourceRatingSummary
 * @typedef {{id: string, projectId: string, resourceId: string, slug: string, versionNumber: number, title: string, resourceVersionId: string, datasetId: string, datasetVersionId: string, styleId: string, styleVersionId: string, configuration: Record<string, unknown>, checksumSha256: string, changeMessage: string | null, createdBy: string, createdAt: string, updatedAt: string}} RenderProfile
 * @typedef {{id: string, projectId: string, resourceId: string, name: string, defaultProfileId: string, createdBy: string, createdAt: string, withdrawnBy: string | null, withdrawnAt: string | null}} WmsPublication
 * @typedef {{id: string, projectId: string, title: string, createdBy: string, createdAt: string, disabledBy: string | null, disabledAt: string | null}} PublicWmsService
 * @typedef {{id: string, projectId: string, slug: string, title: string, description: string | null, createdBy: string, createdAt: string, disabledBy: string | null, disabledAt: string | null}} SpatialService
 * @typedef {{id: string, projectId: string, serviceId: string, collectionName: string, datasetId: string, resourceId: string, defaultProfileId: string, sealedFeatureGeneration: number, sealedProfileVersionId: string, sealedProfileVersionNumber: number, currentFeatureGeneration: number, currentProfileVersionId: string, currentProfileVersionNumber: number, stale: boolean, targetActive: boolean, title: string, description: string | null, createdBy: string, createdAt: string, withdrawnBy: string | null, withdrawnAt: string | null}} SpatialServiceCollection
 * @typedef {{versionId: string, serviceId: string, versionNumber: number, title: string, abstract: string | null, namespaceUri: string | null, keywords: string[], fees: string | null, accessConstraints: string[], contact: Record<string, unknown>, enabledProtocols: string[], changeMessage: string | null, createdBy: string, createdAt: string}} SpatialServiceMetadata
 * @typedef {{id: string, projectId: string, serviceId: string, slug: string, title: string, description: string | null, kind: "managed_project" | "external_source" | "postgresql_connection", datasetId: string | null, externalConnectionId: string | null, sealedSourceRevisionNumber: number | null, sealedConnectionRevisionNumber: number | null, configuration: Record<string, unknown>, createdBy: string, createdAt: string, disabledBy: string | null, disabledAt: string | null}} SpatialServiceStore
 * @typedef {{id: string, projectId: string, serviceId: string, slug: string, versionId: string, versionNumber: number, title: string, description: string | null, mode: "single" | "opaque_container" | "named" | "container" | "earth_observation", memberCollectionIds: string[], changeMessage: string | null, createdBy: string, createdAt: string, updatedBy: string, updatedAt: string, disabledBy: string | null, disabledAt: string | null}} SpatialServiceLayerGroup
 * @typedef {{id: string, projectId: string, serviceId: string, collectionId: string, styleName: string, styleId: string, sealedStyleVersionId: string, sealedStyleVersionNumber: number, currentStyleVersionId: string, currentStyleVersionNumber: number, renderProfileId: string | null, sealedProfileVersionId: string | null, sealedProfileVersionNumber: number | null, currentProfileVersionId: string | null, currentProfileVersionNumber: number | null, consumable: boolean, stale: boolean, isDefault: boolean, createdBy: string, createdAt: string, withdrawnBy: string | null, withdrawnAt: string | null}} SpatialServiceCollectionStyle
 * @typedef {{metadata: SpatialServiceMetadata, stores: SpatialServiceStore[], layerGroups: SpatialServiceLayerGroup[], styles: SpatialServiceCollectionStyle[], limits: Record<string, number>, semantics: Record<string, string>}} SpatialServiceCatalog
 * @typedef {{id: string, projectId: string, serviceId: string, bindingId: string, versionId: string, versionNumber: number, minimumTileMatrix: number, maximumTileMatrix: number, maximumEntries: number, currentEntries: number, changeMessage: string | null, createdBy: string, createdAt: string, updatedBy: string, updatedAt: string, cacheMode: "seeded-cache-only", fixedInactiveComputeCost: "$0"}} TileCachePolicy
 * @typedef {{tileMatrix: number, tileRow: number, tileCol: number}} TileCoordinate
 * @typedef {{cacheId: string, cacheVersionId: string, cacheVersionNumber: number, mode: "tiles" | "bbox", bbox: [number, number, number, number] | null, minimumTileMatrix: number, maximumTileMatrix: number, requestedCount: number, existingCount: number, targetCount: number, targets: TileCoordinate[], expiresAt: string, previewChecksumSha256: string, expansionOrder: "tile_matrix,tile_row,tile_col", batchLimit: 64, confirmationRequired: true, ordinaryReadsCreateWork: false, fixedInactiveComputeCost: "$0"}} TileSeedPlanPreview
 * @typedef {{id: string, cacheId: string, cacheVersionId: string, cacheVersionNumber: number, mode: "tiles" | "bbox", bbox: [number, number, number, number] | null, minimumTileMatrix: number, maximumTileMatrix: number, requestedCount: number, existingCount: number, targetCount: number, previewChecksumSha256: string, previewExpiresAt: string, state: "preparing" | "queued" | "running" | "completed" | "failed" | "cancelled", errorCode: string | null, createdBy: string, createdAt: string, dispatchStartedAt: string | null, startedAt: string | null, finishedAt: string | null, items: Array<TileCoordinate & {position: number, renderJobId: string | null, state: string, errorCode: string | null, startedAt: string | null, finishedAt: string | null}>, cancelAvailable: boolean, activation: "explicit-confirmation-only", ordinaryReadsCreateWork: false, fixedInactiveComputeCost: "$0"}} TileSeedPlan
 * @typedef {{cacheId: string, cacheVersionId: string, cacheVersionNumber: number, minimumTileMatrix: number, maximumTileMatrix: number, maximumEntries: number, changeMessage: string | null, createdAt: string, retiredAt: string, entryCount: number, renderOutputCount: number, reclamationId: string | null, reclamationState: "queued" | "running" | "completed" | "failed" | null, reclamationTargetCount: number | null, reclamationCompletedCount: number, reclamationFailedCount: number}} RetiredTileCacheVersion
 * @typedef {{cacheId: string, cacheVersionId: string, cacheVersionNumber: number, targetCount: number, remainingEligibleTargetCount: number, targetSizeBytes: number, oldestRenderFinishedAt: string, newestRenderFinishedAt: string, expiresAt: string, previewChecksumSha256: string, physicalAction: "delete_exact_storage_versions", renderHistoryRetained: boolean, cacheHistoryRetained: boolean, ordinaryReadsCreateWork: boolean, batchLimit: number, minimumReclamationAgeHours: number, fixedInactiveComputeCost: "$0"}} TileCacheReclamationPreview
 * @typedef {{id: string, cacheId: string, cacheVersionId: string, cacheVersionNumber: number, targetCount: number, targetSizeBytes: number, state: "queued" | "running" | "completed" | "failed", errorCode: string | null, attemptCount: number, completedTargetCount: number, failedTargetCount: number, previewChecksumSha256: string, previewExpiresAt: string, createdBy: string, createdAt: string, startedAt: string | null, finishedAt: string | null}} TileCacheReclamation
 * @typedef {{id: string, projectId: string, serviceId: string, coverageName: string, datasetId: string, datasetVersionId: string, dataObjectId: string, sealedDatasetVersionNumber: number, currentDatasetVersionId: string, currentDatasetVersionNumber: number, crs: string, extent: [number, number, number, number], width: number, height: number, bandCount: number, bands: {index: number, dataType: string | null, colorInterpretation: string | null}[], contentType: "image/tiff" | "image/geotiff", sizeBytes: number, checksumSha256: string, stale: boolean, targetActive: boolean, title: string, description: string | null, createdBy: string, createdAt: string, withdrawnBy: string | null, withdrawnAt: string | null}} SpatialCoverage
 * @typedef {{id: string, projectId: string, serviceId: string, coverageId: string, coverageName: string, subsetExtent: [number, number, number, number], targetCrs: string, targetWidth: number, targetHeight: number, resampling: "nearest" | "bilinear" | "cubic", requestSchemaVersion: number, bandIndexes: number[], scaleMode: "size" | "resolution", requestedResolution: [number, number] | null, requestChecksumSha256: string, state: "queued" | "running" | "completed" | "failed" | "cancelled", outputObjectId: string | null, outputCrs: string | null, outputExtent: [number, number, number, number] | null, outputWidth: number | null, outputHeight: number | null, outputBandCount: number | null, outputBands: {index: number, sourceIndex: number, dataType: string | null, colorInterpretation: string | null}[] | null, outputContentType: "image/tiff" | null, outputSizeBytes: number | null, outputChecksumSha256: string | null, errorCode: string | null, attemptCount: number, createdBy: string, createdAt: string, startedAt: string | null, finishedAt: string | null, sourceAvailable: boolean, reclamationState: "queued" | "running" | "completed" | "failed" | null, outputAvailable: boolean}} CoverageDerivative
 * @typedef {{requestSchemaVersion: number, maximumAxisPixels: number, maximumPixels: number, maximumSamples: number, maximumRetainedJobsPerCoverage: number, maximumActiveJobsPerCoverage: number, maximumOutputBytes: number, supportedResampling: string[], cancellationStates: string[], minimumReclamationAgeHours: number, reclamationPreviewTtlSeconds: number, physicalReclamation: string, ordinaryReadsCreateWork: boolean}} CoverageProcessingPolicy
 * @typedef {{derivativeJobId: string, outputObjectId: string, sizeBytes: number, checksumSha256: string, derivativeFinishedAt: string, expiresAt: string, previewChecksumSha256: string, physicalAction: "delete_exact_storage_version", historyRetained: boolean, ordinaryReadsCreateWork: boolean}} CoverageDerivativeReclamationPreview
 * @typedef {{id: string, derivativeJobId: string, outputObjectId: string, state: "queued" | "running" | "completed" | "failed", sizeBytes: number, checksumSha256: string, previewChecksumSha256: string, previewExpiresAt: string, errorCode: string | null, attemptCount: number, deleteStartedAt: string | null, createdBy: string, createdAt: string, startedAt: string | null, finishedAt: string | null}} CoverageDerivativeReclamation
 * @typedef {{id: string, siteId: string, siteVersionId: string, siteVersionNumber: number, editionNumber: number, manifest: Record<string, unknown>, manifestChecksumSha256: string, publishedBy: string, publishedAt: string, revokedBy: string | null, revokedAt: string | null, publicationReach: "unpublished" | "unlisted" | "listed", listedSlug: string | null, unlistedToken: string | null, isPrimary: boolean}} SiteEdition
 * @typedef {{revision: number, reach: "unpublished" | "unlisted" | "listed", listedSlug: string | null, isPrimary: boolean, configuredBy: string, configuredAt: string}} SitePublicationDestination
 * @typedef {{id: string, slug: string, navigationLabel: string, position: number, isHome: boolean, resourceId: string, resourceVersionId: string, resourceVersionNumber: number, resourceKind: "document" | "story" | "dashboard" | "map", resourceTitle: string, resourceState: string, resourceVisibility: string, content: Record<string, unknown>}} SitePage
 * @typedef {{id: string, projectId: string, slug: string, versionId: string, versionNumber: number, state: "draft" | "review" | "published", title: string, description: string | null, language: string, theme: "paper" | "atlas" | "minimal", themeOptions: Record<string, string>, printLayout: Record<string, unknown>, changeMessage: string | null, createdBy: string, createdAt: string, updatedBy: string, updatedAt: string, pages: SitePage[], activeEdition: SiteEdition | null, publicationDestination: SitePublicationDestination}} ProjectSite
 * @typedef {{kind: "image" | "file" | "document", datasetId: string, datasetName: string, datasetVersionId: string, datasetVersionNumber: number, objectId: string, role: "original" | "derived" | "published" | "thumbnail", contentType: string, sizeBytes: number, checksumSha256: string, filename: string}} SiteAssetCandidate
 * @typedef {{compilerImageDigest: string, frameworkVersion: "1.13.4", lockfileFormat: "npm-package-lock-v3", networkPolicy: "deny_all", resourceLimits: Record<string, number>}} ObservableBuildPolicy
 * @typedef {{id: string, projectId: string, siteId: string, routeNamespace: string, title: string, rightsStatus: "unreviewed" | "approved" | "rejected", ownerUserId: string, currentRevisionId: string | null, currentRevisionNumber: number, buildPolicy: ObservableBuildPolicy, createdBy: string, createdAt: string, updatedBy: string, updatedAt: string}} ObservableSourceProject
 * @typedef {{relativePath: string, sourceObjectId: string, bucket: string, objectKey: string, s3VersionId: string, etag: string, contentType: string, sizeBytes: number, checksumSha256: string}} ObservableSourceRevisionFile
 * @typedef {{id: string, sourceProjectId: string, revisionNumber: number, parentRevisionId: string | null, title: string, rightsStatus: "unreviewed" | "approved" | "rejected", entryPath: string, lockfilePath: string | null, manifest: Record<string, unknown>, manifestChecksumSha256: string, changeSummary: string, createdBy: string, createdAt: string, files: ObservableSourceRevisionFile[]}} ObservableSourceRevision
 * @typedef {{id: string, sourceProjectId: string, sourceRevisionId: string, sourceRevisionNumber: number, purpose: "preview" | "release_candidate", state: "pending" | "running" | "succeeded" | "failed" | "cancelled", request: Record<string, unknown>, requestChecksumSha256: string, result: Record<string, unknown> | null, resultChecksumSha256: string | null, attemptCount: number, errorCode: string | null, createdBy: string, createdAt: string, startedAt: string | null, finishedAt: string | null, updatedAt: string, executionAvailable: boolean, coordinationStatus: "not_configured" | "configured" | "dispatched" | "dispatch_failed"}} ObservableBuildJob
 * @typedef {{authorizeUrl: string, expiresAt: string, publicationAuthorized: false}} ObservablePreviewCapability
 * @typedef {{resourceVersionId: string, resourceVersionNumber: number, mapId: string, mapVersion: number, definitionChecksumSha256: string, recipeChecksumSha256: string}} SavedMapRenderSnapshot
 * @typedef {{id: string, projectId: string, resourceId: string, profileId: string, profileVersionId: string, profileVersionNumber: number, datasetId: string, datasetVersionId: string, styleId: string, styleVersionId: string, savedMapSnapshot: SavedMapRenderSnapshot | null, bbox: number[], crs: "CRS:84" | "EPSG:3857", width: number, height: number, format: "svg" | "png", backgroundColor: string | null, transparent: boolean, requestChecksumSha256: string, state: "queued" | "running" | "completed" | "failed" | "cancelled", attemptCount: number, outputObjectId: string | null, outputContentType: string | null, outputSizeBytes: number | null, outputChecksumSha256: string | null, errorCode: string | null, createdBy: string, createdAt: string, startedAt: string | null, finishedAt: string | null}} RenderJob
 * @typedef {{id: string, email: string, displayName: string, organizationRole: "admin" | "member" | "guest", projectId: string | null, projectRole: "owner" | "editor" | "reviewer" | "viewer" | null, status: "pending" | "accepted" | "expired" | "revoked", expiresAt: string, acceptedAt: string | null, revokedAt: string | null, createdAt: string}} MembershipInvitation
 * @typedef {{invitationId: string, organizationId: string, organizationName: string, projectId: string | null, projectName: string | null, organizationRole: "admin" | "member" | "guest", projectRole: "owner" | "editor" | "reviewer" | "viewer" | null, expiresAt: string, createdAt: string}} PendingInvitation
 */

export const DEFAULT_API_BASE_URL = "/api";

export class ApiClientError extends Error {
  constructor(message, {status = 0, code = "request_failed", requestId = null, currentVersion = null, currentDraftRevision = null, cause} = {}) {
    super(message, {cause});
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.currentVersion = currentVersion;
    this.currentDraftRevision = currentDraftRevision;
    this.retryable = status === 0 || status === 429 || [502, 503, 504].includes(status);
  }
}

export class ApiContractError extends ApiClientError {
  constructor(message, options = {}) {
    super(message, {...options, code: "invalid_api_response"});
    this.name = "ApiContractError";
  }
}

export class OpenGeoApiClient {
  constructor({
    baseUrl = globalThis.OPEN_GEO_API_BASE_URL ?? DEFAULT_API_BASE_URL,
    tokenProvider = () => null,
    organizationProvider = () => null,
    fetchImplementation = globalThis.fetch?.bind(globalThis)
  } = {}) {
    if (typeof fetchImplementation !== "function") throw new TypeError("fetch implementation is required");
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.tokenProvider = tokenProvider;
    this.organizationProvider = organizationProvider;
    this.fetchImplementation = fetchImplementation;
    this.pendingSessions = new Map();
    this.publicArtifactUrls = new Map();
    this.protectedArtifactUrls = new Map();
  }

  /** @returns {Promise<Session>} */
  async getSession({signal} = {}) {
    return parseSession(await this.request("/auth/session", {organizationRequired: false, signal}));
  }

  /** @returns {Promise<PendingInvitation[]>} */
  async listMyInvitations({signal} = {}) {
    return parseArray(
      await this.request("/auth/invitations", {organizationRequired: false, signal}),
      parsePendingInvitation,
      "pending invitations"
    );
  }

  /** @returns {Promise<Organization>} */
  async getCurrentOrganization({signal} = {}) {
    return parseOrganization(await this.request("/organizations/current", {signal}));
  }

  /** @returns {Promise<OrganizationMember[]>} */
  async listOrganizationMembers(page = {}) {
    return parseArray(
      await this.request(`/organizations/current/memberships${pageQuery(page)}`),
      parseOrganizationMember,
      "organization members"
    );
  }

  /** @returns {Promise<MembershipInvitation[]>} */
  async listInvitations(page = {}) {
    return parseArray(
      await this.request(`/organizations/current/invitations${pageQuery(page)}`),
      parseInvitation,
      "invitations"
    );
  }

  /** @returns {Promise<MembershipInvitation>} */
  async createInvitation({
    email,
    displayName,
    organizationRole,
    projectId = null,
    projectRole = null,
    expiresInDays = 7
  }) {
    return parseInvitation(
      await this.request("/organizations/current/invitations", {
        method: "POST",
        body: {
          email,
          display_name: displayName,
          organization_role: organizationRole,
          project_id: projectId,
          project_role: projectRole,
          expires_in_days: expiresInDays
        }
      })
    );
  }

  /** @returns {Promise<MembershipInvitation>} */
  async revokeInvitation(invitationId) {
    return parseInvitation(
      await this.request(
        `/organizations/current/invitations/${pathUuid(invitationId, "invitation id")}`,
        {method: "DELETE"}
      )
    );
  }

  async acceptInvitation(invitationId) {
    return parseAcceptance(
      await this.request(`/auth/invitations/${pathUuid(invitationId, "invitation id")}/accept`, {
        method: "POST",
        organizationRequired: false
      })
    );
  }

  async updateOrganizationMember(userId, role) {
    return parseMembershipMutation(
      await this.request(
        `/organizations/current/memberships/${pathUuid(userId, "user id")}`,
        {method: "PATCH", body: {role}}
      ),
      ["admin", "member", "guest"]
    );
  }

  async revokeOrganizationMember(userId) {
    await this.request(
      `/organizations/current/memberships/${pathUuid(userId, "user id")}`,
      {method: "DELETE"}
    );
  }

  /** @returns {Promise<Client[]>} */
  async listClients(page = {}) {
    return parseArray(await this.request(`/clients${pageQuery(page)}`), parseClient, "clients");
  }

  /** @returns {Promise<Project[]>} */
  async listProjects({clientId = null, q = "", status = "all", signal, context = null, ...page} = {}) {
    await this.assertCollectionContext(context);
    const query = pageParameters(page);
    if (typeof q !== "string" || q.trim().length > 200) throw new TypeError("workspace search must be at most 200 characters");
    if (!["active", "archived", "all"].includes(status)) throw new TypeError("workspace status is invalid");
    if (q.trim()) query.set("q", q.trim());
    if (status !== "all") query.set("status", status);
    if (clientId) query.set("client_id", assertUuid(clientId, "client id"));
    const records = parseArray(await this.request(`/projects?${query}`, {
      ...(context ? this.collectionRequestOptions(context.organization, context) : {}), signal
    }), parseProject, "projects");
    await this.assertCollectionContext(context);
    return records;
  }

  /** @returns {Promise<RecentProject[]>} */
  async listRecentProjects({signal, ...page} = {}) {
    return parseArray(
      await this.request(`/projects/recent${pageQuery(page)}`, {signal}),
      parseRecentProject,
      "recent projects"
    );
  }

  /** @returns {Promise<Project>} */
  async createProject({clientId = null, name, projectCode = null, description = null}) {
    return parseProject(
      await this.request("/projects", {
        method: "POST",
        body: {
          client_id: clientId,
          name,
          project_code: projectCode,
          description
        }
      })
    );
  }

  /** @returns {Promise<Project>} */
  async getProject(projectId, {signal} = {}) {
    return parseProject(await this.request(`/projects/${pathUuid(projectId, "project id")}`, {signal}));
  }

  /** @returns {Promise<Project>} */
  async updateProject(projectId, changes) {
    const record = object(changes, "project update");
    const body = {};
    if (Object.hasOwn(record, "name")) body.name = record.name;
    if (Object.hasOwn(record, "projectCode")) body.project_code = record.projectCode;
    if (Object.hasOwn(record, "description")) body.description = record.description;
    if (Object.hasOwn(record, "status")) body.status = record.status;
    if (Object.hasOwn(record, "visibility")) body.visibility = record.visibility;
    if (!Object.keys(body).length) throw new TypeError("project update is empty");
    return parseProject(await this.request(
      `/projects/${pathUuid(projectId, "project id")}`,
      {method: "PATCH", body}
    ));
  }

  /** @returns {Promise<ProjectMember[]>} */
  async listProjectMembers(projectId, page = {}) {
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/memberships${pageQuery(page)}`
      ),
      parseProjectMember,
      "project members"
    );
  }

  async createProjectMember(projectId, userId, role) {
    return parseMembershipMutation(
      await this.request(`/projects/${pathUuid(projectId, "project id")}/memberships`, {
        method: "POST",
        body: {user_id: userId, role}
      }),
      ["owner", "editor", "reviewer", "viewer"]
    );
  }

  async updateProjectMember(projectId, userId, role) {
    return parseMembershipMutation(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/memberships/${pathUuid(userId, "user id")}`,
        {method: "PATCH", body: {role}}
      ),
      ["owner", "editor", "reviewer", "viewer"]
    );
  }

  async revokeProjectMember(projectId, userId) {
    await this.request(
      `/projects/${pathUuid(projectId, "project id")}/memberships/${pathUuid(userId, "user id")}`,
      {method: "DELETE"}
    );
  }

  async listTeams() {
    return parseArray(await this.request("/teams"), parseTeam, "teams");
  }

  async createTeam({name, description = null}) {
    return parseTeam(await this.request("/teams", {
      method: "POST",
      body: {name, description}
    }));
  }

  async listTeamMembers(teamId) {
    return parseArray(
      await this.request(`/teams/${pathUuid(teamId, "team id")}/members`),
      parseTeamMember,
      "team members"
    );
  }

  async createTeamMember(teamId, userId, role) {
    return parseTeamMember(await this.request(
      `/teams/${pathUuid(teamId, "team id")}/members`,
      {method: "POST", body: {user_id: userId, role}}
    ));
  }

  async listProjectTeamGrants(projectId) {
    return parseArray(
      await this.request(`/projects/${pathUuid(projectId, "project id")}/team-grants`),
      parseProjectTeamGrant,
      "project team grants"
    );
  }

  async createProjectTeamGrant(projectId, teamId, role) {
    return parseProjectTeamGrant(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/team-grants`,
      {method: "POST", body: {team_id: teamId, role}}
    ));
  }

  /** @returns {Promise<ProjectDiscussion[]>} */
  async listProjectDiscussions(projectId, {state = null, limit = 50, offset = 0} = {}) {
    const query = pageParameters({limit, offset});
    if (state !== null) {
      if (!["open", "resolved"].includes(state)) {
        throw new TypeError("discussion state is invalid");
      }
      query.set("state", state);
    }
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/discussions?${query}`
      ),
      parseProjectDiscussion,
      "project discussions"
    );
  }

  /** @returns {Promise<ProjectDiscussionParticipant[]>} */
  async listProjectDiscussionParticipants(projectId) {
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/discussion-participants`
      ),
      parseProjectDiscussionParticipant,
      "project discussion participants"
    );
  }

  async createProjectDiscussion(
    projectId,
    {
      discussionId,
      initialCommentId,
      title,
      body,
      target = null,
      assignedTo = null,
      mentionedUserIds = []
    }
  ) {
    const serializedTarget = target === null ? null : serializeDiscussionTarget(target);
    return parseDiscussionCreationReceipt(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/discussions`,
      {
        method: "POST",
        body: {
          discussion_id: assertUuid(discussionId, "discussion id"),
          initial_comment_id: assertUuid(initialCommentId, "initial comment id"),
          title,
          body,
          assigned_to: assignedTo === null ? null : assertUuid(assignedTo, "assignee id"),
          mentioned_user_ids: discussionMentionIds(mentionedUserIds),
          ...(serializedTarget === null ? {} : {target: serializedTarget})
        }
      }
    ));
  }

  /** @returns {Promise<ProjectDiscussionComment[]>} */
  async listProjectDiscussionComments(
    projectId,
    discussionId,
    {limit = 100, offset = 0} = {}
  ) {
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/discussions/`
        + `${pathUuid(discussionId, "discussion id")}/comments?`
        + pageParameters({limit, offset})
      ),
      parseProjectDiscussionComment,
      "project discussion comments"
    );
  }

  async createProjectDiscussionComment(
    projectId,
    discussionId,
    {commentId, body, mentionedUserIds = []}
  ) {
    return parseDiscussionCommentReceipt(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/discussions/`
      + `${pathUuid(discussionId, "discussion id")}/comments`,
      {
        method: "POST",
        body: {
          comment_id: assertUuid(commentId, "comment id"),
          body,
          mentioned_user_ids: discussionMentionIds(mentionedUserIds)
        }
      }
    ));
  }

  /** @returns {Promise<ProjectDiscussionSubscription | null>} */
  async getProjectDiscussionSubscription(projectId, discussionId) {
    const value = await this.request(
      `/projects/${pathUuid(projectId, "project id")}/discussions/`
      + `${pathUuid(discussionId, "discussion id")}/subscription`
    );
    return value === null ? null : parseProjectDiscussionSubscription(value);
  }

  async setProjectDiscussionSubscription(
    projectId,
    discussionId,
    {subscribed, expectedVersion = null}
  ) {
    if (typeof subscribed !== "boolean") {
      throw new TypeError("discussion subscription state is invalid");
    }
    if (expectedVersion !== null
      && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
      throw new TypeError("discussion subscription expected version is invalid");
    }
    return parseDiscussionSubscriptionReceipt(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/discussions/`
      + `${pathUuid(discussionId, "discussion id")}/subscription`,
      {
        method: "POST",
        body: {subscribed, expected_version: expectedVersion}
      }
    ));
  }

  async moderateProjectDiscussionComment(
    projectId,
    discussionId,
    commentId,
    {moderationId, reason}
  ) {
    return parseDiscussionModerationReceipt(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/discussions/`
      + `${pathUuid(discussionId, "discussion id")}/comments/`
      + `${pathUuid(commentId, "comment id")}/moderation`,
      {
        method: "POST",
        body: {
          moderation_id: assertUuid(moderationId, "discussion moderation id"),
          reason
        }
      }
    ));
  }

  async transitionProjectDiscussion(projectId, discussionId, {state, expectedVersion}) {
    if (!["open", "resolved"].includes(state)) {
      throw new TypeError("discussion state is invalid");
    }
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new TypeError("discussion expected version is invalid");
    }
    return parseDiscussionTransitionReceipt(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/discussions/`
      + `${pathUuid(discussionId, "discussion id")}/state`,
      {
        method: "POST",
        body: {state, expected_version: expectedVersion}
      }
    ));
  }

  async assignProjectDiscussion(
    projectId,
    discussionId,
    {assignedTo = null, expectedVersion}
  ) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new TypeError("discussion expected version is invalid");
    }
    return parseDiscussionAssignmentReceipt(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/discussions/`
      + `${pathUuid(discussionId, "discussion id")}/assignment`,
      {
        method: "POST",
        body: {
          assigned_to: assignedTo === null ? null : assertUuid(assignedTo, "assignee id"),
          expected_version: expectedVersion
        }
      }
    ));
  }

  /** @returns {Promise<ProjectDiscussionNotification[]>} */
  async listProjectDiscussionNotifications(
    projectId,
    {unreadOnly = false, limit = 50, offset = 0} = {}
  ) {
    if (typeof unreadOnly !== "boolean") {
      throw new TypeError("discussion notification unread filter is invalid");
    }
    const query = pageParameters({limit, offset});
    query.set("unread_only", String(unreadOnly));
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/discussion-notifications?${query}`
      ),
      parseProjectDiscussionNotification,
      "project discussion notifications"
    );
  }

  async markProjectDiscussionNotificationRead(
    projectId,
    notificationId,
    {expectedVersion}
  ) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new TypeError("discussion notification expected version is invalid");
    }
    return parseNotificationReadReceipt(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/discussion-notifications/`
      + `${pathUuid(notificationId, "notification id")}/read`,
      {method: "POST", body: {expected_version: expectedVersion}}
    ));
  }

  async listMyDatasetConnections({context = null, signal} = {}) {
    await this.assertCollectionContext(context);
    const records = parseArray(
      await this.request("/me/dataset-connections", {
        ...(context ? this.collectionRequestOptions(context.organization, context) : {}), signal
      }),
      parseUserDatasetConnection,
      "user dataset connections"
    );
    await this.assertCollectionContext(context);
    return records;
  }

  async createMyDatasetConnection({
    provider = "s3",
    displayName,
    bucketName,
    regionName = "us-east-1",
    objectPrefix = "",
    credentialMode,
    roleArn = null
  }) {
    return parseUserDatasetConnection(await this.request("/me/dataset-connections", {
      method: "POST",
      body: {
        provider,
        display_name: displayName,
        bucket_name: bucketName,
        region_name: regionName,
        object_prefix: objectPrefix,
        credential_mode: credentialMode,
        role_arn: roleArn
      }
    }));
  }

  async updateMyDatasetConnection(connectionId, changes) {
    const body = {};
    for (const [clientField, apiField] of [
      ["displayName", "display_name"],
      ["bucketName", "bucket_name"],
      ["regionName", "region_name"],
      ["objectPrefix", "object_prefix"],
      ["roleArn", "role_arn"],
      ["enabled", "enabled"]
    ]) {
      if (Object.hasOwn(changes, clientField)) body[apiField] = changes[clientField];
    }
    return parseUserDatasetConnection(await this.request(
      `/me/dataset-connections/${pathUuid(connectionId, "dataset connection id")}`,
      {method: "PATCH", body}
    ));
  }

  async replaceMyDatasetConnectionCredentials(
    connectionId,
    expectedCredentialRevision,
    credentials
  ) {
    return parseUserDatasetConnection(await this.request(
      `/me/dataset-connections/${pathUuid(connectionId, "dataset connection id")}/credentials`,
      {
        method: "PUT",
        body: {
          expected_credential_revision: expectedCredentialRevision,
          ...(credentials.externalId ? {external_id: credentials.externalId} : {}),
          ...(credentials.accessKeyId ? {access_key_id: credentials.accessKeyId} : {}),
          ...(credentials.secretAccessKey
            ? {secret_access_key: credentials.secretAccessKey}
            : {}),
          ...(credentials.sessionToken ? {session_token: credentials.sessionToken} : {})
        }
      }
    ));
  }

  async requestMyDatasetConnectionVerification(connectionId) {
    return parseUserDatasetConnectionVerificationSubmission(await this.request(
      `/me/dataset-connections/${pathUuid(connectionId, "dataset connection id")}/verifications`,
      {method: "POST"}
    ));
  }

  async listMyDatasetConnectionVerifications(connectionId) {
    return parseArray(
      await this.request(
        `/me/dataset-connections/${pathUuid(connectionId, "dataset connection id")}/verifications`
      ),
      parseUserDatasetConnectionVerification,
      "user dataset connection verifications"
    );
  }

  async getMyDatasetConnectionOverview(connectionId) {
    const id = pathUuid(connectionId, "dataset connection id");
    const overview = parseUserDatasetConnectionOverview(
      await this.request(`/me/dataset-connections/${id}/overview`)
    );
    if (overview.connectionId !== id) {
      contract("user dataset connection overview identity does not match the request");
    }
    return overview;
  }

  async browseMyDatasetConnectionRepository(
    connectionId,
    {prefix = "", cursor = null, limit = 100, context = null, signal} = {}
  ) {
    await this.assertCollectionContext(context);
    const safePrefix = repositoryRelativePath(
      prefix,
      "dataset repository request.prefix",
      true
    );
    if (safePrefix && !safePrefix.endsWith("/")) {
      contract("dataset repository request.prefix is invalid");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      contract("dataset repository request.limit is invalid");
    }
    if (
      cursor !== null
      && (typeof cursor !== "string"
        || cursor.length > 512
        || !/^[A-Za-z0-9_-]+$/.test(cursor))
    ) {
      contract("dataset repository request.cursor is invalid");
    }
    const query = new URLSearchParams({prefix: safePrefix, limit: String(limit)});
    if (cursor !== null) query.set("cursor", cursor);
    const page = parseDatasetRepositoryPage(await this.request(
      `/me/dataset-connections/${pathUuid(connectionId, "dataset connection id")}`
      + `/repository?${query}`, {
        ...(context ? this.collectionRequestOptions(context.organization, context) : {}), signal
      }
    ));
    await this.assertCollectionContext(context);
    if (page.connectionId !== connectionId) {
      contract("dataset repository page belongs to another connection");
    }
    return page;
  }

  async inspectMyDatasetConnectionRepositoryObject(
    connectionId,
    relativePath,
    versionId = null
  ) {
    const safePath = repositoryRelativePath(
      relativePath,
      "dataset repository object request.path",
      false
    );
    if (safePath.endsWith("/")) {
      contract("dataset repository object request.path is invalid");
    }
    if (
      versionId !== null
      && (typeof versionId !== "string"
        || versionId.length < 1
        || versionId.length > 1024
        || new TextEncoder().encode(versionId).byteLength > 1024
        || /[\u0000-\u001f\u007f]/.test(versionId))
    ) {
      contract("dataset repository object request.versionId is invalid");
    }
    const query = new URLSearchParams({path: safePath});
    if (versionId !== null) query.set("version_id", versionId);
    const record = parseDatasetRepositoryObject(await this.request(
      `/me/dataset-connections/${pathUuid(connectionId, "dataset connection id")}`
      + `/repository/object?${query}`
    ));
    if (
      record.connectionId !== connectionId
      || record.relativePath !== safePath
      || (versionId !== null && record.versionId !== versionId)
    ) {
      contract("dataset repository object belongs to another connection or path");
    }
    return record;
  }

  async listMyDatasetConnectionRepositoryObjectVersions(
    connectionId,
    relativePath,
    {cursor = null, limit = 50} = {}
  ) {
    const safePath = repositoryRelativePath(
      relativePath,
      "dataset repository versions request.path",
      false
    );
    if (safePath.endsWith("/")) {
      contract("dataset repository versions request.path is invalid");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      contract("dataset repository versions request.limit is invalid");
    }
    if (
      cursor !== null
      && (typeof cursor !== "string"
        || cursor.length > 1536
        || !/^[A-Za-z0-9_-]+$/.test(cursor))
    ) {
      contract("dataset repository versions request.cursor is invalid");
    }
    const query = new URLSearchParams({path: safePath, limit: String(limit)});
    if (cursor !== null) query.set("cursor", cursor);
    const page = parseDatasetRepositoryObjectVersionsPage(await this.request(
      `/me/dataset-connections/${pathUuid(connectionId, "dataset connection id")}`
      + `/repository/object/versions?${query}`
    ));
    if (page.connectionId !== connectionId || page.relativePath !== safePath) {
      contract("dataset repository versions belong to another connection or path");
    }
    return page;
  }

  async registerMyDatasetConnectionRepositoryObject(connectionId, draft) {
    const relativePath = repositoryRelativePath(
      draft?.relativePath,
      "repository object registration.relativePath",
      false
    );
    const versionId = boundedString(
      draft?.versionId,
      1024,
      "repository object registration.versionId"
    );
    const format = oneOf(
      draft?.format,
      ["geojson", "csv", "shapefile", "geopackage", "geoparquet", "cog", "pmtiles", "png", "jpeg", "pdf", "odt"],
      "repository object registration.format"
    );
    if (
      relativePath.endsWith("/")
      || versionId === "null"
      || /[\u0000-\u001f\u007f]/.test(versionId)
      || new TextEncoder().encode(versionId).byteLength > 1024
    ) {
      contract("repository object registration requires an exact provider version");
    }
    const tags = Array.isArray(draft?.tags) ? draft.tags : [];
    if (
      tags.length > 12
      || new Set(tags).size !== tags.length
      || tags.some((tag) => (
        typeof tag !== "string"
        || tag !== tag.trim().toLowerCase()
        || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(tag)
        || tag.length > 64
      ))
    ) {
      contract("repository object registration.tags is invalid");
    }
    const registration = parseRepositoryObjectRegistration(await this.request(
      `/me/dataset-connections/${pathUuid(connectionId, "dataset connection id")}`
      + "/repository/object/registrations",
      {
        method: "POST",
        body: {
          project_id: pathUuid(draft?.projectId, "project id"),
          relative_path: relativePath,
          version_id: versionId,
          name: boundedString(draft?.name, 200, "repository object registration.name"),
          description: draft?.description
            ? boundedString(
                draft.description,
                4_000,
                "repository object registration.description"
              )
            : null,
          classification: oneOf(
            draft?.classification ?? "internal",
            ["public", "internal", "confidential", "restricted"],
            "repository object registration.classification"
          ),
          format,
          tags
        }
      }
    ));
    if (
      registration.projectId !== draft.projectId
      || registration.source.connectionId !== connectionId
      || registration.source.relativePath !== relativePath
      || registration.source.providerVersionId !== versionId
    ) {
      contract("repository object registration does not match the request");
    }
    return registration;
  }

  async listProjectDatasetConnectionBindings(projectId, {signal} = {}) {
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/dataset-connection-bindings`, {signal}
      ),
      parseProjectDatasetConnectionBinding,
      "project dataset connection bindings"
    );
  }

  async createProjectDatasetConnectionBinding(
    projectId,
    connectionId,
    displayName
  ) {
    return parseProjectDatasetConnectionBinding(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/dataset-connection-bindings`,
      {
        method: "POST",
        body: {connection_id: connectionId, display_name: displayName}
      }
    ));
  }

  async removeProjectDatasetConnectionBinding(projectId, bindingId) {
    await this.request(
      `/projects/${pathUuid(projectId, "project id")}/dataset-connection-bindings/${pathUuid(bindingId, "dataset connection binding id")}`,
      {method: "DELETE"}
    );
  }

  async listMyBasemapConnections() {
    return parseArray(
      await this.request("/me/basemap-connections"),
      parseUserBasemapConnection,
      "user basemap connections"
    );
  }

  async createMyBasemapConnection({
    provider = "protomaps",
    displayName,
    allowedOrigins
  }) {
    return parseUserBasemapConnection(await this.request("/me/basemap-connections", {
      method: "POST",
      body: {
        provider,
        display_name: displayName,
        allowed_origins: allowedOrigins
      }
    }));
  }

  async updateMyBasemapConnection(connectionId, changes) {
    const body = {};
    for (const [clientField, apiField] of [
      ["displayName", "display_name"],
      ["allowedOrigins", "allowed_origins"],
      ["enabled", "enabled"]
    ]) {
      if (Object.hasOwn(changes, clientField)) body[apiField] = changes[clientField];
    }
    return parseUserBasemapConnection(await this.request(
      `/me/basemap-connections/${pathUuid(connectionId, "basemap connection id")}`,
      {method: "PATCH", body}
    ));
  }

  async replaceMyBasemapConnectionBrowserKey(
    connectionId,
    expectedCredentialRevision,
    apiKey
  ) {
    return parseUserBasemapConnection(await this.request(
      `/me/basemap-connections/${pathUuid(connectionId, "basemap connection id")}/browser-key`,
      {
        method: "PUT",
        body: {
          expected_credential_revision: expectedCredentialRevision,
          api_key: apiKey
        }
      }
    ));
  }

  async listProjectBasemapConnectionBindings(projectId, {signal} = {}) {
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/basemap-connection-bindings`, {signal}
      ),
      parseProjectBasemapConnectionBinding,
      "project basemap connection bindings"
    );
  }

  async createProjectBasemapConnectionBinding(projectId, connectionId, displayName) {
    return parseProjectBasemapConnectionBinding(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/basemap-connection-bindings`,
      {
        method: "POST",
        body: {connection_id: connectionId, display_name: displayName}
      }
    ));
  }

  async removeProjectBasemapConnectionBinding(projectId, bindingId) {
    await this.request(
      `/projects/${pathUuid(projectId, "project id")}/basemap-connection-bindings/${pathUuid(bindingId, "basemap connection binding id")}`,
      {method: "DELETE"}
    );
  }

  async resolveProjectBasemapStyle(projectId, bindingId, flavor) {
    const normalizedFlavor = oneOf(
      flavor,
      ["light", "dark", "white", "grayscale", "black", "voyager", "positron", "dark-matter"],
      "basemap provider flavor"
    );
    return parseResolvedBasemapStyle(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/basemap-connection-bindings/${pathUuid(bindingId, "basemap connection binding id")}/styles/${normalizedFlavor}`
    ));
  }

  /** @returns {Promise<MapRecord[]>} */
  async listMaps(projectId, page = {}) {
    return parseArray(
      await this.request(`/projects/${pathUuid(projectId, "project id")}/maps${pageQuery(page)}`, {signal: page.signal}),
      parseMap,
      "maps"
    );
  }

  async listLocations(page = {}) {
    return parseArray(await this.request(`/locations${pageQuery(page)}`), value => ({...collectionReceipt(value), title: string(value.title, "Location title")}), "locations");
  }

  async getLocation(id, version = null) {
    const query = version === null ? "" : `?version=${positiveInteger(version, "Location version")}`;
    const value = object(await this.request(`/locations/${pathUuid(id, "Location id")}${query}`), "Location");
    if (value.id !== id) contract("Location identity changed");
    const document = object(value.document, "Location document");
    string(document.title, "Location title");
    object(document.knowledge, "Location knowledge");
    if (!Array.isArray(document.aliases) || !Array.isArray(document.identifiers)) contract("Invalid Location names");
    return {...collectionReceipt(value), role: oneOf(value.role, ["owner", "editor", "reader"], "Location role"), accessRevision: positiveInteger(value.access_revision, "Location access revision"), currentRevision: positiveInteger(value.current_revision, "Location current revision"), document: structuredClone(document)};
  }

  async getLocationLinks(id, version = null) {
    const query = version === null ? "" : `?version=${nonNegativeInteger(version, "links version")}`;
    const value = object(await this.request(`/locations/${pathUuid(id, "Location id")}/links${query}`), "Location links");
    return {revision: nonNegativeInteger(value.revision, "links revision"), currentRevision: nonNegativeInteger(value.current_revision, "current links revision"),
      entries: parseArray(value.entries, item => {
        const base = {entry_id: uuid(item.entry_id, "link entry"), available: boolean(item.available, "link availability")};
        if (!base.available) return base;
        return {...base, kind: oneOf(item.kind, ["layer", "project", "publication", "collection"], "link kind"),
          target_id: uuid(item.target_id, "link target"), title: string(item.title, "link title"),
          relationship: string(item.relationship, "relationship"), evidence: parseArray(item.evidence, value => string(value, "link evidence"), "link evidence"), confidence: item.confidence};
      }, "Location links")};
  }

  async saveLocationLinks(id, {revision, entries}) {
    return collectionReceipt(await this.request(`/locations/${pathUuid(id, "Location id")}/links`, {
      method: "PUT", body: {expected_links_revision: nonNegativeInteger(revision, "links revision"), entries: entries.map(entry => entry.entry_id
        ? {entry_id: pathUuid(entry.entry_id, "link entry")}
        : {kind: entry.kind, target_id: pathUuid(entry.target_id, "link target"), relationship: entry.relationship, evidence: entry.evidence, confidence: entry.confidence})}
    }));
  }

  async getLocationParent(id, version = null) {
    const query = version === null ? "" : `?version=${nonNegativeInteger(version, "hierarchy version")}`;
    const value = object(await this.request(`/locations/${pathUuid(id, "Location id")}/parent${query}`), "Location parent");
    const base = {revision: nonNegativeInteger(value.revision, "hierarchy revision"),
      currentRevision: nonNegativeInteger(value.current_revision, "current hierarchy revision"),
      parentAvailable: boolean(value.parent_available, "parent availability")};
    if (!base.parentAvailable) return base;
    return {...base, parent: value.parent === null ? null : {id: uuid(value.parent.id, "parent id"), title: string(value.parent.title, "parent title")},
      evidence: parseArray(value.evidence, item => string(item, "parent evidence"), "parent evidence"), confidence: value.confidence};
  }

  async setLocationParent(id, {revision, parentId, evidence = [], confidence = null}) {
    return collectionReceipt(await this.request(`/locations/${pathUuid(id, "Location id")}/parent`, {
      method: "PUT", body: {expected_hierarchy_revision: nonNegativeInteger(revision, "hierarchy revision"),
        parent_id: parentId === null ? null : pathUuid(parentId, "parent id"), evidence, confidence}
    }));
  }

  async listLocationGrants(id, page = {}) {
    const value = object(await this.request(`/locations/${pathUuid(id, "Location id")}/grants${pageQuery(page)}`), "Location sharing");
    return {revision: positiveInteger(value.revision, "access revision"), grants: parseArray(value.grants, item => ({
      userId: uuid(item.user_id, "grantee"), displayName: string(item.display_name, "grantee name"),
      email: string(item.email, "grantee email"), role: oneOf(item.role, ["reader", "editor"], "grant role")
    }), "Location grants")};
  }

  async grantLocation(id, userId, {revision, role}) {
    return collectionReceipt(await this.request(`/locations/${pathUuid(id, "Location id")}/grants/${pathUuid(userId, "grantee")}`, {
      method: "PUT", body: {expected_access_revision: positiveInteger(revision, "access revision"), role}
    }));
  }

  async saveLocation(document, {id = null, revision = null} = {}) {
    return collectionReceipt(await this.request(id === null ? "/locations" : `/locations/${pathUuid(id, "Location id")}`, {
      method: id === null ? "POST" : "PUT", body: id === null ? {document} : {document, expected_revision: positiveInteger(revision, "Location revision")}
    }));
  }

  async listCollections({signal, query = "", visibility = "", sort = "updated", ...page} = {}) {
    const params = new URLSearchParams(pageQuery(page).replace(/^\?/, ""));
    if (query) params.set("q", query);
    if (visibility) params.set("visibility", visibility);
    params.set("sort", sort);
    const organizationId = await this.collectionOrganization();
    const values = await this.request(`/collections?${params}`, {signal, organizationId});
    await this.assertCollectionOrganization(organizationId);
    return parseArray(values, value => parseCollectionSummary(value, {organizationId}), "collections");
  }

  async collectionImagePreviews(id) {
    const records = await this.request(`/collections/${pathUuid(id, "Collection id")}/image-previews`);
    if (!Array.isArray(records) || records.length > 4) contract("Invalid Collection image previews");
    return records.map(record => {
      const match = /^\/public\/organizations\/([^/]+)\/artifact-releases\/([^/]+)\/preview$/.exec(record.preview_path)
        ?? /^\/public\/organizations\/([^/]+)\/projects\/([^/]+)\/site-editions\/([^/]+)\/previews\/([^/]+)\.png$/.exec(record.preview_path);
      if (!match) contract("Invalid preview path");
      for (const identity of match.slice(1)) pathUuid(identity, "preview identity");
      return {entryId: uuid(record.entry_id, "preview Collection entry"), title: string(record.title, "preview title"), license: string(record.license, "preview license"),
        attribution: string(record.attribution, "preview attribution"), url: `${this.baseUrl}${record.preview_path}`};
    });
  }
  async getCollection(id) {
    const selectedOrganization = await this.organizationProvider();
    const organizationId = selectedOrganization == null ? null : uuid(selectedOrganization, "Collection account");
    const value = object(await this.request(`/collections/${pathUuid(id, "collection id")}`, {organizationId}), "collection");
    const currentOrganization = await this.organizationProvider();
    if ((currentOrganization == null ? null : uuid(currentOrganization, "Collection account")) !== organizationId) {
      throw new ApiClientError("The selected account changed. Reopen this Collection in the current account.", {
        status: 409, code: "organization_scope_changed"
      });
    }
    const summary = parseCollectionSummary(value, {organizationId});
    if (summary.id !== id) contract("Collection identity changed");
    const record = {...summary,
      ...(Object.hasOwn(value, "owner_user_id") ? {owner_user_id: value.owner_user_id} : {}),
      ...(Object.hasOwn(value, "created_by") ? {created_by: uuid(value.created_by, "Collection creator")} : {}),
      role: oneOf(value.role, ["owner", "editor", "reader"], "collection.role"),
      members: parseArray(value.members, member => {
        const item = object(member, "collection member");
        const entry_id = uuid(item.entry_id, "collection entry");
        if (item.available === false) return {entry_id, available: false};
        if (item.available !== true) contract("Invalid member availability");
        return {entry_id, available: true, kind: oneOf(item.kind, ["project", "publication"], "member.kind"),
          target_id: uuid(item.target_id, "member.target"), title: string(item.title, "member.title")};
      }, "collection members")};
    let definition;
    try {definition = collectionDefinitionFromApi(value, {baseUrl: this.baseUrl, organizationId});}
    catch (cause) {contract("Invalid qualified Collection metadata", cause);}
    return definition === undefined ? record : {...record, definition};
  }

  async listCollectionCandidates(kind, {limit = 50, offset = 0} = {}) {
    const query = new URLSearchParams({kind: oneOf(kind, ["project", "publication"], "member kind"), limit: String(limit), offset: String(offset)});
    return parseArray(await this.request(`/collections/member-candidates?${query}`), item => ({id: uuid(item.id, "candidate id"), title: string(item.title, "candidate title")}), "Collection candidates");
  }

  async collectionOrganization() {
    const value = await this.organizationProvider();
    return value == null ? null : uuid(value, "Collection account");
  }

  async assertCollectionOrganization(expected) {
    if (await this.collectionOrganization() !== expected) {
      throw new ApiClientError("The selected account changed. Reopen this Collection in the current account.", {
        status: 409, code: "organization_scope_changed"
      });
    }
  }

  async assertCollectionContext(context) {
    if (!context) return;
    const current = () => this.tokenProvider === context.tokenProvider && this.organizationProvider === context.organizationProvider &&
      this.baseUrl === context.baseUrl;
    const token = await context.tokenProvider.call(this);
    const organization = await context.organizationProvider.call(this);
    if (!current() || token !== context.token || String(organization).toLowerCase() !== context.organization) {
      throw new ApiClientError("Your sign-in or selected account changed. Reopen this Collection before continuing.", {
        status: 409, code: "collection_context_changed"
      });
    }
    this.assertCollectionContextNow(context);
  }

  assertCollectionContextNow(context) {
    if (context && (this.tokenProvider !== context.tokenProvider || this.organizationProvider !== context.organizationProvider ||
        this.baseUrl !== context.baseUrl || context.tokenProvider.call(this) !== context.token ||
        String(context.organizationProvider.call(this)).toLowerCase() !== context.organization)) {
      throw new ApiClientError("Your sign-in or selected account changed. Reopen this Collection before continuing.", {
        status: 409, code: "collection_context_changed"
      });
    }
  }

  collectionRequestOptions(organizationId, context) {
    return {organizationId: context ? context.organization : organizationId, ...(context ? {token: context.token,
      beforeDispatch: () => this.assertCollectionContext(context),
      beforeDispatchNow: () => this.assertCollectionContextNow(context)} : {})};
  }

  async listCollectionOwnerCandidates(kind, {collectionId = null, limit = 50, offset = 0, context: originalContext = null} = {}) {
    const context = originalContext && Object.freeze({...originalContext});
    await this.assertCollectionContext(context);
    const principalType = oneOf(kind, ["user", "team", "organization"], "Collection owner type");
    const query = pageParameters({limit, offset}); query.set("kind", principalType);
    if (collectionId !== null) query.set("collection_id", assertUuid(collectionId, "Collection id"));
    const organizationId = context ? context.organization : await this.collectionOrganization();
    const values = await this.request(`/collections/owner-candidates?${query}`, this.collectionRequestOptions(organizationId, context));
    await this.assertCollectionContext(context);
    await this.assertCollectionOrganization(organizationId);
    const owners = parseArray(values, value => {
      const candidate = object(value, "Collection owner candidate");
      exactKeys(candidate, ["principal_type", "principal_id", "name"], "Collection owner candidate");
      let owner;
      try {owner = collectionOwnerFromApi({owner: {principal_type: candidate.principal_type,
        principal_id: candidate.principal_id}}, {organizationId});}
      catch (cause) {contract("Invalid Collection owner candidate", cause);}
      if (owner.principal_type !== principalType) contract("Collection owner candidate type changed");
      return {...owner, name: boundedString(candidate.name, 200, "Collection owner name")};
    }, "Collection owner candidates");
    if (owners.length > limit || new Set(owners.map(owner => owner.principal_id)).size !== owners.length) {
      contract("Invalid Collection owner candidate page");
    }
    return owners;
  }

  async transferCollectionOwner(id, {expected_revision, owner}, {context: originalContext = null} = {}) {
    const context = originalContext && Object.freeze({...originalContext});
    await this.assertCollectionContext(context);
    const organizationId = context ? context.organization : await this.collectionOrganization();
    const typedOwner = collectionOwnerFromApi({owner}, {organizationId});
    const receipt = collectionReceipt(await this.request(`/collections/${pathUuid(id, "Collection id")}/owner`, {
      method: "PUT", ...this.collectionRequestOptions(organizationId, context),
      body: {expected_revision: positiveInteger(expected_revision, "Collection revision"), owner: typedOwner}
    }));
    await this.assertCollectionContext(context);
    await this.assertCollectionOrganization(organizationId);
    if (receipt.id !== id) contract("Collection identity changed");
    return receipt;
  }

  async listCollectionGrants(id, page = {}) {
    const value = object(await this.request(`/collections/${pathUuid(id, "collection id")}/grants${pageQuery(page)}`), "collection sharing");
    return {revision: positiveInteger(value.revision, "collection revision"),
      grants: parseArray(value.grants, item => ({userId: uuid(item.user_id, "grantee"),
        displayName: string(item.display_name, "grantee name"), email: string(item.email, "grantee email"),
        role: oneOf(item.role, ["reader", "editor"], "collection grant")}), "collection grants")};
  }

  async publicCollectionUrl(id) {
    const organizationId = uuid(await this.organizationProvider(), "organization id");
    return `${this.baseUrl}/public/organizations/${organizationId}/collections/${uuid(id, "collection.id")}/view`;
  }
  async setCollectionVisibility(id, {revision, visibility}) {
    if (!["private", "account", "public"].includes(visibility)) contract("Invalid Collection visibility");
    return collectionReceipt(await this.request(`/collections/${uuid(id, "collection.id")}/visibility`, {
      method: "PUT", body: {expected_revision: positiveInteger(revision, "collection.revision"), visibility}
    }));
  }
  async grantCollection(id, userId, {revision, role}) {
    return collectionReceipt(await this.request(`/collections/${pathUuid(id, "collection id")}/grants/${pathUuid(userId, "grantee")}`, {
      method: "PUT", body: {expected_revision: revision, role: role === null ? null : oneOf(role, ["reader", "editor"], "grant role")}
    }));
  }

  async createCollection({title, description = "", owner}, {context: originalContext = null} = {}) {
    const context = originalContext && Object.freeze({...originalContext});
    await this.assertCollectionContext(context);
    const organizationId = context ? context.organization : await this.collectionOrganization();
    const typedOwner = owner === undefined ? undefined : collectionOwnerFromApi({owner}, {organizationId});
    const receipt = collectionReceipt(await this.request("/collections", {method: "POST", ...this.collectionRequestOptions(organizationId, context),
      body: {title, description, ...(typedOwner === undefined ? {} : {owner: typedOwner})}}));
    await this.assertCollectionContext(context);
    await this.assertCollectionOrganization(organizationId);
    return receipt;
  }

  async updateCollection(id, {revision, title, description, members}) {
    return collectionReceipt(await this.request(`/collections/${pathUuid(id, "collection id")}`, {
      method: "PUT", body: {expected_revision: revision, title, description,
        members: members.map(member => member.entry_id ? {entry_id: pathUuid(member.entry_id, "collection entry")}
          : {kind: oneOf(member.kind, ["project", "publication"], "member.kind"), target_id: pathUuid(member.target_id, "member target")})}
    }));
  }

  /** List authorized authored Project metadata without fetching definitions. */
  async listCompositions({limit = 50, offset = 0, query = "", status = "active", signal} = {}) {
    const params = new URLSearchParams({limit: String(limit), offset: String(offset), q: query, status});
    return parseArray(await this.request(`/compositions?${params}`, {signal}), value => {
      const record = object(value, "composition summary");
      if (record.resource_type !== "project") contract("Composition resource type changed");
      return {id: uuid(record.id, "composition.id"), resourceType: "project",
        accessContainerId: uuid(record.access_container_id, "composition.access_container_id"),
        accessContainerName: string(record.access_container_name, "composition.access_container_name"),
        name: string(record.name, "composition.name"), description: nullableString(record.description, "composition.description"),
        status: oneOf(record.status, ["active", "archived"], "composition.status"),
        ownerUserId: nullableUuid(record.owner_user_id ?? null, "composition.owner_user_id"),
        version: positiveInteger(record.version, "composition.version"), updatedAt: timestamp(record.updated_at, "composition.updated_at")};
    }, "compositions");
  }

  /** @returns {Promise<MapRecord & {accessContainerId: string, resourceType: "project"}>} */
  async getComposition(compositionId, {signal} = {}) {
    const record = object(await this.request(`/compositions/${pathUuid(compositionId, "composition id")}`, {signal}), "composition");
    if (record.resource_type !== "project" || record.id !== compositionId) contract("Composition identity changed");
    const accessContainerId = uuid(record.access_container_id, "composition.access_container_id");
    // projectId remains internal compatibility context for existing save APIs.
    return {...parseMap({...record, project_id: accessContainerId}), accessContainerId, resourceType: "project"};
  }

  /** Read saved-version metadata only after an explicit history action. */
  async listCompositionVersions(compositionId, {limit = 50, beforeVersion = null, signal} = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || beforeVersion !== null && (!Number.isSafeInteger(beforeVersion) || beforeVersion < 1)) {
      throw new TypeError("Project history selection is invalid");
    }
    const params = new URLSearchParams({limit: String(limit)});
    if (beforeVersion !== null) params.set("before_version", String(beforeVersion));
    const versions = parseArray(await this.request(
      `/compositions/${pathUuid(compositionId, "composition id")}/versions?${params}`, {signal}
    ), parseCompositionVersionSummary, "composition versions");
    if (versions.length > limit || versions.some((record, index) =>
      beforeVersion !== null && record.version >= beforeVersion
      || index > 0 && record.version >= versions[index - 1].version)) {
      contract("Project history order changed");
    }
    return versions;
  }

  /** Read one retained definition under the Project's current read authority. */
  async getCompositionVersion(compositionId, version, {signal} = {}) {
    if (!Number.isSafeInteger(version) || version < 1) throw new TypeError("Project version is invalid");
    const value = await this.request(
      `/compositions/${pathUuid(compositionId, "composition id")}/versions/${version}`, {signal}
    );
    const summary = parseCompositionVersionSummary(value);
    if (summary.version !== version) contract("Project version changed");
    return {...summary, definition: boundedObject(value.definition, 524_288, "composition version.definition")};
  }

  /** @returns {Promise<MapRecord>} */
  async getMap(projectId, mapId, {signal} = {}) {
    return parseMap(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/maps/${pathUuid(mapId, "map id")}`, {signal}
      )
    );
  }

  /** @returns {Promise<MapRecord>} */
  async createMap(projectId, {name, description = null, definition = emptyMapDefinition(), creationKey = null}) {
    return parseMap(
      await this.request(`/projects/${pathUuid(projectId, "project id")}/maps`, {
        method: "POST",
        body: {name, description, definition, ...(creationKey ? {creation_key: pathUuid(creationKey, "creation key")} : {})}
      })
    );
  }

  /** @returns {Promise<MapRecord>} */
  async updateMap(projectId, mapId, {expectedVersion, changes, changeMessage = null}) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new TypeError("expectedVersion must be a positive integer");
    }
    if (!isObject(changes) || !Object.keys(changes).length) {
      throw new TypeError("map changes must contain at least one field");
    }
    return parseMap(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/maps/${pathUuid(mapId, "map id")}`,
        {
          method: "PATCH",
          body: {
            expected_version: expectedVersion,
            ...changes,
            ...(changeMessage ? {change_message: changeMessage} : {})
          }
        }
      )
    );
  }

  /** @returns {Promise<Dataset[]>} */
  async searchDatasets(filters = {}) {
    return parseArray(
      await this.request(`/datasets${datasetQuery(filters)}`),
      parseDataset,
      "datasets"
    );
  }

  async searchLayers({query = null, projectId = null, clientId = null, classification = null, ...page} = {}) {
    const params = pageParameters(page);
    if (query) params.set("query", boundedString(query, 200, "layer query"));
    if (projectId) params.set("project_id", assertUuid(projectId, "layer project"));
    if (clientId) params.set("client_id", assertUuid(clientId, "layer client"));
    if (classification) params.set("classification", classification);
    return parseArray(await this.request(`/catalog/layers?${params}`), parseCatalogLayer, "catalog layers");
  }

  /** @returns {Promise<Dataset[]>} */
  async listDatasets(projectId, page = {}) {
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/datasets${datasetQuery(page)}`, {signal: page.signal}
      ),
      parseDataset,
      "datasets"
    );
  }

  /** @returns {Promise<Dataset>} */
  async getAuthoredKnowledge(kind, id, {version = null} = {}) {
    if (!["project","publication","collection"].includes(kind)) contract("invalid authored resource kind");
    const suffix=version===null?"":`?version=${positiveInteger(version,"metadata revision")}`;
    return parseAuthoredKnowledge(await this.request(`/resource-knowledge/${kind}/${pathUuid(id,"resource id")}${suffix}`),kind,id);
  }

  async saveAuthoredKnowledge(kind, id, {expectedVersion, document}) {
    if (!["project","publication","collection"].includes(kind)) contract("invalid authored resource kind");
    return parseAuthoredKnowledge(await this.request(`/resource-knowledge/${kind}/${pathUuid(id,"resource id")}`, {
      method:"PUT",body:{expected_version:expectedVersion,document}
    }),kind,id);
  }

  async getDatasetKnowledge(datasetId, {version = null, context: originalContext = null, signal} = {}) {
    const context = originalContext && Object.freeze({...originalContext});
    await this.assertCollectionContext(context);
    const suffix = version === null ? "" : `?version=${positiveInteger(version, "metadata revision")}`;
    const result = parseDatasetKnowledge(await this.request(`/datasets/${pathUuid(datasetId, "dataset id")}/metadata${suffix}`,
      {...(context ? this.collectionRequestOptions(context.organization, context) : {}), signal}), datasetId);
    await this.assertCollectionContext(context);
    return result;
  }

  async searchPlaceNames(datasetId, query) {
    return this.request(`/datasets/${pathUuid(datasetId, "dataset id")}/place-search`, {
      method: "POST", body: {query: boundedQuery(query, 120, "place name")}
    });
  }

  async resolvePlaceContext(datasetId, item) {
    if (!/^Q[1-9][0-9]{0,15}$/.test(item)) contract("invalid Wikidata item identity");
    return this.request(`/datasets/${pathUuid(datasetId, "dataset id")}/place-context`, {
      method: "POST", body: {item}
    });
  }

  async saveDatasetKnowledge(datasetId, {expectedVersion, document, context: originalContext = null}) {
    const context = originalContext && Object.freeze({...originalContext});
    await this.assertCollectionContext(context);
    const result = parseDatasetKnowledge(await this.request(`/datasets/${pathUuid(datasetId, "dataset id")}/metadata`, {
      ...(context ? this.collectionRequestOptions(context.organization, context) : {}),
      method: "PUT", body: {expected_version: expectedVersion, document}
    }), datasetId);
    await this.assertCollectionContext(context);
    return result;
  }

  async getCatalogDataset(datasetId) {
    const record = parseDataset(await this.request(`/datasets/${pathUuid(datasetId, "dataset id")}`));
    if (record.id !== datasetId.toLowerCase()) contract("catalog dataset identity is inconsistent");
    return record;
  }

  async getDataset(projectId, datasetId) {
    return parseDataset(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}`
      )
    );
  }

  async getRepositoryObjectSource(projectId, datasetId) {
    const project = pathUuid(projectId, "project id");
    const dataset = pathUuid(datasetId, "dataset id");
    const source = parseRepositoryObjectSource(await this.request(
      `/projects/${project}/datasets/${dataset}/repository-object-source`
    ));
    if (source.datasetId !== dataset) {
      contract("repository object source belongs to another dataset");
    }
    return source;
  }

  /** Seal the size, format, request count, provider version, and estimated cost. */
  async createRepositoryObjectCopyEstimate(projectId, datasetId) {
    return parseRepositoryObjectCopyEstimate(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}/repository-copy-estimates`,
      {method: "POST"}
    ));
  }

  /** Copy one registered exact provider version into governed immutable storage. */
  async createRepositoryObjectProtectedCopy(projectId, datasetId, request) {
    return parseRepositoryObjectProtectedCopyJob(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}/repository-protected-copies`,
      {method: "POST", body: serializeProtectedCopyAcceptance(request)}
    ));
  }

  async listRepositoryObjectProtectedCopies(projectId, datasetId, page = {}) {
    return parseArray(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}/repository-protected-copies${pageQuery(page)}`
    ), parseRepositoryObjectProtectedCopyJob, "repository object protected copy jobs");
  }

  async getRepositoryObjectProtectedCopy(projectId, datasetId, jobId) {
    return parseRepositoryObjectProtectedCopyJob(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}/repository-protected-copies/${pathUuid(jobId, "repository copy job id")}`
    ));
  }

  async cancelRepositoryObjectProtectedCopy(projectId, datasetId, jobId) {
    return parseRepositoryObjectProtectedCopyJob(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}/repository-protected-copies/${pathUuid(jobId, "repository copy job id")}/cancel`,
      {method: "POST"}
    ));
  }

  /** Attach one existing governed dataset to another editable project. */
  async attachDataset(projectId, datasetId) {
    return parseDataset(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}`,
        {method: "PUT"}
      )
    );
  }

  /** Remove a project reference after maps and publications stop using it. */
  async detachDataset(projectId, datasetId) {
    await this.request(
      `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}`,
      {method: "DELETE"}
    );
  }

  /** @returns {Promise<ExternalSource[]>} */
  async listSources(projectId, page = {}) {
    await this.assertCollectionContext(page.context);
    const records = parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/sources${pageQuery(page)}`, {
          ...(page.context ? this.collectionRequestOptions(page.context.organization, page.context) : {}), signal: page.signal
        }
      ),
      parseExternalSource,
      "external sources"
    );
    await this.assertCollectionContext(page.context);
    return records;
  }

  async listLayerArchives(projectId, datasetId, {signal, context = null} = {}) {
    await this.assertCollectionContext(context);
    const records = await this.request(`/projects/${pathUuid(projectId, "project id")}/sources/${pathUuid(datasetId, "layer id")}/archives`, {
      ...(context ? this.collectionRequestOptions(context.organization, context) : {}), signal
    });
    await this.assertCollectionContext(context);
    return records;
  }

  async listManagedDisplays(projectId, datasetId, versionId, {signal} = {}) {
    return this.request(`/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}/versions/${pathUuid(versionId, "version id")}/displays`, {signal});
  }

  async readManagedDisplay(projectId, datasetId, versionId, displayId, {signal} = {}) {
    return this.request(`/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}/versions/${pathUuid(versionId, "version id")}/displays/${pathUuid(displayId, "display id")}/read`, {
      method: "POST", body: {acknowledge_storage_cost: true}, signal
    });
  }

  async readLayerArchive(projectId, datasetId, archiveId, {signal} = {}) {
    return this.request(`/projects/${pathUuid(projectId, "project id")}/sources/${pathUuid(datasetId, "layer id")}/archives/${pathUuid(archiveId, "archive id")}/read`, {
      method: "POST", body: {acknowledge_storage_cost: true}, signal
    });
  }

  /** @returns {Promise<ExternalSource>} */
  async getSource(projectId, datasetId, {signal} = {}) {
    return parseExternalSource(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}/source`, {signal}
      )
    );
  }

  /** @returns {Promise<ExternalSource>} */
  async createSource(projectId, metadata, {context: originalContext = null} = {}) {
    const context = originalContext && Object.freeze({...originalContext});
    await this.assertCollectionContext(context);
    const record = object(metadata, "external source metadata");
    return parseExternalSource(
      await this.request(`/projects/${pathUuid(projectId, "project id")}/sources`, {
        ...(context ? this.collectionRequestOptions(context.organization, context) : {}),
        method: "POST",
        body: {
          name: record.name,
          description: record.description ?? null,
          classification: record.classification ?? "internal",
          tags: record.tags ?? [],
          source: serializeSourceDefinition(record.source),
          ...(record.discoveryJobId ? {discovery_job_id: pathUuid(record.discoveryJobId, "discovery job id")} : {})
        }
      })
    );
  }

  /** @returns {Promise<ExternalSource>} */
  async updateSource(projectId, datasetId, {expectedVersion, source, changeMessage = null,
    classification = null, expectedClassification = null, publicEligibilityReviewed = false}) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new TypeError("expectedVersion must be a positive integer");
    }
    if (classification !== null) {
      if (source != null) throw new TypeError("Choose a source revision or a source access decision");
      oneOf(classification, ["public", "internal", "confidential", "restricted"], "source classification");
      oneOf(expectedClassification, ["public", "internal", "confidential", "restricted"], "expected source classification");
      boolean(publicEligibilityReviewed, "public source eligibility review");
      if (classification === "public" && !publicEligibilityReviewed) throw new TypeError("Review public source eligibility before applying access");
      const organizationId = uuid(await this.organizationProvider(), "source account");
      const token = await this.tokenProvider();
      const assertContext = async () => {
        if (await this.organizationProvider() !== organizationId || await this.tokenProvider() !== token) {
          throw new ApiClientError("Your sign-in or selected account changed. Reopen this source before continuing.", {
            status: 409, code: "source_context_changed"
          });
        }
      };
      const value = await this.request(
        `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}/source`,
        {method: "PATCH", organizationId, token, beforeDispatch: assertContext,
          body: {expected_version: expectedVersion, expected_classification: expectedClassification,
            classification, public_eligibility_reviewed: publicEligibilityReviewed}}
      );
      await assertContext();
      const updated = parseExternalSource(value);
      if (updated.datasetId !== datasetId || updated.projectId !== projectId
        || updated.versionNumber !== expectedVersion || updated.classification !== classification) {
        contract("Source access changed unexpectedly");
      }
      return updated;
    }
    if (expectedClassification !== null || publicEligibilityReviewed) throw new TypeError("Access review belongs to a source access decision");
    return parseExternalSource(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}/source`,
        {
          method: "PATCH",
          body: {
            expected_version: expectedVersion,
            source: serializeSourceDefinition(source),
            ...(changeMessage ? {change_message: changeMessage} : {})
          }
        }
      )
    );
  }

  async listSourceRevisions(projectId, datasetId, page = {}) {
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}/source/revisions${pageQuery(page)}`
      ),
      parseExternalSourceRevision,
      "external source revisions"
    );
  }

  /** Start one bounded, asynchronous ArcGIS or WFS catalog/schema inspection. */
  async createSourceDiscovery(
    projectId,
    {sourceType, kind, serviceUrl, collectionRef = null, idempotencyKey}
  ) {
    const source = inputOneOf(sourceType, ["arcgis", "wfs"], "discovery source type");
    const discoveryKind = inputOneOf(kind, ["catalog", "collection"], "discovery kind");
    return parseSourceDiscoveryJob(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/source-discoveries`,
      {
        method: "POST",
        body: {
          source_type: source,
          kind: discoveryKind,
          service_url: sourceDiscoveryServiceUrl(serviceUrl, source),
          collection_ref: discoveryKind === "collection"
            ? boundedString(collectionRef, 200, "collection reference")
            : null,
          idempotency_key: assertUuid(idempotencyKey, "idempotency key")
        }
      }
    ));
  }

  /** @returns {Promise<SourceDiscoveryJob>} */
  async getMetadataRefreshCandidate(datasetId, projectId, jobId) {
    const result=boundedObject(await this.request(`/datasets/${pathUuid(datasetId,"dataset id")}/metadata-refresh/${pathUuid(projectId,"project id")}/${pathUuid(jobId,"job id")}`),65_536,"metadata refresh");
    if(result.dataset_id!==datasetId || result.discovery_job_id!==jobId) contract("Metadata refresh identity changed");
    integerBetween(result.source_revision,1,2_147_483_647,"source revision");
    oneOf(result.source_type,["arcgis","wfs"],"source type");
    sourceDiscoveryServiceUrl(result.service_url,result.source_type);
    boundedString(result.collection_ref,200,"collection");
    const doc=object(result.document,"retained response");
    exactKeys(doc,Object.hasOwn(doc,"body_base64")
      ? ["status","body_base64","byte_length","sha256","retrieved_at"]
      : ["status","byte_length","sha256","retrieved_at"],"retained response");
    if(doc.status==="retained") {
      boundedString(doc.body_base64,43_692,"response bytes");
      integerBetween(doc.byte_length,1,32_768,"response size");
    } else if(doc.status==="retained_object") {
      integerBetween(doc.byte_length,32_769,2_097_152,"response size");
      if(doc.body_base64!==undefined && doc.body_base64!==null) contract("Object response cannot contain inline bytes");
    } else contract("Response not retained");
    sha256(doc.sha256,"response checksum");timestamp(doc.retrieved_at,"retrieval time");
    return result;
  }

  /** Explicitly read a reviewed candidate's private saved bytes, never its provider. */
  async getMetadataRefreshResponse(datasetId, projectId, jobId, options) {
    return this._downloadMetadataResponse(
      `/datasets/${pathUuid(datasetId,"dataset id")}/metadata-refresh/${pathUuid(projectId,"project id")}/${pathUuid(jobId,"job id")}/response`,
      jobId, options
    );
  }

  /** Explicitly read a response retained by an accepted knowledge source. */
  async getKnowledgeSourceResponse(datasetId, jobId, options) {
    return this._downloadMetadataResponse(
      `/datasets/${pathUuid(datasetId,"dataset id")}/metadata-sources/${pathUuid(jobId,"job id")}/response`,
      jobId, options
    );
  }

  async _downloadMetadataResponse(path, jobId, {byteLength, checksumSha256, signal = AbortSignal.timeout(30_000)}) {
    const expectedJob = assertUuid(jobId,"discovery job id");
    const expectedSize = integerBetween(byteLength,32_769,2_097_152,"metadata response size");
    const expectedChecksum = sha256Checksum(checksumSha256,"metadata response checksum");
    const response = await this.requestResponse(path,{accept:"application/octet-stream",signal});
    return verifiedDiscoveryResponse(response,{jobId:expectedJob,expectedSize,expectedChecksum,requirePrivacyHeaders:true});
  }

  async acceptMetadataRefresh(datasetId, projectId, jobId, {expectedVersion, sourceRevision}) {
    return parseDatasetKnowledge(await this.request(`/datasets/${pathUuid(datasetId,"dataset id")}/metadata-refresh/${pathUuid(projectId,"project id")}/${pathUuid(jobId,"job id")}/accept`, {
      method:"POST",body:{expected_version:expectedVersion,source_revision:sourceRevision}
    }),datasetId);
  }

  async getDatasetDiscoveryMetadata(datasetId) {
    const result = boundedObject(await this.request(`/datasets/${pathUuid(datasetId,"dataset id")}/discovery-metadata`), 65_536, "discovery metadata");
    exactKeys(result,["dataset_id","discovery_job_id","source_type","service_url","collection_ref","document"],"discovery metadata");
    if (result.dataset_id !== datasetId) contract("Discovery metadata dataset changed");
    uuid(result.discovery_job_id,"discovery job id");
    oneOf(result.source_type,["arcgis","wfs"],"discovery source type");
    sourceDiscoveryServiceUrl(result.service_url,result.source_type);
    boundedString(result.collection_ref,200,"discovery collection");
    if(result.document!==null) {
      const doc=object(result.document,"discovery document");
      exactKeys(doc,["status","body_base64","byte_length","sha256","retrieved_at"],"discovery document");
      oneOf(doc.status,["retained","retained_object","not_retained_size"],"discovery retention status");
      integerBetween(doc.byte_length,1,2_097_152,"discovery byte length");
      sha256(doc.sha256,"discovery source checksum");timestamp(doc.retrieved_at,"discovery retrieval time");
      if(doc.status==="retained") {
        const body=boundedString(doc.body_base64,43_692,"discovery response bytes");
        if(doc.byte_length>32_768 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body)) contract("Invalid retained discovery body");
      } else if(doc.body_base64!==null || doc.byte_length<=32_768) contract("Invalid discovery object or omission");
    }
    return result;
  }

  /** Download a saved response deliberately; never contacts its provider. */
  async downloadDatasetDiscoveryResponse(
    datasetId, {discoveryJobId, byteLength, checksumSha256, signal = AbortSignal.timeout(30_000)}
  ) {
    const jobId = assertUuid(discoveryJobId, "discovery job id");
    const expectedSize = integerBetween(byteLength, 1, 2_097_152, "discovery response size");
    const expectedChecksum = sha256Checksum(checksumSha256, "discovery response checksum");
    const response = await this.requestResponse(
      `/datasets/${pathUuid(datasetId, "dataset id")}/discovery-metadata/response`,
      {accept: "application/octet-stream", signal}
    );
    return verifiedDiscoveryResponse(response,{jobId,expectedSize,expectedChecksum});
  }

  async getSourceDiscovery(projectId, discoveryJobId) {
    return parseSourceDiscoveryJob(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/source-discoveries/${pathUuid(discoveryJobId, "source discovery job id")}`
    ));
  }

  /** @returns {Promise<SourceDiscoveryJob[]>} */
  async listSourceDiscoveries(projectId, page = {}) {
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/source-discoveries${pageQuery(page)}`
      ),
      parseSourceDiscoveryJob,
      "source discovery jobs"
    );
  }

  /** @returns {Promise<SourceDiscoveryJob>} */
  async cancelSourceDiscovery(projectId, discoveryJobId) {
    return parseSourceDiscoveryJob(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/source-discoveries/${pathUuid(discoveryJobId, "source discovery job id")}/cancel`,
      {method: "POST"}
    ));
  }

  /** @returns {Promise<ExternalSourceCopyEstimate>} */
  async createExternalSourceCopyEstimate(
    projectId,
    sourceDatasetId,
    sourceRevisionNumber,
    {sourceType, scope}
  ) {
    const revision = inputIntegerBetween(
      sourceRevisionNumber, 1, Number.MAX_SAFE_INTEGER, "source revision number"
    );
    const source = inputOneOf(
      sourceType, ["wms", "pmtiles", "arcgis", "wfs"], "copy estimate source type"
    );
    return parseExternalSourceCopyEstimate(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(sourceDatasetId, "source dataset id")}/source/revisions/${revision}/copy-estimates`,
      {
        method: "POST",
        body: {source_type: source, scope: serializeCopyScope(source, scope)}
      }
    ));
  }

  /** @returns {Promise<ProtectedCopyJob>} */
  async createProtectedCopy(
    projectId,
    sourceDatasetId,
    sourceRevisionNumber,
    request
  ) {
    const revision = inputIntegerBetween(
      sourceRevisionNumber, 1, Number.MAX_SAFE_INTEGER, "source revision number"
    );
    return parseProtectedCopyJob(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(sourceDatasetId, "source dataset id")}/source/revisions/${revision}/protected-copies`,
      {
        method: "POST",
        body: {
          ...serializeProtectedCopyAcceptance(request),
          ...(request.refreshTarget ? {refresh_target: {
            dataset_id: pathUuid(request.refreshTarget.datasetId, "refresh Layer"),
            expected_base_version_id: pathUuid(request.refreshTarget.baseVersionId, "refresh base")
          }} : {})
        }
      }
    ));
  }

  /** @returns {Promise<ProtectedCopyJob[]>} */
  async listProtectedCopies(projectId, sourceDatasetId, page = {}) {
    return parseArray(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(sourceDatasetId, "source dataset id")}/protected-copies${pageQuery(page)}`
    ), parseProtectedCopyJob, "protected copy jobs");
  }

  /** @returns {Promise<ProtectedCopyJob>} */
  async getProtectedCopy(projectId, sourceDatasetId, jobId) {
    return parseProtectedCopyJob(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(sourceDatasetId, "source dataset id")}/protected-copies/${pathUuid(jobId, "protected copy job id")}`
    ));
  }

  /** @returns {Promise<ProtectedCopyJob>} */
  async cancelProtectedCopy(projectId, sourceDatasetId, jobId) {
    return parseProtectedCopyJob(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(sourceDatasetId, "source dataset id")}/protected-copies/${pathUuid(jobId, "protected copy job id")}/cancel`,
      {method: "POST"}
    ));
  }

  /** @returns {Promise<PmtilesDerivativeJob>} */
  async createPmtilesDerivative(projectId, datasetId, datasetVersionId, request) {
    const record = object(request, "PMTiles derivative request");
    const bounds = orderedGeographicBounds(record.bounds, "PMTiles derivative bounds", TypeError);
    const minZoom = inputIntegerBetween(record.minZoom, 0, 22, "PMTiles minimum zoom");
    const maxZoom = inputIntegerBetween(record.maxZoom, 0, 22, "PMTiles maximum zoom");
    if (minZoom > maxZoom) throw new TypeError("PMTiles minimum zoom must not exceed maximum zoom");
    return parsePmtilesDerivativeJob(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}/versions/${pathUuid(datasetVersionId, "dataset version id")}/pmtiles-derivatives`,
      {
        method: "POST",
        body: {
          idempotency_key: assertUuid(record.idempotencyKey, "PMTiles idempotency key"),
          bounds,
          min_zoom: minZoom,
          max_zoom: maxZoom,
          source_layer: boundedQuery(record.sourceLayer, 200, "PMTiles source layer")
        }
      }
    ));
  }

  /** @returns {Promise<PmtilesDerivativeJob[]>} */
  async listPmtilesDerivatives(projectId, datasetId, datasetVersionId, page = {}) {
    return parseArray(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}/versions/${pathUuid(datasetVersionId, "dataset version id")}/pmtiles-derivatives${pageQuery(page)}`
    ), parsePmtilesDerivativeJob, "PMTiles derivative jobs");
  }

  /** @returns {Promise<PmtilesDerivativeJob>} */
  async getPmtilesDerivative(projectId, datasetId, datasetVersionId, jobId) {
    return parsePmtilesDerivativeJob(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}/versions/${pathUuid(datasetVersionId, "dataset version id")}/pmtiles-derivatives/${pathUuid(jobId, "PMTiles derivative job id")}`
    ));
  }

  /** @returns {Promise<PmtilesDerivativeJob>} */
  async cancelPmtilesDerivative(projectId, datasetId, datasetVersionId, jobId) {
    return parsePmtilesDerivativeJob(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}/versions/${pathUuid(datasetVersionId, "dataset version id")}/pmtiles-derivatives/${pathUuid(jobId, "PMTiles derivative job id")}/cancel`,
      {method: "POST"}
    ));
  }

  /** @returns {Promise<ProjectImport>} */
  async createProjectImport(projectId, plan) {
    const record = object(plan, "project import plan");
    return parseProjectImport(
      await this.request(`/projects/${pathUuid(projectId, "project id")}/imports`, {
        method: "POST",
        body: {
          idempotency_key: assertUuid(record.idempotencyKey, "project import idempotency key"),
          map_id: assertUuid(record.mapId, "project import map id"),
          expected_map_version: record.expectedMapVersion,
          source_product: record.sourceProduct,
          source_version: record.sourceVersion,
          source_sha256: record.sourceSha256,
          plan_digest: record.planDigest,
          map_definition: record.mapDefinition,
          conversion_report: record.conversionReport,
          external_sources: (record.externalSources ?? []).map((value) => {
            const candidate = object(value, "external import candidate");
            return {
              import_ref: candidate.importRef,
              name: candidate.name,
              description: candidate.description ?? null,
              classification: candidate.classification ?? "internal",
              tags: candidate.tags ?? [],
              source: serializeSourceDefinition(candidate.source)
            };
          }),
          embedded_datasets: (record.embeddedDatasets ?? []).map((value) => {
            const candidate = object(value, "embedded import candidate");
            return {
              import_ref: candidate.importRef,
              name: candidate.name,
              description: candidate.description ?? null,
              classification: candidate.classification ?? "internal",
              format: candidate.format,
              filename: candidate.filename,
              content_type: candidate.contentType,
              size_bytes: candidate.sizeBytes,
              checksum_sha256: candidate.checksumSha256,
              tags: candidate.tags ?? []
            };
          })
        }
      })
    );
  }

  /** @returns {Promise<ProjectImport>} */
  async getProjectImport(projectId, importId) {
    return parseProjectImport(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/imports/${pathUuid(importId, "project import id")}`
      )
    );
  }

  /** @returns {Promise<ProjectImport>} */
  async bindProjectImportDataset(projectId, importId, importRef, datasetId) {
    if (typeof importRef !== "string" || !/^geolibre:[A-Za-z0-9._:-]{1,200}$/.test(importRef)) {
      throw new TypeError("project import reference is invalid");
    }
    return parseProjectImport(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/imports/${pathUuid(importId, "project import id")}/items/${encodeURIComponent(importRef)}/dataset`,
        {method: "PUT", body: {dataset_id: assertUuid(datasetId, "dataset id")}}
      )
    );
  }

  /** @returns {Promise<ProjectImport>} */
  async finalizeProjectImport(projectId, importId) {
    return parseProjectImport(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/imports/${pathUuid(importId, "project import id")}/finalize`,
        {method: "POST"}
      )
    );
  }

  /** @returns {Promise<ResourceSummary[]>} */
  async listDatasetResources(datasetId, {limit = 50, offset = 0} = {}) {
    const records = parseArray(await this.request(
      `/datasets/${encodeURIComponent(datasetId)}/resources?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`
    ), parseResourceSummary, "dataset resources");
    if (records.some(record => record.datasetId !== datasetId)) contract("Dataset resource binding changed");
    return records;
  }

  async listResources(projectId, filters = {}) {
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources${resourceQuery(filters)}`, {signal: filters.signal}
      ),
      parseResourceSummary,
      "governed resources"
    );
  }

  /** @returns {Promise<PublicCatalogPage>} */
  async listPublicResources(organizationId, filters = {}) {
    return parsePublicCatalogPage(
      await this.request(
        `/public/organizations/${pathUuid(organizationId, "organization id")}/resources${publicCatalogQuery(filters)}`,
        {anonymous: true}
      )
    );
  }

  /** @returns {Promise<PublicCatalogRecord>} */
  async getPublicResource(organizationId, projectId, resourceId) {
    return parsePublicCatalogRecord(
      await this.request(
        `/public/organizations/${pathUuid(organizationId, "organization id")}/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}`,
        {anonymous: true}
      )
    );
  }

  /** @returns {Promise<PublicSpatialPreview>} */
  async getPublicSpatialPreview(organizationId, projectId, resourceId) {
    return parsePublicSpatialPreview(
      await this.request(
        `/public/organizations/${pathUuid(organizationId, "organization id")}/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/spatial-preview`,
        {anonymous: true}
      )
    );
  }

  /** @returns {Promise<PublicDocumentPreview>} */
  async getPublicDocumentPreview(organizationId, projectId, resourceId) {
    return parsePublicDocumentPreview(
      await this.request(
        `/public/organizations/${pathUuid(organizationId, "organization id")}/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/document-preview`,
        {anonymous: true}
      )
    );
  }

  /** @returns {Promise<PublicDatasetDocumentPreview>} */
  async getPublicDatasetDocumentPreview(organizationId, projectId, resourceId) {
    return parsePublicDatasetDocumentPreview(
      await this.request(
        `/public/organizations/${pathUuid(organizationId, "organization id")}/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/dataset-document-preview`,
        {anonymous: true}
      )
    );
  }

  /** @returns {Promise<PublicMapPreview>} */
  async getPublicMapPreview(organizationId, projectId, resourceId) {
    return parsePublicMapPreview(
      await this.request(
        `/public/organizations/${pathUuid(organizationId, "organization id")}/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/map-preview`,
        {anonymous: true}
      )
    );
  }

  /** @returns {Promise<PublicSiteDirectoryPage>} */
  async listPublicSites(organizationId, {limit = 24, offset = 0} = {}) {
    const boundedLimit = inputIntegerBetween(limit, 1, 100, "public site directory limit");
    const boundedOffset = inputIntegerBetween(offset, 0, 10_000, "public site directory offset");
    const query = new URLSearchParams({
      limit: String(boundedLimit),
      offset: String(boundedOffset)
    });
    return parsePublicSiteDirectoryPage(
      await this.request(
        `/public/organizations/${pathUuid(organizationId, "organization id")}/publications?${query}`,
        {anonymous: true}
      )
    );
  }

  /** @returns {Promise<GovernedResource>} */
  async getResource(projectId, resourceId) {
    const project = pathUuid(projectId, "project id"), resource = pathUuid(resourceId, "resource id");
    const record = parseGovernedResource(
      await this.request(
        `/projects/${project}/resources/${resource}`
      )
    );
    if (record.projectId !== project || record.id !== resource) contract("Governed resource response scope mismatch");
    return record;
  }

  /** @returns {Promise<ResourceCapabilities>} */
  async getResourceCapabilities(projectId, resourceId) {
    return parseResourceCapabilities(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/capabilities`
      )
    );
  }

  /** @returns {Promise<ResourceRatingSummary>} */
  async getResourceRating(projectId, resourceId) {
    return parseResourceRatingSummary(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/resources/`
      + `${pathUuid(resourceId, "resource id")}/rating`
    ));
  }

  async setResourceRating(
    projectId,
    resourceId,
    {score, expectedVersion = null}
  ) {
    if (score !== null && (!Number.isSafeInteger(score) || score < 1 || score > 5)) {
      throw new TypeError("resource rating score is invalid");
    }
    if (expectedVersion !== null
      && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
      throw new TypeError("resource rating expected version is invalid");
    }
    return parseResourceRatingMutationReceipt(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/resources/`
      + `${pathUuid(resourceId, "resource id")}/rating`,
      {
        method: "POST",
        body: {score, expected_version: expectedVersion}
      }
    ));
  }

  async listProjectRecords(projectId, filters = {}) {
    return parseOgcRecordCollection(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/records/collections/resources/items${recordQuery(filters)}`
    ));
  }

  async getProjectRecord(projectId, resourceId, {language = null} = {}) {
    const query = language === null
      ? ""
      : `?${new URLSearchParams({language: languageTag(language, "record language")})}`;
    return parseOgcRecord(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/records/collections/resources/items/${pathUuid(resourceId, "resource id")}${query}`
    ));
  }

  /** @returns {Promise<MetadataProfile[]>} */
  async listMetadataProfiles({signal} = {}) {
    return parseArray(
      await this.request("/metadata-profiles", {signal}),
      parseMetadataProfile,
      "metadata profiles"
    );
  }

  /** @returns {Promise<MetadataProfile>} */
  async createMetadataProfile(draft) {
    const record = object(draft, "metadata profile draft");
    return parseMetadataProfile(await this.request("/metadata-profiles", {
      method: "POST",
      body: {
        slug: record.slug,
        title: record.title,
        description: record.description ?? null,
        definition: structuredClone(object(record.definition, "metadata profile definition"))
      }
    }));
  }

  /** @returns {Promise<MetadataProfile>} */
  async updateMetadataProfile(profileId, update) {
    const record = object(update, "metadata profile update");
    if (!Number.isSafeInteger(record.expectedVersion) || record.expectedVersion < 1) {
      throw new TypeError("metadata profile expectedVersion must be a positive integer");
    }
    return parseMetadataProfile(await this.request(
      `/metadata-profiles/${pathUuid(profileId, "metadata profile id")}`,
      {
        method: "PUT",
        body: {
          expected_version: record.expectedVersion,
          title: record.title,
          description: record.description ?? null,
          definition: structuredClone(object(record.definition, "metadata profile definition")),
          change_message: record.changeMessage ?? null
        }
      }
    ));
  }

  async validateResourceMetadata(projectId, resourceId, profileId, expectedProfileVersion) {
    if (!Number.isSafeInteger(expectedProfileVersion) || expectedProfileVersion < 1) {
      throw new TypeError("metadata profile version must be a positive integer");
    }
    return parseMetadataValidation(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/metadata/validate`,
      {
        method: "POST",
        body: {
          profile_id: assertUuid(profileId, "metadata profile id"),
          expected_profile_version: expectedProfileVersion
        }
      }
    ));
  }

  async exportResourceMetadata(projectId, resourceId, target, {language = null} = {}) {
    if (![
      "dcat_3",
      "stac_1_1",
      "ogc_records_1_0",
      "iso_19115_3",
      "schema_org_dataset",
      "datacite_4_7",
      "datacite_4_7_xml",
      "geodcat_ap_3_1"
    ].includes(target)) {
      throw new TypeError("metadata export target is invalid");
    }
    if (target !== "ogc_records_1_0" && language !== null) {
      throw new TypeError("metadata export language is only valid for OGC records");
    }
    const query = language === null
      ? ""
      : `?${new URLSearchParams({language: languageTag(language, "metadata export language")})}`;
    return parseMetadataExport(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/metadata/export/${target}${query}`
    ));
  }

  async importResourceMetadata(projectId, sourceFormat, draft) {
    if (![
      "dcat_3",
      "stac_1_1",
      "iso_19115_3",
      "schema_org_dataset",
      "datacite_4_7",
      "geodcat_ap_3_1"
    ].includes(sourceFormat)) {
      throw new TypeError("metadata source format is invalid");
    }
    const record = object(draft, "metadata import draft");
    const sourceNamespace = String(record.sourceNamespace ?? "").trim().toLowerCase();
    const slug = String(record.slug ?? "").trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/.test(sourceNamespace)) {
      throw new TypeError("metadata source namespace is invalid");
    }
    if (!/^[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?$/.test(slug)) {
      throw new TypeError("metadata resource slug is invalid");
    }
    const managedProfileId = record.managedProfileId ?? null;
    const managedProfileVersion = record.managedProfileVersion ?? null;
    if ((managedProfileId === null) !== (managedProfileVersion === null)) {
      throw new TypeError("managed metadata profile id and version are required together");
    }
    if (managedProfileVersion !== null
      && (!Number.isSafeInteger(managedProfileVersion) || managedProfileVersion < 1)) {
      throw new TypeError("managed metadata profile version must be a positive integer");
    }
    const document = sourceFormat === "iso_19115_3"
      ? boundedUtf8String(record.document, 49_152, "ISO metadata source document")
      : boundedObject(record.document, 49_152, "metadata source document");
    return parseMetadataImport(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/resources/imports/metadata/${sourceFormat}`,
      {
        method: "POST",
        body: {
          source_namespace: sourceNamespace,
          slug,
          visibility: oneOf(
            record.visibility ?? "restricted",
            ["restricted", "organization"],
            "metadata import visibility"
          ),
          document,
          source_sha256: sha256(record.sourceSha256, "metadata source checksum"),
          managed_profile_id: managedProfileId === null
            ? null
            : assertUuid(managedProfileId, "managed metadata profile id"),
          managed_profile_version: managedProfileVersion
        }
      }
    ));
  }

  /** @returns {Promise<MetadataSource>} */
  async getResourceMetadataSource(projectId, resourceId) {
    return parseMetadataSource(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/metadata/source`
    ));
  }

  /** @returns {Promise<GovernedResource>} */
  async createResource(projectId, draft) {
    const record = object(draft, "resource draft");
    return parseGovernedResource(
      await this.request(`/projects/${pathUuid(projectId, "project id")}/resources`, {
        method: "POST",
        body: serializeResourceDraft(record)
      })
    );
  }

  /** @returns {Promise<GovernedResource>} */
  async updateResource(projectId, resourceId, update) {
    const record = object(update, "resource update");
    if (Object.hasOwn(record, "state")) {
      throw new TypeError("resource workflow state must use transitionResource");
    }
    if (!Number.isSafeInteger(record.expectedVersion) || record.expectedVersion < 1) {
      throw new TypeError("resource expectedVersion must be a positive integer");
    }
    return parseGovernedResource(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}`,
        {
          method: "PUT",
          body: {
            expected_version: record.expectedVersion,
            ...serializeExpectedMapVersion(record),
            visibility: record.visibility,
            metadata: serializeResourceMetadata(record.metadata),
            content: serializeResourceContent(record.content),
            provenance: record.provenance ?? {},
            change_message: record.changeMessage ?? null
          }
        }
      )
    );
  }

  async requestPageSourceUpload(
    projectId,
    resourceId,
    {expectedVersion, sourceBlockId, sizeBytes, checksumSha256}
  ) {
    return parsePageSourceUploadTicket(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/page-source-uploads`,
        {
          method: "POST",
          body: {
            expected_version: positiveInteger(expectedVersion, "page source expected version"),
            source_block_id: pageBlockIdentifier(sourceBlockId, "page source block id"),
            size_bytes: positiveInteger(sizeBytes, "page source size"),
            checksum_sha256: sha256Checksum(checksumSha256, "page source checksum")
          }
        }
      )
    );
  }

  async createPageVersion(projectId, resourceId, uploadId, update) {
    const record = object(update, "page version update");
    return parsePageVersion(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/page-versions`,
        {
          method: "POST",
          body: {
            upload_id: assertUuid(uploadId, "page source upload id"),
            expected_version: positiveInteger(record.expectedVersion, "page expected version"),
            visibility: record.visibility,
            metadata: serializeResourceMetadata(record.metadata),
            content: serializeResourceContent(record.content),
            provenance: record.provenance ?? {},
            change_message: boundedQuery(record.changeMessage, 500, "page change summary")
          }
        }
      )
    );
  }

  async savePageVersion(projectId, resourceId, update, {sourceBlockId, sourceMarkdown}) {
    if (typeof sourceMarkdown !== "string" || !sourceMarkdown.length) {
      throw new TypeError("page source must be non-empty UTF-8 Markdown");
    }
    const source = new Blob([sourceMarkdown], {type: "text/markdown"});
    if (source.size > 65_536) throw new TypeError("page source exceeds 65536 UTF-8 bytes");
    const digest = await crypto.subtle.digest("SHA-256", await source.arrayBuffer());
    const checksumSha256 = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const ticket = await this.requestPageSourceUpload(projectId, resourceId, {
      expectedVersion: update.expectedVersion,
      sourceBlockId,
      sizeBytes: source.size,
      checksumSha256
    });
    if (Date.parse(ticket.expiresAt) <= Date.now()) {
      throw new ApiClientError("The page source upload expired", {code: "page_source_upload_expired"});
    }
    await this.uploadFile(ticket.upload, source);
    return this.createPageVersion(projectId, resourceId, ticket.uploadId, update);
  }

  /** @returns {Promise<PageWorkingDraft | null>} */
  async getPageWorkingDraft(projectId, resourceId) {
    const value = await this.request(
      `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/page-draft`
    );
    return value === null ? null : parsePageWorkingDraft(value);
  }

  /** @returns {Promise<PageWorkingDraft>} */
  async savePageWorkingDraft(projectId, resourceId, update, {sourceBlockId, sourceMarkdown}) {
    const record = object(update, "page working draft update");
    if (sourceBlockId !== null) pageBlockIdentifier(sourceBlockId, "page draft source block id");
    if (typeof sourceMarkdown !== "string" || sourceMarkdown.length > 8_000) {
      throw new TypeError("page draft source must be at most 8000 characters");
    }
    return parsePageWorkingDraft(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/page-draft`,
        {
          method: "PUT",
          body: {
            expected_resource_version: positiveInteger(
              record.expectedVersion,
              "page draft expected resource version"
            ),
            expected_draft_revision: nonNegativeInteger(
              record.expectedDraftRevision,
              "page draft expected revision"
            ),
            visibility: oneOf(
              record.visibility,
              ["restricted", "organization"],
              "page draft visibility"
            ),
            metadata: serializeResourceMetadata(record.metadata),
            content: serializeResourceContent(record.content),
            provenance: record.provenance ?? {},
            source_block_id: sourceBlockId,
            source_markdown: sourceMarkdown,
            change_summary: record.changeMessage ?? null
          }
        }
      )
    );
  }

  async discardPageWorkingDraft(
    projectId,
    resourceId,
    {expectedVersion, expectedDraftRevision}
  ) {
    const query = new URLSearchParams({
      expected_resource_version: String(positiveInteger(
        expectedVersion,
        "page draft expected resource version"
      )),
      expected_draft_revision: String(positiveInteger(
        expectedDraftRevision,
        "page draft expected revision"
      ))
    });
    await this.request(
      `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/page-draft?${query}`,
      {method: "DELETE"}
    );
  }

  /** @returns {Promise<PagePreview>} */
  async previewPageVersion(
    projectId,
    resourceId,
    versionNumber,
    {title, abstract = null, content}
  ) {
    return parsePagePreview(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/page-versions/${positiveInteger(versionNumber, "page version")}/preview`,
        {
          method: "POST",
          body: {
            title: boundedString(title, 300, "page preview.title"),
            abstract: abstract === null
              ? null
              : boundedString(abstract, 8_000, "page preview.abstract"),
            content: serializeResourceContent(content)
          }
        }
      )
    );
  }

  async listPageVersions(projectId, resourceId) {
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/page-versions`
      ),
      parsePageSource,
      "page source history"
    );
  }

  async getPageSource(projectId, resourceId, versionNumber = null) {
    const suffix = versionNumber === null
      ? "/page-source"
      : `/page-versions/${positiveInteger(versionNumber, "page version")}/source`;
    return parsePageSource(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}${suffix}`
      )
    );
  }

  /** @returns {Promise<GovernedResource>} */
  async bindResource(projectId, resourceId, {expectedVersion, datasetId = null, mapId = null}) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new TypeError("resource expectedVersion must be a positive integer");
    }
    if ((datasetId === null) === (mapId === null)) {
      throw new TypeError("exactly one datasetId or mapId is required");
    }
    return parseGovernedResource(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/binding`,
        {
          method: "PUT",
          body: {
            expected_version: expectedVersion,
            dataset_id: datasetId === null ? null : assertUuid(datasetId, "dataset id"),
            map_id: mapId === null ? null : assertUuid(mapId, "map id")
          }
        }
      )
    );
  }

  /** @returns {Promise<GovernedResource>} */
  async transitionResource(projectId, resourceId, {expectedVersion, targetState, visibility = null, reason = null}) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new TypeError("resource expectedVersion must be a positive integer");
    }
    if (!["review", "published", "archived"].includes(targetState)) {
      throw new TypeError("resource targetState is invalid");
    }
    if (targetState === "published" && !["organization", "public"].includes(visibility)) {
      throw new TypeError("published resources require organization or public visibility");
    }
    if (targetState !== "published" && visibility !== null) {
      throw new TypeError("visibility is accepted only when publishing");
    }
    return parseGovernedResource(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/transitions`,
        {
          method: "POST",
          body: {
            expected_version: expectedVersion,
            target_state: targetState,
            visibility,
            reason
          }
        }
      )
    );
  }

  async setResourcePublicationVisibility(projectId, resourceId, {expectedVersion, expectedVisibility, visibility}) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new TypeError("resource expectedVersion must be a positive integer");
    }
    oneOf(expectedVisibility, ["restricted", "organization", "public"], "expected resource audience");
    oneOf(visibility, ["organization", "public"], "resource publication audience");
    const organizationId = uuid(await this.organizationProvider(), "resource account");
    const token = await this.tokenProvider();
    const assertContext = async () => {
      if (await this.organizationProvider() !== organizationId || await this.tokenProvider() !== token) {
        throw new ApiClientError("Your sign-in or selected account changed. Reopen this resource before continuing.", {
          status: 409, code: "resource_context_changed"
        });
      }
    };
    const value = await this.request(
      `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/publication-visibility`,
      {method: "PUT", organizationId, token, beforeDispatch: assertContext,
        body: {expected_version: expectedVersion, expected_visibility: expectedVisibility, visibility}}
    );
    await assertContext();
    const resource = parseGovernedResource(value);
    if (resource.id !== resourceId || resource.projectId !== projectId || resource.versionNumber !== expectedVersion
      || resource.visibility !== visibility || resource.state !== "published") contract("Resource publication audience changed unexpectedly");
    return resource;
  }

  async listResourcePermissions(projectId, resourceId) {
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/permissions`
      ),
      parseResourcePermission,
      "resource permissions"
    );
  }

  async putResourcePermission(projectId, resourceId, userId, role) {
    if (!["manage", "edit", "publish", "view"].includes(role)) {
      throw new TypeError("resource permission role is invalid");
    }
    return parseResourcePermission(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/permissions/${pathUuid(userId, "user id")}`,
        {method: "PUT", body: {role}}
      )
    );
  }

  async deleteResourcePermission(projectId, resourceId, userId) {
    await this.request(
      `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/permissions/${pathUuid(userId, "user id")}`,
      {method: "DELETE"}
    );
  }

  async listResourceStyles(projectId, resourceId, {includeArchived = false} = {}) {
    boolean(includeArchived, "styles includeArchived");
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/styles${includeArchived ? "?include_archived=true" : ""}`
      ),
      parseResourceStyle,
      "resource styles"
    );
  }

  async getResourceStyleVersion(projectId, resourceId, styleId, versionNumber) {
    const version = positiveInteger(versionNumber, "style version");
    const record = parseResourceStyle(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/styles/${pathUuid(styleId, "style id")}/versions/${version}`
    ));
    if (record.id !== styleId || record.resourceId !== resourceId || record.versionNumber !== version) {
      throw new TypeError("style version identity mismatch");
    }
    return record;
  }

  async createResourceStyle(projectId, resourceId, style) {
    const record = object(style, "resource style");
    return parseResourceStyle(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/styles`,
        {
          method: "POST",
          body: {
            slug: record.slug,
            format: record.format,
            title: record.title,
            definition: record.definition
          }
        }
      )
    );
  }

  async archiveResourceStyle(projectId, resourceId, styleId, {expectedVersion}) {
    return parseResourceStyle(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/styles/${pathUuid(styleId, "style id")}/archive`,
      {method: "POST", body: {expected_version: positiveInteger(expectedVersion, "style expectedVersion")}}
    ));
  }

  async restoreResourceStyle(projectId, resourceId, styleId, {expectedVersion}) {
    return parseResourceStyle(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/styles/${pathUuid(styleId, "style id")}/restore`,
      {method: "POST", body: {expected_version: positiveInteger(expectedVersion, "style expectedVersion")}}
    ));
  }

  async importMapServerStyle(projectId, resourceId, source) {
    const record = object(source, "MapServer style import");
    return parseMapServerStyleImport(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/styles/imports/mapserver`,
        {
          method: "POST",
          body: {
            slug: record.slug,
            title: record.title,
            mapfile: record.mapfile,
            layer_name: record.layerName ?? null,
            mapscript: record.mapscript ?? null
          }
        }
      )
    );
  }

  async exportMapServerStyle(projectId, resourceId, styleId) {
    return parseMapServerStyleExport(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/styles/${pathUuid(styleId, "style id")}/exports/mapserver`
      )
    );
  }

  async updateResourceStyle(projectId, resourceId, styleId, update) {
    const record = object(update, "resource style update");
    if (!Number.isSafeInteger(record.expectedVersion) || record.expectedVersion < 1) {
      throw new TypeError("style expectedVersion must be a positive integer");
    }
    return parseResourceStyle(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/styles/${pathUuid(styleId, "style id")}`,
        {
          method: "PUT",
          body: {
            expected_version: record.expectedVersion,
            format: record.format,
            title: record.title,
            definition: record.definition,
            change_message: record.changeMessage ?? null
          }
        }
      )
    );
  }

  /** @returns {Promise<WmsPublication[]>} */
  async listWmsPublications(projectId) {
    return parseArray(
      await this.request(`/projects/${pathUuid(projectId, "project id")}/wms-publications`),
      parseWmsPublication,
      "WMS publications"
    );
  }

  /** @returns {Promise<WmsPublication>} */
  async createWmsPublication(projectId, resourceId, {name, defaultProfileId}) {
    if (typeof name !== "string" || !WMS_PUBLICATION_NAME_PATTERN.test(name)) {
      throw new TypeError("WMS publication name is invalid");
    }
    return parseWmsPublication(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/wms-publications`,
        {
          method: "POST",
          body: {
            name,
            default_profile_id: assertUuid(defaultProfileId, "default render profile id")
          }
        }
      )
    );
  }

  /** @returns {Promise<WmsPublication>} */
  async withdrawWmsPublication(projectId, resourceId, publicationId) {
    return parseWmsPublication(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/wms-publications/${pathUuid(publicationId, "WMS publication id")}/withdraw`,
        {method: "POST"}
      )
    );
  }

  /** @returns {Promise<PublicWmsService[]>} */
  async listPublicWmsServices(projectId) {
    return parseArray(
      await this.request(`/projects/${pathUuid(projectId, "project id")}/public-wms-services`),
      parsePublicWmsService,
      "public WMS services"
    );
  }

  /** @returns {Promise<PublicWmsService>} */
  async createPublicWmsService(projectId, {title}) {
    return parsePublicWmsService(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/public-wms-services`,
        {
          method: "POST",
          body: {title: boundedQuery(title, 200, "public WMS service title")}
        }
      )
    );
  }

  /** @returns {Promise<PublicWmsService>} */
  async disablePublicWmsService(projectId, serviceId) {
    return parsePublicWmsService(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/public-wms-services/${pathUuid(serviceId, "public WMS service id")}/disable`,
        {method: "POST"}
      )
    );
  }

  /** @returns {Promise<GeoNodeFederationSource[]>} */
  async listGeoNodeFederations(projectId, page = {}) {
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/geonode-federations${pageQuery(page)}`
      ),
      parseGeoNodeFederationSource,
      "GeoNode federation sources"
    );
  }

  /** @returns {Promise<GeoNodeFederationSource>} */
  async createGeoNodeFederation(projectId, configuration) {
    return parseGeoNodeFederationSource(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/geonode-federations`,
      {
        method: "POST",
        body: {configuration: serializeGeoNodeFederationConfiguration(configuration)}
      }
    ));
  }

  /** @returns {Promise<GeoNodeFederationSource>} */
  async disableGeoNodeFederation(projectId, sourceId) {
    return parseGeoNodeFederationSource(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/geonode-federations/${pathUuid(sourceId, "GeoNode federation source id")}/disable`,
      {method: "POST"}
    ));
  }

  /** @returns {Promise<GeoNodeHarvestJob>} */
  async createGeoNodeHarvest(projectId, sourceId, {idempotencyKey}) {
    return parseGeoNodeHarvestJob(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/geonode-federations/${pathUuid(sourceId, "GeoNode federation source id")}/harvests`,
      {
        method: "POST",
        body: {idempotency_key: assertUuid(idempotencyKey, "GeoNode harvest idempotency key")}
      }
    ));
  }

  /** @returns {Promise<GeoNodeHarvestJob[]>} */
  async listGeoNodeHarvests(projectId, sourceId, page = {}) {
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/geonode-federations/${pathUuid(sourceId, "GeoNode federation source id")}/harvests${pageQuery(page)}`
      ),
      parseGeoNodeHarvestJob,
      "GeoNode harvest jobs"
    );
  }

  /** @returns {Promise<GeoNodeHarvestJob>} */
  async cancelGeoNodeHarvest(projectId, sourceId, jobId) {
    return parseGeoNodeHarvestJob(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/geonode-federations/${pathUuid(sourceId, "GeoNode federation source id")}/harvests/${pathUuid(jobId, "GeoNode harvest job id")}/cancel`,
      {method: "POST"}
    ));
  }

  /** @returns {Promise<GeoNodeFederatedResource[]>} */
  async listGeoNodeFederatedResources(projectId, sourceId, page = {}) {
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/geonode-federations/${pathUuid(sourceId, "GeoNode federation source id")}/resources${pageQuery(page)}`
      ),
      parseGeoNodeFederatedResource,
      "GeoNode federated resources"
    );
  }

  /** @returns {Promise<GeoNodeFederatedResourceVersion[]>} */
  async listGeoNodeFederatedResourceVersions(
    projectId, sourceId, remoteIdentifier, page = {}
  ) {
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/geonode-federations/${pathUuid(sourceId, "GeoNode federation source id")}/resources/${pathUuid(remoteIdentifier, "GeoNode remote resource id")}/versions${pageQuery(page)}`
      ),
      parseGeoNodeFederatedResourceVersion,
      "GeoNode federated resource versions"
    );
  }

  /** @returns {Promise<SpatialService[]>} */
  async listSpatialServices(projectId, {signal} = {}) {
    return parseArray(
      await this.request(`/projects/${pathUuid(projectId, "project id")}/spatial-services`, {signal}),
      parseSpatialService,
      "spatial services"
    );
  }

  /** @returns {Promise<SpatialService>} */
  async createSpatialService(projectId, {slug, title, description = null}) {
    if (typeof slug !== "string" || !SPATIAL_SERVICE_SLUG_PATTERN.test(slug)) {
      throw new TypeError("spatial service slug is invalid");
    }
    return parseSpatialService(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/spatial-services`,
      {
        method: "POST",
        body: {
          slug,
          title: boundedQuery(title, 200, "spatial service title"),
          description: description === null
            ? null
            : boundedQuery(description, 2000, "spatial service description")
        }
      }
    ));
  }

  /** @returns {Promise<SpatialService>} */
  async disableSpatialService(projectId, serviceId) {
    return parseSpatialService(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/spatial-services/${pathUuid(serviceId, "spatial service id")}/disable`,
      {method: "POST"}
    ));
  }

  /** @returns {Promise<SpatialServiceCollection[]>} */
  async listSpatialServiceCollections(projectId, serviceId, {includeWithdrawn = false} = {}) {
    if (typeof includeWithdrawn !== "boolean") {
      throw new TypeError("includeWithdrawn must be boolean");
    }
    const query = includeWithdrawn ? "?include_withdrawn=true" : "";
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/spatial-services/${pathUuid(serviceId, "spatial service id")}/collections${query}`
      ),
      parseSpatialServiceCollection,
      "spatial service collections"
    );
  }

  /** @returns {Promise<SpatialServiceCollection>} */
  async createSpatialServiceCollection(projectId, serviceId, draft) {
    const record = object(draft, "spatial service collection");
    if (typeof record.collectionName !== "string"
      || !SPATIAL_SERVICE_SLUG_PATTERN.test(record.collectionName)) {
      throw new TypeError("spatial service collection name is invalid");
    }
    return parseSpatialServiceCollection(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/spatial-services/${pathUuid(serviceId, "spatial service id")}/collections`,
      {
        method: "POST",
        body: {
          collection_name: record.collectionName,
          dataset_id: assertUuid(record.datasetId, "spatial service dataset id"),
          resource_id: assertUuid(record.resourceId, "spatial service resource id"),
          default_profile_id: assertUuid(
            record.defaultProfileId,
            "spatial service default profile id"
          ),
          expected_feature_generation: positiveInteger(
            record.expectedFeatureGeneration,
            "spatial service expected feature generation"
          ),
          expected_profile_version: positiveInteger(
            record.expectedProfileVersion,
            "spatial service expected profile version"
          ),
          title: boundedQuery(record.title, 300, "spatial service collection title"),
          description: record.description === null || record.description === undefined
            ? null
            : boundedQuery(
              record.description,
              2000,
              "spatial service collection description"
            )
        }
      }
    ));
  }

  /** @returns {Promise<SpatialServiceCollection>} */
  async withdrawSpatialServiceCollection(projectId, serviceId, bindingId) {
    return parseSpatialServiceCollection(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/spatial-services/${pathUuid(serviceId, "spatial service id")}/collections/${pathUuid(bindingId, "spatial service binding id")}/withdraw`,
      {method: "POST"}
    ));
  }

  /** @returns {Promise<SpatialServiceCatalog>} */
  async getSpatialServiceCatalog(projectId, serviceId) {
    return parseSpatialServiceCatalog(await this.request(
      `${spatialCatalogPath(projectId, serviceId)}`
    ));
  }

  /** @returns {Promise<SpatialServiceMetadata>} */
  async updateSpatialServiceMetadata(projectId, serviceId, draft) {
    return parseSpatialServiceMetadata(await this.request(
      `${spatialCatalogPath(projectId, serviceId)}/metadata`,
      {method: "PUT", body: spatialCatalogMetadataBody(draft)}
    ));
  }

  /** @returns {Promise<SpatialServiceStore>} */
  async createSpatialServiceStore(projectId, serviceId, draft) {
    return parseSpatialServiceStore(await this.request(
      `${spatialCatalogPath(projectId, serviceId)}/stores`,
      {method: "POST", body: spatialCatalogStoreBody(draft)}
    ));
  }

  /** @returns {Promise<SpatialServiceStore>} */
  async disableSpatialServiceStore(projectId, serviceId, storeId) {
    return parseSpatialServiceStore(await this.request(
      `${spatialCatalogPath(projectId, serviceId)}/stores/${pathUuid(storeId, "spatial service store id")}/disable`,
      {method: "POST"}
    ));
  }

  /** @returns {Promise<SpatialServiceLayerGroup>} */
  async putSpatialServiceLayerGroup(projectId, serviceId, slug, draft) {
    if (typeof slug !== "string" || !SPATIAL_SERVICE_SLUG_PATTERN.test(slug)) {
      throw new TypeError("spatial service layer group slug is invalid");
    }
    return parseSpatialServiceLayerGroup(await this.request(
      `${spatialCatalogPath(projectId, serviceId)}/layer-groups/${encodeURIComponent(slug)}`,
      {method: "PUT", body: spatialCatalogLayerGroupBody(draft)}
    ));
  }

  /** @returns {Promise<SpatialServiceLayerGroup>} */
  async disableSpatialServiceLayerGroup(projectId, serviceId, groupId) {
    return parseSpatialServiceLayerGroup(await this.request(
      `${spatialCatalogPath(projectId, serviceId)}/layer-groups/${pathUuid(groupId, "spatial service layer group id")}/disable`,
      {method: "POST"}
    ));
  }

  /** @returns {Promise<SpatialServiceCollectionStyle>} */
  async assignSpatialServiceCollectionStyle(projectId, serviceId, collectionId, draft) {
    return parseSpatialServiceCollectionStyle(await this.request(
      `${spatialCatalogPath(projectId, serviceId)}/collections/${pathUuid(collectionId, "spatial service collection id")}/styles`,
      {method: "POST", body: spatialCatalogStyleBody(draft)}
    ));
  }

  /** @returns {Promise<SpatialServiceCollectionStyle>} */
  async withdrawSpatialServiceCollectionStyle(projectId, serviceId, styleBindingId) {
    return parseSpatialServiceCollectionStyle(await this.request(
      `${spatialCatalogPath(projectId, serviceId)}/styles/${pathUuid(styleBindingId, "spatial service style binding id")}/withdraw`,
      {method: "POST"}
    ));
  }

  /** @returns {Promise<{appliedOperations: number, operationResults: object[], catalog: SpatialServiceCatalog}>} */
  async applySpatialServiceCatalogBulk(projectId, serviceId, operations) {
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > 64) {
      throw new TypeError("spatial service catalog bulk operations are invalid");
    }
    const body = {operations: structuredClone(operations)};
    if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 262_144) {
      throw new TypeError("spatial service catalog bulk request is too large");
    }
    return parseSpatialServiceCatalogBulk(await this.request(
      `${spatialCatalogPath(projectId, serviceId)}/bulk`,
      {method: "POST", body}
    ));
  }

  /** @returns {Promise<TileCachePolicy>} */
  async getTileCachePolicy(projectId, serviceId, bindingId) {
    return parseTileCachePolicy(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/spatial-services/${pathUuid(serviceId, "spatial service id")}/collections/${pathUuid(bindingId, "spatial service binding id")}/tile-cache`
    ));
  }

  /** @returns {Promise<TileCachePolicy>} */
  async configureTileCachePolicy(projectId, serviceId, bindingId, input) {
    const minimum = integerBetween(input.minimumTileMatrix, 0, 22, "minimum tile zoom");
    const body = {
      expected_version: integerBetween(input.expectedVersion, 0, Number.MAX_SAFE_INTEGER, "cache version"),
      minimum_tile_matrix: minimum,
      maximum_tile_matrix: integerBetween(input.maximumTileMatrix, minimum, 22, "maximum tile zoom"),
      maximum_entries: integerBetween(input.maximumEntries, 1, 10000, "maximum stored tiles"),
      change_message: nullableBoundedString(input.changeMessage, 500, "cache change note")
    };
    return parseTileCachePolicy(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/spatial-services/${pathUuid(serviceId, "spatial service id")}/collections/${pathUuid(bindingId, "spatial service binding id")}/tile-cache`,
      {method: "PUT", body}
    ));
  }

  /** @returns {Promise<TileSeedPlanPreview>} */
  async previewTileSeedPlan(projectId, serviceId, bindingId, selector) {
    return parseTileSeedPlanPreview(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/spatial-services/${pathUuid(serviceId, "spatial service id")}/collections/${pathUuid(bindingId, "spatial service binding id")}/tile-cache/seed-plans/preview`,
      {method: "POST", body: tileSeedSelectorBody(selector)}
    ));
  }

  /** @returns {Promise<TileSeedPlan>} */
  async confirmTileSeedPlan(projectId, serviceId, bindingId, selector, preview) {
    const confirmation = object(preview, "tile seed plan preview");
    return parseTileSeedPlan(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/spatial-services/${pathUuid(serviceId, "spatial service id")}/collections/${pathUuid(bindingId, "spatial service binding id")}/tile-cache/seed-plans`,
      {
        method: "POST",
        body: {
          ...tileSeedSelectorBody(selector),
          preview_checksum_sha256: sha256(
            confirmation.previewChecksumSha256,
            "tile seed plan preview checksum"
          ),
          preview_expires_at: timestamp(
            confirmation.expiresAt,
            "tile seed plan preview expiry"
          )
        }
      }
    ));
  }

  /** @returns {Promise<TileSeedPlan[]>} */
  async listTileSeedPlans(projectId, serviceId, bindingId) {
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/spatial-services/${pathUuid(serviceId, "spatial service id")}/collections/${pathUuid(bindingId, "spatial service binding id")}/tile-cache/seed-plans`
      ),
      parseTileSeedPlan,
      "tile seed plans"
    );
  }

  /** @returns {Promise<TileSeedPlan>} */
  async cancelTileSeedPlan(projectId, serviceId, bindingId, planId) {
    return parseTileSeedPlan(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/spatial-services/${pathUuid(serviceId, "spatial service id")}/collections/${pathUuid(bindingId, "spatial service binding id")}/tile-cache/seed-plans/${pathUuid(planId, "tile seed plan id")}/cancel`,
      {method: "POST"}
    ));
  }

  /** @returns {Promise<RetiredTileCacheVersion[]>} */
  async listRetiredTileCacheVersions(projectId, serviceId, bindingId) {
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/spatial-services/${pathUuid(serviceId, "spatial service id")}/collections/${pathUuid(bindingId, "spatial service binding id")}/tile-cache/retired-versions`
      ),
      parseRetiredTileCacheVersion,
      "retired tile cache versions"
    );
  }

  /** @returns {Promise<TileCacheReclamationPreview>} */
  async previewTileCacheReclamation(projectId, serviceId, bindingId, cacheVersionId) {
    return parseTileCacheReclamationPreview(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/spatial-services/${pathUuid(serviceId, "spatial service id")}/collections/${pathUuid(bindingId, "spatial service binding id")}/tile-cache/versions/${pathUuid(cacheVersionId, "tile cache version id")}/reclamation-preview`,
      {method: "POST"}
    ));
  }

  /** @returns {Promise<TileCacheReclamation>} */
  async reclaimTileCacheOutputs(projectId, serviceId, bindingId, cacheVersionId, preview) {
    const record = object(preview, "tile cache reclamation preview");
    return parseTileCacheReclamation(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/spatial-services/${pathUuid(serviceId, "spatial service id")}/collections/${pathUuid(bindingId, "spatial service binding id")}/tile-cache/versions/${pathUuid(cacheVersionId, "tile cache version id")}/reclaim`,
      {
        method: "POST",
        body: {
          preview_checksum_sha256: sha256(
            record.previewChecksumSha256,
            "tile cache reclamation preview checksum"
          ),
          preview_expires_at: timestamp(
            record.expiresAt,
            "tile cache reclamation preview expiry"
          )
        }
      }
    ));
  }

  /** @returns {Promise<SpatialCoverage[]>} */
  async listSpatialServiceCoverages(projectId, serviceId, {includeWithdrawn = false} = {}) {
    if (typeof includeWithdrawn !== "boolean") {
      throw new TypeError("includeWithdrawn must be boolean");
    }
    const query = includeWithdrawn ? "?include_withdrawn=true" : "";
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/spatial-services/${pathUuid(serviceId, "spatial service id")}/coverages${query}`
      ),
      parseSpatialCoverage,
      "spatial service coverages"
    );
  }

  /** @returns {Promise<SpatialCoverage>} */
  async createSpatialServiceCoverage(projectId, serviceId, draft) {
    const record = object(draft, "spatial service coverage");
    if (typeof record.coverageName !== "string"
      || !SPATIAL_SERVICE_SLUG_PATTERN.test(record.coverageName)) {
      throw new TypeError("spatial service coverage name is invalid");
    }
    return parseSpatialCoverage(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/spatial-services/${pathUuid(serviceId, "spatial service id")}/coverages`,
      {
        method: "POST",
        body: {
          coverage_name: record.coverageName,
          dataset_id: assertUuid(record.datasetId, "spatial service coverage dataset id"),
          dataset_version_id: assertUuid(
            record.datasetVersionId,
            "spatial service coverage dataset version id"
          ),
          data_object_id: assertUuid(
            record.dataObjectId,
            "spatial service coverage object id"
          ),
          expected_dataset_version: positiveInteger(
            record.expectedDatasetVersion,
            "spatial service coverage expected dataset version"
          ),
          title: boundedQuery(record.title, 300, "spatial service coverage title"),
          description: record.description === null || record.description === undefined
            ? null
            : boundedQuery(
              record.description,
              2000,
              "spatial service coverage description"
            )
        }
      }
    ));
  }

  /** @returns {Promise<SpatialCoverage>} */
  async withdrawSpatialServiceCoverage(projectId, serviceId, coverageId) {
    return parseSpatialCoverage(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/spatial-services/${pathUuid(serviceId, "spatial service id")}/coverages/${pathUuid(coverageId, "spatial service coverage id")}/withdraw`,
      {method: "POST"}
    ));
  }

  /** @returns {Promise<CoverageDerivative[]>} */
  async listCoverageDerivatives(projectId, serviceId, coverageId) {
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/spatial-services/${pathUuid(serviceId, "spatial service id")}/coverages/${pathUuid(coverageId, "spatial service coverage id")}/derivatives`
      ),
      parseCoverageDerivative,
      "coverage derivatives"
    );
  }

  /** @returns {Promise<CoverageProcessingPolicy>} */
  async getCoverageProcessingPolicy(projectId, serviceId) {
    return parseCoverageProcessingPolicy(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/spatial-services/${pathUuid(serviceId, "spatial service id")}/coverage-processing-policy`
    ));
  }

  async previewWcsSubset(projectId, serviceSlug, coverageName, subsets, {signal} = {}) {
    if (!Array.isArray(subsets) || subsets.length < 1 || subsets.length > 2
      || subsets.some(value => typeof value !== "string" || !value.length || value.length > 256)) {
      throw new TypeError("Provide one or two bounded WCS subset clauses");
    }
    if (typeof serviceSlug !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(serviceSlug)
      || typeof coverageName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(coverageName)) {
      throw new TypeError("Invalid WCS coverage target");
    }
    const query = new URLSearchParams(subsets.map(value => ["subset", value]));
    const record = object(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/services/${serviceSlug}/coverages/${encodeURIComponent(coverageName)}/subset-plan?${query}`,
      {signal}
    ), "WCS subset plan");
    const input = object(record.derivative_request, "WCS subset recipe");
    const width = integerBetween(input.width, 1, 8192, "WCS subset width");
    const height = integerBetween(input.height, 1, 8192, "WCS subset height");
    if (width * height > 16_777_216 || record.ordinary_reads_create_work !== false
      || input.resolution !== null || input.resampling !== "nearest"
      || !/^EPSG:[1-9][0-9]{2,7}$/.test(input.target_crs)) contract("Invalid WCS subset plan");
    return {
      coverageId: uuid(record.coverage_id, "WCS subset coverage id"),
      serviceId: uuid(record.service_id, "WCS subset service id"),
      datasetVersionId: uuid(record.dataset_version_id, "WCS subset dataset version id"),
      requestChecksumSha256: sha256(record.request_checksum_sha256, "WCS subset recipe checksum"),
      derivativeRequest: {subsetExtent: coverageDerivativeExtent(input.subset_extent, TypeError),
        targetCrs: input.target_crs, width, height,
        bandIndexes: coverageDerivativeBandIndexes(input.band_indexes, TypeError), resampling: "nearest"}
    };
  }

  /** @returns {Promise<CoverageDerivative>} */
  async createCoverageDerivative(projectId, serviceId, coverageId, request) {
    const record = object(request, "coverage derivative request");
    const subsetExtent = coverageDerivativeExtent(record.subsetExtent, TypeError);
    const targetCrs = boundedQuery(record.targetCrs, 100, "coverage derivative target CRS");
    if (!/^EPSG:[1-9][0-9]{2,7}$/.test(targetCrs)) {
      throw new TypeError("coverage derivative target CRS is invalid");
    }
    const hasResolution = record.resolution !== null && record.resolution !== undefined;
    const hasSize = record.width !== null && record.width !== undefined
      && record.height !== null && record.height !== undefined;
    if (hasResolution === hasSize) {
      throw new TypeError("coverage derivative requires size or resolution");
    }
    const width = hasSize
      ? integerBetween(record.width, 1, 8192, "coverage derivative width")
      : null;
    const height = hasSize
      ? integerBetween(record.height, 1, 8192, "coverage derivative height")
      : null;
    if (width !== null && height !== null && width * height > 16_777_216) {
      throw new TypeError("coverage derivative exceeds the pixel budget");
    }
    const resolution = hasResolution
      ? positivePair(record.resolution, "coverage derivative resolution", TypeError)
      : null;
    const bandIndexes = record.bandIndexes === null || record.bandIndexes === undefined
      ? null
      : coverageDerivativeBandIndexes(record.bandIndexes, TypeError);
    const resampling = oneOf(
      record.resampling ?? "nearest",
      ["nearest", "bilinear", "cubic"],
      "coverage derivative resampling"
    );
    return parseCoverageDerivative(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/spatial-services/${pathUuid(serviceId, "spatial service id")}/coverages/${pathUuid(coverageId, "spatial service coverage id")}/derivatives`,
      {
        method: "POST",
        body: {
          subset_extent: subsetExtent,
          target_crs: targetCrs,
          ...(width === null ? {resolution} : {width, height}),
          ...(bandIndexes === null ? {} : {band_indexes: bandIndexes}),
          resampling
        }
      }
    ));
  }

  /** @returns {Promise<CoverageDerivative>} */
  async getCoverageDerivative(projectId, serviceId, coverageId, jobId) {
    return parseCoverageDerivative(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/spatial-services/${pathUuid(serviceId, "spatial service id")}/coverages/${pathUuid(coverageId, "spatial service coverage id")}/derivatives/${pathUuid(jobId, "coverage derivative job id")}`
    ));
  }

  /** @returns {Promise<CoverageDerivative>} */
  async cancelCoverageDerivative(projectId, serviceId, coverageId, jobId) {
    return parseCoverageDerivative(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/spatial-services/${pathUuid(serviceId, "spatial service id")}/coverages/${pathUuid(coverageId, "spatial service coverage id")}/derivatives/${pathUuid(jobId, "coverage derivative job id")}/cancel`,
      {method: "POST"}
    ));
  }

  /** @returns {Promise<DownloadTicket>} */
  async downloadCoverageDerivative(projectId, serviceId, coverageId, jobId) {
    return parseDownloadTicket(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/spatial-services/${pathUuid(serviceId, "spatial service id")}/coverages/${pathUuid(coverageId, "spatial service coverage id")}/derivatives/${pathUuid(jobId, "coverage derivative job id")}/download`,
      {method: "POST"}
    ));
  }

  /** @returns {Promise<CoverageDerivativeReclamationPreview>} */
  async previewCoverageDerivativeReclamation(projectId, serviceId, coverageId, jobId) {
    return parseCoverageDerivativeReclamationPreview(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/spatial-services/${pathUuid(serviceId, "spatial service id")}/coverages/${pathUuid(coverageId, "spatial service coverage id")}/derivatives/${pathUuid(jobId, "coverage derivative job id")}/reclamation-preview`,
      {method: "POST"}
    ));
  }

  /** @returns {Promise<CoverageDerivativeReclamation>} */
  async reclaimCoverageDerivative(projectId, serviceId, coverageId, jobId, preview) {
    const record = object(preview, "coverage derivative reclamation preview");
    return parseCoverageDerivativeReclamation(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/spatial-services/${pathUuid(serviceId, "spatial service id")}/coverages/${pathUuid(coverageId, "spatial service coverage id")}/derivatives/${pathUuid(jobId, "coverage derivative job id")}/reclaim`,
      {
        method: "POST",
        body: {
          preview_checksum_sha256: sha256(
            record.previewChecksumSha256,
            "coverage derivative reclamation preview checksum"
          ),
          preview_expires_at: timestamp(
            record.expiresAt,
            "coverage derivative reclamation preview expiry"
          )
        }
      }
    ));
  }

  /** @returns {Promise<ProjectSite & {accessContainerId: string, resourceType: "publication"}>} */
  async getPublication(publicationId, {signal} = {}) {
    const record = object(await this.request(`/publications/${pathUuid(publicationId, "publication id")}`, {signal}), "publication");
    const site = parseProjectSite(record.site);
    const accessContainerId = uuid(record.access_container_id, "publication.access_container_id");
    if (record.resource_type !== "publication" || record.id !== publicationId
      || site.id !== publicationId || site.projectId !== accessContainerId) contract("Publication identity changed");
    return {...site, resourceType: "publication", accessContainerId};
  }

  /** @returns {Promise<ProjectSite[]>} */
  async listSites(projectId, {signal} = {}) {
    return parseArray(
      await this.request(`/projects/${pathUuid(projectId, "project id")}/sites`, {signal}),
      parseProjectSite,
      "project sites"
    );
  }

  /** @returns {Promise<SiteAssetCandidate[]>} */
  async listSiteAssetCandidates(projectId) {
    return parseArray(
      await this.request(`/projects/${pathUuid(projectId, "project id")}/site-assets`),
      parseSiteAssetCandidate,
      "site asset candidates"
    );
  }

  /** @returns {Promise<ProjectSite>} */
  async createSite(projectId, draft) {
    return parseProjectSite(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/sites`,
      {method: "POST", body: serializeSiteDraft(draft, {includeSlug: true})}
    ));
  }

  /** @returns {Promise<ObservableSourceProject[]>} */
  async listObservableSourceProjects(projectId, {signal} = {}) {
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/source-projects`, {signal}
      ),
      parseObservableSourceProject,
      "Observable source projects"
    );
  }

  async listPublicationWorkspaces(page = {}) {
    return parseArray(await this.request(`/publication-workspaces${pageQuery(page)}`),
      parsePublicationWorkspace, "publication workspaces");
  }

  async listObservableDataAttachments(projectId, sourceProjectId) {
    const expected = pathUuid(sourceProjectId, "source project id");
    const records = parseArray(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/source-projects/${expected}/data-attachments`
    ), parseObservableDataAttachment, "Observable data attachments");
    if (records.length > 128 || records.some(record => record.sourceProjectId !== expected)) {
      contract("Observable data attachment scope is inconsistent");
    }
    return records;
  }

  async registerObservableDataAttachment(projectId, sourceProjectId, selection) {
    const expected = pathUuid(sourceProjectId, "source project id");
    const body = {
      dataset_id: assertUuid(selection.datasetId, "dataset id"),
      dataset_version_id: assertUuid(selection.datasetVersionId, "dataset version id"),
      data_object_id: assertUuid(selection.dataObjectId, "data object id")
    };
    const record = parseObservableDataAttachment(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/source-projects/${expected}/data-attachments`,
      {method: "POST", body}
    ));
    if (record.sourceProjectId !== expected || record.datasetId !== body.dataset_id
      || record.datasetVersionId !== body.dataset_version_id || record.dataObjectId !== body.data_object_id) {
      contract("Observable data attachment identity is inconsistent");
    }
    return record;
  }

  async listObservablePublicFileReferences(projectId, sourceProjectId) {
    const expected = pathUuid(sourceProjectId, "source project id");
    const records = parseArray(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/source-projects/${expected}/public-file-references`
    ), parseObservablePublicFileReference, "Public file references");
    if (records.length > 128 || records.some(record => record.sourceProjectId !== expected)) {
      contract("Public file reference scope is inconsistent");
    }
    return records;
  }

  async registerObservablePublicFileReference(projectId, sourceProjectId, selection) {
    const expected = pathUuid(sourceProjectId, "source project id");
    exactKeys(object(selection, "public file selection"),
      ["datasetId", "sourceVersion", "resourceId", "resourceVersionId", "distributionId"],
      "public file selection");
    const body = {
      dataset_id: assertUuid(selection.datasetId, "dataset id"),
      source_version: integerBetween(selection.sourceVersion, 1, Number.MAX_SAFE_INTEGER, "source version"),
      resource_id: assertUuid(selection.resourceId, "resource id"),
      resource_version_id: assertUuid(selection.resourceVersionId, "resource version id"),
      distribution_id: boundedString(selection.distributionId, 1000, "distribution id")
    };
    const record = parseObservablePublicFileReference(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/source-projects/${expected}/public-file-references`,
      {method: "POST", body}
    ));
    if (record.sourceProjectId !== expected || record.datasetId !== body.dataset_id
      || record.sourceVersion !== body.source_version || record.resourceId !== body.resource_id
      || record.resourceVersionId !== body.resource_version_id || record.distributionId !== body.distribution_id) {
      contract("Public file reference identity is inconsistent");
    }
    return record;
  }

  /** @returns {Promise<ObservableSourceProject>} */
  async createObservableSourceProject(projectId, siteId, {title}) {
    return parseObservableSourceProject(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/sites/${pathUuid(siteId, "site id")}/source-project`,
      {method: "POST", body: {title: boundedQuery(title, 300, "Observable source title")}}
    ));
  }

  async requestObservableSourceFileUpload(projectId, sourceProjectId, file, requestOptions = {}) {
    const record = observableSourceFile(file);
    return parseObservableSourceFileUpload(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/source-projects/${pathUuid(sourceProjectId, "source project id")}/file-uploads`,
      {
        ...requestOptions,
        method: "POST",
        body: {
          relative_path: record.relativePath,
          content_type: record.contentType,
          size_bytes: record.blob.size,
          checksum_sha256: record.checksumSha256
        }
      }
    ));
  }

  /** @returns {Promise<ObservableSourceRevision>} */
  async createObservableSourceRevision(projectId, sourceProjectId, draft, requestOptions = {}) {
    const record = object(draft, "Observable source revision");
    const files = parseObservableRevisionUploads(record.files);
    const attachments = normalizeObservableRevisionAttachments(record.dataAttachments ?? [], files);
    const references = normalizeObservableRevisionReferencedFiles(record.referencedFiles ?? [], [...files, ...attachments]);
    const revision = parseObservableSourceRevision(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/source-projects/${pathUuid(sourceProjectId, "source project id")}/revisions`,
      {
        ...requestOptions,
        method: "POST",
        body: {
          expected_revision: nonNegativeInputInteger(
            record.expectedRevision,
            "Observable source expected revision"
          ),
          title: boundedQuery(record.title, 300, "Observable source revision title"),
          rights_status: inputOneOf(
            record.rightsStatus ?? "unreviewed",
            ["unreviewed", "approved", "rejected"],
            "Observable source rights status"
          ),
          entry_path: assertObservableSourcePath(record.entryPath, "Observable source entry path"),
          lockfile_path: record.lockfilePath === null || record.lockfilePath === undefined
            ? null
            : assertObservableSourcePath(record.lockfilePath, "Observable source lockfile path"),
          change_summary: boundedQuery(
            record.changeSummary,
            500,
            "Observable source change summary"
          ),
          files: files.map(({uploadId, sourceObjectId, relativePath}) => ({
            ...(sourceObjectId ? {source_object_id: sourceObjectId} : {upload_id: uploadId}),
            relative_path: relativePath
          })),
          ...(attachments.length ? {data_attachments: attachments.map(item => ({
            attachment_id: item.attachmentId, relative_path: item.relativePath
          }))} : {}),
          ...(references.length ? {referenced_files: references.map(item => ({
            reference_id: item.referenceId, relative_path: item.relativePath
          }))} : {})
        }
      }
    ));
    if (JSON.stringify(revision.referencedFiles ?? []) !== JSON.stringify(references)) {
      contract("Saved public file references differ from the submitted draft; reopen the saved version before continuing");
    }
    return revision;
  }

  /** Hash, upload, and atomically commit one exact sorted source tree. */
  async saveObservableSourceRevision(projectId, sourceProjectId, draft, {context: capturedContext = null, assertCurrent} = {}) {
    const context = capturedContext && Object.freeze({...capturedContext});
    const changed = () => { throw new ApiClientError("Your sign-in or selected account changed. Reopen the saved draft before continuing.", {
      status: 409, code: "observable_source_context_changed"
    }); };
    const guardNow = () => {
      assertCurrent?.();
      if (context && (this.tokenProvider !== context.tokenProvider || this.organizationProvider !== context.organizationProvider
        || this.baseUrl !== context.baseUrl || context.tokenProvider.call(this) !== context.token
        || String(context.organizationProvider.call(this)).toLowerCase() !== context.organization)) changed();
    };
    const guard = async () => {
      await assertCurrent?.();
      if (context) {
        const token = await context.tokenProvider.call(this);
        const organization = await context.organizationProvider.call(this);
        if (token !== context.token || String(organization).toLowerCase() !== context.organization) changed();
      }
      guardNow();
    };
    const requestOptions = {beforeDispatch: guard, beforeDispatchNow: guardNow,
      ...(context ? {token: context.token, organizationId: context.organization} : {})};
    await guard();
    const record = object(draft, "Observable source revision");
    const reuseContext = {sourceProjectId, expectedRevision: record.expectedRevision, reuseRevision: record.reuseRevision};
    const files = normalizeObservableSourceFiles(record.files, reuseContext);
    const publicationPrefix = String(record.entryPath).includes('/') ? record.entryPath.slice(0, record.entryPath.lastIndexOf('/') + 1) : '';
    const publicationConfig = files.find(file => file.relativePath === publicationPrefix + 'opengeo.publication.json');
    if (publicationConfig) {
      if (!publicationConfig.blob) throw new TypeError('Read the publication format record before saving');
      if (publicationConfig.blob.size > 4096) throw new TypeError('Publication format record exceeds 4 KiB');
      const format = JSON.parse(await publicationConfig.blob.text());
      if (format?.format === 'notebook' && !observableNotebookPublishingEnabled) {
        throw new TypeError('Observable Notebook saving requires the pending publishing-service update; nothing was uploaded');
      }
    }
    if (!jupyterPublishingEnabled && files.some(file => /\.ipynb$/i.test(file.relativePath))) {
      throw new TypeError("Notebook saving requires the pending publishing-service update; nothing was uploaded");
    }
    const attachments = normalizeObservableRevisionAttachments(record.dataAttachments ?? [], files);
    const references = normalizeObservableRevisionReferencedFiles(record.referencedFiles ?? [], [...files, ...attachments]);
    validateJupyterPublicationTree(record.entryPath, record.lockfilePath, files, [...attachments, ...references]);
    validateStaticPublicationTree(record.entryPath, record.lockfilePath, files, [...attachments, ...references]);
    if (/(^|\/)index\.html$/.test(record.entryPath) && !staticHtmlPublishingEnabled) {
      throw new TypeError("Standalone HTML publication requires the pending publishing-service update; nothing was uploaded");
    }
    if (!files.some(({relativePath}) => relativePath === record.entryPath && (/\.(md|ipynb)$/i.test(relativePath) || /(^|\/)index\.html$/.test(relativePath)))
      || (record.lockfilePath != null && (record.lockfilePath !== "package-lock.json"
        || !files.some(({relativePath}) => relativePath === record.lockfilePath)))) {
      throw new TypeError("Source entry and lockfile must exist in the selected tree");
    }
    const uploads = [];
    const baseline = record.reuseRevision;
    const reusable = baseline?.supportsFileReuse === true
      && baseline.sourceProjectId === sourceProjectId
      && baseline.revisionNumber === record.expectedRevision
      ? new Map(baseline.files.map(file => [file.relativePath, file])) : new Map();
    for (const file of files) {
      await guard();
      if (!file.blob) {
        uploads.push({sourceObjectId: file.sourceObjectId, relativePath: file.relativePath});
        continue;
      }
      const digest = await crypto.subtle.digest("SHA-256", await file.blob.arrayBuffer());
      await guard();
      const checksumSha256 = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const previous = reusable.get(file.relativePath);
      if (previous?.checksumSha256 === checksumSha256
        && previous.sizeBytes === file.blob.size && previous.contentType === file.contentType) {
        uploads.push({sourceObjectId: previous.sourceObjectId, relativePath: file.relativePath});
        continue;
      }
      const ticket = await this.requestObservableSourceFileUpload(
        projectId,
        sourceProjectId,
        {...file, checksumSha256}, requestOptions
      );
      await guard();
      if (Date.parse(ticket.expiresAt) <= Date.now()) {
        throw new ApiClientError("The Observable source upload expired", {
          code: "observable_source_upload_expired"
        });
      }
      guardNow();
      await this.uploadFile(ticket.upload, file.blob);
      await guard();
      uploads.push({uploadId: ticket.uploadId, relativePath: file.relativePath});
    }
    await guard();
    const revision = await this.createObservableSourceRevision(projectId, sourceProjectId, {
      ...record,
      files: uploads
    }, requestOptions);
    await guard();
    return revision;
  }

  /** @returns {Promise<ObservableSourceRevision[]>} */
  async listObservableSourceRevisions(projectId, sourceProjectId, {signal} = {}) {
    const response = await this.requestResponse(
      `/projects/${pathUuid(projectId, "project id")}/source-projects/${pathUuid(sourceProjectId, "source project id")}/revisions`,
      {signal}
    );
    const payload = await responsePayload(response);
    if (!response.ok) throw apiResponseError(response, payload);
    const supportsFileReuse = response.headers.get("X-OpenGeo-Source-File-Reuse") === "parent-revision-v1";
    return parseArray(
      payload,
      parseObservableSourceRevision,
      "Observable source revisions"
    ).map(revision => ({...revision, supportsFileReuse}));
  }

  /** Read a bounded metadata page. Unsupported APIs fail without an unbounded fallback. */
  async listObservableSourceRevisionsPage(projectId, sourceProjectId, {limit = 25, beforeRevision = null, signal} = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25
      || beforeRevision !== null && (!Number.isSafeInteger(beforeRevision) || beforeRevision < 1)) {
      throw new TypeError("Publication history selection is invalid");
    }
    const params = new URLSearchParams({limit: String(limit)});
    if (beforeRevision !== null) params.set("before_revision", String(beforeRevision));
    const response = await this.requestResponse(
      `/projects/${pathUuid(projectId, "project id")}/source-projects/${pathUuid(sourceProjectId, "source project id")}/revisions/page?${params}`,
      {signal}
    );
    const payload = await responsePayload(response);
    if (!response.ok) throw apiResponseError(response, payload);
    const records = parseArray(payload, parseObservableSourceRevision, "Publication revision page");
    if (records.length > limit || records.some((record, index) =>
      record.sourceProjectId.toLowerCase() !== sourceProjectId.toLowerCase()
      || beforeRevision !== null && record.revisionNumber >= beforeRevision
      || index > 0 && record.revisionNumber >= records[index - 1].revisionNumber)
      || new Set(records.map(record => record.id)).size !== records.length) {
      contract("Publication history page identity or order changed");
    }
    const supportsFileReuse = response.headers.get("X-OpenGeo-Source-File-Reuse") === "parent-revision-v1";
    return records.map(revision => ({...revision, supportsFileReuse}));
  }

  /** Explicitly download a saved source file from S3, without an API byte proxy. */
  async readObservableSourceRevisionFileDirect(
    projectId, sourceProjectId, sourceRevisionId, expectedFile, {signal} = {}
  ) {
    const parentSignal = signal, transfer = new AbortController();
    const cancel = () => transfer.abort(parentSignal.reason);
    if (parentSignal?.aborted) cancel();
    else parentSignal?.addEventListener("abort", cancel, {once: true});
    const timer = setTimeout(() => transfer.abort(
      new DOMException("The source download exceeded 20 seconds", "TimeoutError")
    ), 20_000);
    signal = transfer.signal;
    try {
      const file = object(expectedFile, "expected source file");
      const relativePath = assertObservableSourcePath(file.relativePath, "expected source path");
      const bucket = boundedString(file.bucket, 63, "expected source bucket");
      const key = boundedString(file.objectKey, 1024, "expected source key");
      const version = boundedString(file.s3VersionId, 1024, "expected source version");
      const contentType = observableSourceContentType(file.contentType, "expected source type");
      const size = integerBetween(file.sizeBytes, 1, 4_194_304, "expected source size");
      const checksum = sha256Checksum(file.checksumSha256, "expected source checksum");
      const token = await this.tokenProvider(), account = await this.organizationProvider();
      const checkCurrent = async () => {
        signal?.throwIfAborted();
        if (await this.tokenProvider() !== token || await this.organizationProvider() !== account) {
          contract("The source download session changed");
        }
      };
      await checkCurrent();
      const record = object(await this.request(
        `/projects/${pathUuid(projectId, "project id")}/source-projects/${pathUuid(sourceProjectId, "source project id")}/revisions/${pathUuid(sourceRevisionId, "source revision id")}/file-download`,
        {method: "POST", body: {relative_path: relativePath}, signal}
      ), "source file download");
      await checkCurrent();
      const ticket = parseDownloadTicket(record), target = new URL(ticket.url);
      let targetPath;
      try { targetPath = decodeURIComponent(target.pathname); }
      catch (cause) { contract("Source download path is invalid", cause); }
      if (record.relative_path !== relativePath || record.bucket !== bucket
        || record.object_key !== key || record.s3_version_id !== version
        || record.content_type !== contentType || record.size_bytes !== size
        || record.checksum_sha256 !== checksum || targetPath !== `/${bucket}/${key}`
        || target.searchParams.get("versionId") !== version
        || Date.parse(ticket.expiresAt) <= Date.now()) {
        contract("Source download does not match the saved revision file");
      }
      let response;
      try {
        response = await this.fetchImplementation(ticket.url, {
          method: "GET", credentials: "omit", redirect: "error",
          referrerPolicy: "no-referrer", cache: "no-store", signal
        });
      } catch (cause) {
        signal?.throwIfAborted();
        throw new ApiClientError("The source download could not be reached", {
          code: "source_download_unavailable", cause
        });
      }
      const reader = response.body?.getReader();
      const chunks = [];
      let total = 0;
      try {
        await checkCurrent();
        const declared = response.headers.get("content-length");
        if (!response.ok || !reader
          || response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== contentType
          || response.headers.get("x-amz-version-id") !== version
          || (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== size))) {
          contract("Source download response identity changed");
        }
        while (true) {
          const {done, value} = await reader.read();
          await checkCurrent();
          if (done) break;
          total += value.byteLength;
          if (total > size) contract("Source download exceeds the saved file size");
          chunks.push(value);
        }
      } finally {
        await reader?.cancel().catch(() => {});
        reader?.releaseLock();
      }
      if (total !== size) contract("Source download size changed");
      const blob = new Blob(chunks, {type: contentType});
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))]
        .map(byte => byte.toString(16).padStart(2, "0")).join("");
      await checkCurrent();
      if (digest !== checksum) contract("Source download checksum mismatch");
      // Ephemeral signed credentials must not enter an exported source archive.
      return {relativePath, contentType, checksumSha256: checksum, blob};
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", cancel);
    }
  }

  /** Read one exact file from an authorized immutable source revision. */
  async readObservableSourceRevisionFile(
    projectId,
    sourceProjectId,
    sourceRevisionId,
    relativePath,
    {signal} = {}
  ) {
    signal?.throwIfAborted();
    const encodedPath = assertObservableSourcePath(
      relativePath,
      "Observable source revision file path"
    ).split("/").map(encodeURIComponent).join("/");
    const response = await this.requestResponse(
      `/projects/${pathUuid(projectId, "project id")}/source-projects/${pathUuid(sourceProjectId, "source project id")}/revisions/${pathUuid(sourceRevisionId, "source revision id")}/files/${encodedPath}`,
      {accept: "application/octet-stream", signal}
    );
    if (!response.ok) {
      throw apiResponseError(response, await responsePayload(response));
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    const checksumSha256 = response.headers.get("X-OpenGeo-Source-Sha256");
    const declaredSize = response.headers.get("content-length");
    if (!contentType || !OBSERVABLE_SOURCE_MEDIA.some(([, media]) => media.includes(contentType))) {
      throw new ApiContractError("The source file content type is unsupported", {
        status: response.status,
        requestId: response.headers.get("X-Request-ID")
      });
    }
    const blob = await response.blob();
    signal?.throwIfAborted();
    if (blob.size < 1 || blob.size > 4_194_304
      || (declaredSize !== null && Number(declaredSize) !== blob.size)) {
      throw new ApiContractError("The source file size is invalid", {
        status: response.status,
        requestId: response.headers.get("X-Request-ID")
      });
    }
    const expectedChecksum = sha256Checksum(
      checksumSha256,
      "Observable source response checksum"
    );
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    const actualChecksum = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (actualChecksum !== expectedChecksum) {
      throw new ApiContractError("The source file checksum did not match", {
        status: response.status,
        requestId: response.headers.get("X-Request-ID")
      });
    }
    signal?.throwIfAborted();
    return {relativePath, contentType, checksumSha256: expectedChecksum, blob};
  }

  async getObservableWorkflow(projectId) {
    const id = pathUuid(projectId, "project id");
    const value = await this.request(`/projects/${id}/framework-workflow`);
    if (value === null || typeof value !== "object" || Array.isArray(value) || value.project_id !== id || value.configuration_only !== true ||
        value.public_promotion_available !== false ||
        [value.source_storage_configured, value.build_dispatch_configured, value.private_preview_configured].some(item => typeof item !== "boolean")) {
      contract("Invalid Observable workflow configuration");
    }
    return {projectId: id, sourceStorageConfigured: value.source_storage_configured,
      buildDispatchConfigured: value.build_dispatch_configured, privatePreviewConfigured: value.private_preview_configured,
      publicPromotionAvailable: false, configurationOnly: true};
  }

  async getObservableGitHubStatus(projectId, sourceProjectId) {
    const source = pathUuid(sourceProjectId, "source project id");
    return parseObservableGitHubStatus(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/source-projects/${source}/github`
    ), source);
  }

  async syncObservableGitHubRevision(projectId, sourceProjectId, revisionId) {
    const source = pathUuid(sourceProjectId, "source project id");
    return parseObservableGitHubStatus(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/source-projects/${source}/revisions/${pathUuid(revisionId, "revision id")}/github-sync`,
      {method: "POST"}
    ), source);
  }

  async getFrameworkPublications(projectId, sourceProjectId) {
    const source = pathUuid(sourceProjectId, "source project id");
    return parseFrameworkPublications(await this.request(`/projects/${pathUuid(projectId, "project id")}/source-projects/${source}/publications`), source);
  }

  async reviewFrameworkPublication(projectId, sourceProjectId, {reviewId, buildJobId, mountId, resultChecksumSha256, distributionApprovalId = null}) {
    const source = pathUuid(sourceProjectId, "source project id");
    if (!/^[a-f0-9]{64}$/.test(resultChecksumSha256 ?? "")) contract("Invalid build checksum");
    return parseFrameworkPublications(await this.request(`/projects/${pathUuid(projectId, "project id")}/source-projects/${source}/publications/reviews`, {
      method: "POST", body: {review_id: pathUuid(reviewId, "review id"), build_job_id: pathUuid(buildJobId, "build id"),
        mount_id: pathUuid(mountId, "mount id"), result_checksum_sha256: resultChecksumSha256,
        ...(distributionApprovalId === null ? {} : {distribution_approval_id: pathUuid(distributionApprovalId, "input distribution approval id")})}
    }), source);
  }

  async reserveFrameworkPublicationDestination(projectId, sourceProjectId, {reservationId, originId, slug}) {
    const source = pathUuid(sourceProjectId, "source project id");
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug ?? "")) throw new TypeError("Use a lowercase address name with letters, numbers and hyphens");
    return parseFrameworkPublications(await this.request(`/projects/${pathUuid(projectId, "project id")}/source-projects/${source}/publications/destinations`, {
      method: "POST", body: {reservation_id: pathUuid(reservationId, "reservation id"), origin_id: pathUuid(originId, "origin id"),
        slug, acknowledgment: "reserve-address-without-publishing"}
    }), source);
  }

  async approveFrameworkPublication(projectId, sourceProjectId, reviewId) {
    const source = pathUuid(sourceProjectId, "source project id");
    return parseFrameworkPublications(await this.request(`/projects/${pathUuid(projectId, "project id")}/source-projects/${source}/publications/reviews/${pathUuid(reviewId, "review id")}/approve`, {
      method: "POST", body: {acknowledgment: "publish-exact-previewed-output"}
    }), source);
  }

  async listObservableGitHubDispatches(projectId, sourceProjectId, {limit = 25, offset = 0} = {}) {
    const source = pathUuid(sourceProjectId, "source project id");
    inputIntegerBetween(limit, 1, 100, "GitHub history limit");
    inputIntegerBetween(offset, 0, 100000, "GitHub history offset");
    const values = await this.request(`/projects/${pathUuid(projectId, "project id")}/source-projects/${source}/github-builds?limit=${limit}&offset=${offset}`);
    if (!Array.isArray(values) || values.length > limit) contract("Invalid GitHub build history");
    const records = values.map(value => {
      if (!value || value.source_project_id !== source || !["syncing", "ready", "dispatching", "dispatched", "completed", "failed"].includes(value.stage) ||
          !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository ?? "") ||
          !/^[0-9a-f]{40}$/.test(value.workflow_sha ?? "") ||
          (value.source_commit !== null && !/^[0-9a-f]{40}$/.test(value.source_commit ?? "")) ||
          (value.run_id !== null && (!Number.isSafeInteger(value.run_id) || value.run_id < 1)) ||
          (["dispatched", "completed"].includes(value.stage) && value.run_id === null) ||
          (value.run_attempt !== null && (!Number.isSafeInteger(value.run_attempt) || value.run_attempt < 1)) ||
          ![null, "queued", "in_progress", "completed", "waiting", "requested", "pending"].includes(value.run_status) ||
          ![null, "success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale", "startup_failure"].includes(value.run_conclusion) ||
          (value.error_code !== null && !/^[a-z0-9_]{1,100}$/.test(value.error_code ?? "")) ||
          !Number.isFinite(Date.parse(value.updated_at))) contract("Invalid GitHub dispatch identity");
      const logs = value.retained_logs;
      if (logs != null && (!["retained", "unavailable"].includes(logs.state) ||
          typeof logs.text !== "string" || new TextEncoder().encode(logs.text).length > 24000 ||
          typeof logs.truncated !== "boolean" || !Number.isFinite(Date.parse(logs.captured_at)) ||
          (logs.state === "retained" && !/^[0-9a-f]{64}$/.test(logs.checksum_sha256 ?? "")))) contract("Invalid retained GitHub logs");
      return {buildJobId: pathUuid(value.build_job_id, "GitHub build id"), sourceProjectId: source,
        stage: value.stage, sourceCommit: value.source_commit, updatedAt: value.updated_at,
        runStatus: value.run_status, runConclusion: value.run_conclusion,
        runUrl: value.run_id === null ? null : `https://github.com/${value.repository}/actions/runs/${value.run_id}`,
        errorCode: value.error_code, retainedLogs: logs == null ? null : {
          state: logs.state, text: logs.text, truncated: logs.truncated,
          capturedAt: logs.captured_at, checksumSha256: logs.checksum_sha256
        }};
    });
    if (new Set(records.map(record => record.buildJobId)).size !== records.length) contract("Duplicate GitHub dispatch");
    return records;
  }

  async connectObservableGitHub(projectId, sourceProjectId, connectionId) {
    const source = pathUuid(sourceProjectId, "source project id");
    const connection = pathUuid(connectionId, "GitHub connection id");
    const status = parseObservableGitHubStatus(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/source-projects/${source}/github`,
      {method: "PUT", body: {connection_id: connection}}
    ), source);
    if (status.connection?.id !== connection) contract("GitHub connection response mismatch");
    return status;
  }

  async readPublicationArtifactReferences(projectId, sourceProjectId) {
    return parsePublicationArtifactReferences(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/source-projects/${pathUuid(sourceProjectId, "source project id")}/artifact-references`));
  }

  async readPublicationArtifactBackupInputs(projectId, sourceProjectId, {expectedReferenceRevision, signal} = {}) {
    const project = pathUuid(projectId, "project id");
    const source = pathUuid(sourceProjectId, "source project id");
    const query = expectedReferenceRevision === undefined ? ""
      : `?expected_reference_revision=${integerBetween(expectedReferenceRevision, 0, 2147483647, "Artifact reference revision")}`;
    return parsePublicationArtifactBackupInputs(await this.request(
      `/projects/${project}/source-projects/${source}/artifact-backup-inputs${query}`, {signal}
    ), project, source, expectedReferenceRevision);
  }

  async savePublicationArtifactReferences(projectId, sourceProjectId, revision, references) {
    const selection = parsePublicationArtifactReferences({revision, references});
    return parsePublicationArtifactReferences(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/source-projects/${pathUuid(sourceProjectId, "source project id")}/artifact-references`,
      {method: "PUT", body: {expected_revision: selection.revision, references: selection.references}}));
  }

  async preparePublicationArtifactInputs(projectId, sourceProjectId, revisionId, referenceRevision) {
    positiveInputInteger(referenceRevision, "Artifact reference revision");
    const result = object(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/source-projects/${pathUuid(sourceProjectId, "source project id")}/revisions/${pathUuid(revisionId, "revision id")}/artifact-inputs`,
      {method: "POST", body: {expected_reference_revision: referenceRevision}}), "Artifact inputs");
    exactKeys(result, ["id", "manifest", "manifest_checksum_sha256", "reused"], "Artifact inputs");
    const manifest = object(result.manifest, "Artifact input manifest");
    if (manifest.schemaVersion !== "opengeo.publication-artifact-inputs.1.0.0" || manifest.sourceProjectId !== sourceProjectId || manifest.sourceRevisionId !== revisionId || manifest.referenceRevision !== referenceRevision || !Array.isArray(manifest.artifacts) || !manifest.artifacts.length || manifest.artifacts.length > 32) contract("Artifact input identity mismatch");
    return {id: uuid(result.id, "Artifact input identity"), manifest,
      checksum: sha256(result.manifest_checksum_sha256, "Artifact inputs checksum"), reused: boolean(result.reused, "Artifact input reuse")};
  }

  async getPublicationInputDistributions(projectId, sourceProjectId, revisionId, {artifactInputId = null, buildJobId = null, signal} = {}) {
    if (artifactInputId !== null && buildJobId !== null) throw new TypeError("Choose exact Artifact inputs or a saved build");
    const suffix = buildJobId !== null ? `?build_job_id=${pathUuid(buildJobId, "saved build id")}`
      : artifactInputId !== null ? `?artifact_input_id=${pathUuid(artifactInputId, "Artifact input id")}` : "";
    return parsePublicationInputDistributions(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/source-projects/${pathUuid(sourceProjectId, "source project id")}/revisions/${pathUuid(revisionId, "source revision id")}/distribution-approvals${suffix}`,
      {signal}), projectId, sourceProjectId, revisionId);
  }

  async createPublicationInputDistribution(projectId, sourceProjectId, revisionId, options = {}) {
    const {approvalId = globalThis.crypto.randomUUID(), artifactInputId = null, outputProfile = "default-32m",
      archiveRights = [], artifactReleases = [], referencedRights} = options;
    const withReferences = Object.hasOwn(options, "referencedRights");
    if (!Array.isArray(archiveRights) || archiveRights.length > 128 || !Array.isArray(artifactReleases) || artifactReleases.length > 32) {
      throw new TypeError("Invalid publication input selections");
    }
    if (withReferences && (!Array.isArray(referencedRights)
      || archiveRights.length + referencedRights.length + artifactReleases.length > 128)) {
      throw new TypeError("Invalid referenced file sharing selections");
    }
    const body = {
      approval_id: pathUuid(approvalId, "input distribution approval id"),
      artifact_input_id: artifactInputId === null ? null : pathUuid(artifactInputId, "Artifact input id"),
      output_profile: inputOneOf(outputProfile, ["default-32m", "archive-96m"], "saved output size profile"),
      archive_rights: archiveRights.map(item => ({
        attachment_id: pathUuid(item.attachmentId, "archive attachment id"),
        relative_path: assertObservableSourcePath(item.relativePath, "archive path"),
        license: inputOneOf(item.license, ["CC0-1.0", "CC-BY-4.0", "PDDL-1.0"], "archive license"),
        attribution: boundedString(item.attribution, 4000, "archive attribution"),
        acknowledgment: inputOneOf(item.acknowledgment, ["publish-exact-archive-file"], "archive sharing acknowledgment")
      })),
      artifact_releases: artifactReleases.map(item => ({
        artifact_id: pathUuid(item.artifactId, "Artifact id"),
        version: inputIntegerBetween(item.version, 1, 2147483647, "Artifact edition"),
        release_id: pathUuid(item.releaseId, "Artifact release id"),
        acknowledgment: inputOneOf(item.acknowledgment, ["publish-exact-map-artifact"], "Artifact sharing acknowledgment")
      }))
    };
    if (withReferences) {
      body.referenced_rights = referencedRights.map(item => {
        exactKeys(object(item, "Referenced file sharing selection"),
          ["referenceId", "relativePath", "license", "attribution", "acknowledgment"], "Referenced file sharing selection");
        const relativePath = assertObservableSourcePath(item.relativePath, "referenced file path");
        if (!/\.tiff?$/i.test(relativePath)) throw new TypeError("Referenced sharing requires a TIFF file");
        return {
          reference_id: pathUuid(item.referenceId, "public file reference id"), relative_path: relativePath,
          license: inputOneOf(item.license, ["CC0-1.0", "CC-BY-4.0", "PDDL-1.0"], "referenced file license"),
          attribution: boundedString(item.attribution, 2000, "referenced file attribution"),
          acknowledgment: inputOneOf(item.acknowledgment, ["publish-exact-referenced-file"], "referenced file sharing acknowledgment")
        };
      });
      const paths = [...body.archive_rights, ...body.referenced_rights].map(item => item.relative_path.toLowerCase());
      if (paths.some((path, index) => paths.slice(index + 1).some(other =>
        path === other || path.startsWith(other + "/") || other.startsWith(path + "/")))) {
        throw new TypeError("Archive and referenced sharing paths must not collide");
      }
    }
    if (body.archive_rights.some(item => !item.attribution.trim())) throw new TypeError("Archive attribution is required");
    const value = parsePublicationInputApproval(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/source-projects/${pathUuid(sourceProjectId, "source project id")}/revisions/${pathUuid(revisionId, "source revision id")}/distribution-approvals`,
      {method: "POST", body}), projectId, sourceProjectId, revisionId);
    if (value.id !== approvalId || value.revoked || value.manifest.outputProfile !== outputProfile
      || value.manifest.archiveRights.length !== body.archive_rights.length || value.manifest.artifacts.length !== body.artifact_releases.length
      || body.archive_rights.some(right => !value.manifest.archiveRights.some(pin => pin.attachmentId === right.attachment_id
        && pin.path === right.relative_path && pin.license === right.license && pin.attribution === right.attribution))
      || body.artifact_releases.some(release => !value.manifest.artifacts.some(pin => pin.artifactId === release.artifact_id
        && pin.version === release.version && pin.releaseId === release.release_id))
      || (value.manifest.referenceRights?.length ?? 0) !== (body.referenced_rights?.length ?? 0)
      || (body.referenced_rights ?? []).some(right => !value.manifest.referenceRights?.some(pin =>
        pin.referenceId === right.reference_id && pin.path === right.relative_path && pin.license === right.license
        && pin.attribution === right.attribution && pin.acknowledgment === right.acknowledgment))) {
      contract("Input distribution approval identity mismatch");
    }
    return value;
  }

  async revokePublicationInputDistribution(projectId, sourceProjectId, revisionId, approvalId) {
    const record = object(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/source-projects/${pathUuid(sourceProjectId, "source project id")}/revisions/${pathUuid(revisionId, "source revision id")}/distribution-approvals/${pathUuid(approvalId, "input distribution approval id")}/revoke`,
      {method: "POST", body: {acknowledgment: "revoke-input-distribution-approval"}}), "Revoked input distribution approval");
    exactKeys(record, ["id", "revoked"], "Revoked input distribution approval");
    if (uuid(record.id, "revoked input distribution approval id") !== approvalId || record.revoked !== true) contract("Input distribution revocation identity mismatch");
    return {id: approvalId, revoked: true};
  }

  /** @returns {Promise<ObservableBuildJob>} */
  async createObservableBuildJob(
    projectId,
    sourceProjectId,
    sourceRevisionId,
    {purpose = "preview", idempotencyKey = globalThis.crypto.randomUUID(), artifactInputId = null,
      outputProfile = "default-32m", sizeAcknowledgment = null, distributionApprovalId = null,
      outputRepresentation = null} = {}
  ) {
    if (outputRepresentation !== null) {
      inputOneOf(outputRepresentation, ["single-html"], "saved output representation");
      if (artifactInputId !== null) throw new TypeError("Single HTML does not support Artifact inputs");
    }
    inputOneOf(outputProfile, ["default-32m", "archive-96m"], "saved output size profile");
    if (outputProfile === "archive-96m" ? sizeAcknowledgment !== "allow-up-to-96-mib-output" : sizeAcknowledgment !== null) {
      throw new TypeError("Confirm the selected saved output size limit");
    }
    const job = parseObservableBuildJob(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/source-projects/${pathUuid(sourceProjectId, "source project id")}/revisions/${pathUuid(sourceRevisionId, "source revision id")}/build-jobs`,
      {
        method: "POST",
        body: {
          idempotency_key: pathUuid(idempotencyKey, "build idempotency key"),
          ...(artifactInputId === null ? {} : {artifact_input_id: pathUuid(artifactInputId, "Artifact input id")}),
          ...(outputProfile === "default-32m" ? {} : {output_profile: outputProfile, size_acknowledgment: sizeAcknowledgment}),
          ...(distributionApprovalId === null ? {} : {distribution_approval_id: pathUuid(distributionApprovalId, "input distribution approval id")}),
          ...(outputRepresentation === null ? {} : {output_representation: outputRepresentation}),
          purpose: inputOneOf(
            purpose,
            ["preview", "release_candidate"],
            "Observable build purpose"
          )
        }
      }
    ));
    // The server may reuse an authorized equivalent build with its original ID.
    // The caller's idempotency key is not necessarily that retained job's ID.
    if (job.sourceProjectId !== sourceProjectId || job.sourceRevisionId !== sourceRevisionId || job.purpose !== purpose
      || (job.request.outputProfile ?? "default-32m") !== outputProfile
      || (job.request.distributionApprovalId ?? null) !== distributionApprovalId
      || (job.request.outputRepresentation ?? null) !== outputRepresentation) contract("Observable build source identity mismatch");
    return job;
  }

  /** @returns {Promise<ObservableBuildJob>} */
  async getObservableBuildJob(projectId, buildJobId) {
    const job = parseObservableBuildJob(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/observable-build-jobs/${pathUuid(buildJobId, "Observable build job id")}`
    ));
    if (job.id !== buildJobId) contract("Observable build identity mismatch");
    return job;
  }

  async listObservableBuildJobs(projectId, sourceProjectId, {limit = 25, offset = 0} = {}) {
    inputIntegerBetween(limit, 1, 100, "Observable history limit");
    inputIntegerBetween(offset, 0, 100000, "Observable history offset");
    const sourceId = pathUuid(sourceProjectId, "source project id");
    const response = await this.request(`/projects/${pathUuid(projectId, "project id")}/source-projects/${sourceId}/build-jobs?limit=${limit}&offset=${offset}`);
    if (!Array.isArray(response) || response.length > limit) contract("Invalid Observable build history");
    const jobs = response.map(parseObservableBuildJob);
    if (jobs.some(job => job.sourceProjectId !== sourceId) || new Set(jobs.map(job => job.id)).size !== jobs.length) contract("Observable build history scope mismatch");
    return jobs;
  }

  async dispatchObservableBuildJob(projectId, buildJobId) {
    const id = pathUuid(buildJobId, "Observable build job id");
    const job = parseObservableBuildJob(await this.request(`/projects/${pathUuid(projectId, "project id")}/observable-build-jobs/${id}/dispatch`, {method: "POST"}));
    if (job.id !== id) contract("Observable dispatch identity mismatch");
    return job;
  }

  /** @returns {Promise<ObservablePreviewCapability>} */
  async createObservablePreviewCapability(projectId, buildJobId, {runtimeProfile = "local_only"} = {}) {
    if (!["local_only", "public_maps_v1"].includes(runtimeProfile)) {
      contract("Observable preview runtime profile is invalid");
    }
    return parseObservablePreviewCapability(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/observable-build-jobs/${pathUuid(buildJobId, "Observable build job id")}/preview-capabilities`,
      {method: "POST", ...(runtimeProfile === "public_maps_v1" ? {body: {runtime_profile: runtimeProfile}} : {})}
    ));
  }

  /** @returns {Promise<ProjectSite>} */
  async updateSite(projectId, siteId, update) {
    const record = object(update, "site update");
    return parseProjectSite(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/sites/${pathUuid(siteId, "site id")}`,
      {
        method: "PUT",
        body: {
          ...serializeSiteDraft(record),
          expected_version: positiveInteger(record.expectedVersion, "site expected version"),
          change_message: boundedQuery(record.changeMessage, 500, "site change message")
        }
      }
    ));
  }

  /** @returns {Promise<ProjectSite>} */
  async configureSitePublicationDestination(
    projectId,
    siteId,
    {expectedRevision, reach, listedSlug = null, isPrimary = false}
  ) {
    const publicationReach = inputOneOf(
      reach,
      ["unpublished", "unlisted", "listed"],
      "site publication reach"
    );
    const path = listedSlug === null
      ? null
      : siteSlugPath(listedSlug);
    if (publicationReach === "listed" && path === null) {
      throw new TypeError("listed publication requires a human-readable path");
    }
    if (isPrimary && publicationReach !== "listed") {
      throw new TypeError("only a listed publication can be the primary site");
    }
    return parseProjectSite(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/sites/${pathUuid(siteId, "site id")}/publication-destination`,
      {
        method: "PUT",
        body: {
          expected_revision: positiveInteger(
            expectedRevision,
            "site publication destination expected revision"
          ),
          reach: publicationReach,
          listed_slug: path,
          is_primary: Boolean(isPrimary)
        }
      }
    ));
  }

  /** @returns {Promise<ProjectSite>} */
  async submitSiteForReview(projectId, siteId, {expectedVersion, reason = null}) {
    return parseProjectSite(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/sites/${pathUuid(siteId, "site id")}/review`,
      {
        method: "POST",
        body: {
          expected_version: positiveInteger(expectedVersion, "site expected version"),
          reason: reason === null ? null : boundedQuery(reason, 1000, "site review reason")
        }
      }
    ));
  }

  /** @returns {Promise<ProjectSite>} */
  async publishSite(
    projectId,
    siteId,
    {expectedVersion, reason = null, mapSnapshots = []}
  ) {
    if (!Array.isArray(mapSnapshots) || mapSnapshots.length > 16) {
      throw new TypeError("site map snapshots must contain at most 16 entries");
    }
    const snapshotResources = new Set();
    const snapshotJobs = new Set();
    const serializedSnapshots = mapSnapshots.map((value) => {
      const snapshot = object(value, "site map snapshot");
      const resourceId = assertUuid(snapshot.resourceId, "site snapshot resource id");
      const renderJobId = assertUuid(snapshot.renderJobId, "site snapshot render job id");
      if (snapshotResources.has(resourceId) || snapshotJobs.has(renderJobId)) {
        throw new TypeError("site map snapshots must use unique resources and render jobs");
      }
      snapshotResources.add(resourceId);
      snapshotJobs.add(renderJobId);
      return {resource_id: resourceId, render_job_id: renderJobId};
    });
    return parseProjectSite(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/sites/${pathUuid(siteId, "site id")}/publish`,
      {
        method: "POST",
        body: {
          expected_version: positiveInteger(expectedVersion, "site expected version"),
          reason: reason === null ? null : boundedQuery(reason, 1000, "site publish reason"),
          map_snapshots: serializedSnapshots
        }
      }
    ));
  }

  /** @returns {Promise<SiteEdition[]>} */
  async listSiteEditions(projectId, siteId) {
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/sites/${pathUuid(siteId, "site id")}/editions`
      ),
      parseSiteEdition,
      "site editions"
    );
  }

  /** @returns {Promise<SiteEdition>} */
  async revokeSiteEdition(projectId, siteId, editionId) {
    return parseSiteEdition(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/sites/${pathUuid(siteId, "site id")}/editions/${pathUuid(editionId, "site edition id")}/revoke`,
      {method: "POST"}
    ));
  }

  publicSiteUrl(organizationId, projectId, siteSlug) {
    return `${this.baseUrl}/public/organizations/${pathUuid(organizationId, "organization id")}/projects/${pathUuid(projectId, "project id")}/sites/${siteSlugPath(siteSlug)}`;
  }

  publicListedSiteUrl(organizationId, siteSlug) {
    return `${this.baseUrl}/public/organizations/${pathUuid(organizationId, "organization id")}/publications/${siteSlugPath(siteSlug)}`;
  }

  publicPrimarySiteUrl(organizationId) {
    return `${this.baseUrl}/public/organizations/${pathUuid(organizationId, "organization id")}/publication`;
  }

  publicUnlistedSiteUrl(organizationId, projectId, unlistedToken) {
    const token = boundedQuery(unlistedToken, 32, "unlisted publication token");
    if (!/^[0-9a-f]{32}$/.test(token)) {
      throw new TypeError("unlisted publication token is invalid");
    }
    return `${this.baseUrl}/public/organizations/${pathUuid(organizationId, "organization id")}/projects/${pathUuid(projectId, "project id")}/unlisted/${token}`;
  }

  publicSiteExportUrl(organizationId, projectId, siteSlug) {
    return `${this.publicSiteUrl(organizationId, projectId, siteSlug)}/export.zip`;
  }

  publicSitePrintUrl(organizationId, projectId, siteSlug) {
    return `${this.publicSiteUrl(organizationId, projectId, siteSlug)}/print.pdf`;
  }

  publicSiteEditionExportUrl(organizationId, projectId, editionId) {
    return `${this.baseUrl}/public/organizations/${pathUuid(organizationId, "organization id")}/projects/${pathUuid(projectId, "project id")}/site-editions/${pathUuid(editionId, "site edition id")}/export.zip`;
  }

  publicSiteEditionPrintUrl(organizationId, projectId, editionId) {
    return `${this.baseUrl}/public/organizations/${pathUuid(organizationId, "organization id")}/projects/${pathUuid(projectId, "project id")}/site-editions/${pathUuid(editionId, "site edition id")}/print.pdf`;
  }

  publicSiteEditionPagePngUrl(organizationId, projectId, editionId, pageSlug) {
    return `${this.baseUrl}/public/organizations/${pathUuid(organizationId, "organization id")}/projects/${pathUuid(projectId, "project id")}/site-editions/${pathUuid(editionId, "site edition id")}/print/pages/${siteSlugPath(pageSlug)}.png`;
  }

  publicSiteEditionMapSheetUrl(organizationId, projectId, editionId, resourceId) {
    return `${this.baseUrl}/public/organizations/${pathUuid(organizationId, "organization id")}/projects/${pathUuid(projectId, "project id")}/site-editions/${pathUuid(editionId, "site edition id")}/print/${pathUuid(resourceId, "resource id")}.svg`;
  }

  publicSitePagePngUrl(organizationId, projectId, siteSlug, pageSlug) {
    return `${this.publicSiteUrl(organizationId, projectId, siteSlug)}/print/pages/${siteSlugPath(
      pageSlug
    )}.png`;
  }

  publicSiteMapSheetUrl(organizationId, projectId, siteSlug, resourceId) {
    return `${this.publicSiteUrl(organizationId, projectId, siteSlug)}/print/${pathUuid(
      resourceId,
      "map resource id"
    )}.svg`;
  }

  /** @returns {Promise<RenderProfile[]>} */
  async listRenderProfiles(projectId, resourceId) {
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/render-profiles`
      ),
      parseRenderProfile,
      "render profiles"
    );
  }

  /** @returns {Promise<RenderProfile>} */
  async createRenderProfile(projectId, resourceId, profile) {
    const record = object(profile, "render profile");
    return parseRenderProfile(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/render-profiles`,
        {
          method: "POST",
          body: serializeRenderProfile(record, true)
        }
      )
    );
  }

  /** @returns {Promise<RenderProfile>} */
  async updateRenderProfile(projectId, resourceId, profileId, update) {
    const record = object(update, "render profile update");
    if (!Number.isSafeInteger(record.expectedVersion) || record.expectedVersion < 1) {
      throw new TypeError("render profile expectedVersion must be a positive integer");
    }
    return parseRenderProfile(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/render-profiles/${pathUuid(profileId, "render profile id")}`,
        {
          method: "PUT",
          body: {
            ...serializeRenderProfile(record, false),
            expected_version: record.expectedVersion
          }
        }
      )
    );
  }

  /** @returns {Promise<RenderJob>} */
  async requestResourceRender(projectId, resourceId, profileId, renderRequest) {
    const record = object(renderRequest, "render request");
    const crs = oneOf(record.crs ?? "CRS:84", ["CRS:84", "EPSG:3857"], "render request.crs");
    const bbox = renderRequestBbox(record.bbox, TypeError, crs);
    const width = integerBetween(record.width, 1, 2048, "render request.width");
    const height = integerBetween(record.height, 1, 2048, "render request.height");
    const format = oneOf(record.format ?? "svg", ["svg", "png"], "render request.format");
    const backgroundColor = record.backgroundColor ?? null;
    if (backgroundColor !== null && !/^#[0-9a-f]{6}$/.test(backgroundColor)) {
      throw new TypeError("render request.backgroundColor is invalid");
    }
    const transparent = record.transparent ?? false;
    if (typeof transparent !== "boolean") throw new TypeError("render request.transparent is invalid");
    if (width * height > 4_194_304) throw new TypeError("render request exceeds the pixel budget");
    return parseRenderJob(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/render-profiles/${pathUuid(profileId, "render profile id")}/renders`,
        {
          method: "POST",
          body: {
            idempotency_key: assertUuid(record.idempotencyKey, "render idempotency key"),
            bbox,
            crs,
            width,
            height,
            format,
            background_color: backgroundColor,
            transparent
          }
        }
      )
    );
  }

  /** @returns {Promise<RenderJob>} */
  async requestSavedMapRender(projectId, resourceId, renderRequest) {
    const record = object(renderRequest, "saved map render request");
    const allowed = new Set([
      "idempotencyKey", "expectedResourceVersion", "expectedMapVersion", "width", "height", "format"
    ]);
    if (Object.keys(record).some((key) => !allowed.has(key))) {
      throw new TypeError("saved map renders derive their presentation from the bound saved revision");
    }
    const width = integerBetween(record.width, 64, 2048, "saved map render.width");
    const height = integerBetween(record.height, 64, 2048, "saved map render.height");
    if (width * height > 4_194_304) throw new TypeError("saved map render exceeds the pixel budget");
    const response = await this.requestResponse(
      `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/saved-map-renders`,
      {method: "POST", body: {
        idempotency_key: assertUuid(record.idempotencyKey, "render idempotency key"),
        expected_resource_version: positiveInteger(record.expectedResourceVersion, "saved map render resource version"),
        expected_map_version: positiveInteger(record.expectedMapVersion, "saved map render map version"),
        width,
        height,
        format: oneOf(record.format ?? "png", ["png"], "saved map render.format")
      }}
    );
    const payload = await responsePayload(response);
    if (!response.ok) {
      const error = apiResponseError(response, payload);
      // This route explains unsupported saved presentation. Keep the actionable
      // text bounded; callers render it as text, never as server-supplied markup.
      if (typeof payload?.detail?.message === "string") {
        error.message = payload.detail.message.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 1_000)
          || error.message;
      }
      throw error;
    }
    const job = parseRenderJob(payload);
    if (job.projectId !== projectId || job.resourceId !== resourceId || job.format !== "png"
      || job.width !== width || job.height !== height
      || job.savedMapSnapshot?.resourceVersionNumber !== record.expectedResourceVersion
      || job.savedMapSnapshot?.mapVersion !== record.expectedMapVersion) {
      contract("saved map render response does not match the requested resource revision");
    }
    return job;
  }

  /** @returns {Promise<RenderJob>} */
  async getResourceRender(projectId, resourceId, renderJobId) {
    return parseRenderJob(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/renders/${pathUuid(renderJobId, "render job id")}`
      )
    );
  }

  async requestPortableArtifactUpload(projectId, resourceId, manifest, expectedRevision) {
    const result = object(await this.request(`/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/artifact/uploads`, {
      method: "POST", body: {manifest_json: JSON.stringify(manifest), expected_revision: integerBetween(expectedRevision, 0, 2147483646, "Artifact revision")}
    }), "Artifact upload");
    uuid(result.upload_id, "Artifact upload identity"); uuid(result.artifact_id, "Artifact identity");
    if (!Number.isFinite(Date.parse(result.expires_at))) contract("Artifact upload expiry is invalid");
    return {...result, ...parseUploadInstructions(result)};
  }

  async completePortableArtifactUpload(projectId, resourceId, uploadId) {
    const result = object(await this.request(`/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/artifact/uploads/${pathUuid(uploadId, "upload id")}/complete`, {method: "POST"}), "Artifact completion");
    if (result.upload_id !== uploadId) contract("Artifact upload identity changed");
    uuid(result.output_object_id, "Artifact output identity"); uuid(result.artifact_id, "Artifact identity");
    return result;
  }

  async registerPortableArtifactEdition(projectId, resourceId, outputObjectId, manifest, expectedRevision) {
    return parseArtifactEdition(await this.request(`/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/artifact/portable-editions`, {
      method: "POST", body: {output_object_id: pathUuid(outputObjectId, "Artifact output id"), manifest_json: JSON.stringify(manifest),
        expected_revision: integerBetween(expectedRevision, 0, 2147483646, "Artifact revision")}
    }));
  }

  async downloadPortableArtifact(projectId, resourceId, versionNumber) {
    const version = integerBetween(versionNumber, 1, 2147483647, "Artifact version");
    return parseDownloadTicket(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/artifact/portable-download?version_number=${version}`,
      {method: "POST"}
    ));
  }

  async readArtifactEdition(projectId, resourceId, versionNumber = null, metadataOnly = false, representation = "saved-map-image") {
    oneOf(representation, ["saved-map-image", "portable-map-html"], "Artifact representation");
    let query = metadataOnly ? "?metadata_only=true" : versionNumber == null ? "" : `?version_number=${integerBetween(versionNumber, 1, 2147483647, "Artifact version")}`;
    if (representation !== "saved-map-image") query += `${query ? "&" : "?"}representation=${representation}`;
    return parseArtifactEdition(await this.request(`/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/artifact${query}`));
  }

  async listArtifactReleases(artifactId, {limit = 20, offset = 0} = {}) {
    const result = object(await this.request(`/artifacts/${pathUuid(artifactId, "Artifact id")}/releases${pageQuery({limit, offset})}`), "Artifact releases");
    if (typeof result.can_publish !== "boolean" || typeof result.has_more !== "boolean" || !Array.isArray(result.records) || result.records.length > 100) contract("Invalid release history");
    for (const item of result.records) if (item.public_view_url) this.rememberPublicArtifactUrl(item.id,item.public_view_url);
    result.records = result.records.map(item => ({id: uuid(item.id, "release id"),
      ...(item.representation ? {representation: oneOf(item.representation, ["saved-map-image", "portable-map-html"], "Artifact representation")} : {}),
      ...(item.network_required !== undefined ? {network_required: boolean(item.network_required, "Artifact network requirement")} : {}),
      version_number: positiveInteger(item.version_number, "release version"), title: string(item.title, "release title"),
      license: string(item.license, "release license"), attribution: string(item.attribution, "release attribution"),
      created_at: string(item.created_at, "release creation"), revoked_at: item.revoked_at === null ? null : string(item.revoked_at, "release revocation")}));
    return result;
  }
  async createArtifactRelease(artifactId, draft) {
    const result = object(await this.request(`/artifacts/${pathUuid(artifactId, "Artifact id")}/releases`, {method: "POST", body: draft}), "Artifact release");
    if (result.public_view_url) this.rememberPublicArtifactUrl(result.id,result.public_view_url);
    return {id: uuid(result.id, "release id")};
  }
  async revokeArtifactRelease(releaseId) {
    const result = object(await this.request(`/artifact-releases/${pathUuid(releaseId, "release id")}/revoke`, {method: "POST"}), "Artifact revocation");
    if (result.revoked !== true) contract("Invalid release revocation");
    return {id: uuid(result.id, "release id"), revoked: true};
  }
  async publicArtifactReleaseUrl(releaseId) {
    const path = `/public/organizations/${pathUuid(await this.organizationProvider(), "account id")}/artifact-releases/${pathUuid(releaseId, "release id")}/view`;
    const saved = this.publicArtifactUrls?.get(releaseId);
    if (saved && new URL(saved).pathname === path) return saved;
    if (!/^https:\/\//.test(this.baseUrl)) contract("Reload public release history to obtain its public URL");
    return `${this.baseUrl}${path}`;
  }
  rememberPublicArtifactUrl(releaseId, value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
        || !url.pathname.endsWith(`/artifact-releases/${pathUuid(releaseId, "release id")}/view`)
        || !/^\/public\/organizations\/[0-9a-f-]{36}\//.test(url.pathname)) contract("Invalid public Artifact URL");
    (this.publicArtifactUrls ??= new Map()).set(releaseId,url.href);
  }
  async listArtifactShares(artifactId, {limit = 20, offset = 0, context: originalContext = null} = {}) {
    const context = originalContext && Object.freeze({...originalContext});
    const id = assertUuid(artifactId, "Artifact id");
    const query = pageQuery({limit, offset});
    await this.assertCollectionContext(context);
    const result = object(await this.request(`/artifacts/${id}/shares${query}`, {
      ...(context ? this.collectionRequestOptions(context.organization, context) : {})
    }), "Artifact shares");
    await this.assertCollectionContext(context);
    exactKeys(result, ["can_publish", "records", "has_more"], "Artifact share history");
    const records = parseArray(result.records, item => parseArtifactShareRecord(item, id), "Artifact share history");
    if (records.length > limit) contract("Artifact share history exceeds its page limit");
    const history = {can_publish: boolean(result.can_publish, "Artifact share publish authority"),
      records, has_more: boolean(result.has_more, "Artifact share history continuation")};
    await this.rememberProtectedArtifactUrls(records, context);
    return history;
  }
  async createArtifactShare(artifactId, draft, {context: originalContext = null} = {}) {
    const context = originalContext && Object.freeze({...originalContext});
    const id = assertUuid(artifactId, "Artifact id"), body = serializeArtifactShareDraft(draft);
    await this.assertCollectionContext(context);
    const result = object(await this.request(`/artifacts/${id}/shares`, {
      ...(context ? this.collectionRequestOptions(context.organization, context) : {}), method: "POST", body
    }), "Artifact share receipt");
    await this.assertCollectionContext(context);
    const receipt = parseArtifactShareReceipt(result, id, body.version_number);
    await this.rememberProtectedArtifactUrls([receipt], context);
    return receipt;
  }
  async revokeArtifactShare(shareId, {context: originalContext = null} = {}) {
    const context = originalContext && Object.freeze({...originalContext});
    const id = assertUuid(shareId, "Artifact share id");
    await this.assertCollectionContext(context);
    const result = object(await this.request(`/artifact-shares/${id}/revoke`, {
      ...(context ? this.collectionRequestOptions(context.organization, context) : {}), method: "POST"
    }), "Artifact share revocation");
    await this.assertCollectionContext(context);
    exactKeys(result, ["id", "revoked"], "Artifact share revocation");
    if (uuid(result.id, "Artifact share id") !== id || result.revoked !== true) contract("Invalid Artifact share revocation");
    return {id, revoked: true};
  }
  async protectedArtifactShareUrl(shareId) {
    const id = assertUuid(shareId, "Artifact share id"), organization = assertUuid(await this.organizationProvider(), "account id");
    const path = `/shared/organizations/${organization}/artifact-shares/${id}/view`;
    const saved = this.protectedArtifactUrls?.get(`${organization}:${id}`);
    if (saved) return saved;
    if (!/^https:\/\//.test(this.baseUrl)) contract("Reload protected share history to obtain its viewer URL");
    return protectedArtifactShareHref(`${this.baseUrl}${path}`, id, organization);
  }
  async rememberProtectedArtifactUrls(records, context) {
    const linked = records.filter(item => Object.hasOwn(item, "view_url"));
    if (!linked.length) return;
    const organization = assertUuid(context?.organization ?? await this.organizationProvider(), "account id");
    const urls = linked.map(item => [item.id, protectedArtifactShareHref(item.view_url, item.id, organization)]);
    await this.assertCollectionContext(context);
    for (const [id, href] of urls) (this.protectedArtifactUrls ??= new Map()).set(`${organization}:${id}`, href);
  }
  async registerArtifactEdition(projectId, resourceId, jobId, expectedRevision) {
    return parseArtifactEdition(await this.request(`/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/renders/${pathUuid(jobId, "render job id")}/artifact-edition`, {
      method: "POST", body: {expected_revision: integerBetween(expectedRevision, 0, 2147483646, "Artifact revision")}
    }));
  }

  async selectArtifactCurrent(projectId, resourceId, versionNumber, expectedRevision, representation = "saved-map-image") {
    oneOf(representation, ["saved-map-image", "portable-map-html"], "Artifact representation");
    const query = representation === "saved-map-image" ? "" : `?representation=${representation}`;
    return parseArtifactEdition(await this.request(`/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/artifact/current${query}`, {
      method: "PUT", body: {
        version_number: integerBetween(versionNumber, 1, 2147483647, "Artifact version"),
        expected_revision: integerBetween(expectedRevision, 0, 2147483646, "Artifact revision")
      }
    }));
  }

  async getProjectArtifactManifest(projectId, resourceId, renderJobId) {
    const result = object(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/renders/${pathUuid(renderJobId, "render job id")}/artifact-manifest`
    ), "Project Artifact manifest");
    if (result.schemaVersion !== "opengeo.project-artifact.1.0.0"
      || result.artifactId !== renderJobId || result.accessContainerId !== projectId
      || result.build?.resourceId !== resourceId) contract("Project Artifact identity mismatch");
    return result;
  }

  /** @returns {Promise<RenderJob[]>} */
  async listResourceRenders(projectId, resourceId) {
    const project = pathUuid(projectId, "project id");
    const resource = pathUuid(resourceId, "resource id");
    const jobs = parseArray(await this.request(`/projects/${project}/resources/${resource}/renders`),
      parseRenderJob, "resource renders");
    if (jobs.length > 100 || jobs.some((job) => job.projectId !== project || job.resourceId !== resource)) {
      contract("resource render listing is inconsistent");
    }
    return jobs;
  }

  /** @returns {Promise<DownloadTicket>} */
  async downloadResourceRender(projectId, resourceId, renderJobId) {
    return parseDownloadTicket(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/renders/${pathUuid(renderJobId, "render job id")}/download`,
        {method: "POST"}
      )
    );
  }

  async listResourceWorkflow(projectId, resourceId) {
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/workflow`
      ),
      parseResourceWorkflowEvent,
      "resource workflow"
    );
  }

  /** @returns {Promise<GovernedResource>} */
  async addResourceRelationship(projectId, resourceId, targetResourceId, relation) {
    return parseGovernedResource(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/relationships`,
        {
          method: "POST",
          body: {
            target_resource_id: assertUuid(targetResourceId, "target resource id"),
            relation
          }
        }
      )
    );
  }

  async importGeoNodeResources(projectId, migrationPackage) {
    return parseGeoNodeImport(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/imports/geonode`,
        {method: "POST", body: structuredClone(object(migrationPackage, "GeoNode import package"))}
      )
    );
  }

  async searchCkan(projectId, {sourceUrl, query = "", organization = null, start = 0}, {signal} = {}) {
    return parseCkanSearch(await this.request(`/projects/${pathUuid(projectId, "project id")}/ckan/search`, {
      method: "POST", signal, body: {source_url: ckanUrl(sourceUrl), query, organization, start, rows: 20}
    }));
  }

  async inspectCkan(projectId, {sourceUrl, datasetId}, {signal} = {}) {
    const url = ckanUrl(sourceUrl), id = ckanId(datasetId);
    return parseCkanInspection(await this.request(`/projects/${pathUuid(projectId, "project id")}/ckan/inspect`, {
      method: "POST", signal, body: {source_url: url, dataset_id: id}
    }), id, url);
  }

  async previewCkan(projectId, {sourceUrl, datasetId, resourceId}, {signal} = {}) {
    return parseCkanPreview(await this.request(`/projects/${pathUuid(projectId, "project id")}/ckan/preview`, {
      method: "POST", signal, body: {source_url: ckanUrl(sourceUrl), dataset_id: ckanId(datasetId), resource_id: ckanId(resourceId)}
    }), resourceId);
  }

  async importCkan(projectId, {sourceUrl, datasetId, packageSha256}) {
    if (!/^[0-9a-f]{64}$/.test(packageSha256)) throw Error("invalid_ckan_checksum");
    const value = object(await this.request(`/projects/${pathUuid(projectId, "project id")}/ckan/import`, {
      method: "POST", body: {source_url: ckanUrl(sourceUrl), dataset_id: ckanId(datasetId), package_sha256: packageSha256}
    }), "CKAN import");
    return {resource: parseGovernedResource(value.resource), idempotent: boolean(value.idempotent, "CKAN idempotent"),
      report: structuredClone(object(value.report, "CKAN conversion report"))};
  }

  async exportResourceToGeoNode(projectId, resourceId) {
    return parseGeoNodeExport(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/resources/${pathUuid(resourceId, "resource id")}/export/geonode`
      )
    );
  }

  /** @returns {Promise<DatasetVersion[]>} */
  async resolveFeatureAttachment(versionId) {
    const requested = assertUuid(versionId, "attachment version");
    const value = object(await this.request(`/feature-attachments/${requested}`), "attachment");
    const version = uuid(value.version_id, "attachment.version_id");
    if (version !== requested) contract("attachment version mismatch");
    return {versionId: version, datasetId: uuid(value.dataset_id, "attachment.dataset_id"),
      objectId: uuid(value.object_id, "attachment.object_id"),
      projectId: uuid(value.project_id, "attachment.project_id"),
      versionNumber: positiveInteger(value.version_number, "attachment.version_number"),
      name: boundedString(value.name, 200, "attachment.name"),
      format: boundedString(value.format, 32, "attachment.format")};
  }

  async listDatasetVersions(projectId, datasetId, page = {}) {
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}/versions${pageQuery(page)}`
      ),
      parseDatasetVersion,
      "dataset versions"
    );
  }

  /** @returns {Promise<DatasetVersionLineage>} */
  async getDatasetVersionLineage(projectId, datasetId, versionId) {
    const expectedDatasetId = pathUuid(datasetId, "dataset id");
    const expectedVersionId = pathUuid(versionId, "dataset version id");
    const lineage = parseDatasetVersionLineage(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/datasets/${expectedDatasetId}/versions/${expectedVersionId}/lineage`
    ));
    if (lineage.datasetId !== expectedDatasetId || lineage.versionId !== expectedVersionId) {
      contract("dataset version lineage identity is inconsistent");
    }
    return lineage;
  }

  /** @returns {Promise<DocumentPreview>} */
  async getDatasetDocumentPreview(projectId, datasetId, versionId) {
    return parseDocumentPreview(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}/versions/${pathUuid(versionId, "dataset version id")}/document-preview`
    ));
  }

  /** @returns {Promise<SpatialPreview>} */
  async getDatasetSpatialPreview(projectId, datasetId, versionId, {signal} = {}) {
    const expectedVersionId = pathUuid(versionId, "dataset version id");
    const preview = parseSpatialPreview(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}/versions/${expectedVersionId}/spatial-preview`, {signal}
    ));
    if (preview.datasetVersionId !== expectedVersionId) {
      contract("spatial preview belongs to another dataset version");
    }
    return preview;
  }

  /** @returns {Promise<FeatureCollectionMetadata>} */
  async getFeatureCollection(projectId, datasetId, {signal} = {}) {
    return parseFeatureCollectionMetadata(await this.request(
      featureCollectionPath(projectId, datasetId), {signal}
    ));
  }

  async previewVectorAnalysis(projectId, datasetId, request, {signal} = {}) {
    const result = boundedObject(await this.request(
      `${featurePath(projectId, datasetId).replace(/\/features$/, "")}/analysis-preview`,
      {method: "POST", body: request, signal}
    ), 2_200_000, "analysis preview");
    const receipt = object(result["opengeo:analysis"], "analysis receipt");
    const supportedVersions = ["clip", "intersection"].includes(request.operation)
      ? ["1.0.0", "1.1.0"] : ["1.0.0"];
    if (receipt.sourceDatasetId !== datasetId || receipt.operation !== request.operation
      || receipt.source_generation !== request.source_generation
      || receipt.targetDatasetId !== (request.target_dataset_id ?? null)
      || (request.target_dataset_id && receipt.target_generation !== request.target_generation)
      || receipt.distanceMeters !== (request.distance_meters ?? null)
      || (request.preview_id && receipt.previewId !== request.preview_id)
      || receipt.persisted !== false || receipt.crs !== "CRS:84" || !supportedVersions.includes(receipt.version)) {
      contract("analysis preview does not match the requested inputs");
    }
    const collection = spatialPreviewGeojson({type: result.type, features: result.features});
    if (collection.features.length > 1_000) contract("analysis preview exceeds its feature limit");
    return {...collection, "opengeo:analysis": structuredClone(receipt)};
  }

  async cancelVectorAnalysis(projectId, datasetId, previewId, {signal} = {}) {
    const result = object(await this.request(
      `${featurePath(projectId, datasetId).replace(/\/features$/, "")}/analysis-preview/${uuid(previewId, "analysis preview ID")}/cancel`,
      {method: "POST", signal}
    ), "analysis cancellation");
    if (result.preview_id !== previewId
      || !["cancellation_requested", "not_running"].includes(result.state)) {
      contract("analysis cancellation does not match the requested preview");
    }
    return {previewId: result.preview_id, state: result.state};
  }

  async createFeatureCollection(projectId, datasetId, {geometryType, fields = [], features = []}) {
    return parseFeaturePage(await this.request(featureCollectionPath(projectId, datasetId), {
      method: "POST",
      body: {
        geometry_type: geometryType,
        fields: serializeFeatureFields(fields),
        features: features.map(serializeFeature)
      }
    }));
  }

  async listFeatures(projectId, datasetId, filters = {}) {
    return parseFeaturePage(await this.request(
      `${featurePath(projectId, datasetId)}${featureQuery(filters)}`
    ));
  }

  async getFeature(projectId, datasetId, featureId) {
    return parseGovernedFeature(await this.request(
      `${featurePath(projectId, datasetId)}/${pathUuid(featureId, "feature id")}`
    ));
  }

  async listFeatureTombstones(projectId, datasetId, page = {}) {
    return parseFeatureTombstonePage(await this.request(
      `${featurePath(projectId, datasetId).replace(/\/features$/, "")}/feature-tombstones${pageQuery(page)}`
    ));
  }

  /** @returns {Promise<FeatureLock[]>} */
  async listFeatureLocks(projectId, datasetId) {
    const result = boundedObject(await this.request(
      `${featurePath(projectId, datasetId).replace(/\/features$/, "")}/feature-locks`
    ), 100_000, "feature lock list");
    const locks = parseArray(result.locks, parseFeatureLock, "feature locks");
    if (locks.length > 100
      || nonNegativeInteger(result.number_returned, "feature lock count") !== locks.length
      || positiveInteger(result.limit, "feature lock limit") !== 100) {
      contract("feature lock list counts are inconsistent");
    }
    return locks;
  }

  /** @returns {Promise<FeatureLock>} */
  async acquireFeatureLock(projectId, datasetId, featureId, {
    expectedVersion,
    lockToken,
    leaseSeconds = 120
  }) {
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 300) {
      throw new TypeError("feature lock leaseSeconds must be between 30 and 300");
    }
    return parseFeatureLock(await this.request(
      `${featurePath(projectId, datasetId)}/${pathUuid(featureId, "feature id")}/lock`,
      {
        method: "PUT",
        body: {
          expected_version: positiveInteger(
            expectedVersion, "feature lock expected version"
          ),
          lock_token: assertUuid(lockToken, "feature lock token"),
          lease_seconds: leaseSeconds
        }
      }
    ));
  }

  async releaseFeatureLock(projectId, datasetId, featureId, lockToken) {
    const query = new URLSearchParams({
      lock_token: assertUuid(lockToken, "feature lock token")
    });
    const result = boundedObject(await this.request(
      `${featurePath(projectId, datasetId)}/${pathUuid(featureId, "feature id")}/lock?${query}`,
      {method: "DELETE"}
    ), 10_000, "feature lock release");
    return {
      featureId: uuid(result.feature_id, "feature lock release.feature_id"),
      released: boolean(result.released, "feature lock release.released")
    };
  }

  async queryFeatures(projectId, datasetId, query, {signal} = {}) {
    const result = parseFeatureQueryPage(await this.request(
      `${featurePath(projectId, datasetId).replace(/\/features$/, "")}/feature-query`,
      {method: "POST", body: normalizeFeatureQuery(query), signal}
    ));
    if (await featureQuerySha256(result.query) !== result.querySha256) {
      contract("feature query digest does not match its parameters");
    }
    return result;
  }

  /** @returns {Promise<GovernedFeature>} */
  async createFeature(projectId, datasetId, feature, changeMessage = null) {
    return parseGovernedFeature(await this.request(featurePath(projectId, datasetId), {
      method: "POST",
      body: {...serializeFeature(feature), change_message: changeMessage}
    }));
  }

  /** @returns {Promise<GovernedFeature>} */
  async updateFeature(projectId, datasetId, featureId, {
    expectedVersion,
    geometry,
    properties,
    changeMessage = null,
    lockToken = null
  }) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new TypeError("feature expectedVersion must be a positive integer");
    }
    const draft = serializeFeature({id: featureId, geometry, properties});
    return parseGovernedFeature(await this.request(
      `${featurePath(projectId, datasetId)}/${pathUuid(featureId, "feature id")}`,
      {
        method: "PUT",
        body: {
          expected_version: expectedVersion,
          ...(lockToken === null ? {} : {
            lock_token: assertUuid(lockToken, "feature lock token")
          }),
          geometry: draft.geometry,
          properties: draft.properties,
          change_message: changeMessage
        }
      }
    ));
  }

  async deleteFeature(
    projectId,
    datasetId,
    featureId,
    expectedVersion,
    changeMessage = null,
    lockToken = null
  ) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new TypeError("feature expectedVersion must be a positive integer");
    }
    const query = new URLSearchParams({expected_version: String(expectedVersion)});
    if (changeMessage !== null) query.set("change_message", boundedString(
      changeMessage, 500, "feature change message"
    ));
    if (lockToken !== null) query.set(
      "lock_token", assertUuid(lockToken, "feature lock token")
    );
    return parseFeatureDeletion(await this.request(
      `${featurePath(projectId, datasetId)}/${pathUuid(featureId, "feature id")}?${query}`,
      {method: "DELETE"}
    ));
  }

  /** @returns {Promise<GovernedFeature>} */
  async restoreFeature(projectId, datasetId, featureId, {
    expectedVersion,
    revisionVersion,
    changeMessage = null
  }) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 2) {
      throw new TypeError("feature restore expectedVersion must be an integer of at least 2");
    }
    if (!Number.isSafeInteger(revisionVersion)
      || revisionVersion < 1
      || revisionVersion >= expectedVersion) {
      throw new TypeError("feature restore revisionVersion must predate the tombstone");
    }
    return parseGovernedFeature(await this.request(
      `${featurePath(projectId, datasetId)}/${pathUuid(featureId, "feature id")}/restore`,
      {
        method: "POST",
        body: {
          expected_version: expectedVersion,
          revision_version: revisionVersion,
          change_message: changeMessage === null
            ? null
            : boundedString(changeMessage, 500, "feature restore change message")
        }
      }
    ));
  }

  async separateMultipolygonParts(
    projectId,
    datasetId,
    {
      featureId,
      expectedVersion,
      retainedPartIndex = 0,
      changeMessage = null,
      lockToken = null
    }
  ) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new TypeError("feature expectedVersion must be a positive integer");
    }
    if (!Number.isSafeInteger(retainedPartIndex) || retainedPartIndex < 0 || retainedPartIndex > 255) {
      throw new TypeError("retainedPartIndex must be between 0 and 255");
    }
    return parseFeatureStructureMutation(await this.request(
      `${featurePath(projectId, datasetId)}/separate-parts`,
      {
        method: "POST",
        body: {
          feature_id: assertUuid(featureId, "feature id"),
          expected_version: expectedVersion,
          ...(lockToken === null ? {} : {
            lock_token: assertUuid(lockToken, "feature lock token")
          }),
          retained_part_index: retainedPartIndex,
          change_message: boundedQuery(changeMessage, 500, "feature change message")
        }
      }
    ), "separate_parts");
  }

  async mergeMultipolygonFeatures(
    projectId,
    datasetId,
    {retainedFeatureId, features, changeMessage = null}
  ) {
    if (!Array.isArray(features) || features.length < 2 || features.length > 20) {
      throw new TypeError("polygon merge requires between 2 and 20 features");
    }
    const normalized = features.map((feature) => {
      const record = object(feature, "polygon merge feature");
      if (!Number.isSafeInteger(record.expectedVersion) || record.expectedVersion < 1) {
        throw new TypeError("polygon merge expectedVersion must be a positive integer");
      }
      return {
        feature_id: assertUuid(record.featureId, "polygon merge feature id"),
        expected_version: record.expectedVersion,
        ...(record.lockToken === null || record.lockToken === undefined ? {} : {
          lock_token: assertUuid(record.lockToken, "polygon merge feature lock token")
        })
      };
    });
    if (new Set(normalized.map(({feature_id: id}) => id)).size !== normalized.length) {
      throw new TypeError("polygon merge feature ids must be unique");
    }
    const retained = assertUuid(retainedFeatureId, "retained polygon feature id");
    if (!normalized.some(({feature_id: id}) => id === retained)) {
      throw new TypeError("retained polygon feature must be included in the merge");
    }
    return parseFeatureStructureMutation(await this.request(
      `${featurePath(projectId, datasetId)}/merge-parts`,
      {
        method: "POST",
        body: {
          retained_feature_id: retained,
          features: normalized,
          change_message: boundedQuery(changeMessage, 500, "feature change message")
        }
      }
    ), "merge_parts");
  }

  async listFeatureHistory(projectId, datasetId, featureId, page = {}) {
    return parseFeatureHistory(await this.request(
      `${featurePath(projectId, datasetId)}/${pathUuid(featureId, "feature id")}/history${pageQuery(page)}`
    ));
  }

  /** @returns {Promise<FieldForm[]>} */
  async listFieldForms(projectId, datasetId) {
    const result = boundedObject(
      await this.request(fieldFormPath(projectId, datasetId)),
      1_000_000,
      "field form list"
    );
    const forms = parseArray(result.forms, parseFieldForm, "field forms");
    if (forms.length > 100
      || nonNegativeInteger(result.number_returned, "field form count") !== forms.length) {
      contract("field form list count is inconsistent");
    }
    return forms;
  }

  /** @returns {Promise<FieldForm>} */
  async createFieldForm(projectId, datasetId, {title, instructions = null}) {
    return parseFieldForm(await this.request(fieldFormPath(projectId, datasetId), {
      method: "POST",
      body: {
        title: boundedString(title, 200, "field form title"),
        instructions: instructions === null
          ? null
          : boundedString(instructions, 4000, "field form instructions")
      }
    }));
  }

  /** @returns {Promise<FieldForm>} */
  async createFieldFormVersion(projectId, datasetId, formId, {
    expectedVersion,
    title,
    instructions = null
  }) {
    return parseFieldForm(await this.request(
      `${fieldFormPath(projectId, datasetId)}/${pathUuid(formId, "field form id")}/versions`,
      {
        method: "POST",
        body: {
          expected_version: positiveInteger(expectedVersion, "field form expected version"),
          title: boundedString(title, 200, "field form title"),
          instructions: instructions === null
            ? null
            : boundedString(instructions, 4000, "field form instructions")
        }
      }
    ));
  }

  /** @returns {Promise<{created: boolean, submission: FieldSubmission}>} */
  async createFieldSubmission(projectId, datasetId, formId, formVersion, {
    submissionId,
    supersedesSubmissionId = null,
    operation = "create",
    targetFeatureId = null,
    targetFeatureVersion = null,
    feature
  }) {
    const normalizedOperation = oneOf(
      operation, ["create", "update"], "field submission operation"
    );
    const normalizedTargetId = targetFeatureId === null
      ? null
      : pathUuid(targetFeatureId, "field submission target feature id");
    const normalizedTargetVersion = targetFeatureVersion === null
      ? null
      : positiveInteger(targetFeatureVersion, "field submission target feature version");
    if ((normalizedOperation === "create" && (normalizedTargetId || normalizedTargetVersion))
      || (normalizedOperation === "update"
        && (normalizedTargetId === null || normalizedTargetVersion === null))) {
      throw new TypeError("field submission operation target is invalid");
    }
    return parseFieldSubmissionReceipt(await this.request(
      `${fieldFormPath(projectId, datasetId)}/${pathUuid(formId, "field form id")}/versions/${positiveInteger(formVersion, "field form version")}/submissions`,
      {
        method: "POST",
        body: {
          client_submission_id: pathUuid(submissionId, "field submission id"),
          supersedes_submission_id: supersedesSubmissionId === null
            ? null
            : pathUuid(supersedesSubmissionId, "superseded field submission id"),
          operation: normalizedOperation,
          target_feature_id: normalizedTargetId,
          target_feature_version: normalizedTargetVersion,
          feature: serializeFeature({
            ...feature,
            id: normalizedOperation === "create" ? submissionId : normalizedTargetId
          })
        }
      }
    ));
  }

  /** @returns {Promise<FieldSubmission[]>} */
  async listFieldSubmissions(projectId, datasetId, {state = null, limit = 20, offset = 0} = {}) {
    const query = pageParameters({limit, offset});
    if (state !== null) query.set("state", oneOf(
      state,
      ["submitted", "in_review", "changes_requested", "rejected", "accepted"],
      "field submission state"
    ));
    const result = boundedObject(
      await this.request(`${fieldSubmissionPath(projectId, datasetId)}?${query}`),
      10_000_000,
      "field submission list"
    );
    const submissions = parseArray(
      result.submissions,
      parseFieldSubmission,
      "field submissions"
    );
    if (submissions.length > 100
      || nonNegativeInteger(result.number_returned, "field submission count") !== submissions.length) {
      contract("field submission list count is inconsistent");
    }
    positiveInteger(result.limit, "field submission limit");
    nonNegativeInteger(result.offset, "field submission offset");
    return submissions;
  }

  async reviewFieldSubmission(projectId, datasetId, submissionId, {
    expectedVersion,
    decision,
    message = null
  }) {
    const result = boundedObject(await this.request(
      `${fieldSubmissionPath(projectId, datasetId)}/${pathUuid(submissionId, "field submission id")}/review`,
      {
        method: "POST",
        body: {
          expected_version: positiveInteger(expectedVersion, "field submission expected version"),
          decision: oneOf(
            decision,
            ["start_review", "request_changes", "reject", "accept"],
            "field submission review decision"
          ),
          message: message === null
            ? null
            : boundedString(message, 2000, "field submission review message")
        }
      }
    ), 1_000_000, "field submission review");
    return {
      submission: parseFieldSubmission(result.submission),
      promotedFeature: result.promoted_feature === null
        ? null
        : parseGovernedFeature(result.promoted_feature)
    };
  }

  /** @returns {Promise<DatasetPermission[]>} */
  async listDatasetPermissions(projectId, datasetId) {
    return parseArray(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}/permissions`
      ),
      parseDatasetPermission,
      "dataset permissions"
    );
  }

  /** @returns {Promise<DatasetPermission>} */
  async putDatasetPermission(projectId, datasetId, userId, role) {
    return parseDatasetPermission(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}/permissions/${pathUuid(userId, "user id")}`,
        {method: "PUT", body: {role}}
      )
    );
  }

  async deleteDatasetPermission(projectId, datasetId, userId) {
    await this.request(
      `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}/permissions/${pathUuid(userId, "user id")}`,
      {method: "DELETE"}
    );
  }

  /** @returns {Promise<DownloadTicket>} */
  async requestDatasetDownload(projectId, datasetId, versionId, objectId) {
    return parseDownloadTicket(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}/versions/${pathUuid(versionId, "version id")}/objects/${pathUuid(objectId, "object id")}/download`,
        {method: "POST"}
      )
    );
  }

  archiveUploads(projectId) {
    return archiveUploadApi(this, projectId);
  }

  /** @returns {Promise<UploadTicket>} */
  async requestUpload(projectId, metadata) {
    const record = object(metadata, "upload metadata");
    return parseUploadTicket(
      await this.request(`/projects/${pathUuid(projectId, "project id")}/uploads/request`, {
        method: "POST",
        body: {
          name: record.name,
          description: record.description ?? null,
          classification: record.classification,
          format: record.format,
          filename: record.filename,
          content_type: record.contentType,
          size_bytes: record.sizeBytes,
          checksum_sha256: record.checksumSha256,
          tags: record.tags ?? [],
          ...(record.targetDatasetId ? {
            target_dataset_id: pathUuid(record.targetDatasetId, "target Layer"),
            expected_base_version_id: pathUuid(record.expectedBaseVersionId, "base version")
          } : {})
        }
      })
    );
  }

  async renewUpload(projectId, uploadId) {
    const ticket = parseUploadTicket(await this.request(
      `/projects/${pathUuid(projectId, "project id")}/uploads/${pathUuid(uploadId, "upload id")}/renew`,
      {method: "POST"}
    ));
    if (ticket.uploadId !== uploadId) contract("Renewed upload identity changed");
    return ticket;
  }

  async createDatasetRefreshReview(datasetId, baseVersionId, candidateVersionId) {
    const result = object(await this.request(`/datasets/${pathUuid(datasetId, "Layer")}/refresh-reviews`, {
      method: "POST", body: {base_version_id: pathUuid(baseVersionId, "base version"), candidate_version_id: pathUuid(candidateVersionId, "candidate version")}
    }), "refresh review");
    uuid(result.id, "review id");
    if (result.dataset_id !== datasetId || result.base_version_id !== baseVersionId || result.candidate_version_id !== candidateVersionId
      || !/^[a-f0-9]{64}$/.test(result.evidence_sha256) || JSON.stringify(result).length > 180_000) contract("Refresh review identity is inconsistent");
    oneOf(result.decision, ["ready", "review_required", "rejected"], "review decision");
    const evidence = object(result.evidence, "review evidence");
    if (evidence.schemaVersion !== "opengeo.dataset-refresh-review.1.0.0" || evidence.base?.versionId !== baseVersionId
      || evidence.candidate?.versionId !== candidateVersionId || !Array.isArray(evidence.reviewReasons)) contract("Refresh evidence is invalid");
    return result;
  }

  async acceptDatasetRefreshReview(datasetId, review) {
    const result = object(await this.request(`/datasets/${pathUuid(datasetId, "Layer")}/refresh-reviews/${pathUuid(review.id, "review")}/accept`, {
      method: "POST", body: {base_version_id: pathUuid(review.base_version_id, "base version"), evidence_sha256: review.evidence_sha256}
    }), "refresh acceptance");
    if (result.dataset_id !== datasetId || result.review_id !== review.id || result.current_version_id !== review.candidate_version_id
      || result.previous_version_id !== review.base_version_id || result.evidence_sha256 !== review.evidence_sha256) contract("Refresh acceptance identity is inconsistent");
    return result;
  }

  async uploadFile(instructions, file) {
    const upload = parseUploadInstructions(instructions);
    if (!(file instanceof Blob) || file.size < 1) {
      throw new TypeError("upload file must be a non-empty Blob");
    }
    const body = new FormData();
    for (const [name, value] of Object.entries(upload.fields)) body.append(name, value);
    body.append("file", file);

    let response;
    try {
      response = await this.fetchImplementation(upload.url, {
        method: upload.method,
        body,
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer"
      });
    } catch (cause) {
      throw new ApiClientError("The signed upload destination could not be reached", {
        code: "upload_network_unavailable",
        cause
      });
    }
    if (!response.ok) {
      throw new ApiClientError("The signed upload was rejected", {
        status: response.status,
        code: "signed_upload_failed"
      });
    }
  }

  /** @returns {Promise<UploadCompletion>} */
  async completeUpload(projectId, uploadId) {
    return parseUploadCompletion(
      await this.request(
        `/projects/${pathUuid(projectId, "project id")}/uploads/${pathUuid(uploadId, "upload id")}/complete`,
        {method: "POST"}
      )
    );
  }

  async requestResponse(
    path,
    {
      method = "GET", body, organizationRequired = true, organizationId: selectedOrganizationId, signal,
      accept = "application/json", anonymous = false, token: selectedToken, beforeDispatch, beforeDispatchNow
    } = {}
  ) {
    const headers = new Headers({accept});
    if (!anonymous) {
      const token = selectedToken === undefined ? await this.tokenProvider() : selectedToken;
      if (!token || typeof token !== "string") {
        throw new ApiClientError("Authentication is required", {
          status: 401,
          code: "authentication_required"
        });
      }
      headers.set("authorization", `Bearer ${token}`);
      const organizationId = selectedOrganizationId === undefined ? await this.organizationProvider() : selectedOrganizationId;
      if (organizationId) headers.set("X-OpenGeo-Organization", assertUuid(organizationId, "organization id"));
      if (organizationRequired && !organizationId) {
        throw new ApiClientError("An organization must be selected", {
          status: 409,
          code: "organization_scope_required"
        });
      }
    }
    if (body !== undefined) headers.set("content-type", "application/json");
    if (beforeDispatch) await beforeDispatch();
    if (beforeDispatchNow) beforeDispatchNow();

    let response;
    try {
      const requestBaseUrl = this.baseUrl;
      const fetchResponse = (requestSignal) => this.fetchImplementation(`${requestBaseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: requestSignal
      });
      if (path === "/auth/session" && method === "GET" && body === undefined && !anonymous) {
        const scope = JSON.stringify([requestBaseUrl, [...headers]]);
        const loadSession = async (requestSignal) => {
          const first = await fetchResponse(requestSignal);
          if (first.status !== 503) return first;
          let detail;
          try { detail = (await first.clone().json())?.detail; }
          catch { return first; }
          if (detail !== "identity_store_unavailable") return first;
          // A paused metadata store can recover while the existing login stays valid.
          // Keep one retry inside this shared, cancellable session read.
          await new Promise((resolve, reject) => {
            requestSignal.throwIfAborted();
            const abort = () => {
              clearTimeout(timer);
              requestSignal.removeEventListener("abort", abort);
              reject(requestSignal.reason ?? new DOMException("Aborted", "AbortError"));
            };
            const timer = setTimeout(() => {
              requestSignal.removeEventListener("abort", abort);
              resolve();
            }, 2000);
            requestSignal.addEventListener("abort", abort, {once: true});
          });
          requestSignal.throwIfAborted();
          return fetchResponse(requestSignal);
        };
        response = (await pendingSessionRequest(this.pendingSessions, scope, loadSession, {signal})).clone();
      } else {
        response = await fetchResponse(signal);
      }
    } catch (cause) {
      if (signal?.aborted || cause?.name === "AbortError") throw cause;
      throw new ApiClientError("The API could not be reached", {
        code: "network_unavailable",
        cause
      });
    }

    return response;
  }

  async request(path, options = {}) {
    const response = await this.requestResponse(path, options);
    const payload = await responsePayload(response);
    if (!response.ok) {
      throw apiResponseError(response, payload);
    }
    return payload;
  }
}

function serializeArtifactShareDraft(value) {
  if (!isObject(value) || Object.keys(value).length !== 4
    || ["creation_key", "version_number", "title", "password"].some(key => !Object.hasOwn(value, key))) {
    throw new TypeError("Artifact share draft has unexpected fields");
  }
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 200) {
    throw new TypeError("Artifact share title is invalid");
  }
  if (typeof value.password !== "string" || value.password.length < 12 || value.password.length > 128) {
    throw new TypeError("Artifact share password must contain 12 to 128 characters");
  }
  return {creation_key: assertUuid(value.creation_key, "Artifact share creation key"),
    version_number: inputIntegerBetween(value.version_number, 1, 2147483647, "Artifact share version"),
    title: value.title, password: value.password};
}

function parseArtifactShareRecord(value, artifactId) {
  const record = object(value, "Artifact share");
  const fields = ["id", "artifact_id", "version_number", "title", "created_at", "revoked_at"];
  exactKeys(record, Object.hasOwn(record, "view_url") ? [...fields, "view_url"] : fields, "Artifact share");
  const id = uuid(record.id, "Artifact share id"), artifact = uuid(record.artifact_id, "Artifact share Artifact id");
  if (artifact !== artifactId) contract("Artifact share belongs to a different Artifact");
  return {id, artifact_id: artifact, version_number: positiveInteger(record.version_number, "Artifact share version"),
    title: boundedString(record.title, 200, "Artifact share title"), created_at: timestamp(record.created_at, "Artifact share creation"),
    revoked_at: nullableTimestamp(record.revoked_at, "Artifact share revocation"),
    ...(Object.hasOwn(record, "view_url") ? {view_url: record.view_url} : {})};
}

function parseArtifactShareReceipt(record, artifactId, versionNumber) {
  const allowed = ["id", "artifact_id", "version_number", "title", "created_at", "revoked_at", "view_url"];
  if (!Object.hasOwn(record, "id") || Object.keys(record).some(key => !allowed.includes(key))) {
    contract("Artifact share receipt has unexpected fields");
  }
  const id = uuid(record.id, "Artifact share id");
  if (Object.hasOwn(record, "artifact_id") && uuid(record.artifact_id, "Artifact share Artifact id") !== artifactId) {
    contract("Artifact share belongs to a different Artifact");
  }
  if (Object.hasOwn(record, "version_number") && positiveInteger(record.version_number, "Artifact share version") !== versionNumber) {
    contract("Artifact share refers to a different version");
  }
  if (Object.hasOwn(record, "title")) boundedString(record.title, 200, "Artifact share title");
  if (Object.hasOwn(record, "created_at")) timestamp(record.created_at, "Artifact share creation");
  if (Object.hasOwn(record, "revoked_at")) nullableTimestamp(record.revoked_at, "Artifact share revocation");
  return {id, ...(Object.hasOwn(record, "view_url") ? {view_url: record.view_url} : {})};
}

function protectedArtifactShareHref(value, shareId, organization) {
  let url;
  try {url = new URL(value);}
  catch (cause) {contract("Invalid protected Artifact URL", cause);}
  const path = `/shared/organizations/${organization}/artifact-shares/${shareId}/view`;
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      (url.pathname !== path && url.pathname !== `/api${path}`)) {
    contract("Invalid protected Artifact URL");
  }
  return url.href;
}

export function parseSession(value) {
  const record = object(value, "session");
  return {
    userId: uuid(record.user_id, "session.user_id"),
    email: string(record.email, "session.email"),
    displayName: string(record.display_name, "session.display_name"),
    memberships: parseArray(record.memberships, (membership) => {
      const item = object(membership, "membership");
      return {
        organizationId: uuid(item.organization_id, "membership.organization_id"),
        role: oneOf(item.role, ["admin", "member", "guest"], "membership.role")
      };
    }, "memberships"),
    selectedOrganizationId: nullableUuid(record.selected_organization_id, "selected organization"),
    selectedOrganizationRole: nullableString(record.selected_organization_role, "selected role")
  };
}

export function parseOrganization(value) {
  const record = object(value, "organization");
  return {
    id: uuid(record.id, "organization.id"),
    name: string(record.name, "organization.name"),
    slug: string(record.slug, "organization.slug"),
    status: oneOf(record.status, ["active", "archived"], "organization.status"),
    callerRole: oneOf(record.caller_role, ["admin", "member", "guest"], "organization.caller_role")
  };
}

export function parseClient(value) {
  const record = object(value, "client");
  return {
    id: uuid(record.id, "client.id"),
    name: string(record.name, "client.name"),
    clientCode: nullableString(record.client_code, "client.client_code"),
    description: nullableString(record.description, "client.description"),
    status: oneOf(record.status, ["active", "archived"], "client.status"),
    createdAt: timestamp(record.created_at, "client.created_at"),
    updatedAt: timestamp(record.updated_at, "client.updated_at")
  };
}

export function parseProject(value) {
  const record = object(value, "project");
  return {
    id: uuid(record.id, "project.id"),
    clientId: nullableUuid(record.client_id, "project.client_id"),
    name: string(record.name, "project.name"),
    projectCode: nullableString(record.project_code, "project.project_code"),
    description: nullableString(record.description, "project.description"),
    status: oneOf(record.status, ["active", "archived"], "project.status"),
    createdAt: timestamp(record.created_at, "project.created_at"),
    updatedAt: timestamp(record.updated_at, "project.updated_at"),
    callerRole: record.caller_role === null
      ? null
      : oneOf(record.caller_role, ["owner", "editor", "reviewer", "viewer"], "project.caller_role"),
    visibility: record.visibility === undefined
      ? "internal"
      : oneOf(record.visibility, ["internal", "published"], "project.visibility"),
    publishedAt: record.published_at === undefined
      ? null
      : nullableTimestamp(record.published_at, "project.published_at"),
    publishedBy: record.published_by === undefined
      ? null
      : nullableUuid(record.published_by, "project.published_by")
  };
}

export function parseTeam(value) {
  const record = object(value, "team");
  return {
    id: uuid(record.id, "team.id"),
    name: string(record.name, "team.name"),
    description: nullableString(record.description, "team.description"),
    status: oneOf(record.status, ["active", "archived"], "team.status"),
    callerRole: record.caller_role === null
      ? null
      : oneOf(record.caller_role, ["owner", "manager", "member"], "team.caller_role"),
    createdAt: timestamp(record.created_at, "team.created_at"),
    updatedAt: timestamp(record.updated_at, "team.updated_at")
  };
}

export function parseTeamMember(value) {
  const record = object(value, "team member");
  return {
    userId: uuid(record.user_id, "team member.user_id"),
    email: string(record.email, "team member.email"),
    displayName: string(record.display_name, "team member.display_name"),
    role: oneOf(record.role, ["owner", "manager", "member"], "team member.role"),
    createdAt: timestamp(record.created_at, "team member.created_at"),
    updatedAt: timestamp(record.updated_at, "team member.updated_at")
  };
}

export function parseProjectTeamGrant(value) {
  const record = object(value, "project team grant");
  return {
    id: uuid(record.id, "project team grant.id"),
    projectId: uuid(record.project_id, "project team grant.project_id"),
    teamId: uuid(record.team_id, "project team grant.team_id"),
    teamName: string(record.team_name, "project team grant.team_name"),
    role: oneOf(
      record.role,
      ["owner", "editor", "reviewer", "viewer"],
      "project team grant.role"
    ),
    createdAt: timestamp(record.created_at, "project team grant.created_at"),
    updatedAt: timestamp(record.updated_at, "project team grant.updated_at")
  };
}

export function parseProjectDiscussion(value) {
  const record = object(value, "project discussion");
  exactKeys(record, [
    "id", "project_id", "initial_comment_id", "title", "state", "version_number",
    "created_by", "created_by_name", "resolved_by", "resolved_by_name", "resolved_at",
    "created_at", "updated_at", "comment_count", "latest_comment_at", "can_moderate",
    "target", "assigned_to", "assigned_to_name", "assigned_by", "assigned_by_name",
    "assigned_at"
  ], "project discussion");
  const state = oneOf(record.state, ["open", "resolved"], "project discussion.state");
  const resolvedBy = nullableUuid(record.resolved_by, "project discussion.resolved_by");
  const resolvedByName = nullableBoundedString(
    record.resolved_by_name, 200, "project discussion.resolved_by_name"
  );
  const resolvedAt = nullableTimestamp(
    record.resolved_at, "project discussion.resolved_at"
  );
  if ((state === "open" && [resolvedBy, resolvedByName, resolvedAt].some(Boolean))
    || (state === "resolved" && [resolvedBy, resolvedByName, resolvedAt].some((item) => !item))) {
    contract("project discussion resolution attribution is inconsistent");
  }
  const assignedTo = nullableUuid(record.assigned_to, "project discussion.assigned_to");
  const assignedToName = nullableBoundedString(
    record.assigned_to_name, 200, "project discussion.assigned_to_name"
  );
  const assignedBy = nullableUuid(record.assigned_by, "project discussion.assigned_by");
  const assignedByName = nullableBoundedString(
    record.assigned_by_name, 200, "project discussion.assigned_by_name"
  );
  const assignedAt = nullableTimestamp(record.assigned_at, "project discussion.assigned_at");
  if ([assignedTo, assignedToName, assignedBy, assignedByName, assignedAt]
    .some((value) => (assignedTo === null) !== (value === null))) {
    contract("project discussion assignment attribution is inconsistent");
  }
  return {
    id: uuid(record.id, "project discussion.id"),
    projectId: uuid(record.project_id, "project discussion.project_id"),
    initialCommentId: uuid(
      record.initial_comment_id, "project discussion.initial_comment_id"
    ),
    title: boundedString(record.title, 200, "project discussion.title"),
    state,
    versionNumber: integerBetween(
      record.version_number, 1, 2_147_483_647, "project discussion.version_number"
    ),
    createdBy: uuid(record.created_by, "project discussion.created_by"),
    createdByName: boundedString(
      record.created_by_name, 200, "project discussion.created_by_name"
    ),
    resolvedBy,
    resolvedByName,
    resolvedAt,
    createdAt: timestamp(record.created_at, "project discussion.created_at"),
    updatedAt: timestamp(record.updated_at, "project discussion.updated_at"),
    commentCount: integerBetween(
      record.comment_count, 1, 1_000_000, "project discussion.comment_count"
    ),
    latestCommentAt: timestamp(
      record.latest_comment_at, "project discussion.latest_comment_at"
    ),
    canModerate: boolean(record.can_moderate, "project discussion.can_moderate"),
    target: record.target === null ? null : parseDiscussionTarget(record.target),
    assignedTo,
    assignedToName,
    assignedBy,
    assignedByName,
    assignedAt
  };
}

function serializeDiscussionTarget(value) {
  const target = object(value, "discussion target");
  if (Object.hasOwn(target, "kind")) {
    exactKeys(target, ["kind", "objectId", "version"], "object discussion target");
    return {
      kind: oneOf(
        target.kind,
        ["map", "dataset", "resource", "site"],
        "object discussion target.kind"
      ),
      object_id: assertUuid(target.objectId, "object discussion target.objectId"),
      version: positiveInteger(target.version, "object discussion target.version")
    };
  }
  return serializeFeatureDiscussionTarget(target);
}

function serializeFeatureDiscussionTarget(target) {
  exactKeys(
    target,
    ["mapId", "mapVersion", "layerId", "datasetId", "featureId"],
    "feature discussion target"
  );
  const layerId = boundedString(target.layerId, 160, "feature discussion target.layerId");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(layerId)) {
    throw new TypeError("feature discussion target.layerId is invalid");
  }
  return {
    map_id: assertUuid(target.mapId, "feature discussion target.mapId"),
    map_version: positiveInteger(
      target.mapVersion, "feature discussion target.mapVersion"
    ),
    layer_id: layerId,
    dataset_id: assertUuid(target.datasetId, "feature discussion target.datasetId"),
    feature_id: assertUuid(target.featureId, "feature discussion target.featureId")
  };
}

export function parseDiscussionTarget(value) {
  const target = object(value, "discussion target");
  return Object.hasOwn(target, "kind")
    ? parseObjectDiscussionTarget(target)
    : parseFeatureDiscussionTarget(target);
}

export function parseObjectDiscussionTarget(value) {
  const target = object(value, "object discussion target");
  exactKeys(target, ["kind", "object_id", "version"], "object discussion target");
  return {
    kind: oneOf(
      target.kind,
      ["map", "dataset", "resource", "site"],
      "object discussion target.kind"
    ),
    objectId: uuid(target.object_id, "object discussion target.object_id"),
    version: positiveInteger(target.version, "object discussion target.version")
  };
}

export function parseFeatureDiscussionTarget(value) {
  const target = object(value, "feature discussion target");
  exactKeys(
    target,
    ["map_id", "map_version", "layer_id", "dataset_id", "feature_id"],
    "feature discussion target"
  );
  const layerId = boundedString(target.layer_id, 160, "feature discussion target.layer_id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(layerId)) {
    contract("feature discussion target.layer_id is invalid");
  }
  return {
    mapId: uuid(target.map_id, "feature discussion target.map_id"),
    mapVersion: positiveInteger(
      target.map_version, "feature discussion target.map_version"
    ),
    layerId,
    datasetId: uuid(target.dataset_id, "feature discussion target.dataset_id"),
    featureId: uuid(target.feature_id, "feature discussion target.feature_id")
  };
}

export function parseProjectDiscussionComment(value) {
  const record = object(value, "project discussion comment");
  exactKeys(record, [
    "id", "project_id", "discussion_id", "body", "created_by", "created_by_name",
    "created_at", "mentions", "moderation"
  ], "project discussion comment");
  const body = boundedString(record.body, 4000, "project discussion comment.body");
  const moderation = record.moderation === null
    ? null
    : parseProjectDiscussionModeration(record.moderation);
  if (moderation !== null && body !== "[Comment redacted]") {
    contract("moderated project discussion comment did not project the redaction marker");
  }
  return {
    id: uuid(record.id, "project discussion comment.id"),
    projectId: uuid(record.project_id, "project discussion comment.project_id"),
    discussionId: uuid(record.discussion_id, "project discussion comment.discussion_id"),
    body,
    createdBy: uuid(record.created_by, "project discussion comment.created_by"),
    createdByName: boundedString(
      record.created_by_name, 200, "project discussion comment.created_by_name"
    ),
    createdAt: timestamp(record.created_at, "project discussion comment.created_at"),
    mentions: parseArray(
      record.mentions,
      parseProjectDiscussionMention,
      "project discussion comment.mentions"
    ),
    moderation
  };
}

export function parseProjectDiscussionModeration(value) {
  const record = object(value, "project discussion moderation");
  exactKeys(
    record,
    ["id", "action", "reason", "actor_user_id", "actor_name", "created_at"],
    "project discussion moderation"
  );
  return {
    id: uuid(record.id, "project discussion moderation.id"),
    action: oneOf(record.action, ["redact"], "project discussion moderation.action"),
    reason: boundedString(record.reason, 500, "project discussion moderation.reason"),
    actorUserId: uuid(record.actor_user_id, "project discussion moderation.actor_user_id"),
    actorName: boundedString(record.actor_name, 200, "project discussion moderation.actor_name"),
    createdAt: timestamp(record.created_at, "project discussion moderation.created_at")
  };
}

export function parseProjectDiscussionSubscription(value) {
  const record = object(value, "project discussion subscription");
  exactKeys(record, [
    "discussion_id", "subscribed", "version_number", "subscribed_at", "unsubscribed_at"
  ], "project discussion subscription");
  const subscribed = boolean(record.subscribed, "project discussion subscription.subscribed");
  const unsubscribedAt = nullableTimestamp(
    record.unsubscribed_at, "project discussion subscription.unsubscribed_at"
  );
  if (subscribed !== (unsubscribedAt === null)) {
    contract("project discussion subscription state is inconsistent");
  }
  return {
    discussionId: uuid(record.discussion_id, "project discussion subscription.discussion_id"),
    subscribed,
    versionNumber: positiveInteger(
      record.version_number, "project discussion subscription.version_number"
    ),
    subscribedAt: timestamp(
      record.subscribed_at, "project discussion subscription.subscribed_at"
    ),
    unsubscribedAt
  };
}

export function parseProjectDiscussionParticipant(value) {
  const record = object(value, "project discussion participant");
  exactKeys(
    record,
    ["user_id", "display_name", "project_role"],
    "project discussion participant"
  );
  return {
    userId: uuid(record.user_id, "project discussion participant.user_id"),
    displayName: boundedString(
      record.display_name, 200, "project discussion participant.display_name"
    ),
    projectRole: oneOf(
      record.project_role,
      ["administrator", "owner", "editor", "reviewer", "viewer"],
      "project discussion participant.project_role"
    )
  };
}

export function parseProjectDiscussionMention(value) {
  const record = object(value, "project discussion mention");
  exactKeys(record, ["user_id", "display_name"], "project discussion mention");
  return {
    userId: uuid(record.user_id, "project discussion mention.user_id"),
    displayName: boundedString(
      record.display_name, 200, "project discussion mention.display_name"
    )
  };
}

export function parseProjectDiscussionNotification(value) {
  const record = object(value, "project discussion notification");
  exactKeys(record, [
    "id", "project_id", "discussion_id", "discussion_title", "discussion_version",
    "comment_id", "kind", "actor_user_id", "actor_name", "version_number",
    "read_at", "created_at"
  ], "project discussion notification");
  return {
    id: uuid(record.id, "project discussion notification.id"),
    projectId: uuid(record.project_id, "project discussion notification.project_id"),
    discussionId: uuid(
      record.discussion_id, "project discussion notification.discussion_id"
    ),
    discussionTitle: boundedString(
      record.discussion_title, 200, "project discussion notification.discussion_title"
    ),
    discussionVersion: positiveInteger(
      record.discussion_version, "project discussion notification.discussion_version"
    ),
    commentId: nullableUuid(
      record.comment_id, "project discussion notification.comment_id"
    ),
    kind: oneOf(
      record.kind,
      ["assignment", "mention", "reply", "state"],
      "project discussion notification.kind"
    ),
    actorUserId: uuid(
      record.actor_user_id, "project discussion notification.actor_user_id"
    ),
    actorName: boundedString(
      record.actor_name, 200, "project discussion notification.actor_name"
    ),
    versionNumber: positiveInteger(
      record.version_number, "project discussion notification.version_number"
    ),
    readAt: nullableTimestamp(record.read_at, "project discussion notification.read_at"),
    createdAt: timestamp(record.created_at, "project discussion notification.created_at")
  };
}

export function parseDiscussionCreationReceipt(value) {
  const record = object(value, "discussion creation receipt");
  exactKeys(record, ["created", "discussion"], "discussion creation receipt");
  return {
    created: boolean(record.created, "discussion creation receipt.created"),
    discussion: parseProjectDiscussion(record.discussion)
  };
}

export function parseDiscussionCommentReceipt(value) {
  const record = object(value, "discussion comment receipt");
  exactKeys(record, ["created", "comment"], "discussion comment receipt");
  return {
    created: boolean(record.created, "discussion comment receipt.created"),
    comment: parseProjectDiscussionComment(record.comment)
  };
}

export function parseDiscussionModerationReceipt(value) {
  const receipt = parseDiscussionCommentReceipt(value);
  if (receipt.comment.moderation === null) {
    contract("discussion moderation receipt did not contain moderation evidence");
  }
  return receipt;
}

export function parseDiscussionTransitionReceipt(value) {
  const record = object(value, "discussion transition receipt");
  exactKeys(record, ["changed", "discussion"], "discussion transition receipt");
  return {
    changed: boolean(record.changed, "discussion transition receipt.changed"),
    discussion: parseProjectDiscussion(record.discussion)
  };
}

export function parseDiscussionAssignmentReceipt(value) {
  return parseDiscussionTransitionReceipt(value);
}

export function parseNotificationReadReceipt(value) {
  const record = object(value, "discussion notification read receipt");
  exactKeys(record, ["changed", "notification"], "discussion notification read receipt");
  return {
    changed: boolean(record.changed, "discussion notification read receipt.changed"),
    notification: parseProjectDiscussionNotification(record.notification)
  };
}

export function parseDiscussionSubscriptionReceipt(value) {
  const record = object(value, "discussion subscription receipt");
  exactKeys(record, ["changed", "subscription"], "discussion subscription receipt");
  const changed = boolean(record.changed, "discussion subscription receipt.changed");
  const subscription = record.subscription === null
    ? null
    : parseProjectDiscussionSubscription(record.subscription);
  if (changed && subscription === null) {
    contract("changed discussion subscription receipt is missing its current state");
  }
  return {
    changed,
    subscription
  };
}

export function parseResourceRatingSummary(value) {
  const record = object(value, "resource rating summary");
  exactKeys(record, [
    "project_id", "resource_id", "rating_count", "rating_average", "caller_score",
    "caller_version", "caller_withdrawn", "updated_at"
  ], "resource rating summary");
  const ratingCount = nonNegativeInteger(record.rating_count, "resource rating count");
  const ratingAverage = record.rating_average === null
    ? null
    : finiteNumber(record.rating_average, "resource rating average");
  const callerScore = record.caller_score === null
    ? null
    : integerBetween(record.caller_score, 1, 5, "resource rating caller score");
  const callerVersion = record.caller_version === null
    ? null
    : positiveInteger(record.caller_version, "resource rating caller version");
  const callerWithdrawn = boolean(record.caller_withdrawn, "resource rating caller withdrawn");
  if ((ratingCount === 0) !== (ratingAverage === null)
    || (ratingAverage !== null && (ratingAverage < 1 || ratingAverage > 5))
    || (callerVersion === null && (callerScore !== null || callerWithdrawn))
    || (callerWithdrawn && callerScore !== null)
    || (callerVersion !== null && callerScore === null && !callerWithdrawn)) {
    contract("resource rating summary is inconsistent");
  }
  return {
    projectId: uuid(record.project_id, "resource rating project id"),
    resourceId: uuid(record.resource_id, "resource rating resource id"),
    ratingCount,
    ratingAverage,
    callerScore,
    callerVersion,
    callerWithdrawn,
    updatedAt: nullableTimestamp(record.updated_at, "resource rating updated at")
  };
}

export function parseResourceRatingMutationReceipt(value) {
  const record = object(value, "resource rating mutation receipt");
  exactKeys(record, ["changed", "summary"], "resource rating mutation receipt");
  return {
    changed: boolean(record.changed, "resource rating mutation receipt.changed"),
    summary: parseResourceRatingSummary(record.summary)
  };
}

function discussionMentionIds(value) {
  if (!Array.isArray(value) || value.length > 20) {
    throw new TypeError("discussion mention ids are invalid");
  }
  const normalized = value.map((entry) => assertUuid(entry, "discussion mention user id"));
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError("discussion mention ids contain duplicates");
  }
  return normalized.sort();
}

export function parseUserDatasetConnection(value) {
  const record = object(value, "user dataset connection");
  if (Object.hasOwn(record, "secret_arn")
    || Object.hasOwn(record, "credentials")
    || Object.hasOwn(record, "secret_access_key")) {
    contract("user dataset connection contains forbidden secret material");
  }
  const configuredSecretFields = parseArray(
    record.configured_secret_fields,
    (field) => oneOf(
      field,
      ["external_id", "access_key_id", "secret_access_key", "session_token"],
      "user dataset connection.configured_secret_field"
    ),
    "user dataset connection.configured_secret_fields"
  );
  return {
    id: uuid(record.connection_id, "user dataset connection.connection_id"),
    ownerUserId: uuid(record.owner_user_id, "user dataset connection.owner_user_id"),
    provider: oneOf(record.provider, ["s3"], "user dataset connection.provider"),
    displayName: string(record.display_name, "user dataset connection.display_name"),
    bucketName: string(record.bucket_name, "user dataset connection.bucket_name"),
    regionName: string(record.region_name, "user dataset connection.region_name"),
    objectPrefix: typeof record.object_prefix === "string"
      ? record.object_prefix
      : contract("user dataset connection.object_prefix is invalid"),
    credentialMode: oneOf(
      record.credential_mode,
      ["workload_identity", "assume_role", "access_key"],
      "user dataset connection.credential_mode"
    ),
    roleArn: nullableString(record.role_arn, "user dataset connection.role_arn"),
    configuredSecretFields,
    credentialRevision: nonNegativeInteger(
      record.credential_revision,
      "user dataset connection.credential_revision"
    ),
    targetRevision: positiveInteger(
      record.target_revision,
      "user dataset connection.target_revision"
    ),
    credentialReady: boolean(
      record.credential_ready,
      "user dataset connection.credential_ready"
    ),
    status: oneOf(
      record.status,
      ["draft", "unverified", "verified", "error", "disabled"],
      "user dataset connection.status"
    ),
    lastVerifiedAt: optionalTimestamp(
      record.last_verified_at,
      "user dataset connection.last_verified_at"
    ),
    sanitizedErrorCode: record.sanitized_error_code === null
      ? null
      : machineCode(
          record.sanitized_error_code,
          "user dataset connection.sanitized_error_code"
        ),
    createdAt: timestamp(record.created_at, "user dataset connection.created_at"),
    updatedAt: timestamp(record.updated_at, "user dataset connection.updated_at"),
    ownedByCaller: boolean(
      record.owned_by_caller,
      "user dataset connection.owned_by_caller"
    ),
    verificationAvailable: boolean(
      record.verification_available,
      "user dataset connection.verification_available"
    ),
    repositoryBrowseAvailable: boolean(
      record.repository_browse_available,
      "user dataset connection.repository_browse_available"
    )
  };
}

export function parseDatasetRepositoryPage(value) {
  const record = object(value, "dataset repository page");
  for (const forbidden of ["bucket_name", "role_arn", "secret_arn", "credentials"]) {
    if (Object.hasOwn(record, forbidden)) {
      contract("dataset repository page contains forbidden connection material");
    }
  }
  const prefix = repositoryRelativePath(record.prefix, "dataset repository page.prefix", true);
  if (prefix && !prefix.endsWith("/")) {
    contract("dataset repository page.prefix is invalid");
  }
  const parentPrefix = record.parent_prefix === null
    ? null
    : repositoryRelativePath(
        record.parent_prefix,
        "dataset repository page.parent_prefix",
        true
      );
  if (parentPrefix !== repositoryParentPrefix(prefix)) {
    contract("dataset repository page.parent_prefix is invalid");
  }
  const seenPaths = new Set();
  const entries = parseArray(record.entries, (value) => {
    const entry = object(value, "dataset repository entry");
    const kind = oneOf(entry.kind, ["prefix", "object"], "dataset repository entry.kind");
    const relativePath = repositoryRelativePath(
      entry.relative_path,
      "dataset repository entry.relative_path",
      false
    );
    const name = string(entry.name, "dataset repository entry.name");
    if (
      !name
      || name.length > 1024
      || /[\\/\u0000-\u001f\u007f]/.test(name)
      || (kind === "prefix" && !relativePath.endsWith("/"))
      || (kind === "object" && relativePath.endsWith("/"))
      || !relativePath.startsWith(prefix)
      || relativePath === prefix
      || repositoryEntryName(relativePath) !== name
      || seenPaths.has(relativePath)
      || (kind === "prefix" && entry.size_bytes !== null)
    ) {
      contract("dataset repository entry identity is invalid");
    }
    seenPaths.add(relativePath);
    return {
      kind,
      relativePath,
      name,
      sizeBytes: nullableNonNegativeInteger(
        entry.size_bytes,
        "dataset repository entry.size_bytes"
      ),
      lastModified: optionalTimestamp(
        entry.last_modified,
        "dataset repository entry.last_modified"
      ),
      storageClass: nullableBoundedString(
        entry.storage_class,
        64,
        "dataset repository entry.storage_class"
      ),
      versionId: nullableBoundedString(
        entry.version_id,
        1024,
        "dataset repository entry.version_id"
      )
    };
  }, "dataset repository page.entries");
  if (entries.length > 100) contract("dataset repository page contains too many entries");
  const truncated = boolean(record.truncated, "dataset repository page.truncated");
  const nextCursor = nullableBoundedString(
    record.next_cursor,
    512,
    "dataset repository page.next_cursor"
  );
  if (
    truncated !== (nextCursor !== null)
    || (nextCursor !== null && !/^[A-Za-z0-9_-]+$/.test(nextCursor))
  ) {
    contract("dataset repository page pagination is invalid");
  }
  return {
    connectionId: uuid(record.connection_id, "dataset repository page.connection_id"),
    prefix,
    parentPrefix,
    entries,
    truncated,
    nextCursor
  };
}

export function parseDatasetRepositoryObject(value) {
  const record = object(value, "dataset repository object");
  for (const forbidden of ["bucket_name", "role_arn", "secret_arn", "credentials"]) {
    if (Object.hasOwn(record, forbidden)) {
      contract("dataset repository object contains forbidden connection material");
    }
  }
  const relativePath = repositoryRelativePath(
    record.relative_path,
    "dataset repository object.relative_path",
    false
  );
  const name = string(record.name, "dataset repository object.name");
  if (
    relativePath.endsWith("/")
    || !name
    || name.length > 1024
    || /[\\/\u0000-\u001f\u007f]/.test(name)
    || repositoryEntryName(relativePath) !== name
  ) {
    contract("dataset repository object identity is invalid");
  }
  const sizeBytes = nonNegativeInteger(
    record.size_bytes,
    "dataset repository object.size_bytes"
  );
  if (sizeBytes > 5_368_709_120_000) {
    contract("dataset repository object.size_bytes is too large");
  }
  const lastModified = timestamp(
    record.last_modified,
    "dataset repository object.last_modified"
  );
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(lastModified)) {
    contract("dataset repository object.last_modified must include a timezone");
  }
  const contentType = nullableBoundedString(
    record.content_type,
    256,
    "dataset repository object.content_type"
  );
  const etag = boundedString(record.etag, 1024, "dataset repository object.etag");
  const storageClass = nullableBoundedString(
    record.storage_class,
    64,
    "dataset repository object.storage_class"
  );
  const versionId = nullableBoundedString(
    record.version_id,
    1024,
    "dataset repository object.version_id"
  );
  if ([contentType, etag, storageClass, versionId]
    .some((item) => item !== null && /[\u0000-\u001f\u007f]/.test(item))) {
    contract("dataset repository object metadata contains control characters");
  }
  const checksumSha256 = nullableBoundedString(
    record.checksum_sha256,
    44,
    "dataset repository object.checksum_sha256"
  );
  if (
    checksumSha256 !== null
    && !/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(checksumSha256)
  ) {
    contract("dataset repository object checksum is invalid");
  }
  return {
    connectionId: uuid(record.connection_id, "dataset repository object.connection_id"),
    relativePath,
    name,
    sizeBytes,
    lastModified,
    contentType,
    etag,
    storageClass,
    versionId,
    checksumSha256
  };
}

export function parseDatasetRepositoryObjectVersionsPage(value) {
  const record = object(value, "dataset repository object versions page");
  for (const forbidden of ["bucket_name", "role_arn", "secret_arn", "credentials"]) {
    if (Object.hasOwn(record, forbidden)) {
      contract("dataset repository versions contain forbidden connection material");
    }
  }
  const relativePath = repositoryRelativePath(
    record.relative_path,
    "dataset repository object versions page.relative_path",
    false
  );
  if (relativePath.endsWith("/")) {
    contract("dataset repository object versions page path is invalid");
  }
  const seen = new Set();
  let latestCount = 0;
  const entries = parseArray(record.entries, (value) => {
    const entry = object(value, "dataset repository object version");
    const versionId = boundedString(
      entry.version_id,
      1024,
      "dataset repository object version.version_id"
    );
    const isLatest = boolean(
      entry.is_latest,
      "dataset repository object version.is_latest"
    );
    const isDeleteMarker = boolean(
      entry.is_delete_marker,
      "dataset repository object version.is_delete_marker"
    );
    const lastModified = timestamp(
      entry.last_modified,
      "dataset repository object version.last_modified"
    );
    const sizeBytes = nullableNonNegativeInteger(
      entry.size_bytes,
      "dataset repository object version.size_bytes"
    );
    const etag = nullableBoundedString(
      entry.etag,
      1024,
      "dataset repository object version.etag"
    );
    const storageClass = nullableBoundedString(
      entry.storage_class,
      64,
      "dataset repository object version.storage_class"
    );
    if (
      /[\u0000-\u001f\u007f]/.test(versionId)
      || new TextEncoder().encode(versionId).byteLength > 1024
      || seen.has(versionId)
      || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(lastModified)
      || (sizeBytes !== null && sizeBytes > 5_368_709_120_000)
      || [etag, storageClass]
        .some((item) => item !== null && /[\u0000-\u001f\u007f]/.test(item))
      || (isDeleteMarker && [sizeBytes, etag, storageClass].some((item) => item !== null))
      || (!isDeleteMarker && (sizeBytes === null || etag === null))
    ) {
      contract("dataset repository object version is invalid");
    }
    seen.add(versionId);
    latestCount += Number(isLatest);
    return {
      versionId,
      isLatest,
      isDeleteMarker,
      lastModified,
      sizeBytes,
      etag,
      storageClass
    };
  }, "dataset repository object versions page.entries");
  if (entries.length > 100 || latestCount > 1) {
    contract("dataset repository object versions page is invalid");
  }
  const truncated = boolean(
    record.truncated,
    "dataset repository object versions page.truncated"
  );
  const nextCursor = nullableBoundedString(
    record.next_cursor,
    1536,
    "dataset repository object versions page.next_cursor"
  );
  if (
    truncated !== (nextCursor !== null)
    || (nextCursor !== null && !/^[A-Za-z0-9_-]+$/.test(nextCursor))
  ) {
    contract("dataset repository object versions pagination is invalid");
  }
  return {
    connectionId: uuid(
      record.connection_id,
      "dataset repository object versions page.connection_id"
    ),
    relativePath,
    entries,
    truncated,
    nextCursor
  };
}

export function parseRepositoryObjectSource(value) {
  const record = object(value, "repository object source");
  for (const forbidden of ["role_arn", "secret_arn", "credentials", "external_id"]) {
    if (Object.hasOwn(record, forbidden)) {
      contract("repository object source contains forbidden connection material");
    }
  }
  const bucketName = boundedString(
    record.bucket_name,
    63,
    "repository object source.bucket_name"
  );
  const regionName = boundedString(
    record.region_name,
    32,
    "repository object source.region_name"
  );
  const objectPrefix = repositoryRelativePath(
    record.object_prefix,
    "repository object source.object_prefix",
    true
  );
  const relativePath = repositoryRelativePath(
    record.relative_path,
    "repository object source.relative_path",
    false
  );
  const providerVersionId = boundedString(
    record.provider_version_id,
    1024,
    "repository object source.provider_version_id"
  );
  const sizeBytes = nonNegativeInteger(
    record.size_bytes,
    "repository object source.size_bytes"
  );
  const lastModified = timestamp(
    record.last_modified,
    "repository object source.last_modified"
  );
  const contentType = nullableBoundedString(
    record.content_type,
    255,
    "repository object source.content_type"
  );
  const etag = boundedString(record.etag, 1024, "repository object source.etag");
  const storageClass = nullableBoundedString(
    record.storage_class,
    100,
    "repository object source.storage_class"
  );
  const checksumSha256 = nullableBoundedString(
    record.provider_checksum_sha256,
    44,
    "repository object source.provider_checksum_sha256"
  );
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucketName)
    || !/^[a-z]{2}(?:-gov)?-[a-z0-9-]+-[0-9]+$/.test(regionName)
    || relativePath.endsWith("/")
    || providerVersionId === "null"
    || /[\u0000-\u001f\u007f]/.test(providerVersionId)
    || new TextEncoder().encode(providerVersionId).byteLength > 1024
    || sizeBytes < 1
    || sizeBytes > 5_497_558_138_880
    || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(lastModified)
    || [contentType, etag, storageClass]
      .some((item) => item !== null && /[\u0000-\u001f\u007f]/.test(item))
    || (checksumSha256 !== null && !/^[A-Za-z0-9+/]{43}=$/.test(checksumSha256))
  ) {
    contract("repository object source metadata is invalid");
  }
  return {
    datasetId: uuid(record.dataset_id, "repository object source.dataset_id"),
    connectionId: uuid(record.connection_id, "repository object source.connection_id"),
    connectionTargetRevision: positiveInteger(
      record.connection_target_revision,
      "repository object source.connection_target_revision"
    ),
    provider: oneOf(record.provider, ["s3"], "repository object source.provider"),
    bucketName,
    regionName,
    objectPrefix,
    relativePath,
    providerVersionId,
    sizeBytes,
    lastModified,
    contentType,
    etag,
    storageClass,
    providerChecksumSha256: checksumSha256,
    createdBy: uuid(record.created_by, "repository object source.created_by"),
    createdAt: timestamp(record.created_at, "repository object source.created_at")
  };
}

export function parseRepositoryObjectRegistration(value) {
  const record = object(value, "repository object registration");
  const source = parseRepositoryObjectSource(record.source);
  const datasetId = uuid(record.dataset_id, "repository object registration.dataset_id");
  if (source.datasetId !== datasetId) {
    contract("repository object registration source belongs to another dataset");
  }
  return {
    datasetId,
    projectId: uuid(record.project_id, "repository object registration.project_id"),
    name: boundedString(record.name, 200, "repository object registration.name"),
    classification: oneOf(
      record.classification,
      ["public", "internal", "confidential", "restricted"],
      "repository object registration.classification"
    ),
    format: oneOf(
      record.format,
      ["geojson", "csv", "shapefile", "geopackage", "geoparquet", "cog", "pmtiles", "png", "jpeg", "pdf", "odt"],
      "repository object registration.format"
    ),
    created: boolean(record.created, "repository object registration.created"),
    attached: boolean(record.attached, "repository object registration.attached"),
    source
  };
}

function repositoryRelativePath(value, label, emptyAllowed) {
  if (
    typeof value !== "string"
    || value.length > 1024
    || (!emptyAllowed && value.length === 0)
    || value.startsWith("/")
    || /[\\\u0000-\u001f\u007f]/.test(value)
    || value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    contract(`${label} is invalid`);
  }
  return value;
}

function repositoryParentPrefix(prefix) {
  if (!prefix) return null;
  const parentEnd = prefix.slice(0, -1).lastIndexOf("/");
  return parentEnd < 0 ? "" : prefix.slice(0, parentEnd + 1);
}

function repositoryEntryName(relativePath) {
  const withoutTrailingSlash = relativePath.endsWith("/")
    ? relativePath.slice(0, -1)
    : relativePath;
  return withoutTrailingSlash.slice(withoutTrailingSlash.lastIndexOf("/") + 1);
}

export function parseUserDatasetConnectionVerification(value) {
  const record = object(value, "user dataset connection verification");
  if (
    Object.hasOwn(record, "secret_arn")
    || Object.hasOwn(record, "object_key")
    || Object.hasOwn(record, "credentials")
  ) {
    contract("user dataset connection verification contains forbidden material");
  }
  return {
    id: uuid(record.verification_id, "user dataset verification.verification_id"),
    connectionId: uuid(record.connection_id, "user dataset verification.connection_id"),
    targetRevision: positiveInteger(
      record.target_revision,
      "user dataset verification.target_revision"
    ),
    credentialRevision: nonNegativeInteger(
      record.credential_revision,
      "user dataset verification.credential_revision"
    ),
    state: oneOf(
      record.state,
      ["queued", "running", "succeeded", "failed", "cancelled"],
      "user dataset verification.state"
    ),
    attemptCount: nonNegativeInteger(
      record.attempt_count,
      "user dataset verification.attempt_count"
    ),
    bucketAccessConfirmed: boolean(
      record.bucket_access_confirmed,
      "user dataset verification.bucket_access_confirmed"
    ),
    objectAccessConfirmed: boolean(
      record.object_access_confirmed,
      "user dataset verification.object_access_confirmed"
    ),
    denyCanariesConfirmed: boolean(
      record.deny_canaries_confirmed,
      "user dataset verification.deny_canaries_confirmed"
    ),
    objectsObserved: nonNegativeInteger(
      record.objects_observed,
      "user dataset verification.objects_observed"
    ),
    sanitizedErrorCode: record.sanitized_error_code === null
      ? null
      : machineCode(
          record.sanitized_error_code,
          "user dataset verification.sanitized_error_code"
        ),
    durationMs: record.duration_ms === null
      ? null
      : nonNegativeInteger(record.duration_ms, "user dataset verification.duration_ms"),
    requestedBy: uuid(record.requested_by, "user dataset verification.requested_by"),
    createdAt: timestamp(record.created_at, "user dataset verification.created_at"),
    startedAt: optionalTimestamp(record.started_at, "user dataset verification.started_at"),
    finishedAt: optionalTimestamp(record.finished_at, "user dataset verification.finished_at")
  };
}

export function parseUserDatasetConnectionVerificationSubmission(value) {
  const record = object(value, "user dataset connection verification submission");
  return {
    verification: parseUserDatasetConnectionVerification(record.verification),
    created: boolean(record.created, "user dataset verification submission.created")
  };
}

export function parseUserDatasetConnectionOverview(value) {
  const record = object(value, "user dataset connection overview");
  for (const forbidden of ["bucket_name", "role_arn", "secret_arn", "credentials"]) {
    if (Object.hasOwn(record, forbidden)) {
      contract("user dataset connection overview contains forbidden authority material");
    }
  }
  const connectionId = uuid(
    record.connection_id,
    "user dataset connection overview.connection_id"
  );
  const targetRevision = positiveInteger(
    record.target_revision,
    "user dataset connection overview.target_revision"
  );
  const credentialRevision = nonNegativeInteger(
    record.credential_revision,
    "user dataset connection overview.credential_revision"
  );
  const health = oneOf(
    record.health,
    [
      "healthy",
      "checking",
      "needs_verification",
      "check_failed",
      "needs_credentials",
      "disabled"
    ],
    "user dataset connection overview.health"
  );
  const latestVerification = record.latest_verification === null
    ? null
    : parseUserDatasetConnectionVerification(record.latest_verification);
  if (latestVerification !== null && latestVerification.connectionId !== connectionId) {
    contract("user dataset connection overview verification identity is invalid");
  }
  const projectIds = new Set();
  const bindingIds = new Set();
  const projectReferences = parseArray(record.project_references, (value) => {
    const reference = object(value, "user dataset connection project reference");
    const bindingId = uuid(
      reference.binding_id,
      "user dataset connection project reference.binding_id"
    );
    const projectId = uuid(
      reference.project_id,
      "user dataset connection project reference.project_id"
    );
    if (bindingIds.has(bindingId) || projectIds.has(projectId)) {
      contract("user dataset connection overview contains duplicate project references");
    }
    bindingIds.add(bindingId);
    projectIds.add(projectId);
    return {
      id: bindingId,
      projectId,
      projectName: boundedString(
        reference.project_name,
        200,
        "user dataset connection project reference.project_name"
      ),
      projectStatus: oneOf(
        reference.project_status,
        ["active", "archived"],
        "user dataset connection project reference.project_status"
      ),
      displayName: boundedString(
        reference.display_name,
        200,
        "user dataset connection project reference.display_name"
      ),
      createdAt: timestamp(
        reference.created_at,
        "user dataset connection project reference.created_at"
      )
    };
  }, "user dataset connection overview.project_references");
  if (projectReferences.length > 250) {
    contract("user dataset connection overview contains too many project references");
  }
  const currentVerification = latestVerification !== null
    && latestVerification.targetRevision === targetRevision
    && latestVerification.credentialRevision === credentialRevision;
  if (
    (health === "checking"
      && (!currentVerification || !["queued", "running"].includes(latestVerification.state)))
    || (health === "healthy"
      && (!currentVerification
        || latestVerification.state !== "succeeded"
        || !latestVerification.bucketAccessConfirmed
        || !latestVerification.objectAccessConfirmed
        || !latestVerification.denyCanariesConfirmed))
  ) {
    contract("user dataset connection overview health is inconsistent");
  }
  return {
    connectionId,
    targetRevision,
    credentialRevision,
    health,
    latestVerification,
    projectReferences
  };
}

export function parseProjectDatasetConnectionBinding(value) {
  const record = object(value, "project dataset connection binding");
  return {
    id: uuid(record.binding_id, "project dataset connection binding.binding_id"),
    projectId: uuid(record.project_id, "project dataset connection binding.project_id"),
    displayName: string(
      record.display_name,
      "project dataset connection binding.display_name"
    ),
    createdBy: uuid(record.created_by, "project dataset connection binding.created_by"),
    createdAt: timestamp(record.created_at, "project dataset connection binding.created_at"),
    connection: parseUserDatasetConnection(record.connection)
  };
}

export function parseUserBasemapConnection(value) {
  const record = object(value, "user basemap connection");
  for (const forbidden of ["secret_arn", "api_key", "browser_key", "credentials"]) {
    if (Object.hasOwn(record, forbidden)) {
      contract("user basemap connection contains forbidden browser-key material");
    }
  }
  const allowedOrigins = parseArray(
    record.allowed_origins,
    (origin) => {
      const parsed = new URL(string(origin, "user basemap connection.allowed_origin"));
      if (!["http:", "https:"].includes(parsed.protocol)
        || parsed.username || parsed.password
        || !parsed.hostname || parsed.pathname !== "/"
        || parsed.search || parsed.hash) {
        contract("user basemap connection.allowed_origin is invalid");
      }
      return parsed.origin;
    },
    "user basemap connection.allowed_origins"
  );
  if (allowedOrigins.length < 1 || allowedOrigins.length > 16
    || new Set(allowedOrigins.map((origin) => origin.toLowerCase())).size !== allowedOrigins.length) {
    contract("user basemap connection.allowed_origins is invalid");
  }
  const configuredSecretFields = parseArray(
    record.configured_secret_fields,
    (field) => oneOf(field, ["api_key"], "user basemap connection.configured_secret_field"),
    "user basemap connection.configured_secret_fields"
  );
  return {
    id: uuid(record.connection_id, "user basemap connection.connection_id"),
    ownerUserId: uuid(record.owner_user_id, "user basemap connection.owner_user_id"),
    provider: oneOf(record.provider, ["protomaps", "carto"], "user basemap connection.provider"),
    displayName: string(record.display_name, "user basemap connection.display_name"),
    allowedOrigins,
    configuredSecretFields,
    credentialRevision: nonNegativeInteger(
      record.credential_revision,
      "user basemap connection.credential_revision"
    ),
    credentialReady: boolean(
      record.credential_ready,
      "user basemap connection.credential_ready"
    ),
    status: oneOf(
      record.status,
      ["draft", "configured", "disabled"],
      "user basemap connection.status"
    ),
    browserKeyExposure: oneOf(
      record.browser_key_exposure,
      ["client_visible"],
      "user basemap connection.browser_key_exposure"
    ),
    createdAt: timestamp(record.created_at, "user basemap connection.created_at"),
    updatedAt: timestamp(record.updated_at, "user basemap connection.updated_at"),
    ownedByCaller: boolean(
      record.owned_by_caller,
      "user basemap connection.owned_by_caller"
    )
  };
}

export function parseProjectBasemapConnectionBinding(value) {
  const record = object(value, "project basemap connection binding");
  return {
    id: uuid(record.binding_id, "project basemap connection binding.binding_id"),
    projectId: uuid(record.project_id, "project basemap connection binding.project_id"),
    displayName: string(
      record.display_name,
      "project basemap connection binding.display_name"
    ),
    createdBy: uuid(record.created_by, "project basemap connection binding.created_by"),
    createdAt: timestamp(record.created_at, "project basemap connection binding.created_at"),
    connection: parseUserBasemapConnection(record.connection)
  };
}

export function parseResolvedBasemapStyle(value) {
  const record = object(value, "resolved basemap style");
  for (const forbidden of ["secret_arn", "api_key", "browser_key", "credentials"]) {
    if (Object.hasOwn(record, forbidden)) {
      contract("resolved basemap style contains an unscoped browser key");
    }
  }
  const provider = oneOf(record.provider, ["protomaps", "carto"], "resolved basemap style.provider");
  const flavor = oneOf(
    record.flavor,
    ["light", "dark", "white", "grayscale", "black", "voyager", "positron", "dark-matter"],
    "resolved basemap style.flavor"
  );
  const resourceKind = oneOf(
    record.resource_kind,
    ["maplibre-style", "raster"],
    "resolved basemap style.resource_kind"
  );
  const resourceUrl = string(record.resource_url, "resolved basemap style.resource_url");
  const parsed = new URL(resourceUrl);
  const keys = [...parsed.searchParams.keys()];
  const commonSafe = parsed.protocol === "https:"
    && !parsed.username && !parsed.password && !parsed.hash
    && keys.length === 1 && keys[0] === "key" && parsed.searchParams.get("key");
  const providerSafe = provider === "protomaps"
    ? resourceKind === "maplibre-style"
      && ["light", "dark", "white", "grayscale", "black"].includes(flavor)
      && parsed.hostname === "api.protomaps.com"
      && parsed.pathname === `/styles/v5/${flavor}/en.json`
    : resourceKind === "raster"
      && ["voyager", "positron", "dark-matter"].includes(flavor)
      && parsed.hostname === "basemaps.cartocdn.com"
      && ({
        voyager: "/rastertiles/voyager/{z}/{x}/{y}.png",
        positron: "/light_all/{z}/{x}/{y}.png",
        "dark-matter": "/dark_all/{z}/{x}/{y}.png"
      })[flavor] === decodeURIComponent(parsed.pathname);
  if (!commonSafe || !providerSafe) {
    contract(`resolved basemap resource is outside the ${provider} browser contract`);
  }
  return {
    bindingId: uuid(record.binding_id, "resolved basemap style.binding_id"),
    connectionId: uuid(record.connection_id, "resolved basemap style.connection_id"),
    provider,
    connectionName: string(record.connection_name, "resolved basemap style.connection_name"),
    flavor,
    resourceKind,
    resourceUrl,
    attribution: string(record.attribution, "resolved basemap style.attribution"),
    credentialRevision: positiveInteger(
      record.credential_revision,
      "resolved basemap style.credential_revision"
    ),
    browserKeyExposure: oneOf(
      record.browser_key_exposure,
      ["client_visible"],
      "resolved basemap style.browser_key_exposure"
    )
  };
}

export function parseRecentProject(value) {
  const record = object(value, "recent project");
  const project = parseProject(record);
  return {
    ...project,
    lastActivityAt: timestamp(record.last_activity_at, "recent project.last_activity_at"),
    lastEventType: machineCode(record.last_event_type, "recent project.last_event_type")
  };
}

export function parseMap(value) {
  const record = object(value, "map");
  if (!Number.isSafeInteger(record.version) || record.version < 1) contract("map.version is invalid");
  return {
    id: uuid(record.id, "map.id"),
    projectId: uuid(record.project_id, "map.project_id"),
    ownerUserId: nullableUuid(record.owner_user_id ?? null, "map.owner_user_id"),
    name: string(record.name, "map.name"),
    description: nullableString(record.description, "map.description"),
    status: oneOf(record.status, ["active", "archived"], "map.status"),
    definition: object(record.definition, "map.definition"),
    version: record.version,
    createdAt: timestamp(record.created_at, "map.created_at"),
    updatedAt: timestamp(record.updated_at, "map.updated_at")
  };
}

export function parseCompositionVersionSummary(value) {
  const record = object(value, "composition version");
  const definitionBytes = positiveInteger(record.definition_bytes, "composition version.definition_bytes");
  if (definitionBytes < 2 || definitionBytes > 524_288) contract("Project version definition is too large");
  const changeMessage = nullableString(record.change_message, "composition version.change_message");
  if (changeMessage !== null && [...changeMessage].length > 500) contract("Project change message is too long");
  return {version: positiveInteger(record.version, "composition version.version"), definitionBytes,
    changeMessage, createdBy: uuid(record.created_by, "composition version.created_by"),
    createdAt: timestamp(record.created_at, "composition version.created_at")};
}

export function parseDataset(value) {
  const record = object(value, "dataset");
  const currentVersionNumber = nullablePositiveInteger(
    record.current_version_number,
    "dataset.current_version_number"
  );
  const extent = record.extent === null
    ? null
    : parseArray(record.extent, (coordinate) => finiteNumber(coordinate, "dataset.extent"), "dataset.extent");
  if (extent !== null && extent.length !== 4) contract("dataset.extent is invalid");
  return {
    id: uuid(record.id, "dataset.id"),
    projectId: uuid(record.project_id, "dataset.project_id"),
    name: string(record.name, "dataset.name"),
    description: nullableString(record.description, "dataset.description"),
    classification: oneOf(record.classification, ["public", "internal", "confidential", "restricted"], "dataset.classification"),
    sourceType: oneOf(record.source_type, ["upload", "repository", "xyz", "wms", "pmtiles", "geojson", "arcgis", "wfs", "imageserver", "mapserver", "cog"], "dataset.source_type"),
    format: oneOf(record.format, ["geojson", "csv", "shapefile", "geopackage", "geoparquet", "cog", "pmtiles", "png", "jpeg", "pdf", "odt", "kml", "xyz", "wms", "arcgis", "wfs", "imageserver", "mapserver"], "dataset.format"),
    status: oneOf(record.status, ["draft", "processing", "active", "failed", "archived"], "dataset.status"),
    ownerUserId: uuid(record.owner_user_id, "dataset.owner_user_id"),
    currentVersionId: nullableUuid(record.current_version_id, "dataset.current_version_id"),
    currentVersionNumber,
    currentVersionState: record.current_version_state === null
      ? null
      : oneOf(record.current_version_state, ["queued", "processing", "active", "failed"], "dataset.current_version_state"),
    featureCount: nullableNonNegativeInteger(record.feature_count, "dataset.feature_count"),
    extent,
    spatialSearchAvailable: record.spatial_search_available == null ? null : boolean(record.spatial_search_available, "dataset.spatial_search_available"),
    preservationSummary: record.preservation_summary == null ? null : parsePreservationSummary(record.preservation_summary),
    sourceSpatialMetadata: record.source_spatial_metadata == null ? null : boundedObject(record.source_spatial_metadata, 65536, "dataset.source_spatial_metadata"),
    catalogMatchCount: record.catalog_match_count == null ? null : nonNegativeInteger(record.catalog_match_count, "dataset.catalog_match_count"),
    crs: nullableString(record.crs, "dataset.crs"),
    geometryType: nullableString(record.geometry_type, "dataset.geometry_type"),
    qualityResults: parseQualityResults(record.quality_results),
    processingJobState: record.processing_job_state === null
      ? null
      : oneOf(record.processing_job_state, ["queued", "running", "completed", "failed", "cancelled"], "dataset.processing_job_state"),
    processingErrorCode: record.processing_error_code === null
      ? null
      : machineCode(record.processing_error_code, "dataset.processing_error_code"),
    tags: parseArray(record.tags, (tag) => string(tag, "dataset.tag"), "dataset.tags"),
    createdAt: timestamp(record.created_at, "dataset.created_at"),
    updatedAt: timestamp(record.updated_at, "dataset.updated_at"),
    capabilities: parseDatasetCapabilities(record.capabilities)
  };
}

export function parsePreservationSummary(value) {
  const record = object(value, "dataset.preservation_summary");
  return {
    sourceVersion: nullablePositiveInteger(record.source_version, "preservation.source_version"),
    connectionValidation: nullableString(record.connection_validation, "preservation.connection_validation"),
    connectionRecordedAt: record.connection_recorded_at === null ? null : timestamp(record.connection_recorded_at, "preservation.connection_recorded_at"),
    mapArchives: nonNegativeInteger(record.map_archives, "preservation.map_archives"),
    dataPreserved: boolean(record.data_preserved, "preservation.data_preserved"),
    metadataPreserved: boolean(record.metadata_preserved, "preservation.metadata_preserved")
  };
}

function parseDatasetCapabilities(value) {
  const record = object(value, "dataset.capabilities");
  return {
    read: boolean(record.read, "dataset.capabilities.read"),
    edit: boolean(record.edit, "dataset.capabilities.edit"),
    download: boolean(record.download, "dataset.capabilities.download"),
    managePermissions: boolean(record.manage_permissions, "dataset.capabilities.manage_permissions")
  };
}

export function parseFeatureCollectionMetadata(value) {
  const record = object(value, "feature collection");
  const fields = parseFeatureFields(record.fields, "feature collection.fields");
  if (fields.length > 64) contract("feature collection.fields is too large");
  return {
    datasetId: uuid(record.dataset_id, "feature collection.dataset_id"),
    geometryType: featureGeometryType(record.geometry_type, "feature collection.geometry_type"),
    fields,
    generation: positiveInteger(record.generation, "feature collection.generation"),
    featureCount: nonNegativeInteger(record.feature_count, "feature collection.feature_count"),
    createdBy: uuid(record.created_by, "feature collection.created_by"),
    createdAt: timestamp(record.created_at, "feature collection.created_at"),
    updatedBy: uuid(record.updated_by, "feature collection.updated_by"),
    updatedAt: timestamp(record.updated_at, "feature collection.updated_at")
  };
}

export function parseFieldForm(value) {
  const record = boundedObject(value, 100_000, "field form");
  const fields = parseFeatureFields(record.fields, "field form fields");
  if (fields.length > 64) contract("field form fields are too large");
  return {
    id: uuid(record.id, "field form.id"),
    datasetId: uuid(record.dataset_id, "field form.dataset_id"),
    version: positiveInteger(record.version, "field form.version"),
    title: boundedString(record.title, 200, "field form.title"),
    instructions: nullableBoundedString(record.instructions, 4000, "field form.instructions"),
    collectionGeneration: positiveInteger(
      record.collection_generation,
      "field form.collection_generation"
    ),
    geometryType: featureGeometryType(record.geometry_type, "field form.geometry_type"),
    fields,
    createdBy: uuid(record.created_by, "field form.created_by"),
    createdAt: timestamp(record.created_at, "field form.created_at"),
    updatedBy: uuid(record.updated_by, "field form.updated_by"),
    updatedAt: timestamp(record.updated_at, "field form.updated_at")
  };
}

export function parseFieldSubmission(value) {
  const record = boundedObject(value, 400_000, "field submission");
  const id = uuid(record.id, "field submission.id");
  const operation = oneOf(
    record.operation, ["create", "update"], "field submission.operation"
  );
  const targetFeatureId = nullableUuid(
    record.target_feature_id, "field submission.target_feature_id"
  );
  const targetFeatureVersion = record.target_feature_version === null
    ? null
    : positiveInteger(
      record.target_feature_version, "field submission.target_feature_version"
    );
  if ((operation === "create" && (targetFeatureId || targetFeatureVersion))
    || (operation === "update"
      && (targetFeatureId === null || targetFeatureVersion === null))) {
    contract("field submission operation target is invalid");
  }
  const feature = boundedObject(record.feature, 330_000, "field submission.feature");
  const expectedFeatureId = operation === "create" ? id : targetFeatureId;
  if (feature.type !== "Feature"
    || uuid(feature.id, "field submission.feature.id") !== expectedFeatureId) {
    contract("field submission feature identity is invalid");
  }
  const geometry = boundedObject(feature.geometry, 262_144, "field submission.geometry");
  featureGeometryType(geometry.type, "field submission.geometry.type");
  const properties = boundedObject(
    feature.properties,
    32_768,
    "field submission.properties"
  );
  return {
    id,
    datasetId: uuid(record.dataset_id, "field submission.dataset_id"),
    formId: uuid(record.form_id, "field submission.form_id"),
    formVersion: positiveInteger(record.form_version, "field submission.form_version"),
    supersedesSubmissionId: nullableUuid(
      record.supersedes_submission_id,
      "field submission.supersedes_submission_id"
    ),
    operation,
    targetFeatureId,
    targetFeatureVersion,
    payloadSha256: sha256(record.payload_sha256, "field submission.payload_sha256"),
    feature: {
      type: "Feature",
      id: expectedFeatureId,
      geometry: structuredClone(geometry),
      properties: structuredClone(properties)
    },
    state: oneOf(
      record.state,
      ["submitted", "in_review", "changes_requested", "rejected", "accepted"],
      "field submission.state"
    ),
    reviewVersion: positiveInteger(record.review_version, "field submission.review_version"),
    submittedBy: uuid(record.submitted_by, "field submission.submitted_by"),
    submittedAt: timestamp(record.submitted_at, "field submission.submitted_at"),
    reviewedBy: nullableUuid(record.reviewed_by, "field submission.reviewed_by"),
    reviewedAt: nullableTimestamp(record.reviewed_at, "field submission.reviewed_at"),
    reviewMessage: nullableBoundedString(
      record.review_message,
      2000,
      "field submission.review_message"
    ),
    promotedFeatureId: nullableUuid(
      record.promoted_feature_id,
      "field submission.promoted_feature_id"
    )
  };
}

export function parseFieldSubmissionReceipt(value) {
  const record = boundedObject(value, 500_000, "field submission receipt");
  return {
    created: boolean(record.created, "field submission receipt.created"),
    submission: parseFieldSubmission(record.submission)
  };
}

export function parseGovernedFeature(value) {
  const record = boundedObject(value, 330_000, "governed feature");
  if (record.type !== "Feature") contract("governed feature.type is invalid");
  const bbox = parseArray(
    record.bbox,
    (coordinate) => finiteNumber(coordinate, "governed feature.bbox"),
    "governed feature.bbox"
  );
  if (bbox.length !== 4) contract("governed feature.bbox is invalid");
  const geometry = boundedObject(record.geometry, 262_144, "governed feature.geometry");
  featureGeometryType(geometry.type, "governed feature.geometry.type");
  const properties = boundedObject(record.properties, 32_768, "governed feature.properties");
  return {
    type: "Feature",
    id: uuid(record.id, "governed feature.id"),
    bbox,
    geometry: structuredClone(geometry),
    properties: structuredClone(properties),
    version: positiveInteger(record["opengeo:version"], "governed feature version"),
    collectionGeneration: record["opengeo:collectionGeneration"] === undefined
      ? null
      : positiveInteger(
        record["opengeo:collectionGeneration"],
        "governed feature collection generation"
      ),
    createdBy: uuid(record["opengeo:createdBy"], "governed feature createdBy"),
    createdAt: timestamp(record["opengeo:createdAt"], "governed feature createdAt"),
    updatedBy: uuid(record["opengeo:updatedBy"], "governed feature updatedBy"),
    updatedAt: timestamp(record["opengeo:updatedAt"], "governed feature updatedAt")
  };
}

export function parseFeatureLock(value) {
  const record = boundedObject(value, 10_000, "feature lock");
  const heldByCurrentUser = boolean(
    record.held_by_current_user,
    "feature lock.held_by_current_user"
  );
  const lockToken = nullableUuid(record.lock_token, "feature lock.lock_token");
  if (heldByCurrentUser !== (lockToken !== null)) {
    contract("feature lock token visibility is inconsistent");
  }
  const acquiredAt = timestamp(record.acquired_at, "feature lock.acquired_at");
  const expiresAt = timestamp(record.expires_at, "feature lock.expires_at");
  if (Date.parse(expiresAt) <= Date.parse(acquiredAt)) {
    contract("feature lock expiry is not after acquisition");
  }
  return {
    featureId: uuid(record.feature_id, "feature lock.feature_id"),
    featureVersion: positiveInteger(
      record.feature_version,
      "feature lock.feature_version"
    ),
    lockToken,
    heldByCurrentUser,
    acquiredAt,
    expiresAt
  };
}

export function parseFeaturePage(value) {
  const record = boundedObject(value, 2_000_000, "feature page");
  if (record.type !== "FeatureCollection") contract("feature page.type is invalid");
  const collection = parseFeatureCollectionMetadata(record["opengeo:collection"]);
  const features = parseArray(record.features, parseGovernedFeature, "feature page.features");
  if (features.length > 100) contract("feature page.features is too large");
  features.forEach((feature, index) => validateFeatureProperties(
    feature.properties,
    collection.fields,
    `feature page.features[${index}].properties`
  ));
  const numberMatched = nonNegativeInteger(record.numberMatched, "feature page.numberMatched");
  const numberReturned = nonNegativeInteger(
    record.numberReturned,
    "feature page.numberReturned"
  );
  if (numberReturned !== features.length || numberReturned > numberMatched) {
    contract("feature page counts are inconsistent");
  }
  return {
    features,
    numberMatched,
    numberReturned,
    collection,
    limit: positiveInteger(record["opengeo:limit"], "feature page limit"),
    offset: nonNegativeInteger(record["opengeo:offset"], "feature page offset")
  };
}

function validateFeatureProperties(properties, fields, label) {
  const expected = new Map(fields.map((field) => [field.name, field]));
  for (const name of Object.keys(properties)) {
    if (!expected.has(name)) contract(`${label} contains unknown field ${name}`);
  }
  const normalized = new Map();
  for (const field of fields) {
    const visible = featureFieldVisible(field.visibleWhen, normalized);
    const present = Object.hasOwn(properties, field.name);
    if (!visible) {
      if (present) contract(`${label}.${field.name} is hidden by its visibility rule`);
      continue;
    }
    if (field.calculation != null) {
      let computed;
      try { computed = evaluateCalculation(field.calculation, normalized); }
      catch (error) { contract(`${label}.${field.name}: ${error.message}`); }
      if ((properties[field.name] ?? null) !== computed) contract(`${label}.${field.name} differs from calculation`);
    }
    if (!present || properties[field.name] === null) {
      if (field.required) contract(`${label}.${field.name} is required`);
      if (present) normalized.set(field.name, null);
      continue;
    }
    const value = properties[field.name];
    if (field.attachment) assertUuid(value, `${label}.${field.name} attachment version`);
    if (field.type === "group") {
      if (field.repeat) {
        if (!Array.isArray(value)) contract(`${label}.${field.name} must be an array`);
        const minimum = Math.max(field.minItems ?? 0, field.required ? 1 : 0);
        const maximum = field.maxItems ?? 20;
        if (value.length < minimum || value.length > maximum) {
          contract(`${label}.${field.name} repeat count is invalid`);
        }
        value.forEach((entry, index) => {
          const record = object(entry, `${label}.${field.name}[${index}]`);
          validateFeatureProperties(record, field.fields, `${label}.${field.name}[${index}]`);
        });
      } else {
        const record = object(value, `${label}.${field.name}`);
        validateFeatureProperties(record, field.fields, `${label}.${field.name}`);
      }
      normalized.set(field.name, value);
      continue;
    }
    if (field.type === "string") {
      if (
        typeof value !== "string"
        || value.length < (field.minLength ?? 1)
        || value.length > (field.maxLength ?? 2_000)
        || (field.choices.length && !field.choices.includes(value))
      ) contract(`${label}.${field.name} string value is invalid`);
    } else if (field.type === "integer") {
      if (!Number.isSafeInteger(value)) contract(`${label}.${field.name} integer value is invalid`);
    } else if (field.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        contract(`${label}.${field.name} numeric value is invalid`);
      }
    } else if (typeof value !== "boolean") {
      contract(`${label}.${field.name} boolean value is invalid`);
    }
    if (
      ["integer", "number"].includes(field.type)
      && (
        (field.minimum !== null && value < field.minimum)
        || (field.maximum !== null && value > field.maximum)
      )
    ) contract(`${label}.${field.name} numeric bounds are invalid`);
    normalized.set(field.name, value);
  }
}

export function parseFeatureQueryPage(value) {
  const record = boundedObject(value, 2_100_000, "feature query page");
  const page = parseFeaturePage(record);
  const query = parseFeatureQueryReceipt(record["opengeo:query"]);
  const querySha256 = assertFeatureQuerySha256(record["opengeo:querySha256"]);
  const generation = positiveInteger(
    record["opengeo:collectionGeneration"],
    "feature query collection generation"
  );
  if (generation !== page.collection.generation) {
    contract("feature query generation is inconsistent");
  }
  if (query.expected_generation !== null && query.expected_generation !== generation) {
    contract("feature query expected generation is inconsistent");
  }
  if (query.limit !== page.limit || query.offset !== page.offset) {
    contract("feature query page parameters are inconsistent");
  }
  return {...page, query, querySha256, generation};
}

export function parseFeatureHistory(value) {
  const record = boundedObject(value, 2_000_000, "feature history");
  const revisions = parseArray(record.revisions, (value) => {
    const revision = boundedObject(value, 330_000, "feature revision");
    return {
      version: positiveInteger(revision.version, "feature revision.version"),
      operation: oneOf(
        revision.operation,
        ["create", "update", "delete", "restore"],
        "feature revision.operation"
      ),
      geometryType: featureGeometryType(
        revision.geometry_type,
        "feature revision.geometry_type"
      ),
      geometry: boundedObject(revision.geometry, 262_144, "feature revision.geometry"),
      properties: boundedObject(revision.properties, 32_768, "feature revision.properties"),
      changedBy: uuid(revision.changed_by, "feature revision.changed_by"),
      changeMessage: nullableBoundedString(
        revision.change_message,
        500,
        "feature revision.change_message"
      ),
      requestId: boundedString(revision.request_id, 128, "feature revision.request_id"),
      createdAt: timestamp(revision.created_at, "feature revision.created_at")
    };
  }, "feature history.revisions");
  if (revisions.length > 100) contract("feature history.revisions is too large");
  const numberReturned = nonNegativeInteger(
    record.number_returned,
    "feature history.number_returned"
  );
  if (numberReturned !== revisions.length) contract("feature history counts are inconsistent");
  return {
    featureId: uuid(record.feature_id, "feature history.feature_id"),
    revisions,
    numberReturned,
    limit: positiveInteger(record.limit, "feature history.limit"),
    offset: nonNegativeInteger(record.offset, "feature history.offset")
  };
}

export function parseFeatureTombstonePage(value) {
  const record = boundedObject(value, 100_000, "feature tombstone page");
  const tombstones = parseArray(record.tombstones, (value) => {
    const tombstone = object(value, "feature tombstone");
    const deletedAt = timestamp(tombstone.deleted_at, "feature tombstone.deleted_at");
    const updatedAt = timestamp(tombstone.updated_at, "feature tombstone.updated_at");
    if (Date.parse(updatedAt) < Date.parse(deletedAt)) {
      contract("feature tombstone update predates deletion");
    }
    return {
      featureId: uuid(tombstone.feature_id, "feature tombstone.feature_id"),
      deletedVersion: positiveInteger(
        tombstone.deleted_version,
        "feature tombstone.deleted_version"
      ),
      deletedBy: uuid(tombstone.deleted_by, "feature tombstone.deleted_by"),
      deletedAt,
      updatedAt
    };
  }, "feature tombstone page.tombstones");
  if (tombstones.length > 100) contract("feature tombstone page is too large");
  const numberMatched = nonNegativeInteger(
    record.number_matched,
    "feature tombstone page.number_matched"
  );
  const numberReturned = nonNegativeInteger(
    record.number_returned,
    "feature tombstone page.number_returned"
  );
  if (numberReturned !== tombstones.length || numberReturned > numberMatched) {
    contract("feature tombstone page counts are inconsistent");
  }
  return {
    tombstones,
    numberMatched,
    numberReturned,
    limit: positiveInteger(record.limit, "feature tombstone page.limit"),
    offset: nonNegativeInteger(record.offset, "feature tombstone page.offset")
  };
}

function parseFeatureDeletion(value) {
  const record = object(value, "feature deletion");
  return {
    featureId: uuid(record.feature_id, "feature deletion.feature_id"),
    deletedVersion: positiveInteger(record.deleted_version, "feature deletion.deleted_version"),
    collectionGeneration: positiveInteger(
      record.collection_generation,
      "feature deletion.collection_generation"
    )
  };
}

export function parseFeatureStructureMutation(value, expectedOperation) {
  const record = boundedObject(value, 6_000_000, "feature structure mutation");
  const operation = oneOf(
    record.operation,
    ["separate_parts", "merge_parts"],
    "feature structure mutation.operation"
  );
  if (operation !== expectedOperation) contract("feature structure mutation operation changed");
  const retainedFeature = parseGovernedFeature(record.retained_feature);
  const createdFeatures = parseArray(
    record.created_features,
    parseGovernedFeature,
    "feature structure mutation.created_features"
  );
  const deletedFeatures = parseArray(
    record.deleted_features,
    parseFeatureDeletion,
    "feature structure mutation.deleted_features"
  );
  const collectionGeneration = positiveInteger(
    record.collection_generation,
    "feature structure mutation.collection_generation"
  );
  const featureCount = nonNegativeInteger(
    record.feature_count,
    "feature structure mutation.feature_count"
  );
  if (retainedFeature.geometry.type !== "MultiPolygon"
    || createdFeatures.some((feature) => feature.geometry.type !== "MultiPolygon")) {
    contract("feature structure mutation contains a non-MultiPolygon feature");
  }
  const liveIds = [retainedFeature.id, ...createdFeatures.map(({id}) => id)];
  const deletedIds = deletedFeatures.map(({featureId}) => featureId);
  if (new Set([...liveIds, ...deletedIds]).size !== liveIds.length + deletedIds.length) {
    contract("feature structure mutation ids are not distinct");
  }
  if (deletedFeatures.some((item) => item.collectionGeneration !== collectionGeneration)) {
    contract("feature structure mutation deletion generation is inconsistent");
  }
  if (operation === "separate_parts") {
    if (!createdFeatures.length || createdFeatures.length > 255 || deletedFeatures.length) {
      contract("separate-parts mutation counts are invalid");
    }
  } else if (createdFeatures.length || !deletedFeatures.length || deletedFeatures.length > 19) {
    contract("merge-parts mutation counts are invalid");
  }
  return {
    operation,
    retainedFeature,
    createdFeatures,
    deletedFeatures,
    collectionGeneration,
    featureCount
  };
}

export function parseExternalSource(value) {
  const record = object(value, "external source");
  const sourceType = oneOf(
    record.source_type,
    ["xyz", "wms", "pmtiles", "geojson", "arcgis", "wfs", "imageserver", "mapserver", "cog"],
    "external source.source_type"
  );
  const sourceUrl = publicSourceUrl(record.source_url, sourceType);
  return {
    datasetId: uuid(record.dataset_id, "external source.dataset_id"),
    projectId: uuid(record.project_id, "external source.project_id"),
    name: string(record.name, "external source.name"),
    description: nullableString(record.description, "external source.description"),
    classification: oneOf(record.classification, ["public", "internal", "confidential", "restricted"], "external source.classification"),
    status: oneOf(record.status, ["draft", "processing", "active", "failed", "archived"], "external source.status"),
    ownerUserId: uuid(record.owner_user_id, "external source.owner_user_id"),
    sourceType,
    accessMode: oneOf(record.access_mode, ["direct_browser"], "external source.access_mode"),
    credentialMode: oneOf(record.credential_mode, ["none"], "external source.credential_mode"),
    versionNumber: positiveInteger(record.version_number, "external source.version_number"),
    sourceUrl,
    configuration: parseExternalSourceConfiguration(record.configuration, sourceType),
    verificationState: oneOf(record.verification_state, ["syntax_only"], "external source.verification_state"),
    createdAt: timestamp(record.created_at, "external source.created_at"),
    updatedAt: timestamp(record.updated_at, "external source.updated_at"),
    capabilities: parseSourceCapabilities(record.capabilities)
  };
}

export function parseExternalSourceRevision(value) {
  const record = object(value, "external source revision");
  const configuration = object(record.configuration, "external source revision.configuration");
  const sourceType = configuration.service_kind === "cog" ? "cog"
    : configuration.service_kind === "mapserver" ? "mapserver"
    : configuration.service_kind === "imageserver"
    ? "imageserver"
    : Object.hasOwn(configuration, "object_id_field")
    ? "arcgis"
    : Object.hasOwn(configuration, "type_name")
    ? "wfs"
    : Object.hasOwn(configuration, "object_sha256")
    ? "geojson"
    : Object.hasOwn(configuration, "tile_type")
    ? "pmtiles"
    : Object.hasOwn(configuration, "layers") ? "wms" : "xyz";
  return {
    datasetId: uuid(record.dataset_id, "external source revision.dataset_id"),
    versionNumber: positiveInteger(record.version_number, "external source revision.version_number"),
    sourceUrl: publicSourceUrl(record.source_url, sourceType),
    configuration: parseExternalSourceConfiguration(configuration, sourceType),
    verificationState: oneOf(record.verification_state, ["syntax_only"], "external source revision.verification_state"),
    changeMessage: nullableString(record.change_message, "external source revision.change_message"),
    createdBy: uuid(record.created_by, "external source revision.created_by"),
    createdAt: timestamp(record.created_at, "external source revision.created_at")
  };
}

export function parseSourceDiscoveryJob(value) {
  const record = object(value, "source discovery job");
  exactKeys(record, [
    "schema_version", "job_id", "project_id", "source_type", "kind", "service_url",
    "collection_ref", "request_checksum_sha256", "idempotency_key", "state", "result",
    "error_code", "attempt_count", "created_by", "created_at", "started_at", "finished_at",
    "cancellable"
  ], "source discovery job");
  if (record.schema_version !== "opengeo.external-source-discovery-job.1.0.0") {
    contract("source discovery job schema is unsupported");
  }
  const sourceType = oneOf(record.source_type, ["arcgis", "wfs"], "source discovery.source_type");
  const kind = oneOf(record.kind, ["catalog", "collection"], "source discovery.kind");
  const state = oneOf(
    record.state,
    ["queued", "running", "completed", "failed", "cancelled"],
    "source discovery.state"
  );
  const result = record.result === null
    ? null
    : parseSourceDiscoveryResult(record.result, sourceType, kind);
  if ((state === "completed") !== (result !== null)) {
    contract("source discovery result and state are inconsistent");
  }
  return {
    jobId: uuid(record.job_id, "source discovery.job_id"),
    projectId: uuid(record.project_id, "source discovery.project_id"),
    sourceType,
    kind,
    serviceUrl: sourceDiscoveryServiceUrl(record.service_url, sourceType),
    collectionRef: nullableBoundedString(
      record.collection_ref, 200, "source discovery.collection_ref"
    ),
    requestChecksumSha256: sha256(record.request_checksum_sha256, "source discovery checksum"),
    idempotencyKey: uuid(record.idempotency_key, "source discovery.idempotency_key"),
    state,
    result,
    errorCode: nullableBoundedString(record.error_code, 100, "source discovery.error_code"),
    attemptCount: nonNegativeInteger(record.attempt_count, "source discovery.attempt_count"),
    createdBy: uuid(record.created_by, "source discovery.created_by"),
    createdAt: timestamp(record.created_at, "source discovery.created_at"),
    startedAt: nullableTimestamp(record.started_at, "source discovery.started_at"),
    finishedAt: nullableTimestamp(record.finished_at, "source discovery.finished_at"),
    cancellable: boolean(record.cancellable, "source discovery.cancellable")
  };
}

function parseSourceDiscoveryResult(value, sourceType, kind) {
  const result = object(value, "source discovery result");
  exactKeys(result, [
    "schema_version", "source_type", "kind", "service_url", "collections",
    "source_definition", "limitations"
  ], "source discovery result");
  if (result.schema_version !== "opengeo.external-source-discovery-result.1.0.0"
    || result.source_type !== sourceType || result.kind !== kind) {
    contract("source discovery result identity is inconsistent");
  }
  if (!Array.isArray(result.collections)
    || result.collections.length < 1 || result.collections.length > 100) {
    contract("source discovery collections are invalid");
  }
  const collections = result.collections.map((value, index) => {
    const collection = object(value, `source discovery collection ${index}`);
    exactKeys(
      collection,
      ["ref", "name", "title", "geometry_type", "bounds"],
      `source discovery collection ${index}`
    );
    const bounds = collection.bounds === null
      ? null
      : orderedGeographicBounds(
          collection.bounds,
          `source discovery collection ${index}.bounds`,
          ApiContractError
        );
    return {
      ref: boundedString(collection.ref, 200, `source discovery collection ${index}.ref`),
      name: boundedString(collection.name, 200, `source discovery collection ${index}.name`),
      title: boundedString(collection.title, 500, `source discovery collection ${index}.title`),
      geometryType: collection.geometry_type === null
        ? null
        : oneOf(
            collection.geometry_type,
            ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"],
            `source discovery collection ${index}.geometry_type`
          ),
      bounds
    };
  });
  if (!Array.isArray(result.limitations)
    || result.limitations.length < 1 || result.limitations.length > 10) {
    contract("source discovery limitations are invalid");
  }
  const sourceDefinition = result.source_definition === null
    ? null
    : boundedObject(result.source_definition, 262_144, "source discovery source_definition");
  if ((kind === "catalog") !== (sourceDefinition === null)) {
    contract("source discovery definition and kind are inconsistent");
  }
  return {
    sourceType,
    kind,
    serviceUrl: sourceDiscoveryServiceUrl(result.service_url, sourceType),
    collections,
    sourceDefinition,
    limitations: result.limitations.map((item, index) => (
      boundedString(item, 500, `source discovery limitation ${index}`)
    ))
  };
}

export function parseExternalSourceCopyEstimate(value) {
  const record = object(value, "external source copy estimate");
  exactKeys(record, [
    "schema_version", "estimate_id", "project_id", "source_dataset_id",
    "source_revision_number", "source_type", "copy_method", "capture_scope",
    "output_format", "output_content_type", "maximum_requests",
    "maximum_output_bytes", "estimated_cost_usd", "estimate_checksum_sha256",
    "created_at", "expires_at"
  ], "external source copy estimate");
  if (record.schema_version !== "opengeo.external-source-copy-estimate.1.0.0") {
    contract("external source copy estimate schema is unsupported");
  }
  const sourceType = oneOf(
    record.source_type,
    ["wms", "pmtiles", "arcgis", "wfs"],
    "external source copy estimate.source_type"
  );
  const copyMethod = oneOf(
    record.copy_method,
    ["bounded_map_capture", "exact_object_copy", "bounded_feature_capture"],
    "external source copy estimate.copy_method"
  );
  const outputFormat = oneOf(
    record.output_format,
    ["png", "pmtiles", "geojson"],
    "external source copy estimate.output_format"
  );
  const outputContentType = oneOf(
    record.output_content_type,
    ["image/png", "application/vnd.pmtiles", "application/geo+json"],
    "external source copy estimate.output_content_type"
  );
  if (
    (sourceType === "wms" && (
      copyMethod !== "bounded_map_capture"
      || outputFormat !== "png"
      || outputContentType !== "image/png"
    ))
    || (sourceType === "pmtiles" && (
      copyMethod !== "exact_object_copy"
      || outputFormat !== "pmtiles"
      || outputContentType !== "application/vnd.pmtiles"
    ))
    || (["arcgis", "wfs"].includes(sourceType) && (
      copyMethod !== "bounded_feature_capture"
      || outputFormat !== "geojson"
      || outputContentType !== "application/geo+json"
    ))
  ) contract("external source copy estimate method and output are inconsistent");
  const createdAt = timestamp(record.created_at, "external source copy estimate.created_at");
  const expiresAt = timestamp(record.expires_at, "external source copy estimate.expires_at");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    contract("external source copy estimate expiry is invalid");
  }
  return {
    estimateId: uuid(record.estimate_id, "external source copy estimate.estimate_id"),
    projectId: uuid(record.project_id, "external source copy estimate.project_id"),
    sourceDatasetId: uuid(
      record.source_dataset_id, "external source copy estimate.source_dataset_id"
    ),
    sourceRevisionNumber: positiveInteger(
      record.source_revision_number,
      "external source copy estimate.source_revision_number"
    ),
    sourceType,
    copyMethod,
    captureScope: parseCopyScope(sourceType, record.capture_scope),
    outputFormat,
    outputContentType,
    maximumRequests: integerBetween(
      record.maximum_requests,
      1,
      ["arcgis", "wfs"].includes(sourceType) ? 64 : 1,
      "external source copy estimate.maximum_requests"
    ),
    maximumOutputBytes: integerBetween(
      record.maximum_output_bytes,
      1,
      2_147_483_648,
      "external source copy estimate.maximum_output_bytes"
    ),
    estimatedCostUsd: decimalBetween(
      record.estimated_cost_usd, 0, 100, "external source copy estimate.estimated_cost_usd"
    ),
    estimateChecksumSha256: sha256Checksum(
      record.estimate_checksum_sha256,
      "external source copy estimate.estimate_checksum_sha256"
    ),
    createdAt,
    expiresAt
  };
}

export function parseProtectedCopyJob(value) {
  const record = object(value, "protected copy job");
  exactKeys(record, [
    "schema_version", "job_id", "project_id", "estimate_id",
    "source_dataset_id", "source_revision_number", "destination_dataset_id",
    "destination_name", "destination_classification", "copy_method",
    "capture_scope", "output_format", "output_content_type", "maximum_requests",
    "maximum_output_bytes", "estimated_cost_usd", "estimate_checksum_sha256",
    "estimate_expires_at", "rights_basis", "attribution",
    "request_checksum_sha256", "idempotency_key", "state", "output_object_id",
    "output_dataset_version_id", "error_code", "attempt_count", "created_by",
    "created_at", "started_at", "finished_at", "cancellable"
  ], "protected copy job");
  if (record.schema_version !== "opengeo.protected-copy-job.1.0.0") {
    contract("protected copy job schema is unsupported");
  }
  const copyMethod = oneOf(
    record.copy_method,
    ["bounded_map_capture", "exact_object_copy", "bounded_feature_capture"],
    "protected copy job.copy_method"
  );
  const scopeType = copyMethod === "bounded_map_capture"
    ? "wms"
    : copyMethod === "exact_object_copy" ? "pmtiles" : "feature";
  const outputFormat = oneOf(
    record.output_format, ["png", "pmtiles", "geojson"], "protected copy job.output_format"
  );
  const outputContentType = oneOf(
    record.output_content_type,
    ["image/png", "application/vnd.pmtiles", "application/geo+json"],
    "protected copy job.output_content_type"
  );
  if ((scopeType === "wms" && (
    outputFormat !== "png" || outputContentType !== "image/png"
  )) || (scopeType === "pmtiles" && (
    outputFormat !== "pmtiles" || outputContentType !== "application/vnd.pmtiles"
  )) || (scopeType === "feature" && (
    outputFormat !== "geojson" || outputContentType !== "application/geo+json"
  ))) contract("protected copy job method and output are inconsistent");
  const state = processingState(record.state, "protected copy job.state");
  const outputObjectId = nullableUuid(record.output_object_id, "protected copy job.output_object_id");
  const outputDatasetVersionId = nullableUuid(
    record.output_dataset_version_id, "protected copy job.output_dataset_version_id"
  );
  const errorCode = nullableSafeErrorCode(record.error_code, "protected copy job.error_code");
  validateJobResultShape(
    state,
    outputObjectId !== null && outputDatasetVersionId !== null,
    errorCode,
    record.cancellable,
    "protected copy job"
  );
  return {
    jobId: uuid(record.job_id, "protected copy job.job_id"),
    projectId: uuid(record.project_id, "protected copy job.project_id"),
    estimateId: uuid(record.estimate_id, "protected copy job.estimate_id"),
    sourceDatasetId: uuid(record.source_dataset_id, "protected copy job.source_dataset_id"),
    sourceRevisionNumber: positiveInteger(
      record.source_revision_number, "protected copy job.source_revision_number"
    ),
    destinationDatasetId: uuid(
      record.destination_dataset_id, "protected copy job.destination_dataset_id"
    ),
    destinationName: boundedString(record.destination_name, 200, "protected copy job.destination_name"),
    destinationClassification: oneOf(
      record.destination_classification,
      ["public", "internal", "confidential", "restricted"],
      "protected copy job.destination_classification"
    ),
    copyMethod,
    captureScope: parseCopyScope(scopeType, record.capture_scope),
    outputFormat,
    outputContentType,
    maximumRequests: integerBetween(
      record.maximum_requests,
      1,
      scopeType === "feature" ? 64 : 1,
      "protected copy job.maximum_requests"
    ),
    maximumOutputBytes: integerBetween(record.maximum_output_bytes, 1, 2_147_483_648, "protected copy job.maximum_output_bytes"),
    estimatedCostUsd: decimalBetween(record.estimated_cost_usd, 0, 100, "protected copy job.estimated_cost_usd"),
    estimateChecksumSha256: sha256Checksum(record.estimate_checksum_sha256, "protected copy job.estimate_checksum_sha256"),
    estimateExpiresAt: timestamp(record.estimate_expires_at, "protected copy job.estimate_expires_at"),
    rightsBasis: boundedString(record.rights_basis, 500, "protected copy job.rights_basis"),
    attribution: boundedString(record.attribution, 1000, "protected copy job.attribution"),
    requestChecksumSha256: sha256Checksum(record.request_checksum_sha256, "protected copy job.request_checksum_sha256"),
    idempotencyKey: uuid(record.idempotency_key, "protected copy job.idempotency_key"),
    state,
    outputObjectId,
    outputDatasetVersionId,
    errorCode,
    attemptCount: integerBetween(record.attempt_count, 0, 3, "protected copy job.attempt_count"),
    createdBy: uuid(record.created_by, "protected copy job.created_by"),
    createdAt: timestamp(record.created_at, "protected copy job.created_at"),
    startedAt: nullableTimestamp(record.started_at, "protected copy job.started_at"),
    finishedAt: nullableTimestamp(record.finished_at, "protected copy job.finished_at"),
    cancellable: boolean(record.cancellable, "protected copy job.cancellable")
  };
}

export function parseRepositoryObjectCopyEstimate(value) {
  const record = object(value, "repository object copy estimate");
  exactKeys(record, [
    "schema_version", "estimate_id", "project_id", "source_dataset_id",
    "connection_target_revision", "provider_version_id", "copy_method",
    "output_format", "output_content_type", "maximum_requests",
    "maximum_output_bytes", "estimated_cost_usd", "estimate_checksum_sha256",
    "created_at", "expires_at"
  ], "repository object copy estimate");
  if (record.schema_version !== "opengeo.repository-object-copy-estimate.1.0.0"
    || record.copy_method !== "exact_object_copy") {
    contract("repository object copy estimate schema is unsupported");
  }
  const createdAt = timestamp(record.created_at, "repository copy estimate.created_at");
  const expiresAt = timestamp(record.expires_at, "repository copy estimate.expires_at");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    contract("repository object copy estimate expiry is invalid");
  }
  const providerVersionId = boundedString(
    record.provider_version_id, 1024, "repository copy estimate.provider_version_id"
  );
  if (providerVersionId === "null") {
    contract("repository object copy estimate requires an immutable provider version");
  }
  return {
    estimateId: uuid(record.estimate_id, "repository copy estimate.estimate_id"),
    projectId: uuid(record.project_id, "repository copy estimate.project_id"),
    sourceDatasetId: uuid(
      record.source_dataset_id, "repository copy estimate.source_dataset_id"
    ),
    connectionTargetRevision: positiveInteger(
      record.connection_target_revision,
      "repository copy estimate.connection_target_revision"
    ),
    providerVersionId,
    copyMethod: "exact_object_copy",
    outputFormat: repositoryCopyFormat(
      record.output_format, "repository copy estimate.output_format"
    ),
    outputContentType: boundedString(
      record.output_content_type, 200, "repository copy estimate.output_content_type"
    ),
    maximumRequests: integerBetween(
      record.maximum_requests, 1, 1, "repository copy estimate.maximum_requests"
    ),
    maximumOutputBytes: integerBetween(
      record.maximum_output_bytes, 1, 536_870_912,
      "repository copy estimate.maximum_output_bytes"
    ),
    estimatedCostUsd: decimalBetween(
      record.estimated_cost_usd, 0, 100, "repository copy estimate.estimated_cost_usd"
    ),
    estimateChecksumSha256: sha256Checksum(
      record.estimate_checksum_sha256,
      "repository copy estimate.estimate_checksum_sha256"
    ),
    createdAt,
    expiresAt
  };
}

export function parseRepositoryObjectProtectedCopyJob(value) {
  const record = object(value, "repository object protected copy job");
  exactKeys(record, [
    "schema_version", "job_id", "project_id", "estimate_id",
    "source_dataset_id", "destination_dataset_id", "destination_name",
    "destination_classification", "connection_target_revision",
    "provider_version_id", "copy_method", "output_format",
    "output_content_type", "maximum_requests", "maximum_output_bytes",
    "estimated_cost_usd", "estimate_checksum_sha256", "estimate_expires_at",
    "rights_basis", "attribution", "request_checksum_sha256",
    "idempotency_key", "state", "output_object_id",
    "output_dataset_version_id", "error_code", "attempt_count", "created_by",
    "created_at", "started_at", "finished_at", "cancellable"
  ], "repository object protected copy job");
  if (record.schema_version !== "opengeo.repository-object-protected-copy-job.1.0.0"
    || record.copy_method !== "exact_object_copy") {
    contract("repository object protected copy job schema is unsupported");
  }
  const state = processingState(record.state, "repository copy job.state");
  const outputObjectId = nullableUuid(
    record.output_object_id, "repository copy job.output_object_id"
  );
  const outputDatasetVersionId = nullableUuid(
    record.output_dataset_version_id, "repository copy job.output_dataset_version_id"
  );
  const errorCode = nullableSafeErrorCode(
    record.error_code, "repository copy job.error_code"
  );
  validateJobResultShape(
    state,
    outputObjectId !== null && outputDatasetVersionId !== null,
    errorCode,
    record.cancellable,
    "repository object protected copy job"
  );
  const providerVersionId = boundedString(
    record.provider_version_id, 1024, "repository copy job.provider_version_id"
  );
  if (providerVersionId === "null") {
    contract("repository object protected copy job requires an immutable provider version");
  }
  return {
    jobId: uuid(record.job_id, "repository copy job.job_id"),
    projectId: uuid(record.project_id, "repository copy job.project_id"),
    estimateId: uuid(record.estimate_id, "repository copy job.estimate_id"),
    sourceDatasetId: uuid(record.source_dataset_id, "repository copy job.source_dataset_id"),
    destinationDatasetId: uuid(
      record.destination_dataset_id, "repository copy job.destination_dataset_id"
    ),
    destinationName: boundedString(
      record.destination_name, 200, "repository copy job.destination_name"
    ),
    destinationClassification: oneOf(
      record.destination_classification,
      ["public", "internal", "confidential", "restricted"],
      "repository copy job.destination_classification"
    ),
    connectionTargetRevision: positiveInteger(
      record.connection_target_revision, "repository copy job.connection_target_revision"
    ),
    providerVersionId,
    copyMethod: "exact_object_copy",
    outputFormat: repositoryCopyFormat(
      record.output_format, "repository copy job.output_format"
    ),
    outputContentType: boundedString(
      record.output_content_type, 200, "repository copy job.output_content_type"
    ),
    maximumRequests: integerBetween(
      record.maximum_requests, 1, 1, "repository copy job.maximum_requests"
    ),
    maximumOutputBytes: integerBetween(
      record.maximum_output_bytes, 1, 536_870_912,
      "repository copy job.maximum_output_bytes"
    ),
    estimatedCostUsd: decimalBetween(
      record.estimated_cost_usd, 0, 100, "repository copy job.estimated_cost_usd"
    ),
    estimateChecksumSha256: sha256Checksum(
      record.estimate_checksum_sha256, "repository copy job.estimate_checksum_sha256"
    ),
    estimateExpiresAt: timestamp(
      record.estimate_expires_at, "repository copy job.estimate_expires_at"
    ),
    rightsBasis: boundedString(record.rights_basis, 500, "repository copy job.rights_basis"),
    attribution: boundedString(record.attribution, 1000, "repository copy job.attribution"),
    requestChecksumSha256: sha256Checksum(
      record.request_checksum_sha256, "repository copy job.request_checksum_sha256"
    ),
    idempotencyKey: uuid(record.idempotency_key, "repository copy job.idempotency_key"),
    state,
    outputObjectId,
    outputDatasetVersionId,
    errorCode,
    attemptCount: integerBetween(record.attempt_count, 0, 3, "repository copy job.attempt_count"),
    createdBy: uuid(record.created_by, "repository copy job.created_by"),
    createdAt: timestamp(record.created_at, "repository copy job.created_at"),
    startedAt: nullableTimestamp(record.started_at, "repository copy job.started_at"),
    finishedAt: nullableTimestamp(record.finished_at, "repository copy job.finished_at"),
    cancellable: boolean(record.cancellable, "repository copy job.cancellable")
  };
}

function repositoryCopyFormat(value, label) {
  return oneOf(value, [
    "geojson", "csv", "shapefile", "geopackage", "geoparquet", "cog",
    "pmtiles", "png", "jpeg", "pdf", "odt"
  ], label);
}

export function parsePmtilesDerivativeJob(value) {
  const record = object(value, "PMTiles derivative job");
  exactKeys(record, [
    "schema_version", "job_id", "project_id", "dataset_id", "dataset_version_id",
    "source_object_id", "bounds", "min_zoom", "max_zoom", "source_layer",
    "request_checksum_sha256", "idempotency_key", "state", "output_object_id",
    "output_size_bytes", "output_checksum_sha256", "error_code", "attempt_count",
    "created_by", "created_at", "started_at", "finished_at", "cancellable"
  ], "PMTiles derivative job");
  if (record.schema_version !== "opengeo.pmtiles-derivative-job.1.0.0") {
    contract("PMTiles derivative job schema is unsupported");
  }
  const state = processingState(record.state, "PMTiles derivative job.state");
  const outputObjectId = nullableUuid(record.output_object_id, "PMTiles derivative job.output_object_id");
  const outputSizeBytes = record.output_size_bytes === null
    ? null
    : integerBetween(record.output_size_bytes, 1, 2_147_483_648, "PMTiles derivative job.output_size_bytes");
  const outputChecksumSha256 = record.output_checksum_sha256 === null
    ? null
    : sha256Checksum(record.output_checksum_sha256, "PMTiles derivative job.output_checksum_sha256");
  const errorCode = nullableSafeErrorCode(record.error_code, "PMTiles derivative job.error_code");
  validateJobResultShape(
    state,
    outputObjectId !== null && outputSizeBytes !== null && outputChecksumSha256 !== null,
    errorCode,
    record.cancellable,
    "PMTiles derivative job"
  );
  const minZoom = integerBetween(record.min_zoom, 0, 22, "PMTiles derivative job.min_zoom");
  const maxZoom = integerBetween(record.max_zoom, 0, 22, "PMTiles derivative job.max_zoom");
  if (minZoom > maxZoom) contract("PMTiles derivative job zoom range is invalid");
  return {
    jobId: uuid(record.job_id, "PMTiles derivative job.job_id"),
    projectId: uuid(record.project_id, "PMTiles derivative job.project_id"),
    datasetId: uuid(record.dataset_id, "PMTiles derivative job.dataset_id"),
    datasetVersionId: uuid(record.dataset_version_id, "PMTiles derivative job.dataset_version_id"),
    sourceObjectId: uuid(record.source_object_id, "PMTiles derivative job.source_object_id"),
    bounds: orderedGeographicBounds(record.bounds, "PMTiles derivative job.bounds", ApiContractError),
    minZoom,
    maxZoom,
    sourceLayer: boundedString(record.source_layer, 200, "PMTiles derivative job.source_layer"),
    requestChecksumSha256: sha256Checksum(record.request_checksum_sha256, "PMTiles derivative job.request_checksum_sha256"),
    idempotencyKey: uuid(record.idempotency_key, "PMTiles derivative job.idempotency_key"),
    state,
    outputObjectId,
    outputSizeBytes,
    outputChecksumSha256,
    errorCode,
    attemptCount: integerBetween(record.attempt_count, 0, 3, "PMTiles derivative job.attempt_count"),
    createdBy: uuid(record.created_by, "PMTiles derivative job.created_by"),
    createdAt: timestamp(record.created_at, "PMTiles derivative job.created_at"),
    startedAt: nullableTimestamp(record.started_at, "PMTiles derivative job.started_at"),
    finishedAt: nullableTimestamp(record.finished_at, "PMTiles derivative job.finished_at"),
    cancellable: boolean(record.cancellable, "PMTiles derivative job.cancellable")
  };
}

export function parseProjectImport(value) {
  const record = object(value, "project import");
  const state = oneOf(record.state, ["open", "completed"], "project import.state");
  const items = parseArray(record.items, (value) => {
    const item = object(value, "project import item");
    const itemState = oneOf(item.state, ["pending", "bound"], "project import item.state");
    const datasetId = item.dataset_id === null
      ? null
      : uuid(item.dataset_id, "project import item.dataset_id");
    const boundAt = item.bound_at === null
      ? null
      : timestamp(item.bound_at, "project import item.bound_at");
    if ((itemState === "pending") !== (datasetId === null && boundAt === null)) {
      contract("project import item binding shape is invalid");
    }
    return {
      importRef: importReference(item.import_ref, "project import item.import_ref"),
      kind: oneOf(item.kind, ["external_source", "embedded_dataset"], "project import item.kind"),
      expectedSourceType: oneOf(
        item.expected_source_type,
        ["upload", "xyz", "wms", "pmtiles", "geojson", "arcgis", "wfs"],
        "project import item.expected_source_type"
      ),
      expectedFormat: oneOf(
        item.expected_format,
        ["geojson", "xyz", "wms", "pmtiles", "arcgis", "wfs"],
        "project import item.expected_format"
      ),
      candidate: structuredClone(object(item.candidate, "project import item.candidate")),
      state: itemState,
      datasetId,
      boundAt
    };
  }, "project import.items");
  const unresolvedImportRefs = parseArray(
    record.unresolved_import_refs,
    (item) => importReference(item, "project import.unresolved_import_ref"),
    "project import.unresolved_import_refs"
  );
  const expectedUnresolved = items.filter((item) => item.state === "pending").map((item) => item.importRef);
  if (unresolvedImportRefs.length !== expectedUnresolved.length || unresolvedImportRefs.some((item) => !expectedUnresolved.includes(item))) {
    contract("project import unresolved references are inconsistent");
  }
  const ready = boolean(record.ready, "project import.ready");
  if (ready !== (state === "open" && expectedUnresolved.length === 0)) {
    contract("project import readiness is inconsistent");
  }
  const completedAt = record.completed_at === null
    ? null
    : timestamp(record.completed_at, "project import.completed_at");
  const finalMapVersion = record.final_map_version === null
    ? null
    : positiveInteger(record.final_map_version, "project import.final_map_version");
  if ((state === "completed") !== (completedAt !== null)) contract("project import completion shape is invalid");
  return {
    importId: uuid(record.import_id, "project import.import_id"),
    projectId: uuid(record.project_id, "project import.project_id"),
    mapId: uuid(record.map_id, "project import.map_id"),
    idempotencyKey: uuid(record.idempotency_key, "project import.idempotency_key"),
    sourceProduct: oneOf(record.source_product, ["geolibre"], "project import.source_product"),
    sourceVersion: string(record.source_version, "project import.source_version"),
    sourceSha256: sha256(record.source_sha256, "project import.source_sha256"),
    planDigest: sha256(record.plan_digest, "project import.plan_digest"),
    expectedMapVersion: positiveInteger(record.expected_map_version, "project import.expected_map_version"),
    state,
    ready,
    unresolvedImportRefs,
    items,
    createdBy: uuid(record.created_by, "project import.created_by"),
    createdAt: timestamp(record.created_at, "project import.created_at"),
    updatedAt: timestamp(record.updated_at, "project import.updated_at"),
    completedAt,
    finalMapVersion
  };
}

export function parseResourceSummary(value) {
  const record = object(value, "governed resource");
  const spatialExtent = record.spatial_extent === null
    ? null
    : parseArray(record.spatial_extent, (coordinate) => finiteNumber(coordinate, "resource.spatial_extent"), "resource.spatial_extent");
  if (spatialExtent !== null && spatialExtent.length !== 4) contract("resource.spatial_extent is invalid");
  const keywords = parseArray(record.keywords, (keyword) => string(keyword, "resource.keyword"), "resource.keywords");
  if (keywords.length > 64) contract("resource.keywords is too large");
  return {
    id: uuid(record.id, "resource.id"),
    projectId: uuid(record.project_id, "resource.project_id"),
    kind: oneOf(record.kind, ["dataset", "map", "document", "story", "dashboard", "service"], "resource.kind"),
    slug: boundedString(record.slug, 160, "resource.slug"),
    datasetId: nullableUuid(record.dataset_id, "resource.dataset_id"),
    mapId: nullableUuid(record.map_id, "resource.map_id"),
    visibility: oneOf(record.visibility, ["restricted", "organization", "public"], "resource.visibility"),
    state: oneOf(record.state, ["draft", "review", "published", "archived"], "resource.state"),
    versionNumber: positiveInteger(record.version_number, "resource.version_number"),
    title: boundedString(record.title, 300, "resource.title"),
    abstract: nullableBoundedString(record.abstract, 8_000, "resource.abstract"),
    language: boundedString(record.language, 40, "resource.language"),
    license: nullableBoundedString(record.license, 1_000, "resource.license"),
    attribution: nullableBoundedString(record.attribution, 2_000, "resource.attribution"),
    keywords,
    spatialExtent,
    temporalStart: nullableTimestamp(record.temporal_start, "resource.temporal_start"),
    temporalEnd: nullableTimestamp(record.temporal_end, "resource.temporal_end"),
    ownerUserId: uuid(record.owner_user_id, "resource.owner_user_id"),
    originNamespace: nullableBoundedString(record.origin_namespace, 64, "resource.origin_namespace"),
    originIdentifier: nullableBoundedString(record.origin_identifier, 300, "resource.origin_identifier"),
    relationshipCount: nonNegativeInteger(record.relationship_count, "resource.relationship_count"),
    createdAt: timestamp(record.created_at, "resource.created_at"),
    updatedAt: timestamp(record.updated_at, "resource.updated_at")
  };
}

export function parsePublicCatalogRecord(value) {
  const record = object(value, "public catalog record");
  exactKeys(record, [
    "id", "kind", "slug", "version_number", "title", "abstract", "language",
    "license", "attribution", "keywords", "spatial_extent", "temporal_start",
    "temporal_end", "created_at", "community", "preview", "freshness",
    "provenance", "relationships", "ratings"
  ], "public catalog record");
  const spatialExtent = record.spatial_extent === null
    ? null
    : parseArray(
      record.spatial_extent,
      (coordinate) => finiteNumber(coordinate, "public catalog spatial extent"),
      "public catalog spatial extent"
    );
  if (spatialExtent !== null && (spatialExtent.length !== 4
    || spatialExtent[0] > spatialExtent[2] || spatialExtent[1] > spatialExtent[3]
    || spatialExtent[0] < -180 || spatialExtent[2] > 180
    || spatialExtent[1] < -90 || spatialExtent[3] > 90)) {
    contract("public catalog spatial extent is invalid");
  }
  const keywords = boundedStringArray(record.keywords, 64, 100, "public catalog keywords");
  const community = object(record.community, "public catalog community");
  exactKeys(community, [
    "organization_id", "organization_slug", "organization_name", "project_id", "project_name"
  ], "public catalog community");
  const preview = object(record.preview, "public catalog preview");
  exactKeys(preview, ["kind", "href"], "public catalog preview");
  const freshness = object(record.freshness, "public catalog freshness");
  exactKeys(
    freshness,
    ["catalog_updated_at", "source_observed_at", "source_version"],
    "public catalog freshness"
  );
  const provenance = object(record.provenance, "public catalog provenance");
  exactKeys(provenance, ["namespace", "identifier"], "public catalog provenance");
  const relationships = object(record.relationships, "public catalog relationships");
  exactKeys(relationships, ["public_count", "detail_href"], "public catalog relationships");
  const ratings = object(record.ratings, "public catalog ratings");
  exactKeys(ratings, ["count", "average"], "public catalog ratings");
  const ratingCount = nonNegativeInteger(ratings.count, "public catalog ratings.count");
  const ratingAverage = ratings.average === null
    ? null
    : finiteNumber(ratings.average, "public catalog ratings.average");
  if ((ratingCount === 0) !== (ratingAverage === null)
    || (ratingAverage !== null && (ratingAverage < 1 || ratingAverage > 5))) {
    contract("public catalog rating aggregate is inconsistent");
  }
  const resourceId = uuid(record.id, "public catalog record.id");
  const organizationId = uuid(
    community.organization_id,
    "public catalog organization id"
  );
  const projectId = uuid(community.project_id, "public catalog project id");
  const previewKind = oneOf(
    preview.kind,
    ["map", "dataset", "dataset-document", "document", "metadata"],
    "public catalog preview.kind"
  );
  const href = publicCatalogHref(
    preview.href,
    "public catalog preview.href",
    previewKind === "map"
      ? "map-preview"
      : previewKind === "dataset"
      ? "spatial-preview"
      : previewKind === "dataset-document"
      ? "dataset-document-preview"
      : previewKind === "document" ? "document-preview" : null
  );
  const detailHref = publicCatalogHref(
    relationships.detail_href,
    "public catalog relationships.detail_href",
    null
  );
  const expectedDetailHref = (
    `/public/organizations/${organizationId}/projects/${projectId}/resources/${resourceId}`
  );
  const expectedPreviewHref = previewKind === "map"
    ? `${expectedDetailHref}/map-preview`
    : previewKind === "dataset"
    ? `${expectedDetailHref}/spatial-preview`
    : previewKind === "dataset-document"
    ? `${expectedDetailHref}/dataset-document-preview`
    : previewKind === "document"
      ? `${expectedDetailHref}/document-preview`
      : expectedDetailHref;
  if (detailHref !== expectedDetailHref || href !== expectedPreviewHref) {
    contract("public catalog links do not match the resource identity");
  }
  const resourceKind = oneOf(
    record.kind,
    ["dataset", "map", "document", "story", "dashboard", "service"],
    "public catalog record.kind"
  );
  if (previewKind === "document"
    && !["document", "story", "dashboard"].includes(resourceKind)) {
    contract("public catalog document preview has an incompatible resource kind");
  }
  if (previewKind === "dataset-document" && resourceKind !== "dataset") {
    contract("public catalog dataset document preview has an incompatible resource kind");
  }
  return {
    id: resourceId,
    kind: resourceKind,
    slug: boundedString(record.slug, 160, "public catalog record.slug"),
    versionNumber: positiveInteger(record.version_number, "public catalog record.version_number"),
    title: boundedString(record.title, 300, "public catalog record.title"),
    abstract: nullableBoundedString(record.abstract, 8_000, "public catalog record.abstract"),
    language: boundedString(record.language, 40, "public catalog record.language"),
    license: nullableBoundedString(record.license, 1_000, "public catalog record.license"),
    attribution: nullableBoundedString(
      record.attribution, 2_000, "public catalog record.attribution"
    ),
    keywords,
    spatialExtent,
    temporalStart: nullableTimestamp(record.temporal_start, "public catalog temporal start"),
    temporalEnd: nullableTimestamp(record.temporal_end, "public catalog temporal end"),
    createdAt: timestamp(record.created_at, "public catalog record.created_at"),
    community: {
      organizationId,
      organizationSlug: boundedString(
        community.organization_slug, 100, "public catalog organization slug"
      ),
      organizationName: boundedString(
        community.organization_name, 200, "public catalog organization name"
      ),
      projectId,
      projectName: boundedString(community.project_name, 200, "public catalog project name")
    },
    preview: {
      kind: previewKind,
      href
    },
    freshness: {
      catalogUpdatedAt: timestamp(
        freshness.catalog_updated_at, "public catalog freshness.catalog_updated_at"
      ),
      sourceObservedAt: nullableTimestamp(
        freshness.source_observed_at, "public catalog freshness.source_observed_at"
      ),
      sourceVersion: nullableBoundedString(
        freshness.source_version, 40, "public catalog freshness.source_version"
      )
    },
    provenance: {
      namespace: nullableBoundedString(
        provenance.namespace, 64, "public catalog provenance.namespace"
      ),
      identifier: nullableBoundedString(
        provenance.identifier, 300, "public catalog provenance.identifier"
      )
    },
    relationships: {
      publicCount: nonNegativeInteger(
        relationships.public_count, "public catalog relationships.public_count"
      ),
      detailHref
    },
    ratings: {count: ratingCount, average: ratingAverage}
  };
}

export function parsePublicCatalogPage(value) {
  const record = object(value, "public catalog page");
  exactKeys(record, [
    "schema_version", "number_returned", "number_matched", "limit", "offset",
    "next_offset", "facet_sample_size", "facets_truncated", "facets", "records"
  ], "public catalog page");
  const limit = integerBetween(record.limit, 1, 100, "public catalog limit");
  const offset = integerBetween(record.offset, 0, 10_000, "public catalog offset");
  const records = parseArray(
    record.records,
    parsePublicCatalogRecord,
    "public catalog records"
  );
  if (records.length > limit) contract("public catalog page exceeds its limit");
  const numberReturned = integerBetween(
    record.number_returned, 0, limit, "public catalog number returned"
  );
  if (numberReturned !== records.length) contract("public catalog return count is inconsistent");
  const numberMatched = nonNegativeInteger(
    record.number_matched, "public catalog number matched"
  );
  const nextOffset = record.next_offset === null
    ? null
    : integerBetween(record.next_offset, 1, 10_000, "public catalog next offset");
  const candidateOffset = offset + numberReturned;
  const expectedNext = numberReturned > 0
    && candidateOffset < numberMatched
    && candidateOffset <= 10_000
    ? candidateOffset
    : null;
  if (nextOffset !== expectedNext || (nextOffset !== null && numberReturned === 0)) {
    contract("public catalog pagination is inconsistent");
  }
  const facetsRecord = object(record.facets, "public catalog facets");
  const facetNames = ["kind", "project", "license", "keyword", "origin"];
  exactKeys(facetsRecord, facetNames, "public catalog facets");
  const facets = {};
  for (const name of facetNames) {
    const values = parseArray(facetsRecord[name], (value) => {
      const facet = object(value, `public catalog ${name} facet`);
      exactKeys(facet, ["value", "label", "count"], `public catalog ${name} facet`);
      return {
        value: boundedString(facet.value, 300, `public catalog ${name} facet value`),
        label: boundedString(facet.label, 300, `public catalog ${name} facet label`),
        count: positiveInteger(facet.count, `public catalog ${name} facet count`)
      };
    }, `public catalog ${name} facets`);
    if (values.length > 50 || new Set(values.map(({value}) => value)).size !== values.length) {
      contract(`public catalog ${name} facets are invalid`);
    }
    facets[name] = values;
  }
  return {
    schemaVersion: oneOf(
      record.schema_version,
      ["opengeo.public-catalog.1.5.0"],
      "public catalog schema version"
    ),
    numberReturned,
    numberMatched,
    limit,
    offset,
    nextOffset,
    facetSampleSize: integerBetween(
      record.facet_sample_size, 0, 10_000, "public catalog facet sample size"
    ),
    facetsTruncated: boolean(record.facets_truncated, "public catalog facets truncated"),
    facets,
    records
  };
}

export function parsePublicSpatialPreview(value) {
  const record = boundedObject(value, 4_300_000, "public spatial preview");
  exactKeys(record, [
    "schema_version", "resource_id", "resource_version_number", "number_returned",
    "number_matched", "may_be_truncated", "geojson"
  ], "public spatial preview");
  if (record.schema_version !== "opengeo.public-spatial-preview.1.0.0") {
    contract("public spatial preview schema is unsupported");
  }
  const numberReturned = integerBetween(
    record.number_returned,
    0,
    5_000,
    "public spatial preview.number_returned"
  );
  const numberMatched = record.number_matched === null
    ? null
    : nonNegativeInteger(record.number_matched, "public spatial preview.number_matched");
  const mayBeTruncated = boolean(
    record.may_be_truncated,
    "public spatial preview.may_be_truncated"
  );
  if (
    (numberMatched !== null && numberReturned > numberMatched)
    || mayBeTruncated !== (numberMatched === null || numberReturned < numberMatched)
  ) {
    contract("public spatial preview counts are inconsistent");
  }
  const geojson = spatialPreviewGeojson(record.geojson);
  if (geojson.features.length !== numberReturned) {
    contract("public spatial preview feature count is inconsistent");
  }
  return {
    schemaVersion: record.schema_version,
    resourceId: uuid(record.resource_id, "public spatial preview.resource_id"),
    resourceVersionNumber: positiveInteger(
      record.resource_version_number,
      "public spatial preview.resource_version_number"
    ),
    numberReturned,
    numberMatched,
    mayBeTruncated,
    geojson
  };
}

export function parsePublicDocumentPreview(value) {
  const record = boundedObject(value, 270_000, "public document preview");
  exactKeys(record, [
    "schema_version", "resource_id", "resource_version_number", "resource_kind",
    "renderer_version", "dependency_references_omitted", "html"
  ], "public document preview");
  if (record.schema_version !== "opengeo.public-document-preview.1.0.0") {
    contract("public document preview schema is unsupported");
  }
  const rendererVersion = oneOf(
    record.renderer_version,
    ["opengeo-page-renderer-1.1.0"],
    "public document preview.renderer_version"
  );
  const html = boundedString(record.html, 256 * 1024, "public document preview.html");
  if (
    !html.startsWith("<!doctype html>")
    || !html.includes(`data-renderer-version="${rendererVersion}"`)
    || !html.includes("script-src 'none'")
    || /<script\b|<iframe\b|<form\b/i.test(html)
  ) {
    contract("public document preview HTML is not the pinned inert document");
  }
  return {
    schemaVersion: record.schema_version,
    resourceId: uuid(record.resource_id, "public document preview.resource_id"),
    resourceVersionNumber: positiveInteger(
      record.resource_version_number,
      "public document preview.resource_version_number"
    ),
    resourceKind: oneOf(
      record.resource_kind,
      ["document", "story", "dashboard"],
      "public document preview.resource_kind"
    ),
    rendererVersion,
    dependencyReferencesOmitted: integerBetween(
      record.dependency_references_omitted,
      0,
      24,
      "public document preview.dependency_references_omitted"
    ),
    html
  };
}

export function parsePublicDatasetDocumentPreview(value) {
  const record = boundedObject(value, 4_300_000, "public dataset document preview");
  exactKeys(record, [
    "schema_version", "resource_id", "resource_version_number",
    "dataset_version_number", "source_format", "presentation_kind", "presentation"
  ], "public dataset document preview");
  if (record.schema_version !== "opengeo.public-dataset-document-preview.1.0.0") {
    contract("public dataset document preview schema is unsupported");
  }
  const sourceFormat = oneOf(
    record.source_format,
    ["pdf", "odt"],
    "public dataset document preview.source_format"
  );
  const presentationKind = oneOf(
    record.presentation_kind,
    ["semantic", "visual"],
    "public dataset document preview.presentation_kind"
  );
  const presentation = parseDocumentPreview(record.presentation);
  const visual = presentation.schemaVersion.startsWith("opengeo.pdf-visual-presentation.");
  if (
    presentation.sourceFormat !== sourceFormat
    || visual !== (presentationKind === "visual")
    || (sourceFormat === "odt" && presentationKind !== "semantic")
  ) {
    contract("public dataset document preview presentation is inconsistent");
  }
  return {
    schemaVersion: record.schema_version,
    resourceId: uuid(record.resource_id, "public dataset document preview.resource_id"),
    resourceVersionNumber: positiveInteger(
      record.resource_version_number,
      "public dataset document preview.resource_version_number"
    ),
    datasetVersionNumber: positiveInteger(
      record.dataset_version_number,
      "public dataset document preview.dataset_version_number"
    ),
    sourceFormat,
    presentationKind,
    presentation
  };
}

export function parsePublicMapPreview(value) {
  const record = boundedObject(value, 9_000_000, "public map preview");
  exactKeys(record, [
    "schema_version", "resource_id", "resource_version_number", "map_version",
    "projection", "color_mode", "layers"
  ], "public map preview");
  if (record.schema_version !== "opengeo.public-map-preview.1.0.0") {
    contract("public map preview schema is unsupported");
  }
  const layerIds = new Set();
  let totalFeatures = 0;
  const layers = parseArray(record.layers, (value) => {
    const layer = boundedObject(value, 600_000, "public map preview layer");
    exactKeys(layer, [
      "layer_id", "title", "visible", "opacity", "order", "style", "labels",
      "number_returned", "number_matched", "may_be_truncated", "geojson"
    ], "public map preview layer");
    const layerId = boundedString(layer.layer_id, 160, "public map preview layer.id");
    if (layerIds.has(layerId)) contract("public map preview layer ids are duplicated");
    layerIds.add(layerId);
    const numberReturned = integerBetween(
      layer.number_returned, 0, 5_000, "public map preview layer.number_returned"
    );
    const numberMatched = layer.number_matched === null
      ? null
      : nonNegativeInteger(layer.number_matched, "public map preview layer.number_matched");
    const mayBeTruncated = boolean(
      layer.may_be_truncated, "public map preview layer.may_be_truncated"
    );
    if ((numberMatched !== null && numberReturned > numberMatched)
      || mayBeTruncated !== (numberMatched === null || numberReturned < numberMatched)) {
      contract("public map preview layer counts are inconsistent");
    }
    const geojson = spatialPreviewGeojson(layer.geojson);
    if (geojson.features.length !== numberReturned) {
      contract("public map preview layer feature count is inconsistent");
    }
    totalFeatures += numberReturned;
    if (totalFeatures > 50_000) contract("public map preview feature limit exceeded");
    const opacity = finiteNumber(layer.opacity, "public map preview layer.opacity");
    if (opacity < 0 || opacity > 1) contract("public map preview layer.opacity is invalid");
    return {
      layerId,
      title: boundedString(layer.title, 240, "public map preview layer.title"),
      visible: boolean(layer.visible, "public map preview layer.visible"),
      opacity,
      order: integerBetween(layer.order, -1_000_000, 1_000_000, "public map preview layer.order"),
      style: boundedObject(layer.style, 8_192, "public map preview layer.style"),
      labels: boundedObject(layer.labels, 8_192, "public map preview layer.labels"),
      numberReturned,
      numberMatched,
      mayBeTruncated,
      geojson
    };
  }, "public map preview layers");
  if (layers.length > 64) contract("public map preview layer limit exceeded");
  return {
    schemaVersion: record.schema_version,
    resourceId: uuid(record.resource_id, "public map preview.resource_id"),
    resourceVersionNumber: positiveInteger(
      record.resource_version_number, "public map preview.resource_version_number"
    ),
    mapVersion: positiveInteger(record.map_version, "public map preview.map_version"),
    projection: oneOf(record.projection, ["mercator", "globe"], "public map preview.projection"),
    colorMode: oneOf(record.color_mode, ["light", "dark"], "public map preview.color_mode"),
    layers
  };
}

export function parseCatalogLayer(value) {
  const r = object(value, "catalog layer");
  return {
    datasetId: uuid(r.dataset_id, "catalog dataset"), datasetName: string(r.dataset_name, "catalog dataset name"),
    projectId: uuid(r.project_id, "catalog project"), projectName: string(r.project_name, "catalog project name"),
    format: string(r.format, "catalog format"), classification: string(r.classification, "catalog classification"),
    sourceType: string(r.source_type, "catalog source"), updatedAt: timestamp(r.updated_at, "catalog updated"),
    mapId: nullableUuid(r.map_id, "catalog map"), mapVersion: nullablePositiveInteger(r.map_version, "catalog map version"),
    layerId: nullableString(r.layer_id, "catalog layer id"), title: string(r.title, "catalog title"),
    description: nullableString(r.description, "catalog description"), styleField: nullableString(r.style_field, "catalog field"),
    legend: r.legend === null ? null : object(r.legend, "catalog legend"),
    geometryType: nullableString(r.geometry_type, "catalog geometry"), styleKey: nullableString(r.style_key, "catalog style key"),
    service: r.service == null ? null : parseCatalogService(r.service)
  };
}

function parseCatalogService(value) {
  const r = object(value, "catalog service");
  const kind = oneOf(r.kind, ["FeatureServer", "MapServer", "ImageServer", "WFS", "COG"], "service kind");
  const url = string(r.url, "service URL");
  let parsed;
  try {parsed = new URL(url);} catch {contract("Invalid service URL");}
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.port || /[\s\\%]/.test(url) || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(parsed.hostname)
    || /\.(localhost|local|internal)$/i.test(parsed.hostname)
    || (kind === "COG" ? !/\.tiff?$/i.test(parsed.pathname) : kind === "WFS" ? !/^\/[A-Za-z0-9_./~-]+$/.test(parsed.pathname) : !parsed.pathname.endsWith(`/${kind}`)) || parsed.href !== url) contract("Invalid service URL");
  const layerId = nullableString(r.layer_id, "provider layer id");
  if (layerId !== null && (!/^\d+$/.test(layerId) || ["ImageServer", "WFS", "COG"].includes(kind))) contract("Invalid provider layer id");
  const layerUrl = string(r.layer_url, "provider layer URL");
  if (layerUrl !== url + (layerId === null ? "" : `/${layerId}`)) contract("Provider layer URL does not match service");
  return {url, kind, layerId, layerUrl,
    renderingSource: oneOf(r.rendering_source, ["provider", "captured_copy"], "rendering source"),
    sourceVersion: nullablePositiveInteger(r.source_version, "source revision")};
}

export function parsePublicationWorkspace(value) {
  const r = object(value, "publication workspace");
  const hostname = nullableString(r.hostname, "publication hostname");
  const mountPath = nullableString(r.mount_path, "publication path");
  if (hostname !== null && !/^[a-z0-9][a-z0-9.-]{1,251}[a-z0-9]$/.test(hostname)) contract("Invalid publication hostname");
  if (mountPath !== null && !/^\/(?:[a-z0-9][a-z0-9-]{0,79}\/)*$/.test(mountPath)) contract("Invalid publication path");
  const status = oneOf(r.status, ["published", "draft", "unmanaged", "adopted"], "publication status");
  if (status === "adopted" && (mountPath !== "/" || hostname === null || r.source_project_id === null
    || r.published_revision !== null || r.published_at !== null)) contract("Invalid adopted root publication");
  return {
    id: uuid(r.id, "publication id"), kind: oneOf(r.kind, ["framework", "hosted_site", "site"], "publication kind"),
    projectId: nullableUuid(r.project_id, "publication project"), projectName: nullableString(r.project_name, "publication project name"),
    siteId: nullableUuid(r.site_id, "publication site"), sourceProjectId: nullableUuid(r.source_project_id, "publication source"),
    title: string(r.title, "publication title"), currentRevision: nonNegativeInteger(r.current_revision, "source revision"),
    hostname, mountPath, status, publishedAt: nullableTimestamp(r.published_at, "publication time"),
    publishedRevision: nullablePositiveInteger(r.published_revision, "published revision"),
    canManage: boolean(r.can_manage, "publication manage permission"),
    publicUrl: hostname && mountPath && status !== "draft" ? `https://${hostname}${mountPath}` : null
  };
}

export function parsePublicSiteDirectoryRecord(value) {
  const record = object(value, "public site directory record");
  exactKeys(record, [
    "project_id", "project_name", "site_id", "edition_id", "listed_slug",
    "title", "description", "language", "theme", "page_count", "published_at",
    "is_primary", "href", "primary_href"
  ], "public site directory record");
  const listedSlug = siteSlugPath(record.listed_slug);
  const href = parsePublicSiteDirectoryHref(
    record.href,
    "public site directory record.href"
  );
  if (href.listedSlug !== listedSlug) {
    contract("public site directory path does not match its listed slug");
  }
  const isPrimary = boolean(record.is_primary, "public site directory record.is_primary");
  const primaryHref = record.primary_href === null
    ? null
    : parsePublicPrimarySiteHref(
      record.primary_href,
      "public site directory record.primary_href"
    );
  if (isPrimary !== (primaryHref !== null)) {
    contract("public site directory primary path is inconsistent");
  }
  if (primaryHref !== null && primaryHref.organizationId !== href.organizationId) {
    contract("public site directory paths cross organization boundaries");
  }
  return {
    projectId: uuid(record.project_id, "public site directory record.project_id"),
    projectName: boundedString(
      record.project_name, 200, "public site directory record.project_name"
    ),
    siteId: uuid(record.site_id, "public site directory record.site_id"),
    editionId: uuid(record.edition_id, "public site directory record.edition_id"),
    listedSlug,
    title: boundedString(record.title, 300, "public site directory record.title"),
    description: nullableBoundedString(
      record.description, 4_000, "public site directory record.description"
    ),
    language: boundedString(record.language, 40, "public site directory record.language"),
    theme: oneOf(
      record.theme,
      ["paper", "atlas", "minimal"],
      "public site directory record.theme"
    ),
    pageCount: integerBetween(
      record.page_count, 1, 64, "public site directory record.page_count"
    ),
    publishedAt: timestamp(
      record.published_at, "public site directory record.published_at"
    ),
    isPrimary,
    href: href.href,
    primaryHref: primaryHref?.href ?? null
  };
}

export function parsePublicSiteDirectoryPage(value) {
  const record = object(value, "public site directory page");
  exactKeys(record, [
    "schema_version", "number_returned", "number_matched", "limit", "offset",
    "next_offset", "records"
  ], "public site directory page");
  const limit = integerBetween(record.limit, 1, 100, "public site directory limit");
  const offset = integerBetween(record.offset, 0, 10_000, "public site directory offset");
  const records = parseArray(
    record.records,
    parsePublicSiteDirectoryRecord,
    "public site directory records"
  );
  if (records.length > limit) contract("public site directory exceeds its limit");
  if (new Set(records.map(({listedSlug}) => listedSlug)).size !== records.length) {
    contract("public site directory contains duplicate paths");
  }
  if (records.filter(({isPrimary}) => isPrimary).length > 1) {
    contract("public site directory contains multiple primary publications");
  }
  const numberReturned = integerBetween(
    record.number_returned, 0, limit, "public site directory number returned"
  );
  if (numberReturned !== records.length) {
    contract("public site directory return count is inconsistent");
  }
  const numberMatched = nonNegativeInteger(
    record.number_matched, "public site directory number matched"
  );
  const nextOffset = record.next_offset === null
    ? null
    : integerBetween(record.next_offset, 1, 10_000, "public site directory next offset");
  const candidateOffset = offset + numberReturned;
  const expectedNext = numberReturned > 0
    && candidateOffset < numberMatched
    && candidateOffset <= 10_000
    ? candidateOffset
    : null;
  if (nextOffset !== expectedNext) {
    contract("public site directory pagination is inconsistent");
  }
  return {
    schemaVersion: oneOf(
      record.schema_version,
      ["opengeo.public-site-directory.1.0.0"],
      "public site directory schema version"
    ),
    numberReturned,
    numberMatched,
    limit,
    offset,
    nextOffset,
    records
  };
}

export function parseGovernedResource(value) {
  const record = object(value, "governed resource detail");
  const summary = parseResourceSummary(record);
  let mapSnapshot = null;
  if (record.map_snapshot !== undefined && record.map_snapshot !== null) {
    const snapshot = object(record.map_snapshot, "resource.map_snapshot");
    exactKeys(snapshot, ["map_id", "map_version_id", "map_version", "definition_checksum_sha256"], "resource.map_snapshot");
    mapSnapshot = {
      mapId: uuid(snapshot.map_id, "resource.map_snapshot.map_id"),
      mapVersionId: uuid(snapshot.map_version_id, "resource.map_snapshot.map_version_id"),
      mapVersion: positiveInteger(snapshot.map_version, "resource.map_snapshot.map_version"),
      definitionChecksumSha256: sha256(snapshot.definition_checksum_sha256, "resource.map_snapshot.definition_checksum_sha256")
    };
    if (summary.kind !== "map" || mapSnapshot.mapId !== summary.mapId) {
      contract("resource.map_snapshot does not match its map resource");
    }
  }
  const metadataExtensions = boundedObject(record.metadata_extensions, 8_192, "resource.metadata_extensions");
  const translations = parseResourceTranslations(record.translations);
  const content = parseResourceContent(record.content);
  const provenance = boundedObject(record.provenance, 4_096, "resource.provenance");
  const externalIdentifiers = parseArray(record.external_identifiers, (value) => {
    const item = object(value, "resource external identifier");
    return {
      namespace: boundedString(item.namespace, 64, "external identifier.namespace"),
      identifier: boundedString(item.identifier, 300, "external identifier.identifier"),
      sourceUrl: publicSourceUrl(item.source_url, "resource"),
      sourceVersion: boundedString(item.source_version, 40, "external identifier.source_version"),
      sourcePayloadSha256: sha256(item.source_payload_sha256, "external identifier.source_payload_sha256"),
      importedAt: timestamp(item.imported_at, "external identifier.imported_at")
    };
  }, "resource.external_identifiers");
  const relationships = parseArray(record.relationships, (value) => {
    const item = object(value, "resource relationship");
    return {
      id: uuid(item.id, "resource relationship.id"),
      sourceResourceId: uuid(item.source_resource_id, "resource relationship.source_resource_id"),
      targetResourceId: uuid(item.target_resource_id, "resource relationship.target_resource_id"),
      relation: oneOf(item.relation, ["references", "has_part", "is_part_of", "derived_from", "documents"], "resource relationship.relation"),
      createdBy: uuid(item.created_by, "resource relationship.created_by"),
      createdAt: timestamp(item.created_at, "resource relationship.created_at")
    };
  }, "resource.relationships");
  return {
    ...summary,
    ...(Object.hasOwn(record, "current_version_id")
      ? {currentVersionId: nullableUuid(record.current_version_id, "resource.current_version_id")} : {}),
    mapSnapshot,
    metadataProfile: boundedString(record.metadata_profile, 100, "resource.metadata_profile"),
    metadataExtensions,
    translations,
    managedMetadataProfileId: nullableUuid(record.managed_metadata_profile_id, "resource.managed_metadata_profile_id"),
    managedMetadataProfileVersion: record.managed_metadata_profile_version === null
      ? null
      : positiveInteger(record.managed_metadata_profile_version, "resource.managed_metadata_profile_version"),
    metadataValidation: record.metadata_validation === null
      ? null
      : boundedObject(record.metadata_validation, 16_384, "resource.metadata_validation"),
    content,
    provenance,
    changeMessage: nullableBoundedString(record.change_message, 500, "resource.change_message"),
    versionCreatedBy: uuid(record.version_created_by, "resource.version_created_by"),
    versionCreatedAt: timestamp(record.version_created_at, "resource.version_created_at"),
    externalIdentifiers,
    relationships
  };
}

/** Inspect saved metadata only; registration still rechecks current authority. */
export function observablePublicFileCandidates(resource) {
  const unavailable = unavailableReason => ({candidates: [], unavailableReason});
  if (!isObject(resource) || resource.kind !== "dataset" || !["draft", "review", "published"].includes(resource.state)) {
    return unavailable("Choose an available Catalog dataset to connect a public TIFF file.");
  }
  let datasetId, resourceId, resourceVersionId, resourceVersionNumber;
  try {
    datasetId = uuid(resource.datasetId, "public file candidate dataset");
    resourceId = uuid(resource.id, "public file candidate resource");
    uuid(resource.projectId, "public file candidate project");
    resourceVersionId = uuid(resource.currentVersionId, "public file candidate metadata edition");
    resourceVersionNumber = integerBetween(resource.versionNumber, 1, Number.MAX_SAFE_INTEGER, "public file candidate metadata version");
  } catch {
    return unavailable("Catalog metadata needs an exact current edition before this file can be connected.");
  }
  const provenance = resource.provenance;
  let sourceVersion = isObject(provenance) ? provenance.externalSourceVersion : null;
  if (typeof sourceVersion === "string" && /^[1-9][0-9]{0,15}$/.test(sourceVersion)) sourceVersion = Number(sourceVersion);
  if (!Number.isSafeInteger(sourceVersion) || sourceVersion < 1 || !isObject(provenance)) {
    return unavailable("Catalog metadata must record the exact public TIFF source revision and URL.");
  }
  let url;
  try { url = publicReferencedFileUrl(provenance.externalSourceUrl); }
  catch { return unavailable("Catalog metadata must record a query-free public HTTPS TIFF source URL."); }
  const opengeo = resource.metadataExtensions?.opengeo;
  if (!isObject(opengeo) || !["1.0.0", "1.1.0", "1.2.0", "1.3.0"].includes(opengeo.schemaVersion)
    || !Array.isArray(opengeo.distributions) || opengeo.distributions.length > 32) {
    return unavailable("Catalog metadata needs a supported distribution record for this public TIFF.");
  }
  const candidates = [];
  for (const distribution of opengeo.distributions) {
    if (!isObject(distribution)) continue;
    let distributionId, contentType, sizeBytes, checksumSha256;
    try {
      distributionId = boundedString(distribution.identifier, 1000, "public file candidate distribution");
      if (opengeo.distributions.filter(item => isObject(item) && item.identifier === distributionId).length !== 1
        || distribution.downloadUrl !== url) continue;
      contentType = oneOf(distribution.mediaType, ["image/tiff", "image/geotiff"], "public file candidate media");
      sizeBytes = integerBetween(distribution.byteSize, 1, 67_108_864, "public file candidate bytes");
      checksumSha256 = sha256(distribution.checksumSha256, "public file candidate checksum");
    } catch { continue; }
    const encodedFilename = new URL(url).pathname.split("/").at(-1);
    let filename = encodedFilename;
    try {
      const decoded = decodeURIComponent(encodedFilename);
      if (!/[\u0000-\u001f\u007f/\\]/.test(decoded)) filename = decoded;
    } catch { /* Retain the exact encoded filename when decoding is unavailable. */ }
    candidates.push({selection: {datasetId, sourceVersion, resourceId, resourceVersionId, distributionId},
      filename, url, contentType, sizeBytes, checksumSha256, resourceVersionNumber});
  }
  return candidates.length ? {candidates, unavailableReason: null}
    : unavailable("Catalog metadata needs a unique TIFF distribution with the exact source URL, byte size up to 64 MiB and SHA-256.");
}

export function parseResourceCapabilities(value) {
  const record = object(value, "resource capabilities");
  exactKeys(
    record,
    ["can_read", "can_update", "can_publish", "can_manage_permissions"],
    "resource capabilities"
  );
  return {
    canRead: boolean(record.can_read, "resource capabilities.can_read"),
    canUpdate: boolean(record.can_update, "resource capabilities.can_update"),
    canPublish: boolean(record.can_publish, "resource capabilities.can_publish"),
    canManagePermissions: boolean(
      record.can_manage_permissions,
      "resource capabilities.can_manage_permissions"
    )
  };
}

export function parseMetadataProfile(value) {
  const record = object(value, "metadata profile");
  return {
    id: uuid(record.id, "metadata profile.id"),
    slug: boundedString(record.slug, 100, "metadata profile.slug"),
    title: boundedString(record.title, 300, "metadata profile.title"),
    description: nullableBoundedString(record.description, 4_000, "metadata profile.description"),
    versionNumber: positiveInteger(record.version_number, "metadata profile.version_number"),
    definition: boundedObject(record.definition, 32_768, "metadata profile.definition"),
    checksumSha256: sha256(record.checksum_sha256, "metadata profile.checksum_sha256"),
    changeMessage: nullableBoundedString(record.change_message, 500, "metadata profile.change_message"),
    createdBy: uuid(record.created_by, "metadata profile.created_by"),
    versionCreatedBy: uuid(record.version_created_by, "metadata profile.version_created_by"),
    createdAt: timestamp(record.created_at, "metadata profile.created_at"),
    updatedAt: timestamp(record.updated_at, "metadata profile.updated_at"),
    versionCreatedAt: timestamp(record.version_created_at, "metadata profile.version_created_at")
  };
}

export function parseMetadataValidation(value) {
  const record = object(value, "metadata validation");
  return {
    resourceId: uuid(record.resource_id, "metadata validation.resource_id"),
    resourceVersion: positiveInteger(record.resource_version, "metadata validation.resource_version"),
    profileId: uuid(record.profile_id, "metadata validation.profile_id"),
    profileVersion: positiveInteger(record.profile_version, "metadata validation.profile_version"),
    profileChecksumSha256: sha256(record.profile_checksum_sha256, "metadata validation.profile_checksum_sha256"),
    report: boundedObject(record.report, 16_384, "metadata validation.report")
  };
}

export function parseMetadataExport(value) {
  const record = object(value, "metadata export");
  const target = oneOf(
      record.target,
      [
        "dcat_3",
        "stac_1_1",
        "ogc_records_1_0",
        "iso_19115_3",
        "schema_org_dataset",
        "datacite_4_7",
        "datacite_4_7_xml",
        "geodcat_ap_3_1"
      ],
      "metadata export.target"
    );
  const document = record.document === null
    ? null
    : boundedObject(record.document, 65_536, "metadata export.document");
  const documentText = record.document_text === null
    ? null
    : boundedUtf8String(record.document_text, 65_536, "metadata export.document_text");
  const status = boundedString(record.status, 100, "metadata export.status");
  const xmlTarget = target === "iso_19115_3" || target === "datacite_4_7_xml";
  if (xmlTarget && document !== null) {
    contract("XML metadata export must not contain a JSON document");
  }
  if (
    xmlTarget
    && status.startsWith("mapped")
    && documentText === null
  ) {
    contract("mapped XML metadata export must contain document_text");
  }
  if (!xmlTarget && documentText !== null) {
    contract("JSON metadata export must not contain document_text");
  }
  if (document !== null && documentText !== null) {
    contract("metadata export representations are ambiguous");
  }
  return {
    target,
    targetVersion: boundedString(record.target_version, 100, "metadata export.target_version"),
    mediaType: boundedString(record.media_type, 100, "metadata export.media_type"),
    status,
    document,
    documentText,
    report: boundedObject(record.report, 16_384, "metadata export.report")
  };
}

export function parseOgcRecord(value) {
  const record = boundedObject(value, 65_536, "OGC record");
  if (record.type !== "Feature") contract("OGC record.type is invalid");
  uuid(record.id, "OGC record.id");
  if (record.geometry !== null) boundedObject(record.geometry, 16_384, "OGC record.geometry");
  const properties = object(record.properties, "OGC record.properties");
  boundedString(properties.title, 300, "OGC record.properties.title");
  const selectedLanguage = parseOgcLanguage(
    properties.language,
    "OGC record.properties.language"
  );
  const languages = parseArray(
    properties.languages,
    (item) => parseOgcLanguage(item, "OGC record alternate language"),
    "OGC record.properties.languages"
  );
  if (
    languages.length > 8
    || languages.includes(selectedLanguage)
    || new Set(languages).size !== languages.length
  ) {
    contract("OGC record.properties.languages is invalid");
  }
  if (properties.externalIds !== undefined) {
    const externalIds = parseArray(
      properties.externalIds,
      (item) => {
        const identifier = object(item, "OGC record external identifier");
        boundedString(identifier.value, 500, "OGC record external identifier.value");
        if (identifier.scheme !== undefined) {
          boundedString(identifier.scheme, 500, "OGC record external identifier.scheme");
        }
        return identifier;
      },
      "OGC record.properties.externalIds"
    );
    if (externalIds.length > 50) contract("OGC record external identifiers are too large");
  }
  const links = parseArray(record.links, parseOgcLink, "OGC record.links");
  if (links.length > 50) contract("OGC record.links is too large");
  if (!links.some((link) => link.rel === "self") || !links.some((link) => link.rel === "collection")) {
    contract("OGC record links are incomplete");
  }
  return structuredClone(record);
}

export function parseOgcRecordCollection(value) {
  const collection = boundedObject(value, 1_500_000, "OGC record collection");
  if (collection.type !== "FeatureCollection") {
    contract("OGC record collection.type is invalid");
  }
  const features = parseArray(collection.features, parseOgcRecord, "OGC record features");
  if (features.length > 20) contract("OGC record collection page is too large");
  const matched = nonNegativeInteger(collection.numberMatched, "OGC record numberMatched");
  const returned = nonNegativeInteger(collection.numberReturned, "OGC record numberReturned");
  if (returned !== features.length || returned > matched) {
    contract("OGC record collection counts are inconsistent");
  }
  timestamp(collection.timeStamp, "OGC record collection.timeStamp");
  const links = parseArray(collection.links, parseOgcLink, "OGC record collection.links");
  if (links.length > 10) contract("OGC record collection.links is too large");
  return structuredClone(collection);
}

function parseOgcLink(value) {
  const link = object(value, "OGC record link");
  boundedString(link.href, 2_048, "OGC record link.href");
  boundedString(link.rel, 100, "OGC record link.rel");
  if (link.type !== undefined) boundedString(link.type, 100, "OGC record link.type");
  if (link.hreflang !== undefined) languageTag(link.hreflang, "OGC record link.hreflang");
  return structuredClone(link);
}

function parseOgcLanguage(value, label) {
  const language = object(value, label);
  const code = languageTag(language.code, `${label}.code`);
  if (language.name !== undefined) boundedString(language.name, 100, `${label}.name`);
  if (language.alternate !== undefined) {
    boundedString(language.alternate, 100, `${label}.alternate`);
  }
  if (language.dir !== undefined) {
    oneOf(language.dir, ["ltr", "rtl", "ttb", "btt"], `${label}.dir`);
  }
  return code;
}

function parseResourceTranslations(value) {
  const translations = boundedObject(value, 16_384, "resource.translations");
  const entries = Object.entries(translations);
  if (entries.length > 8) contract("resource.translations has too many languages");
  const parsed = {};
  for (const [language, value] of entries) {
    const normalized = languageTag(language, "resource translation language");
    if (normalized !== language) contract("resource translation language is not normalized");
    const translation = object(value, `resource.translations.${language}`);
    const keywords = parseArray(
      translation.keywords ?? [],
      (keyword) => boundedString(keyword, 200, "resource translated keyword"),
      `resource.translations.${language}.keywords`
    );
    if (keywords.length > 64 || new Set(keywords.map((item) => item.toLowerCase())).size !== keywords.length) {
      contract(`resource.translations.${language}.keywords is invalid`);
    }
    parsed[language] = {
      title: boundedString(translation.title, 300, `resource.translations.${language}.title`),
      abstract: nullableBoundedString(
        translation.abstract ?? null,
        8_000,
        `resource.translations.${language}.abstract`
      ),
      attribution: nullableBoundedString(
        translation.attribution ?? null,
        2_000,
        `resource.translations.${language}.attribution`
      ),
      keywords
    };
  }
  return parsed;
}

export function parseMetadataSource(value) {
  const record = object(value, "metadata source");
  const sourceFormat = oneOf(
    record.source_format,
    [
      "dcat_3",
      "stac_1_1",
      "iso_19115_3",
      "schema_org_dataset",
      "datacite_4_7",
      "geodcat_ap_3_1"
    ],
    "metadata source.source_format"
  );
  const sourceSha256 = sha256(record.source_sha256, "metadata source.source_sha256");
  const checksumBasis = oneOf(
    record.checksum_basis,
    ["canonical_json", "raw_utf8"],
    "metadata source.checksum_basis"
  );
  const canonicalJsonSha256 = record.canonical_json_sha256 === null
    ? null
    : sha256(record.canonical_json_sha256, "metadata source.canonical_json_sha256");
  if (sourceFormat === "iso_19115_3") {
    if (checksumBasis !== "raw_utf8" || canonicalJsonSha256 !== null) {
      contract("ISO metadata source checksum basis is invalid");
    }
  } else if (checksumBasis !== "canonical_json" || canonicalJsonSha256 !== sourceSha256) {
    contract("JSON metadata source checksum basis is invalid");
  }
  return {
    id: uuid(record.id, "metadata source.id"),
    resourceId: uuid(record.resource_id, "metadata source.resource_id"),
    resourceVersionId: uuid(
      record.resource_version_id,
      "metadata source.resource_version_id"
    ),
    sourceFormat,
    sourceVersion: boundedString(record.source_version, 100, "metadata source.source_version"),
    sourceNamespace: boundedString(
      record.source_namespace,
      100,
      "metadata source.source_namespace"
    ),
    sourceIdentifier: boundedString(
      record.source_identifier,
      500,
      "metadata source.source_identifier"
    ),
    document: record.source_format === "iso_19115_3"
      ? boundedUtf8String(record.document, 49_152, "metadata source.document")
      : boundedObject(record.document, 49_152, "metadata source.document"),
    sourceSha256,
    checksumBasis,
    canonicalJsonSha256,
    conversionReport: boundedObject(
      record.conversion_report,
      16_384,
      "metadata source.conversion_report"
    ),
    importedBy: uuid(record.imported_by, "metadata source.imported_by"),
    importedAt: timestamp(record.imported_at, "metadata source.imported_at")
  };
}

export function parseMetadataImport(value) {
  const record = object(value, "metadata import");
  return {
    idempotent: boolean(record.idempotent, "metadata import.idempotent"),
    resource: parseGovernedResource(record.resource),
    source: parseMetadataSource(record.source)
  };
}

export function parseResourcePermission(value) {
  const record = object(value, "resource permission");
  return {
    userId: uuid(record.user_id, "resource permission.user_id"),
    email: boundedString(record.email, 320, "resource permission.email"),
    displayName: boundedString(record.display_name, 200, "resource permission.display_name"),
    role: oneOf(record.role, ["manage", "edit", "publish", "view"], "resource permission.role"),
    grantedBy: uuid(record.granted_by, "resource permission.granted_by"),
    createdAt: timestamp(record.created_at, "resource permission.created_at"),
    updatedAt: timestamp(record.updated_at, "resource permission.updated_at")
  };
}

export function parseResourceStyle(value) {
  const record = object(value, "resource style");
  return {
    id: uuid(record.id, "resource style.id"),
    resourceId: uuid(record.resource_id, "resource style.resource_id"),
    slug: boundedString(record.slug, 100, "resource style.slug"),
    format: oneOf(
      record.format,
      ["maplibre", "geostyler", "sld_1_0", "sld_1_1", "mapserver_mapfile"],
      "resource style.format"
    ),
    versionNumber: positiveInteger(record.version_number, "resource style.version_number"),
    archived: record.archived === undefined ? false : boolean(record.archived, "resource style.archived"),
    title: boundedString(record.title, 300, "resource style.title"),
    mediaType: boundedString(record.media_type, 129, "resource style.media_type"),
    definition: boundedString(record.definition, 49_152, "resource style.definition"),
    checksumSha256: sha256(record.checksum_sha256, "resource style.checksum_sha256"),
    changeMessage: nullableBoundedString(record.change_message, 500, "resource style.change_message"),
    createdBy: uuid(record.created_by, "resource style.created_by"),
    createdAt: timestamp(record.created_at, "resource style.created_at"),
    updatedAt: timestamp(record.updated_at, "resource style.updated_at")
  };
}

export function parseMapServerStyleImport(value) {
  const record = object(value, "MapServer style import");
  const style = parseResourceStyle(record.style);
  const activation = object(record.activation, "MapServer style import.activation");
  const styleId = uuid(activation.style_id, "MapServer style import.activation.style_id");
  if (styleId !== style.id) contract("MapServer style import activation style changed");
  const requestLimits = parseMapServerRequestLimits(record.request_limits);
  return {
    style,
    canonicalMapfile: boundedUtf8String(
      record.canonical_mapfile, 49_152, "MapServer style import.canonical_mapfile"
    ),
    report: boundedObject(record.report, 32_768, "MapServer style import.report"),
    activation: {
      styleId,
      geometryLayerId: boundedString(
        activation.geometry_layer_id, 100, "MapServer style import.activation.geometry_layer_id"
      ),
      labelLayerId: nullableBoundedString(
        activation.label_layer_id, 100, "MapServer style import.activation.label_layer_id"
      ),
      minimumScaleDenominator: activation.minimum_scale_denominator === null
        ? null
        : finiteNumber(
          activation.minimum_scale_denominator,
          "MapServer style import.activation.minimum_scale_denominator"
        ),
      maximumScaleDenominator: activation.maximum_scale_denominator === null
        ? null
        : finiteNumber(
          activation.maximum_scale_denominator,
          "MapServer style import.activation.maximum_scale_denominator"
        ),
      includeLegend: boolean(
        activation.include_legend, "MapServer style import.activation.include_legend"
      )
    },
    requestLimits
  };
}

export function parseMapServerStyleExport(value) {
  const record = object(value, "MapServer style export");
  return {
    styleId: uuid(record.style_id, "MapServer style export.style_id"),
    filename: boundedString(record.filename, 120, "MapServer style export.filename"),
    mediaType: oneOf(
      record.media_type,
      ["text/vnd.mapserver.mapfile"],
      "MapServer style export.media_type"
    ),
    mapfile: boundedUtf8String(record.mapfile, 49_152, "MapServer style export.mapfile"),
    report: boundedObject(record.report, 32_768, "MapServer style export.report")
  };
}

function parseMapServerRequestLimits(value) {
  const record = object(value, "MapServer request limits");
  exactKeys(record, [
    "requests_per_minute",
    "concurrent_requests_per_project",
    "maximum_layers_per_request",
    "maximum_width",
    "maximum_height",
    "maximum_pixels",
    "maximum_runtime_seconds"
  ], "MapServer request limits");
  return {
    requestsPerMinute: integerBetween(
      record.requests_per_minute, 1, 600, "MapServer request limits.requests_per_minute"
    ),
    concurrentRequestsPerProject: integerBetween(
      record.concurrent_requests_per_project,
      1,
      16,
      "MapServer request limits.concurrent_requests_per_project"
    ),
    maximumLayersPerRequest: integerBetween(
      record.maximum_layers_per_request,
      1,
      16,
      "MapServer request limits.maximum_layers_per_request"
    ),
    maximumWidth: integerBetween(
      record.maximum_width, 1, 2048, "MapServer request limits.maximum_width"
    ),
    maximumHeight: integerBetween(
      record.maximum_height, 1, 2048, "MapServer request limits.maximum_height"
    ),
    maximumPixels: integerBetween(
      record.maximum_pixels, 1, 4_194_304, "MapServer request limits.maximum_pixels"
    ),
    maximumRuntimeSeconds: integerBetween(
      record.maximum_runtime_seconds,
      1,
      8,
      "MapServer request limits.maximum_runtime_seconds"
    )
  };
}

export function parseRenderProfile(value) {
  const record = object(value, "render profile");
  return {
    id: uuid(record.id, "render profile.id"),
    projectId: uuid(record.project_id, "render profile.project_id"),
    resourceId: uuid(record.resource_id, "render profile.resource_id"),
    slug: boundedString(record.slug, 100, "render profile.slug"),
    versionNumber: positiveInteger(record.version_number, "render profile.version_number"),
    title: boundedString(record.title, 300, "render profile.title"),
    resourceVersionId: uuid(record.resource_version_id, "render profile.resource_version_id"),
    datasetId: uuid(record.dataset_id, "render profile.dataset_id"),
    datasetVersionId: uuid(record.dataset_version_id, "render profile.dataset_version_id"),
    styleId: uuid(record.style_id, "render profile.style_id"),
    styleVersionId: uuid(record.style_version_id, "render profile.style_version_id"),
    configuration: boundedObject(record.configuration, 32_768, "render profile.configuration"),
    checksumSha256: sha256(record.checksum_sha256, "render profile.checksum_sha256"),
    changeMessage: nullableBoundedString(record.change_message, 500, "render profile.change_message"),
    createdBy: uuid(record.created_by, "render profile.created_by"),
    createdAt: timestamp(record.created_at, "render profile.created_at"),
    updatedAt: timestamp(record.updated_at, "render profile.updated_at")
  };
}

export function parseWmsPublication(value) {
  const record = object(value, "WMS publication");
  const name = string(record.name, "WMS publication.name");
  if (!WMS_PUBLICATION_NAME_PATTERN.test(name)) {
    contract("WMS publication.name is invalid");
  }
  return {
    id: uuid(record.id, "WMS publication.id"),
    projectId: uuid(record.project_id, "WMS publication.project_id"),
    resourceId: uuid(record.resource_id, "WMS publication.resource_id"),
    name,
    defaultProfileId: uuid(
      record.default_profile_id,
      "WMS publication.default_profile_id"
    ),
    createdBy: uuid(record.created_by, "WMS publication.created_by"),
    createdAt: timestamp(record.created_at, "WMS publication.created_at"),
    withdrawnBy: nullableUuid(record.withdrawn_by, "WMS publication.withdrawn_by"),
    withdrawnAt: nullableTimestamp(record.withdrawn_at, "WMS publication.withdrawn_at")
  };
}

export function parsePublicWmsService(value) {
  const record = object(value, "public WMS service");
  return {
    id: uuid(record.id, "public WMS service.id"),
    projectId: uuid(record.project_id, "public WMS service.project_id"),
    title: boundedString(record.title, 200, "public WMS service.title"),
    createdBy: uuid(record.created_by, "public WMS service.created_by"),
    createdAt: timestamp(record.created_at, "public WMS service.created_at"),
    disabledBy: nullableUuid(record.disabled_by, "public WMS service.disabled_by"),
    disabledAt: nullableTimestamp(record.disabled_at, "public WMS service.disabled_at")
  };
}

export function parseSpatialService(value) {
  const record = object(value, "spatial service");
  const slug = boundedString(record.slug, 100, "spatial service.slug");
  if (!SPATIAL_SERVICE_SLUG_PATTERN.test(slug)) {
    contract("spatial service.slug is invalid");
  }
  return {
    id: uuid(record.id, "spatial service.id"),
    projectId: uuid(record.project_id, "spatial service.project_id"),
    slug,
    title: boundedString(record.title, 200, "spatial service.title"),
    description: nullableBoundedString(
      record.description,
      2000,
      "spatial service.description"
    ),
    createdBy: uuid(record.created_by, "spatial service.created_by"),
    createdAt: timestamp(record.created_at, "spatial service.created_at"),
    disabledBy: nullableUuid(record.disabled_by, "spatial service.disabled_by"),
    disabledAt: nullableTimestamp(record.disabled_at, "spatial service.disabled_at")
  };
}

export function parseSpatialServiceMetadata(value) {
  const record = object(value, "spatial service metadata");
  exactKeys(record, [
    "version_id", "service_id", "version_number", "title", "abstract",
    "namespace_uri", "keywords", "fees", "access_constraints", "contact",
    "enabled_protocols", "change_message", "created_by", "created_at"
  ], "spatial service metadata");
  const keywords = uniqueBoundedStringArray(
    record.keywords, 32, 300, "spatial service metadata.keywords"
  );
  const accessConstraints = uniqueBoundedStringArray(
    record.access_constraints, 16, 300, "spatial service metadata.access_constraints"
  );
  const enabledProtocols = uniqueBoundedStringArray(
    record.enabled_protocols, 8, 40, "spatial service metadata.enabled_protocols"
  );
  for (const protocol of enabledProtocols) {
    oneOf(protocol, [
      "ogc_api_features", "wfs_2_0", "wms_1_1", "wms_1_3",
      "wmts_1_0", "wcs_2_0", "arcgis_features"
    ], "spatial service metadata.enabled_protocols");
  }
  const namespaceUri = nullableBoundedString(
    record.namespace_uri, 2048, "spatial service metadata.namespace_uri"
  );
  if (namespaceUri !== null) {
    let parsed;
    try {
      parsed = new URL(namespaceUri);
    } catch (cause) {
      contract("spatial service metadata.namespace_uri is invalid", cause);
    }
    if (!parsed || !["http:", "https:"].includes(parsed.protocol)
      || parsed.username || parsed.password) {
      contract("spatial service metadata.namespace_uri is invalid");
    }
  }
  return {
    versionId: uuid(record.version_id, "spatial service metadata.version_id"),
    serviceId: uuid(record.service_id, "spatial service metadata.service_id"),
    versionNumber: positiveInteger(
      record.version_number, "spatial service metadata.version_number"
    ),
    title: boundedString(record.title, 200, "spatial service metadata.title"),
    abstract: nullableBoundedString(
      record.abstract, 8000, "spatial service metadata.abstract"
    ),
    namespaceUri,
    keywords,
    fees: nullableBoundedString(record.fees, 1000, "spatial service metadata.fees"),
    accessConstraints,
    contact: boundedObject(record.contact, 4096, "spatial service metadata.contact"),
    enabledProtocols,
    changeMessage: nullableBoundedString(
      record.change_message, 500, "spatial service metadata.change_message"
    ),
    createdBy: uuid(record.created_by, "spatial service metadata.created_by"),
    createdAt: timestamp(record.created_at, "spatial service metadata.created_at")
  };
}

export function parseSpatialServiceStore(value) {
  const record = object(value, "spatial service store");
  exactKeys(record, [
    "id", "project_id", "service_id", "slug", "title", "description", "kind",
    "dataset_id", "external_connection_id", "sealed_source_revision_number",
    "sealed_connection_revision_number", "configuration", "created_by", "created_at",
    "disabled_by", "disabled_at"
  ], "spatial service store");
  const slug = boundedString(record.slug, 100, "spatial service store.slug");
  if (!SPATIAL_SERVICE_SLUG_PATTERN.test(slug)) {
    contract("spatial service store.slug is invalid");
  }
  const kind = oneOf(
    record.kind,
    ["managed_project", "external_source", "postgresql_connection"],
    "spatial service store.kind"
  );
  const datasetId = nullableUuid(record.dataset_id, "spatial service store.dataset_id");
  const externalConnectionId = nullableUuid(
    record.external_connection_id, "spatial service store.external_connection_id"
  );
  const sealedSourceRevisionNumber = nullablePositiveInteger(
    record.sealed_source_revision_number,
    "spatial service store.sealed_source_revision_number"
  );
  const sealedConnectionRevisionNumber = nullablePositiveInteger(
    record.sealed_connection_revision_number,
    "spatial service store.sealed_connection_revision_number"
  );
  const shape = kind === "managed_project"
    ? datasetId === null && externalConnectionId === null
      && sealedSourceRevisionNumber === null && sealedConnectionRevisionNumber === null
    : kind === "external_source"
      ? datasetId !== null && externalConnectionId === null
        && sealedSourceRevisionNumber !== null && sealedConnectionRevisionNumber === null
      : datasetId === null && externalConnectionId !== null
        && sealedSourceRevisionNumber === null && sealedConnectionRevisionNumber !== null;
  if (!shape) contract("spatial service store binding shape is invalid");
  return {
    id: uuid(record.id, "spatial service store.id"),
    projectId: uuid(record.project_id, "spatial service store.project_id"),
    serviceId: uuid(record.service_id, "spatial service store.service_id"),
    slug,
    title: boundedString(record.title, 200, "spatial service store.title"),
    description: nullableBoundedString(
      record.description, 2000, "spatial service store.description"
    ),
    kind,
    datasetId,
    externalConnectionId,
    sealedSourceRevisionNumber,
    sealedConnectionRevisionNumber,
    configuration: boundedObject(
      record.configuration, 8192, "spatial service store.configuration"
    ),
    createdBy: uuid(record.created_by, "spatial service store.created_by"),
    createdAt: timestamp(record.created_at, "spatial service store.created_at"),
    disabledBy: nullableUuid(record.disabled_by, "spatial service store.disabled_by"),
    disabledAt: nullableTimestamp(record.disabled_at, "spatial service store.disabled_at")
  };
}

export function parseSpatialServiceLayerGroup(value) {
  const record = object(value, "spatial service layer group");
  exactKeys(record, [
    "id", "project_id", "service_id", "slug", "version_id", "version_number",
    "title", "description", "mode", "member_collection_ids", "change_message",
    "created_by", "created_at", "updated_by", "updated_at", "disabled_by", "disabled_at"
  ], "spatial service layer group");
  const slug = boundedString(record.slug, 100, "spatial service layer group.slug");
  if (!SPATIAL_SERVICE_SLUG_PATTERN.test(slug)) {
    contract("spatial service layer group.slug is invalid");
  }
  if (!Array.isArray(record.member_collection_ids)
    || record.member_collection_ids.length < 1
    || record.member_collection_ids.length > 64) {
    contract("spatial service layer group.member_collection_ids is invalid");
  }
  const memberCollectionIds = record.member_collection_ids.map((entry) => uuid(
    entry, "spatial service layer group.member_collection_ids"
  ));
  if (new Set(memberCollectionIds).size !== memberCollectionIds.length) {
    contract("spatial service layer group members are duplicated");
  }
  return {
    id: uuid(record.id, "spatial service layer group.id"),
    projectId: uuid(record.project_id, "spatial service layer group.project_id"),
    serviceId: uuid(record.service_id, "spatial service layer group.service_id"),
    slug,
    versionId: uuid(record.version_id, "spatial service layer group.version_id"),
    versionNumber: positiveInteger(
      record.version_number, "spatial service layer group.version_number"
    ),
    title: boundedString(record.title, 300, "spatial service layer group.title"),
    description: nullableBoundedString(
      record.description, 2000, "spatial service layer group.description"
    ),
    mode: oneOf(
      record.mode,
      ["single", "opaque_container", "named", "container", "earth_observation"],
      "spatial service layer group.mode"
    ),
    memberCollectionIds,
    changeMessage: nullableBoundedString(
      record.change_message, 500, "spatial service layer group.change_message"
    ),
    createdBy: uuid(record.created_by, "spatial service layer group.created_by"),
    createdAt: timestamp(record.created_at, "spatial service layer group.created_at"),
    updatedBy: uuid(record.updated_by, "spatial service layer group.updated_by"),
    updatedAt: timestamp(record.updated_at, "spatial service layer group.updated_at"),
    disabledBy: nullableUuid(record.disabled_by, "spatial service layer group.disabled_by"),
    disabledAt: nullableTimestamp(record.disabled_at, "spatial service layer group.disabled_at")
  };
}

export function parseSpatialServiceCollectionStyle(value) {
  const record = object(value, "spatial service collection style");
  exactKeys(record, [
    "id", "project_id", "service_id", "collection_id", "style_name", "style_id",
    "sealed_style_version_id", "sealed_style_version_number",
    "current_style_version_id", "current_style_version_number", "render_profile_id",
    "sealed_profile_version_id", "sealed_profile_version_number",
    "current_profile_version_id", "current_profile_version_number", "consumable",
    "stale", "is_default",
    "created_by", "created_at", "withdrawn_by", "withdrawn_at"
  ], "spatial service collection style");
  const styleName = boundedString(
    record.style_name, 100, "spatial service collection style.style_name"
  );
  if (!SPATIAL_SERVICE_SLUG_PATTERN.test(styleName)) {
    contract("spatial service collection style.style_name is invalid");
  }
  const sealedStyleVersionId = uuid(
    record.sealed_style_version_id,
    "spatial service collection style.sealed_style_version_id"
  );
  const sealedStyleVersionNumber = positiveInteger(
    record.sealed_style_version_number,
    "spatial service collection style.sealed_style_version_number"
  );
  const currentStyleVersionId = uuid(
    record.current_style_version_id,
    "spatial service collection style.current_style_version_id"
  );
  const currentStyleVersionNumber = positiveInteger(
    record.current_style_version_number,
    "spatial service collection style.current_style_version_number"
  );
  const renderProfileId = nullableUuid(
    record.render_profile_id, "spatial service collection style.render_profile_id"
  );
  const sealedProfileVersionId = nullableUuid(
    record.sealed_profile_version_id,
    "spatial service collection style.sealed_profile_version_id"
  );
  const sealedProfileVersionNumber = nullablePositiveInteger(
    record.sealed_profile_version_number,
    "spatial service collection style.sealed_profile_version_number"
  );
  const currentProfileVersionId = nullableUuid(
    record.current_profile_version_id,
    "spatial service collection style.current_profile_version_id"
  );
  const currentProfileVersionNumber = nullablePositiveInteger(
    record.current_profile_version_number,
    "spatial service collection style.current_profile_version_number"
  );
  const stale = boolean(record.stale, "spatial service collection style.stale");
  const consumable = boolean(
    record.consumable, "spatial service collection style.consumable"
  );
  const withdrawnAt = nullableTimestamp(
    record.withdrawn_at, "spatial service collection style.withdrawn_at"
  );
  const expectedStale = withdrawnAt === null && (
    sealedStyleVersionId !== currentStyleVersionId
    || sealedStyleVersionNumber !== currentStyleVersionNumber
    || (renderProfileId !== null && (
      sealedProfileVersionId !== currentProfileVersionId
      || sealedProfileVersionNumber !== currentProfileVersionNumber
    ))
  );
  if (stale !== expectedStale) {
    contract("spatial service collection style.stale is inconsistent");
  }
  const expectedConsumable = withdrawnAt === null && renderProfileId !== null
    && sealedProfileVersionId !== null && sealedProfileVersionNumber !== null && !stale;
  if (consumable !== expectedConsumable) {
    contract("spatial service collection style.consumable is inconsistent");
  }
  return {
    id: uuid(record.id, "spatial service collection style.id"),
    projectId: uuid(record.project_id, "spatial service collection style.project_id"),
    serviceId: uuid(record.service_id, "spatial service collection style.service_id"),
    collectionId: uuid(
      record.collection_id, "spatial service collection style.collection_id"
    ),
    styleName,
    styleId: uuid(record.style_id, "spatial service collection style.style_id"),
    sealedStyleVersionId,
    sealedStyleVersionNumber,
    currentStyleVersionId,
    currentStyleVersionNumber,
    renderProfileId,
    sealedProfileVersionId,
    sealedProfileVersionNumber,
    currentProfileVersionId,
    currentProfileVersionNumber,
    consumable,
    stale,
    isDefault: boolean(record.is_default, "spatial service collection style.is_default"),
    createdBy: uuid(record.created_by, "spatial service collection style.created_by"),
    createdAt: timestamp(record.created_at, "spatial service collection style.created_at"),
    withdrawnBy: nullableUuid(
      record.withdrawn_by, "spatial service collection style.withdrawn_by"
    ),
    withdrawnAt
  };
}

export function parseSpatialServiceCatalog(value) {
  const record = object(value, "spatial service catalog");
  exactKeys(record, [
    "metadata", "stores", "layer_groups", "styles", "limits", "semantics"
  ], "spatial service catalog");
  const limits = boundedObject(record.limits, 4096, "spatial service catalog.limits");
  for (const [key, maximum] of Object.entries({
    storesPerService: 16,
    layerGroupsPerService: 64,
    membersPerLayerGroup: 64,
    stylesPerCollection: 8,
    keywordsPerService: 32,
    accessConstraintsPerService: 16,
    bulkOperations: 64,
    bulkRequestBytes: 262_144
  })) {
    if (limits[key] !== maximum) contract(`spatial service catalog.limits.${key} is invalid`);
  }
  const semantics = boundedObject(
    record.semantics, 4096, "spatial service catalog.semantics"
  );
  if (semantics.layerOrder !== "the first layer-group member draws on top"
    || semantics.bulk !== "all operations commit together or none commit") {
    contract("spatial service catalog semantics are invalid");
  }
  return {
    metadata: parseSpatialServiceMetadata(record.metadata),
    stores: parseArray(record.stores, parseSpatialServiceStore, "spatial service stores"),
    layerGroups: parseArray(
      record.layer_groups, parseSpatialServiceLayerGroup, "spatial service layer groups"
    ),
    styles: parseArray(
      record.styles, parseSpatialServiceCollectionStyle, "spatial service collection styles"
    ),
    limits,
    semantics
  };
}

export function parseSpatialServiceCatalogBulk(value) {
  const record = object(value, "spatial service catalog bulk result");
  exactKeys(record, [
    "applied_operations", "operation_results", "catalog"
  ], "spatial service catalog bulk result");
  const appliedOperations = positiveInteger(
    record.applied_operations, "spatial service catalog bulk result.applied_operations"
  );
  if (!Array.isArray(record.operation_results)
    || record.operation_results.length !== appliedOperations
    || appliedOperations > 64) {
    contract("spatial service catalog bulk result operation count is invalid");
  }
  return {
    appliedOperations,
    operationResults: record.operation_results.map((item) => boundedObject(
      item, 4096, "spatial service catalog bulk result.operation_results"
    )),
    catalog: parseSpatialServiceCatalog(record.catalog)
  };
}

export function parseSpatialServiceCollection(value) {
  const record = object(value, "spatial service collection");
  const collectionName = boundedString(
    record.collection_name,
    100,
    "spatial service collection.collection_name"
  );
  if (!SPATIAL_SERVICE_SLUG_PATTERN.test(collectionName)) {
    contract("spatial service collection.collection_name is invalid");
  }
  const sealedFeatureGeneration = positiveInteger(
    record.sealed_feature_generation,
    "spatial service collection.sealed_feature_generation"
  );
  const sealedProfileVersionNumber = positiveInteger(
    record.sealed_profile_version_number,
    "spatial service collection.sealed_profile_version_number"
  );
  const currentFeatureGeneration = positiveInteger(
    record.current_feature_generation,
    "spatial service collection.current_feature_generation"
  );
  const currentProfileVersionNumber = positiveInteger(
    record.current_profile_version_number,
    "spatial service collection.current_profile_version_number"
  );
  const stale = boolean(record.stale, "spatial service collection.stale");
  const targetActive = boolean(
    record.target_active,
    "spatial service collection.target_active"
  );
  const expectedStale = !targetActive
    || sealedFeatureGeneration !== currentFeatureGeneration
    || sealedProfileVersionNumber !== currentProfileVersionNumber
    || record.sealed_profile_version_id !== record.current_profile_version_id;
  if (stale !== expectedStale) {
    contract("spatial service collection.stale is inconsistent");
  }
  return {
    id: uuid(record.id, "spatial service collection.id"),
    projectId: uuid(record.project_id, "spatial service collection.project_id"),
    serviceId: uuid(record.service_id, "spatial service collection.service_id"),
    collectionName,
    datasetId: uuid(record.dataset_id, "spatial service collection.dataset_id"),
    resourceId: uuid(record.resource_id, "spatial service collection.resource_id"),
    defaultProfileId: uuid(
      record.default_profile_id,
      "spatial service collection.default_profile_id"
    ),
    sealedFeatureGeneration,
    sealedProfileVersionId: uuid(
      record.sealed_profile_version_id,
      "spatial service collection.sealed_profile_version_id"
    ),
    sealedProfileVersionNumber,
    currentFeatureGeneration,
    currentProfileVersionId: uuid(
      record.current_profile_version_id,
      "spatial service collection.current_profile_version_id"
    ),
    currentProfileVersionNumber,
    stale,
    targetActive,
    title: boundedString(record.title, 300, "spatial service collection.title"),
    description: nullableBoundedString(
      record.description,
      2000,
      "spatial service collection.description"
    ),
    createdBy: uuid(record.created_by, "spatial service collection.created_by"),
    createdAt: timestamp(record.created_at, "spatial service collection.created_at"),
    withdrawnBy: nullableUuid(
      record.withdrawn_by,
      "spatial service collection.withdrawn_by"
    ),
    withdrawnAt: nullableTimestamp(
      record.withdrawn_at,
      "spatial service collection.withdrawn_at"
    )
  };
}

function tileSeedSelectorBody(value) {
  const selector = object(value, "tile seed selector");
  if (!Number.isSafeInteger(selector.expectedCacheVersion)
    || selector.expectedCacheVersion < 1) {
    throw new TypeError("tile seed cache version is invalid");
  }
  if (selector.mode === "tiles") {
    if (!Array.isArray(selector.tiles) || !selector.tiles.length || selector.tiles.length > 64) {
      throw new TypeError("tile seed coordinates are invalid");
    }
    const tiles = selector.tiles.map((value, index) => {
      const coordinate = object(value, `tile seed coordinate ${index + 1}`);
      for (const [name, maximum] of [
        ["tileMatrix", 22], ["tileRow", (1 << 22) - 1], ["tileCol", (1 << 22) - 1]
      ]) {
        if (!Number.isSafeInteger(coordinate[name])
          || coordinate[name] < 0 || coordinate[name] > maximum) {
          throw new TypeError(`tile seed coordinate ${name} is invalid`);
        }
      }
      if (coordinate.tileRow >= 2 ** coordinate.tileMatrix
        || coordinate.tileCol >= 2 ** coordinate.tileMatrix) {
        throw new TypeError("tile seed coordinate is outside its matrix");
      }
      return {
        tile_matrix: coordinate.tileMatrix,
        tile_row: coordinate.tileRow,
        tile_col: coordinate.tileCol
      };
    });
    if (new Set(tiles.map((tile) => `${tile.tile_matrix}/${tile.tile_row}/${tile.tile_col}`)).size
      !== tiles.length) {
      throw new TypeError("tile seed coordinates must be unique");
    }
    return {
      expected_cache_version: selector.expectedCacheVersion,
      mode: "tiles",
      tiles
    };
  }
  if (selector.mode !== "bbox" || !Array.isArray(selector.bbox)
    || selector.bbox.length !== 4 || !selector.bbox.every(Number.isFinite)
    || !Number.isSafeInteger(selector.minimumTileMatrix)
    || !Number.isSafeInteger(selector.maximumTileMatrix)
    || selector.minimumTileMatrix < 0
    || selector.maximumTileMatrix < selector.minimumTileMatrix
    || selector.maximumTileMatrix > 22) {
    throw new TypeError("tile seed bbox selector is invalid");
  }
  const [west, south, east, north] = selector.bbox;
  if (!(west >= -180 && west < east && east <= 180
    && south >= -85.05112878 && south < north && north <= 85.05112878)) {
    throw new TypeError("tile seed bbox is outside Web Mercator");
  }
  return {
    expected_cache_version: selector.expectedCacheVersion,
    mode: "bbox",
    bbox: [...selector.bbox],
    minimum_tile_matrix: selector.minimumTileMatrix,
    maximum_tile_matrix: selector.maximumTileMatrix
  };
}

export function parseTileCachePolicy(value) {
  const record = object(value, "tile cache policy");
  exactKeys(record, [
    "id", "project_id", "service_id", "binding_id", "version_id",
    "version_number", "minimum_tile_matrix", "maximum_tile_matrix",
    "maximum_entries", "current_entries", "change_message", "created_by",
    "created_at", "updated_by", "updated_at", "cache_mode",
    "fixed_inactive_compute_cost"
  ], "tile cache policy");
  const minimumTileMatrix = integerBetween(
    record.minimum_tile_matrix, 0, 22, "tile cache policy.minimum_tile_matrix"
  );
  return {
    id: uuid(record.id, "tile cache policy.id"),
    projectId: uuid(record.project_id, "tile cache policy.project_id"),
    serviceId: uuid(record.service_id, "tile cache policy.service_id"),
    bindingId: uuid(record.binding_id, "tile cache policy.binding_id"),
    versionId: uuid(record.version_id, "tile cache policy.version_id"),
    versionNumber: positiveInteger(record.version_number, "tile cache policy.version_number"),
    minimumTileMatrix,
    maximumTileMatrix: integerBetween(
      record.maximum_tile_matrix, minimumTileMatrix, 22,
      "tile cache policy.maximum_tile_matrix"
    ),
    maximumEntries: integerBetween(
      record.maximum_entries, 1, 10_000, "tile cache policy.maximum_entries"
    ),
    currentEntries: integerBetween(
      record.current_entries, 0, 10_000, "tile cache policy.current_entries"
    ),
    changeMessage: nullableBoundedString(
      record.change_message, 500, "tile cache policy.change_message"
    ),
    createdBy: uuid(record.created_by, "tile cache policy.created_by"),
    createdAt: timestamp(record.created_at, "tile cache policy.created_at"),
    updatedBy: uuid(record.updated_by, "tile cache policy.updated_by"),
    updatedAt: timestamp(record.updated_at, "tile cache policy.updated_at"),
    cacheMode: oneOf(record.cache_mode, ["seeded-cache-only"], "tile cache policy.mode"),
    fixedInactiveComputeCost: oneOf(
      record.fixed_inactive_compute_cost, ["$0"], "tile cache policy.inactive cost"
    )
  };
}

function parseTileCoordinate(value, label = "tile coordinate") {
  const record = object(value, label);
  const tileMatrix = integerBetween(record.tile_matrix, 0, 22, `${label}.tile_matrix`);
  const tileRow = integerBetween(record.tile_row, 0, 2 ** tileMatrix - 1, `${label}.tile_row`);
  const tileCol = integerBetween(record.tile_col, 0, 2 ** tileMatrix - 1, `${label}.tile_col`);
  return {tileMatrix, tileRow, tileCol};
}

function parseTileSeedBbox(value, label) {
  if (value === null) return null;
  const bbox = parseArray(value, (item) => finiteNumber(item, label), label);
  if (bbox.length !== 4 || !(bbox[0] >= -180 && bbox[0] < bbox[2] && bbox[2] <= 180
    && bbox[1] >= -85.05112878 && bbox[1] < bbox[3] && bbox[3] <= 85.05112878)) {
    contract(`${label} is invalid`);
  }
  return bbox;
}

export function parseTileSeedPlanPreview(value) {
  const record = object(value, "tile seed plan preview");
  exactKeys(record, [
    "cache_id", "cache_version_id", "cache_version_number", "mode", "bbox",
    "minimum_tile_matrix", "maximum_tile_matrix", "requested_count",
    "existing_count", "target_count", "targets", "expires_at",
    "preview_checksum_sha256", "expansion_order", "batch_limit",
    "confirmation_required", "ordinary_reads_create_work",
    "fixed_inactive_compute_cost"
  ], "tile seed plan preview");
  const minimumTileMatrix = integerBetween(
    record.minimum_tile_matrix, 0, 22, "tile seed preview.minimum_tile_matrix"
  );
  const requestedCount = integerBetween(
    record.requested_count, 1, 64, "tile seed preview.requested_count"
  );
  const existingCount = integerBetween(
    record.existing_count, 0, requestedCount, "tile seed preview.existing_count"
  );
  const targets = parseArray(record.targets, parseTileCoordinate, "tile seed preview.targets");
  const targetCount = integerBetween(
    record.target_count, 0, 64, "tile seed preview.target_count"
  );
  if (targets.length !== targetCount || requestedCount !== existingCount + targetCount) {
    contract("tile seed preview counts are inconsistent");
  }
  return {
    cacheId: uuid(record.cache_id, "tile seed preview.cache_id"),
    cacheVersionId: uuid(record.cache_version_id, "tile seed preview.cache_version_id"),
    cacheVersionNumber: positiveInteger(
      record.cache_version_number, "tile seed preview.cache_version_number"
    ),
    mode: oneOf(record.mode, ["tiles", "bbox"], "tile seed preview.mode"),
    bbox: parseTileSeedBbox(record.bbox, "tile seed preview.bbox"),
    minimumTileMatrix,
    maximumTileMatrix: integerBetween(
      record.maximum_tile_matrix, minimumTileMatrix, 22,
      "tile seed preview.maximum_tile_matrix"
    ),
    requestedCount,
    existingCount,
    targetCount,
    targets,
    expiresAt: timestamp(record.expires_at, "tile seed preview.expires_at"),
    previewChecksumSha256: sha256(
      record.preview_checksum_sha256, "tile seed preview.checksum"
    ),
    expansionOrder: oneOf(
      record.expansion_order, ["tile_matrix,tile_row,tile_col"],
      "tile seed preview.expansion_order"
    ),
    batchLimit: integerBetween(record.batch_limit, 64, 64, "tile seed preview.batch_limit"),
    confirmationRequired: oneOf(
      record.confirmation_required, [true], "tile seed preview.confirmation_required"
    ),
    ordinaryReadsCreateWork: oneOf(
      record.ordinary_reads_create_work, [false], "tile seed preview.read activation"
    ),
    fixedInactiveComputeCost: oneOf(
      record.fixed_inactive_compute_cost, ["$0"], "tile seed preview.inactive cost"
    )
  };
}

export function parseTileSeedPlan(value) {
  const record = object(value, "tile seed plan");
  exactKeys(record, [
    "id", "cache_id", "cache_version_id", "cache_version_number", "mode", "bbox",
    "minimum_tile_matrix", "maximum_tile_matrix", "requested_count",
    "existing_count", "target_count", "preview_checksum_sha256",
    "preview_expires_at", "state", "error_code", "created_by", "created_at",
    "dispatch_started_at", "started_at", "finished_at", "items",
    "cancel_available", "activation", "ordinary_reads_create_work",
    "fixed_inactive_compute_cost"
  ], "tile seed plan");
  const minimumTileMatrix = integerBetween(
    record.minimum_tile_matrix, 0, 22, "tile seed plan.minimum_tile_matrix"
  );
  const requestedCount = integerBetween(
    record.requested_count, 1, 64, "tile seed plan.requested_count"
  );
  const existingCount = integerBetween(
    record.existing_count, 0, requestedCount, "tile seed plan.existing_count"
  );
  const targetCount = integerBetween(record.target_count, 1, 64, "tile seed plan.target_count");
  const state = oneOf(
    record.state,
    ["preparing", "queued", "running", "completed", "failed", "cancelled"],
    "tile seed plan.state"
  );
  const items = parseArray(record.items, (value) => {
    const item = object(value, "tile seed plan item");
    exactKeys(item, [
      "position", "tile_matrix", "tile_row", "tile_col", "render_job_id",
      "state", "error_code", "started_at", "finished_at"
    ], "tile seed plan item");
    return {
      position: integerBetween(item.position, 1, 64, "tile seed plan item.position"),
      ...parseTileCoordinate(item, "tile seed plan item"),
      renderJobId: nullableUuid(item.render_job_id, "tile seed plan item.render_job_id"),
      state: oneOf(
        item.state,
        ["pending", "queued", "running", "completed", "failed", "cancelled"],
        "tile seed plan item.state"
      ),
      errorCode: nullableBoundedString(item.error_code, 100, "tile seed plan item.error_code"),
      startedAt: nullableTimestamp(item.started_at, "tile seed plan item.started_at"),
      finishedAt: nullableTimestamp(item.finished_at, "tile seed plan item.finished_at")
    };
  }, "tile seed plan.items");
  if (requestedCount !== existingCount + targetCount || items.length !== targetCount) {
    contract("tile seed plan counts are inconsistent");
  }
  const cancelAvailable = boolean(record.cancel_available, "tile seed plan.cancel_available");
  if (cancelAvailable !== (state === "preparing")) {
    contract("tile seed plan cancellation state is inconsistent");
  }
  return {
    id: uuid(record.id, "tile seed plan.id"),
    cacheId: uuid(record.cache_id, "tile seed plan.cache_id"),
    cacheVersionId: uuid(record.cache_version_id, "tile seed plan.cache_version_id"),
    cacheVersionNumber: positiveInteger(
      record.cache_version_number, "tile seed plan.cache_version_number"
    ),
    mode: oneOf(record.mode, ["tiles", "bbox"], "tile seed plan.mode"),
    bbox: parseTileSeedBbox(record.bbox, "tile seed plan.bbox"),
    minimumTileMatrix,
    maximumTileMatrix: integerBetween(
      record.maximum_tile_matrix, minimumTileMatrix, 22, "tile seed plan.maximum_tile_matrix"
    ),
    requestedCount,
    existingCount,
    targetCount,
    previewChecksumSha256: sha256(
      record.preview_checksum_sha256, "tile seed plan.preview_checksum"
    ),
    previewExpiresAt: timestamp(record.preview_expires_at, "tile seed plan.preview_expires_at"),
    state,
    errorCode: nullableBoundedString(record.error_code, 100, "tile seed plan.error_code"),
    createdBy: uuid(record.created_by, "tile seed plan.created_by"),
    createdAt: timestamp(record.created_at, "tile seed plan.created_at"),
    dispatchStartedAt: nullableTimestamp(
      record.dispatch_started_at, "tile seed plan.dispatch_started_at"
    ),
    startedAt: nullableTimestamp(record.started_at, "tile seed plan.started_at"),
    finishedAt: nullableTimestamp(record.finished_at, "tile seed plan.finished_at"),
    items,
    cancelAvailable,
    activation: oneOf(
      record.activation, ["explicit-confirmation-only"], "tile seed plan.activation"
    ),
    ordinaryReadsCreateWork: oneOf(
      record.ordinary_reads_create_work, [false], "tile seed plan.read activation"
    ),
    fixedInactiveComputeCost: oneOf(
      record.fixed_inactive_compute_cost, ["$0"], "tile seed plan.inactive cost"
    )
  };
}

export function parseRetiredTileCacheVersion(value) {
  const record = object(value, "retired tile cache version");
  exactKeys(record, [
    "cache_id", "cache_version_id", "cache_version_number",
    "minimum_tile_matrix", "maximum_tile_matrix", "maximum_entries",
    "change_message", "created_at", "retired_at", "entry_count",
    "render_output_count", "reclamation_id", "reclamation_state",
    "reclamation_target_count", "reclamation_completed_count",
    "reclamation_failed_count"
  ], "retired tile cache version");
  const minimumTileMatrix = integerBetween(
    record.minimum_tile_matrix, 0, 22, "retired tile cache.minimum_tile_matrix"
  );
  const maximumTileMatrix = integerBetween(
    record.maximum_tile_matrix, minimumTileMatrix, 22,
    "retired tile cache.maximum_tile_matrix"
  );
  const reclamationState = record.reclamation_state === null
    ? null
    : oneOf(
      record.reclamation_state,
      ["queued", "running", "completed", "failed"],
      "retired tile cache.reclamation_state"
    );
  const reclamationId = nullableUuid(
    record.reclamation_id, "retired tile cache.reclamation_id"
  );
  const reclamationTargetCount = nullablePositiveInteger(
    record.reclamation_target_count, "retired tile cache.reclamation_target_count"
  );
  if ((reclamationState === null) !== (reclamationId === null)
    || (reclamationState === null) !== (reclamationTargetCount === null)) {
    contract("retired tile cache reclamation summary is inconsistent");
  }
  return {
    cacheId: uuid(record.cache_id, "retired tile cache.cache_id"),
    cacheVersionId: uuid(record.cache_version_id, "retired tile cache.cache_version_id"),
    cacheVersionNumber: positiveInteger(
      record.cache_version_number, "retired tile cache.cache_version_number"
    ),
    minimumTileMatrix,
    maximumTileMatrix,
    maximumEntries: integerBetween(
      record.maximum_entries, 1, 10_000, "retired tile cache.maximum_entries"
    ),
    changeMessage: nullableBoundedString(
      record.change_message, 500, "retired tile cache.change_message"
    ),
    createdAt: timestamp(record.created_at, "retired tile cache.created_at"),
    retiredAt: timestamp(record.retired_at, "retired tile cache.retired_at"),
    entryCount: integerBetween(
      record.entry_count, 0, 10_000, "retired tile cache.entry_count"
    ),
    renderOutputCount: integerBetween(
      record.render_output_count, 0, 10_000, "retired tile cache.render_output_count"
    ),
    reclamationId,
    reclamationState,
    reclamationTargetCount,
    reclamationCompletedCount: integerBetween(
      record.reclamation_completed_count, 0, 64,
      "retired tile cache.reclamation_completed_count"
    ),
    reclamationFailedCount: integerBetween(
      record.reclamation_failed_count, 0, 64,
      "retired tile cache.reclamation_failed_count"
    )
  };
}

export function parseTileCacheReclamationPreview(value) {
  const record = object(value, "tile cache reclamation preview");
  exactKeys(record, [
    "cache_id", "cache_version_id", "cache_version_number", "target_count",
    "remaining_eligible_target_count", "target_size_bytes",
    "oldest_render_finished_at", "newest_render_finished_at", "expires_at",
    "preview_checksum_sha256", "physical_action", "render_history_retained",
    "cache_history_retained", "ordinary_reads_create_work", "batch_limit",
    "minimum_reclamation_age_hours", "fixed_inactive_compute_cost"
  ], "tile cache reclamation preview");
  return {
    cacheId: uuid(record.cache_id, "tile cache reclamation preview.cache_id"),
    cacheVersionId: uuid(
      record.cache_version_id, "tile cache reclamation preview.cache_version_id"
    ),
    cacheVersionNumber: positiveInteger(
      record.cache_version_number,
      "tile cache reclamation preview.cache_version_number"
    ),
    targetCount: integerBetween(
      record.target_count, 1, 64, "tile cache reclamation preview.target_count"
    ),
    remainingEligibleTargetCount: integerBetween(
      record.remaining_eligible_target_count, 0, 10_000,
      "tile cache reclamation preview.remaining_eligible_target_count"
    ),
    targetSizeBytes: integerBetween(
      record.target_size_bytes, 1, 1_342_177_280,
      "tile cache reclamation preview.target_size_bytes"
    ),
    oldestRenderFinishedAt: timestamp(
      record.oldest_render_finished_at,
      "tile cache reclamation preview.oldest_render_finished_at"
    ),
    newestRenderFinishedAt: timestamp(
      record.newest_render_finished_at,
      "tile cache reclamation preview.newest_render_finished_at"
    ),
    expiresAt: timestamp(record.expires_at, "tile cache reclamation preview.expires_at"),
    previewChecksumSha256: sha256(
      record.preview_checksum_sha256,
      "tile cache reclamation preview.preview_checksum_sha256"
    ),
    physicalAction: oneOf(
      record.physical_action,
      ["delete_exact_storage_versions"],
      "tile cache reclamation preview.physical_action"
    ),
    renderHistoryRetained: boolean(
      record.render_history_retained,
      "tile cache reclamation preview.render_history_retained"
    ),
    cacheHistoryRetained: boolean(
      record.cache_history_retained,
      "tile cache reclamation preview.cache_history_retained"
    ),
    ordinaryReadsCreateWork: boolean(
      record.ordinary_reads_create_work,
      "tile cache reclamation preview.ordinary_reads_create_work"
    ),
    batchLimit: integerBetween(
      record.batch_limit, 1, 64, "tile cache reclamation preview.batch_limit"
    ),
    minimumReclamationAgeHours: integerBetween(
      record.minimum_reclamation_age_hours, 24, 24,
      "tile cache reclamation preview.minimum_reclamation_age_hours"
    ),
    fixedInactiveComputeCost: oneOf(
      record.fixed_inactive_compute_cost,
      ["$0"],
      "tile cache reclamation preview.fixed_inactive_compute_cost"
    )
  };
}

export function parseTileCacheReclamation(value) {
  const record = object(value, "tile cache reclamation");
  exactKeys(record, [
    "id", "cache_id", "cache_version_id", "cache_version_number",
    "target_count", "target_size_bytes", "state", "error_code",
    "attempt_count", "completed_target_count", "failed_target_count",
    "preview_checksum_sha256", "preview_expires_at", "created_by",
    "created_at", "started_at", "finished_at"
  ], "tile cache reclamation");
  const state = oneOf(
    record.state,
    ["queued", "running", "completed", "failed"],
    "tile cache reclamation.state"
  );
  const result = {
    id: uuid(record.id, "tile cache reclamation.id"),
    cacheId: uuid(record.cache_id, "tile cache reclamation.cache_id"),
    cacheVersionId: uuid(
      record.cache_version_id, "tile cache reclamation.cache_version_id"
    ),
    cacheVersionNumber: positiveInteger(
      record.cache_version_number, "tile cache reclamation.cache_version_number"
    ),
    targetCount: integerBetween(
      record.target_count, 1, 64, "tile cache reclamation.target_count"
    ),
    targetSizeBytes: integerBetween(
      record.target_size_bytes, 1, 1_342_177_280,
      "tile cache reclamation.target_size_bytes"
    ),
    state,
    errorCode: nullableBoundedString(record.error_code, 200, "tile cache reclamation.error_code"),
    attemptCount: nonNegativeInteger(
      record.attempt_count, "tile cache reclamation.attempt_count"
    ),
    completedTargetCount: integerBetween(
      record.completed_target_count, 0, 64,
      "tile cache reclamation.completed_target_count"
    ),
    failedTargetCount: integerBetween(
      record.failed_target_count, 0, 64,
      "tile cache reclamation.failed_target_count"
    ),
    previewChecksumSha256: sha256(
      record.preview_checksum_sha256,
      "tile cache reclamation.preview_checksum_sha256"
    ),
    previewExpiresAt: timestamp(
      record.preview_expires_at, "tile cache reclamation.preview_expires_at"
    ),
    createdBy: uuid(record.created_by, "tile cache reclamation.created_by"),
    createdAt: timestamp(record.created_at, "tile cache reclamation.created_at"),
    startedAt: nullableTimestamp(record.started_at, "tile cache reclamation.started_at"),
    finishedAt: nullableTimestamp(record.finished_at, "tile cache reclamation.finished_at")
  };
  if (
    (state === "queued" && result.finishedAt !== null)
    || (state === "running" && (result.startedAt === null || result.finishedAt !== null))
    || (["completed", "failed"].includes(state)
      && (result.startedAt === null || result.finishedAt === null))
  ) {
    contract("tile cache reclamation state shape is invalid");
  }
  return result;
}

export function parseSpatialCoverage(value) {
  const record = object(value, "spatial service coverage");
  const coverageName = boundedString(
    record.coverage_name,
    100,
    "spatial service coverage.coverage_name"
  );
  if (!SPATIAL_SERVICE_SLUG_PATTERN.test(coverageName)) {
    contract("spatial service coverage.coverage_name is invalid");
  }
  const sealedDatasetVersionNumber = positiveInteger(
    record.sealed_dataset_version_number,
    "spatial service coverage.sealed_dataset_version_number"
  );
  const currentDatasetVersionNumber = positiveInteger(
    record.current_dataset_version_number,
    "spatial service coverage.current_dataset_version_number"
  );
  const datasetVersionId = uuid(
    record.dataset_version_id,
    "spatial service coverage.dataset_version_id"
  );
  const currentDatasetVersionId = uuid(
    record.current_dataset_version_id,
    "spatial service coverage.current_dataset_version_id"
  );
  const targetActive = boolean(
    record.target_active,
    "spatial service coverage.target_active"
  );
  const stale = boolean(record.stale, "spatial service coverage.stale");
  const expectedStale = !targetActive
    || datasetVersionId !== currentDatasetVersionId
    || sealedDatasetVersionNumber !== currentDatasetVersionNumber;
  if (stale !== expectedStale) {
    contract("spatial service coverage.stale is inconsistent");
  }
  const extent = parseArray(
    record.extent,
    (coordinate) => finiteNumber(coordinate, "spatial service coverage.extent"),
    "spatial service coverage.extent"
  );
  if (extent.length !== 4 || extent[0] >= extent[2] || extent[1] >= extent[3]) {
    contract("spatial service coverage.extent is invalid");
  }
  const width = integerBetween(record.width, 1, 1_000_000, "spatial service coverage.width");
  const height = integerBetween(
    record.height,
    1,
    1_000_000,
    "spatial service coverage.height"
  );
  if (width * height > 100_000_000_000) {
    contract("spatial service coverage grid is too large");
  }
  const bandCount = integerBetween(
    record.band_count,
    1,
    64,
    "spatial service coverage.band_count"
  );
  const bands = parseArray(record.bands, parseSpatialCoverageBand, "spatial service coverage.bands");
  if (bands.length !== bandCount) {
    contract("spatial service coverage.bands is inconsistent");
  }
  const withdrawnBy = nullableUuid(
    record.withdrawn_by,
    "spatial service coverage.withdrawn_by"
  );
  const withdrawnAt = nullableTimestamp(
    record.withdrawn_at,
    "spatial service coverage.withdrawn_at"
  );
  if ((withdrawnBy === null) !== (withdrawnAt === null)) {
    contract("spatial service coverage withdrawal is inconsistent");
  }
  return {
    id: uuid(record.id, "spatial service coverage.id"),
    projectId: uuid(record.project_id, "spatial service coverage.project_id"),
    serviceId: uuid(record.service_id, "spatial service coverage.service_id"),
    coverageName,
    datasetId: uuid(record.dataset_id, "spatial service coverage.dataset_id"),
    datasetVersionId,
    dataObjectId: uuid(record.data_object_id, "spatial service coverage.data_object_id"),
    sealedDatasetVersionNumber,
    currentDatasetVersionId,
    currentDatasetVersionNumber,
    crs: boundedString(record.crs, 2048, "spatial service coverage.crs"),
    extent,
    width,
    height,
    bandCount,
    bands,
    contentType: oneOf(
      record.content_type,
      ["image/tiff", "image/geotiff"],
      "spatial service coverage.content_type"
    ),
    sizeBytes: integerBetween(
      record.size_bytes,
      1,
      5_368_709_120,
      "spatial service coverage.size_bytes"
    ),
    checksumSha256: sha256(
      record.checksum_sha256,
      "spatial service coverage.checksum_sha256"
    ),
    stale,
    targetActive,
    title: boundedString(record.title, 300, "spatial service coverage.title"),
    description: nullableBoundedString(
      record.description,
      2000,
      "spatial service coverage.description"
    ),
    createdBy: uuid(record.created_by, "spatial service coverage.created_by"),
    createdAt: timestamp(record.created_at, "spatial service coverage.created_at"),
    withdrawnBy,
    withdrawnAt
  };
}

function parseSpatialCoverageBand(value) {
  const record = object(value, "spatial service coverage band");
  exactKeys(
    record,
    ["index", "data_type", "color_interpretation"],
    "spatial service coverage band"
  );
  return {
    index: integerBetween(record.index, 1, 64, "spatial service coverage band.index"),
    dataType: nullableBoundedString(
      record.data_type,
      100,
      "spatial service coverage band.data_type"
    ),
    colorInterpretation: nullableBoundedString(
      record.color_interpretation,
      100,
      "spatial service coverage band.color_interpretation"
    )
  };
}

function parseCoverageDerivativeBand(value) {
  const record = object(value, "coverage derivative band");
  exactKeys(
    record,
    ["index", "source_index", "data_type", "color_interpretation"],
    "coverage derivative band"
  );
  return {
    index: integerBetween(record.index, 1, 64, "coverage derivative band.index"),
    sourceIndex: integerBetween(
      record.source_index, 1, 64, "coverage derivative band.source_index"
    ),
    dataType: nullableBoundedString(
      record.data_type, 100, "coverage derivative band.data_type"
    ),
    colorInterpretation: nullableBoundedString(
      record.color_interpretation,
      100,
      "coverage derivative band.color_interpretation"
    )
  };
}

export function parseCoverageProcessingPolicy(value) {
  const record = object(value, "coverage processing policy");
  exactKeys(record, [
    "request_schema_version", "maximum_axis_pixels", "maximum_pixels",
    "maximum_samples", "maximum_retained_jobs_per_coverage",
    "maximum_active_jobs_per_coverage", "maximum_output_bytes",
    "supported_resampling", "cancellation_states", "minimum_reclamation_age_hours",
    "reclamation_preview_ttl_seconds", "physical_reclamation",
    "ordinary_reads_create_work"
  ], "coverage processing policy");
  const supportedResampling = boundedStringArray(
    record.supported_resampling, 3, 20, "coverage processing policy.supported_resampling"
  );
  const cancellationStates = boundedStringArray(
    record.cancellation_states, 3, 20, "coverage processing policy.cancellation_states"
  );
  if (
    JSON.stringify(supportedResampling) !== JSON.stringify(["nearest", "bilinear", "cubic"])
    || JSON.stringify(cancellationStates) !== JSON.stringify(["queued"])
  ) {
    contract("coverage processing policy capabilities are invalid");
  }
  return {
    requestSchemaVersion: integerBetween(
      record.request_schema_version, 2, 2, "coverage processing policy.request_schema_version"
    ),
    maximumAxisPixels: integerBetween(
      record.maximum_axis_pixels, 1, 8192, "coverage processing policy.maximum_axis_pixels"
    ),
    maximumPixels: integerBetween(
      record.maximum_pixels, 1, 16_777_216, "coverage processing policy.maximum_pixels"
    ),
    maximumSamples: integerBetween(
      record.maximum_samples, 1, 67_108_864, "coverage processing policy.maximum_samples"
    ),
    maximumRetainedJobsPerCoverage: integerBetween(
      record.maximum_retained_jobs_per_coverage,
      1,
      64,
      "coverage processing policy.maximum_retained_jobs_per_coverage"
    ),
    maximumActiveJobsPerCoverage: integerBetween(
      record.maximum_active_jobs_per_coverage,
      1,
      4,
      "coverage processing policy.maximum_active_jobs_per_coverage"
    ),
    maximumOutputBytes: integerBetween(
      record.maximum_output_bytes,
      1,
      536_870_912,
      "coverage processing policy.maximum_output_bytes"
    ),
    supportedResampling,
    cancellationStates,
    minimumReclamationAgeHours: integerBetween(
      record.minimum_reclamation_age_hours,
      1,
      168,
      "coverage processing policy.minimum_reclamation_age_hours"
    ),
    reclamationPreviewTtlSeconds: integerBetween(
      record.reclamation_preview_ttl_seconds,
      60,
      900,
      "coverage processing policy.reclamation_preview_ttl_seconds"
    ),
    physicalReclamation: oneOf(
      record.physical_reclamation,
      ["preview_then_explicit_exact_version_worker_delete"],
      "coverage processing policy.physical_reclamation"
    ),
    ordinaryReadsCreateWork: boolean(
      record.ordinary_reads_create_work,
      "coverage processing policy.ordinary_reads_create_work"
    )
  };
}

export function parseCoverageDerivative(value) {
  const record = object(value, "coverage derivative");
  exactKeys(record, [
    "id", "project_id", "service_id", "coverage_id", "coverage_name",
    "subset_extent", "target_crs", "target_width", "target_height", "resampling",
    "request_schema_version", "band_indexes", "scale_mode", "requested_resolution",
    "request_checksum_sha256", "state", "output_object_id", "output_crs",
    "output_extent", "output_width", "output_height", "output_band_count",
    "output_bands", "output_content_type", "output_size_bytes",
    "output_checksum_sha256", "error_code", "attempt_count", "created_by",
    "created_at", "started_at", "finished_at", "source_available",
    "reclamation_state", "output_available"
  ], "coverage derivative");
  const subsetExtent = coverageDerivativeExtent(
    record.subset_extent,
    ApiContractError
  );
  const targetCrs = boundedString(record.target_crs, 100, "coverage derivative.target_crs");
  if (!/^EPSG:[1-9][0-9]{2,7}$/.test(targetCrs)) {
    contract("coverage derivative.target_crs is invalid");
  }
  const targetWidth = integerBetween(
    record.target_width, 1, 8192, "coverage derivative.target_width"
  );
  const targetHeight = integerBetween(
    record.target_height, 1, 8192, "coverage derivative.target_height"
  );
  if (targetWidth * targetHeight > 16_777_216) {
    contract("coverage derivative exceeds the pixel budget");
  }
  const requestSchemaVersion = integerBetween(
    record.request_schema_version, 1, 2, "coverage derivative.request_schema_version"
  );
  const bandIndexes = coverageDerivativeBandIndexes(
    record.band_indexes, ApiContractError
  );
  if (targetWidth * targetHeight * bandIndexes.length > 67_108_864) {
    contract("coverage derivative exceeds the sample budget");
  }
  const scaleMode = oneOf(
    record.scale_mode, ["size", "resolution"], "coverage derivative.scale_mode"
  );
  const requestedResolution = record.requested_resolution === null
    ? null
    : positivePair(
      record.requested_resolution,
      "coverage derivative.requested_resolution",
      ApiContractError
    );
  if (
    (scaleMode === "size" && requestedResolution !== null)
    || (scaleMode === "resolution" && requestedResolution === null)
    || (requestSchemaVersion === 1 && scaleMode !== "size")
  ) {
    contract("coverage derivative scale shape is invalid");
  }
  const outputExtent = record.output_extent === null
    ? null
    : coverageDerivativeExtent(record.output_extent, ApiContractError);
  const outputWidth = record.output_width === null
    ? null
    : integerBetween(record.output_width, 1, 8192, "coverage derivative.output_width");
  const outputHeight = record.output_height === null
    ? null
    : integerBetween(record.output_height, 1, 8192, "coverage derivative.output_height");
  const outputBandCount = record.output_band_count === null
    ? null
    : integerBetween(record.output_band_count, 1, 64, "coverage derivative.output_band_count");
  const outputBands = record.output_bands === null
    ? null
    : parseArray(
      record.output_bands, parseCoverageDerivativeBand, "coverage derivative.output_bands"
    );
  if (outputBands !== null && outputBands.length !== outputBandCount) {
    contract("coverage derivative.output_bands is inconsistent");
  }
  if (
    outputBands !== null
    && outputBands.some((band, index) => (
      band.index !== index + 1 || band.sourceIndex !== bandIndexes[index]
    ))
  ) {
    contract("coverage derivative.output_bands does not match the range request");
  }
  const outputCrs = nullableBoundedString(
    record.output_crs, 100, "coverage derivative.output_crs"
  );
  if (outputCrs !== null && outputCrs !== targetCrs) {
    contract("coverage derivative.output_crs does not match the request");
  }
  const state = oneOf(
    record.state,
    ["queued", "running", "completed", "failed", "cancelled"],
    "coverage derivative.state"
  );
  const result = {
    id: uuid(record.id, "coverage derivative.id"),
    projectId: uuid(record.project_id, "coverage derivative.project_id"),
    serviceId: uuid(record.service_id, "coverage derivative.service_id"),
    coverageId: uuid(record.coverage_id, "coverage derivative.coverage_id"),
    coverageName: boundedString(
      record.coverage_name, 100, "coverage derivative.coverage_name"
    ),
    subsetExtent,
    targetCrs,
    targetWidth,
    targetHeight,
    resampling: oneOf(
      record.resampling,
      ["nearest", "bilinear", "cubic"],
      "coverage derivative.resampling"
    ),
    requestSchemaVersion,
    bandIndexes,
    scaleMode,
    requestedResolution,
    requestChecksumSha256: sha256(
      record.request_checksum_sha256, "coverage derivative.request_checksum_sha256"
    ),
    state,
    outputObjectId: nullableUuid(record.output_object_id, "coverage derivative.output_object_id"),
    outputCrs,
    outputExtent,
    outputWidth,
    outputHeight,
    outputBandCount,
    outputBands,
    outputContentType: record.output_content_type === null
      ? null
      : oneOf(record.output_content_type, ["image/tiff"], "coverage derivative.output_content_type"),
    outputSizeBytes: record.output_size_bytes === null
      ? null
      : integerBetween(
        record.output_size_bytes, 1, 536_870_912, "coverage derivative.output_size_bytes"
      ),
    outputChecksumSha256: record.output_checksum_sha256 === null
      ? null
      : sha256(
        record.output_checksum_sha256, "coverage derivative.output_checksum_sha256"
      ),
    errorCode: nullableBoundedString(record.error_code, 100, "coverage derivative.error_code"),
    attemptCount: nonNegativeInteger(record.attempt_count, "coverage derivative.attempt_count"),
    createdBy: uuid(record.created_by, "coverage derivative.created_by"),
    createdAt: timestamp(record.created_at, "coverage derivative.created_at"),
    startedAt: nullableTimestamp(record.started_at, "coverage derivative.started_at"),
    finishedAt: nullableTimestamp(record.finished_at, "coverage derivative.finished_at"),
    sourceAvailable: boolean(record.source_available, "coverage derivative.source_available"),
    reclamationState: record.reclamation_state === null
      ? null
      : oneOf(
        record.reclamation_state,
        ["queued", "running", "completed", "failed"],
        "coverage derivative.reclamation_state"
      ),
    outputAvailable: boolean(record.output_available, "coverage derivative.output_available")
  };
  const outputValues = [
    result.outputObjectId, result.outputCrs, result.outputExtent, result.outputWidth,
    result.outputHeight, result.outputBandCount, result.outputBands,
    result.outputContentType, result.outputSizeBytes, result.outputChecksumSha256
  ];
  const hasOutput = outputValues.every((entry) => entry !== null)
    && result.outputWidth === result.targetWidth
    && result.outputHeight === result.targetHeight;
  const hasNoOutput = outputValues.every((entry) => entry === null);
  const shouldBeAvailable = state === "completed"
    && !["queued", "running", "completed"].includes(result.reclamationState);
  if (
    (!hasOutput && !hasNoOutput)
    || result.outputAvailable !== shouldBeAvailable
    || (state === "queued" && (result.finishedAt !== null || !hasNoOutput))
    || (state === "running" && (
      result.startedAt === null || result.finishedAt !== null || !hasNoOutput
      || result.errorCode !== null
    ))
    || (state === "completed" && (
      result.startedAt === null || result.finishedAt === null || !hasOutput
      || result.errorCode !== null
    ))
    || (["failed", "cancelled"].includes(state) && (
      result.finishedAt === null || !hasNoOutput || result.errorCode === null
    ))
  ) {
    contract("coverage derivative state shape is invalid");
  }
  return result;
}

export function parseCoverageDerivativeReclamationPreview(value) {
  const record = object(value, "coverage derivative reclamation preview");
  exactKeys(record, [
    "derivative_job_id", "output_object_id", "size_bytes", "checksum_sha256",
    "derivative_finished_at", "expires_at", "preview_checksum_sha256",
    "physical_action", "history_retained", "ordinary_reads_create_work"
  ], "coverage derivative reclamation preview");
  return {
    derivativeJobId: uuid(record.derivative_job_id, "reclamation preview.derivative_job_id"),
    outputObjectId: uuid(record.output_object_id, "reclamation preview.output_object_id"),
    sizeBytes: integerBetween(record.size_bytes, 1, 536_870_912, "reclamation preview.size_bytes"),
    checksumSha256: sha256(record.checksum_sha256, "reclamation preview.checksum_sha256"),
    derivativeFinishedAt: timestamp(
      record.derivative_finished_at, "reclamation preview.derivative_finished_at"
    ),
    expiresAt: timestamp(record.expires_at, "reclamation preview.expires_at"),
    previewChecksumSha256: sha256(
      record.preview_checksum_sha256, "reclamation preview.preview_checksum_sha256"
    ),
    physicalAction: oneOf(
      record.physical_action,
      ["delete_exact_storage_version"],
      "reclamation preview.physical_action"
    ),
    historyRetained: boolean(record.history_retained, "reclamation preview.history_retained"),
    ordinaryReadsCreateWork: boolean(
      record.ordinary_reads_create_work, "reclamation preview.ordinary_reads_create_work"
    )
  };
}

export function parseCoverageDerivativeReclamation(value) {
  const record = object(value, "coverage derivative reclamation");
  exactKeys(record, [
    "id", "derivative_job_id", "output_object_id", "state", "size_bytes",
    "checksum_sha256", "preview_checksum_sha256", "preview_expires_at",
    "error_code", "attempt_count", "delete_started_at", "created_by",
    "created_at", "started_at", "finished_at"
  ], "coverage derivative reclamation");
  const state = oneOf(
    record.state,
    ["queued", "running", "completed", "failed"],
    "coverage derivative reclamation.state"
  );
  const result = {
    id: uuid(record.id, "coverage derivative reclamation.id"),
    derivativeJobId: uuid(record.derivative_job_id, "reclamation.derivative_job_id"),
    outputObjectId: uuid(record.output_object_id, "reclamation.output_object_id"),
    state,
    sizeBytes: integerBetween(record.size_bytes, 1, 536_870_912, "reclamation.size_bytes"),
    checksumSha256: sha256(record.checksum_sha256, "reclamation.checksum_sha256"),
    previewChecksumSha256: sha256(
      record.preview_checksum_sha256, "reclamation.preview_checksum_sha256"
    ),
    previewExpiresAt: timestamp(record.preview_expires_at, "reclamation.preview_expires_at"),
    errorCode: nullableBoundedString(record.error_code, 200, "reclamation.error_code"),
    attemptCount: nonNegativeInteger(record.attempt_count, "reclamation.attempt_count"),
    deleteStartedAt: nullableTimestamp(record.delete_started_at, "reclamation.delete_started_at"),
    createdBy: uuid(record.created_by, "reclamation.created_by"),
    createdAt: timestamp(record.created_at, "reclamation.created_at"),
    startedAt: nullableTimestamp(record.started_at, "reclamation.started_at"),
    finishedAt: nullableTimestamp(record.finished_at, "reclamation.finished_at")
  };
  if (
    (state === "queued" && result.finishedAt !== null)
    || (state === "running" && (result.startedAt === null || result.finishedAt !== null))
    || (state === "completed" && (
      result.deleteStartedAt === null || result.finishedAt === null || result.errorCode !== null
    ))
    || (state === "failed" && (
      result.deleteStartedAt !== null || result.finishedAt === null || result.errorCode === null
    ))
  ) contract("coverage derivative reclamation state shape is invalid");
  return result;
}

function coverageDerivativeExtent(value, ErrorClass) {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new ErrorClass("coverage derivative extent is invalid");
  }
  const extent = value.map((coordinate) => {
    if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
      throw new ErrorClass("coverage derivative extent is invalid");
    }
    return coordinate;
  });
  if (extent[0] >= extent[2] || extent[1] >= extent[3]) {
    throw new ErrorClass("coverage derivative extent is invalid");
  }
  return extent;
}

function coverageDerivativeBandIndexes(value, ErrorClass) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new ErrorClass("coverage derivative band indexes are invalid");
  }
  const indexes = value.map((entry) => {
    if (!Number.isInteger(entry) || entry < 1 || entry > 64) {
      throw new ErrorClass("coverage derivative band indexes are invalid");
    }
    return entry;
  });
  if (indexes.some((entry, index) => index > 0 && entry <= indexes[index - 1])) {
    throw new ErrorClass("coverage derivative band indexes are invalid");
  }
  return indexes;
}

function positivePair(value, label, ErrorClass) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new ErrorClass(`${label} is invalid`);
  }
  const pair = value.map((entry) => {
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry <= 0 || entry > 1e100) {
      throw new ErrorClass(`${label} is invalid`);
    }
    return entry;
  });
  return pair;
}

function boundedStringArray(value, maximumItems, maximumLength, label) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    contract(`${label} is invalid`);
  }
  return value.map((entry) => boundedString(entry, maximumLength, label));
}

function uniqueBoundedStringArray(value, maximumItems, maximumLength, label) {
  const result = boundedStringArray(value, maximumItems, maximumLength, label);
  if (new Set(result).size !== result.length) contract(`${label} contains duplicates`);
  return result;
}

function spatialCatalogPath(projectId, serviceId) {
  return `/projects/${pathUuid(projectId, "project id")}`
    + `/spatial-services/${pathUuid(serviceId, "spatial service id")}/catalog`;
}

function spatialCatalogInput(value, label) {
  if (!isObject(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function spatialCatalogRequestArray(value, maximumItems, maximumLength, label, {minimum = 0} = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximumItems) {
    throw new TypeError(`${label} is invalid`);
  }
  const result = value.map((entry) => boundedQuery(entry, maximumLength, label));
  if (new Set(result).size !== result.length) throw new TypeError(`${label} contains duplicates`);
  return result;
}

function spatialCatalogMetadataBody(value) {
  const draft = spatialCatalogInput(value, "spatial service metadata");
  const enabledProtocols = spatialCatalogRequestArray(
    draft.enabledProtocols, 8, 40, "spatial service metadata enabled protocols", {minimum: 1}
  );
  const knownProtocols = new Set([
    "ogc_api_features", "wfs_2_0", "wms_1_1", "wms_1_3",
    "wmts_1_0", "wcs_2_0", "arcgis_features"
  ]);
  if (enabledProtocols.some((item) => !knownProtocols.has(item))) {
    throw new TypeError("spatial service metadata enabled protocols are invalid");
  }
  const contact = draft.contact ?? {};
  if (!isObject(contact)
    || new TextEncoder().encode(JSON.stringify(contact)).byteLength > 4096) {
    throw new TypeError("spatial service metadata contact is invalid");
  }
  return {
    expected_version: positiveInputInteger(
      draft.expectedVersion, "spatial service metadata expected version"
    ),
    title: boundedQuery(draft.title, 200, "spatial service metadata title"),
    abstract: draft.abstract == null
      ? null
      : boundedQuery(draft.abstract, 8000, "spatial service metadata abstract"),
    namespace_uri: draft.namespaceUri == null
      ? null
      : boundedQuery(draft.namespaceUri, 2048, "spatial service metadata namespace URI"),
    keywords: spatialCatalogRequestArray(
      draft.keywords ?? [], 32, 300, "spatial service metadata keywords"
    ),
    fees: draft.fees == null
      ? null
      : boundedQuery(draft.fees, 1000, "spatial service metadata fees"),
    access_constraints: spatialCatalogRequestArray(
      draft.accessConstraints ?? [], 16, 300, "spatial service metadata access constraints"
    ),
    contact: structuredClone(contact),
    enabled_protocols: enabledProtocols,
    change_message: draft.changeMessage == null
      ? null
      : boundedQuery(
        draft.changeMessage, 500, "spatial service metadata change message"
      )
  };
}

function spatialCatalogStoreBody(value) {
  const draft = spatialCatalogInput(value, "spatial service store");
  if (typeof draft.slug !== "string" || !SPATIAL_SERVICE_SLUG_PATTERN.test(draft.slug)) {
    throw new TypeError("spatial service store slug is invalid");
  }
  const kind = draft.kind;
  if (!["managed_project", "external_source", "postgresql_connection"].includes(kind)) {
    throw new TypeError("spatial service store kind is invalid");
  }
  const configuration = draft.configuration ?? {};
  if (!isObject(configuration)
    || new TextEncoder().encode(JSON.stringify(configuration)).byteLength > 8192) {
    throw new TypeError("spatial service store configuration is invalid");
  }
  return {
    slug: draft.slug,
    title: boundedQuery(draft.title, 200, "spatial service store title"),
    description: draft.description == null
      ? null
      : boundedQuery(draft.description, 2000, "spatial service store description"),
    kind,
    dataset_id: draft.datasetId == null
      ? null
      : assertUuid(draft.datasetId, "spatial service store dataset id"),
    external_connection_id: draft.externalConnectionId == null
      ? null
      : assertUuid(
        draft.externalConnectionId, "spatial service store external connection id"
      ),
    sealed_source_revision_number: draft.sealedSourceRevisionNumber == null
      ? null
      : positiveInputInteger(
        draft.sealedSourceRevisionNumber, "spatial service store source revision"
      ),
    sealed_connection_revision_number: draft.sealedConnectionRevisionNumber == null
      ? null
      : positiveInputInteger(
        draft.sealedConnectionRevisionNumber, "spatial service store connection revision"
      ),
    configuration: structuredClone(configuration)
  };
}

function spatialCatalogLayerGroupBody(value) {
  const draft = spatialCatalogInput(value, "spatial service layer group");
  const mode = draft.mode;
  if (!["single", "opaque_container", "named", "container", "earth_observation"].includes(mode)) {
    throw new TypeError("spatial service layer group mode is invalid");
  }
  if (!Array.isArray(draft.memberCollectionIds)
    || draft.memberCollectionIds.length < 1
    || draft.memberCollectionIds.length > 64) {
    throw new TypeError("spatial service layer group members are invalid");
  }
  const memberIds = draft.memberCollectionIds.map((entry) => assertUuid(
    entry, "spatial service layer group member id"
  ));
  if (new Set(memberIds).size !== memberIds.length) {
    throw new TypeError("spatial service layer group members contain duplicates");
  }
  if (!Number.isSafeInteger(draft.expectedVersion) || draft.expectedVersion < 0) {
    throw new TypeError("spatial service layer group expected version is invalid");
  }
  return {
    expected_version: draft.expectedVersion,
    title: boundedQuery(draft.title, 300, "spatial service layer group title"),
    description: draft.description == null
      ? null
      : boundedQuery(draft.description, 2000, "spatial service layer group description"),
    mode,
    member_collection_ids: memberIds,
    change_message: draft.changeMessage == null
      ? null
      : boundedQuery(
        draft.changeMessage, 500, "spatial service layer group change message"
      )
  };
}

function spatialCatalogStyleBody(value) {
  const draft = spatialCatalogInput(value, "spatial service collection style");
  if (typeof draft.styleName !== "string"
    || !SPATIAL_SERVICE_SLUG_PATTERN.test(draft.styleName)) {
    throw new TypeError("spatial service collection style name is invalid");
  }
  if (typeof draft.isDefault !== "boolean") {
    throw new TypeError("spatial service collection style default flag is invalid");
  }
  return {
    style_name: draft.styleName,
    style_id: assertUuid(draft.styleId, "spatial service collection style id"),
    expected_style_version: positiveInputInteger(
      draft.expectedStyleVersion, "spatial service collection style expected version"
    ),
    render_profile_id: assertUuid(
      draft.renderProfileId, "spatial service collection render profile id"
    ),
    expected_profile_version: positiveInputInteger(
      draft.expectedProfileVersion,
      "spatial service collection render profile expected version"
    ),
    is_default: draft.isDefault
  };
}

export function parseSiteEdition(value) {
  const record = object(value, "site edition");
  const publicationReach = oneOf(
    record.publication_reach,
    ["unpublished", "unlisted", "listed"],
    "site edition.publication_reach"
  );
  const listedSlug = record.listed_slug === null
    ? null
    : siteSlugPath(record.listed_slug);
  const unlistedToken = nullableBoundedString(
    record.unlisted_token,
    32,
    "site edition.unlisted_token"
  );
  const isPrimary = boolean(record.is_primary, "site edition.is_primary");
  if (unlistedToken !== null && !/^[0-9a-f]{32}$/.test(unlistedToken)) {
    contract("site edition.unlisted_token is invalid");
  }
  if (
    (publicationReach === "unpublished" && (listedSlug !== null || unlistedToken !== null || isPrimary))
    || (publicationReach === "unlisted" && (listedSlug !== null || unlistedToken === null || isPrimary))
    || (publicationReach === "listed" && (listedSlug === null || unlistedToken !== null))
    || (isPrimary && publicationReach !== "listed")
  ) {
    contract("site edition publication destination is inconsistent");
  }
  return {
    id: uuid(record.id, "site edition.id"),
    siteId: uuid(record.site_id, "site edition.site_id"),
    siteVersionId: uuid(record.site_version_id, "site edition.site_version_id"),
    siteVersionNumber: positiveInteger(
      record.site_version_number,
      "site edition.site_version_number"
    ),
    editionNumber: positiveInteger(record.edition_number, "site edition.edition_number"),
    manifest: boundedObject(record.manifest, 32_768, "site edition.manifest"),
    manifestChecksumSha256: sha256(
      record.manifest_checksum_sha256,
      "site edition.manifest_checksum_sha256"
    ),
    publishedBy: uuid(record.published_by, "site edition.published_by"),
    publishedAt: timestamp(record.published_at, "site edition.published_at"),
    revokedBy: nullableUuid(record.revoked_by, "site edition.revoked_by"),
    revokedAt: nullableTimestamp(record.revoked_at, "site edition.revoked_at"),
    publicationReach,
    listedSlug,
    unlistedToken,
    isPrimary
  };
}

export function parseSiteAssetCandidate(value) {
  const record = object(value, "site asset candidate");
  exactKeys(record, [
    "kind",
    "dataset_id",
    "dataset_name",
    "dataset_version_id",
    "dataset_version_number",
    "object_id",
    "role",
    "content_type",
    "size_bytes",
    "checksum_sha256",
    "filename"
  ], "site asset candidate");
  const filename = boundedString(record.filename, 180, "site asset candidate.filename");
  if (filename.includes("/") || filename.includes("\\")) {
    contract("site asset candidate.filename is invalid");
  }
  return {
    kind: oneOf(record.kind, ["image", "file", "document"], "site asset candidate.kind"),
    datasetId: uuid(record.dataset_id, "site asset candidate.dataset_id"),
    datasetName: boundedString(record.dataset_name, 200, "site asset candidate.dataset_name"),
    datasetVersionId: uuid(
      record.dataset_version_id,
      "site asset candidate.dataset_version_id"
    ),
    datasetVersionNumber: positiveInteger(
      record.dataset_version_number,
      "site asset candidate.dataset_version_number"
    ),
    objectId: uuid(record.object_id, "site asset candidate.object_id"),
    role: oneOf(
      record.role,
      ["original", "derived", "published", "thumbnail"],
      "site asset candidate.role"
    ),
    contentType: boundedString(
      record.content_type,
      100,
      "site asset candidate.content_type"
    ),
    sizeBytes: integerBetween(record.size_bytes, 1, 4_194_304, "site asset candidate.size_bytes"),
    checksumSha256: sha256(
      record.checksum_sha256,
      "site asset candidate.checksum_sha256"
    ),
    filename
  };
}

export function parseObservableDataAttachment(value) {
  const record = object(value, "Observable data attachment");
  exactKeys(record, ["id", "source_project_id", "dataset_id", "dataset_version_id", "data_object_id",
    "s3_version_id", "checksum_sha256", "size_bytes", "content_type", "created_by", "created_at",
    "available", "revision_bound", "build_input", "publication_authorized"], "Observable data attachment");
  for (const key of ["revision_bound", "build_input", "publication_authorized"]) {
    if (record[key] !== false) contract(`Observable data attachment.${key} is unsupported`);
  }
  const s3VersionId = boundedString(record.s3_version_id, 1024, "attachment storage version");
  if (!s3VersionId.trim() || s3VersionId === "null") contract("attachment storage version is missing");
  const checksumSha256 = string(record.checksum_sha256, "attachment SHA-256");
  if (!/^[0-9a-f]{64}$/.test(checksumSha256)) contract("attachment SHA-256 is invalid");
  const sizeBytes = positiveInteger(record.size_bytes, "attachment size");
  if (!Number.isSafeInteger(sizeBytes)) contract("attachment size is unsafe");
  return {
    id: uuid(record.id, "attachment id"),
    sourceProjectId: uuid(record.source_project_id, "attachment source project"),
    datasetId: uuid(record.dataset_id, "attachment dataset"),
    datasetVersionId: uuid(record.dataset_version_id, "attachment dataset version"),
    dataObjectId: uuid(record.data_object_id, "attachment data object"),
    s3VersionId, checksumSha256, sizeBytes,
    contentType: boundedString(record.content_type, 255, "attachment media type"),
    createdBy: uuid(record.created_by, "attachment creator"),
    createdAt: timestamp(record.created_at, "attachment creation time"),
    available: boolean(record.available, "attachment availability"),
    revisionBound: false, buildInput: false, publicationAuthorized: false
  };
}

export function parseObservablePublicFileReference(value) {
  const record = object(value, "public file reference");
  exactKeys(record, ["id", "source_project_id", "dataset_id", "source_version", "resource_id",
    "resource_version_id", "resource_version_number", "distribution_id", "url", "content_type",
    "size_bytes", "checksum_sha256", "created_by", "created_at", "available", "kind", "custody",
    "revision_bound", "build_input", "publication_authorized"], "public file reference");
  for (const key of ["revision_bound", "build_input", "publication_authorized"]) {
    if (record[key] !== false) contract(`Public file reference.${key} is unsupported`);
  }
  if (record.kind !== "referenced-public-file" || record.custody !== "referenced") {
    contract("Public file reference custody is inconsistent");
  }
  return {
    id: uuid(record.id, "public reference id"),
    sourceProjectId: uuid(record.source_project_id, "public reference source project"),
    datasetId: uuid(record.dataset_id, "public reference dataset"),
    sourceVersion: integerBetween(record.source_version, 1, Number.MAX_SAFE_INTEGER, "public reference source version"),
    resourceId: uuid(record.resource_id, "public reference resource"),
    resourceVersionId: uuid(record.resource_version_id, "public reference resource version"),
    resourceVersionNumber: integerBetween(record.resource_version_number, 1, Number.MAX_SAFE_INTEGER, "public reference metadata version"),
    distributionId: boundedString(record.distribution_id, 1000, "public reference distribution"),
    url: publicReferencedFileUrl(record.url),
    contentType: oneOf(record.content_type, ["image/tiff", "image/geotiff"], "public reference media"),
    sizeBytes: integerBetween(record.size_bytes, 1, 67_108_864, "public reference bytes"),
    checksumSha256: sha256(record.checksum_sha256, "public reference checksum"),
    createdBy: uuid(record.created_by, "public reference creator"),
    createdAt: timestamp(record.created_at, "public reference creation time"),
    available: boolean(record.available, "public reference availability"),
    kind: "referenced-public-file", custody: "referenced",
    revisionBound: false, buildInput: false, publicationAuthorized: false
  };
}

export function parseObservableSourceProject(value) {
  const record = object(value, "Observable source project");
  exactKeys(record, [
    "id", "project_id", "site_id", "route_namespace", "title", "rights_status",
    "owner_user_id", "current_revision_id", "current_revision_number", "build_policy",
    "created_by", "created_at", "updated_by", "updated_at"
  ], "Observable source project");
  const policy = object(record.build_policy, "Observable source build policy");
  exactKeys(policy, [
    "compiler_image_digest", "framework_version", "lockfile_format", "network_policy",
    "resource_limits"
  ], "Observable source build policy");
  const resourceLimits = object(policy.resource_limits, "Observable source resource limits");
  const limitNames = [
    "cpuMillis", "memoryMiB", "timeoutSeconds", "maxInputFiles", "maxInputBytes",
    "maxOutputFiles", "maxOutputBytes"
  ];
  exactKeys(resourceLimits, limitNames, "Observable source resource limits");
  return {
    id: uuid(record.id, "Observable source project.id"),
    projectId: uuid(record.project_id, "Observable source project.project_id"),
    siteId: uuid(record.site_id, "Observable source project.site_id"),
    routeNamespace: siteSlug(record.route_namespace, "Observable source route namespace"),
    title: boundedString(record.title, 300, "Observable source project.title"),
    rightsStatus: oneOf(
      record.rights_status,
      ["unreviewed", "approved", "rejected"],
      "Observable source project.rights_status"
    ),
    ownerUserId: uuid(record.owner_user_id, "Observable source project.owner_user_id"),
    currentRevisionId: nullableUuid(
      record.current_revision_id,
      "Observable source project.current_revision_id"
    ),
    currentRevisionNumber: nonNegativeInteger(
      record.current_revision_number,
      "Observable source project.current_revision_number"
    ),
    buildPolicy: {
      compilerImageDigest: compilerImageDigest(
        policy.compiler_image_digest,
        "Observable source compiler image digest"
      ),
      frameworkVersion: oneOf(
        policy.framework_version,
        ["1.13.4"],
        "Observable source framework version"
      ),
      lockfileFormat: oneOf(
        policy.lockfile_format,
        ["npm-package-lock-v3"],
        "Observable source lockfile format"
      ),
      networkPolicy: oneOf(
        policy.network_policy,
        ["deny_all"],
        "Observable source network policy"
      ),
      resourceLimits: Object.fromEntries(limitNames.map((name) => [
        name,
        positiveInteger(resourceLimits[name], `Observable source resource limits.${name}`)
      ]))
    },
    createdBy: uuid(record.created_by, "Observable source project.created_by"),
    createdAt: timestamp(record.created_at, "Observable source project.created_at"),
    updatedBy: uuid(record.updated_by, "Observable source project.updated_by"),
    updatedAt: timestamp(record.updated_at, "Observable source project.updated_at")
  };
}

export function parseObservableSourceFileUpload(value) {
  const record = object(value, "Observable source file upload");
  exactKeys(record, [
    "upload_id", "source_project_id", "relative_path", "content_type", "size_bytes",
    "checksum_sha256", "expires_at", "upload"
  ], "Observable source file upload");
  return {
    uploadId: uuid(record.upload_id, "Observable source file upload.upload_id"),
    sourceProjectId: uuid(
      record.source_project_id,
      "Observable source file upload.source_project_id"
    ),
    relativePath: parseObservableSourcePath(
      record.relative_path,
      "Observable source file upload.relative_path"
    ),
    contentType: observableSourceContentType(
      record.content_type,
      "Observable source file upload.content_type"
    ),
    sizeBytes: integerBetween(
      record.size_bytes,
      1,
      4_194_304,
      "Observable source file upload.size_bytes"
    ),
    checksumSha256: sha256Checksum(
      record.checksum_sha256,
      "Observable source file upload.checksum_sha256"
    ),
    expiresAt: timestamp(record.expires_at, "Observable source file upload.expires_at"),
    upload: parseUploadInstructions(record.upload)
  };
}

export function normalizeObservableRevisionAttachments(value, files = []) {
  if (!Array.isArray(value) || value.length + files.length > 128) {
    throw new TypeError("Source and archive bindings are limited to 128 files");
  }
  const bindings = value.map(item => {
    const relativePath = assertObservableSourcePath(item.relativePath, "archive binding path");
    if (!/\.(json|geojson|csv|txt|png|jpe?g|tiff?)$/i.test(relativePath)
      || /(^|\/)(package\.json|package-lock\.json)$/i.test(relativePath)) {
      throw new TypeError("Archive bindings must be data files, not executable source or package configuration");
    }
    return {attachmentId: assertUuid(item.attachmentId, "archive reference id"), relativePath};
  }).sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  const paths = [...files, ...bindings].map(item => item.relativePath.toLowerCase());
  if (paths.some((path, index) => paths.slice(index + 1).some(other =>
    path === other || path.startsWith(other + "/") || other.startsWith(path + "/")))) {
    throw new TypeError("Source and archive paths must not collide");
  }
  return bindings;
}

export function normalizeObservableRevisionReferencedFiles(value, files = []) {
  if (!Array.isArray(value) || value.length + files.length > 128) {
    throw new TypeError("Source and data bindings are limited to 128 files");
  }
  const bindings = value.map(item => {
    exactKeys(object(item, "public file binding"), ["referenceId", "relativePath"], "public file binding");
    const relativePath = assertObservableSourcePath(item.relativePath, "public file binding path");
    if (!/\.tiff?$/i.test(relativePath)) throw new TypeError("Public file bindings must name TIFF data files");
    return {referenceId: assertUuid(item.referenceId, "public file reference id"), relativePath};
  }).sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  const paths = [...files, ...bindings].map(item => item.relativePath.toLowerCase());
  if (paths.some((path, index) => paths.slice(index + 1).some(other =>
    path === other || path.startsWith(other + "/") || other.startsWith(path + "/")))) {
    throw new TypeError("Source, archive and public file paths must not collide");
  }
  return bindings;
}

function parseObservableRevisionDataBindings(manifest, files) {
  const hasReferences = manifest.schemaVersion === "opengeo.observable-source-revision.3.0.0";
  if (!hasReferences && Object.hasOwn(manifest, "referencedFiles")) contract("Public file bindings require source manifest version 3");
  if (!hasReferences && manifest.schemaVersion !== "opengeo.observable-source-revision.2.0.0") {
    if (manifest.schemaVersion !== "opengeo.observable-source-revision.1.0.0") contract("Unsupported source manifest version");
    if (Object.hasOwn(manifest, "dataAttachments")) contract("Archive bindings require source manifest version 2");
    return [];
  }
  const bindings = parseArray(manifest.dataAttachments, value => {
    const item = object(value, "source archive binding");
    exactKeys(item, ["path", "attachmentId", "datasetId", "datasetVersionId", "dataObjectId",
      "s3VersionId", "checksumSha256", "sizeBytes", "contentType"], "source archive binding");
    for (const key of ["datasetId", "datasetVersionId", "dataObjectId"]) uuid(item[key], key);
    sha256Checksum(item.checksumSha256, "archive checksum");
    integerBetween(item.sizeBytes, 1, 67_108_864, "archive bytes");
    const version = boundedString(item.s3VersionId, 1024, "archive storage version");
    if (!version.trim() || version === "null") contract("Archive storage version is missing");
    if (/\.tiff?$/i.test(item.path)) {
      oneOf(item.contentType, ["image/tiff", "image/geotiff"], "archive media type");
    } else {
      observableSourceContentType(item.contentType, "archive media type");
    }
    return {attachmentId: item.attachmentId, relativePath: item.path};
  }, "source archive bindings");
  const normalized = normalizeObservableRevisionAttachments(bindings, files);
  if ((!hasReferences && !bindings.length) || bindings.some((item, index) => item.relativePath !== normalized[index].relativePath)
    || manifest.dataAttachments.reduce((sum, item) => sum + item.sizeBytes, 0) > 67_108_864) {
    contract("Source archive bindings must be sorted and bounded to 64 MiB");
  }
  return normalized;
}

function parseObservableRevisionReferencedFiles(manifest, files, attachments) {
  if (manifest.schemaVersion !== "opengeo.observable-source-revision.3.0.0") return [];
  const bindings = parseArray(manifest.referencedFiles, value => {
    const item = object(value, "public file pin");
    exactKeys(item, ["referenceId", "path", "kind", "custody", "datasetId", "sourceVersion", "resourceId",
      "resourceVersionId", "resourceVersionNumber", "distributionId", "url", "contentType",
      "sizeBytes", "checksumSha256"], "public file pin");
    if (item.kind !== "referenced-public-file" || item.custody !== "referenced") contract("Public file pin custody is invalid");
    for (const key of ["datasetId", "resourceId", "resourceVersionId"]) uuid(item[key], `public file ${key}`);
    integerBetween(item.sourceVersion, 1, Number.MAX_SAFE_INTEGER, "public file source version");
    integerBetween(item.resourceVersionNumber, 1, Number.MAX_SAFE_INTEGER, "public file metadata version");
    boundedString(item.distributionId, 1000, "public file distribution");
    publicReferencedFileUrl(item.url);
    oneOf(item.contentType, ["image/tiff", "image/geotiff"], "public file media");
    sha256Checksum(item.checksumSha256, "public file checksum");
    integerBetween(item.sizeBytes, 1, 67_108_864, "public file bytes");
    return {referenceId: item.referenceId, relativePath: item.path};
  }, "public file pins");
  const normalized = normalizeObservableRevisionReferencedFiles(bindings, [...files, ...attachments]);
  if (!bindings.length || bindings.some((item, index) => item.relativePath !== normalized[index].relativePath)
    || [...manifest.dataAttachments, ...manifest.referencedFiles].reduce((sum, item) => sum + item.sizeBytes, 0) > 67_108_864) {
    contract("Public file pins must be sorted and combined data bounded to 64 MiB");
  }
  return normalized;
}

export function publicReferencedFileUrl(value) {
  const url = publicSourceUrl(value, "cog");
  if (url.includes("?") || /\s/.test(url)) contract("Public file URL must be query-free and exact");
  return url;
}

export function parseObservableSourceRevision(value) {
  const record = object(value, "Observable source revision");
  exactKeys(record, [
    "id", "source_project_id", "revision_number", "parent_revision_id", "title",
    "rights_status", "entry_path", "lockfile_path", "manifest",
    "manifest_checksum_sha256", "change_summary", "created_by", "created_at", "files"
  ], "Observable source revision");
  const files = parseArray(record.files, (value) => {
    const file = object(value, "Observable source revision file");
    exactKeys(file, [
      "relative_path", "source_object_id", "bucket", "object_key", "s3_version_id",
      "etag", "content_type", "size_bytes", "checksum_sha256"
    ], "Observable source revision file");
    return {
      relativePath: parseObservableSourcePath(
        file.relative_path,
        "Observable source revision file.relative_path"
      ),
      sourceObjectId: uuid(
        file.source_object_id,
        "Observable source revision file.source_object_id"
      ),
      bucket: boundedString(file.bucket, 63, "Observable source revision file.bucket"),
      objectKey: boundedString(
        file.object_key,
        1024,
        "Observable source revision file.object_key"
      ),
      s3VersionId: boundedString(
        file.s3_version_id,
        1024,
        "Observable source revision file.s3_version_id"
      ),
      etag: boundedString(file.etag, 512, "Observable source revision file.etag"),
      contentType: observableSourceContentType(
        file.content_type,
        "Observable source revision file.content_type"
      ),
      sizeBytes: integerBetween(
        file.size_bytes,
        1,
        4_194_304,
        "Observable source revision file.size_bytes"
      ),
      checksumSha256: sha256Checksum(
        file.checksum_sha256,
        "Observable source revision file.checksum_sha256"
      )
    };
  }, "Observable source revision.files");
  if (!files.length || files.length > 128) contract("Observable source revision.files is invalid");
  const paths = files.map(({relativePath}) => relativePath);
  const sorted = [...paths].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (paths.some((path, index) => path !== sorted[index])
    || new Set(paths.map((path) => path.toLowerCase())).size !== paths.length) {
    contract("Observable source revision.files must be exact, sorted, and unique");
  }
  const entryPath = parseObservableSourcePath(
    record.entry_path,
    "Observable source revision.entry_path"
  );
  const lockfilePath = record.lockfile_path === null
    ? null
    : parseObservableSourcePath(
      record.lockfile_path,
      "Observable source revision.lockfile_path"
    );
  if (!paths.includes(entryPath) || (!/\.(md|ipynb)$/i.test(entryPath) && !/(^|\/)index\.html$/.test(entryPath))
    || (lockfilePath !== null && (lockfilePath !== "package-lock.json"
      || !paths.includes(lockfilePath)))) {
    contract("Observable source revision entry or lockfile is inconsistent");
  }
  const manifest = boundedObject(record.manifest, 131_072, "Observable source revision.manifest");
  const dataAttachments = parseObservableRevisionDataBindings(manifest, files);
  const referencedFiles = parseObservableRevisionReferencedFiles(manifest, files, dataAttachments);
  return {
    id: uuid(record.id, "Observable source revision.id"),
    sourceProjectId: uuid(
      record.source_project_id,
      "Observable source revision.source_project_id"
    ),
    revisionNumber: positiveInteger(
      record.revision_number,
      "Observable source revision.revision_number"
    ),
    parentRevisionId: nullableUuid(
      record.parent_revision_id,
      "Observable source revision.parent_revision_id"
    ),
    title: boundedString(record.title, 300, "Observable source revision.title"),
    rightsStatus: oneOf(
      record.rights_status,
      ["unreviewed", "approved", "rejected"],
      "Observable source revision.rights_status"
    ),
    entryPath,
    lockfilePath,
    manifest,
    dataAttachments,
    ...(referencedFiles.length ? {referencedFiles} : {}),
    manifestChecksumSha256: sha256Checksum(
      record.manifest_checksum_sha256,
      "Observable source revision.manifest_checksum_sha256"
    ),
    changeSummary: boundedString(
      record.change_summary,
      500,
      "Observable source revision.change_summary"
    ),
    createdBy: uuid(record.created_by, "Observable source revision.created_by"),
    createdAt: timestamp(record.created_at, "Observable source revision.created_at"),
    files
  };
}

export function parseFrameworkPublications(value, sourceProjectId) {
  if (!value || value.source_project_id !== sourceProjectId || typeof value.can_publish !== "boolean" ||
      typeof value.dispatch_configured !== "boolean" || !Array.isArray(value.mounts) ||
      !Array.isArray(value.reviews) || value.reviews.length > 25) contract("Invalid publication status");
  const destination = record => {
    if (!/^[a-z0-9][a-z0-9.-]{1,251}[a-z0-9]$/.test(record.hostname ?? "") ||
        !(record.mount_path === "/" || /^\/[a-z0-9][a-z0-9-]{0,79}(\/[a-z0-9][a-z0-9-]{0,79}){0,7}\/$/.test(record.mount_path ?? ""))) contract("Invalid publication destination");
    return {hostname: record.hostname, mountPath: record.mount_path, url: `https://${record.hostname}${record.mount_path}`};
  };
  const mounts = value.mounts.map(record => {
    if (!record || typeof record.enabled !== "boolean" || !Number.isSafeInteger(record.generation) || record.generation < 1) contract("Invalid publication mount");
    return {id: pathUuid(record.id, "mount id"), ...destination(record), generation: record.generation, enabled: record.enabled};
  });
  if (value.can_configure_destinations !== undefined && typeof value.can_configure_destinations !== "boolean") contract("Invalid destination configuration permission");
  if (value.origins !== undefined && !Array.isArray(value.origins)) contract("Invalid public hosting origins");
  const origins = (value.origins ?? []).map(record => {
    const target = destination({...record, mount_path: record.path_prefix});
    if (target.mountPath === "/" || target.mountPath.split('/').filter(Boolean).length > 7
      || ['studio.opengeo.tools', 'preview.studio.opengeo.tools', 'maps-preview.studio.opengeo.tools', 'api.opengeo.tools', 'auth.opengeo.tools'].includes(target.hostname)) contract("Unsafe public hosting origin");
    return {id: pathUuid(record.id, "origin id"), hostname: target.hostname, pathPrefix: target.mountPath, urlPrefix: target.url};
  });
  if (origins.length > 100 || new Set(origins.map(origin => origin.id)).size !== origins.length
    || (origins.length > 0 && value.can_configure_destinations !== true)) contract("Invalid public hosting origins");
  const reviews = value.reviews.map(record => {
    if (!record || !/^[a-f0-9]{64}$/.test(record.result_checksum_sha256 ?? "") ||
        !/^[a-f0-9]{64}$/.test(record.output_tree_checksum_sha256 ?? "") ||
        !/^releases\/[A-Za-z0-9_-]+$/.test(record.previous_release_prefix ?? "") ||
        !Number.isSafeInteger(record.expected_generation) || record.expected_generation < 1 ||
        !Number.isFinite(Date.parse(record.reviewed_at)) || !Number.isFinite(Date.parse(record.expires_at)) ||
        (record.approved_at !== null && !Number.isFinite(Date.parse(record.approved_at)))) contract("Invalid publication review");
    let deployment = null;
    if (record.deployment != null) {
      const job = record.deployment;
      if (!["preparing", "copying", "activating", "deployed", "needs_attention"].includes(job.stage) ||
          !Number.isSafeInteger(job.completed_files) || job.completed_files < 0 || job.completed_files > 2048 ||
          (job.total_files !== null && (!Number.isSafeInteger(job.total_files) || job.total_files < job.completed_files || job.total_files > 2048)) ||
          !Number.isFinite(Date.parse(job.updated_at)) ||
          (job.error_code !== null && !/^[a-z0-9_]{1,100}$/.test(job.error_code)) ||
          (job.stage === "deployed" ? job.release_prefix !== `releases/framework-${record.id}` : job.release_prefix !== null)) contract("Invalid publication deployment");
      deployment = {stage: job.stage, completedFiles: job.completed_files, totalFiles: job.total_files,
        errorCode: job.error_code, updatedAt: job.updated_at, releasePrefix: job.release_prefix};
    }
    return {id: pathUuid(record.id, "review id"), ...destination(record), buildJobId: pathUuid(record.build_job_id, "build id"),
      mountId: pathUuid(record.mount_id, "mount id"), resultChecksumSha256: record.result_checksum_sha256,
      outputTreeChecksumSha256: record.output_tree_checksum_sha256, expectedGeneration: record.expected_generation,
      previousReleasePrefix: record.previous_release_prefix, reviewedAt: record.reviewed_at,
      expiresAt: record.expires_at, approvedAt: record.approved_at, deployment};
  });
  if (new Set(mounts.map(record => record.id)).size !== mounts.length || new Set(reviews.map(record => record.id)).size !== reviews.length) contract("Duplicate publication identity");
  return {sourceProjectId, canPublish: value.can_publish, dispatchConfigured: value.dispatch_configured, mounts, reviews,
    canConfigureDestinations: value.can_configure_destinations === true, origins};
}

export function parseObservableGitHubStatus(value, sourceProjectId) {
  if (!value || typeof value !== "object" || value.source_project_id !== sourceProjectId ||
      typeof value.can_connect !== "boolean" || !Array.isArray(value.available_connections) ||
      !Array.isArray(value.revisions) || value.revisions.length > 25) contract("Invalid GitHub source status");
  function connection(item) {
    if (!item || typeof item !== "object" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item.repository ?? "") ||
        !Number.isSafeInteger(item.repository_id) || item.repository_id < 1 ||
        typeof item.enabled !== "boolean" || !Number.isFinite(Date.parse(item.verified_at))) contract("Invalid GitHub connection");
    return {id: pathUuid(item.id, "GitHub connection id"), repository: item.repository,
      repositoryId: item.repository_id, enabled: item.enabled, verifiedAt: item.verified_at};
  }
  const selected = value.connection === null ? null : connection(value.connection);
  const available = value.available_connections.map(connection);
  if (new Set(available.map(item => item.id)).size !== available.length ||
      available.some(item => !item.enabled) || (selected && value.can_connect)) contract("Invalid GitHub connection state");
  const revisions = value.revisions.map(item => {
    const id = pathUuid(item.source_revision_id, "source revision id");
    if (!selected || !Number.isSafeInteger(item.revision_number) || item.revision_number < 1 ||
        !/^[0-9a-f]{40}$/.test(item.commit_sha ?? "") || !/^[0-9a-f]{40}$/.test(item.tree_sha ?? "") ||
        !/^[0-9a-f]{64}$/.test(item.manifest_sha256 ?? "") ||
        item.git_ref !== `heads/studio/sources/${sourceProjectId}/revisions/${id}` ||
        !Number.isFinite(Date.parse(item.created_at))) contract("Invalid GitHub revision receipt");
    return {sourceRevisionId: id, revisionNumber: item.revision_number, commitSha: item.commit_sha,
      treeSha: item.tree_sha, manifestSha256: item.manifest_sha256, createdAt: item.created_at};
  });
  if (value.syncs != null && !Array.isArray(value.syncs)) contract("Invalid GitHub sync state");
  const syncs = (value.syncs ?? []).map(item => {
    if (!item || !["pending", "syncing", "synced", "failed"].includes(item.stage) ||
        !Number.isSafeInteger(item.revision_number) || item.revision_number < 1 ||
        !Number.isFinite(Date.parse(item.updated_at)) ||
        (item.error_code !== null && !/^[a-z0-9_]{1,100}$/.test(item.error_code))) contract("Invalid GitHub sync state");
    return {sourceRevisionId: pathUuid(item.source_revision_id, "revision id"), revisionNumber: item.revision_number,
      stage: item.stage, errorCode: item.error_code, updatedAt: item.updated_at};
  });
  if (syncs.length > 25 || new Set(syncs.map(item => item.sourceRevisionId)).size !== syncs.length ||
      (value.can_sync !== undefined && typeof value.can_sync !== "boolean") ||
      (value.sync_configured !== undefined && typeof value.sync_configured !== "boolean")) contract("Invalid GitHub sync state");
  return {sourceProjectId, connection: selected, availableConnections: available,
    canConnect: value.can_connect, revisions, syncs, canSync: value.can_sync === true,
    syncConfigured: value.sync_configured === true,
    currentRevisionId: value.current_revision_id == null ? null : pathUuid(value.current_revision_id, "revision id")};
}

export function parseObservableBuildJob(value) {
  const record = object(value, "Observable build job");
  exactKeys(record, [
    "id", "source_project_id", "source_revision_id", "source_revision_number", "purpose",
    "state", "request", "request_checksum_sha256", "result",
    "result_checksum_sha256", "attempt_count", "error_code", "created_by", "created_at",
    "started_at", "finished_at", "updated_at", "execution_available", "coordination_status"
  ], "Observable build job");
  const executionAvailable = boolean(record.execution_available, "Observable execution availability");
  const coordinationStatus = oneOf(record.coordination_status, ["not_configured", "configured", "dispatched", "dispatch_failed"], "Observable coordination status");
  if (executionAvailable !== (coordinationStatus !== "not_configured")) {
    contract("Observable build execution boundary is invalid");
  }
  const request = parseObservableBuildRequest(record.request);
  const sourceProjectId = uuid(
    record.source_project_id,
    "Observable build job.source_project_id"
  );
  const sourceRevisionId = uuid(
    record.source_revision_id,
    "Observable build job.source_revision_id"
  );
  const sourceRevisionNumber = positiveInteger(
    record.source_revision_number,
    "Observable build job.source_revision_number"
  );
  const purpose = oneOf(
    record.purpose,
    ["preview", "release_candidate"],
    "Observable build purpose"
  );
  if (request.sourceProjectId !== sourceProjectId
    || request.sourceRevisionId !== sourceRevisionId
    || request.sourceRevisionNumber !== sourceRevisionNumber
    || request.purpose !== purpose) {
    contract("Observable build request does not match its job");
  }
  const id = uuid(record.id, "Observable build job.id");
  const state = oneOf(
    record.state,
    ["pending", "running", "succeeded", "failed", "cancelled"],
    "Observable build state"
  );
  const requestChecksumSha256 = sha256Checksum(
    record.request_checksum_sha256,
    "Observable build request checksum"
  );
  const result = record.result === null ? null : parseObservableBuildResult(record.result);
  const resultChecksumSha256 = record.result_checksum_sha256 === null
    ? null
    : sha256Checksum(record.result_checksum_sha256, "Observable build result checksum");
  if ((state === "succeeded") !== (result !== null)
    || (result === null) !== (resultChecksumSha256 === null)
    || (result !== null && (
      result.buildJobId !== id
      || result.requestChecksumSha256 !== requestChecksumSha256
      || result.compilerImageDigest !== request.compilerImageDigest
      || result.inputManifestChecksumSha256 !== request.sourceManifestChecksumSha256
    ))) {
    contract("Observable build result does not match its job");
  }
  return {
    id,
    sourceProjectId,
    sourceRevisionId,
    sourceRevisionNumber,
    purpose,
    state,
    request,
    requestChecksumSha256,
    result,
    resultChecksumSha256,
    attemptCount: nonNegativeInteger(record.attempt_count, "Observable build attempt count"),
    errorCode: record.error_code === null
      ? null
      : machineCode(record.error_code, "Observable build error code"),
    createdBy: uuid(record.created_by, "Observable build job.created_by"),
    createdAt: timestamp(record.created_at, "Observable build job.created_at"),
    startedAt: nullableTimestamp(record.started_at, "Observable build job.started_at"),
    finishedAt: nullableTimestamp(record.finished_at, "Observable build job.finished_at"),
    updatedAt: timestamp(record.updated_at, "Observable build job.updated_at"),
    executionAvailable,
    coordinationStatus
  };
}

export function parsePublicationArtifactReferences(value) {
  const record = object(value, "Publication Artifact references");
  exactKeys(record, ["revision", "references"], "Publication Artifact references");
  const revision = nonNegativeInteger(record.revision, "Artifact reference revision");
  if (revision > 2147483647 || !Array.isArray(record.references) || record.references.length > 32) contract("Invalid Artifact reference set");
  const references = record.references.map(item => {
    exactKeys(object(item, "Artifact reference"), ["path", "artifact_id", "mode", "version"], "Artifact reference");
    const path = parseObservableSourcePath(item.path, "Artifact path");
    if (!path.endsWith(".html")) contract("Artifact path must end in .html");
    const mode = oneOf(item.mode, ["current", "pinned"], "Artifact selection");
    if (mode === "current" ? item.version !== null : !Number.isInteger(item.version) || item.version < 1 || item.version > 2147483647) contract("Invalid Artifact edition selection");
    return {path, artifact_id: uuid(item.artifact_id, "Artifact identity"), mode, version: item.version};
  });
  const paths = references.map(item => item.path.toLowerCase());
  if (paths.some((a, i) => paths.some((b, j) => i !== j && (a === b || a.startsWith(b + "/"))))) contract("Artifact paths overlap");
  return {revision, references};
}

export function parsePublicationArtifactBackupInputs(value, projectId, sourceProjectId, expectedReferenceRevision) {
  const record = object(value, "Publication Artifact backup inputs");
  exactKeys(record, ["schema_version", "project_id", "source_project_id", "reference_revision", "pins"], "Publication Artifact backup inputs");
  const schemaVersion = oneOf(record.schema_version, ["opengeo.publication-artifact-backup-inputs.1.0.0"], "Artifact backup schema");
  const project = uuid(record.project_id, "Artifact backup project identity");
  const source = uuid(record.source_project_id, "Artifact backup source identity");
  if (project !== uuid(projectId, "requested Artifact backup project identity")
    || source !== uuid(sourceProjectId, "requested Artifact backup source identity")) {
    contract("Artifact backup source identity mismatch");
  }
  if (!Array.isArray(record.pins) || record.pins.length > 32) contract("Invalid Artifact backup pin set");
  const selection = parsePublicationArtifactReferences({revision: record.reference_revision, references: record.pins.map(pin => {
    exactKeys(object(pin, "Artifact backup pin"), [
      "path", "artifact_id", "mode", "version", "resolved_version", "manifest_checksum_sha256", "output", "project_id", "resource_id"
    ], "Artifact backup pin");
    return {path: pin.path, artifact_id: pin.artifact_id, mode: pin.mode, version: pin.version};
  })});
  if ((expectedReferenceRevision !== undefined && selection.revision !== expectedReferenceRevision)
    || (selection.revision === 0 && record.pins.length !== 0)) {
    contract("Artifact backup reference revision mismatch");
  }
  const pins = record.pins.map((pin, index) => {
    const reference = selection.references[index];
    const resolvedVersion = integerBetween(pin.resolved_version, 1, 2147483647, "Artifact backup resolved version");
    if (reference.mode === "pinned" && resolvedVersion !== reference.version) contract("Artifact backup pinned edition mismatch");
    const output = object(pin.output, "Artifact backup output");
    exactKeys(output, ["objectId", "mediaType", "sizeBytes", "checksumSha256"], "Artifact backup output");
    return {
      path: reference.path,
      artifactId: reference.artifact_id,
      mode: reference.mode,
      version: reference.version,
      resolvedVersion,
      manifestChecksumSha256: sha256(pin.manifest_checksum_sha256, "Artifact backup manifest checksum"),
      projectId: uuid(pin.project_id, "Artifact backup origin project identity"),
      resourceId: uuid(pin.resource_id, "Artifact backup origin resource identity"),
      output: {
        objectId: uuid(output.objectId, "Artifact backup output identity"),
        mediaType: oneOf(output.mediaType, ["text/html"], "Artifact backup output media type"),
        sizeBytes: integerBetween(output.sizeBytes, 1, 4_194_304, "Artifact backup output size"),
        checksumSha256: sha256(output.checksumSha256, "Artifact backup output checksum")
      }
    };
  });
  return {schemaVersion, projectId: project, sourceProjectId: source, referenceRevision: selection.revision, pins};
}

function parseDistributionArchivePin(value) {
  const pin = object(value, "Distribution archive pin");
  const fields = ["path", "attachmentId", "datasetId", "datasetVersionId", "dataObjectId", "s3VersionId", "checksumSha256", "sizeBytes", "contentType"];
  exactKeys(pin, fields, "Distribution archive pin");
  parseObservableRevisionDataBindings({schemaVersion: "opengeo.observable-source-revision.2.0.0", dataAttachments: [pin]}, []);
  uuid(pin.attachmentId, "archive attachment id");
  parseObservableSourcePath(pin.path, "archive path");
  return pin;
}

function parseDistributionReferencePin(value) {
  const pin = object(value, "Distribution referenced file pin");
  parseObservableRevisionReferencedFiles({schemaVersion: "opengeo.observable-source-revision.3.0.0",
    dataAttachments: [], referencedFiles: [pin]}, [], []);
  return pin;
}

function validateDistributionReferencePins(archives, references, artifacts) {
  parseObservableRevisionReferencedFiles({schemaVersion: "opengeo.observable-source-revision.3.0.0",
    dataAttachments: archives, referencedFiles: references},
  artifacts.map(item => ({relativePath: item.path})), archives.map(item => ({relativePath: item.path})));
}

function parseDistributionArtifactOutput(value) {
  const output = object(value, "Distribution Artifact output");
  exactKeys(output, ["objectId", "mediaType", "sizeBytes", "checksumSha256"], "Distribution Artifact output");
  if (output.objectId !== null) uuid(output.objectId, "Artifact output id");
  oneOf(output.mediaType, ["text/html"], "Artifact output type");
  integerBetween(output.sizeBytes, 1, 4_194_304, "Artifact output size");
  sha256(output.checksumSha256, "Artifact output checksum");
  return output;
}

function parsePublicationInputApproval(value, projectId, sourceProjectId, revisionId) {
  const record = object(value, "Input distribution approval");
  exactKeys(record, ["id", "manifest", "manifest_checksum_sha256", "revoked", ...(Object.hasOwn(record, "reused") ? ["reused"] : [])], "Input distribution approval");
  const manifest = boundedObject(record.manifest, 262_144, "Input distribution approval manifest");
  const withReferences = manifest.schemaVersion === "opengeo.observable-input-distribution-approval.2.0.0";
  exactKeys(manifest, ["schemaVersion", "organizationId", "projectId", "sourceProjectId", "sourceRevisionId", "sourceManifestChecksumSha256",
    "compilerImageDigest", "outputProfile", "artifactInputsChecksumSha256", "dataAttachments", "archiveRights", "artifacts",
    ...(withReferences ? ["referencedFiles", "referenceRights"] : [])], "Input distribution approval manifest");
  if ((!withReferences && manifest.schemaVersion !== "opengeo.observable-input-distribution-approval.1.0.0") || manifest.projectId !== projectId
    || manifest.sourceProjectId !== sourceProjectId || manifest.sourceRevisionId !== revisionId) contract("Input distribution approval source mismatch");
  for (const key of ["organizationId", "projectId", "sourceProjectId", "sourceRevisionId"]) uuid(manifest[key], key);
  sha256(manifest.sourceManifestChecksumSha256, "distribution source checksum");
  compilerImageDigest(manifest.compilerImageDigest, "distribution compiler image");
  oneOf(manifest.outputProfile, ["default-32m", "archive-96m"], "distribution output profile");
  if (manifest.artifactInputsChecksumSha256 !== null) sha256(manifest.artifactInputsChecksumSha256, "distribution Artifact input checksum");
  if (!Array.isArray(manifest.dataAttachments) || manifest.dataAttachments.length > 128
    || !Array.isArray(manifest.archiveRights) || manifest.archiveRights.length !== manifest.dataAttachments.length
    || !Array.isArray(manifest.artifacts) || manifest.artifacts.length > 32
    || (manifest.artifacts.length > 0) !== (manifest.artifactInputsChecksumSha256 !== null)) contract("Invalid distribution input set");
  if (withReferences && (!Array.isArray(manifest.referencedFiles) || manifest.referencedFiles.length < 1
    || manifest.referencedFiles.length > 128 || !Array.isArray(manifest.referenceRights)
    || manifest.referenceRights.length !== manifest.referencedFiles.length)) contract("Invalid referenced distribution input set");
  manifest.dataAttachments.forEach(parseDistributionArchivePin);
  if (manifest.dataAttachments.reduce((sum, item) => sum + item.sizeBytes, 0) > 67_108_864) contract("Distribution archive input limit exceeded");
  manifest.archiveRights.forEach((item, index) => {
    exactKeys(object(item, "Archive distribution rights"), ["path", "attachmentId", "resourceId", "resourceVersionId", "license", "attribution", "acknowledgment"], "Archive distribution rights");
    const pin = manifest.dataAttachments[index];
    if (item.path !== pin.path || item.attachmentId !== pin.attachmentId || item.acknowledgment !== "publish-exact-archive-file") contract("Archive distribution pin mismatch");
    uuid(item.resourceId, "archive resource id"); uuid(item.resourceVersionId, "archive resource version id");
    oneOf(item.license, ["CC0-1.0", "CC-BY-4.0", "PDDL-1.0"], "archive distribution license");
    if (!boundedString(item.attribution, 4000, "archive distribution attribution").trim()) contract("Archive attribution is required");
  });
  manifest.artifacts.forEach(item => {
    exactKeys(object(item, "Artifact distribution pin"), ["path", "artifactId", "version", "outputObjectId", "manifestChecksumSha256", "output", "releaseId",
      "resourceId", "resourceVersionId", "license", "attribution", "acknowledgment", "sourceResources"], "Artifact distribution pin");
    parseObservableSourcePath(item.path, "Artifact path");
    for (const key of ["artifactId", "outputObjectId", "releaseId", "resourceId", "resourceVersionId"]) uuid(item[key], key);
    integerBetween(item.version, 1, 2147483647, "Artifact edition");
    sha256(item.manifestChecksumSha256, "Artifact manifest checksum");
    parseDistributionArtifactOutput(item.output);
    if (item.output.objectId !== null && item.output.objectId !== item.outputObjectId || item.acknowledgment !== "publish-exact-map-artifact") contract("Artifact distribution output mismatch");
    oneOf(item.license, ["CC0-1.0", "CC-BY-4.0", "PDDL-1.0"], "Artifact distribution license");
    if (!boundedString(item.attribution, 4000, "Artifact distribution attribution").trim() || !Array.isArray(item.sourceResources) || item.sourceResources.length > 128) contract("Invalid Artifact distribution sources");
    item.sourceResources.forEach(source => {
      exactKeys(object(source, "Artifact source authority"), ["resourceId", "resourceVersionId", "datasetId", "datasetVersionId", "sourceVersion"], "Artifact source authority");
      for (const key of ["resourceId", "resourceVersionId", "datasetId"]) uuid(source[key], key);
      if (source.datasetVersionId !== null) uuid(source.datasetVersionId, "Artifact dataset version id");
      integerBetween(source.sourceVersion, 1, 2147483647, "Artifact source version");
    });
  });
  if (withReferences) {
    validateDistributionReferencePins(manifest.dataAttachments, manifest.referencedFiles, manifest.artifacts);
    manifest.referenceRights.forEach((item, index) => {
      exactKeys(object(item, "Referenced file distribution rights"), ["referenceId", "path", "resourceId", "resourceVersionId",
        "distributionId", "license", "attribution", "acknowledgment"], "Referenced file distribution rights");
      const pin = manifest.referencedFiles[index];
      if (item.referenceId !== pin.referenceId || item.path !== pin.path || item.resourceId !== pin.resourceId
        || item.distributionId !== pin.distributionId || item.acknowledgment !== "publish-exact-referenced-file") {
        contract("Referenced file distribution pin mismatch");
      }
      // This rights edition is current. The file pin retains its historical
      // metadata edition independently, so these UUIDs may deliberately differ.
      uuid(item.resourceVersionId, "referenced file rights metadata version");
      oneOf(item.license, ["CC0-1.0", "CC-BY-4.0", "PDDL-1.0"], "referenced file distribution license");
      boundedString(item.attribution, 2000, "referenced file distribution attribution");
    });
  }
  return {id: uuid(record.id, "input distribution approval id"), manifest,
    checksum: sha256(record.manifest_checksum_sha256, "input distribution approval checksum"), revoked: boolean(record.revoked, "input distribution revocation"),
    ...(Object.hasOwn(record, "reused") ? {reused: boolean(record.reused, "input distribution reuse")} : {})};
}

export function parsePublicationInputDistributions(value, projectId, sourceProjectId, revisionId) {
  const record = object(value, "Publication input distributions");
  const withReferences = Object.hasOwn(record, "referenced_files");
  exactKeys(record, ["source_revision_id", "source_manifest_checksum_sha256", "compiler_image_digest", "archive_files", "artifacts", "approvals",
    "artifact_input_id", "artifact_inputs_checksum_sha256", "output_profile",
    ...(withReferences ? ["referenced_files"] : [])], "Publication input distributions");
  if (uuid(record.source_revision_id, "distribution source revision id") !== revisionId) contract("Publication input source mismatch");
  if (!Array.isArray(record.archive_files) || record.archive_files.length > 128 || !Array.isArray(record.artifacts) || record.artifacts.length > 32
    || !Array.isArray(record.approvals) || record.approvals.length > 10
    || (record.artifact_input_id === null) !== (record.artifact_inputs_checksum_sha256 === null)
    || (record.artifacts.length > 0) !== (record.artifact_input_id !== null)) contract("Invalid publication input review");
  if (withReferences && (!Array.isArray(record.referenced_files) || record.referenced_files.length > 128)) {
    contract("Invalid referenced publication input review");
  }
  const archiveFiles = record.archive_files.map(item => {
    const extras = ["resource_id", "resource_version_id", "title", "license", "attribution", "can_publish"];
    exactKeys(object(item, "Reviewed archive file"), ["path", "attachmentId", "datasetId", "datasetVersionId", "dataObjectId", "s3VersionId", "checksumSha256", "sizeBytes", "contentType", ...extras], "Reviewed archive file");
    const pin = parseDistributionArchivePin(Object.fromEntries(Object.entries(item).filter(([key]) => !extras.includes(key))));
    return {...pin, relativePath: pin.path,
      resourceId: item.resource_id === null ? null : uuid(item.resource_id, "archive resource id"),
      resourceVersionId: item.resource_version_id === null ? null : uuid(item.resource_version_id, "archive resource version id"),
      title: boundedString(item.title, 4000, "archive title"), license: item.license === null ? null : boundedString(item.license, 4000, "archive license"),
      attribution: item.attribution === null ? null : boundedString(item.attribution, 4000, "archive attribution"), canPublish: boolean(item.can_publish, "archive publication authority")};
  });
  if (archiveFiles.reduce((sum, item) => sum + item.sizeBytes, 0) > 67_108_864) contract("Reviewed archive input limit exceeded");
  const referencedFiles = (record.referenced_files ?? []).map(item => {
    const extras = ["current_resource_version_id", "title", "license", "attribution", "can_publish"];
    const reviewed = object(item, "Reviewed referenced file");
    const pin = parseDistributionReferencePin(Object.fromEntries(Object.entries(reviewed).filter(([key]) => !extras.includes(key))));
    exactKeys(reviewed, [...Object.keys(pin), ...extras], "Reviewed referenced file");
    const currentResourceVersionId = item.current_resource_version_id === null ? null
      : uuid(item.current_resource_version_id, "referenced file current metadata version");
    const canPublish = boolean(item.can_publish, "referenced file publication authority");
    if (canPublish && currentResourceVersionId === null) contract("Referenced publication authority lacks a current metadata edition");
    return {...pin, relativePath: pin.path, currentResourceVersionId, canPublish,
      title: boundedString(item.title, 4000, "referenced file title"),
      license: item.license === null ? null : boundedString(item.license, 4000, "referenced file license"),
      attribution: item.attribution === null ? null : boundedString(item.attribution, 4000, "referenced file attribution")};
  });
  const artifacts = record.artifacts.map(item => {
    exactKeys(object(item, "Reviewed Artifact"), ["artifact_id", "version", "path", "manifest_checksum_sha256", "output", "project_id", "resource_id", "resource_version_id", "can_publish", "releases"], "Reviewed Artifact");
    if (!Array.isArray(item.releases) || item.releases.length > 25) contract("Invalid Artifact release choices");
    return {artifactId: uuid(item.artifact_id, "Artifact id"), version: integerBetween(item.version, 1, 2147483647, "Artifact edition"),
      path: parseObservableSourcePath(item.path, "Artifact path"), manifestChecksumSha256: sha256(item.manifest_checksum_sha256, "Artifact manifest checksum"),
      output: parseDistributionArtifactOutput(item.output), projectId: uuid(item.project_id, "Artifact project id"), resourceId: uuid(item.resource_id, "Artifact resource id"), resourceVersionId: uuid(item.resource_version_id, "Artifact resource version id"),
      canPublish: boolean(item.can_publish, "Artifact publication authority"), releases: item.releases.map(release => {
        exactKeys(object(release, "Artifact release"), ["id", "license", "attribution", "revoked_at"], "Artifact release");
        return {id: uuid(release.id, "Artifact release id"), license: boundedString(release.license, 4000, "Artifact license"),
          attribution: boundedString(release.attribution, 4000, "Artifact attribution"), revokedAt: nullableTimestamp(release.revoked_at, "Artifact revocation")};
      })};
  });
  if (referencedFiles.length) {
    const extras = ["relativePath", "currentResourceVersionId", "canPublish", "title", "license", "attribution"];
    validateDistributionReferencePins(archiveFiles, referencedFiles.map(item =>
      Object.fromEntries(Object.entries(item).filter(([key]) => !extras.includes(key)))), artifacts);
  }
  const approvals = record.approvals.map(item => parsePublicationInputApproval(item, projectId, sourceProjectId, revisionId));
  for (const approval of approvals) {
    if (referencedFiles.length && !approval.manifest.referencedFiles) {
      contract("Referenced files require exact distribution approval pins");
    }
    if (approval.manifest.referencedFiles) {
      const pins = approval.manifest.referencedFiles;
      if (!withReferences || pins.length !== referencedFiles.length
        || pins.some((pin, index) => Object.keys(pin).some(key => pin[key] !== referencedFiles[index][key]))) {
        contract("Referenced distribution approval differs from reviewed source pins");
      }
    }
  }
  return {sourceRevisionId: revisionId, sourceManifestChecksumSha256: sha256(record.source_manifest_checksum_sha256, "distribution source checksum"),
    compilerImageDigest: compilerImageDigest(record.compiler_image_digest, "distribution compiler image"), archiveFiles, artifacts,
    ...(withReferences ? {referencedFiles} : {}),
    artifactInputId: record.artifact_input_id === null ? null : uuid(record.artifact_input_id, "Artifact input id"),
    artifactInputsChecksumSha256: record.artifact_inputs_checksum_sha256 === null ? null : sha256(record.artifact_inputs_checksum_sha256, "Artifact input checksum"),
    outputProfile: oneOf(record.output_profile, ["default-32m", "archive-96m"], "distribution output profile"),
    approvals};
}

function parseObservableBuildRequest(value) {
  const request = object(value, "Observable build request");
  const localized = request.schemaVersion === "opengeo.observable-build-request.4.0.0";
  const distribution = request.schemaVersion === "opengeo.observable-build-request.3.0.0" || localized;
  if (localized && Object.hasOwn(request, "artifactInputsChecksumSha256")) contract("Single HTML does not support Artifact inputs");
  const withArtifacts = request.schemaVersion === "opengeo.observable-build-request.2.0.0"
    || distribution && Object.hasOwn(request, "artifactInputsChecksumSha256");
  if (withArtifacts && !distribution && request.purpose !== "preview") contract("Artifact builds are preview-only");
  exactKeys(request, [
    "schemaVersion", "sourceProjectId", "sourceRevisionId", "sourceRevisionNumber",
    "sourceManifestChecksumSha256", "purpose", "compilerImageDigest", "frameworkVersion",
    "lockfileFormat", "lockfileChecksumSha256", "networkPolicy", "resourceLimits",
    ...(withArtifacts ? ["artifactInputsChecksumSha256"] : []),
    ...(distribution ? ["outputProfile", "sizeAcknowledgment", "distributionApprovalId", "distributionApprovalChecksumSha256"] : []),
    ...(localized ? ["outputRepresentation"] : [])
  ], "Observable build request");
  if (localized) oneOf(request.outputRepresentation, ["single-html"], "saved output representation");
  if (distribution) {
    oneOf(request.outputProfile, ["default-32m", "archive-96m"], "saved output size profile");
    if (request.outputProfile === "archive-96m" ? request.sizeAcknowledgment !== "allow-up-to-96-mib-output" : request.sizeAcknowledgment !== null) contract("Invalid saved output size acknowledgment");
    if ((request.distributionApprovalId === null) !== (request.distributionApprovalChecksumSha256 === null)
      || request.purpose === "release_candidate" && request.distributionApprovalId === null
        && (!localized || request.outputProfile === "archive-96m")) contract("Missing sealed input distribution approval");
    // Request4 default32 source-only releases can have a null pair. Captured
    // inputs are checked against the source manifest by the API and database;
    // this client request has no data inventory and grants no publication rights.
    if (request.distributionApprovalId !== null) {
      uuid(request.distributionApprovalId, "input distribution approval id");
      sha256(request.distributionApprovalChecksumSha256, "input distribution approval checksum");
    }
  }
  return {
    ...(distribution ? {outputProfile: request.outputProfile, sizeAcknowledgment: request.sizeAcknowledgment,
      distributionApprovalId: request.distributionApprovalId, distributionApprovalChecksumSha256: request.distributionApprovalChecksumSha256} : {}),
    ...(withArtifacts ? {artifactInputsChecksumSha256: sha256(request.artifactInputsChecksumSha256, "Artifact inputs checksum")} : {}),
    ...(localized ? {outputRepresentation: request.outputRepresentation} : {}),
    schemaVersion: oneOf(
      request.schemaVersion,
      ["opengeo.observable-build-request.1.0.0", "opengeo.observable-build-request.2.0.0", "opengeo.observable-build-request.3.0.0", "opengeo.observable-build-request.4.0.0"],
      "Observable build request schema"
    ),
    sourceProjectId: uuid(request.sourceProjectId, "Observable build request source project"),
    sourceRevisionId: uuid(request.sourceRevisionId, "Observable build request source revision"),
    sourceRevisionNumber: positiveInteger(
      request.sourceRevisionNumber,
      "Observable build request source revision number"
    ),
    sourceManifestChecksumSha256: sha256(
      request.sourceManifestChecksumSha256,
      "Observable build request source manifest checksum"
    ),
    purpose: oneOf(
      request.purpose,
      ["preview", "release_candidate"],
      "Observable build request purpose"
    ),
    compilerImageDigest: compilerImageDigest(
      request.compilerImageDigest,
      "Observable build request compiler image"
    ),
    frameworkVersion: oneOf(
      request.frameworkVersion,
      ["1.13.4"],
      "Observable build request framework version"
    ),
    lockfileFormat: oneOf(
      request.lockfileFormat,
      ["npm-package-lock-v3"],
      "Observable build request lockfile format"
    ),
    lockfileChecksumSha256: request.lockfileChecksumSha256 === null
      ? null
      : sha256(request.lockfileChecksumSha256, "Observable build request lockfile checksum"),
    networkPolicy: oneOf(
      request.networkPolicy,
      ["deny_all"],
      "Observable build request network policy"
    ),
    resourceLimits: parseObservableResourceLimits(request.resourceLimits)
  };
}

function parseObservableResourceLimits(value) {
  const limits = object(value, "Observable build resource limits");
  const names = [
    "cpuMillis", "memoryMiB", "timeoutSeconds", "maxInputFiles", "maxInputBytes",
    "maxOutputFiles", "maxOutputBytes"
  ];
  exactKeys(limits, names, "Observable build resource limits");
  return Object.fromEntries(names.map((name) => [
    name,
    positiveInteger(limits[name], `Observable build resource limits.${name}`)
  ]));
}

function parseObservableBuildResult(value) {
  const result = object(value, "Observable build result");
  exactKeys(result, [
    "schemaVersion", "buildJobId", "requestChecksumSha256", "compilerImageDigest",
    "inputManifestChecksumSha256", "outputTreeChecksumSha256", "sandbox",
    "networkRequests", "validationReport", "routeManifest", "outputManifest",
    "publicationAuthorized"
  ], "Observable build result");
  const sandbox = object(result.sandbox, "Observable build sandbox");
  exactKeys(sandbox, [
    "credentialMode", "networkPolicy", "readOnlyInputs", "readOnlyBaseImage",
    "unprivilegedUser", "dockerSocket"
  ], "Observable build sandbox");
  if (sandbox.credentialMode !== "none" || sandbox.networkPolicy !== "deny_all"
    || sandbox.readOnlyInputs !== true || sandbox.readOnlyBaseImage !== true
    || sandbox.unprivilegedUser !== true || sandbox.dockerSocket !== false
    || result.publicationAuthorized !== false
    || !Array.isArray(result.networkRequests) || result.networkRequests.length !== 0) {
    contract("Observable build sandbox widened its authority");
  }
  const routeManifest = parseArray(
    result.routeManifest,
    (value, index) => {
      const route = object(value, `Observable build route ${index + 1}`);
      exactKeys(route, ["path", "file"], `Observable build route ${index + 1}`);
      return {
        path: boundedString(route.path, 512, "Observable build route path"),
        file: observableOutputPath(route.file, "Observable build route file")
      };
    },
    "Observable build route manifest"
  );
  if (routeManifest.length > 128) contract("Observable build route manifest is too large");
  const outputManifestRecord = boundedObject(
    result.outputManifest,
    196_608,
    "Observable build output manifest"
  );
  exactKeys(outputManifestRecord, ["files"], "Observable build output manifest");
  if (!Array.isArray(outputManifestRecord.files)
    || outputManifestRecord.files.length < 1
    || outputManifestRecord.files.length > 512) {
    contract("Observable build output manifest is invalid");
  }
  const outputFiles = outputManifestRecord.files.map((value, index) => {
    const file = object(value, `Observable build output file ${index + 1}`);
    exactKeys(file, [
      "path", "contentType", "sizeBytes", "checksumSha256"
    ], `Observable build output file ${index + 1}`);
    return {
      path: observableOutputPath(file.path, "Observable build output path"),
      contentType: oneOf(file.contentType, [
        "text/html", "text/css", "text/javascript", "application/json", "text/plain",
        "text/csv", "application/geo+json", "image/svg+xml", "image/png", "image/jpeg",
        "application/octet-stream", "application/zip"
      ], "Observable build output content type"),
      sizeBytes: positiveInteger(file.sizeBytes, "Observable build output size"),
      checksumSha256: sha256(file.checksumSha256, "Observable build output checksum")
    };
  });
  if (outputFiles.some((file, index) => index > 0 && file.path <= outputFiles[index - 1].path)
    || new Set(outputFiles.map((file) => file.path.toLowerCase())).size !== outputFiles.length) {
    contract("Observable build output manifest is not canonical");
  }
  const validationReport = object(
    result.validationReport,
    "Observable build validation report"
  );
  exactKeys(validationReport, [
    "entryPath", "fixedBuilderConfig", "frameworkVersion", "inputBytes", "inputFileCount",
    "lockfileVerified", "outputBytes", "outputFileCount", "prewarmedFrameworkCache",
    "publicationAuthorized", "coordinatorSchemaVersion", "inputObjectsReverified",
    "outputBytesReverified", "outputObjectsReverified"
  ], "Observable build validation report");
  if (validationReport.fixedBuilderConfig !== true
    || validationReport.frameworkVersion !== "1.13.4"
    || validationReport.prewarmedFrameworkCache !== /\.md$/i.test(validationReport.entryPath)
    || validationReport.publicationAuthorized !== false
    || validationReport.coordinatorSchemaVersion !== "opengeo.observable-coordinator.1.0.0"
    || validationReport.inputObjectsReverified !== true
    || validationReport.outputBytesReverified !== true
    || validationReport.outputObjectsReverified !== true
    || validationReport.outputFileCount !== outputFiles.length
    || validationReport.outputBytes !== outputFiles.reduce((sum, file) => sum + file.sizeBytes, 0)) {
    contract("Observable build validation report is invalid");
  }
  const expectedRoutes = outputFiles
    .filter((file) => file.path.endsWith(".html"))
    .map((file) => {
      if (file.path === "dist/index.html") return {path: "/", file: file.path};
      const route = file.path.slice("dist/".length, -".html".length);
      return {
        path: route.endsWith("/index") ? `/${route.slice(0, -"index".length)}` : `/${route}`,
        file: file.path
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(routeManifest) !== JSON.stringify(expectedRoutes)) {
    contract("Observable build route manifest is invalid");
  }
  const validationEntryPath = parseObservableSourcePath(
    validationReport.entryPath,
    "Observable build validation entry path"
  );
  if (!/\.(md|ipynb)$/i.test(validationEntryPath) && !/(^|\/)index\.html$/.test(validationEntryPath)) {
    contract("Publication build entry path is not Markdown, Jupyter or static index.html");
  }
  return {
    schemaVersion: oneOf(
      result.schemaVersion,
      ["opengeo.observable-build-client-result.1.0.0"],
      "Observable build result schema"
    ),
    buildJobId: uuid(result.buildJobId, "Observable build result job"),
    requestChecksumSha256: sha256(
      result.requestChecksumSha256,
      "Observable build result request checksum"
    ),
    compilerImageDigest: compilerImageDigest(
      result.compilerImageDigest,
      "Observable build result compiler image"
    ),
    inputManifestChecksumSha256: sha256(
      result.inputManifestChecksumSha256,
      "Observable build result input manifest checksum"
    ),
    outputTreeChecksumSha256: sha256(
      result.outputTreeChecksumSha256,
      "Observable build result output tree checksum"
    ),
    sandbox: structuredClone(sandbox),
    networkRequests: [],
    validationReport: {
      entryPath: validationEntryPath,
      fixedBuilderConfig: true,
      frameworkVersion: "1.13.4",
      inputBytes: positiveInteger(validationReport.inputBytes, "Observable build input bytes"),
      inputFileCount: positiveInteger(
        validationReport.inputFileCount,
        "Observable build input file count"
      ),
      lockfileVerified: boolean(
        validationReport.lockfileVerified,
        "Observable build lockfile verification"
      ),
      outputBytes: positiveInteger(validationReport.outputBytes, "Observable build output bytes"),
      outputFileCount: positiveInteger(
        validationReport.outputFileCount,
        "Observable build output file count"
      ),
      prewarmedFrameworkCache: validationReport.prewarmedFrameworkCache,
      publicationAuthorized: false,
      coordinatorSchemaVersion: "opengeo.observable-coordinator.1.0.0",
      inputObjectsReverified: true,
      outputBytesReverified: true,
      outputObjectsReverified: true
    },
    routeManifest,
    outputManifest: {files: outputFiles},
    publicationAuthorized: false
  };
}

const OBSERVABLE_OUTPUT_PATH_PATTERN =
  /^dist\/[A-Za-z0-9_@][A-Za-z0-9._@-]{0,99}(?:\/[A-Za-z0-9_@][A-Za-z0-9._@-]{0,99}){0,7}$/;
const OBSERVABLE_OUTPUT_FORBIDDEN_DIRECTORY =
  /(^|\/)(?:node_modules|build|cache|\.git|\.aws|\.ssh)(?:\/|$)/i;
const OBSERVABLE_OUTPUT_SECRET_FILE =
  /(^|\/)(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|id_rsa|[^/]+\.(?:pem|key|p12|pfx))$/i;

function observableOutputPath(value, label) {
  const path = boundedString(value, 512, label);
  const relative = path.slice("dist/".length);
  if (!OBSERVABLE_OUTPUT_PATH_PATTERN.test(path)
    || OBSERVABLE_OUTPUT_FORBIDDEN_DIRECTORY.test(relative)
    || OBSERVABLE_OUTPUT_SECRET_FILE.test(relative)) {
    contract(`${label} is invalid`);
  }
  return path;
}

export function parseObservablePreviewCapability(value) {
  const record = object(value, "Observable preview capability");
  exactKeys(record, [
    "authorize_url", "expires_at", "publication_authorized"
  ], "Observable preview capability");
  if (record.publication_authorized !== false) {
    contract("Observable preview capability widened publication authority");
  }
  const authorizeUrl = boundedString(
    record.authorize_url,
    1024,
    "Observable preview authorize URL"
  );
  let parsed;
  try {
    parsed = new URL(authorizeUrl);
  } catch {
    contract("Observable preview authorize URL is invalid");
  }
  if (!["https://preview.studio.opengeo.tools", "https://maps-preview.studio.opengeo.tools"].includes(parsed.origin)
    || authorizeUrl !== `${parsed.origin}/authorize/${parsed.hash}`
    || parsed.pathname !== "/authorize/"
    || parsed.search !== ""
    || !/^#cap=[A-Za-z0-9_-]{128,512}$/.test(parsed.hash)
    || parsed.username !== ""
    || parsed.password !== "") {
    contract("Observable preview authorize URL is invalid");
  }
  return {
    authorizeUrl,
    expiresAt: timestamp(record.expires_at, "Observable preview expiry"),
    publicationAuthorized: false
  };
}

export function parseProjectSite(value) {
  const record = object(value, "project site");
  const slug = boundedString(record.slug, 160, "project site.slug");
  if (!SITE_SLUG_PATTERN.test(slug)) contract("project site.slug is invalid");
  const pages = parseArray(record.pages, (value) => {
    const page = object(value, "project site page");
    const pageSlug = boundedString(page.slug, 160, "project site page.slug");
    if (!SITE_SLUG_PATTERN.test(pageSlug)) contract("project site page.slug is invalid");
    return {
      id: uuid(page.id, "project site page.id"),
      slug: pageSlug,
      navigationLabel: boundedString(
        page.navigation_label,
        120,
        "project site page.navigation_label"
      ),
      position: nonNegativeInteger(page.position, "project site page.position"),
      isHome: boolean(page.is_home, "project site page.is_home"),
      resourceId: uuid(page.resource_id, "project site page.resource_id"),
      resourceVersionId: uuid(
        page.resource_version_id,
        "project site page.resource_version_id"
      ),
      resourceVersionNumber: positiveInteger(
        page.resource_version_number,
        "project site page.resource_version_number"
      ),
      resourceKind: oneOf(
        page.resource_kind,
        ["document", "story", "dashboard", "map"],
        "project site page.resource_kind"
      ),
      resourceTitle: boundedString(
        page.resource_title,
        300,
        "project site page.resource_title"
      ),
      resourceState: oneOf(
        page.resource_state,
        ["draft", "review", "published", "archived"],
        "project site page.resource_state"
      ),
      resourceVisibility: oneOf(
        page.resource_visibility,
        ["restricted", "organization", "public"],
        "project site page.resource_visibility"
      ),
      content: boundedObject(page.content, 16_384, "project site page.content")
    };
  }, "project site.pages");
  if (!pages.length || pages.length > 64 || pages.filter((page) => page.isHome).length !== 1) {
    contract("project site.pages must contain one to 64 pages and one home page");
  }
  const publicationDestination = parseSitePublicationDestination(
    record.publication_destination
  );
  return {
    id: uuid(record.id, "project site.id"),
    projectId: uuid(record.project_id, "project site.project_id"),
    slug,
    versionId: uuid(record.version_id, "project site.version_id"),
    versionNumber: positiveInteger(record.version_number, "project site.version_number"),
    state: oneOf(record.state, ["draft", "review", "published"], "project site.state"),
    title: boundedString(record.title, 300, "project site.title"),
    description: nullableBoundedString(record.description, 4_000, "project site.description"),
    language: boundedString(record.language, 40, "project site.language"),
    theme: oneOf(record.theme, ["paper", "atlas", "minimal"], "project site.theme"),
    themeOptions: parseSiteThemeOptions(record.theme_options),
    printLayout: parseSitePrintLayout(
      record.print_layout,
      new Set(pages.map((page) => page.slug))
    ),
    changeMessage: nullableBoundedString(
      record.change_message,
      500,
      "project site.change_message"
    ),
    createdBy: uuid(record.created_by, "project site.created_by"),
    createdAt: timestamp(record.created_at, "project site.created_at"),
    updatedBy: uuid(record.updated_by, "project site.updated_by"),
    updatedAt: timestamp(record.updated_at, "project site.updated_at"),
    pages,
    activeEdition: record.active_edition === null
      ? null
      : parseSiteEdition(record.active_edition),
    publicationDestination
  };
}

export function parseSitePublicationDestination(value) {
  const record = object(value, "site publication destination");
  const reach = oneOf(
    record.reach,
    ["unpublished", "unlisted", "listed"],
    "site publication destination.reach"
  );
  const listedSlug = record.listed_slug === null
    ? null
    : siteSlugPath(record.listed_slug);
  const isPrimary = boolean(
    record.is_primary,
    "site publication destination.is_primary"
  );
  if (reach === "listed" && listedSlug === null) {
    contract("listed publication destination requires a path");
  }
  if (isPrimary && reach !== "listed") {
    contract("primary publication destination must be listed");
  }
  return {
    revision: positiveInteger(
      record.revision,
      "site publication destination.revision"
    ),
    reach,
    listedSlug,
    isPrimary,
    configuredBy: uuid(
      record.configured_by,
      "site publication destination.configured_by"
    ),
    configuredAt: timestamp(
      record.configured_at,
      "site publication destination.configured_at"
    )
  };
}

function parseSiteThemeOptions(value) {
  const raw = boundedObject(value, 4_096, "project site.theme_options");
  const allowed = [
    "accentColor",
    "footerText",
    "printPageSize",
    "printOrientation",
    "printLayout",
    "printLegend",
    "printNorthArrow",
    "printScaleBar"
  ];
  const keys = Object.keys(raw);
  if (keys.length > 8 || keys.some((key) => !allowed.includes(key))) {
    contract("project site.theme_options contains an unknown option");
  }
  const result = {};
  if (Object.hasOwn(raw, "accentColor")) {
    if (typeof raw.accentColor !== "string" || !/^#[0-9a-f]{6}$/i.test(raw.accentColor)) {
      contract("project site accent color is invalid");
    }
    result.accentColor = raw.accentColor;
  }
  if (Object.hasOwn(raw, "footerText")) {
    const footer = boundedString(raw.footerText, 500, "project site footer text");
    if (!footer.length || footer !== footer.trim()) contract("project site footer text is invalid");
    result.footerText = footer;
  }
  const printEnums = {
    printPageSize: ["letter", "legal", "tabloid", "a4", "a3", "a2", "a1", "a0"],
    printOrientation: ["portrait", "landscape"],
    printLayout: ["flow", "map-sheet"],
    printLegend: ["true", "false"],
    printNorthArrow: ["true", "false"],
    printScaleBar: ["true", "false"]
  };
  for (const [key, values] of Object.entries(printEnums)) {
    if (Object.hasOwn(raw, key)) result[key] = oneOf(raw[key], values, `project site ${key}`);
  }
  return result;
}

export function parseSitePrintLayout(value, allowedPageSlugs = null) {
  const raw = boundedObject(value, 32_768, "project site.print_layout");
  const legacy = raw.schemaVersion === "opengeo.print-layout.1.0.0";
  if (Object.keys(raw).length !== 2
    || (!legacy && raw.schemaVersion !== "opengeo.print-layout.1.1.0")
    || !Array.isArray(raw.pages)
    || raw.pages.length > 64) {
    contract("project site.print_layout shape is invalid");
  }
  const pageSlugs = new Set();
  const mapResources = new Set();
  let elementTotal = 0;
  const pages = raw.pages.map((value) => {
    const page = object(value, "project site print layout page");
    if (Object.keys(page).length !== 2 || !Array.isArray(page.elements)
      || !page.elements.length || page.elements.length > 32) {
      contract("project site print layout page shape is invalid");
    }
    const sitePageSlug = siteSlug(page.sitePageSlug, "project site print layout page slug");
    if (pageSlugs.has(sitePageSlug)
      || (allowedPageSlugs !== null && !allowedPageSlugs.has(sitePageSlug))) {
      contract("project site print layout page is missing or duplicated");
    }
    pageSlugs.add(sitePageSlug);
    elementTotal += page.elements.length;
    if (elementTotal > 256) contract("project site print layout has too many elements");
    const elementIds = new Set();
    const mapFrameIds = new Set();
    const elements = page.elements.map((value) => {
      const element = object(value, "project site print layout element");
      const type = oneOf(
        element.type,
        legacy
          ? ["map_frame", "text", "source_panel", "north_arrow", "scale_bar"]
          : [
            "map_frame", "text", "source_panel", "north_arrow", "scale_bar",
            "legend_frame", "image_frame", "table_frame", "chart_frame"
          ],
        "project site print layout element type"
      );
      const commonKeys = legacy
        ? ["id", "type", "x", "y", "width", "height"]
        : ["id", "type", "x", "y", "width", "height", "rotation", "clip"];
      const allowedKeys = type === "map_frame"
        ? [...commonKeys, "resourceId", ...(legacy ? [] : ["fit"])]
        : type === "text"
          ? [...commonKeys, "text", "style"]
          : ["image_frame", "table_frame", "chart_frame"].includes(type)
            ? [...commonKeys, "blockId", ...(type === "image_frame" ? ["fit"] : [])]
            : [...commonKeys, "mapFrameId"];
      if (Object.keys(element).length !== allowedKeys.length
        || Object.keys(element).some((key) => !allowedKeys.includes(key))) {
        contract("project site print layout element shape is invalid");
      }
      if (typeof element.id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(element.id)
        || elementIds.has(element.id)) {
        contract("project site print layout element id is invalid or duplicated");
      }
      elementIds.add(element.id);
      const x = integerBetween(element.x, 0, 1000, "project site print layout x");
      const y = integerBetween(element.y, 0, 1000, "project site print layout y");
      const width = integerBetween(element.width, 10, 1000, "project site print layout width");
      const height = integerBetween(element.height, 10, 1000, "project site print layout height");
      if (x + width > 1000 || y + height > 1000) {
        contract("project site print layout element is out of bounds");
      }
      const common = {id: element.id, type, x, y, width, height};
      if (!legacy) {
        common.rotation = integerBetween(
          element.rotation, -180, 180, "project site print layout rotation"
        );
        if (typeof element.clip !== "boolean") {
          contract("project site print layout clip is invalid");
        }
        common.clip = element.clip;
      }
      if (type === "map_frame") {
        const resourceId = uuid(element.resourceId, "project site print layout resource id");
        mapFrameIds.add(element.id);
        mapResources.add(resourceId);
        if (mapResources.size > 16) contract("project site print layout has too many maps");
        return {
          ...common,
          resourceId,
          ...(legacy ? {} : {
            fit: oneOf(element.fit, ["contain", "cover"], "project site print layout fit")
          })
        };
      }
      if (["image_frame", "table_frame", "chart_frame"].includes(type)) {
        if (typeof element.blockId !== "string"
          || !/^[a-z][a-z0-9_-]{0,63}$/.test(element.blockId)) {
          contract("project site print layout block id is invalid");
        }
        return {
          ...common,
          blockId: element.blockId,
          ...(type === "image_frame"
            ? {fit: oneOf(element.fit, ["contain", "cover"], "project site print layout fit")}
            : {})
        };
      }
      if (type === "text") {
        const text = boundedString(element.text, 1_000, "project site print layout text");
        if (!text.length || text !== text.trim()) {
          contract("project site print layout text is invalid");
        }
        return {
          ...common,
          text,
          style: oneOf(
            element.style,
            ["title", "heading", "body", "note", "attribution"],
            "project site print layout text style"
          )
        };
      }
      if (typeof element.mapFrameId !== "string"
        || !/^[a-z][a-z0-9_-]{0,63}$/.test(element.mapFrameId)) {
        contract("project site print layout map frame id is invalid");
      }
      return {...common, mapFrameId: element.mapFrameId};
    });
    for (const element of elements) {
      if (Object.hasOwn(element, "mapFrameId") && !mapFrameIds.has(element.mapFrameId)) {
        contract("project site print layout map frame was not found");
      }
    }
    return {sitePageSlug, elements};
  });
  return {schemaVersion: raw.schemaVersion, pages};
}

function parseArtifactEdition(value) {
  const record = object(value, "Artifact edition");
  uuid(record.id, "Artifact identity");
  nonNegativeInteger(record.revision, "Artifact revision");
  for (const key of ["current_version_number", "version_number"]) {
    if (record[key] !== null) positiveInteger(record[key], `Artifact ${key}`);
  }
  if (record.editions !== undefined) {
    if (!Array.isArray(record.editions) || record.editions.length > 100) contract("Artifact edition history is invalid");
    for (const edition of record.editions) {
      positiveInteger(edition.version_number, "Artifact history version");
      if ((edition.render_job_id == null) === (edition.output_object_id == null)) contract("Artifact history requires exactly one output identity");
      uuid(edition.render_job_id ?? edition.output_object_id, "Artifact history output identity");
    }
  }
  return record;
}

export function parseRenderJob(value) {
  const record = object(value, "render job");
  const crs = oneOf(record.crs, ["CRS:84", "EPSG:3857"], "render job.crs");
  const bbox = renderRequestBbox(record.bbox, ApiContractError, crs);
  const width = integerBetween(record.width, 1, 2048, "render job.width");
  const height = integerBetween(record.height, 1, 2048, "render job.height");
  if (width * height > 4_194_304) contract("render job exceeds the pixel budget");
  const format = oneOf(record.format, ["svg", "png"], "render job.format");
  const outputContentType = nullableString(record.output_content_type, "render job.output_content_type");
  if (outputContentType !== null && !["image/svg+xml", "image/png"].includes(outputContentType)) {
    contract("render job.output_content_type is invalid");
  }
  const backgroundColor = nullableString(record.background_color, "render job.background_color");
  if (backgroundColor !== null && !/^#[0-9a-f]{6}$/.test(backgroundColor)) {
    contract("render job.background_color is invalid");
  }
  const result = {
    id: uuid(record.id, "render job.id"),
    projectId: uuid(record.project_id, "render job.project_id"),
    resourceId: uuid(record.resource_id, "render job.resource_id"),
    profileId: uuid(record.profile_id, "render job.profile_id"),
    profileVersionId: uuid(record.profile_version_id, "render job.profile_version_id"),
    profileVersionNumber: positiveInteger(record.profile_version_number, "render job.profile_version_number"),
    datasetId: uuid(record.dataset_id, "render job.dataset_id"),
    datasetVersionId: uuid(record.dataset_version_id, "render job.dataset_version_id"),
    styleId: uuid(record.style_id, "render job.style_id"),
    styleVersionId: uuid(record.style_version_id, "render job.style_version_id"),
    savedMapSnapshot: parseSavedMapRenderSnapshot(record.saved_map_snapshot),
    bbox,
    crs,
    width,
    height,
    format,
    backgroundColor,
    transparent: boolean(record.transparent, "render job.transparent"),
    requestChecksumSha256: sha256(record.request_checksum_sha256, "render job.request_checksum_sha256"),
    state: oneOf(record.state, ["queued", "running", "completed", "failed", "cancelled"], "render job.state"),
    attemptCount: nonNegativeInteger(record.attempt_count, "render job.attempt_count"),
    outputObjectId: nullableUuid(record.output_object_id, "render job.output_object_id"),
    outputContentType,
    outputSizeBytes: nullableNonNegativeInteger(record.output_size_bytes, "render job.output_size_bytes"),
    outputChecksumSha256: record.output_checksum_sha256 === null
      ? null
      : sha256(record.output_checksum_sha256, "render job.output_checksum_sha256"),
    errorCode: nullableBoundedString(record.error_code, 100, "render job.error_code"),
    createdBy: uuid(record.created_by, "render job.created_by"),
    createdAt: timestamp(record.created_at, "render job.created_at"),
    startedAt: nullableTimestamp(record.started_at, "render job.started_at"),
    finishedAt: nullableTimestamp(record.finished_at, "render job.finished_at")
  };
  const expectedContentType = result.format === "svg" ? "image/svg+xml" : "image/png";
  const hasOutput = result.outputObjectId !== null
    && result.outputContentType === expectedContentType
    && result.outputSizeBytes !== null
    && result.outputSizeBytes > 0
    && result.outputChecksumSha256 !== null;
  if (
    (result.state === "queued" && (result.startedAt !== null || result.finishedAt !== null || hasOutput))
    || (result.state === "running" && (result.startedAt === null || result.finishedAt !== null || hasOutput))
    || (result.state === "completed" && (result.startedAt === null || result.finishedAt === null || !hasOutput || result.errorCode !== null))
    || (["failed", "cancelled"].includes(result.state) && (result.finishedAt === null || hasOutput))
  ) {
    contract("render job state shape is invalid");
  }
  return result;
}

function parseSavedMapRenderSnapshot(value) {
  if (value == null) return null;
  const record = object(value, "render job.saved_map_snapshot");
  return {
    resourceVersionId: uuid(record.resource_version_id, "saved map render.resource_version_id"),
    resourceVersionNumber: positiveInteger(record.resource_version_number, "saved map render.resource_version_number"),
    mapId: uuid(record.map_id, "saved map render.map_id"),
    mapVersion: positiveInteger(record.map_version, "saved map render.map_version"),
    definitionChecksumSha256: sha256(record.definition_checksum_sha256, "saved map render.definition_checksum_sha256"),
    recipeChecksumSha256: sha256(record.recipe_checksum_sha256, "saved map render.recipe_checksum_sha256")
  };
}

function serializeRenderProfile(record, includeSlug) {
  const body = {
    title: record.title,
    style_id: assertUuid(record.styleId, "render style id"),
    geometry_layer_id: record.geometryLayerId,
    label_layer_id: record.labelLayerId ?? null,
    minimum_scale_denominator: record.minimumScaleDenominator ?? null,
    maximum_scale_denominator: record.maximumScaleDenominator ?? null,
    include_legend: record.includeLegend ?? true,
    change_message: record.changeMessage ?? null
  };
  return includeSlug ? {slug: record.slug, ...body} : body;
}

function renderRequestBbox(value, ErrorClass = TypeError, crs = "CRS:84") {
  if (!Array.isArray(value) || value.length !== 4) throw new ErrorClass("render bbox is invalid");
  const bbox = value.map((coordinate) => {
    if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
      throw new ErrorClass("render bbox is invalid");
    }
    return coordinate;
  });
  const xLimit = crs === "EPSG:3857" ? 20_037_508.342789244 : 180;
  const yLimit = crs === "EPSG:3857" ? 20_037_508.342789244 : 90;
  if (!(bbox[0] >= -xLimit && bbox[0] < bbox[2] && bbox[2] <= xLimit
    && bbox[1] >= -yLimit && bbox[1] < bbox[3] && bbox[3] <= yLimit)) {
    throw new ErrorClass("render bbox is invalid");
  }
  return bbox;
}

export function parseResourceWorkflowEvent(value) {
  const record = object(value, "resource workflow event");
  return {
    id: uuid(record.id, "resource workflow event.id"),
    sourceState: oneOf(
      record.source_state,
      ["draft", "review", "published", "archived"],
      "resource workflow event.source_state"
    ),
    targetState: oneOf(
      record.target_state,
      ["draft", "review", "published", "archived"],
      "resource workflow event.target_state"
    ),
    reason: nullableBoundedString(record.reason, 1_000, "resource workflow event.reason"),
    actorUserId: uuid(record.actor_user_id, "resource workflow event.actor_user_id"),
    createdAt: timestamp(record.created_at, "resource workflow event.created_at")
  };
}

const GEONODE_FEDERATION_SCHEMA = "opengeo.geonode-federation-configuration.1.0.0";
const GEONODE_VERSION = "5.1.0";
const GEONODE_COMMIT = "a1db97e81dfc26c16bb4ee1a5d2b408877af66c9";

export function serializeGeoNodeFederationConfiguration(value) {
  const record = object(value, "GeoNode federation configuration");
  exactKeys(record, ["schema_version", "source", "harvester"], "GeoNode federation configuration");
  if (record.schema_version !== GEONODE_FEDERATION_SCHEMA) {
    throw new TypeError("GeoNode federation configuration schema is unsupported");
  }
  const source = object(record.source, "GeoNode federation source");
  exactKeys(source, ["product", "version", "commit"], "GeoNode federation source");
  if (source.product !== "geonode" || source.version !== GEONODE_VERSION
    || source.commit !== GEONODE_COMMIT) {
    throw new TypeError("GeoNode federation source version is unsupported");
  }
  const harvester = object(record.harvester, "GeoNode federation harvester");
  exactKeys(
    harvester,
    [
      "name", "remote_url", "scheduling_enabled", "refresh_interval_minutes",
      "maximum_resources", "credential_mode"
    ],
    "GeoNode federation harvester"
  );
  if (typeof harvester.name !== "string" || !harvester.name
    || harvester.name !== harvester.name.trim() || harvester.name.length > 100) {
    throw new TypeError("GeoNode federation name is invalid");
  }
  const name = harvester.name;
  const remoteUrl = geonodeRemoteUrl(harvester.remote_url, TypeError);
  if (typeof harvester.scheduling_enabled !== "boolean") {
    throw new TypeError("GeoNode federation scheduling preference is invalid");
  }
  const refreshIntervalMinutes = inputIntegerBetween(
    harvester.refresh_interval_minutes, 60, 10_080, "GeoNode federation refresh interval"
  );
  const maximumResources = inputIntegerBetween(
    harvester.maximum_resources, 1, 100, "GeoNode federation maximum resources"
  );
  if (harvester.credential_mode !== "anonymous") {
    throw new TypeError("GeoNode federation credentials are unsupported");
  }
  return {
    schema_version: GEONODE_FEDERATION_SCHEMA,
    source: {product: "geonode", version: GEONODE_VERSION, commit: GEONODE_COMMIT},
    harvester: {
      name,
      remote_url: remoteUrl,
      scheduling_enabled: harvester.scheduling_enabled,
      refresh_interval_minutes: refreshIntervalMinutes,
      maximum_resources: maximumResources,
      credential_mode: "anonymous"
    }
  };
}

export function parseGeoNodeFederationSource(value) {
  const record = object(value, "GeoNode federation source");
  exactKeys(record, [
    "schema_version", "source_id", "project_id", "configuration", "conversion_report",
    "configuration_checksum_sha256", "status", "created_by", "created_at", "disabled_at"
  ], "GeoNode federation source");
  if (record.schema_version !== "opengeo.geonode-federation-source.1.0.0") {
    contract("GeoNode federation source schema is unsupported");
  }
  let configuration;
  try {
    configuration = serializeGeoNodeFederationConfiguration(record.configuration);
  } catch (cause) {
    contract("GeoNode federation configuration is invalid", cause);
  }
  return {
    sourceId: uuid(record.source_id, "GeoNode federation source.source_id"),
    projectId: uuid(record.project_id, "GeoNode federation source.project_id"),
    configuration,
    conversionReport: boundedObject(
      record.conversion_report, 131_072, "GeoNode federation source.conversion_report"
    ),
    configurationChecksumSha256: sha256(
      record.configuration_checksum_sha256,
      "GeoNode federation source.configuration_checksum_sha256"
    ),
    status: oneOf(record.status, ["active", "disabled"], "GeoNode federation source.status"),
    createdBy: uuid(record.created_by, "GeoNode federation source.created_by"),
    createdAt: timestamp(record.created_at, "GeoNode federation source.created_at"),
    disabledAt: nullableTimestamp(record.disabled_at, "GeoNode federation source.disabled_at")
  };
}

export function parseGeoNodeHarvestJob(value) {
  const record = object(value, "GeoNode harvest job");
  exactKeys(record, [
    "schema_version", "job_id", "source_id", "project_id",
    "source_configuration_checksum_sha256", "request_checksum_sha256", "idempotency_key",
    "state", "result", "error_code", "attempt_count", "created_by", "created_at",
    "started_at", "finished_at", "cancellable"
  ], "GeoNode harvest job");
  if (record.schema_version !== "opengeo.geonode-harvest-job.1.0.0") {
    contract("GeoNode harvest job schema is unsupported");
  }
  const state = oneOf(
    record.state,
    ["queued", "running", "completed", "failed", "cancelled"],
    "GeoNode harvest job.state"
  );
  const result = record.result === null
    ? null
    : boundedObject(record.result, 262_144, "GeoNode harvest job.result");
  if ((state === "completed") !== (result !== null)) {
    contract("GeoNode harvest result and state are inconsistent");
  }
  return {
    jobId: uuid(record.job_id, "GeoNode harvest job.job_id"),
    sourceId: uuid(record.source_id, "GeoNode harvest job.source_id"),
    projectId: uuid(record.project_id, "GeoNode harvest job.project_id"),
    sourceConfigurationChecksumSha256: sha256(
      record.source_configuration_checksum_sha256,
      "GeoNode harvest job.source_configuration_checksum_sha256"
    ),
    requestChecksumSha256: sha256(
      record.request_checksum_sha256, "GeoNode harvest job.request_checksum_sha256"
    ),
    idempotencyKey: uuid(record.idempotency_key, "GeoNode harvest job.idempotency_key"),
    state,
    result,
    errorCode: nullableBoundedString(record.error_code, 100, "GeoNode harvest job.error_code"),
    attemptCount: nonNegativeInteger(record.attempt_count, "GeoNode harvest job.attempt_count"),
    createdBy: uuid(record.created_by, "GeoNode harvest job.created_by"),
    createdAt: timestamp(record.created_at, "GeoNode harvest job.created_at"),
    startedAt: nullableTimestamp(record.started_at, "GeoNode harvest job.started_at"),
    finishedAt: nullableTimestamp(record.finished_at, "GeoNode harvest job.finished_at"),
    cancellable: boolean(record.cancellable, "GeoNode harvest job.cancellable")
  };
}

export function parseGeoNodeFederatedResource(value) {
  const record = object(value, "GeoNode federated resource");
  exactKeys(record, [
    "schema_version", "source_id", "remote_identifier", "resource_type", "title", "status",
    "current_version_number", "current_payload_sha256", "remote_modified_at", "first_seen_at",
    "last_refreshed_at", "fresh_until", "withdrawn_at"
  ], "GeoNode federated resource");
  if (record.schema_version !== "opengeo.geonode-federated-resource.1.0.0") {
    contract("GeoNode federated resource schema is unsupported");
  }
  return {
    sourceId: uuid(record.source_id, "GeoNode federated resource.source_id"),
    remoteIdentifier: uuid(
      record.remote_identifier, "GeoNode federated resource.remote_identifier"
    ),
    resourceType: oneOf(
      record.resource_type,
      ["dataset", "document", "map", "geoapp", "service"],
      "GeoNode federated resource.resource_type"
    ),
    title: boundedString(record.title, 500, "GeoNode federated resource.title"),
    status: oneOf(record.status, ["current", "withdrawn"], "GeoNode federated resource.status"),
    currentVersionNumber: positiveInteger(
      record.current_version_number, "GeoNode federated resource.current_version_number"
    ),
    currentPayloadSha256: sha256(
      record.current_payload_sha256, "GeoNode federated resource.current_payload_sha256"
    ),
    remoteModifiedAt: nullableTimestamp(
      record.remote_modified_at, "GeoNode federated resource.remote_modified_at"
    ),
    firstSeenAt: timestamp(record.first_seen_at, "GeoNode federated resource.first_seen_at"),
    lastRefreshedAt: timestamp(
      record.last_refreshed_at, "GeoNode federated resource.last_refreshed_at"
    ),
    freshUntil: timestamp(record.fresh_until, "GeoNode federated resource.fresh_until"),
    withdrawnAt: nullableTimestamp(
      record.withdrawn_at, "GeoNode federated resource.withdrawn_at"
    )
  };
}

export function parseGeoNodeFederatedResourceVersion(value) {
  const record = object(value, "GeoNode federated resource version");
  exactKeys(record, [
    "schema_version", "source_id", "remote_identifier", "version_number", "harvest_job_id",
    "action", "resource_type", "title", "payload_sha256", "payload", "remote_modified_at",
    "observed_at"
  ], "GeoNode federated resource version");
  if (record.schema_version !== "opengeo.geonode-federated-resource-version.1.0.0") {
    contract("GeoNode federated resource version schema is unsupported");
  }
  const action = oneOf(
    record.action, ["added", "updated", "withdrawn"],
    "GeoNode federated resource version.action"
  );
  return {
    sourceId: uuid(record.source_id, "GeoNode federated resource version.source_id"),
    remoteIdentifier: uuid(
      record.remote_identifier, "GeoNode federated resource version.remote_identifier"
    ),
    versionNumber: positiveInteger(
      record.version_number, "GeoNode federated resource version.version_number"
    ),
    harvestJobId: uuid(
      record.harvest_job_id, "GeoNode federated resource version.harvest_job_id"
    ),
    action,
    resourceType: oneOf(
      record.resource_type,
      ["dataset", "document", "map", "geoapp", "service"],
      "GeoNode federated resource version.resource_type"
    ),
    title: boundedString(record.title, 500, "GeoNode federated resource version.title"),
    payloadSha256: sha256(
      record.payload_sha256, "GeoNode federated resource version.payload_sha256"
    ),
    payload: record.payload === null
      ? null
      : boundedObject(record.payload, 131_072, "GeoNode federated resource version.payload"),
    remoteModifiedAt: nullableTimestamp(
      record.remote_modified_at, "GeoNode federated resource version.remote_modified_at"
    ),
    observedAt: timestamp(
      record.observed_at, "GeoNode federated resource version.observed_at"
    )
  };
}

function geonodeRemoteUrl(value, ErrorClass) {
  if (typeof value !== "string" || value.length > 2_048 || value !== value.trim()) {
    throw new ErrorClass("GeoNode federation URL is invalid");
  }
  let url;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new ErrorClass("GeoNode federation URL is invalid", {cause});
  }
  const path = url.pathname === "/" ? "" : url.pathname;
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || !url.hostname || ["localhost", "localhost.localdomain"].includes(url.hostname)
    || url.hostname.endsWith(".local") || path.endsWith("/")) {
    throw new ErrorClass("GeoNode federation URL must be canonical HTTPS");
  }
  return `${url.origin}${path}`;
}

export function parseGeoNodeImport(value) {
  const record = object(value, "GeoNode import");
  return {
    sourceProduct: oneOf(record.source_product, ["geonode"], "GeoNode import.source_product"),
    sourceVersion: oneOf(record.source_version, ["5.1.0"], "GeoNode import.source_version"),
    sourceCommit: oneOf(record.source_commit, ["a1db97e81dfc26c16bb4ee1a5d2b408877af66c9"], "GeoNode import.source_commit"),
    idempotent: boolean(record.idempotent, "GeoNode import.idempotent"),
    resources: parseArray(record.resources, parseGovernedResource, "GeoNode import.resources"),
    report: boundedObject(record.report, 131_072, "GeoNode import.report")
  };
}

export function parseGeoNodeExport(value) {
  const record = object(value, "GeoNode export");
  return {
    sourceProduct: oneOf(record.source_product, ["opengeo"], "GeoNode export.source_product"),
    targetProduct: oneOf(record.target_product, ["geonode"], "GeoNode export.target_product"),
    targetVersion: oneOf(record.target_version, ["5.1.0"], "GeoNode export.target_version"),
    targetCommit: oneOf(record.target_commit, ["a1db97e81dfc26c16bb4ee1a5d2b408877af66c9"], "GeoNode export.target_commit"),
    resource: boundedObject(record.resource, 131_072, "GeoNode export.resource"),
    report: boundedObject(record.report, 131_072, "GeoNode export.report")
  };
}

function importReference(value, label) {
  const reference = string(value, label);
  if (!/^geolibre:[A-Za-z0-9._:-]{1,200}$/.test(reference)) contract(`${label} is invalid`);
  return reference;
}

function parseSourceCapabilities(value) {
  const record = object(value, "external source.capabilities");
  return {
    read: boolean(record.read, "external source.capabilities.read"),
    edit: boolean(record.edit, "external source.capabilities.edit"),
    manageClassification: record.manage_classification === undefined ? false
      : boolean(record.manage_classification, "external source.capabilities.manage_classification")
  };
}

function boundedSourceFields(value, label) {
  const fields = parseArray(value, (field) => ogcName(field, label), label);
  if (!fields.length || fields.length > 64 || new Set(fields).size !== fields.length) {
    contract(`${label} is invalid`);
  }
  return fields;
}

function parseExternalSourceConfiguration(value, sourceType) {
  if (sourceType === "cog") {
    const record = object(value, "COG configuration");
    exactKeys(record, ["service_kind", "bands", "bounds", "size_bytes", "attribution", "license", "reference_metadata"], "COG configuration");
    const bands = parseArray(record.bands, band => integerBetween(band, 1, 64, "COG band"), "COG bands");
    if (![1, 3].includes(bands.length) || new Set(bands).size !== bands.length) contract("Select one or three distinct COG bands");
    return {serviceKind: oneOf(record.service_kind, ["cog"], "COG kind"), bands,
      bounds: orderedGeographicBounds(record.bounds, "COG bounds", ApiContractError),
      sizeBytes: record.size_bytes === null ? null : integerBetween(record.size_bytes, 1, 1_099_511_627_776, "COG size"),
      attribution: nullableBoundedString(record.attribution, 1000, "COG attribution"),
      license: nullableBoundedString(record.license, 500, "COG license"),
      referenceMetadata: boundedObject(record.reference_metadata, 262144, "COG reference metadata")};
  }
  if (sourceType === "mapserver") {
    const record = object(value, "MapServer configuration");
    exactKeys(record, ["service_kind", "layer_ids", "tile_size", "image_format", "min_zoom", "max_zoom", "attribution"], "MapServer configuration");
    const layerIds = parseArray(record.layer_ids, id => integerBetween(id, 0, 1000000, "MapServer layer ID"), "MapServer layers");
    if (!layerIds.length || layerIds.length > 32 || new Set(layerIds).size !== layerIds.length) contract("Invalid MapServer layer selection");
    const minZoom = integerBetween(record.min_zoom, 0, 24, "MapServer minimum zoom");
    return {serviceKind: oneOf(record.service_kind, ["mapserver"], "MapServer kind"), layerIds,
      tileSize: oneOf(record.tile_size, [256, 512], "MapServer tile size"),
      imageFormat: oneOf(record.image_format, ["png32"], "MapServer display format"), minZoom,
      maxZoom: integerBetween(record.max_zoom, minZoom, 24, "MapServer maximum zoom"),
      attribution: nullableString(record.attribution, "MapServer attribution")};
  }
  if (sourceType === "imageserver") {
    const record = object(value, "ImageServer source configuration");
    exactKeys(record, ["service_kind", "tile_size", "image_format", "interpolation", "band_ids", "min_zoom", "max_zoom", "attribution", ...(Object.hasOwn(record, "raster_ids") ? ["raster_ids"] : [])], "ImageServer source configuration");
    const bandIds = parseArray(record.band_ids, band => integerBetween(band, 0, 255, "ImageServer band"), "ImageServer bands");
    if (![0, 1, 3].includes(bandIds.length)) contract("Select one or three display bands, or the provider default");
    const rasterIds = Object.hasOwn(record, "raster_ids")
      ? imageServerRasterIds(record.raster_ids, ApiContractError) : [];
    const minZoom = integerBetween(record.min_zoom, 0, 24, "ImageServer minimum zoom");
    const maxZoom = integerBetween(record.max_zoom, minZoom, 24, "ImageServer maximum zoom");
    return {
      serviceKind: oneOf(record.service_kind, ["imageserver"], "ImageServer kind"),
      tileSize: oneOf(record.tile_size, [256, 512], "ImageServer tile size"),
      imageFormat: oneOf(record.image_format, ["png32", "jpg"], "ImageServer display format"),
      interpolation: oneOf(record.interpolation, ["RSP_NearestNeighbor", "RSP_BilinearInterpolation"], "ImageServer interpolation"),
      bandIds, minZoom, maxZoom,
      ...(rasterIds.length ? {rasterIds} : {}),
      attribution: nullableString(record.attribution, "ImageServer attribution")
    };
  }
  const record = object(value, "external source.configuration");
  if (sourceType === "xyz") {
    const regional = Object.hasOwn(record, "presentation_role");
    exactKeys(
      record,
      [
        "min_zoom",
        "max_zoom",
        "tile_size",
        "scheme",
        "attribution",
        ...(regional
          ? ["presentation_role", "license", "coverage_bounds", "coordinate_behavior"]
          : [])
      ],
      "XYZ source configuration"
    );
    const minZoom = integerBetween(record.min_zoom, 0, 24, "XYZ source.min_zoom");
    const maxZoom = integerBetween(record.max_zoom, 0, 24, "XYZ source.max_zoom");
    if (minZoom > maxZoom) contract("XYZ source zoom range is invalid");
    const configuration = {
      minZoom,
      maxZoom,
      tileSize: oneOf(record.tile_size, [256, 512], "XYZ source.tile_size"),
      scheme: oneOf(record.scheme, ["xyz", "tms"], "XYZ source.scheme"),
      attribution: nullableString(record.attribution, "XYZ source.attribution")
    };
    if (!regional) return configuration;
    if (configuration.attribution === null) contract("Regional basemap attribution is required");
    const coverageBounds = parseArray(
      record.coverage_bounds,
      (coordinate) => finiteNumber(coordinate, "Regional basemap coverage coordinate"),
      "Regional basemap coverage_bounds"
    );
    if (
      coverageBounds.length !== 4
      || coverageBounds[0] < -180
      || coverageBounds[2] > 180
      || coverageBounds[1] < -90
      || coverageBounds[3] > 90
      || coverageBounds[0] >= coverageBounds[2]
      || coverageBounds[1] >= coverageBounds[3]
    ) {
      contract("Regional basemap coverage_bounds are invalid");
    }
    return {
      ...configuration,
      presentationRole: oneOf(
        record.presentation_role,
        ["regional_basemap"],
        "Regional basemap presentation_role"
      ),
      license: boundedString(record.license, 500, "Regional basemap license"),
      coverageBounds,
      coordinateBehavior: oneOf(
        record.coordinate_behavior,
        ["wgs84_web_mercator", "gcj02_offset"],
        "Regional basemap coordinate_behavior"
      )
    };
  }
  if (sourceType === "arcgis") {
    exactKeys(
      record,
      ["object_id_field", "fields", "geometry_type", "page_size", "attribution"],
      "ArcGIS source configuration"
    );
    const objectIdField = ogcName(record.object_id_field, "ArcGIS source.object_id_field");
    const fields = boundedSourceFields(record.fields, "ArcGIS source.fields");
    if (!fields.includes(objectIdField)) {
      contract("ArcGIS source fields must include object_id_field");
    }
    return {
      objectIdField,
      fields,
      geometryType: featureGeometryType(record.geometry_type, "ArcGIS source.geometry_type"),
      pageSize: integerBetween(record.page_size, 1, 2_000, "ArcGIS source.page_size"),
      attribution: nullableString(record.attribution, "ArcGIS source.attribution")
    };
  }
  if (sourceType === "wfs") {
    exactKeys(
      record,
      ["version", "type_name", "geometry_name", "fields", "sort_by", "geometry_type", "page_size", "attribution"],
      "WFS source configuration"
    );
    const fields = boundedSourceFields(record.fields, "WFS source.fields");
    const sortBy = ogcName(record.sort_by, "WFS source.sort_by");
    const geometryName = ogcName(record.geometry_name, "WFS source.geometry_name");
    if (!fields.includes(sortBy) || fields.includes(geometryName)) {
      contract("WFS source field identity is invalid");
    }
    return {
      version: oneOf(record.version, ["2.0.0"], "WFS source.version"),
      typeName: ogcName(record.type_name, "WFS source.type_name"),
      geometryName,
      fields,
      sortBy,
      geometryType: featureGeometryType(record.geometry_type, "WFS source.geometry_type"),
      pageSize: integerBetween(record.page_size, 1, 1_000, "WFS source.page_size"),
      attribution: nullableString(record.attribution, "WFS source.attribution")
    };
  }
  if (sourceType === "pmtiles") {
    exactKeys(record, ["tile_type", "source_layer", "geometry_type", "min_zoom", "max_zoom", "attribution"], "PMTiles source configuration");
    const tileType = oneOf(record.tile_type, ["vector", "raster"], "PMTiles source.tile_type");
    const sourceLayer = nullableString(record.source_layer, "PMTiles source.source_layer");
    const geometryType = record.geometry_type === null
      ? null
      : oneOf(record.geometry_type, ["Point", "LineString", "Polygon"], "PMTiles source.geometry_type");
    const minZoom = integerBetween(record.min_zoom, 0, 24, "PMTiles source.min_zoom");
    const maxZoom = integerBetween(record.max_zoom, 0, 24, "PMTiles source.max_zoom");
    if (minZoom > maxZoom) contract("PMTiles source zoom range is invalid");
    if (tileType === "vector" && (!sourceLayer || !geometryType)) contract("Vector PMTiles source shape is invalid");
    if (tileType === "raster" && (sourceLayer || geometryType)) contract("Raster PMTiles source shape is invalid");
    return {
      tileType,
      sourceLayer,
      geometryType,
      minZoom,
      maxZoom,
      attribution: nullableString(record.attribution, "PMTiles source.attribution")
    };
  }
  if (sourceType === "geojson") {
    exactKeys(record, [
      "content_encoding",
      "object_sha256",
      "decoded_sha256",
      "size_bytes",
      "decoded_size_bytes",
      "feature_count",
      "geometry_type",
      "bounds",
      "attribution",
      "license",
      "authoritative_url",
      "rights_url"
    ], "GeoJSON archive configuration");
    const contentEncoding = oneOf(
      record.content_encoding,
      ["identity", "gzip"],
      "GeoJSON archive.content_encoding"
    );
    const objectSha256 = sha256(record.object_sha256, "GeoJSON archive.object_sha256");
    const decodedSha256 = sha256(record.decoded_sha256, "GeoJSON archive.decoded_sha256");
    const sizeBytes = integerBetween(record.size_bytes, 1, 33_554_432, "GeoJSON archive.size_bytes");
    const decodedSizeBytes = integerBetween(
      record.decoded_size_bytes,
      1,
      134_217_728,
      "GeoJSON archive.decoded_size_bytes"
    );
    const bounds = orderedGeographicBounds(
      record.bounds,
      "GeoJSON archive.bounds",
      ApiContractError
    );
    if (contentEncoding === "identity"
      && (objectSha256 !== decodedSha256 || sizeBytes !== decodedSizeBytes)) {
      contract("Uncompressed GeoJSON archive facts do not match");
    }
    if (contentEncoding === "gzip" && decodedSizeBytes < sizeBytes) {
      contract("Gzip GeoJSON archive decoded size is invalid");
    }
    return {
      contentEncoding,
      objectSha256,
      decodedSha256,
      sizeBytes,
      decodedSizeBytes,
      featureCount: integerBetween(record.feature_count, 1, 250_000, "GeoJSON archive.feature_count"),
      geometryType: featureGeometryType(record.geometry_type, "GeoJSON archive.geometry_type"),
      bounds,
      attribution: boundedString(record.attribution, 1_000, "GeoJSON archive.attribution"),
      license: boundedString(record.license, 500, "GeoJSON archive.license"),
      authoritativeUrl: publicSourceUrl(record.authoritative_url, "reference"),
      rightsUrl: publicSourceUrl(record.rights_url, "reference")
    };
  }
  exactKeys(record, ["version", "layers", "styles", "format", "transparent", "crs", "tile_size", "attribution"], "WMS source configuration");
  const layers = parseArray(record.layers, (layer) => ogcName(layer, "WMS layer"), "WMS source.layers");
  const styles = parseArray(record.styles, (style) => style === "" ? "" : ogcName(style, "WMS style"), "WMS source.styles");
  if (!layers.length || layers.length > 32 || styles.length !== layers.length || new Set(layers).size !== layers.length) {
    contract("WMS source layer/style configuration is invalid");
  }
  const imageFormat = oneOf(record.format, ["image/png", "image/jpeg"], "WMS source.format");
  const transparent = boolean(record.transparent, "WMS source.transparent");
  if (imageFormat === "image/jpeg" && transparent) contract("WMS source transparent JPEG is invalid");
  return {
    version: oneOf(record.version, ["1.3.0", "1.1.1"], "WMS source.version"),
    layers,
    styles,
    imageFormat,
    transparent,
    crs: oneOf(record.crs, ["EPSG:3857"], "WMS source.crs"),
    tileSize: oneOf(record.tile_size, [256, 512], "WMS source.tile_size"),
    attribution: nullableString(record.attribution, "WMS source.attribution")
  };
}

function serializeSourceDefinition(value) {
  const source = object(value, "external source definition");
  const type = oneOf(
    source.type,
    ["xyz", "wms", "pmtiles", "geojson", "arcgis", "wfs", "imageserver", "mapserver", "cog"],
    "external source definition.type"
  );
  if (type === "cog") {
    const bands = source.bands ?? [1, 2, 3];
    if (!Array.isArray(bands) || ![1, 3].includes(bands.length) || bands.some(band => !Number.isInteger(band) || band < 1 || band > 64) || new Set(bands).size !== bands.length) throw new TypeError("Invalid COG band selection");
    return {type, url: publicSourceUrl(source.url, type), bands,
      bounds: orderedGeographicBounds(source.bounds, "COG bounds", TypeError),
      size_bytes: source.sizeBytes == null ? null : inputIntegerBetween(source.sizeBytes, 1, 1_099_511_627_776, "COG size"),
      attribution: source.attribution ?? null, license: source.license ?? null,
      reference_metadata: boundedObject(source.referenceMetadata ?? {}, 262144, "COG reference metadata")};
  }
  if (type === "mapserver") {
    return {type, url: publicSourceUrl(source.url, type), layer_ids: source.layerIds,
      tile_size: source.tileSize ?? 256, image_format: "png32",
      min_zoom: source.minZoom ?? 0, max_zoom: source.maxZoom ?? 22,
      attribution: source.attribution ?? null};
  }
  if (type === "imageserver") {
    const rasterIds = source.rasterIds === undefined ? [] : imageServerRasterIds(source.rasterIds, TypeError);
    return {
      type, url: publicSourceUrl(source.url, type),
      tile_size: source.tileSize ?? 256,
      image_format: source.imageFormat ?? "png32",
      interpolation: source.interpolation ?? "RSP_NearestNeighbor",
      band_ids: source.bandIds ?? [],
      ...(rasterIds.length ? {raster_ids: rasterIds} : {}),
      min_zoom: source.minZoom ?? 0, max_zoom: source.maxZoom ?? 22,
      attribution: source.attribution ?? null
    };
  }
  if (type === "xyz") {
    const sourceDefinition = {
      type,
      url: source.url,
      min_zoom: source.minZoom ?? 0,
      max_zoom: source.maxZoom ?? 22,
      tile_size: source.tileSize ?? 256,
      scheme: source.scheme ?? "xyz",
      attribution: source.attribution ?? null
    };
    if (source.presentationRole === undefined) return sourceDefinition;
    return {
      ...sourceDefinition,
      presentation_role: source.presentationRole,
      license: source.license,
      coverage_bounds: source.coverageBounds,
      coordinate_behavior: source.coordinateBehavior
    };
  }
  if (type === "pmtiles") {
    return {
      type,
      url: source.url,
      tile_type: source.tileType,
      source_layer: source.sourceLayer ?? null,
      geometry_type: source.geometryType ?? null,
      min_zoom: source.minZoom ?? 0,
      max_zoom: source.maxZoom ?? 24,
      attribution: source.attribution ?? null
    };
  }
  if (type === "arcgis") {
    return {
      type,
      url: source.url,
      object_id_field: source.objectIdField,
      fields: source.fields,
      geometry_type: source.geometryType,
      page_size: source.pageSize ?? 1_000,
      attribution: source.attribution ?? null
    };
  }
  if (type === "wfs") {
    return {
      type,
      url: source.url,
      version: source.version ?? "2.0.0",
      type_name: source.typeName,
      geometry_name: source.geometryName,
      fields: source.fields,
      sort_by: source.sortBy,
      geometry_type: source.geometryType,
      page_size: source.pageSize ?? 1_000,
      attribution: source.attribution ?? null
    };
  }
  if (type === "geojson") {
    return {
      type,
      url: source.url,
      content_encoding: source.contentEncoding,
      object_sha256: sha256Checksum(source.objectSha256, "GeoJSON archive object checksum"),
      decoded_sha256: sha256Checksum(source.decodedSha256, "GeoJSON archive decoded checksum"),
      size_bytes: inputIntegerBetween(source.sizeBytes, 1, 33_554_432, "GeoJSON archive size"),
      decoded_size_bytes: inputIntegerBetween(
        source.decodedSizeBytes,
        1,
        134_217_728,
        "GeoJSON archive decoded size"
      ),
      feature_count: inputIntegerBetween(source.featureCount, 1, 250_000, "GeoJSON archive feature count"),
      geometry_type: featureGeometryType(source.geometryType, "GeoJSON archive geometry type"),
      bounds: orderedGeographicBounds(source.bounds, "GeoJSON archive bounds", TypeError),
      attribution: source.attribution,
      license: source.license,
      authoritative_url: source.authoritativeUrl,
      rights_url: source.rightsUrl
    };
  }
  return {
    type,
    url: source.url,
    version: source.version ?? "1.3.0",
    layers: source.layers,
    styles: source.styles ?? [],
    image_format: source.imageFormat ?? "image/png",
    transparent: source.transparent ?? true,
    crs: source.crs ?? "EPSG:3857",
    tile_size: source.tileSize ?? 256,
    attribution: source.attribution ?? null
  };
}

function imageServerRasterIds(value, ErrorType) {
  if (!Array.isArray(value) || value.length > 32
    || Array.from(value).some(id => !Number.isInteger(id) || id < 0 || id > 2_147_483_647)
    || new Set(value).size !== value.length) {
    throw new ErrorType("Select at most 32 distinct integer ImageServer raster IDs from 0 to 2147483647.");
  }
  return [...value];
}

function publicSourceUrl(value, sourceType) {
  const raw = string(value, "external source.source_url");
  if (raw.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(raw)) contract("external source.source_url is invalid");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (cause) {
    contract("external source.source_url is invalid", cause);
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || (parsed.port && parsed.port !== "443")
    || parsed.hash
    || !hostname
    || hostname === "localhost"
    || hostname === "localhost.localdomain"
    || [".localhost", ".local", ".internal", ".home.arpa"].some((suffix) => hostname.endsWith(suffix))
    || hostname.includes(":")
    || /^\d+(?:\.\d+){3}$/.test(hostname)
  ) {
    contract("external source.source_url is not an allowed public HTTPS URL");
  }
  if (["wms", "arcgis", "wfs", "imageserver", "mapserver", "cog"].includes(sourceType) && parsed.search) {
    contract(`${sourceType.toUpperCase()} source URL must not contain a query`);
  }
  if (sourceType === "cog" && !/\.tiff?$/i.test(parsed.pathname)) contract("COG source URL must name a TIFF object");
  if (sourceType === "arcgis" && !/\/(?:FeatureServer|MapServer)\/[0-9]{1,5}\/?$/.test(parsed.pathname)) {
    contract("ArcGIS source URL must identify one FeatureServer or MapServer layer");
  }
  if (sourceType === "mapserver" && !/\/MapServer\/?$/.test(parsed.pathname)) {
    contract("Use a MapServer service endpoint");
  }
  if (sourceType === "imageserver" && !/\/ImageServer\/?$/.test(parsed.pathname)) {
    contract("ImageServer source URL must identify an image service, not an operation");
  }
  if (sourceType === "pmtiles" && (parsed.search || !parsed.pathname.toLowerCase().endsWith(".pmtiles"))) {
    contract("PMTiles source URL must name a query-free .pmtiles object");
  }
  if (sourceType === "geojson" && (
    parsed.search
    || !parsed.pathname.toLowerCase().endsWith(".geojson")
      && !parsed.pathname.toLowerCase().endsWith(".geojson.gz")
  )) {
    contract("GeoJSON source URL must name a query-free .geojson or .geojson.gz object");
  }
  if (sourceType === "xyz") {
    const placeholders = [...raw.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
    if (placeholders.length !== 3 || new Set(placeholders).size !== 3 || !["z", "x", "y"].every((name) => placeholders.includes(name))) {
      contract("XYZ source URL placeholders are invalid");
    }
  }
  return raw;
}

function sourceDiscoveryServiceUrl(value, sourceType) {
  const raw = boundedString(value, 2_048, "source discovery service URL");
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) {
    contract("source discovery service URL is invalid");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (cause) {
    contract("source discovery service URL is invalid", cause);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password
    || parsed.port || parsed.search || parsed.hash || parsed.origin === "null") {
    contract("source discovery service URL must be anonymous, query-free HTTPS");
  }
  if (sourceType === "arcgis"
    && !/\/(?:FeatureServer|MapServer)\/?$/.test(parsed.pathname)) {
    contract("ArcGIS discovery URL must identify one service");
  }
  return parsed.href.replace(/\/$/, "");
}

function exactKeys(record, expected, label) {
  const actual = Object.keys(record).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    contract(`${label} has unexpected fields`);
  }
}

function publicCatalogHref(value, label, previewSuffix) {
  const href = boundedString(value, 512, label);
  const match = href.match(
    /^\/public\/organizations\/([^/]+)\/projects\/([^/]+)\/resources\/([^/]+)(?:\/(map-preview|spatial-preview|dataset-document-preview|document-preview))?$/
  );
  if (
    !match
    || match.slice(1, 4).some((item) => !UUID_PATTERN.test(item))
    || (match[4] ?? null) !== previewSuffix
  ) {
    contract(`${label} is invalid`);
  }
  return href;
}

function parsePublicSiteDirectoryHref(value, label) {
  const href = boundedString(value, 512, label);
  const match = href.match(
    /^\/public\/organizations\/([^/]+)\/publications\/([a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?)$/
  );
  if (!match || !UUID_PATTERN.test(match[1])) contract(`${label} is invalid`);
  return {href, organizationId: match[1].toLowerCase(), listedSlug: match[2]};
}

function parsePublicPrimarySiteHref(value, label) {
  const href = boundedString(value, 512, label);
  const match = href.match(/^\/public\/organizations\/([^/]+)\/publication$/);
  if (!match || !UUID_PATTERN.test(match[1])) contract(`${label} is invalid`);
  return {href, organizationId: match[1].toLowerCase()};
}

function serializeCopyScope(sourceType, value) {
  if (!isObject(value)) throw new TypeError("copy estimate scope must be an object");
  if (sourceType === "pmtiles") {
    const keys = Object.keys(value).sort();
    if (keys.length !== 1 || keys[0] !== "kind" || value.kind !== "exact_object") {
      throw new TypeError("PMTiles copy scope must select the exact object");
    }
    return {kind: "exact_object"};
  }
  if (["arcgis", "wfs"].includes(sourceType)) {
    const keys = Object.keys(value).sort();
    const expected = ["bounds", "kind", "maximumFeatures", "pageSize"];
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
      throw new TypeError("feature copy scope has unexpected fields");
    }
    if (value.kind !== "bounded_features") {
      throw new TypeError("feature copy scope must be bounded features");
    }
    const maximumFeatures = inputIntegerBetween(
      value.maximumFeatures, 1, 50_000, "feature copy maximum features"
    );
    const pageSize = inputIntegerBetween(
      value.pageSize,
      1,
      sourceType === "wfs" ? 1_000 : 2_000,
      "feature copy page size"
    );
    if (Math.ceil(maximumFeatures / pageSize) > 64) {
      throw new TypeError("feature copy exceeds the request limit");
    }
    return {
      kind: "bounded_features",
      bounds: orderedGeographicBounds(value.bounds, "feature copy bounds", TypeError),
      maximum_features: maximumFeatures,
      page_size: pageSize
    };
  }
  const keys = Object.keys(value).sort();
  const expected = ["bounds", "height", "kind", "width"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError("WMS copy scope has unexpected fields");
  }
  if (value.kind !== "bounded_image") {
    throw new TypeError("WMS copy scope must be a bounded image");
  }
  const bounds = orderedGeographicBounds(value.bounds, "WMS copy bounds", TypeError);
  const width = inputIntegerBetween(value.width, 1, 4096, "WMS copy width");
  const height = inputIntegerBetween(value.height, 1, 4096, "WMS copy height");
  if (width * height > 16_777_216) throw new TypeError("WMS copy exceeds the pixel limit");
  return {kind: "bounded_image", bounds, width, height};
}

function serializeProtectedCopyAcceptance(request) {
  const record = object(request, "protected copy request");
  const estimate = object(record.estimate, "protected copy estimate acceptance");
  const rights = object(record.rights, "protected copy rights");
  const destination = object(record.destination, "protected copy destination");
  if (estimate.accepted !== true || rights.confirmed !== true) {
    throw new TypeError("protected copy requires accepted estimate and confirmed rights");
  }
  return {
    idempotency_key: assertUuid(record.idempotencyKey, "protected copy idempotency key"),
    estimate: {
      estimate_id: assertUuid(estimate.estimateId, "protected copy estimate id"),
      estimate_checksum_sha256: sha256Checksum(
        estimate.estimateChecksumSha256, "protected copy estimate checksum"
      ),
      accepted: true
    },
    rights: {
      confirmed: true,
      basis: boundedQuery(rights.basis, 500, "protected copy rights basis"),
      attribution: boundedQuery(rights.attribution, 1000, "protected copy attribution")
    },
    destination: {
      name: boundedQuery(destination.name, 200, "protected copy destination name"),
      description: destination.description === null || destination.description === undefined
        ? null
        : boundedQuery(
            destination.description, 10_000, "protected copy destination description"
          ),
      classification: inputOneOf(
        destination.classification ?? "internal",
        ["public", "internal", "confidential", "restricted"],
        "protected copy destination classification"
      )
    }
  };
}

function parseCopyScope(sourceType, value) {
  const record = object(value, "copy scope");
  if (sourceType === "pmtiles") {
    exactKeys(record, ["kind"], "PMTiles copy scope");
    if (record.kind !== "exact_object") contract("PMTiles copy scope is invalid");
    return {kind: "exact_object"};
  }
  if (["arcgis", "wfs", "feature"].includes(sourceType)) {
    exactKeys(
      record,
      ["kind", "bounds", "maximum_features", "page_size"],
      "feature copy scope"
    );
    if (record.kind !== "bounded_features") contract("feature copy scope is invalid");
    const maximumFeatures = integerBetween(
      record.maximum_features, 1, 50_000, "feature copy scope.maximum_features"
    );
    const pageSize = integerBetween(
      record.page_size,
      1,
      sourceType === "wfs" ? 1_000 : 2_000,
      "feature copy scope.page_size"
    );
    if (Math.ceil(maximumFeatures / pageSize) > 64) {
      contract("feature copy scope exceeds the request limit");
    }
    return {
      kind: "bounded_features",
      bounds: orderedGeographicBounds(
        record.bounds, "feature copy scope.bounds", ApiContractError
      ),
      maximumFeatures,
      pageSize
    };
  }
  exactKeys(record, ["kind", "bounds", "width", "height"], "WMS copy scope");
  if (record.kind !== "bounded_image") contract("WMS copy scope is invalid");
  const bounds = orderedGeographicBounds(record.bounds, "WMS copy scope.bounds", ApiContractError);
  const width = integerBetween(record.width, 1, 4096, "WMS copy scope.width");
  const height = integerBetween(record.height, 1, 4096, "WMS copy scope.height");
  if (width * height > 16_777_216) contract("WMS copy scope exceeds the pixel limit");
  return {kind: "bounded_image", bounds, width, height};
}

function orderedGeographicBounds(value, label, ErrorClass) {
  if (!Array.isArray(value) || value.length !== 4) throw new ErrorClass(`${label} is invalid`);
  const bounds = value.map((coordinate) => {
    if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
      throw new ErrorClass(`${label} is invalid`);
    }
    return coordinate;
  });
  const [west, south, east, north] = bounds;
  if (!(west >= -180 && west < east && east <= 180
    && south >= -90 && south < north && north <= 90)) {
    throw new ErrorClass(`${label} is invalid`);
  }
  return bounds;
}

function inputIntegerBetween(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function decimalBetween(value, minimum, maximum, label) {
  const parsed = typeof value === "string" && /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value)
    ? Number(value)
    : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)
    || parsed < minimum || parsed > maximum) contract(`${label} is invalid`);
  return parsed;
}

function processingState(value, label) {
  return oneOf(value, ["queued", "running", "completed", "failed", "cancelled"], label);
}

function nullableSafeErrorCode(value, label) {
  if (value === null) return null;
  const code = string(value, label);
  if (code.length > 100 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(code)) {
    contract(`${label} is invalid`);
  }
  return code;
}

function validateJobResultShape(state, hasCompleteOutput, errorCode, cancellable, label) {
  if (typeof cancellable !== "boolean"
    || cancellable !== (state === "queued")
    || hasCompleteOutput !== (state === "completed")
    || (errorCode !== null) !== ["failed", "cancelled"].includes(state)) {
    contract(`${label} state and result are inconsistent`);
  }
}

function integerBetween(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) contract(`${label} is invalid`);
  return value;
}

function sha256(value, label) {
  const digest = string(value, label);
  if (!/^[0-9a-f]{64}$/.test(digest)) contract(`${label} is invalid`);
  return digest;
}

function ogcName(value, label) {
  const result = string(value, label);
  if (result.length > 200 || !/^[A-Za-z0-9_.:-]+$/.test(result)) contract(`${label} is invalid`);
  return result;
}

export function parseDatasetVersion(value) {
  const record = object(value, "dataset version");
  const extent = record.extent === null
    ? null
    : parseArray(record.extent, (coordinate) => finiteNumber(coordinate, "dataset version.extent"), "dataset version.extent");
  if (extent !== null && extent.length !== 4) contract("dataset version.extent is invalid");
  const schemaDefinition = object(record.schema_definition, "dataset version.schema_definition");
  if (JSON.stringify(schemaDefinition).length > 1_048_576) contract("dataset version.schema_definition is too large");
  return {
    id: uuid(record.id, "dataset version.id"),
    versionNumber: positiveInteger(record.version_number, "dataset version.version_number"),
    parentVersionId: nullableUuid(record.parent_version_id, "dataset version.parent_version_id"),
    state: oneOf(record.state, ["queued", "processing", "active", "failed"], "dataset version.state"),
    changeMessage: nullableString(record.change_message, "dataset version.change_message"),
    featureCount: nullableNonNegativeInteger(record.feature_count, "dataset version.feature_count"),
    extent,
    crs: nullableString(record.crs, "dataset version.crs"),
    geometryType: nullableString(record.geometry_type, "dataset version.geometry_type"),
    schemaDefinition,
    qualityResults: parseQualityResults(record.quality_results),
    createdBy: uuid(record.created_by, "dataset version.created_by"),
    createdAt: timestamp(record.created_at, "dataset version.created_at"),
    current: boolean(record.current, "dataset version.current"),
    objects: parseArray(record.objects, parseDatasetObject, "dataset version.objects")
  };
}

export function parseDatasetVersionLineage(value) {
  const record = boundedObject(value, 262_144, "dataset version lineage");
  exactKeys(record, [
    "schema_version", "dataset_id", "version_id", "version_number", "origins",
    "derivatives", "derivatives_truncated"
  ], "dataset version lineage");
  if (record.schema_version !== "opengeo.dataset-version-lineage.1.0.0") {
    contract("dataset version lineage schema is unsupported");
  }
  const origins = parseArray(
    record.origins, parseDatasetLineageOrigin, "dataset version lineage.origins"
  );
  const derivatives = parseArray(
    record.derivatives, parseDatasetDerivativeLineage, "dataset version lineage.derivatives"
  );
  if (origins.length > 3 || derivatives.length > 100) {
    contract("dataset version lineage contains too many records");
  }
  return {
    schemaVersion: record.schema_version,
    datasetId: uuid(record.dataset_id, "dataset version lineage.dataset_id"),
    versionId: uuid(record.version_id, "dataset version lineage.version_id"),
    versionNumber: positiveInteger(
      record.version_number, "dataset version lineage.version_number"
    ),
    origins,
    derivatives,
    derivativesTruncated: boolean(
      record.derivatives_truncated, "dataset version lineage.derivatives_truncated"
    )
  };
}

function parseDatasetLineageOrigin(value) {
  const record = object(value, "dataset lineage origin");
  exactKeys(record, [
    "kind", "operation_id", "source_dataset_id", "source_dataset_name",
    "source_revision_number", "input_object_id", "acquired_at"
  ], "dataset lineage origin");
  const kind = oneOf(record.kind, [
    "managed_upload", "external_source_archive", "repository_object_copy"
  ], "dataset lineage origin.kind");
  const sourceDatasetId = nullableUuid(
    record.source_dataset_id, "dataset lineage origin.source_dataset_id"
  );
  const sourceDatasetName = nullableBoundedString(
    record.source_dataset_name, 300, "dataset lineage origin.source_dataset_name"
  );
  const sourceRevisionNumber = nullablePositiveInteger(
    record.source_revision_number, "dataset lineage origin.source_revision_number"
  );
  const managedShape = kind === "managed_upload"
    && sourceDatasetId === null
    && sourceDatasetName === null
    && sourceRevisionNumber === null;
  const externalShape = kind === "external_source_archive"
    && sourceDatasetId !== null
    && sourceDatasetName !== null
    && sourceRevisionNumber !== null;
  const repositoryShape = kind === "repository_object_copy"
    && sourceDatasetId !== null
    && sourceDatasetName !== null
    && sourceRevisionNumber === null;
  if (!managedShape && !externalShape && !repositoryShape) {
    contract("dataset lineage origin source shape is inconsistent");
  }
  return {
    kind,
    operationId: uuid(record.operation_id, "dataset lineage origin.operation_id"),
    sourceDatasetId,
    sourceDatasetName,
    sourceRevisionNumber,
    inputObjectId: uuid(record.input_object_id, "dataset lineage origin.input_object_id"),
    acquiredAt: timestamp(record.acquired_at, "dataset lineage origin.acquired_at")
  };
}

function parseDatasetDerivativeLineage(value) {
  const record = object(value, "dataset derivative lineage");
  exactKeys(record, [
    "kind", "operation_id", "recipe", "source_object_id", "output_object_id",
    "bounds", "minimum_zoom", "maximum_zoom", "source_layer",
    "request_checksum_sha256", "created_at"
  ], "dataset derivative lineage");
  if (record.kind !== "pmtiles" || record.recipe !== "gdal-pmtiles-v1") {
    contract("dataset derivative lineage kind or recipe is unsupported");
  }
  const bounds = parseArray(
    record.bounds,
    (coordinate) => finiteNumber(coordinate, "dataset derivative lineage.bounds"),
    "dataset derivative lineage.bounds"
  );
  if (
    bounds.length !== 4
    || bounds[0] < -180 || bounds[0] > 180
    || bounds[2] < -180 || bounds[2] > 180
    || bounds[1] < -90 || bounds[1] > 90
    || bounds[3] < -90 || bounds[3] > 90
    || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]
  ) contract("dataset derivative lineage.bounds is invalid");
  const minimumZoom = integerBetween(
    record.minimum_zoom, 0, 22, "dataset derivative lineage.minimum_zoom"
  );
  const maximumZoom = integerBetween(
    record.maximum_zoom, 0, 22, "dataset derivative lineage.maximum_zoom"
  );
  if (minimumZoom > maximumZoom) {
    contract("dataset derivative lineage zoom range is inconsistent");
  }
  return {
    kind: record.kind,
    operationId: uuid(record.operation_id, "dataset derivative lineage.operation_id"),
    recipe: record.recipe,
    sourceObjectId: uuid(
      record.source_object_id, "dataset derivative lineage.source_object_id"
    ),
    outputObjectId: uuid(
      record.output_object_id, "dataset derivative lineage.output_object_id"
    ),
    bounds,
    minimumZoom,
    maximumZoom,
    sourceLayer: boundedString(
      record.source_layer, 200, "dataset derivative lineage.source_layer"
    ),
    requestChecksumSha256: sha256(
      record.request_checksum_sha256, "dataset derivative lineage.request_checksum_sha256"
    ),
    createdAt: timestamp(record.created_at, "dataset derivative lineage.created_at")
  };
}

export function parseSpatialPreview(value) {
  const record = boundedObject(value, 4_300_000, "spatial preview");
  exactKeys(record, [
    "schema_version", "dataset_version_id", "number_returned",
    "number_matched", "may_be_truncated", "geojson"
  ], "spatial preview");
  if (record.schema_version !== "opengeo.spatial-preview.1.0.0") {
    contract("spatial preview schema is unsupported");
  }
  const numberReturned = integerBetween(
    record.number_returned, 0, 5_000, "spatial preview.number_returned"
  );
  const numberMatched = record.number_matched === null
    ? null
    : nonNegativeInteger(record.number_matched, "spatial preview.number_matched");
  const mayBeTruncated = boolean(
    record.may_be_truncated, "spatial preview.may_be_truncated"
  );
  if (
    (numberMatched !== null && numberReturned > numberMatched)
    || mayBeTruncated !== (numberMatched === null || numberReturned < numberMatched)
  ) {
    contract("spatial preview counts are inconsistent");
  }
  const geojson = spatialPreviewGeojson(record.geojson);
  if (geojson.features.length !== numberReturned) {
    contract("spatial preview feature count is inconsistent");
  }
  return {
    schemaVersion: record.schema_version,
    datasetVersionId: uuid(record.dataset_version_id, "spatial preview.dataset_version_id"),
    numberReturned,
    numberMatched,
    mayBeTruncated,
    geojson
  };
}

function spatialPreviewGeojson(value) {
  const collection = boundedObject(value, 4_194_304, "spatial preview GeoJSON");
  const keys = Object.keys(collection);
  if (keys.some((key) => !["type", "name", "bbox", "features"].includes(key))) {
    contract("spatial preview GeoJSON has unsupported members");
  }
  if (collection.type !== "FeatureCollection") {
    contract("spatial preview GeoJSON type is invalid");
  }
  if (collection.name !== undefined) {
    boundedString(collection.name, 300, "spatial preview GeoJSON name");
  }
  if (collection.bbox !== undefined) spatialPreviewBbox(collection.bbox);
  const budget = {positions: 0, nodes: 0};
  const features = parseArray(
    collection.features,
    (feature) => spatialPreviewFeature(feature, budget),
    "spatial preview GeoJSON features"
  );
  if (features.length > 5_000) contract("spatial preview has too many features");
  return structuredClone({...collection, features});
}

function spatialPreviewFeature(value, budget) {
  const feature = object(value, "spatial preview feature");
  if (Object.keys(feature).some(
    (key) => !["type", "id", "bbox", "geometry", "properties"].includes(key)
  ) || feature.type !== "Feature" || !("geometry" in feature) || !("properties" in feature)) {
    contract("spatial preview feature is invalid");
  }
  if (feature.id !== undefined && (
    !["string", "number"].includes(typeof feature.id)
    || (typeof feature.id === "number" && !Number.isFinite(feature.id))
    || (typeof feature.id === "string" && (!feature.id.length || feature.id.length > 512))
  )) contract("spatial preview feature id is invalid");
  if (feature.bbox !== undefined) spatialPreviewBbox(feature.bbox);
  const geometry = feature.geometry === null
    ? null
    : spatialPreviewGeometry(feature.geometry, budget, 0);
  const properties = boundedObject(feature.properties, 262_144, "spatial preview properties");
  if (Object.keys(properties).length > 256) contract("spatial preview has too many properties");
  spatialPreviewJson(properties, budget, 0);
  return structuredClone({...feature, geometry, properties});
}

function spatialPreviewGeometry(value, budget, depth) {
  const geometry = object(value, "spatial preview geometry");
  if (depth > 2 || Object.keys(geometry).some(
    (key) => !["type", "bbox", "coordinates", "geometries"].includes(key)
  )) contract("spatial preview geometry is invalid");
  if (geometry.bbox !== undefined) spatialPreviewBbox(geometry.bbox);
  const kind = oneOf(geometry.type, [
    "Point", "MultiPoint", "LineString", "MultiLineString",
    "Polygon", "MultiPolygon", "GeometryCollection"
  ], "spatial preview geometry type");
  if (kind === "GeometryCollection") {
    if ("coordinates" in geometry) contract("spatial preview geometry is invalid");
    const geometries = parseArray(
      geometry.geometries,
      (item) => spatialPreviewGeometry(item, budget, depth + 1),
      "spatial preview geometries"
    );
    if (geometries.length > 64) contract("spatial preview has too many geometries");
    return structuredClone({...geometry, geometries});
  }
  if ("geometries" in geometry || !("coordinates" in geometry)) {
    contract("spatial preview geometry is invalid");
  }
  spatialPreviewCoordinates(kind, geometry.coordinates, budget);
  return structuredClone(geometry);
}

function spatialPreviewCoordinates(kind, coordinates, budget) {
  if (kind === "Point") return spatialPreviewPosition(coordinates, budget);
  const level = (values, child) => {
    if (!Array.isArray(values) || values.length > 200_000) {
      contract("spatial preview coordinates are invalid");
    }
    for (const value of values) child(value);
  };
  if (kind === "MultiPoint" || kind === "LineString") {
    level(coordinates, (value) => spatialPreviewPosition(value, budget));
    if (kind === "LineString" && coordinates.length < 2) {
      contract("spatial preview line is invalid");
    }
    return;
  }
  if (kind === "MultiLineString" || kind === "Polygon") {
    level(coordinates, (values) => {
      level(values, (value) => spatialPreviewPosition(value, budget));
      if (values.length < (kind === "Polygon" ? 4 : 2)) {
        contract("spatial preview coordinate group is invalid");
      }
      if (kind === "Polygon" && !samePreviewPosition(values[0], values.at(-1))) {
        contract("spatial preview polygon is not closed");
      }
    });
    return;
  }
  level(coordinates, (groups) => level(groups, (values) => {
    level(values, (value) => spatialPreviewPosition(value, budget));
    if (values.length < 4 || !samePreviewPosition(values[0], values.at(-1))) {
      contract("spatial preview polygon is invalid");
    }
  }));
}

function spatialPreviewPosition(value, budget) {
  if (
    !Array.isArray(value)
    || ![2, 3].includes(value.length)
    || !value.every(Number.isFinite)
    || value[0] < -180 || value[0] > 180
    || value[1] < -90 || value[1] > 90
  ) contract("spatial preview position is invalid");
  budget.positions += 1;
  if (budget.positions > 200_000) contract("spatial preview has too many positions");
}

function samePreviewPosition(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left[0] === right[0] && left[1] === right[1];
}

function spatialPreviewBbox(value) {
  if (
    !Array.isArray(value) || ![4, 6].includes(value.length)
    || !value.every(Number.isFinite)
  ) contract("spatial preview bbox is invalid");
  const half = value.length / 2;
  if (value[0] < -180 || value[1] < -90 || value[half] > 180 || value[half + 1] > 90) {
    contract("spatial preview bbox is outside WGS84");
  }
  for (let index = 0; index < half; index += 1) {
    if (value[index] > value[index + half]) contract("spatial preview bbox is unordered");
  }
}

function spatialPreviewJson(value, budget, depth) {
  if (depth > 8 || ++budget.nodes > 400_000) {
    contract("spatial preview properties are too complex");
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value === "string" && value.length <= 8_192 && !value.includes("\0")) return;
  if (Array.isArray(value)) {
    if (value.length > 1_024) contract("spatial preview property array is too large");
    for (const item of value) spatialPreviewJson(item, budget, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > 256) contract("spatial preview property object is too large");
    for (const [key, item] of entries) {
      if (!key.length || key.length > 256 || key.includes("\0")) {
        contract("spatial preview property name is invalid");
      }
      spatialPreviewJson(item, budget, depth + 1);
    }
    return;
  }
  contract("spatial preview property is invalid");
}

export function parseDocumentPreview(value) {
  const record = boundedObject(value, 4_194_304, "document preview");
  let variant;
  let isOcrPdf = false;
  let isVisualPdf = false;
  if (
    record.schemaVersion === "opengeo.document-preview.1.0.0"
    && record.sourceFormat === "odt"
  ) {
    exactKeys(
      record,
      ["schemaVersion", "sourceFormat", "odfVersion", "title", "language", "pages"],
      "document preview"
    );
    variant = {
      schemaVersion: oneOf(
        record.schemaVersion,
        ["opengeo.document-preview.1.0.0"],
        "document preview schema"
      ),
      sourceFormat: oneOf(record.sourceFormat, ["odt"], "document preview source format"),
      odfVersion: oneOf(record.odfVersion, ["1.2", "1.3", "1.4"], "ODF version")
    };
  } else if (
    [
      "opengeo.document-preview.2.0.0",
      "opengeo.document-preview.3.0.0",
      "opengeo.pdf-visual-presentation.1.0.0",
      "opengeo.pdf-visual-presentation.2.0.0"
    ]
      .includes(record.schemaVersion)
    && record.sourceFormat === "pdf"
  ) {
    isOcrPdf = [
      "opengeo.document-preview.3.0.0",
      "opengeo.pdf-visual-presentation.2.0.0"
    ].includes(record.schemaVersion);
    isVisualPdf = [
      "opengeo.pdf-visual-presentation.1.0.0",
      "opengeo.pdf-visual-presentation.2.0.0"
    ].includes(record.schemaVersion);
    exactKeys(
      record,
      [
        "schemaVersion", "sourceFormat", "pdfVersion", "title", "language", "extraction",
        ...(isVisualPdf ? ["rendering"] : []),
        "pages"
      ],
      "document preview"
    );
    const extraction = object(record.extraction, "PDF text extraction");
    exactKeys(
      extraction,
      isOcrPdf
        ? [
            "engine", "mode", "ocrPerformed", "ocrEngine", "ocrEngineVersion", "ocrModel",
            "ocrPageLimit", "ocrPages", "ocrPixelLimit", "ocrMaximumDimension",
            "ocrTotalPixels", "ocrTruncated", "readingOrder", "tagged", "textAvailable"
          ]
        : ["engine", "mode", "ocrPerformed", "readingOrder", "tagged", "textAvailable"],
      "PDF text extraction"
    );
    let parsedExtraction;
    if (isOcrPdf) {
      const ocrEngineVersion = string(extraction.ocrEngineVersion, "PDF OCR engine version");
      if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+._A-Za-z0-9]{0,24})?$/.test(ocrEngineVersion)) {
        contract("PDF OCR engine version is invalid");
      }
      const ocrPages = parseArray(
        extraction.ocrPages,
        (page) => integerBetween(page, 1, 200, "PDF OCR page"),
        "PDF OCR pages"
      );
      if (
        !ocrPages.length
        || ocrPages.length > 32
        || ocrPages.some((page, index) => index > 0 && page <= ocrPages[index - 1])
      ) {
        contract("PDF OCR pages are invalid");
      }
      parsedExtraction = {
        engine: oneOf(extraction.engine, ["poppler-pdftotext+tesseract"], "PDF extraction engine"),
        mode: oneOf(extraction.mode, ["layout+page-ocr"], "PDF extraction mode"),
        ocrPerformed: oneOf(extraction.ocrPerformed, [true], "PDF OCR state"),
        ocrEngine: oneOf(extraction.ocrEngine, ["tesseract"], "PDF OCR engine"),
        ocrEngineVersion,
        ocrModel: oneOf(extraction.ocrModel, [
          "eng", "Arabic", "Bengali", "Cyrillic", "Devanagari", "Ethiopic", "Greek",
          "Hangul", "HanS", "HanT", "Hebrew", "Japanese", "Latin", "Thai"
        ], "PDF OCR model"),
        ocrPageLimit: oneOf(extraction.ocrPageLimit, [32], "PDF OCR page limit"),
        ocrPages,
        ocrPixelLimit: oneOf(extraction.ocrPixelLimit, [32_000_000], "PDF OCR pixel limit"),
        ocrMaximumDimension: integerBetween(
          extraction.ocrMaximumDimension, 300, 1_600, "PDF OCR maximum dimension"
        ),
        ocrTotalPixels: integerBetween(
          extraction.ocrTotalPixels, 1, 32_000_000, "PDF OCR total pixels"
        ),
        ocrTruncated: boolean(extraction.ocrTruncated, "PDF OCR truncation state"),
        readingOrder: oneOf(extraction.readingOrder, ["heuristic"], "PDF reading order"),
        tagged: boolean(extraction.tagged, "PDF tagged state"),
        textAvailable: boolean(extraction.textAvailable, "PDF text availability")
      };
    } else {
      parsedExtraction = {
        engine: oneOf(extraction.engine, ["poppler-pdftotext"], "PDF extraction engine"),
        mode: oneOf(extraction.mode, ["layout"], "PDF extraction mode"),
        ocrPerformed: oneOf(extraction.ocrPerformed, [false], "PDF OCR state"),
        readingOrder: oneOf(extraction.readingOrder, ["heuristic"], "PDF reading order"),
        tagged: boolean(extraction.tagged, "PDF tagged state"),
        textAvailable: boolean(extraction.textAvailable, "PDF text availability")
      };
    }
    let rendering;
    if (isVisualPdf) {
      const source = object(record.rendering, "PDF visual rendering");
      exactKeys(source, [
        "engine", "mediaType", "annotationsHidden", "colorSpace", "pageCount",
        "targetMaximumDimension", "totalPixels", "totalImageBytes"
      ], "PDF visual rendering");
      rendering = {
        engine: oneOf(source.engine, ["poppler-pdftoppm"], "PDF visual rendering engine"),
        mediaType: oneOf(source.mediaType, ["image/jpeg"], "PDF visual rendering media type"),
        annotationsHidden: oneOf(
          source.annotationsHidden,
          [true],
          "PDF visual rendering annotation policy"
        ),
        colorSpace: oneOf(source.colorSpace, ["rgb"], "PDF visual rendering color space"),
        pageCount: integerBetween(source.pageCount, 1, 200, "PDF visual page count"),
        targetMaximumDimension: integerBetween(
          source.targetMaximumDimension,
          64,
          1_000,
          "PDF visual maximum dimension"
        ),
        totalPixels: integerBetween(
          source.totalPixels,
          1,
          20_000_000,
          "PDF visual total pixels"
        ),
        totalImageBytes: integerBetween(
          source.totalImageBytes,
          1,
          2_400_000,
          "PDF visual total image bytes"
        )
      };
    }
    variant = {
      schemaVersion: oneOf(
        record.schemaVersion,
        [
          "opengeo.document-preview.2.0.0",
          "opengeo.document-preview.3.0.0",
          "opengeo.pdf-visual-presentation.1.0.0",
          "opengeo.pdf-visual-presentation.2.0.0"
        ],
        "document preview schema"
      ),
      sourceFormat: oneOf(record.sourceFormat, ["pdf"], "document preview source format"),
      pdfVersion: oneOf(
        record.pdfVersion,
        ["1.0", "1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "2.0"],
        "PDF version"
      ),
      extraction: parsedExtraction,
      ...(rendering ? {rendering} : {})
    };
  } else {
    contract("document preview schema or source format is invalid");
  }
  const title = record.title === null ? null : documentText(record.title, 300, "document title");
  const language = record.language === null ? null : string(record.language, "document language");
  if (language !== null && !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(language)) {
    contract("document language is invalid");
  }
  let blockTotal = 0;
  let characterTotal = 0;
  let tableCells = 0;
  let visualPixels = 0;
  let visualBytes = 0;
  const pages = parseArray(record.pages, (value, index) => {
    const page = object(value, "document page");
    exactKeys(page, [
      "number",
      ...(isOcrPdf ? ["textSource"] : []),
      ...(isVisualPdf ? ["width", "height", "imageBase64", "imageSha256"] : []),
      "blocks"
    ], "document page");
    const number = integerBetween(page.number, 1, 200, "document page number");
    if (number !== index + 1) contract("document page sequence is invalid");
    const textSource = isOcrPdf
      ? oneOf(page.textSource, ["embedded", "ocr", "none"], "document page text source")
      : undefined;
    let visual;
    if (isVisualPdf) {
      const width = integerBetween(
        page.width,
        1,
        variant.rendering.targetMaximumDimension,
        "PDF visual page width"
      );
      const height = integerBetween(
        page.height,
        1,
        variant.rendering.targetMaximumDimension,
        "PDF visual page height"
      );
      const imageBase64 = documentPreviewJpeg(page.imageBase64);
      visualPixels += width * height;
      visualBytes += decodedBase64Length(imageBase64);
      visual = {
        width,
        height,
        imageBase64,
        imageSha256: sha256Checksum(page.imageSha256, "PDF visual page checksum")
      };
    }
    const blocks = parseArray(page.blocks, (value) => {
      const block = object(value, "document block");
      blockTotal += 1;
      if (blockTotal > 2_000) contract("document preview has too many blocks");
      const type = string(block.type, "document block type");
      if (type === "heading") {
        exactKeys(block, ["type", "level", "text"], "document heading");
        const text = documentText(block.text, 8_000, "document heading text");
        characterTotal += text.length;
        return {
          type,
          level: integerBetween(block.level, 1, 10, "document heading level"),
          text
        };
      }
      if (type === "paragraph") {
        exactKeys(block, ["type", "text"], "document paragraph");
        const text = documentText(block.text, 8_000, "document paragraph text");
        characterTotal += text.length;
        return {type, text};
      }
      if (type === "list") {
        exactKeys(block, ["type", "ordered", "items"], "document list");
        const items = parseArray(
          block.items,
          (item) => documentText(item, 1_000, "document list item"),
          "document list items"
        );
        if (!items.length || items.length > 500) contract("document list is invalid");
        characterTotal += items.reduce((total, item) => total + item.length, 0);
        return {type, ordered: boolean(block.ordered, "document list ordered"), items};
      }
      if (type === "table") {
        const keys = Object.hasOwn(block, "label")
          ? ["type", "label", "headerRows", "rows"]
          : ["type", "headerRows", "rows"];
        exactKeys(block, keys, "document table");
        const rows = parseArray(block.rows, (value) => {
          const row = parseArray(
            value,
            (cell) => documentText(cell, 1_000, "document table cell", true),
            "document table row"
          );
          if (!row.length || row.length > 20) contract("document table row is invalid");
          tableCells += row.length;
          characterTotal += row.reduce((total, cell) => total + cell.length, 0);
          return row;
        }, "document table rows");
        if (!rows.length || rows.length > 200 || rows.some((row) => row.length !== rows[0].length)) {
          contract("document table is invalid");
        }
        const headerRows = integerBetween(block.headerRows, 0, rows.length, "document table header rows");
        return {
          type,
          ...(Object.hasOwn(block, "label")
            ? {label: documentText(block.label, 300, "document table label")}
            : {}),
          headerRows,
          rows
        };
      }
      contract("document block type is invalid");
    }, "document blocks");
    return {
      ...(isOcrPdf ? {textSource} : {}),
      ...(visual ?? {}),
      number,
      blocks
    };
  }, "document pages");
  if (!pages.length || pages.length > 200 || tableCells > 5_000 || characterTotal > 200_000) {
    contract("document preview limits are exceeded");
  }
  if (
    variant.sourceFormat === "pdf"
    && variant.extraction.textAvailable !== (characterTotal > 0)
  ) {
    contract("PDF text availability does not match its content");
  }
  if (isOcrPdf) {
    const ocrPages = pages.filter((page) => page.textSource === "ocr").map((page) => page.number);
    const hasUnprocessedPage = pages.some((page) => page.textSource === "none");
    if (
      JSON.stringify(ocrPages) !== JSON.stringify(variant.extraction.ocrPages)
      || pages.some((page) => page.textSource === "embedded" && !page.blocks.length)
      || pages.some((page) => page.textSource === "none" && page.blocks.length)
      || variant.extraction.ocrTruncated !== hasUnprocessedPage
      || (variant.extraction.ocrTruncated && ocrPages.length !== 32)
    ) {
      contract("PDF OCR page provenance is inconsistent");
    }
  }
  if (isVisualPdf && (
    variant.rendering.pageCount !== pages.length
    || variant.rendering.totalPixels !== visualPixels
    || variant.rendering.totalImageBytes !== visualBytes
  )) {
    contract("PDF visual rendering totals are inconsistent");
  }
  return {
    ...variant,
    title,
    language,
    pages
  };
}

function documentPreviewJpeg(value) {
  const encoded = boundedString(value, 700_000, "PDF visual page image");
  if (
    encoded.length < 4
    || encoded.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    || decodedBase64Length(encoded) > 512 * 1024
    || !encoded.startsWith("/9j/")
  ) {
    contract("PDF visual page image is invalid");
  }
  return encoded;
}

function decodedBase64Length(value) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length / 4 * 3 - padding;
}

function documentText(value, maximum, label, allowEmpty = false) {
  const result = string(value, label);
  if ((!allowEmpty && !result.length) || result.length > maximum || result.includes("\0")) {
    contract(`${label} is invalid`);
  }
  return result;
}

function parseDatasetObject(value) {
  const record = object(value, "dataset object");
  const filename = string(record.filename, "dataset object.filename");
  if (filename.length > 180 || filename.includes("/") || filename.includes("\\")) contract("dataset object.filename is invalid");
  const checksum = string(record.checksum_sha256, "dataset object.checksum_sha256");
  if (!/^[0-9a-f]{64}$/.test(checksum)) contract("dataset object.checksum_sha256 is invalid");
  return {
    id: uuid(record.id, "dataset object.id"),
    role: oneOf(record.role, ["original", "working", "published", "tile", "derived", "thumbnail"], "dataset object.role"),
    filename,
    contentType: string(record.content_type, "dataset object.content_type"),
    sizeBytes: positiveInteger(record.size_bytes, "dataset object.size_bytes"),
    checksumSha256: checksum,
    createdAt: timestamp(record.created_at, "dataset object.created_at")
  };
}

export function parseDatasetPermission(value) {
  const record = object(value, "dataset permission");
  return {
    userId: uuid(record.user_id, "dataset permission.user_id"),
    email: string(record.email, "dataset permission.email"),
    displayName: string(record.display_name, "dataset permission.display_name"),
    role: oneOf(record.role, ["manage", "edit", "view", "download"], "dataset permission.role"),
    grantedBy: uuid(record.granted_by, "dataset permission.granted_by"),
    createdAt: timestamp(record.created_at, "dataset permission.created_at"),
    updatedAt: timestamp(record.updated_at, "dataset permission.updated_at")
  };
}

export function parseDownloadTicket(value) {
  const record = object(value, "download ticket");
  const rawUrl = string(record.url, "download ticket.url");
  let destination;
  try {
    destination = new URL(rawUrl);
  } catch (cause) {
    contract("download ticket.url is invalid", cause);
  }
  const allowed = new Set([
    "X-Amz-Algorithm", "X-Amz-Credential", "X-Amz-Date", "X-Amz-Expires",
    "X-Amz-Security-Token", "X-Amz-SignedHeaders", "X-Amz-Signature",
    "response-content-disposition", "versionId"
  ]);
  const required = [...allowed].filter((name) => name !== "X-Amz-Security-Token");
  if (
    destination.protocol !== "https:"
    || destination.username
    || destination.password
    || destination.port
    || destination.hash
    || !isPathStyleS3Target(destination, {objectRequired: true})
    || [...destination.searchParams.keys()].some((name) => !allowed.has(name))
    || required.some((name) => destination.searchParams.getAll(name).length !== 1)
    || destination.searchParams.getAll("X-Amz-Security-Token").length > 1
    || destination.searchParams.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256"
    || destination.searchParams.get("X-Amz-SignedHeaders") !== "host"
    || !/^[0-9a-f]{64}$/.test(destination.searchParams.get("X-Amz-Signature") ?? "")
    || !destination.searchParams.get("versionId")
    || !destination.searchParams.get("response-content-disposition")?.startsWith("attachment; filename=")
  ) {
    contract("download ticket.url is not an allowed exact-version S3 destination");
  }
  const expires = Number(destination.searchParams.get("X-Amz-Expires"));
  if (!Number.isSafeInteger(expires) || expires < 60 || expires > 900) contract("download ticket.url expiry is invalid");
  return {
    url: destination.href,
    method: oneOf(record.method, ["GET"], "download ticket.method"),
    expiresAt: timestamp(record.expires_at, "download ticket.expires_at")
  };
}

function parseQualityResults(value) {
  const record = object(value, "dataset.quality_results");
  if (record.valid !== undefined && typeof record.valid !== "boolean") {
    contract("dataset.quality_results.valid is invalid");
  }
  return {
    ...structuredClone(record),
    valid: record.valid ?? null,
    checks: parseQualityFindings(record.checks ?? [], "dataset.quality_results.checks"),
    warnings: parseQualityFindings(record.warnings ?? [], "dataset.quality_results.warnings"),
    errors: parseQualityFindings(record.errors ?? [], "dataset.quality_results.errors")
  };
}

function parseQualityFindings(value, label) {
  const findings = parseArray(value, (finding) => {
    const record = object(finding, `${label} entry`);
    if (record.message !== undefined && (typeof record.message !== "string" || record.message.length > 8192)) {
      contract(`${label}.message is invalid`);
    }
    return {
      ...structuredClone(record),
      code: machineCode(record.code, `${label}.code`),
      status: record.status === undefined ? null : string(record.status, `${label}.status`)
    };
  }, label);
  if (findings.length > 256) contract(`${label} is too large`);
  return findings;
}

export function parseUploadTicket(value) {
  const record = object(value, "upload ticket");
  return {
    uploadId: uuid(record.upload_id, "upload ticket.upload_id"),
    dataset: parseDataset(record.dataset),
    expiresAt: timestamp(record.expires_at, "upload ticket.expires_at"),
    upload: parseUploadInstructions(record.upload)
  };
}

export function parsePageSourceUploadTicket(value) {
  const record = object(value, "page source upload ticket");
  return {
    uploadId: uuid(record.upload_id, "page source upload ticket.upload_id"),
    resourceId: uuid(record.resource_id, "page source upload ticket.resource_id"),
    expectedResourceVersion: positiveInteger(
      record.expected_resource_version,
      "page source upload ticket.expected_resource_version"
    ),
    sourceBlockId: pageBlockIdentifier(
      record.source_block_id,
      "page source upload ticket.source_block_id"
    ),
    expiresAt: timestamp(record.expires_at, "page source upload ticket.expires_at"),
    upload: parseUploadInstructions(record.upload)
  };
}

export function parsePageSource(value) {
  const record = object(value, "page source");
  return {
    id: uuid(record.id, "page source.id"),
    resourceId: uuid(record.resource_id, "page source.resource_id"),
    resourceVersionId: uuid(record.resource_version_id, "page source.resource_version_id"),
    resourceVersionNumber: positiveInteger(
      record.resource_version_number,
      "page source.resource_version_number"
    ),
    parentVersionNumber: record.parent_version_number === null
      ? null
      : positiveInteger(record.parent_version_number, "page source.parent_version_number"),
    sourceBlockId: pageBlockIdentifier(record.source_block_id, "page source.source_block_id"),
    bucket: boundedQuery(record.bucket, 63, "page source.bucket"),
    objectKey: boundedQuery(record.object_key, 1024, "page source.object_key"),
    s3VersionId: boundedQuery(record.s3_version_id, 1024, "page source.s3_version_id"),
    etag: boundedQuery(record.etag, 512, "page source.etag"),
    contentType: oneOf(record.content_type, ["text/markdown"], "page source.content_type"),
    sizeBytes: positiveInteger(record.size_bytes, "page source.size_bytes"),
    checksumSha256: sha256Checksum(record.checksum_sha256, "page source.checksum_sha256"),
    dialect: oneOf(record.dialect, ["opengeo-markdown"], "page source.dialect"),
    dialectVersion: semanticVersion(record.dialect_version, "page source.dialect_version"),
    compilerVersion: compilerIdentity(record.compiler_version, "page source.compiler_version"),
    changeSummary: boundedQuery(record.change_summary, 500, "page source.change_summary"),
    createdBy: uuid(record.created_by, "page source.created_by"),
    createdAt: timestamp(record.created_at, "page source.created_at"),
    sourceMarkdown: record.source_markdown === null
      ? null
      : string(record.source_markdown, "page source.source_markdown")
  };
}

export function parsePageVersion(value) {
  const record = object(value, "page version");
  return {
    resource: parseGovernedResource(record.resource),
    source: parsePageSource(record.source)
  };
}

export function parsePageWorkingDraft(value) {
  const record = object(value, "page working draft");
  const metadata = boundedObject(record.metadata, 65_536, "page working draft.metadata");
  const spatialExtent = metadata.spatial_extent === null
    ? null
    : parseArray(
      metadata.spatial_extent,
      (coordinate) => finiteNumber(coordinate, "page working draft metadata extent"),
      "page working draft metadata extent"
    );
  if (spatialExtent !== null && spatialExtent.length !== 4) {
    contract("page working draft metadata extent is invalid");
  }
  const managedProfileId = nullableUuid(
    metadata.managed_profile_id,
    "page working draft metadata.managed_profile_id"
  );
  const managedProfileVersion = metadata.managed_profile_version === null
    ? null
    : positiveInteger(
      metadata.managed_profile_version,
      "page working draft metadata.managed_profile_version"
    );
  if ((managedProfileId === null) !== (managedProfileVersion === null)) {
    contract("page working draft managed metadata profile is incomplete");
  }
  return {
    id: uuid(record.id, "page working draft.id"),
    resourceId: uuid(record.resource_id, "page working draft.resource_id"),
    ownerUserId: uuid(record.owner_user_id, "page working draft.owner_user_id"),
    baseResourceVersion: positiveInteger(
      record.base_resource_version,
      "page working draft.base_resource_version"
    ),
    revisionNumber: positiveInteger(
      record.revision_number,
      "page working draft.revision_number"
    ),
    visibility: oneOf(
      record.visibility,
      ["restricted", "organization"],
      "page working draft.visibility"
    ),
    metadata: {
      title: boundedString(metadata.title, 300, "page working draft metadata.title"),
      abstract: nullableBoundedString(
        metadata.abstract,
        8_000,
        "page working draft metadata.abstract"
      ),
      language: languageTag(metadata.language, "page working draft metadata.language"),
      license: nullableBoundedString(
        metadata.license,
        1_000,
        "page working draft metadata.license"
      ),
      attribution: nullableBoundedString(
        metadata.attribution,
        2_000,
        "page working draft metadata.attribution"
      ),
      keywords: parseArray(
        metadata.keywords,
        (keyword) => boundedString(keyword, 100, "page working draft metadata keyword"),
        "page working draft metadata.keywords"
      ),
      spatialExtent,
      temporalStart: nullableTimestamp(
        metadata.temporal_start,
        "page working draft metadata.temporal_start"
      ),
      temporalEnd: nullableTimestamp(
        metadata.temporal_end,
        "page working draft metadata.temporal_end"
      ),
      profile: boundedString(metadata.profile, 100, "page working draft metadata.profile"),
      extensions: boundedObject(
        metadata.extensions,
        8_192,
        "page working draft metadata.extensions"
      ),
      translations: parseResourceTranslations(metadata.translations),
      managedProfileId,
      managedProfileVersion
    },
    content: parseResourceContent(record.content),
    provenance: boundedObject(record.provenance, 4_096, "page working draft.provenance"),
    sourceBlockId: record.source_block_id === null
      ? null
      : pageBlockIdentifier(record.source_block_id, "page working draft.source_block_id"),
    sourceMarkdown: boundedUtf8String(
      record.source_markdown,
      65_536,
      "page working draft.source_markdown"
    ),
    changeSummary: nullableBoundedString(
      record.change_summary,
      500,
      "page working draft.change_summary"
    ),
    documentChecksumSha256: sha256Checksum(
      record.document_checksum_sha256,
      "page working draft.document_checksum_sha256"
    ),
    createdAt: timestamp(record.created_at, "page working draft.created_at"),
    updatedAt: timestamp(record.updated_at, "page working draft.updated_at")
  };
}

export function parsePagePreview(value) {
  const record = object(value, "page preview");
  exactKeys(
    record,
    ["renderer_version", "content_checksum_sha256", "html", "dependencies"],
    "page preview"
  );
  const rendererVersion = oneOf(
    record.renderer_version,
    ["opengeo-page-renderer-1.1.0"],
    "page preview.renderer_version"
  );
  const html = boundedString(record.html, 131_072, "page preview.html");
  if (
    !html.includes(`data-renderer-version="${rendererVersion}"`)
    || !html.includes("script-src 'none'")
    || /<script\b|<iframe\b|<form\b/i.test(html)
  ) {
    contract("page preview HTML is not the pinned inert document");
  }
  const dependencies = parseArray(record.dependencies, (value) => {
    const dependency = object(value, "page preview dependency");
    exactKeys(
      dependency,
      [
        "block_id", "kind", "resource_id", "resource_version_number", "dataset_id",
        "dataset_version_id", "object_id", "checksum_sha256"
      ],
      "page preview dependency"
    );
    const kind = oneOf(
      dependency.kind,
      ["map", "dataset", "image", "file", "document"],
      "page preview dependency.kind"
    );
    const parsed = {
      blockId: pageBlockIdentifier(dependency.block_id, "page preview dependency.block_id"),
      kind,
      resourceId: nullableUuid(dependency.resource_id, "page preview dependency.resource_id"),
      resourceVersionNumber: dependency.resource_version_number === null
        ? null
        : positiveInteger(
          dependency.resource_version_number,
          "page preview dependency.resource_version_number"
        ),
      datasetId: nullableUuid(dependency.dataset_id, "page preview dependency.dataset_id"),
      datasetVersionId: nullableUuid(
        dependency.dataset_version_id,
        "page preview dependency.dataset_version_id"
      ),
      objectId: nullableUuid(dependency.object_id, "page preview dependency.object_id"),
      checksumSha256: dependency.checksum_sha256 === null
        ? null
        : sha256Checksum(
          dependency.checksum_sha256,
          "page preview dependency.checksum_sha256"
        )
    };
    if (
      (["map", "dataset"].includes(kind)
        && (parsed.resourceId === null || parsed.resourceVersionNumber === null
          || parsed.datasetId !== null || parsed.objectId !== null))
      || (["image", "file", "document"].includes(kind)
        && (parsed.resourceId !== null || parsed.datasetId === null
          || parsed.datasetVersionId === null || parsed.objectId === null
          || parsed.checksumSha256 === null))
    ) {
      contract("page preview dependency shape is inconsistent");
    }
    return parsed;
  }, "page preview.dependencies");
  if (dependencies.length > 24
    || new Set(dependencies.map(({blockId}) => blockId)).size !== dependencies.length) {
    contract("page preview dependencies are invalid");
  }
  return {
    rendererVersion,
    contentChecksumSha256: sha256Checksum(
      record.content_checksum_sha256,
      "page preview.content_checksum_sha256"
    ),
    html,
    dependencies
  };
}

export function parseUploadInstructions(value) {
  const record = object(value, "upload instructions");
  const url = string(record.url, "upload instructions.url");
  let destination;
  try {
    destination = new URL(url);
  } catch (cause) {
    contract("upload instructions.url is invalid", cause);
  }
  if (
    destination.protocol !== "https:"
    || destination.username
    || destination.password
    || destination.port
    || destination.search
    || destination.hash
    || !isPathStyleS3Target(destination, {objectRequired: false})
  ) {
    contract("upload instructions.url is not an allowed S3 destination");
  }
  const method = oneOf(record.method, ["POST"], "upload instructions.method");
  const sourceFields = object(record.fields, "upload instructions.fields");
  const entries = Object.entries(sourceFields);
  if (entries.length < REQUIRED_UPLOAD_FIELDS.length || entries.length > ALLOWED_UPLOAD_FIELDS.size) {
    contract("upload instructions.fields has an invalid size");
  }
  const fields = {};
  for (const [name, fieldValue] of entries) {
    if (!ALLOWED_UPLOAD_FIELDS.has(name)) contract("upload instructions.fields contains an unexpected field");
    const parsed = string(fieldValue, `upload instructions.fields.${name}`);
    if (parsed.length > 4096) contract("upload instructions.fields contains an oversized value");
    fields[name] = parsed;
  }
  for (const required of REQUIRED_UPLOAD_FIELDS) {
    if (!Object.hasOwn(fields, required)) contract(`upload instructions.fields.${required} is missing`);
  }
  return {url: destination.href, method, fields};
}

export function parseUploadCompletion(value) {
  const record = object(value, "upload completion");
  const versionNumber = positiveInteger(record.version_number, "upload completion.version_number");
  return {
    dataset: parseDataset(record.dataset),
    datasetVersionId: uuid(record.dataset_version_id, "upload completion.dataset_version_id"),
    versionNumber,
    processingJobId: uuid(record.processing_job_id, "upload completion.processing_job_id"),
    processingJobState: oneOf(record.processing_job_state, ["queued", "running", "completed", "failed", "cancelled"], "upload completion.processing_job_state")
  };
}

export function parseOrganizationMember(value) {
  const record = object(value, "organization member");
  return {
    userId: uuid(record.user_id, "organization member.user_id"),
    email: string(record.email, "organization member.email"),
    displayName: string(record.display_name, "organization member.display_name"),
    role: oneOf(record.role, ["admin", "member", "guest"], "organization member.role")
  };
}

export function parseProjectMember(value) {
  const record = object(value, "project member");
  return {
    userId: uuid(record.user_id, "project member.user_id"),
    email: string(record.email, "project member.email"),
    displayName: string(record.display_name, "project member.display_name"),
    role: oneOf(record.role, ["owner", "editor", "reviewer", "viewer"], "project member.role")
  };
}

export function parseInvitation(value) {
  const record = object(value, "invitation");
  return {
    id: uuid(record.id, "invitation.id"),
    email: string(record.email, "invitation.email"),
    displayName: string(record.display_name, "invitation.display_name"),
    organizationRole: oneOf(record.organization_role, ["admin", "member", "guest"], "invitation.organization_role"),
    projectId: nullableUuid(record.project_id, "invitation.project_id"),
    projectRole: record.project_role === null
      ? null
      : oneOf(record.project_role, ["owner", "editor", "reviewer", "viewer"], "invitation.project_role"),
    status: oneOf(record.status, ["pending", "accepted", "expired", "revoked"], "invitation.status"),
    expiresAt: timestamp(record.expires_at, "invitation.expires_at"),
    acceptedAt: nullableTimestamp(record.accepted_at, "invitation.accepted_at"),
    revokedAt: nullableTimestamp(record.revoked_at, "invitation.revoked_at"),
    createdAt: timestamp(record.created_at, "invitation.created_at")
  };
}

export function parsePendingInvitation(value) {
  const record = object(value, "pending invitation");
  return {
    invitationId: uuid(record.invitation_id, "pending invitation.invitation_id"),
    organizationId: uuid(record.organization_id, "pending invitation.organization_id"),
    organizationName: string(record.organization_name, "pending invitation.organization_name"),
    projectId: nullableUuid(record.project_id, "pending invitation.project_id"),
    projectName: nullableString(record.project_name, "pending invitation.project_name"),
    organizationRole: oneOf(record.organization_role, ["admin", "member", "guest"], "pending invitation.organization_role"),
    projectRole: record.project_role === null
      ? null
      : oneOf(record.project_role, ["owner", "editor", "reviewer", "viewer"], "pending invitation.project_role"),
    expiresAt: timestamp(record.expires_at, "pending invitation.expires_at"),
    createdAt: timestamp(record.created_at, "pending invitation.created_at")
  };
}

function parseAcceptance(value) {
  const record = object(value, "invitation acceptance");
  return {
    invitationId: uuid(record.invitation_id, "acceptance.invitation_id"),
    organizationId: uuid(record.organization_id, "acceptance.organization_id"),
    projectId: nullableUuid(record.project_id, "acceptance.project_id"),
    organizationRole: oneOf(record.organization_role, ["admin", "member", "guest"], "acceptance.organization_role"),
    projectRole: record.project_role === null
      ? null
      : oneOf(record.project_role, ["owner", "editor", "reviewer", "viewer"], "acceptance.project_role"),
    acceptedAt: timestamp(record.accepted_at, "acceptance.accepted_at")
  };
}

function parseMembershipMutation(value, roles) {
  const record = object(value, "membership mutation");
  return {
    userId: uuid(record.user_id, "membership mutation.user_id"),
    role: oneOf(record.role, roles, "membership mutation.role")
  };
}

function pageQuery(page) {
  return `?${pageParameters(page)}`;
}

function featureCollectionPath(projectId, datasetId) {
  return `${featurePath(projectId, datasetId).replace(/\/features$/, "")}/feature-collection`;
}

function featurePath(projectId, datasetId) {
  return `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}/features`;
}

function fieldFormPath(projectId, datasetId) {
  return `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}/field-forms`;
}

function fieldSubmissionPath(projectId, datasetId) {
  return `/projects/${pathUuid(projectId, "project id")}/datasets/${pathUuid(datasetId, "dataset id")}/field-submissions`;
}

function featureQuery({bbox = null, limit = 20, offset = 0} = {}) {
  const parameters = pageParameters({limit, offset});
  if (bbox !== null) {
    const value = serializeBbox(bbox);
    const [minimumX, minimumY, maximumX, maximumY] = bbox;
    if (minimumX === maximumX || minimumY === maximumY) {
      throw new TypeError("feature bbox must have positive area");
    }
    parameters.set("bbox", value);
  }
  return `?${parameters}`;
}

function parseFeatureField(value, label, {depth = 0, state = {count: 0}} = {}) {
  state.count += 1;
  if (state.count > 64) contract("feature schema exceeds 64 fields across all groups");
  const field = object(value, label);
  const type = oneOf(
    field.type,
    ["string", "integer", "number", "boolean", "group"],
    `${label}.type`
  );
  const parsed = {
    name: boundedString(field.name, 100, `${label}.name`),
    type,
    required: boolean(field.required, `${label}.required`),
    label: field.label === undefined || field.label === null
      ? null
      : boundedString(field.label, 100, `${label}.label`).trim(),
    description: field.description === undefined || field.description === null
      ? null
      : boundedString(field.description, 500, `${label}.description`).trim(),
    choices: field.choices === undefined
      ? []
      : parseArray(
          field.choices,
          (choice) => boundedString(choice, 200, `${label}.choice`).trim(),
          `${label}.choices`
        ),
    minimum: field.minimum === undefined || field.minimum === null
      ? null
      : finiteNumber(field.minimum, `${label}.minimum`),
    maximum: field.maximum === undefined || field.maximum === null
      ? null
      : finiteNumber(field.maximum, `${label}.maximum`),
    minLength: field.min_length === undefined || field.min_length === null
      ? null
      : positiveInteger(field.min_length, `${label}.min_length`),
    maxLength: field.max_length === undefined || field.max_length === null
      ? null
      : positiveInteger(field.max_length, `${label}.max_length`),
    ...(field.attachment === undefined ? {} : {attachment: boolean(field.attachment, `${label}.attachment`)}),
    ...(field.calculation == null ? {} : {calculation: field.calculation}),
    visibleWhen: parseFeatureFieldCondition(field.visible_when, `${label}.visible_when`),
    fields: [],
    repeat: field.repeat === undefined ? false : boolean(field.repeat, `${label}.repeat`),
    minItems: field.min_items === undefined || field.min_items === null
      ? null
      : integerBetween(field.min_items, 0, 20, `${label}.min_items`),
    maxItems: field.max_items === undefined || field.max_items === null
      ? null
      : integerBetween(field.max_items, 1, 20, `${label}.max_items`)
  };
  if (type === "group") {
    if (depth >= 3) contract(`${label} exceeds three nested group levels`);
    parsed.fields = parseArray(
      field.fields,
      (item) => parseFeatureField(item, `${label}.field`, {depth: depth + 1, state}),
      `${label}.fields`
    );
    if (!parsed.fields.length) contract(`${label}.fields must not be empty`);
  } else if (
    (field.fields !== undefined && parseArray(field.fields, (item) => item, `${label}.fields`).length)
    || parsed.repeat
    || parsed.minItems !== null
    || parsed.maxItems !== null
  ) {
    contract(`${label} scalar field has group rules`);
  }
  if (parsed.label === "" || parsed.description === "" || parsed.choices.includes("")) {
    contract(`${label} text rules are invalid`);
  }
  if (parsed.choices.length > 32 || new Set(parsed.choices).size !== parsed.choices.length) {
    contract(`${label}.choices is invalid`);
  }
  if (
    (parsed.minLength !== null && parsed.minLength > 2_000)
    || (parsed.maxLength !== null && parsed.maxLength > 2_000)
    || (
      parsed.minLength !== null
      && parsed.maxLength !== null
      && parsed.minLength > parsed.maxLength
    )
  ) contract(`${label} string bounds are invalid`);
  if (parsed.minimum !== null && parsed.maximum !== null && parsed.minimum > parsed.maximum) {
    contract(`${label} numeric bounds are invalid`);
  }
  if (type === "group") {
    if (
      parsed.choices.length
      || parsed.minimum !== null
      || parsed.maximum !== null
      || parsed.minLength !== null
      || parsed.maxLength !== null
    ) contract(`${label} group field has scalar rules`);
    if (!parsed.repeat && (parsed.minItems !== null || parsed.maxItems !== null)) {
      contract(`${label} non-repeating group has item bounds`);
    }
    if (parsed.repeat) {
      parsed.minItems ??= 0;
      parsed.maxItems ??= 20;
      if (parsed.minItems > parsed.maxItems) contract(`${label} repeat bounds are invalid`);
    }
  } else if (type === "string") {
    if (parsed.minimum !== null || parsed.maximum !== null) {
      contract(`${label} string field has numeric bounds`);
    }
    const minimumLength = parsed.minLength ?? 1;
    const maximumLength = parsed.maxLength ?? 2_000;
    if (parsed.choices.some((choice) => (
      choice.length < minimumLength || choice.length > maximumLength
    ))) contract(`${label}.choice violates string bounds`);
  } else if (type === "integer" || type === "number") {
    if (parsed.choices.length || parsed.minLength !== null || parsed.maxLength !== null) {
      contract(`${label} numeric field has string rules`);
    }
    if (type === "integer" && [parsed.minimum, parsed.maximum].some((bound) => (
      bound !== null && !Number.isSafeInteger(bound)
    ))) contract(`${label} integer bounds are invalid`);
  } else if (
    parsed.choices.length
    || parsed.minimum !== null
    || parsed.maximum !== null
    || parsed.minLength !== null
    || parsed.maxLength !== null
  ) {
    contract(`${label} boolean field has value rules`);
  }
  if (type !== "group") {
    delete parsed.fields;
    delete parsed.repeat;
    delete parsed.minItems;
    delete parsed.maxItems;
  }
  return parsed;
}

function parseFeatureFieldCondition(value, label) {
  if (value === undefined || value === null) return null;
  const condition = object(value, label);
  if (
    Object.keys(condition).some((key) => !["field", "equals", "operator", "value_field"].includes(key))
    || !Object.hasOwn(condition, "field")
    || Object.hasOwn(condition, "equals") === Object.hasOwn(condition, "value_field")
  ) contract(`${label} requires field and exactly one of equals or value_field`);
  const operator = condition.operator === undefined ? "eq" : condition.operator;
  if (!["eq", "ne", "gt", "gte", "lt", "lte"].includes(operator)) {
    contract(`${label}.operator is invalid`);
  }
  if (Object.hasOwn(condition, "value_field")) {
    return {
      field: boundedString(condition.field, 100, `${label}.field`),
      value_field: boundedString(condition.value_field, 100, `${label}.value_field`),
      ...(operator === "eq" ? {} : {operator})
    };
  }
  const equals = condition.equals;
  if (
    !["string", "number", "boolean"].includes(typeof equals)
    || (typeof equals === "string" && (!equals || equals.length > 2_000))
    || (typeof equals === "number" && !Number.isFinite(equals))
  ) contract(`${label}.equals is invalid`);
  return {
    field: boundedString(condition.field, 100, `${label}.field`),
    equals,
    ...(operator === "eq" ? {} : {operator})
  };
}

function validateFeatureFieldConditions(fields, label) {
  const prior = new Map();
  for (const field of fields) {
    if (field.attachment && (field.type !== "string" || field.choices.length
        || field.minLength !== null || field.maxLength !== null)) {
      contract(`${label} attachment requires string without choice or length rules`);
    }
    if (field.calculation != null) {
      if (!["integer", "number"].includes(field.type)) contract(`${label} calculated field must be numeric`);
      try {
        field.calculation = validateCalculation(field.calculation,
          new Set([...prior.values()].filter(item => ["integer", "number"].includes(item.type)).map(item => item.name)));
      } catch (error) { contract(`${label}: ${error.message}`); }
    }
    if (field.visibleWhen !== null) {
      const controller = prior.get(field.visibleWhen.field);
      if (!controller) contract(`${label} visibility rule must reference an earlier field`);
      if (controller.type === "group") contract(`${label} visibility controller must be scalar`);
      if (!["eq", "ne"].includes(field.visibleWhen.operator ?? "eq")
          && !["integer", "number"].includes(controller.type)) {
        contract(`${label} ordered visibility comparison requires a numeric field`);
      }
      if (field.visibleWhen.value_field !== undefined) {
        const other = prior.get(field.visibleWhen.value_field);
        if (!other || other.type === "group") {
          contract(`${label} value_field must reference an earlier scalar field`);
        }
        if (other.type !== controller.type
            && ![other.type, controller.type].every((type) => ["integer", "number"].includes(type))) {
          contract(`${label} comparison fields must have compatible types`);
        }
      } else {
        const value = field.visibleWhen.equals;
        if (
          (controller.type === "string" && typeof value !== "string")
          || (controller.type === "boolean" && typeof value !== "boolean")
          || (controller.type === "integer" && !Number.isSafeInteger(value))
          || (
            controller.type === "number"
            && (typeof value !== "number" || !Number.isFinite(value))
          )
        ) contract(`${label} visibility rule value has the wrong type`);
        if (
          controller.type === "string"
          && (
            value.length < (controller.minLength ?? 1)
            || value.length > (controller.maxLength ?? 2_000)
            || (controller.choices.length && !controller.choices.includes(value))
          )
        ) contract(`${label} visibility rule value violates its controller rules`);
        if (
          ["integer", "number"].includes(controller.type)
          && (
            (controller.minimum !== null && value < controller.minimum)
            || (controller.maximum !== null && value > controller.maximum)
          )
        ) contract(`${label} visibility rule value violates its controller rules`);
    }
    }
    if (field.type === "group") validateFeatureFieldConditions(field.fields, `${label}.${field.name}`);
    prior.set(field.name, field);
  }
  return fields;
}

function parseFeatureFields(value, label) {
  const state = {count: 0};
  return validateFeatureFieldConditions(
    parseArray(
      value,
      (item) => parseFeatureField(item, "feature field", {depth: 0, state}),
      label
    ),
    label
  );
}

function serializeFeatureField(value) {
  const field = object(value, "feature field");
  const parsed = parseFeatureField({
    name: field.name,
    type: field.type,
    required: field.required === undefined ? false : field.required,
    ...(field.label === undefined ? {} : {label: field.label}),
    ...(field.description === undefined ? {} : {description: field.description}),
    ...(field.choices === undefined ? {} : {choices: field.choices}),
    ...(field.minimum === undefined ? {} : {minimum: field.minimum}),
    ...(field.maximum === undefined ? {} : {maximum: field.maximum}),
    ...(field.minLength === undefined ? {} : {min_length: field.minLength}),
    ...(field.maxLength === undefined ? {} : {max_length: field.maxLength}),
    ...(field.calculation == null ? {} : {calculation: field.calculation}),
    ...(field.attachment === undefined ? {} : {attachment: field.attachment}),
    ...(field.visibleWhen === undefined ? {} : {visible_when: field.visibleWhen}),
    ...(field.fields === undefined ? {} : {fields: field.fields.map(serializeFeatureField)}),
    ...(field.repeat === undefined ? {} : {repeat: field.repeat}),
    ...(field.minItems === undefined ? {} : {min_items: field.minItems}),
    ...(field.maxItems === undefined ? {} : {max_items: field.maxItems})
  }, "feature field");
  return {
    name: parsed.name,
    type: parsed.type,
    required: parsed.required,
    ...(parsed.label === null ? {} : {label: parsed.label}),
    ...(parsed.description === null ? {} : {description: parsed.description}),
    ...(parsed.choices.length ? {choices: parsed.choices} : {}),
    ...(parsed.minimum === null ? {} : {minimum: parsed.minimum}),
    ...(parsed.maximum === null ? {} : {maximum: parsed.maximum}),
    ...(parsed.minLength === null ? {} : {min_length: parsed.minLength}),
    ...(parsed.maxLength === null ? {} : {max_length: parsed.maxLength}),
    ...(parsed.attachment ? {attachment: true} : {}),
    ...(parsed.calculation == null ? {} : {calculation: parsed.calculation}),
    ...(parsed.visibleWhen === null ? {} : {visible_when: parsed.visibleWhen}),
    ...(parsed.type === "group" ? {fields: parsed.fields.map(serializeFeatureField)} : {}),
    ...(parsed.type === "group" && parsed.repeat ? {
      repeat: true,
      min_items: parsed.minItems,
      max_items: parsed.maxItems
    } : {})
  };
}

function serializeFeatureFields(values) {
  const serialized = values.map(serializeFeatureField);
  const parsed = validateFeatureFieldConditions(
    serialized.map((field) => parseFeatureField(field, "feature field")),
    "feature fields"
  );
  return serialized.map((field, index) => ({
    ...field,
    ...(parsed[index].visibleWhen === null
      ? {}
      : {visible_when: parsed[index].visibleWhen})
  }));
}

function serializeFeature(value) {
  const feature = object(value, "feature");
  const geometry = boundedObject(feature.geometry, 262_144, "feature.geometry");
  featureGeometryType(geometry.type, "feature.geometry.type");
  const properties = boundedObject(feature.properties ?? {}, 32_768, "feature.properties");
  return {
    type: "Feature",
    ...(feature.id === undefined || feature.id === null
      ? {}
      : {id: assertUuid(feature.id, "feature id")}),
    geometry,
    properties
  };
}

function featureGeometryType(value, label) {
  return oneOf(
    value,
    ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"],
    label
  );
}

function datasetQuery({
  bbox = null,
  placeUri = null,
  query = null,
  ownerUserId = null,
  tag = null,
  geometryType = null,
  format = null,
  classification = null,
  sourceType = null,
  updatedAfter = null,
  updatedBefore = null,
  clientId = null,
  projectId = null,
  ...page
} = {}) {
  const parameters = pageParameters(page);
  const values = {
    bbox: serializeDatasetBbox(bbox),
    place_uri: placeUri === null ? null : boundedQuery(placeUri, 2048, "place identity"),
    query: boundedQuery(query, 200, "query"),
    owner_user_id: ownerUserId === null ? null : assertUuid(ownerUserId, "owner user id"),
    tag: boundedQuery(tag, 64, "tag")?.toLowerCase() ?? null,
    geometry_type: boundedQuery(geometryType, 100, "geometry type"),
    format: optionalOneOf(format, ["geojson", "csv", "shapefile", "geopackage", "geoparquet", "cog", "pmtiles", "png", "jpeg", "pdf", "odt", "kml", "xyz", "wms", "arcgis", "wfs", "imageserver", "mapserver"], "format"),
    classification: optionalOneOf(classification, ["public", "internal", "confidential", "restricted"], "classification"),
    source_type: optionalOneOf(
      sourceType,
      ["upload", "repository", "xyz", "wms", "pmtiles", "geojson", "arcgis", "wfs", "imageserver", "mapserver"],
      "source type"
    ),
    updated_after: optionalTimestamp(updatedAfter, "updated after"),
    updated_before: optionalTimestamp(updatedBefore, "updated before"),
    client_id: clientId === null ? null : assertUuid(clientId, "client id"),
    project_id: projectId === null ? null : assertUuid(projectId, "project id")
  };
  for (const [name, item] of Object.entries(values)) if (item !== null) parameters.set(name, item);
  return `?${parameters}`;
}

function resourceQuery({
  query = null,
  kind = null,
  visibility = null,
  state = null,
  bbox = null,
  temporalStart = null,
  temporalEnd = null,
  ...page
} = {}) {
  const parameters = pageParameters(page);
  const values = {
    query: boundedQuery(query, 200, "resource query"),
    kind: optionalOneOf(kind, ["dataset", "map", "document", "story", "dashboard", "service"], "resource kind"),
    visibility: optionalOneOf(visibility, ["restricted", "organization", "public"], "resource visibility"),
    state: optionalOneOf(state, ["draft", "review", "published", "archived"], "resource state"),
    bbox: serializeBbox(bbox),
    temporal_start: optionalTimestamp(temporalStart, "resource temporal start"),
    temporal_end: optionalTimestamp(temporalEnd, "resource temporal end")
  };
  for (const [name, item] of Object.entries(values)) if (item !== null) parameters.set(name, item);
  return `?${parameters}`;
}

function publicCatalogQuery({
  query = null,
  kind = null,
  projectId = null,
  keyword = null,
  license = null,
  originNamespace = null,
  bbox = null,
  temporalStart = null,
  temporalEnd = null,
  limit = 24,
  offset = 0
} = {}) {
  const parameters = pageParameters({limit, offset});
  const values = {
    query: boundedQuery(query, 200, "public catalog query"),
    kind: optionalOneOf(
      kind,
      ["dataset", "map", "document", "story", "dashboard", "service"],
      "public catalog kind"
    ),
    project_id: projectId === null ? null : assertUuid(projectId, "public catalog project id"),
    keyword: boundedQuery(keyword, 100, "public catalog keyword"),
    license: boundedQuery(license, 200, "public catalog license"),
    origin_namespace: boundedQuery(originNamespace, 64, "public catalog origin namespace"),
    bbox: serializeBbox(bbox),
    temporal_start: optionalTimestamp(temporalStart, "public catalog temporal start"),
    temporal_end: optionalTimestamp(temporalEnd, "public catalog temporal end")
  };
  if (values.origin_namespace !== null
    && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(values.origin_namespace)) {
    throw new TypeError("public catalog origin namespace is invalid");
  }
  for (const [name, item] of Object.entries(values)) {
    if (item !== null) parameters.set(name, item);
  }
  return `?${parameters}`;
}

function recordQuery({
  query = null,
  types = [],
  ids = [],
  externalIds = [],
  bbox = null,
  datetime = null,
  language = null,
  limit = 10,
  offset = 0
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw new TypeError("record limit is invalid");
  }
  if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("record offset is invalid");
  const parameters = new URLSearchParams({limit: String(limit), offset: String(offset)});
  const textQuery = boundedQuery(query, 1_000, "record query");
  if (textQuery !== null) parameters.set("q", textQuery);
  const kinds = Array.isArray(types) ? types : [types];
  if (kinds.length) {
    parameters.set("type", kinds.map((kind) => oneOf(
      kind,
      ["dataset", "map", "document", "story", "dashboard", "service"],
      "record type"
    )).join(","));
  }
  if (!Array.isArray(ids) || ids.length > 50) throw new TypeError("record ids are invalid");
  if (ids.length) parameters.set("ids", ids.map((id) => assertUuid(id, "record id")).join(","));
  if (!Array.isArray(externalIds) || externalIds.length > 50) {
    throw new TypeError("record external ids are invalid");
  }
  if (externalIds.length) {
    parameters.set("externalIds", externalIds.map((id) => {
      const value = String(id).trim();
      if (!value || value.length > 500 || value.includes(",")) {
        throw new TypeError("record external id is invalid");
      }
      return value;
    }).join(","));
  }
  const extent = serializeBbox(bbox);
  if (extent !== null) parameters.set("bbox", extent);
  if (datetime !== null) {
    const value = String(datetime).trim();
    if (!value || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new TypeError("record datetime is invalid");
    }
    parameters.set("datetime", value);
  }
  if (language !== null) parameters.set("language", languageTag(language, "record language"));
  return `?${parameters}`;
}

function serializeResourceDraft(record) {
  if (record.expectedMapVersion !== undefined && record.kind !== "map") {
    throw new TypeError("expectedMapVersion is valid only for map resources");
  }
  return {
    kind: record.kind,
    slug: record.slug,
    dataset_id: record.datasetId ?? null,
    map_id: record.mapId ?? null,
    ...serializeExpectedMapVersion(record),
    visibility: record.visibility ?? "restricted",
    metadata: serializeResourceMetadata(record.metadata),
    content: serializeResourceContent(record.content ?? {blocks: []}),
    provenance: record.provenance ?? {}
  };
}

function serializeExpectedMapVersion(record) {
  if (record.expectedMapVersion === undefined) return {};
  if (!Number.isSafeInteger(record.expectedMapVersion) || record.expectedMapVersion < 1) {
    throw new TypeError("resource expectedMapVersion must be a positive safe integer");
  }
  return {expected_map_version: record.expectedMapVersion};
}

function serializeResourceMetadata(value) {
  const record = object(value, "resource metadata");
  return {
    title: record.title,
    abstract: record.abstract ?? null,
    language: record.language ?? "en",
    license: record.license ?? null,
    attribution: record.attribution ?? null,
    keywords: record.keywords ?? [],
    spatial_extent: record.spatialExtent ?? null,
    temporal_start: record.temporalStart ?? null,
    temporal_end: record.temporalEnd ?? null,
    profile: record.profile ?? "opengeo.core.v1",
    extensions: record.extensions ?? {},
    translations: serializeResourceTranslations(record.translations ?? {}),
    managed_profile_id: record.managedProfileId ?? null,
    managed_profile_version: record.managedProfileVersion ?? null
  };
}

function serializeResourceTranslations(value) {
  const translations = parseResourceTranslations(value);
  return structuredClone(translations);
}

function serializeSiteDraft(value, {includeSlug = false} = {}) {
  const record = object(value, "site draft");
  if (!Array.isArray(record.pages) || !record.pages.length || record.pages.length > 64) {
    throw new TypeError("site pages must contain one to 64 entries");
  }
  const pages = record.pages.map((value) => {
    const page = object(value, "site page");
    return {
      slug: siteSlug(page.slug, "site page slug"),
      navigation_label: boundedQuery(
        page.navigationLabel,
        120,
        "site page navigation label"
      ),
      resource_id: assertUuid(page.resourceId, "site page resource id"),
      resource_version: positiveInteger(page.resourceVersion, "site page resource version"),
      is_home: boolean(page.isHome ?? false, "site page home flag")
    };
  });
  if (pages.filter((page) => page.is_home).length !== 1) {
    throw new TypeError("exactly one site page must be home");
  }
  if (new Set(pages.map((page) => page.slug)).size !== pages.length) {
    throw new TypeError("site page slugs must be unique");
  }
  if (new Set(pages.map((page) => page.resource_id)).size !== pages.length) {
    throw new TypeError("site page resources must be unique");
  }
  const rawOptions = object(record.themeOptions ?? {}, "site theme options");
  const unknown = Object.keys(rawOptions).filter(
    (key) => ![
      "accentColor",
      "footerText",
      "printPageSize",
      "printOrientation",
      "printLayout",
      "printLegend",
      "printNorthArrow",
      "printScaleBar"
    ].includes(key)
  );
  if (unknown.length) throw new TypeError(`unknown site theme option ${unknown[0]}`);
  const themeOptions = {};
  if (Object.hasOwn(rawOptions, "accentColor")) {
    if (typeof rawOptions.accentColor !== "string"
      || !/^#[0-9a-f]{6}$/i.test(rawOptions.accentColor)) {
      throw new TypeError("site accent color is invalid");
    }
    themeOptions.accentColor = rawOptions.accentColor;
  }
  if (Object.hasOwn(rawOptions, "footerText")) {
    themeOptions.footerText = boundedQuery(rawOptions.footerText, 500, "site footer text");
  }
  const printEnums = {
    printPageSize: ["letter", "legal", "tabloid", "a4", "a3", "a2", "a1", "a0"],
    printOrientation: ["portrait", "landscape"],
    printLayout: ["flow", "map-sheet"],
    printLegend: ["true", "false"],
    printNorthArrow: ["true", "false"],
    printScaleBar: ["true", "false"]
  };
  for (const [key, values] of Object.entries(printEnums)) {
    if (Object.hasOwn(rawOptions, key)) {
      themeOptions[key] = oneOf(rawOptions[key], values, `site ${key}`);
    }
  }
  return {
    ...(includeSlug ? {slug: siteSlug(record.slug, "site slug")} : {}),
    title: boundedQuery(record.title, 300, "site title"),
    description: record.description === null || record.description === undefined
      ? null
      : boundedQuery(record.description, 4_000, "site description"),
    language: languageTag(record.language ?? "en", "site language"),
    theme: oneOf(record.theme ?? "paper", ["paper", "atlas", "minimal"], "site theme"),
    theme_options: themeOptions,
    print_layout: parseSitePrintLayout(
      record.printLayout ?? {schemaVersion: "opengeo.print-layout.1.1.0", pages: []},
      new Set(pages.map((page) => page.slug))
    ),
    pages
  };
}

function serializeDatasetBbox(value) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 4 || value.some(item => typeof item !== "number" || !Number.isFinite(item))) throw new TypeError("Catalog bounds must contain four numbers.");
  const [west,south,east,north] = value;
  if (west < -180 || west > 180 || east < -180 || east > 180 || south < -90 || north > 90 || south > north) throw new TypeError("Catalog bounds are outside longitude/latitude limits.");
  return value.join(",");
}

function serializeBbox(value) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 4 || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new TypeError("resource bbox is invalid");
  }
  const [minX, minY, maxX, maxY] = value;
  if (minX < -180 || maxX > 180 || minY < -90 || maxY > 90 || minX > maxX || minY > maxY) {
    throw new TypeError("resource bbox is invalid");
  }
  return value.join(",");
}

function parseResourceContent(value) {
  const record = boundedObject(value, 16_384, "resource.content");
  exactKeys(record, ["blocks"], "resource.content");
  const blocks = parseArray(record.blocks, (value) => {
    const block = object(value, "resource content block");
    const type = oneOf(block.type, ["markdown", "heading", "callout", "navigation", "map", "dataset", "link", "citation", "table", "chart", "image", "file", "document", "preserved"], "resource content block.type");
    const id = boundedString(block.id, 100, "resource content block.id");
    if (type === "markdown") {
      exactKeys(block, ["id", "type", "markdown"], "markdown block");
      return {id, type, markdown: boundedString(block.markdown, 8_000, "markdown block.markdown")};
    }
    if (type === "heading") {
      exactKeys(block, ["id", "type", "level", "text"], "heading block");
      return {
        id,
        type,
        level: integerBetween(block.level, 2, 4, "heading block.level"),
        text: boundedString(block.text, 300, "heading block.text")
      };
    }
    if (type === "callout") {
      exactKeys(block, ["id", "type", "tone", "title", "markdown"], "callout block");
      return {
        id,
        type,
        tone: oneOf(block.tone, ["note", "tip", "warning", "important"], "callout block.tone"),
        title: boundedString(block.title, 300, "callout block.title"),
        markdown: boundedString(block.markdown, 2_000, "callout block.markdown")
      };
    }
    if (type === "navigation") {
      exactKeys(block, ["id", "type", "label", "heading_block_ids"], "navigation block");
      return {
        id,
        type,
        label: boundedString(block.label, 300, "navigation block.label"),
        headingBlockIds: parseHeadingBlockIds(block.heading_block_ids)
      };
    }
    if (type === "map" || type === "dataset") {
      const expected = ["id", "type", "resource_id"];
      if (block.resource_version_number !== undefined) expected.push("resource_version_number");
      if (block.caption !== undefined) expected.push("caption");
      exactKeys(block, expected, "resource reference block");
      return {
        id,
        type,
        resourceId: uuid(block.resource_id, "resource reference block.resource_id"),
        resourceVersionNumber: block.resource_version_number === undefined
          ? null
          : positiveInteger(
            block.resource_version_number,
            "resource reference block.resource_version_number"
          ),
        caption: block.caption === undefined ? null : nullableBoundedString(block.caption, 300, "resource reference block.caption")
      };
    }
    if (type === "link") {
      exactKeys(block, ["id", "type", "url", "label"], "resource link block");
      return {id, type, url: publicSourceUrl(block.url, "resource"), label: boundedString(block.label, 300, "resource link block.label")};
    }
    if (type === "citation") {
      exactKeys(block, ["id", "type", "title", "doi", "url"].filter((key) => block[key] !== undefined), "resource citation block");
      return {
        id,
        type,
        title: boundedString(block.title, 300, "resource citation block.title"),
        doi: block.doi === undefined ? null : nullableBoundedString(block.doi, 200, "resource citation block.doi"),
        url: block.url === undefined || block.url === null ? null : publicSourceUrl(block.url, "resource")
      };
    }
    if (type === "table") {
      exactKeys(block, ["id", "type", "caption", "columns", "rows"], "resource table block");
      return parseTableBlock({id, type, ...block});
    }
    if (type === "chart") {
      exactKeys(
        block,
        ["id", "type", "chart_type", "title", "alt_text", "table_block_id", "x_column", "y_columns"],
        "resource chart block"
      );
      return {
        id,
        type,
        chartType: oneOf(block.chart_type, ["bar", "line"], "chart block.chart_type"),
        title: boundedString(block.title, 300, "chart block.title"),
        altText: boundedString(block.alt_text, 1_000, "chart block.alt_text"),
        tableBlockId: boundedString(block.table_block_id, 100, "chart block.table_block_id"),
        xColumn: boundedString(block.x_column, 300, "chart block.x_column"),
        yColumns: parseChartColumns(block.y_columns)
      };
    }
    if (type === "image") {
      exactKeys(
        block,
        ["id", "type", "dataset_id", "dataset_version_id", "object_id", "alt_text", "caption"]
          .filter((key) => block[key] !== undefined),
        "resource image block"
      );
      return {
        id,
        type,
        datasetId: uuid(block.dataset_id, "image block.dataset_id"),
        datasetVersionId: uuid(block.dataset_version_id, "image block.dataset_version_id"),
        objectId: uuid(block.object_id, "image block.object_id"),
        altText: boundedString(block.alt_text, 1_000, "image block.alt_text"),
        caption: block.caption === undefined
          ? null
          : nullableBoundedString(block.caption, 300, "image block.caption")
      };
    }
    if (type === "file") {
      exactKeys(
        block,
        ["id", "type", "dataset_id", "dataset_version_id", "object_id", "label", "description"]
          .filter((key) => block[key] !== undefined),
        "resource file block"
      );
      return {
        id,
        type,
        datasetId: uuid(block.dataset_id, "file block.dataset_id"),
        datasetVersionId: uuid(block.dataset_version_id, "file block.dataset_version_id"),
        objectId: uuid(block.object_id, "file block.object_id"),
        label: boundedString(block.label, 300, "file block.label"),
        description: block.description === undefined
          ? null
          : nullableBoundedString(block.description, 1_000, "file block.description")
      };
    }
    if (type === "document") {
      exactKeys(
        block,
        ["id", "type", "dataset_id", "dataset_version_id", "object_id", "label"],
        "resource document block"
      );
      return {
        id,
        type,
        datasetId: uuid(block.dataset_id, "document block.dataset_id"),
        datasetVersionId: uuid(block.dataset_version_id, "document block.dataset_version_id"),
        objectId: uuid(block.object_id, "document block.object_id"),
        label: boundedString(block.label, 300, "document block.label")
      };
    }
    exactKeys(block, ["id", "type", "namespace", "label"], "preserved resource block");
    return {
      id,
      type,
      namespace: boundedString(block.namespace, 100, "preserved block.namespace"),
      label: boundedString(block.label, 300, "preserved block.label")
    };
  }, "resource.content.blocks");
  if (blocks.length > 24 || new Set(blocks.map((block) => block.id)).size !== blocks.length) {
    contract("resource.content.blocks is invalid");
  }
  validateParsedCharts(blocks);
  validateParsedStructure(blocks);
  return {blocks};
}

function serializeResourceContent(value) {
  const record = object(value, "resource content");
  exactKeys(record, ["blocks"], "resource content");
  if (!Array.isArray(record.blocks) || record.blocks.length > 24) {
    throw new TypeError("resource content blocks are invalid");
  }
  const ids = new Set();
  const result = record.blocks.map((value) => {
    const block = object(value, "resource content block");
    const type = oneOf(
      block.type,
      ["markdown", "heading", "callout", "navigation", "map", "dataset", "link", "citation", "table", "chart", "image", "file", "document", "preserved"],
      "resource content block.type"
    );
    const id = contentBlockId(block.id);
    if (ids.has(id)) throw new TypeError("resource content block ids must be unique");
    ids.add(id);
    if (type === "markdown") {
      exactKeys(block, ["id", "type", "markdown"], "markdown block");
      return {id, type, markdown: boundedString(block.markdown, 8_000, "markdown block.markdown")};
    }
    if (type === "heading") {
      exactKeys(block, ["id", "type", "level", "text"], "heading block");
      return {
        id,
        type,
        level: integerBetween(block.level, 2, 4, "heading block.level"),
        text: boundedString(block.text, 300, "heading block.text")
      };
    }
    if (type === "callout") {
      exactKeys(block, ["id", "type", "tone", "title", "markdown"], "callout block");
      return {
        id,
        type,
        tone: oneOf(block.tone, ["note", "tip", "warning", "important"], "callout block.tone"),
        title: boundedString(block.title, 300, "callout block.title"),
        markdown: boundedString(block.markdown, 2_000, "callout block.markdown")
      };
    }
    if (type === "navigation") {
      exactKeys(block, ["id", "type", "label", "headingBlockIds"], "navigation block");
      return {
        id,
        type,
        label: boundedString(block.label, 300, "navigation block.label"),
        heading_block_ids: parseHeadingBlockIds(block.headingBlockIds)
      };
    }
    if (type === "map" || type === "dataset") {
      exactKeys(
        block,
        ["id", "type", "resourceId", "resourceVersionNumber", "caption"]
          .filter((key) => block[key] !== undefined),
        "resource reference block"
      );
      return {
        id,
        type,
        resource_id: assertUuid(block.resourceId, "resource reference block.resourceId"),
        ...(block.resourceVersionNumber === undefined || block.resourceVersionNumber === null
          ? {}
          : {
            resource_version_number: positiveInteger(
              block.resourceVersionNumber,
              "resource reference block.resourceVersionNumber"
            )
          }),
        ...(block.caption === undefined || block.caption === null
          ? {}
          : {caption: boundedString(block.caption, 300, "resource reference block.caption")})
      };
    }
    if (type === "link") {
      exactKeys(block, ["id", "type", "url", "label"], "resource link block");
      return {
        id,
        type,
        url: publicSourceUrl(block.url, "resource"),
        label: boundedString(block.label, 300, "resource link block.label")
      };
    }
    if (type === "citation") {
      exactKeys(
        block,
        ["id", "type", "title", "doi", "url"].filter((key) => block[key] !== undefined),
        "resource citation block"
      );
      const doi = block.doi === undefined || block.doi === null
        ? null
        : boundedString(block.doi, 200, "resource citation block.doi");
      const url = block.url === undefined || block.url === null
        ? null
        : publicSourceUrl(block.url, "resource");
      if (doi === null && url === null) throw new TypeError("citation requires a DOI or URL");
      return {
        id,
        type,
        title: boundedString(block.title, 300, "resource citation block.title"),
        doi,
        url
      };
    }
    if (type === "table") {
      exactKeys(block, ["id", "type", "caption", "columns", "rows"], "resource table block");
      const parsed = parseTableBlock({id, type, ...block});
      return {
        id,
        type,
        caption: parsed.caption,
        columns: parsed.columns,
        rows: parsed.rows
      };
    }
    if (type === "chart") {
      exactKeys(
        block,
        ["id", "type", "chartType", "title", "altText", "tableBlockId", "xColumn", "yColumns"],
        "resource chart block"
      );
      return {
        id,
        type,
        chart_type: oneOf(block.chartType, ["bar", "line"], "chart block.chartType"),
        title: boundedString(block.title, 300, "chart block.title"),
        alt_text: boundedString(block.altText, 1_000, "chart block.altText"),
        table_block_id: contentBlockId(block.tableBlockId),
        x_column: boundedString(block.xColumn, 300, "chart block.xColumn"),
        y_columns: parseChartColumns(block.yColumns)
      };
    }
    if (type === "image") {
      exactKeys(
        block,
        ["id", "type", "datasetId", "datasetVersionId", "objectId", "altText", "caption"]
          .filter((key) => block[key] !== undefined),
        "resource image block"
      );
      return {
        id,
        type,
        dataset_id: assertUuid(block.datasetId, "image block.datasetId"),
        dataset_version_id: assertUuid(block.datasetVersionId, "image block.datasetVersionId"),
        object_id: assertUuid(block.objectId, "image block.objectId"),
        alt_text: boundedString(block.altText, 1_000, "image block.altText"),
        ...(block.caption === undefined || block.caption === null
          ? {}
          : {caption: boundedString(block.caption, 300, "image block.caption")})
      };
    }
    if (type === "file") {
      exactKeys(
        block,
        ["id", "type", "datasetId", "datasetVersionId", "objectId", "label", "description"]
          .filter((key) => block[key] !== undefined),
        "resource file block"
      );
      return {
        id,
        type,
        dataset_id: assertUuid(block.datasetId, "file block.datasetId"),
        dataset_version_id: assertUuid(block.datasetVersionId, "file block.datasetVersionId"),
        object_id: assertUuid(block.objectId, "file block.objectId"),
        label: boundedString(block.label, 300, "file block.label"),
        ...(block.description === undefined || block.description === null
          ? {}
          : {description: boundedString(block.description, 1_000, "file block.description")})
      };
    }
    if (type === "document") {
      exactKeys(
        block,
        ["id", "type", "datasetId", "datasetVersionId", "objectId", "label"],
        "resource document block"
      );
      return {
        id,
        type,
        dataset_id: assertUuid(block.datasetId, "document block.datasetId"),
        dataset_version_id: assertUuid(block.datasetVersionId, "document block.datasetVersionId"),
        object_id: assertUuid(block.objectId, "document block.objectId"),
        label: boundedString(block.label, 300, "document block.label")
      };
    }
    exactKeys(block, ["id", "type", "namespace", "label"], "preserved resource block");
    return {
      id,
      type,
      namespace: boundedString(block.namespace, 100, "preserved block.namespace"),
      label: boundedString(block.label, 300, "preserved block.label")
    };
  });
  validateSerializedCharts(result);
  validateSerializedStructure(result);
  const serialized = {blocks: result};
  boundedObject(serialized, 16_384, "resource content");
  return serialized;
}

function validateSerializedCharts(blocks) {
  const tables = new Map(
    blocks.filter((block) => block.type === "table").map((block) => [block.id, block])
  );
  for (const chart of blocks.filter((block) => block.type === "chart")) {
    const table = tables.get(chart.table_block_id);
    if (!table) throw new TypeError("chart must reference a table block");
    const columns = new Map(
      table.columns.map((column, index) => [column.toLowerCase(), index])
    );
    const xIndex = columns.get(chart.x_column.toLowerCase());
    const yIndexes = chart.y_columns.map((column) => columns.get(column.toLowerCase()));
    if (xIndex === undefined || yIndexes.some((index) => index === undefined)
      || chart.y_columns.some((column) => column.toLowerCase() === chart.x_column.toLowerCase())) {
      throw new TypeError("chart columns are invalid");
    }
    for (const index of yIndexes) {
      const values = table.rows.map((row) => row[index]).filter((value) => value !== null);
      if (!values.length || values.some((value) => typeof value !== "number")) {
        throw new TypeError("chart value columns must contain only numbers");
      }
    }
  }
}

function parseTableBlock(block) {
  const columns = parseArray(
    block.columns,
    (value) => boundedString(value, 300, "table block column"),
    "table block.columns"
  );
  if (!columns.length || columns.length > 12
    || new Set(columns.map((value) => value.toLowerCase())).size !== columns.length) {
    contract("table block columns are invalid");
  }
  if (!Array.isArray(block.rows) || block.rows.length > 50) {
    contract("table block rows are invalid");
  }
  const rows = block.rows.map((row) => {
    if (!Array.isArray(row) || row.length !== columns.length) {
      contract("table block row width is invalid");
    }
    return row.map(tableCell);
  });
  return {
    id: contentBlockId(block.id),
    type: "table",
    caption: boundedString(block.caption, 300, "table block.caption"),
    columns,
    rows
  };
}

function tableCell(value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string" && value.length <= 300) return value;
  if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e15) {
    return value;
  }
  contract("table cell is invalid");
}

function parseChartColumns(value) {
  const columns = parseArray(
    value,
    (column) => boundedString(column, 300, "chart value column"),
    "chart value columns"
  );
  if (!columns.length || columns.length > 4
    || new Set(columns.map((column) => column.toLowerCase())).size !== columns.length) {
    contract("chart value columns are invalid");
  }
  return columns;
}

function parseHeadingBlockIds(value) {
  const targets = parseArray(
    value,
    (target) => contentBlockId(target),
    "navigation heading targets"
  );
  if (!targets.length || targets.length > 12 || new Set(targets).size !== targets.length) {
    contract("navigation heading targets are invalid");
  }
  return targets;
}

function contentBlockId(value) {
  const id = boundedString(value, 100, "resource content block.id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) contract("resource content block.id is invalid");
  return id;
}

function validateParsedCharts(blocks) {
  const tables = new Map(
    blocks.filter((block) => block.type === "table").map((block) => [block.id, block])
  );
  for (const chart of blocks.filter((block) => block.type === "chart")) {
    const table = tables.get(chart.tableBlockId);
    if (!table) contract("chart table reference is invalid");
    const columns = new Map(
      table.columns.map((column, index) => [column.toLowerCase(), index])
    );
    const xIndex = columns.get(chart.xColumn.toLowerCase());
    const yIndexes = chart.yColumns.map((column) => columns.get(column.toLowerCase()));
    if (xIndex === undefined || yIndexes.some((index) => index === undefined)
      || chart.yColumns.some((column) => column.toLowerCase() === chart.xColumn.toLowerCase())) {
      contract("chart columns are invalid");
    }
    for (const index of yIndexes) {
      const values = table.rows.map((row) => row[index]).filter((value) => value !== null);
      if (!values.length || values.some((value) => typeof value !== "number")) {
        contract("chart value columns are invalid");
      }
    }
  }
}

function validateParsedStructure(blocks) {
  validateStructure(
    blocks,
    (navigation) => navigation.headingBlockIds,
    (message) => contract(message)
  );
}

function validateSerializedStructure(blocks) {
  validateStructure(
    blocks,
    (navigation) => navigation.heading_block_ids,
    (message) => {
      throw new TypeError(message);
    }
  );
}

function validateStructure(blocks, targetsFor, fail) {
  const headings = new Map();
  let previousLevel = null;
  for (const [position, block] of blocks.entries()) {
    if (block.type !== "heading") continue;
    if (previousLevel === null && block.level !== 2) {
      fail("the first structural heading must be level 2");
    }
    if (previousLevel !== null && block.level > previousLevel + 1) {
      fail("structural heading levels cannot be skipped");
    }
    previousLevel = block.level;
    headings.set(block.id, position);
  }
  for (const navigation of blocks.filter((block) => block.type === "navigation")) {
    const targets = targetsFor(navigation);
    if (targets.some((target) => !headings.has(target))) {
      fail("navigation must target headings in the same resource");
    }
    const positions = targets.map((target) => headings.get(target));
    if (positions.some((position, index) => index && position < positions[index - 1])) {
      fail("navigation headings must preserve document order");
    }
  }
}

function boundedQuery(value, maximum, label) {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new TypeError(`${label} is invalid`);
  return value.trim();
}

function nonNegativeInputInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} is invalid`);
  return value;
}

function positiveInputInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} is invalid`);
  return value;
}

function inputOneOf(value, choices, label) {
  if (!choices.includes(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

const OBSERVABLE_SOURCE_PATH_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,7}$/;
const OBSERVABLE_SOURCE_FORBIDDEN_DIRECTORY =
  /(^|\/)(?:node_modules|dist|build|cache|\.git|\.aws|\.ssh)(?:\/|$)/i;
const OBSERVABLE_SOURCE_SECRET_FILE =
  /(^|\/)(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|id_rsa|[^/]+\.(?:pem|key|p12|pfx))$/i;
const OBSERVABLE_SOURCE_MEDIA = Object.freeze([
  [/\.ipynb$/i, ["application/x-ipynb+json", "application/json"]],
  [/\.md$/i, ["text/markdown"]],
  [/\.(?:js|mjs)$/i, ["text/javascript"]],
  [/\.css$/i, ["text/css"]],
  [/\.geojson$/i, ["application/json", "application/geo+json"]],
  [/\.json$/i, ["application/json"]],
  [/\.csv$/i, ["text/csv"]],
  [/\.txt$/i, ["text/plain"]],
  [/\.html$/i, ["text/html"]],
  [/\.svg$/i, ["image/svg+xml"]],
  [/\.png$/i, ["image/png"]],
  [/\.(?:jpg|jpeg)$/i, ["image/jpeg"]]
]);

function assertObservableSourcePath(value, label) {
  if (typeof value !== "string" || value.length > 512
    || !OBSERVABLE_SOURCE_PATH_PATTERN.test(value)
    || OBSERVABLE_SOURCE_FORBIDDEN_DIRECTORY.test(value)
    || OBSERVABLE_SOURCE_SECRET_FILE.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function parseObservableSourcePath(value, label) {
  try {
    return assertObservableSourcePath(value, label);
  } catch (cause) {
    contract(`${label} is invalid`, cause);
  }
}

function observableSourceContentType(value, label) {
  return oneOf(value, [
    "application/x-ipynb+json",
    "text/markdown", "text/javascript", "text/css", "application/json",
    "application/geo+json", "text/csv", "text/plain", "text/html", "image/svg+xml",
    "image/png", "image/jpeg"
  ], label);
}

export function validateJupyterPublicationTree(entryPath, lockfilePath, files, attachments = []) {
  if (!/\.ipynb$/i.test(entryPath)) return;
  const prefix = entryPath.includes('/') ? entryPath.slice(0, entryPath.lastIndexOf('/') + 1) : '';
  if (lockfilePath != null || [...files, ...attachments].some(file => !file.relativePath.startsWith(prefix))) {
    throw new TypeError('Jupyter notebooks require a lockfile-free source tree under the entry directory');
  }
}

export function validateStaticPublicationTree(entryPath, lockfilePath, files, attachments = []) {
  if (!/(^|\/)index\.html$/.test(entryPath)) return;
  const prefix = entryPath.slice(0, -"index.html".length);
  if (lockfilePath != null || [...files, ...attachments].some(({relativePath}) =>
    !relativePath.startsWith(prefix) || /\.md$/i.test(relativePath)
    || /(^|\/)(package(?:-lock)?\.json|observablehq\.config\.[cm]?js|opengeo\.observable\.json)$/i.test(relativePath))) {
    throw new TypeError("Static HTML accepts only public files under its entry directory, without package or build configuration");
  }
}

/** Only unread, unchanged files from the server-supported exact parent can skip a byte read. */
export function canReuseDeferredObservableSourceFile(file, {sourceProjectId, expectedRevision, reuseRevision} = {}) {
  if (file?.blob != null || reuseRevision?.supportsFileReuse !== true
    || reuseRevision.sourceProjectId !== sourceProjectId
    || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1
    || reuseRevision.revisionNumber !== expectedRevision || !Array.isArray(reuseRevision.files)) return false;
  const parent = reuseRevision.files.find(item => item.relativePath === file?.relativePath);
  return !!parent && typeof file.sourceObjectId === 'string' && UUID_PATTERN.test(file.sourceObjectId)
    && /^[0-9a-f]{64}$/.test(file.checksumSha256)
    && Number.isSafeInteger(file.sizeBytes) && file.sizeBytes >= 1 && file.sizeBytes <= 4_194_304
    && ['relativePath', 'contentType', 'sizeBytes', 'checksumSha256', 'sourceObjectId']
      .every(key => file[key] === parent[key]);
}

export function normalizeObservableSourceFiles(values, reuseContext = {}) {
  if (!Array.isArray(values) || !values.length || values.length > 128) {
    throw new TypeError("Observable source files must contain one to 128 entries");
  }
  const files = values.map(value => {
    if (!canReuseDeferredObservableSourceFile(value, reuseContext)) return observableSourceFileInput(value);
    // Use the same path/media validation and byte ceilings as materialized files.
    const relativePath = assertObservableSourcePath(value.relativePath, "Observable source relative path");
    const media = OBSERVABLE_SOURCE_MEDIA.find(([pattern]) => pattern.test(relativePath));
    if (!media?.[1].includes(value.contentType)) throw new TypeError("Observable source content type does not match its path");
    return {relativePath, blob: null, contentType: value.contentType, sizeBytes: value.sizeBytes,
      checksumSha256: value.checksumSha256, sourceObjectId: value.sourceObjectId};
  }).sort((left, right) => (
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
  ));
  if (new Set(files.map(({relativePath}) => relativePath.toLowerCase())).size !== files.length) {
    throw new TypeError("Observable source paths must be case-insensitively unique");
  }
  if (files.reduce((bytes, file) => bytes + (file.blob?.size ?? file.sizeBytes), 0) > 16_777_216) {
    throw new TypeError("Source tree exceeds 16 MiB; move large data attachments into datasets");
  }
  return files;
}

function observableSourceFileInput(value) {
  const record = object(value, "Observable source file");
  const relativePath = assertObservableSourcePath(
    record.relativePath,
    "Observable source relative path"
  );
  if (!(record.blob instanceof Blob) || record.blob.size < 1 || record.blob.size > 4_194_304) {
    throw new TypeError("Observable source file must be a non-empty Blob of at most 4 MiB");
  }
  const media = OBSERVABLE_SOURCE_MEDIA.find(([pattern]) => pattern.test(relativePath));
  if (!media) throw new TypeError("Observable source file type is unsupported");
  const contentType = record.contentType || record.blob.type || media[1][0];
  if (!media[1].includes(contentType)) {
    throw new TypeError("Observable source content type does not match its path");
  }
  return {relativePath, blob: record.blob, contentType};
}

function observableSourceFile(value) {
  const record = object(value, "Observable source file upload");
  const file = observableSourceFileInput(record);
  return {
    ...file,
    checksumSha256: sha256Checksum(
      record.checksumSha256,
      "Observable source checksum"
    )
  };
}

function parseObservableRevisionUploads(value) {
  if (!Array.isArray(value) || !value.length || value.length > 128) {
    throw new TypeError("Observable source revision files are invalid");
  }
  const files = value.map((candidate) => {
    const record = object(candidate, "Observable source revision file");
    if ((record.uploadId == null) === (record.sourceObjectId == null)) {
      throw new TypeError("Provide exactly one source upload or retained object id");
    }
    return {
      ...(record.sourceObjectId == null
        ? {uploadId: assertUuid(record.uploadId, "Observable source upload id")}
        : {sourceObjectId: assertUuid(record.sourceObjectId, "Observable retained source object id")}),
      relativePath: assertObservableSourcePath(
        record.relativePath,
        "Observable source revision path"
      )
    };
  });
  const sorted = [...files].sort((left, right) => (
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
  ));
  if (files.some((file, index) => file.relativePath !== sorted[index].relativePath)
    || new Set(files.map(({uploadId, sourceObjectId}) => uploadId ? `upload:${uploadId}` : `object:${sourceObjectId}`)).size !== files.length
    || new Set(files.map(({relativePath}) => relativePath.toLowerCase())).size !== files.length) {
    throw new TypeError("Observable source revision files must be sorted and unique");
  }
  return files;
}

function compilerImageDigest(value, label) {
  const digest = string(value, label);
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) contract(`${label} is invalid`);
  return digest;
}

function pageBlockIdentifier(value, label) {
  const parsed = string(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(parsed)) {
    throw new TypeError(`${label} is invalid`);
  }
  return parsed;
}

function sha256Checksum(value, label) {
  const parsed = string(value, label);
  if (!/^[0-9a-f]{64}$/.test(parsed)) throw new TypeError(`${label} is invalid`);
  return parsed;
}

function semanticVersion(value, label) {
  const parsed = string(value, label);
  if (!/^\d+\.\d+\.\d+$/.test(parsed)) throw new TypeError(`${label} is invalid`);
  return parsed;
}

function compilerIdentity(value, label) {
  const parsed = string(value, label);
  if (!/^[a-z][a-z0-9-]*-\d+\.\d+\.\d+$/.test(parsed)) {
    throw new TypeError(`${label} is invalid`);
  }
  return parsed;
}

function optionalOneOf(value, values, label) {
  if (value === null) return null;
  if (!values.includes(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function optionalTimestamp(value, label) {
  if (value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new TypeError(`${label} is invalid`);
  return value;
}

function pageParameters({limit = 50, offset = 0} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be between 1 and 100");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000) throw new TypeError("offset must be between 0 and 10000");
  return new URLSearchParams({limit: String(limit), offset: String(offset)});
}

async function responsePayload(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ApiContractError("The API returned invalid JSON", {
      status: response.status,
      requestId: response.headers.get("X-Request-ID"),
      cause
    });
  }
}

function apiResponseError(response, payload) {
  const detail = isObject(payload) ? payload.detail : null;
  const code = typeof detail === "string"
    ? detail
    : isObject(detail) && typeof detail.code === "string"
      ? detail.code
      : `http_${response.status}`;
  const currentVersion = isObject(detail) && Number.isSafeInteger(detail.current_version)
    ? detail.current_version
    : null;
  const currentDraftRevision = isObject(detail)
    && Number.isSafeInteger(detail.current_draft_revision)
    ? detail.current_draft_revision
    : null;
  return new ApiClientError(`API request failed with status ${response.status}`, {
    status: response.status,
    code,
    requestId: response.headers.get("X-Request-ID"),
    currentVersion,
    currentDraftRevision
  });
}

function pathUuid(value, label) {
  return encodeURIComponent(assertUuid(value, label));
}

function siteSlugPath(value) {
  return encodeURIComponent(siteSlug(value, "site slug"));
}

function siteSlug(value, label) {
  if (typeof value !== "string" || !SITE_SLUG_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function assertUuid(value, label) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new TypeError(`${label} must be a UUID`);
  return value.toLowerCase();
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WMS_PUBLICATION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,62}(?::[A-Za-z][A-Za-z0-9._-]{0,62})?$/;
const SPATIAL_SERVICE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const SITE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?$/;

function uuid(value, label) {
  try {
    return assertUuid(value, label);
  } catch (cause) {
    contract(`${label} is invalid`, cause);
  }
}

function nullableUuid(value, label) {
  return value === null ? null : uuid(value, label);
}

function string(value, label) {
  if (typeof value !== "string" || !value.trim()) contract(`${label} is invalid`);
  return value;
}

function boundedString(value, maximum, label) {
  const result = string(value, label);
  if (result.length > maximum) contract(`${label} is too large`);
  return result;
}

function boundedUtf8String(value, maximumBytes, label) {
  const result = string(value, label);
  if (new TextEncoder().encode(result).byteLength > maximumBytes) {
    contract(`${label} is too large`);
  }
  return result;
}

function boolean(value, label) {
  if (typeof value !== "boolean") contract(`${label} is invalid`);
  return value;
}

function nullableString(value, label) {
  return value === null ? null : string(value, label);
}

function nullableBoundedString(value, maximum, label) {
  return value === null ? null : boundedString(value, maximum, label);
}

function timestamp(value, label) {
  const result = string(value, label);
  if (Number.isNaN(Date.parse(result))) contract(`${label} is invalid`);
  return result;
}

function nullableTimestamp(value, label) {
  return value === null ? null : timestamp(value, label);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) contract(`${label} is invalid`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) contract(`${label} is invalid`);
  return value;
}

function nullablePositiveInteger(value, label) {
  return value === null ? null : positiveInteger(value, label);
}

function nullableNonNegativeInteger(value, label) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) contract(`${label} is invalid`);
  return value;
}

function finiteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) contract(`${label} is invalid`);
  return value;
}

function oneOf(value, choices, label) {
  if (!choices.includes(value)) contract(`${label} is invalid`);
  return value;
}

function machineCode(value, label) {
  const result = string(value, label);
  if (result.length > 100 || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(result)) {
    contract(`${label} is invalid`);
  }
  return result;
}

function languageTag(value, label) {
  const result = string(value, label).trim().toLowerCase();
  if (result.length > 40 || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(result)) {
    contract(`${label} is invalid`);
  }
  return result;
}

function object(value, label) {
  if (!isObject(value)) contract(`${label} must be an object`);
  return value;
}

function boundedObject(value, maximumBytes, label) {
  const record = object(value, label);
  let encoded;
  try {
    encoded = new TextEncoder().encode(JSON.stringify(record));
  } catch (cause) {
    contract(`${label} is not JSON serializable`, cause);
  }
  if (encoded.byteLength > maximumBytes) contract(`${label} is too large`);
  return structuredClone(record);
}

function parseArray(value, parser, label) {
  if (!Array.isArray(value)) contract(`${label} must be an array`);
  return value.map(parser);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function contract(message, cause) {
  throw new ApiContractError(message, {cause});
}

const S3_PATH_STYLE_HOST_PATTERN = /^s3\.[a-z]{2}(?:-gov)?-[a-z]+-[0-9]\.amazonaws\.com$/;
const S3_BUCKET_NAME_PATTERN = /^(?=.{3,63}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/;
const REQUIRED_UPLOAD_FIELDS = Object.freeze([
  "key",
  "Content-Type",
  "x-amz-checksum-sha256",
  "x-amz-server-side-encryption",
  "x-amz-server-side-encryption-aws-kms-key-id",
  "x-amz-algorithm",
  "x-amz-credential",
  "x-amz-date",
  "policy",
  "x-amz-signature"
]);
const ALLOWED_UPLOAD_FIELDS = new Set([...REQUIRED_UPLOAD_FIELDS, "x-amz-security-token"]);

function isPathStyleS3Target(destination, {objectRequired}) {
  if (!S3_PATH_STYLE_HOST_PATTERN.test(destination.hostname) || !destination.pathname.startsWith("/")) {
    return false;
  }
  const separator = destination.pathname.indexOf("/", 1);
  const bucket = separator === -1
    ? destination.pathname.slice(1)
    : destination.pathname.slice(1, separator);
  if (!S3_BUCKET_NAME_PATTERN.test(bucket)
    || bucket.includes("..")
    || bucket.includes(".-")
    || bucket.includes("-.")
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket)) {
    return false;
  }
  const hasObject = separator !== -1 && separator < destination.pathname.length - 1;
  return objectRequired ? hasObject : separator === -1;
}

async function verifiedDiscoveryResponse(response,{jobId,expectedSize,expectedChecksum,requirePrivacyHeaders=false}) {
  if (!response.ok) throw apiResponseError(response,await responsePayload(response));
  const contentType=response.headers.get("content-type")?.split(";",1)[0]?.trim();
  const declaredSize=response.headers.get("content-length");
  const privateResponse=!requirePrivacyHeaders || (
    response.headers.get("cache-control")?.split(",").some(value=>value.trim().toLowerCase()==="no-store")
    && response.headers.get("x-content-type-options")?.trim().toLowerCase()==="nosniff");
  if(contentType!=="application/octet-stream" || !privateResponse
    || response.headers.get("X-OpenGeo-Discovery-Job-Id")!==jobId
    || response.headers.get("X-OpenGeo-Source-Sha256")!==expectedChecksum
    || (declaredSize!==null && (!/^\d+$/.test(declaredSize) || Number(declaredSize)!==expectedSize))) {
    await response.body?.cancel().catch(()=>{});
    contract("Saved discovery response identity changed");
  }
  const reader=response.body?.getReader();
  if(!reader) contract("Saved discovery response body is missing");
  const chunks=[];
  let size=0;
  try {
    while(true) {
      const {done,value}=await reader.read();
      if(done) break;
      size+=value.byteLength;
      if(size>expectedSize) contract("Saved discovery response exceeds its declared size");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
  if(size!==expectedSize) contract("Saved discovery response size changed");
  const blob=new Blob(chunks,{type:contentType});
  const digest=[...new Uint8Array(await crypto.subtle.digest("SHA-256",await blob.arrayBuffer()))]
    .map(byte=>byte.toString(16).padStart(2,"0")).join("");
  if(digest!==expectedChecksum) contract("Saved discovery response checksum mismatch");
  return {discoveryJobId:jobId,checksumSha256:expectedChecksum,blob};
}

export function parseDatasetKnowledge(value, datasetId) {
  const record = object(value, "dataset metadata");
  if (uuid(record.dataset_id, "metadata dataset") !== datasetId.toLowerCase()) contract("metadata dataset identity is inconsistent");
  return {datasetId:record.dataset_id,...parseKnowledgeRecord(record)};
}

export function parseAuthoredKnowledge(value, kind, id) {
  const record=object(value,"authored metadata");
  if(record.kind!==kind || uuid(record.resource_id,"metadata resource")!==id.toLowerCase()) contract("metadata resource identity is inconsistent");
  return {kind,resourceId:record.resource_id,...parseKnowledgeRecord(record)};
}

function parseKnowledgeRecord(record) {
  const document = object(record.document, "metadata document");
  if (document.schemaVersion !== "1.0.0") contract("unsupported metadata document");
  const metadata = object(document.metadata, "metadata levels");
  for (const level of ["source", "normalized", "curated", "inferred"]) {
    if (!Array.isArray(metadata[level])) contract("metadata level must be an array");
  }
  if (!Array.isArray(document.distributions) || !Array.isArray(document.context)) contract("metadata relationships must be arrays");
  return {version: nonNegativeInteger(record.version, "metadata revision"),
    document, canEdit: boolean(record.can_edit, "metadata edit access"),
    createdAt: nullableTimestamp(record.created_at, "metadata timestamp"),
    createdBy: nullableUuid(record.created_by, "metadata author")};
}

function collectionReceipt(value) {
  const item = object(value, "collection receipt");
  return {id: uuid(item.id, "collection.id"), revision: positiveInteger(item.revision, "collection.revision")};
}
function parseCollectionSummary(value, {organizationId = null} = {}) {
  const item = object(value, "collection");
  if (typeof item.description !== "string" || item.description.length > 10000) contract("Invalid Collection description");
  const visibility = item.visibility ?? "private";
  if (!["private", "account", "public"].includes(visibility)) contract("Invalid Collection visibility");
  let owner;
  try {owner = collectionOwnerFromApi(item, {organizationId});}
  catch (cause) {contract("Invalid Collection owner", cause);}
  return {...collectionReceipt(item), ...(!Object.hasOwn(item, "owner") ? {} : {owner}),
    title: string(item.title, "collection.title"),
    description: item.description, visibility,
    owner_name: item.owner_name == null ? null : string(item.owner_name, "Collection owner"),
    updated_at: item.updated_at == null ? null : string(item.updated_at, "Collection updated"),
    visible_member_count: item.visible_member_count == null ? null : nonNegativeInteger(item.visible_member_count, "visible member count"),
    member_preview: item.member_preview == null ? [] : parseArray(item.member_preview, preview => {
      if (!["project", "publication"].includes(preview.kind)) contract("Invalid Collection preview kind");
      return {kind: preview.kind, title: string(preview.title, "Collection preview title")};
    }, "Collection preview").slice(0, 4)};
}
