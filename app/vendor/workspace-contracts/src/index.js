// @ts-nocheck -- Runtime contract behavior is enforced by the package's conformance suite.
export {
  actionsForCollaborationRole,
  assertCollaborationResource,
  assertResourceGrant,
  authorizeResource,
  canManageResourceAccess,
  collaborationActions,
  collaborationAuditEvents,
  collaborationGrantEffects,
  collaborationGrantStatuses,
  collaborationInheritanceModes,
  collaborationPrincipalTypes,
  collaborationResourceTypes,
  collaborationRoleActions,
  collaborationRoles,
  collaborationSchemaVersion,
  createNotebookResource,
  createResourceGrant,
  normalizeCollaborationActions,
  resolveResourceAccess,
  validateCollaborationResource,
  validateResourceGrant
} from "./collaboration.js";

export {
  assertArtifactReference,
  assertDataRepository,
  assertSourceReference,
  createArtifactReference,
  createDataRepository,
  createSourceAdapterDescriptor,
  createSourceReference,
  repositorySchemaVersion,
  sourceAdapterCapabilities,
  sourceCaptureModes,
  sourceKinds,
  validateArtifactReference,
  validateDataRepository,
  validatePortableData,
  validateSourceReference,
  wellKnownSourceProviders
} from "./repository.js";

export {
  assertDemoPolicy,
  authorizeDemoMutation,
  buildDemoPartitionScope,
  createDemoPolicy,
  demoMinuteKey,
  demoMutationActions,
  demoPartitionNeedsReset,
  demoResetCadences,
  demoSchemaVersion,
  demoUtcDayKey,
  validateDemoPolicy
} from "./demo.js";

export {
  assertPublicReleaseCandidate,
  assertPublicReleaseTransition,
  createPublicReleaseCandidate,
  publicationSchemaVersion,
  publicReleaseApprovalRoles,
  publicReleaseStatuses,
  validatePublicReleaseCandidate,
  validatePublicReleaseTransition
} from "./publication.js";

export {
  assertMassgisSourceManifest,
  massgisSourceManifestSchemaVersion,
  massgisSourceReviewStatuses,
  requiredMassgisAttribution,
  validateMassgisSourceManifest
} from "./source-manifest.js";

export {
  adaptResourceReference,
  assertResourceEnvelope,
  assertResourceReference,
  createResourceEnvelope,
  createResourceReference,
  interoperabilitySchemaVersion,
  resourceReferenceKey,
  validateResourceEnvelope,
  validateResourceReference
} from "./interoperability.js";

export const workspaceContractsVersion = "0.1.0-alpha.9";

export {assertPreservedRecord, validatePreservedRecord} from "./preservation.js";

export {
  authorizeScopedResource,
  createExternalIdentityLink,
  createIdentityUser,
  createIdentityWorkspace,
  createWorkspaceParticipation,
  externalIdentityKey,
  identitySchemaVersion,
  identityStatuses,
  participationModes,
  resolveIdentityUser,
  resolveScopedResourceAccess,
  validateExternalIdentityLink,
  validateIdentityUser,
  validateIdentityWorkspace,
  validateWorkspaceParticipation
} from "./identity.js";

export {
  assertLocationWrite,
  assertPromotionApplicable,
  checkpointWorkingCopy,
  createPromotionRequest,
  createWorkingCopy,
  locationPurposes,
  validateLocationWrite,
  validatePromotionRequest,
  validateWorkingCopy,
  validateWorkingCopyCheckpoint,
  workingStateSchemaVersion
} from "./working-state.js";

export {assertRetainedEvidenceLink, assertRetainedEvidenceLinks, readRetainedEvidence, retainedEvidenceChunkBytes, retainedEvidenceExtension, retainedEvidenceKey, verifyRetainedEvidenceBytes} from "./retained.js";

export {
  assertPublicationAvailabilityEvent,
  assertPublicationAvailabilityTransition,
  assertPublicationProjectionReview,
  assertPublicationRelease,
  assertPublicReleaseProjection,
  createPublicationAvailabilityEvent,
  createPublicationRelease,
  createPublicReleaseProjection,
  publicationReleaseBytes,
  publicationReleaseDigest,
  releaseInteroperabilitySchemaVersion,
  validatePublicationAvailabilityEvent,
  validatePublicationProjectionReview,
  validatePublicationRelease,
  validatePublicReleaseProjection
} from "./releases.js";

export {assertProjectBusinessContext, businessContextSchemaVersion, createProjectBusinessContext,
  normalizeProjectAccountIds, projectBusinessAccountLimit, validateProjectBusinessContext} from "./business-context.js";

export {collectionSchemaVersion, collectionEntryLimit, validateCollectionDefinition, assertCollectionDefinition, createCollectionDefinition} from "./collections.js";

export {assertDocumentVersionLink, documentVersionKey, verifyDocumentVersionBytes,
  documentVersionChunkBytes, documentVersionMaxBytes} from "./documents.js";
