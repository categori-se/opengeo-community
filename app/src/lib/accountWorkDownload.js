import {zipSync, strToU8} from "fflate";
import {createPublicationSourceArchive, publicationSourceExportContext} from "./publicationSourceArchive.js";
import {createPublicationSourceDownloadReader, planPublicationSourceDownload} from "./publicationSourceDownload.js";
import {savedProjectVersionFile} from "./projectFileFormat.js";
import {serializeSavedCollection} from "./collectionExport.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX = Object.freeze({maxItems: 32, maxSourceBytes: 67_108_864, maxFileReads: 256,
  maxMetadataRequests: 100, maxDiscoveryRecords: 200, maxArchiveBytes: 100_663_296, maxDurationMs: 120_000});
const EXCLUSIONS = Object.freeze({projectDefinitions: false, savedHistory: true, linkedBytes: true,
  unsavedBuffers: true, compiledOutputs: true, collections: true, catalog: true, nonSourcePublications: true});
const contexts = new WeakMap();
const SOURCE_INVENTORY_BYTES = 1_048_576, REVISION_INVENTORY_BYTES = 2_097_152;
const PROJECT_DEFINITION_BYTES = 524_288;
const REMOTE_SOURCE_TYPES = new Set(["xyz", "wms", "pmtiles", "geojson", "arcgis", "wfs", "imageserver", "mapserver", "cog"]);
const REMOTE_SOURCE_FIELDS = ["datasetId", "projectId", "name", "description", "classification", "status", "ownerUserId",
  "sourceType", "accessMode", "credentialMode", "versionNumber", "sourceUrl", "configuration", "verificationState", "createdAt", "updatedAt"];
const REPOSITORY_SOURCE_FIELDS = ["datasetId", "connectionId", "connectionTargetRevision", "provider", "bucketName", "regionName",
  "objectPrefix", "relativePath", "providerVersionId", "sizeBytes", "lastModified", "contentType", "etag", "storageClass",
  "providerChecksumSha256", "createdBy", "createdAt"];
async function catalogSourceReference(adapter, record, scope, read, signal) {
  if (identity(record.ownerUserId, "Catalog owner") !== scope.ownerUserId) throw error("Catalog ownership changed");
  if (record.sourceType === "upload") return {state: "not-applicable"};
  const repository = record.sourceType === "repository";
  if (!repository && !REMOTE_SOURCE_TYPES.has(record.sourceType)) throw error("Registered source representation is unsupported");
  const kind = repository ? "repository-object" : "remote-reference";
  const method = repository ? adapter.getRepositoryObjectSource : adapter.getSource;
  if (typeof method !== "function") throw error("Registered source metadata is unavailable");
  let source;
  try {source = await read(() => method.call(adapter, record.projectId, record.id, {signal}));}
  catch (cause) {
    if (cause?.status === 404) return {state: "unavailable", kind, reason: "not-found-or-not-readable"};
    throw cause;
  }
  const fields = repository ? REPOSITORY_SOURCE_FIELDS : REMOTE_SOURCE_FIELDS;
  if (!source || Object.keys(source).some(key => !fields.includes(key) && !(key === "capabilities" && !repository))
    || source.datasetId !== record.id) throw error("Registered source identity or connection material is invalid");
  if (repository) {
    if (!UUID.test(source.connectionId ?? "") || !Number.isSafeInteger(source.connectionTargetRevision)
      || source.connectionTargetRevision < 1 || source.provider !== "s3"
      || typeof source.providerVersionId !== "string" || !source.providerVersionId || source.providerVersionId === "null") {
      throw error("Repository source pins are invalid");
    }
  } else if (source.projectId !== record.projectId || source.ownerUserId !== scope.ownerUserId
    || source.sourceType !== record.sourceType || source.accessMode !== "direct_browser" || source.credentialMode !== "none"
    || source.verificationState !== "syntax_only" || !Number.isSafeInteger(source.versionNumber) || source.versionNumber < 1) {
    throw error("Registered source ownership, mode or revision changed");
  }
  // Maintained SDK methods validate the representation. Export only their closed,
  // non-secret descriptor fields; no provider inspection or connection resolution.
  const descriptor = Object.fromEntries(fields.filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));
  return publicationSourceExportContext({state: "registered", kind, descriptor});
}
function catalogExport(record, knowledge, scope, registeredSource) {
  if (identity(record?.ownerUserId, "Catalog owner") !== scope.ownerUserId
    || !UUID.test(record?.projectId ?? "") || typeof record.updatedAt !== "string"
    || knowledge?.datasetId !== record.id || !Number.isSafeInteger(knowledge.version) || knowledge.version < 0
    || !knowledge.document || typeof knowledge.document !== "object") throw error("Catalog ownership or metadata is unavailable");
  const {capabilities: _capabilities, catalogMatchCount: _catalogMatchCount, ...metadata} = record;
  return JSON.stringify(publicationSourceExportContext({schemaVersion: "opengeo.catalog-record-export.1.0.0", scope,
    record: metadata, knowledge: {version: knowledge.version, document: knowledge.document}, registeredSource,
    currentOnly: true, linkedBytesIncluded: false, grantsIncluded: false, rightsGranted: false})) + "\n";
}
function collectionExport(record, scope) {
  if (record?.owner?.principal_type !== "user" || record.owner.principal_id !== scope.ownerUserId) {
    throw error("Collection ownership is unavailable");
  }
  const output = serializeSavedCollection(record), definition = output.definition;
  if (definition.owner.principal_type !== "user" || definition.owner.principal_id !== scope.ownerUserId
    || definition.reference.workspace_id !== `account:${scope.accountId}`) throw error("Collection ownership or account changed");
  return output.text;
}
const error = message => new TypeError(message);
const identity = (value, name) => {if (!UUID.test(value ?? "")) throw error(`${name} is invalid`); return value.toLowerCase();};
function bounds(input = {}) {
  if (Object.keys(input).some(key => !Object.hasOwn(MAX, key))) throw error("Unsupported download limit");
  return Object.freeze(Object.fromEntries(Object.entries(MAX).map(([key, maximum]) => {
    const value = input[key] ?? maximum;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw error(`Invalid ${key}`);
    return [key, value];
  })));
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function boundedInventory(records, maximumRecords, maximumBytes) {
  return Array.isArray(records) && records.length <= maximumRecords
    && new TextEncoder().encode(JSON.stringify(records)).byteLength <= maximumBytes;
}
function projectVersionMetadata(record) {
  return record && Number.isSafeInteger(record.version) && record.version > 0
    && Number.isSafeInteger(record.definitionBytes) && record.definitionBytes >= 2
    && record.definitionBytes <= PROJECT_DEFINITION_BYTES
    && UUID.test(record.createdBy ?? "") && typeof record.createdAt === "string" && record.createdAt.length <= 64
    && (record.changeMessage === null || typeof record.changeMessage === "string" && [...record.changeMessage].length <= 500);
}
function sameProjectVersion(record, reviewed) {
  return projectVersionMetadata(record) && ["version", "definitionBytes", "createdBy", "createdAt", "changeMessage"]
    .every(key => record[key] === reviewed[key]);
}
function publicationRevisionMetadata(record, sourceId) {
  return record && UUID.test(record.id ?? "") && record.sourceProjectId === sourceId
    && Number.isSafeInteger(record.revisionNumber) && record.revisionNumber > 0
    && (record.parentRevisionId === null || UUID.test(record.parentRevisionId ?? ""))
    && typeof record.title === "string" && record.title.length <= 300
    && ["unreviewed", "approved", "rejected"].includes(record.rightsStatus)
    && typeof record.entryPath === "string" && record.entryPath.length <= 512
    && (record.lockfilePath === null || typeof record.lockfilePath === "string" && record.lockfilePath.length <= 512)
    && record.manifest && typeof record.manifest === "object" && !Array.isArray(record.manifest)
    && /^[a-f0-9]{64}$/.test(record.manifestChecksumSha256 ?? "")
    && UUID.test(record.createdBy ?? "") && typeof record.createdAt === "string" && record.createdAt.length <= 64
    && Array.isArray(record.files) && record.files.every(file => file &&
      typeof file.relativePath === "string" && file.relativePath.length <= 512
      && UUID.test(file.sourceObjectId ?? "") && /^[a-f0-9]{64}$/.test(file.checksumSha256 ?? "")
      && typeof file.contentType === "string");
}
function publicationRevisionContext(projectId, source, revision) {
  return publicationSourceExportContext({projectId, sourceProjectId: source.id,
    siteId: source.siteId, routeNamespace: source.routeNamespace,
    title: revision.title, entryPath: revision.entryPath, lockfilePath: revision.lockfilePath,
    rightsStatus: revision.rightsStatus, changeSummary: revision.changeSummary,
    buildPolicy: source.buildPolicy, exportedContent: "saved-source-files",
    savedRevisionId: revision.id, savedRevisionNumber: revision.revisionNumber});
}
function projectDefinitionBytes(definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) throw error("Saved Project definition is invalid");
  const bytes = strToU8(JSON.stringify(definition, (_key, value) => {
    if (typeof value === "number" && !Number.isFinite(value)
      || ["undefined", "function", "symbol", "bigint"].includes(typeof value)
      || value && typeof value === "object" && !Array.isArray(value)
        && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw error("Saved Project definition must contain JSON values only");
    }
    return value;
  }));
  if (bytes.byteLength > PROJECT_DEFINITION_BYTES) throw error("Saved Project definition exceeds its limit");
  return bytes;
}
const sha256 = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
  .map(value => value.toString(16).padStart(2, "0")).join("");
function pending(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Download cancelled", "AbortError"));
    signal.addEventListener("abort", abort, {once: true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
function operationSignal(signal, milliseconds) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, {once: true});
  const timer = setTimeout(() => controller.abort(new DOMException("Download time limit reached", "TimeoutError")), milliseconds);
  return {signal: controller.signal, dispose() {clearTimeout(timer); signal?.removeEventListener("abort", cancel);}};
}
async function capture(adapter, scope, signal, isCurrent) {
  if (typeof adapter?.organizationProvider !== "function" || typeof adapter?.tokenProvider !== "function") {
    throw error("An authenticated account connection is required");
  }
  const {organizationProvider, tokenProvider, baseUrl} = adapter;
  const token = await pending(Promise.resolve().then(() => tokenProvider.call(adapter)), signal);
  const context = {adapter, organizationProvider, tokenProvider, baseUrl, token, scope};
  await assertContext(context, signal, isCurrent);
  return context;
}
async function assertContext(context, signal, isCurrent) {
  signal.throwIfAborted();
  const {adapter, tokenProvider, organizationProvider, baseUrl, scope, token} = context;
  if (!isCurrent() || adapter.tokenProvider !== tokenProvider || adapter.organizationProvider !== organizationProvider
    || adapter.baseUrl !== baseUrl) throw error("The download account or sign-in changed. Review again.");
  const account = await pending(Promise.resolve().then(() => organizationProvider.call(adapter)), signal);
  const currentToken = await pending(Promise.resolve().then(() => tokenProvider.call(adapter)), signal);
  signal.throwIfAborted();
  if (!isCurrent() || identity(account, "Account") !== scope.accountId || currentToken !== token
    || adapter.tokenProvider !== tokenProvider || adapter.organizationProvider !== organizationProvider
    || adapter.baseUrl !== baseUrl) throw error("The download account or sign-in changed. Review again.");
}

/** Metadata inspection is deliberate. Authority to manage a teammate's work is never ownership. */
export async function planAccountSavedPublicationDownload({adapter, accountId, ownerUserId,
  signal: callerSignal, isCurrent = () => true, limits: requestedLimits = {}, includeSavedMapVersions = false,
  includeSavedPublicationVersions = false, includeOwnedMetadata = false}) {
  if (typeof includeSavedMapVersions !== "boolean") throw error("Saved map version selection is invalid");
  if (typeof includeSavedPublicationVersions !== "boolean") throw error("Saved Publication version selection is invalid");
  if (typeof includeOwnedMetadata !== "boolean") throw error("Catalog and Collection selection is invalid");
  const limits = bounds(requestedLimits), operation = operationSignal(callerSignal, limits.maxDurationMs);
  const {signal} = operation;
  try {
    const scope = {accountId: identity(accountId, "Account"), ownerUserId: identity(ownerUserId, "Owner")};
    const context = await capture(adapter, scope, signal, isCurrent);
    let metadataRequests = 0, discovered = 0, sourceBytes = 0, fileReads = 0,
      definitionBytes = 0, definitionReads = 0, sourceArchiveCount = 0, projectPageRequests = 0,
      ownedMetadataBytes = 0, ownedMetadataReads = 0;
    const items = [], unresolved = [], sourceIds = new Set();
    const check = () => assertContext(context, signal, isCurrent);
    const read = async callback => {
      await check();
      if (metadataRequests >= limits.maxMetadataRequests) throw error("Metadata request limit reached");
      metadataRequests++;
      const result = await pending(Promise.resolve().then(callback), signal);
      await check(); return result;
    };
    const note = (kind, id, reason, title) => unresolved.push({kind, ...(id ? {id} : {}),
      ...(typeof title === "string" ? {title: title.slice(0, 300)} : {}), reason});
    const pageSize = 25;
    const pages = async (method, visit, kind) => {
      const seen = new Set();
      for (let offset = 0;; offset += pageSize) {
        if (metadataRequests >= limits.maxMetadataRequests || discovered >= limits.maxDiscoveryRecords) {
          note(kind, null, "discovery-limit"); return;
        }
        let page;
        try {page = await read(() => method({limit: pageSize, offset, signal}));}
        catch {await check(); note(kind, null, "metadata-unavailable"); return;}
        if (!boundedInventory(page, pageSize, SOURCE_INVENTORY_BYTES)) throw error("Account inventory page is invalid");
        for (const record of page) {
          const id = identity(record.id, "Resource");
          if (seen.has(id)) throw error("Account inventory changed during discovery. Review again.");
          seen.add(id);
          if (discovered >= limits.maxDiscoveryRecords) {note(kind, null, "discovery-limit"); return;}
          discovered++;
          await visit(record);
        }
        if (page.length < pageSize) return;
      }
    };
    await pages(options => adapter.listProjects({...options, status: "all"}), async project => {
      let sources;
      try {sources = await read(() => adapter.listObservableSourceProjects(project.id, {signal}));}
      catch {await check(); note("publication-sources", project.id, "metadata-unavailable"); return;}
      if (!boundedInventory(sources, limits.maxDiscoveryRecords, SOURCE_INVENTORY_BYTES)) {
        note("publication-sources", project.id, "source-inventory-over-limit", project.name); return;
      }
      for (const source of sources) {
        if (discovered >= limits.maxDiscoveryRecords) {note("publication-sources", project.id, "discovery-limit"); break;}
        discovered++;
        if (source.projectId !== project.id || sourceIds.has(identity(source.id, "Publication"))) {
          throw error("Publication inventory identity changed");
        }
        sourceIds.add(source.id.toLowerCase());
        if (identity(source.ownerUserId, "Publication owner") !== scope.ownerUserId) continue;
        if (!source.currentRevisionId) {note("publication-source", source.id, "no-saved-revision", source.title); continue;}
        if (items.length >= limits.maxItems) {note("publication-source", source.id, "item-limit", source.title); continue;}
        const pagedRevisions = typeof adapter.listObservableSourceRevisionsPage === "function";
        if (includeSavedPublicationVersions && !pagedRevisions) {
          note("publication-source", source.id, "saved-history-unavailable", source.title); continue;
        }
        const boundedHistory = includeSavedPublicationVersions && pagedRevisions;
        let revisions = [], historyMetadataIssue = null, beforeRevision;
        let revisionPageSize = pagedRevisions ? 1 : 100;
        for (;;) {
          if (metadataRequests >= limits.maxMetadataRequests) {
            historyMetadataIssue = "saved-history-over-limit"; break;
          }
          let page;
          try {page = await read(() => pagedRevisions
            ? adapter.listObservableSourceRevisionsPage(project.id, source.id,
              {limit: revisionPageSize, ...(beforeRevision ? {beforeRevision} : {}), signal})
            : adapter.listObservableSourceRevisions(project.id, source.id, {signal}));}
          catch (cause) {await check(); historyMetadataIssue = cause?.status === 409
            ? "saved-history-over-limit" : "saved-history-unavailable"; break;}
          if (!boundedInventory(page, revisionPageSize, REVISION_INVENTORY_BYTES)
            || !boundedInventory([...revisions, ...page], 100, REVISION_INVENTORY_BYTES)) {
            historyMetadataIssue = "saved-history-over-limit"; break;
          }
          if (beforeRevision && page.some(retained => retained?.revisionNumber >= beforeRevision)) {
            historyMetadataIssue = "saved-history-unavailable"; break;
          }
          if (pagedRevisions && !revisions.length && page.length && (page[0]?.id !== source.currentRevisionId
            || page[0]?.revisionNumber !== source.currentRevisionNumber)) {
            historyMetadataIssue = "saved-head-unavailable"; break;
          }
          revisions.push(...page);
          if (!boundedHistory || page.length < revisionPageSize) break;
          if (revisions.length >= 100) {historyMetadataIssue = "saved-history-over-limit"; break;}
          beforeRevision = page.at(-1)?.revisionNumber;
          if (!Number.isSafeInteger(beforeRevision) || beforeRevision < 1) {
            historyMetadataIssue = "saved-history-unavailable"; break;
          }
          revisionPageSize = Math.min(25, 100 - revisions.length);
        }
        if (!revisions.length && historyMetadataIssue) {
          note("publication-source", source.id, historyMetadataIssue === "saved-history-over-limit"
            ? "revision-inventory-over-limit" : historyMetadataIssue === "saved-head-unavailable"
              ? "saved-head-unavailable" : "revision-metadata-unavailable", source.title); continue;
        }
        const matches = revisions.filter(revision => revision?.id === source.currentRevisionId
          && revision.revisionNumber === source.currentRevisionNumber);
        const revision = matches[0];
        if (matches.length !== 1 || !publicationRevisionMetadata(revision, source.id)) {
          note("publication-source", source.id, "saved-head-unavailable", source.title); continue;
        }
        const savedRevisions = [], estimates = [], historyIssues = new Set();
        let historyComplete = boundedHistory && !historyMetadataIssue;
        const historyNote = reason => {
          historyComplete = false;
          if (!historyIssues.has(reason)) {historyIssues.add(reason); note("publication-source", source.id, reason, source.title);}
        };
        if (boundedHistory && historyMetadataIssue) historyNote(historyMetadataIssue);
        const ids = new Map(), numbers = new Map();
        for (const retained of revisions) {
          ids.set(retained?.id, (ids.get(retained?.id) ?? 0) + 1);
          numbers.set(retained?.revisionNumber, (numbers.get(retained?.revisionNumber) ?? 0) + 1);
        }
        const older = boundedHistory ? revisions.filter(retained => retained !== revision)
          .sort((left, right) => (right?.revisionNumber ?? 0) - (left?.revisionNumber ?? 0)) : [];
        for (const retained of [revision, ...older]) {
          const latest = retained === revision;
          if (!latest && (!publicationRevisionMetadata(retained, source.id)
            || retained.revisionNumber >= revision.revisionNumber || ids.get(retained.id) !== 1
            || numbers.get(retained.revisionNumber) !== 1)) {
            historyNote("saved-history-unavailable"); continue;
          }
          let estimate;
          try {
            publicationSourceExportContext({metadata: publicationRevisionContext(project.id, source, retained),
              artifactReferences: retained.manifest.artifactReferences ?? null, baseRevision: retained});
          } catch {
            if (latest) note("publication-source", source.id, "source-size-unavailable-or-over-limit", source.title);
            else historyNote("saved-history-unavailable");
            if (latest) break;
            continue;
          }
          try {estimate = planPublicationSourceDownload(retained.files);}
          catch {
            if (latest) note("publication-source", source.id, "source-size-unavailable-or-over-limit", source.title);
            else historyNote("saved-history-over-limit");
            if (latest) break;
            continue;
          }
          const archiveUpperBound = sourceBytes + definitionBytes + estimate.totalBytes
            + (sourceArchiveCount + 1 + definitionReads) * 2_097_152 + 524_288;
          if (sourceBytes + definitionBytes + estimate.totalBytes > limits.maxSourceBytes
            || fileReads + definitionReads + estimate.fileReads > limits.maxFileReads
            || archiveUpperBound > limits.maxArchiveBytes) {
            if (latest) note("publication-source", source.id, "byte-or-read-limit", source.title);
            else historyNote("saved-history-over-limit");
            break;
          }
          sourceBytes += estimate.totalBytes; fileReads += estimate.fileReads; sourceArchiveCount++;
          savedRevisions.push(structuredClone(retained)); estimates.push(estimate);
        }
        if (!savedRevisions.length) continue;
        const estimate = {fileCount: estimates.reduce((sum, value) => sum + value.fileCount, 0),
          totalBytes: estimates.reduce((sum, value) => sum + value.totalBytes, 0),
          transferBytes: estimates.reduce((sum, value) => sum + value.transferBytes, 0),
          fileReads: estimates.reduce((sum, value) => sum + value.fileReads, 0)};
        items.push({kind: "publication-source", id: source.id, projectId: project.id, title: source.title,
          revisionId: revision.id, revisionNumber: revision.revisionNumber,
          sourceProject: structuredClone(source), revision: savedRevisions[0], savedRevisions, historyComplete, estimate});
      }
    }, "workspaces");
    await pages(options => {
      projectPageRequests++;
      return adapter.listCompositions({...options, status: "all"});
    }, async record => {
      if (!UUID.test(record.ownerUserId ?? "")) {
        note("project", record.id, "canonical-project-owner-unavailable", record.name); return;
      }
      if (identity(record.ownerUserId, "Project owner") !== scope.ownerUserId) return;
      if (!UUID.test(record.accessContainerId ?? "") || !Number.isSafeInteger(record.version) || record.version < 1
        || !["active", "archived"].includes(record.status) || typeof record.updatedAt !== "string") {
        note("project", record.id, "saved-head-unavailable", record.name); return;
      }
      if (items.length >= limits.maxItems) {note("project", record.id, "item-limit", record.name); return;}
      const savedVersions = [], versionPageSize = includeSavedMapVersions ? 25 : 1;
      let beforeVersion, historyComplete = !includeSavedMapVersions, stopped = false;
      while (!stopped) {
        if (metadataRequests >= limits.maxMetadataRequests) {
          note("project", record.id, savedVersions.length ? "saved-history-over-limit" : "revision-metadata-unavailable", record.name); break;
        }
        let versions;
        try {versions = await read(() => adapter.listCompositionVersions(record.id,
          {limit: versionPageSize, ...(beforeVersion ? {beforeVersion} : {}), signal}));}
        catch {await check(); note("project", record.id, savedVersions.length ? "saved-history-unavailable" : "revision-metadata-unavailable", record.name); break;}
        if (!boundedInventory(versions, versionPageSize, SOURCE_INVENTORY_BYTES)
          || versions.some((version, index) => !projectVersionMetadata(version)
            || beforeVersion !== undefined && version.version >= beforeVersion
            || index > 0 && version.version >= versions[index - 1].version)
          || !savedVersions.length && versions[0]?.version !== record.version) {
          note("project", record.id, savedVersions.length ? "saved-history-unavailable" : "saved-head-unavailable", record.name); break;
        }
        for (const version of versions) {
          const downloadBase = new Set(items.filter(item => item.kind === "publication-source").map(item => item.projectId)).size * 2
            + projectPageRequests * 2;
          const archiveUpperBound = sourceBytes + definitionBytes + version.definitionBytes
            + (sourceArchiveCount + definitionReads + 1) * 2_097_152 + 524_288;
          if (sourceBytes + definitionBytes + version.definitionBytes > limits.maxSourceBytes
            || fileReads + definitionReads + 1 > limits.maxFileReads
            || downloadBase + definitionReads + 1 > limits.maxMetadataRequests
            || archiveUpperBound > limits.maxArchiveBytes) {
            note("project", record.id, savedVersions.length ? "saved-history-over-limit" : "byte-or-read-limit", record.name);
            stopped = true; break;
          }
          definitionBytes += version.definitionBytes; definitionReads++;
          savedVersions.push(structuredClone(version));
        }
        if (stopped) break;
        if (!includeSavedMapVersions || versions.length < versionPageSize) {
          historyComplete = true; break;
        }
        beforeVersion = versions.at(-1).version;
      }
      if (!savedVersions.length) return;
      items.push({kind: "project", id: record.id, projectId: record.accessContainerId, title: record.name,
        version: record.version, composition: structuredClone(record), savedVersion: savedVersions[0], savedVersions,
        historyComplete, estimate: {totalBytes: savedVersions.reduce((sum, version) => sum + version.definitionBytes, 0),
          definitionReads: savedVersions.length}});
    }, "projects");
    const baseDownloadReads = new Set(items.filter(item => item.kind === "publication-source").map(item => item.projectId)).size * 2
      + (items.some(item => item.kind === "project") ? projectPageRequests * 2 + definitionReads : 0);
    const canReviewMetadata = (kind, record, reads) => {
      if (items.length >= limits.maxItems) {note(kind, record.id, "item-limit", record.name ?? record.title); return false;}
      if (baseDownloadReads + ownedMetadataReads + reads > limits.maxMetadataRequests) {
        note(kind, record.id, "metadata-read-limit", record.name ?? record.title); return false;
      }
      return true;
    };
    const addMetadata = (kind, record, text, reads) => {
      const sizeBytes = strToU8(text).byteLength;
      if (sourceBytes + definitionBytes + ownedMetadataBytes + sizeBytes > limits.maxSourceBytes
        || sourceBytes + definitionBytes + ownedMetadataBytes + sizeBytes
          + (sourceArchiveCount + definitionReads) * 2_097_152 + 524_288 > limits.maxArchiveBytes) {
        note(kind, record.id, "byte-or-read-limit", record.name ?? record.title); return;
      }
      ownedMetadataBytes += sizeBytes; ownedMetadataReads += reads;
      items.push({kind, id: record.id, title: record.name ?? record.title, text,
        ...(kind === "catalog-record" ? {projectId: record.projectId} : {revision: record.revision}),
        estimate: {totalBytes: sizeBytes, metadataReads: reads}});
    };
    if (includeOwnedMetadata) {
      if (typeof adapter.searchDatasets !== "function" || typeof adapter.getCatalogDataset !== "function"
        || typeof adapter.getDatasetKnowledge !== "function") note("catalog", null, "metadata-unavailable");
      else await pages(options => adapter.searchDatasets({...options, ownerUserId: scope.ownerUserId}), async record => {
        if (!UUID.test(record.ownerUserId ?? "")) {note("catalog-record", record.id, "canonical-owner-unavailable"); return;}
        if (identity(record.ownerUserId, "Catalog owner") !== scope.ownerUserId) return;
        const reads = record.sourceType === "upload" ? 4 : 6;
        if (!canReviewMetadata("catalog-record", record, reads)) return;
        try {
          const canonical = await read(() => adapter.getCatalogDataset(record.id));
          if (canonical.id !== record.id) throw error("Catalog identity changed");
          const knowledge = await read(() => adapter.getDatasetKnowledge(record.id, {signal}));
          if (canonical.sourceType !== record.sourceType) throw error("Catalog source representation changed");
          const registeredSource = await catalogSourceReference(adapter, canonical, scope, read, signal);
          if (registeredSource.state === "unavailable") note("catalog-record", record.id, "registered-source-unavailable", record.name);
          addMetadata("catalog-record", canonical, catalogExport(canonical, knowledge, scope, registeredSource), reads);
        } catch {await check(); note("catalog-record", record.id, "metadata-definition-unavailable", record.name);}
      }, "catalog");
      if (typeof adapter.listCollections !== "function" || typeof adapter.getCollection !== "function") {
        note("collections", null, "metadata-unavailable");
      } else await pages(options => adapter.listCollections(options), async record => {
        if (!record.owner) {note("collection", record.id, "canonical-owner-unavailable"); return;}
        if (["team", "organization"].includes(record.owner.principal_type)) {note("collection", record.id, "non-user-owner"); return;}
        if (record.owner.principal_type !== "user" || !UUID.test(record.owner.principal_id ?? "")) {
          note("collection", record.id, "canonical-owner-unavailable"); return;
        }
        if (identity(record.owner.principal_id, "Collection owner") !== scope.ownerUserId) return;
        if (!canReviewMetadata("collection", record, 2)) return;
        try {
          const saved = await read(() => adapter.getCollection(record.id));
          if (saved.id !== record.id || saved.revision !== record.revision) throw error("Collection revision changed");
          addMetadata("collection", saved, collectionExport(saved, scope), 2);
        } catch {await check(); note("collection", record.id, "metadata-definition-unavailable", record.title);}
      }, "collections");
    }
    const projects = items.filter(item => item.kind === "project"),
      publications = items.filter(item => item.kind === "publication-source");
    const downloadMetadataRequests = new Set(publications.map(item => item.projectId)).size * 2
      + (projects.length ? projectPageRequests * 2 + definitionReads : 0) + ownedMetadataReads;
    if (downloadMetadataRequests > limits.maxMetadataRequests) throw error("Download metadata requests exceed the limit");
    const archiveBytesUpperBound = sourceBytes + definitionBytes + ownedMetadataBytes
      + (sourceArchiveCount + definitionReads) * 2_097_152 + 524_288;
    const projectSavedHistory = !includeSavedMapVersions || projects.some(item => !item.historyComplete)
      || unresolved.some(item => item.kind === "project" || item.kind === "projects");
    const publicationSavedHistory = !includeSavedPublicationVersions || publications.some(item => !item.historyComplete)
      || unresolved.some(item => ["workspaces", "publication-sources", "publication-source"].includes(item.kind));
    const plan = freeze({schemaVersion: "opengeo.account-saved-content-download-plan.1.0.0", scope,
      items, unresolved, estimate: {sourceBytes: sourceBytes + definitionBytes + ownedMetadataBytes, publicationSourceBytes: sourceBytes,
        ownedMetadataBytes,
        projectDefinitionBytes: definitionBytes, projectDefinitionReads: definitionReads, savedMapVersions: definitionReads,
        savedPublicationVersions: sourceArchiveCount, publicationArchiveCount: sourceArchiveCount,
        fileReads, metadataRequests, downloadMetadataRequests, archiveBytesUpperBound},
      limits, includeSavedMapVersions, includeSavedPublicationVersions, includeOwnedMetadata,
      exclusions: {...EXCLUSIONS, projectSavedHistory, publicationSavedHistory,
        savedHistory: includeOwnedMetadata || projectSavedHistory || publicationSavedHistory,
        catalog: !includeOwnedMetadata, collections: !includeOwnedMetadata,
        catalogHistory: true, collectionHistory: true, sourceConnections: true,
        registeredSourceReferences: !includeOwnedMetadata,
        connectionCredentials: true, nonUserOwnedCollections: true}, complete: false});
    if (archiveBytesUpperBound > limits.maxArchiveBytes) throw error("Estimated archive exceeds the download limit");
    contexts.set(plan, context);
    return plan;
  } finally {operation.dispose();}
}

/** Export saved source bytes and owned Project definitions without reading linked data. */
export async function createAccountSavedPublicationDownload({adapter, plan, signal: callerSignal,
  isCurrent = () => true, onProgress = () => {}}) {
  const context = contexts.get(plan);
  if (!context || context.adapter !== adapter || !plan.items.length) throw error("Review saved content before downloading");
  const operation = operationSignal(callerSignal, plan.limits.maxDurationMs), {signal} = operation;
  try {
    const check = () => assertContext(context, signal, isCurrent);
    const publications = plan.items.filter(item => item.kind === "publication-source"),
      projects = plan.items.filter(item => item.kind === "project");
    let metadataRequests = 0;
    const read = async callback => {
      await check();
      if (metadataRequests >= plan.estimate.downloadMetadataRequests || metadataRequests >= plan.limits.maxMetadataRequests) {
        throw error("Download metadata request limit reached. Review again.");
      }
      metadataRequests++;
      const result = await pending(Promise.resolve().then(callback), signal);
      await check(); return result;
    };
    const verifyProjectHeads = async () => {
      if (!projects.length) return;
      const remaining = new Map(projects.map(item => [item.id, item])), seen = new Set();
      for (let offset = 0;; offset += 25) {
        const records = await read(() => adapter.listCompositions({limit: 25, offset, status: "all", signal}));
        if (!boundedInventory(records, 25, SOURCE_INVENTORY_BYTES)) throw error("Project inventory exceeds its review limit");
        for (const record of records) {
          const id = identity(record.id, "Project");
          if (seen.has(id) || seen.size >= plan.limits.maxDiscoveryRecords) {
            throw error("Project inventory changed. Review again.");
          }
          seen.add(id);
          const item = remaining.get(record.id);
          if (!item) continue;
          if (record.ownerUserId !== plan.scope.ownerUserId || record.version !== item.version
            || record.accessContainerId !== item.projectId || record.status !== item.composition.status
            || record.updatedAt !== item.composition.updatedAt) {
            throw error("Saved Project ownership or version changed. Review again.");
          }
          remaining.delete(record.id);
        }
        if (!remaining.size) return;
        if (records.length < 25) throw error("Saved Project ownership or version changed. Review again.");
      }
    };
    const verifyHeads = async () => {
      for (const projectId of new Set(publications.map(item => item.projectId))) {
        const sources = await read(() => adapter.listObservableSourceProjects(projectId, {signal}));
        if (!boundedInventory(sources, plan.limits.maxDiscoveryRecords, SOURCE_INVENTORY_BYTES)) {
          throw error("Publication inventory exceeds its review limit");
        }
        for (const item of publications.filter(value => value.projectId === projectId)) {
          const matches = sources.filter(source => source.id === item.id), current = matches[0];
          if (matches.length !== 1 || current.projectId !== projectId || current.ownerUserId !== plan.scope.ownerUserId
            || current.currentRevisionId !== item.revisionId || current.currentRevisionNumber !== item.revisionNumber) {
            throw error("Saved publication ownership or version changed. Review again.");
          }
        }
      }
      await verifyProjectHeads();
      for (const item of plan.items.filter(item => ["catalog-record", "collection"].includes(item.kind))) {
        let text;
        if (item.kind === "catalog-record") {
          const record = await read(() => adapter.getCatalogDataset(item.id));
          if (record.id !== item.id) throw error("Catalog identity changed. Review again.");
          const knowledge = await read(() => adapter.getDatasetKnowledge(item.id, {signal}));
          const registeredSource = await catalogSourceReference(adapter, record, plan.scope, read, signal);
          text = catalogExport(record, knowledge, plan.scope, registeredSource);
        } else {
          const record = await read(() => adapter.getCollection(item.id));
          if (record.id !== item.id || record.revision !== item.revision) throw error("Collection revision changed. Review again.");
          text = collectionExport(record, plan.scope);
        }
        if (text !== item.text) throw error("Saved metadata ownership or revision changed. Review again.");
      }
    };
    await verifyHeads();
    const entries = Object.create(null), exported = [];
    let packedBytes = 0;
    for (const [index, item] of plan.items.entries()) {
      await check();
      if (["catalog-record", "collection"].includes(item.kind)) {
        onProgress(`Packing saved ${item.kind === "collection" ? "Collection" : "Catalog metadata"}: ${item.title}`);
        const bytes = strToU8(item.text), path = item.kind === "collection"
          ? `collections/${item.id}/saved-collection.json` : `catalog/${item.id}/catalog-record.json`;
        packedBytes += bytes.byteLength;
        if (packedBytes + 524_288 > plan.limits.maxArchiveBytes) throw error("Account source archive exceeds its limit");
        entries[path] = bytes;
        exported.push({kind: item.kind, id: item.id, path, sizeBytes: bytes.byteLength, checksumSha256: await sha256(bytes),
          ...(item.kind === "collection" ? {revision: item.revision} : {projectId: item.projectId})});
        continue;
      }
      if (item.kind === "project") {
        for (const reviewedVersion of item.savedVersions) {
          onProgress(`Reading saved Project ${index + 1} of ${plan.items.length}: ${item.title} · v${reviewedVersion.version}`);
          const saved = structuredClone(await read(() => adapter.getCompositionVersion(item.id, reviewedVersion.version, {signal})));
          if (!sameProjectVersion(saved, reviewedVersion)) throw error("Saved Project version changed. Review again.");
          const definition = projectDefinitionBytes(saved.definition);
          if (definition.byteLength > reviewedVersion.definitionBytes) throw error("Saved Project definition exceeds its reviewed size");
          const definitionChecksumSha256 = await sha256(definition);
          await check();
          const metadata = publicationSourceExportContext({
            scope: plan.scope, project: {id: item.id, accessContainerId: item.projectId,
              ownerUserId: item.composition.ownerUserId, name: item.title,
              description: item.composition.description ?? null, status: item.composition.status,
              version: item.version, updatedAt: item.composition.updatedAt}, savedVersion: reviewedVersion,
            definitionEncoding: "json-utf8", definitionChecksumSha256,
            linkedBytesIncluded: false, grantsIncluded: false, rightsGranted: false});
          const envelope = JSON.parse(savedProjectVersionFile(item.id, saved));
          const bytes = strToU8(JSON.stringify({...metadata, ...envelope}) + "\n");
          packedBytes += bytes.byteLength;
          if (packedBytes + 524_288 > plan.limits.maxArchiveBytes) throw error("Account source archive exceeds its limit");
          const path = saved.version === item.version ? `projects/${item.id}/saved-project.json`
            : `projects/${item.id}/versions/v${saved.version}.opengeo-project.json`;
          entries[path] = bytes;
          exported.push({kind: item.kind, id: item.id, projectId: item.projectId, version: saved.version,
            path, sizeBytes: bytes.byteLength, definitionSizeBytes: definition.byteLength,
            definitionChecksumSha256, checksumSha256: await sha256(bytes)});
        }
        continue;
      }
      for (const revision of item.savedRevisions) {
        onProgress(`Reading saved publication ${index + 1} of ${plan.items.length}: ${item.title} · v${revision.revisionNumber}`);
        const reader = createPublicationSourceDownloadReader({adapter, projectId: item.projectId, sourceProjectId: item.id,
          sourceRevisionId: revision.id, signal, isCurrent});
        const files = revision.files.map(file => ({...file}));
        for (const file of files) {await reader.readFile(file); await check();}
        const metadata = publicationRevisionContext(item.projectId, item.sourceProject, revision);
        const {blob} = await createPublicationSourceArchive({files, metadata,
          dataAttachments: revision.dataAttachments ?? [],
          artifactReferences: revision.manifest.artifactReferences ?? null, baseRevision: revision});
        await check();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        packedBytes += bytes.byteLength;
        if (packedBytes + 524_288 > plan.limits.maxArchiveBytes) throw error("Account source archive exceeds its limit");
        const path = revision.id === item.revisionId ? `publications/${item.id}/saved-source.zip`
          : `publications/${item.id}/versions/v${revision.revisionNumber}.saved-source.zip`;
        entries[path] = bytes;
        exported.push({kind: item.kind, id: item.id, projectId: item.projectId, revisionId: revision.id,
          revisionNumber: revision.revisionNumber, path, sizeBytes: bytes.byteLength});
      }
    }
    await check();
    const manifest = publicationSourceExportContext({schemaVersion: "opengeo.account-saved-content-download.1.0.0",
      content: plan.includeOwnedMetadata ? "saved-work-and-owned-metadata" : "saved-publication-sources-and-project-definitions", scope: plan.scope, complete: false, exported,
      includeSavedMapVersions: plan.includeSavedMapVersions,
      includeSavedPublicationVersions: plan.includeSavedPublicationVersions,
      includeOwnedMetadata: plan.includeOwnedMetadata,
      unresolved: plan.unresolved, exclusions: plan.exclusions, estimate: plan.estimate,
      costs: {storageReads: "incurred by explicit source downloads", backendSqlWork: "unknown",
        kmsRequests: "unknown", charges: "unknown"},
      grantsIncluded: false, rightsGranted: false});
    entries["opengeo-account-download.json"] = strToU8(JSON.stringify(manifest, null, 2) + "\n");
    entries["README.txt"] = strToU8("Saved work from one OpenGeo Studio account and owner.\n"
      + "Each publications/<id>/saved-source.zip contains exact saved source files and their original revision context.\n"
      + (plan.includeSavedPublicationVersions
        ? "Selected older Publication sources are in publications/<id>/versions/vN.saved-source.zip; unresolved entries disclose unavailable or limited history.\n"
        : "Older Publication source revisions were not selected.\n")
      + "The inner source package reopens as a working draft; its original revision is retained context, not restored identity.\n"
      + "Each projects/<id>/saved-project.json preserves the latest retained composition as JSON with its original Project/version context.\n"
      + (plan.includeSavedMapVersions
        ? "Selected older saved map versions are in projects/<id>/versions/vN.opengeo-project.json; unresolved entries disclose unavailable or limited history.\n"
        : "Older saved map versions were not selected.\n")
      + "Project checksums describe this UTF-8 JSON encoding; the original database JSON text encoding is not retained.\n"
      + "Layer, Style, source, and Artifact references remain references; linked bytes are not read or captured.\n"
      + "This is a partial account content download. See exclusions and unresolved entries in opengeo-account-download.json.\n"
      + (plan.includeOwnedMetadata
        ? "catalog/<id>/catalog-record.json contains current owned Catalog records, recorded knowledge and supported registered source references; collections/<id>/saved-collection.json uses the shared saved Collection definition.\nCurrent metadata only: reference URLs/configuration and repository provider pins grant no access and are not verified. Missing source metadata is explicitly unresolved. Credentials, Catalog/Collection history and connection/import restoration are excluded. Team/Account-owned Collections are excluded. Collection members remain references, including unavailable placeholders; no member titles or member data are bundled.\n"
        : "Catalog records and Collections were not selected.\n")
      + "Unsaved buffers, linked data/map bytes and compiled outputs are excluded.\n"
      + "Project import/identity/permission restoration is not provided by this package.\n"
      + "References grant no access or publication rights. No source is committed to GitHub.\n");
    const bytes = zipSync(entries, {level: 0, mtime: new Date(1980, 0, 1)});
    if (bytes.byteLength > plan.limits.maxArchiveBytes) throw error("Account source archive exceeds its limit");
    await verifyHeads(); await check();
    return {blob: new Blob([bytes], {type: "application/zip"}), manifest,
      filename: `opengeo-saved-content-${plan.scope.accountId}.zip`};
  } finally {operation.dispose();}
}
