const DATABASE_NAME = "opengeo-field-capture-v1";
const STORE_NAME = "submissions";
const DATABASE_VERSION = 2;
const FILE_STORE_NAME = "attachment-files";
const DEFAULT_MAX_RECORDS = 100;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_RECORD_BYTES = 350_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class OfflineCaptureQueue {
  constructor({
    store = createIndexedDbStore(),
    now = () => new Date(),
    maxRecords = DEFAULT_MAX_RECORDS,
    maxBytes = DEFAULT_MAX_BYTES
  } = {}) {
    if (!store || typeof store.list !== "function" || typeof store.put !== "function"
      || typeof store.remove !== "function") {
      throw new TypeError("offline capture store is invalid");
    }
    this.store = store;
    this.now = now;
    this.maxRecords = positiveInteger(maxRecords, "offline capture maxRecords");
    this.maxBytes = positiveInteger(maxBytes, "offline capture maxBytes");
  }

  async enqueue(scope, draft) {
    const partition = capturePartition(scope);
    const record = captureQueueRecord(partition, draft, this.now());
    const records = await this.list(partition);
    const existing = records.find((candidate) => candidate.queueId === record.queueId);
    if (existing) {
      if (canonicalJson(existing.request) !== canonicalJson(record.request)) {
        throw codedError("offline_capture_idempotency_conflict");
      }
      return existing;
    }
    if (records.length >= this.maxRecords) throw codedError("offline_capture_queue_full");
    const nextBytes = records.reduce((total, candidate) => total + byteLength(candidate), 0)
      + byteLength(record);
    if (nextBytes > this.maxBytes) throw codedError("offline_capture_queue_size_exceeded");
    await this.store.put(record);
    return structuredClone(record);
  }

  async list(scope) {
    const partition = capturePartition(scope);
    const records = await this.store.list();
    return records
      .filter((record) => record.organizationId === partition.organizationId
        && record.userId === partition.userId)
      .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt))
      .map((record) => structuredClone(record));
  }

  async remove(scope, submissionId) {
    const partition = capturePartition(scope);
    await this.store.remove(queueId(partition, uuid(submissionId, "submission id")));
  }

  async resolveDeviceFiles(scope, record, resolveFile) {
    const partition = capturePartition(scope);
    if (record.organizationId !== partition.organizationId || record.userId !== partition.userId) throw codedError("offline_attachment_scope_invalid");
    if (!record.deviceAttachments?.length) return record.request;
    if (!resolveFile) throw codedError("offline_attachment_pending");
    const request = structuredClone(record.request);
    const versions = new Map();
    for (const {path, localId} of record.deviceAttachments) {
      if (!versions.has(localId)) versions.set(localId, uuid(await resolveFile(localId, request.projectId), "managed attachment version"));
      let parent = request.feature.properties;
      for (const part of path.slice(0, -1)) {
        if (!parent || !Object.hasOwn(parent, part)) throw codedError("offline_attachment_path_invalid");
        parent = parent[part];
      }
      const key = path.at(-1);
      if (!parent || !Object.hasOwn(parent, key) || parent[key] !== `device-file:${localId}`) throw codedError("offline_attachment_path_invalid");
      parent[key] = versions.get(localId);
    }
    // Persist the exact replay payload before any network submission can commit it.
    await this.store.put({...record, request, deviceAttachments: []});
    return request;
  }
}

export function pendingDeviceAttachments(fields, values, prefix = []) {
  return fields.flatMap(field => {
    const value = values?.[field.name], path = [...prefix, field.name];
    if (field.type === "group") return field.repeat
      ? (Array.isArray(value) ? value.flatMap((entry, index) => pendingDeviceAttachments(field.fields, entry, [...path, index])) : [])
      : pendingDeviceAttachments(field.fields, value, path);
    return field.attachment && typeof value === "string" && value.startsWith("device-file:")
      ? [{path, localId: uuid(value.slice(12), "device attachment id")}] : [];
  });
}

/** Local bytes are drafts, never managed dataset-version identities. */
export class OfflineAttachmentFiles {
  constructor({store = createIndexedDbStore(globalThis.indexedDB, FILE_STORE_NAME)} = {}) {
    this.store = store;
  }

  async list(scope, projectId) {
    const partition = capturePartition(scope);
    return (await this.store.list()).filter(record =>
      record.organizationId === partition.organizationId && record.userId === partition.userId
      && (projectId === undefined || record.projectId === uuid(projectId, "project id")));
  }

  async save(scope, {projectId, classification, file}) {
    const partition = capturePartition(scope);
    if (!offlineCaptureAllowed(classification)) throw codedError("offline_attachment_classification_denied");
    if (!(file instanceof Blob) || file.size <= 0 || file.size > 5 * 1024 * 1024
      || typeof file.name !== "string" || !file.name || file.name.length > 255) {
      throw codedError("offline_attachment_file_invalid");
    }
    const records = await this.list(partition);
    if (records.length >= 20 || records.reduce((total, record) => total + record.file.size, 0) + file.size > 20 * 1024 * 1024) {
      throw codedError("offline_attachment_storage_full");
    }
    const id = crypto.randomUUID();
    const record = {queueId: queueId(partition, id), id, ...partition,
      projectId: uuid(projectId, "project id"), classification, filename: file.name,
      file: file.slice(0, file.size, file.type), createdAt: new Date().toISOString()};
    await this.store.put(record);
    return record;
  }

  async remove(scope, id) {
    await this.store.remove(queueId(capturePartition(scope), uuid(id, "attachment draft id")));
  }

  async register(scope, id, versionId) {
    const record = (await this.list(scope)).find(item => item.id === uuid(id, "attachment draft id"));
    if (!record) throw codedError("offline_attachment_missing");
    const registeredVersionId = uuid(versionId, "managed attachment version");
    if (record.registeredVersionId && record.registeredVersionId !== registeredVersionId) throw codedError("offline_attachment_registration_conflict");
    await this.store.put({...record, registeredVersionId});
  }

  async checkpointRegistration(scope, id, {attemptId, uploadId, checksumSha256}) {
    const key = queueId(capturePartition(scope), uuid(id, "attachment draft id"));
    const attempt = uuid(attemptId, "registration attempt id");
    if (uploadId !== undefined) uuid(uploadId, "upload id");
    if (checksumSha256 !== undefined && !/^[a-f0-9]{64}$/.test(checksumSha256)) throw codedError("offline_attachment_checksum_invalid");
    const change = record => {
      if (!record) throw codedError("offline_attachment_missing");
      if (record.registrationAttemptId && record.registrationAttemptId !== attempt) throw codedError("offline_attachment_registration_unresolved");
      if (record.uploadId && uploadId && record.uploadId !== uploadId) throw codedError("offline_attachment_registration_conflict");
      return {...record, registrationAttemptId: attempt,
        ...(uploadId ? {uploadId} : {}), ...(checksumSha256 ? {checksumSha256} : {})};
    };
    if (!this.store.update) throw codedError("offline_attachment_checkpoint_unavailable");
    await this.store.update(key, change);
  }
}

export function offlineCaptureAllowed(classification) {
  return ["public", "internal"].includes(classification);
}

export function gpsPoint(position) {
  const longitude = position?.coords?.longitude;
  const latitude = position?.coords?.latitude;
  const accuracy = position?.coords?.accuracy;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180
    || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw codedError("gps_position_invalid");
  }
  if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100_000) {
    throw codedError("gps_accuracy_invalid");
  }
  return {
    geometry: {type: "Point", coordinates: [longitude, latitude]},
    accuracyMeters: accuracy
  };
}

export async function currentGpsPoint(geolocation = globalThis.navigator?.geolocation) {
  if (!geolocation || typeof geolocation.getCurrentPosition !== "function") {
    throw codedError("gps_unavailable");
  }
  const position = await new Promise((resolve, reject) => geolocation.getCurrentPosition(
    resolve,
    () => reject(codedError("gps_unavailable")),
    {enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000}
  ));
  return gpsPoint(position);
}

export async function syncCaptureQueue(queue, scope, submit, {resolveDeviceAttachment} = {}) {
  if (!queue || typeof queue.list !== "function" || typeof queue.remove !== "function") {
    throw new TypeError("offline capture queue is invalid");
  }
  if (typeof submit !== "function") throw new TypeError("capture submit operation is required");
  const records = await queue.list(scope);
  let attempted = 0;
  let synced = 0;
  const conflicts = [];
  let stoppedReason;
  for (const record of records) {
    attempted += 1;
    try {
      const request = record.deviceAttachments?.length
        ? await queue.resolveDeviceFiles(scope, record, resolveDeviceAttachment) : record.request;
      await submit(structuredClone(request));
      await queue.remove(scope, record.submissionId);
      synced += 1;
    } catch (error) {
      if (error?.status === 409 || error?.code === "field_submission_idempotency_conflict") {
        conflicts.push(record.submissionId);
        continue;
      }
      stoppedReason = error?.code === "offline_attachment_pending" ? "attachment_pending"
        : ({401: "authentication_required", 403: "access_denied", 422: "validation_failed"})[error?.status];
      break;
    }
  }
  return {
    attempted,
    synced,
    conflicts,
    ...(stoppedReason ? {stoppedReason} : {}),
    pending: (await queue.list(scope)).length
  };
}

export function capturePartition({organizationId, userId}) {
  return {
    organizationId: uuid(organizationId, "organization id"),
    userId: uuid(userId, "user id")
  };
}

function captureQueueRecord(partition, draft, now) {
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) {
    throw new TypeError("offline capture clock is invalid");
  }
  const record = object(draft, "offline capture draft");
  const projectId = uuid(record.projectId, "project id");
  const datasetId = uuid(record.datasetId, "dataset id");
  const formId = uuid(record.formId, "form id");
  const formVersion = positiveInteger(record.formVersion, "form version");
  const submissionId = uuid(record.submissionId, "submission id");
  const supersedesSubmissionId = record.supersedesSubmissionId === null
    || record.supersedesSubmissionId === undefined
    ? null
    : uuid(record.supersedesSubmissionId, "superseded submission id");
  const operation = record.operation ?? "create";
  if (!["create", "update"].includes(operation)) {
    throw new TypeError("offline capture operation is invalid");
  }
  const targetFeatureId = record.targetFeatureId === null
    || record.targetFeatureId === undefined
    ? null
    : uuid(record.targetFeatureId, "target feature id");
  const targetFeatureVersion = record.targetFeatureVersion === null
    || record.targetFeatureVersion === undefined
    ? null
    : positiveInteger(record.targetFeatureVersion, "target feature version");
  if ((operation === "create" && (targetFeatureId || targetFeatureVersion))
    || (operation === "update"
      && (targetFeatureId === null || targetFeatureVersion === null))) {
    throw new TypeError("offline capture operation target is invalid");
  }
  const feature = object(record.feature, "offline capture feature");
  if (feature.type !== "Feature") throw new TypeError("offline capture feature.type is invalid");
  const expectedFeatureId = operation === "create" ? submissionId : targetFeatureId;
  if (feature.id !== undefined && feature.id !== expectedFeatureId) {
    throw new TypeError("offline capture feature id does not match its operation target");
  }
  const geometry = object(feature.geometry, "offline capture geometry");
  if (typeof geometry.type !== "string" || !Array.isArray(geometry.coordinates)) {
    throw new TypeError("offline capture geometry is invalid");
  }
  const properties = object(feature.properties ?? {}, "offline capture properties");
  const request = {
    projectId,
    datasetId,
    formId,
    formVersion,
    submissionId,
    supersedesSubmissionId,
    operation,
    targetFeatureId,
    targetFeatureVersion,
    feature: {
      type: "Feature",
      id: expectedFeatureId,
      geometry: structuredClone(geometry),
      properties: structuredClone(properties)
    }
  };
  if (byteLength(request) > MAX_RECORD_BYTES) {
    throw codedError("offline_capture_record_size_exceeded");
  }
  const deviceAttachments = record.deviceAttachments ?? [];
  if (!Array.isArray(deviceAttachments) || deviceAttachments.length > 64) throw codedError("offline_attachment_path_invalid");
  for (const entry of deviceAttachments) {
    uuid(entry.localId, "device attachment id");
    if (!Array.isArray(entry.path) || !entry.path.length || entry.path.length > 32
      || entry.path.some(part => !(typeof part === "string" && /^[A-Za-z_][A-Za-z0-9_.:-]{0,99}$/.test(part) && !["__proto__", "constructor", "prototype"].includes(part))
        && !(Number.isSafeInteger(part) && part >= 0))) throw codedError("offline_attachment_path_invalid");
  }
  if (byteLength({request, deviceAttachments}) > MAX_RECORD_BYTES) throw codedError("offline_capture_record_size_exceeded");
  return {
    queueId: queueId(partition, submissionId),
    organizationId: partition.organizationId,
    userId: partition.userId,
    submissionId,
    queuedAt: now.toISOString(),
    request,
    ...(deviceAttachments.length ? {deviceAttachments: structuredClone(deviceAttachments)} : {})
  };
}

function queueId(partition, submissionId) {
  return `${partition.organizationId}:${partition.userId}:${submissionId}`;
}

function createIndexedDbStore(indexedDb = globalThis.indexedDB, storeName = STORE_NAME) {
  return {
    async update(id, change) {
      const database = await openDatabase(indexedDb);
      try {
        const transaction = database.transaction(storeName, "readwrite");
        const store = transaction.objectStore(storeName);
        const current = await requestResult(store.get(id));
        let updated;
        try {updated = change(current);} catch (error) {transaction.abort();throw error;}
        store.put(structuredClone(updated));
        await transactionDone(transaction);
      } finally {database.close();}
    },
    async list() {
      const database = await openDatabase(indexedDb);
      try {
        return await requestResult(database.transaction(storeName).objectStore(storeName).getAll());
      } finally {
        database.close();
      }
    },
    async put(record) {
      const database = await openDatabase(indexedDb);
      try {
        const transaction = database.transaction(storeName, "readwrite");
        if (storeName === FILE_STORE_NAME) {
          const existing = await requestResult(transaction.objectStore(storeName).getAll());
          const own = existing.filter(item => item.organizationId === record.organizationId && item.userId === record.userId && item.queueId !== record.queueId);
          if (own.length >= 20 || own.reduce((total, item) => total + item.file.size, 0) + record.file.size > 20 * 1024 * 1024) {
            transaction.abort();
            throw codedError("offline_attachment_storage_full");
          }
        }
        transaction.objectStore(storeName).put(structuredClone(record));
        await transactionDone(transaction);
      } finally {
        database.close();
      }
    },
    async remove(id) {
      const database = await openDatabase(indexedDb);
      try {
        const transaction = database.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).delete(id);
        await transactionDone(transaction);
      } finally {
        database.close();
      }
    }
  };
}

function openDatabase(indexedDb) {
  if (!indexedDb || typeof indexedDb.open !== "function") {
    return Promise.reject(codedError("offline_capture_storage_unavailable"));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, {keyPath: "queueId"});
      }
      if (!request.result.objectStoreNames.contains(FILE_STORE_NAME)) {
        request.result.createObjectStore(FILE_STORE_NAME, {keyPath: "queueId"});
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(codedError("offline_capture_storage_unavailable")));
    request.addEventListener("blocked", () => reject(codedError("offline_capture_storage_unavailable")));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(codedError("offline_capture_storage_unavailable")));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", resolve);
    transaction.addEventListener("abort", () => reject(codedError("offline_capture_storage_unavailable")));
    transaction.addEventListener("error", () => reject(codedError("offline_capture_storage_unavailable")));
  });
}

function byteLength(value) {
  return new TextEncoder().encode(canonicalJson(value)).length;
}

function canonicalJson(value) {
  return JSON.stringify(sortObject(value));
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
  }
  return value;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function uuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`${label} is invalid`);
  return value.toLowerCase();
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} is invalid`);
  return value;
}

function codedError(code) {
  return Object.assign(new Error(code), {code});
}
