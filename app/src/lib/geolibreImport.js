import {canonicalJson} from "./legacyCanonicalJson.js";
export {canonicalJson} from "./legacyCanonicalJson.js";

const IMPORT_SOURCE_VERSION = "2.6.0";

export async function prepareGeoLibreImport({conversion, sourceText, mapId, expectedMapVersion}) {
  if (!conversion?.map?.definition || !conversion?.report || !conversion?.records) {
    throw new TypeError("GeoLibre conversion result is invalid");
  }
  const sourceVersion = conversion.map.definition.extensions?.geolibre?.upstream?.version ?? IMPORT_SOURCE_VERSION;
  if (![IMPORT_SOURCE_VERSION, "3.0.0"].includes(sourceVersion)) {
    throw new TypeError("GeoLibre conversion reference is unsupported");
  }
  const sourceSha256 = await sha256Hex(sourceText);
  const embeddedWithData = await Promise.all(conversion.records.embeddedDatasets.map(async (record) => {
    const content = JSON.stringify(record.data);
    const blob = new Blob([content], {type: "application/geo+json"});
    return {
      importRef: record.importRef,
      name: record.name,
      description: null,
      classification: "internal",
      format: "geojson",
      filename: `${filenameStem(record.layerId)}.geojson`,
      contentType: "application/geo+json",
      sizeBytes: blob.size,
      checksumSha256: await sha256Hex(await blob.arrayBuffer()),
      tags: ["geolibre", "project-import"],
      blob
    };
  }));
  const externalSources = conversion.records.externalSources.map((candidate) => ({
    importRef: candidate.importRef,
    name: candidate.name,
    description: candidate.description ?? null,
    classification: candidate.classification ?? "internal",
    tags: candidate.tags ?? ["geolibre", candidate.source.type],
    source: structuredClone(candidate.source)
  }));
  const embeddedDatasets = embeddedWithData.map(({blob, ...candidate}) => candidate);
  const mapDefinition = structuredClone(conversion.map.definition);
  const digestInput = {
    sourceSha256,
    mapId,
    expectedMapVersion,
    mapDefinition,
    externalSources,
    embeddedDatasets,
    conversionReport: conversion.report
  };
  const planDigest = await sha256Hex(canonicalJson(digestInput));
  return {
    idempotencyKey: uuidFromDigest(await sha256Hex(canonicalJson({
      kind: "geolibre-project-import",
      mapId,
      expectedMapVersion,
      planDigest
    }))),
    mapId,
    expectedMapVersion,
    sourceProduct: "geolibre",
    sourceVersion,
    sourceSha256,
    planDigest,
    mapDefinition,
    conversionReport: structuredClone(conversion.report),
    externalSources,
    embeddedDatasets,
    embeddedWithData
  };
}

export async function executeGeoLibreImport({
  adapter,
  projectId,
  mapId,
  expectedMapVersion,
  conversion,
  sourceText,
  storage = safeLocalStorage()
}) {
  requireMethods(adapter, [
    "createProjectImport",
    "getProjectImport",
    "requestUpload",
    "uploadFile",
    "completeUpload",
    "bindProjectImportDataset",
    "finalizeProjectImport"
  ]);
  const prepared = await prepareGeoLibreImport({
    conversion,
    sourceText,
    mapId,
    expectedMapVersion
  });
  const plan = {
    ...prepared,
    embeddedWithData: undefined
  };
  let operation;
  let checkpoint = loadCheckpoint(storage, prepared.idempotencyKey) ?? {
    schemaVersion: "1.0.0",
    idempotencyKey: prepared.idempotencyKey,
    sourceSha256: prepared.sourceSha256,
    planDigest: prepared.planDigest,
    importId: null,
    steps: {},
    orphanedDatasetIds: []
  };
  assertCheckpoint(checkpoint, prepared);
  try {
    operation = await adapter.createProjectImport(projectId, plan);
    checkpoint.importId = operation.importId;
    saveCheckpoint(storage, checkpoint);
    for (const item of operation.items.filter((candidate) => candidate.kind === "embedded_dataset" && candidate.state === "pending")) {
      const candidate = prepared.embeddedWithData.find((record) => record.importRef === item.importRef);
      if (!candidate) throw new Error(`Embedded import bytes are missing for ${item.importRef}`);
      operation = await bindEmbeddedCandidate({
        adapter,
        projectId,
        operation,
        item,
        candidate,
        checkpoint,
        storage
      });
    }
    operation = operation.ready
      ? await adapter.finalizeProjectImport(projectId, operation.importId)
      : await adapter.getProjectImport(projectId, operation.importId);
    if (operation.state !== "completed") {
      throw codedError("project_import_incomplete", "Project import still has unresolved datasets");
    }
    removeCheckpoint(storage, prepared.idempotencyKey);
    return {operation, plan: prepared};
  } catch (error) {
    if (operation?.importId) {
      try {
        operation = await adapter.getProjectImport(projectId, operation.importId);
      } catch {
        // Preserve the last server response when the recovery read is unavailable.
      }
    }
    error.importRecovery = {
      importId: operation?.importId ?? checkpoint.importId,
      idempotencyKey: prepared.idempotencyKey,
      sourceSha256: prepared.sourceSha256,
      planDigest: prepared.planDigest,
      unresolvedImportRefs: operation?.unresolvedImportRefs ?? [],
      boundDatasets: operation?.items
        ?.filter((item) => item.datasetId)
        .map((item) => ({importRef: item.importRef, datasetId: item.datasetId})) ?? [],
      orphanedDatasetIds: [...checkpoint.orphanedDatasetIds],
      instruction: "Re-select the exact source project to resume this idempotent operation."
    };
    saveCheckpoint(storage, checkpoint);
    throw error;
  }
}

async function bindEmbeddedCandidate({
  adapter,
  projectId,
  operation,
  item,
  candidate,
  checkpoint,
  storage
}) {
  const previous = checkpoint.steps[item.importRef] ?? {};
  if (previous.datasetId) {
    return adapter.bindProjectImportDataset(
      projectId,
      operation.importId,
      item.importRef,
      previous.datasetId
    );
  }
  if (previous.uploadId) {
    try {
      const completion = await adapter.completeUpload(projectId, previous.uploadId);
      checkpoint.steps[item.importRef] = {
        ...previous,
        datasetId: completion.dataset.id,
        stage: "completed"
      };
      saveCheckpoint(storage, checkpoint);
      return await adapter.bindProjectImportDataset(
        projectId,
        operation.importId,
        item.importRef,
        completion.dataset.id
      );
    } catch {
      if (previous.datasetId) checkpoint.orphanedDatasetIds.push(previous.datasetId);
    }
  }
  const ticket = await adapter.requestUpload(projectId, {
    name: candidate.name,
    description: candidate.description,
    classification: candidate.classification,
    format: candidate.format,
    filename: candidate.filename,
    contentType: candidate.contentType,
    sizeBytes: candidate.sizeBytes,
    checksumSha256: candidate.checksumSha256,
    tags: [...candidate.tags, `import-${operation.importId}`]
  });
  checkpoint.steps[item.importRef] = {
    uploadId: ticket.uploadId,
    datasetId: ticket.dataset.id,
    stage: "requested"
  };
  saveCheckpoint(storage, checkpoint);
  await adapter.uploadFile(ticket.upload, candidate.blob);
  checkpoint.steps[item.importRef].stage = "uploaded";
  saveCheckpoint(storage, checkpoint);
  const completion = await adapter.completeUpload(projectId, ticket.uploadId);
  checkpoint.steps[item.importRef] = {
    uploadId: ticket.uploadId,
    datasetId: completion.dataset.id,
    stage: "completed"
  };
  saveCheckpoint(storage, checkpoint);
  return adapter.bindProjectImportDataset(
    projectId,
    operation.importId,
    item.importRef,
    completion.dataset.id
  );
}


async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto is required for project imports");
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : value;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function uuidFromDigest(hex) {
  const characters = hex.slice(0, 32).split("");
  characters[12] = "5";
  characters[16] = ((Number.parseInt(characters[16], 16) & 3) | 8).toString(16);
  const value = characters.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function filenameStem(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180) || "embedded";
}

function requireMethods(adapter, methods) {
  for (const method of methods) {
    if (typeof adapter?.[method] !== "function") {
      throw new TypeError("A persistent project connection with import support is required");
    }
  }
}

function checkpointKey(idempotencyKey) {
  return `opengeo.geolibre-import.${idempotencyKey}`;
}

function loadCheckpoint(storage, idempotencyKey) {
  if (!storage) return null;
  try {
    return JSON.parse(storage.getItem(checkpointKey(idempotencyKey)) ?? "null");
  } catch {
    return null;
  }
}

function saveCheckpoint(storage, checkpoint) {
  storage?.setItem(checkpointKey(checkpoint.idempotencyKey), JSON.stringify(checkpoint));
}

function removeCheckpoint(storage, idempotencyKey) {
  storage?.removeItem(checkpointKey(idempotencyKey));
}

function assertCheckpoint(checkpoint, prepared) {
  if (checkpoint.sourceSha256 !== prepared.sourceSha256 || checkpoint.planDigest !== prepared.planDigest) {
    throw codedError("project_import_checkpoint_mismatch", "Stored import checkpoint does not match this project");
  }
}

function safeLocalStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
