// Request builders for source-wide archives. A WMS image export is not a mirror.
// The API must independently enforce access, inventory identity and admission.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;

export const SOURCE_ARCHIVE_METHODS = Object.freeze([
  "listSourceArchiveJobs", "createSourceArchivePlan", "startSourceArchiveCapture",
  "getSourceArchiveJob", "controlSourceArchiveJob"
]);

export function hasSourceArchiveWorkflow(adapter) {
  return SOURCE_ARCHIVE_METHODS.every((name) => typeof adapter?.[name] === "function");
}

export function sourceArchiveContext({organizationId, projectId, sourceDatasetId, sourceRevisionNumber}) {
  for (const value of [organizationId, projectId, sourceDatasetId]) {
    if (!UUID.test(value)) throw new TypeError("A saved project and source are required.");
  }
  if (!Number.isSafeInteger(sourceRevisionNumber) || sourceRevisionNumber < 1) {
    throw new TypeError("A saved source revision is required.");
  }
  return Object.freeze({organizationId, projectId, sourceDatasetId, sourceRevisionNumber});
}

export function sourceArchivePlanRequest(context, capture) {
  if (!["metadata", "originals_and_metadata"].includes(capture)) throw new TypeError("Choose what to preserve.");
  return Object.freeze({...sourceArchiveContext(context), capture, scope: {kind: "full_source"}});
}

export function validateSourceArchivePlan(plan, request, now = Date.now()) {
  if (!UUID.test(plan?.id) || !DIGEST.test(plan?.sha256)) throw new TypeError("The archive plan has no verified identity.");
  for (const key of ["organizationId", "projectId", "sourceDatasetId", "sourceRevisionNumber", "capture"]) {
    if (plan[key] !== request[key]) throw new TypeError("The archive plan does not match this source and selection.");
  }
  if (plan.scope?.kind !== "full_source" || plan.inventoryComplete !== true) {
    throw new TypeError("The source inventory is incomplete. A selected area cannot replace a full-source archive.");
  }
  if (!Number.isFinite(Date.parse(plan.expiresAt)) || Date.parse(plan.expiresAt) <= now) {
    throw new TypeError("This plan has expired. Review a new estimate before starting.");
  }
  for (const key of ["fileCount", "totalBytes"]) {
    if (!Number.isSafeInteger(plan[key]) || plan[key] < 0) throw new TypeError("The source size must be known before capture.");
  }
  for (const key of ["estimatedExecutionCostUsd", "estimatedMonthlyStorageUsd", "maximumExecutionCostUsd"]) {
    if (!Number.isFinite(plan[key]) || plan[key] < 0) throw new TypeError("A complete cost estimate is required.");
  }
  if (plan.estimatedExecutionCostUsd > plan.maximumExecutionCostUsd) throw new TypeError("The estimate exceeds the execution limit.");
  if (!plan.destination?.connectionId || !UUID.test(plan.destination.connectionId)
      || !["private", "public"].includes(plan.destination.access)
      || typeof plan.destination.label !== "string" || !plan.destination.label.trim()) {
    throw new TypeError("Choose a verified archive connection and access setting.");
  }
  return plan;
}

export function sourceArchiveStartRequest(context, plan, {capture, accepted, rightsConfirmed, idempotencyKey}, now = Date.now()) {
  validateSourceArchivePlan(plan, sourceArchivePlanRequest(context, capture), now);
  if (accepted !== true || rightsConfirmed !== true) throw new TypeError("Confirm retention rights, destination and cost before capture.");
  if (!UUID.test(idempotencyKey)) throw new TypeError("A stable request identity is required.");
  return Object.freeze({...sourceArchiveContext(context), planId: plan.id, planSha256: plan.sha256,
    idempotencyKey, acceptedMaximumExecutionCostUsd: plan.maximumExecutionCostUsd,
    rightsConfirmed: true, destinationAccepted: true});
}

export function sourceArchiveControls(job) {
  const byState = {
    queued: ["pause", "cancel"], running: ["pause", "cancel"],
    paused: ["resume", "cancel"], failed: ["retry", "cancel"],
    verifying: ["cancel"], cancelling: [], cancelled: [], complete: []
  };
  // Only expose actions that the server also permits for this exact job/user.
  return (byState[job?.state] ?? []).filter((action) => job.allowedActions?.includes(action));
}
