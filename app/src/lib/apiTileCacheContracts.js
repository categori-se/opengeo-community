/** Pure tile-cache request and response contracts. Reads do not create work. */

import {
  object,
  exactKeys,
  integerBetween,
  uuid,
  positiveInteger,
  nullableBoundedString,
  timestamp,
  oneOf,
  parseArray,
  finiteNumber,
  contract,
  nullableUuid,
  nullableTimestamp,
  boolean,
  nullablePositiveInteger,
  nonNegativeInteger,
  sha256
} from "./apiResponseContracts.js";

export function tileSeedSelectorBody(value) {
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
