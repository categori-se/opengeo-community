import {createPublicationSourceArchive, readPublicationSourceArchive, publicationSourceExportContext,
  choosePublicationBackupContextPath} from "./publicationSourceArchive.js";
import {normalizeObservableSourceFiles, normalizeObservableRevisionAttachments,
  validateStaticPublicationTree, validateJupyterPublicationTree} from "./apiClient.js";

const SCHEMA = "opengeo.publication-source-history.1.0.0";
const RECEIPT = "opengeo.source-history-restore.1.0.0";
const SHA = /^[0-9a-f]{64}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalid = message => new TypeError(message);
const digest = async blob => [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))]
  .map(byte => byte.toString(16).padStart(2, "0")).join("");
const assertCurrent = current => {if (!current()) throw invalid("The Source history workspace changed. Review again.");};

function canonicalHistory(sourceProject, revisions) {
  if (!UUID.test(sourceProject?.id) || !Number.isSafeInteger(sourceProject.currentRevisionNumber)
    || sourceProject.currentRevisionNumber < 1 || sourceProject.currentRevisionNumber > 100
    || !Array.isArray(revisions) || revisions.length !== sourceProject.currentRevisionNumber) {
    throw invalid("History must include every saved revision, up to 100. No partial history is supported.");
  }
  const ordered = [...revisions].sort((a, b) => a.revisionNumber - b.revisionNumber);
  let parent = null;
  for (const [index, revision] of ordered.entries()) {
    if (!UUID.test(revision.id) || revision.sourceProjectId !== sourceProject.id || revision.revisionNumber !== index + 1
      || revision.parentRevisionId !== parent || !UUID.test(revision.createdBy) || !Number.isFinite(Date.parse(revision.createdAt))
      || !["unreviewed", "approved", "rejected"].includes(revision.rightsStatus)
      || typeof revision.title !== "string" || !revision.title.trim() || revision.title.length > 300
      || typeof revision.changeSummary !== "string" || !revision.changeSummary.trim() || revision.changeSummary.length > 500
      || !SHA.test(revision.manifestChecksumSha256) || !revision.manifest || typeof revision.manifest !== "object") {
      throw invalid("Saved history identities, parent chain or recorded context are incomplete.");
    }
    if (revision.dataAttachments !== undefined && !Array.isArray(revision.dataAttachments)
      || revision.manifest.dataAttachments !== undefined && !Array.isArray(revision.manifest.dataAttachments)
      || (revision.dataAttachments ?? []).length || (revision.manifest.dataAttachments ?? []).length
      || revision.referencedFiles !== undefined && !Array.isArray(revision.referencedFiles)
      || revision.manifest.referencedFiles !== undefined && !Array.isArray(revision.manifest.referencedFiles)
      || (revision.referencedFiles ?? []).length || (revision.manifest.referencedFiles ?? []).length
      || (revision.manifest.artifactReferences?.references ?? []).length) {
      throw invalid("History has pinned dependencies. Their authorized history restoration is not supported yet; nothing will be written.");
    }
    const files = normalizeObservableSourceFiles(revision.files.map(file => ({relativePath: file.relativePath,
      contentType: file.contentType, blob: new Blob(["x"], {type: file.contentType})})));
    normalizeObservableRevisionAttachments([], files);
    if (files.length !== revision.files.length || files.length > 127 || !files.some(file => file.relativePath === revision.entryPath)
      || revision.lockfilePath !== null && (revision.lockfilePath !== "package-lock.json" || !files.some(file => file.relativePath === revision.lockfilePath))) {
      throw invalid("Every revision needs its original entry and at most 127 files, reserving restoration context.");
    }
    for (const file of revision.files) if (!SHA.test(file.checksumSha256)
      || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1 || file.sizeBytes > 4_194_304) {
      throw invalid("A saved file lacks bounded exact size and checksum facts.");
    }
    parent = revision.id;
  }
  if (parent !== sourceProject.currentRevisionId) throw invalid("The Source head does not match its complete history.");
  return ordered;
}

export function planSourceHistoryBackup({sourceProject, revisions}) {
  const ordered = canonicalHistory(sourceProject, revisions), objects = new Map();
  const metadata = publicationSourceExportContext({schemaVersion: SCHEMA, content: "saved-source-file-history",
    sourceProject: {id: sourceProject.id, projectId: sourceProject.projectId, siteId: sourceProject.siteId,
      title: sourceProject.title, currentRevisionId: sourceProject.currentRevisionId,
      currentRevisionNumber: sourceProject.currentRevisionNumber, buildPolicy: sourceProject.buildPolicy},
    revisions: ordered.map(revision => {
      const {files, supportsFileReuse, ...provenance} = revision;
      return {...provenance, files: files.map(file => {
        const previous = objects.get(file.checksumSha256);
        if (previous && previous.sizeBytes !== file.sizeBytes) throw invalid("A repeated content hash has inconsistent size.");
        if (!previous) objects.set(file.checksumSha256, {...file, revisionId: revision.id,
          archivePath: `objects/${file.checksumSha256}${file.relativePath.slice(file.relativePath.lastIndexOf("."))}`});
        return {relativePath: file.relativePath, contentType: file.contentType, sizeBytes: file.sizeBytes,
          checksumSha256: file.checksumSha256};
      })};
    })});
  const uniqueFiles = [...objects.values()], totalBytes = uniqueFiles.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (uniqueFiles.length > 128 || totalBytes > 16_777_216) throw invalid("History exceeds 128 distinct files or 16 MiB. No partial history is supported.");
  return {metadata, revisions: ordered, uniqueFiles, totalBytes, revisionCount: ordered.length,
    downloadRequests: uniqueFiles.length + 4};
}

async function requireNoReferences(adapter, projectId, sourceProjectId) {
  if (typeof adapter.readPublicationArtifactReferences !== "function") throw invalid("Map-reference history support is unavailable.");
  const references = await adapter.readPublicationArtifactReferences(projectId, sourceProjectId);
  if (references.sourceProjectId !== undefined && references.sourceProjectId !== sourceProjectId
    || references.revision !== 0 || references.references?.length !== 0) {
    throw invalid("This Source has retained map-reference history. Restoring it needs dependency history support; nothing will be written.");
  }
}

export async function createSourceHistoryBackup({adapter, projectId, sourceProject, plan, isCurrent = () => true, onProgress = () => {}}) {
  const checked = planSourceHistoryBackup({sourceProject, revisions: plan.revisions});
  assertCurrent(isCurrent); await requireNoReferences(adapter, projectId, sourceProject.id);
  const files = [];
  for (const [index, file] of checked.uniqueFiles.entries()) {
    assertCurrent(isCurrent); onProgress(`Reading original file ${index + 1} of ${checked.uniqueFiles.length}…`);
    const loaded = await adapter.readObservableSourceRevisionFile(projectId, sourceProject.id, file.revisionId, file.relativePath);
    assertCurrent(isCurrent);
    if (loaded.contentType !== file.contentType || loaded.blob?.size !== file.sizeBytes || await digest(loaded.blob) !== file.checksumSha256) {
      throw invalid("An original history file failed its exact byte check.");
    }
    files.push({relativePath: file.archivePath, contentType: file.contentType, blob: loaded.blob});
  }
  const latest = await adapter.listObservableSourceRevisions(projectId, sourceProject.id);
  assertCurrent(isCurrent);
  if (latest.length !== checked.revisions.length || latest.some(item => !checked.revisions.some(record =>
    record.id === item.id && record.manifestChecksumSha256 === item.manifestChecksumSha256))) {
    throw invalid("Saved history changed during download. Review again.");
  }
  await requireNoReferences(adapter, projectId, sourceProject.id); assertCurrent(isCurrent);
  const result = await createPublicationSourceArchive({files, metadata: checked.metadata});
  assertCurrent(isCurrent); return result;
}

export async function readSourceHistoryBackup(blob) {
  const loaded = await readPublicationSourceArchive(blob), metadata = loaded.manifest.metadata;
  if (metadata.schemaVersion !== SCHEMA || metadata.content !== "saved-source-file-history") throw invalid("Choose an OpenGeo Studio Source file history ZIP.");
  const synthetic = metadata.revisions.map(revision => ({...revision, files: revision.files}));
  const plan = planSourceHistoryBackup({sourceProject: metadata.sourceProject, revisions: synthetic});
  const original = new Map();
  for (const file of loaded.files) original.set(await digest(file.blob), file);
  if (original.size !== loaded.files.length || original.size !== plan.uniqueFiles.length) throw invalid("History objects are missing, duplicated or unreferenced.");
  const revisions = plan.metadata.revisions.map(provenance => {
    const files = provenance.files.map(file => {
      const stored = original.get(file.checksumSha256);
      if (!stored || stored.blob.size !== file.sizeBytes) throw invalid("A revision's original file is missing or changed.");
      return {...file, blob: new Blob([stored.blob], {type: file.contentType})};
    });
    const contextPath = choosePublicationBackupContextPath(provenance.entryPath, files.map(file => file.relativePath));
    const context = publicationSourceExportContext({schemaVersion: "opengeo.source-history-context.1.0.0",
      purpose: "original-history-provenance-only", sourceProject: plan.metadata.sourceProject, revision: provenance});
    files.push({relativePath: contextPath, contentType: "application/json", blob: new Blob([JSON.stringify(context)], {type: "application/json"})});
    const normalized = normalizeObservableSourceFiles(files);
    normalizeObservableRevisionAttachments([], normalized);
    validateStaticPublicationTree(provenance.entryPath, provenance.lockfilePath, normalized, []);
    validateJupyterPublicationTree(provenance.entryPath, provenance.lockfilePath, normalized, []);
    return {revisionNumber: provenance.revisionNumber, title: provenance.title, entryPath: provenance.entryPath,
      lockfilePath: provenance.lockfilePath, files: normalized, provenance};
  });
  return {manifest: plan.metadata, revisions, plan, checksumSha256: await digest(blob)};
}

function checkReceipt(archive, destination, checkpoint) {
  if (!checkpoint || checkpoint.schemaVersion !== RECEIPT || checkpoint.archiveChecksumSha256 !== archive.checksumSha256
    || checkpoint.sourceProjectId !== destination.id || checkpoint.baseRevision !== 0 || !Array.isArray(checkpoint.completed)
    || checkpoint.completed.length > archive.revisions.length) throw invalid("The restore receipt does not match this archive and destination.");
}

export function planSourceHistoryRestore({archive, destination, checkpoint = null}) {
  if (!archive?.revisions?.length || !UUID.test(destination?.id)) throw invalid("Review the complete history and destination first.");
  if (checkpoint) checkReceipt(archive, destination, checkpoint);
  else if (destination.currentRevisionNumber !== 0 || destination.currentRevisionId !== null) {
    throw invalid("Restore history into a new empty private Source. Existing saved revisions are preserved.");
  }
  const totalUploadBytes = archive.revisions.reduce((sum, revision) => sum + revision.files.reduce((size, file) => size + file.blob.size, 0), 0);
  const files = archive.revisions.reduce((sum, revision) => sum + revision.files.length, 0);
  return {revisionCount: archive.revisions.length, totalUploadBytes, maximumUploadRequests: files * 2,
    maximumCommitRequests: archive.revisions.length, maximumReadbackRequests: files + archive.revisions.length * 4};
}

function expectedDraft(archive, index) {
  const revision = archive.revisions[index];
  return {...revision, rightsStatus: "unreviewed", dataAttachments: [],
    changeSummary: `Restore history ${archive.checksumSha256.slice(0, 16)} revision ${revision.revisionNumber}`};
}

async function currentDestination(args) {
  assertCurrent(args.isCurrent ?? (() => true));
  await requireNoReferences(args.adapter, args.projectId, args.sourceProjectId);
  const records = await args.adapter.listObservableSourceRevisions(args.projectId, args.sourceProjectId);
  assertCurrent(args.isCurrent ?? (() => true));
  const ordered = [...records].sort((a, b) => a.revisionNumber - b.revisionNumber);
  const completed = args.checkpoint.completed;
  if (ordered.length < completed.length || ordered.length > completed.length + (args.checkpoint.pending ? 1 : 0)
    || completed.some((record, index) => ordered[index]?.id !== record.id || ordered[index]?.manifestChecksumSha256 !== record.manifestChecksumSha256)
    || ordered.some((record, index) => record.sourceProjectId !== args.sourceProjectId || record.revisionNumber !== index + 1
      || record.parentRevisionId !== (index ? ordered[index - 1].id : null))) {
    throw invalid("Destination history changed. No restore mutation will be repeated.");
  }
  return ordered;
}

export async function reconcileSourceHistoryStep(args) {
  checkReceipt(args.archive, {id: args.sourceProjectId}, args.checkpoint);
  const records = await currentDestination(args), index = args.checkpoint.completed.length;
  if (!args.checkpoint.pending) return args.checkpoint;
  const actual = records[index];
  if (!actual) return args.checkpoint; // A missing response cannot prove the pending commit never ran.
  const expected = expectedDraft(args.archive, index);
  if (args.checkpoint.pending.index !== index || actual.title !== expected.title || actual.rightsStatus !== "unreviewed"
    || actual.entryPath !== expected.entryPath || actual.lockfilePath !== expected.lockfilePath || actual.changeSummary !== expected.changeSummary
    || (actual.dataAttachments ?? []).length || actual.files.length !== expected.files.length) throw invalid("Pending restore does not match saved history. No mutation will be repeated.");
  for (const file of expected.files) {
    const saved = actual.files.find(item => item.relativePath === file.relativePath);
    const checksum = await digest(file.blob);
    if (!saved || saved.sizeBytes !== file.blob.size || saved.contentType !== file.contentType || saved.checksumSha256 !== checksum) {
      throw invalid("A restored revision differs from the verified archive.");
    }
    const loaded = await args.adapter.readObservableSourceRevisionFile(args.projectId, args.sourceProjectId, actual.id, file.relativePath);
    assertCurrent(args.isCurrent ?? (() => true));
    if (loaded.blob?.size !== file.blob.size || loaded.contentType !== file.contentType || await digest(loaded.blob) !== checksum) {
      throw invalid("Restored byte readback did not match. Reconcile this pending save; do not repeat it.");
    }
  }
  const next = {...args.checkpoint, completed: [...args.checkpoint.completed,
    {id: actual.id, revisionNumber: actual.revisionNumber, manifestChecksumSha256: actual.manifestChecksumSha256}], pending: null};
  await args.saveCheckpoint(next); return next;
}

export async function restoreSourceHistoryStep(args) {
  checkReceipt(args.archive, {id: args.sourceProjectId}, args.checkpoint);
  if (args.checkpoint.pending) throw invalid("Reconcile the pending save first. It will not be replayed.");
  const records = await currentDestination(args), index = args.checkpoint.completed.length;
  if (index === args.archive.revisions.length) return args.checkpoint;
  const draft = expectedDraft(args.archive, index);
  const pending = {...args.checkpoint, pending: {index, changeSummary: draft.changeSummary}};
  await args.saveCheckpoint(pending); assertCurrent(args.isCurrent ?? (() => true));
  try {
    await args.adapter.saveObservableSourceRevision(args.projectId, args.sourceProjectId,
      {...draft, expectedRevision: index, reuseRevision: records.at(-1) ?? null});
  } catch {return await reconcileSourceHistoryStep({...args, checkpoint: pending});}
  return await reconcileSourceHistoryStep({...args, checkpoint: pending});
}
