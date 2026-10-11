import {hashArchiveFileInWorker} from "./archiveHashClient.js";
import {uploadArchiveBlob} from "./archiveUploadApi.js";

export async function runArchiveUpload({api, plan, entries, resume, saveResume, signal,
  assertScope = async () => {}, onProgress = () => {}, hashFile = hashArchiveFileInWorker,
  put = uploadArchiveBlob}) {
  const check = async () => {signal?.throwIfAborted(); await assertScope(); signal?.throwIfAborted();};
  const call = async task => {await check(); const value = await task(); await check(); return value;};
  const files = new Map(entries.map(entry => [entry.path, entry.file]));
  const rows = plan.files.map((file, ordinal) => ({ordinal, path: file.path,
    size_bytes: file.sizeBytes, modified_milliseconds: file.lastModified, sha256: file.sha256,
    destination_id: plan.objects[file.objectIndex].destinationId}));
  // Persist the idempotency key before the first request, including lost responses.
  await saveResume(resume);
  if (!resume.uploadId) {
    const created = await call(() => api.create(resume.creationKey));
    resume = {...resume, uploadId: created.id};
    await saveResume(resume);
  }
  const id = resume.uploadId;
  let status = await call(() => api.status(id));
  if (status.state === "planning") {
    for (let offset = 0; offset < rows.length; offset += 25) {
      await call(() => api.append(id, rows.slice(offset, offset + 25)));
    }
    await call(() => api.seal(id, rows.length, plan.logicalBytes));
  } else {
    const saved = await readArchivePages(after => call(() => api.files(id, after)));
    if (saved.length !== rows.length || saved.some((row, index) =>
      Object.keys(rows[index]).some(key => row[key] !== rows[index][key]))) {
      throw Error("archive_selection_changed");
    }
  }
  if (status.state !== "complete") {
    await call(() => api.start(id));
    let verified = 0;
    for (const object of plan.objects) {
      const ordinal = plan.files.findIndex(file => file.path === object.path);
      const file = files.get(object.path);
      if (!file || file.size !== object.sizeBytes) throw Error("archive_selection_changed");
      const prepared = await call(() => api.prepare(id, ordinal));
      const report = (phase, loaded = 0, total = file.size) => onProgress({phase,
        path: object.path, loaded, total, verifiedObjects: verified, totalObjects: plan.objects.length});
      if (prepared.state !== "complete" && prepared.state !== "completing") {
        if (prepared.single) {
          report("uploading");
          await check();
          await put(prepared.single, file, {signal, onProgress: value => report("uploading", value.uploadedBytes)});
        } else {
          if (!Number.isSafeInteger(prepared.part_bytes) || prepared.part_bytes < 5 * 1024 * 1024
            || !Number.isSafeInteger(prepared.part_count) || prepared.part_count < 1
            || prepared.part_count > 10000 || Math.ceil(file.size / prepared.part_bytes) !== prepared.part_count) {
            throw Error("archive_parts_invalid");
          }
          const remote = new Map();
          let after = 0;
          for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
            const page = await call(() => api.parts(id, ordinal, after));
            for (const part of page.parts) {
              if (!Number.isInteger(part.number) || part.number <= after || remote.has(part.number)) throw Error("archive_parts_invalid");
              remote.set(part.number, part);
            }
            if (page.next_after == null) break;
            if (!Number.isInteger(page.next_after) || page.next_after <= after || pageNumber === 99) throw Error("archive_parts_invalid");
            after = page.next_after;
          }
          for (let number = 1; number <= prepared.part_count; number++) {
            const offset = (number - 1) * prepared.part_bytes;
            const chunk = file.slice(offset, Math.min(offset + prepared.part_bytes, file.size));
            report("checking part", offset);
            await check();
            const sha256 = await hashFile(chunk, {signal});
            const existing = remote.get(number);
            if (existing?.sha256 === sha256 && existing.size === chunk.size) continue;
            const ticket = await call(() => api.part(id, ordinal, number, sha256));
            await check();
            await put(ticket, chunk, {signal, onProgress: value => report("uploading", offset + value.uploadedBytes)});
          }
        }
        await check();
      }
      if (prepared.state !== "complete") {
        report("verifying", file.size);
        await call(() => api.complete(id, ordinal));
      }
      verified++;
      report("verified", file.size);
    }
    await call(() => api.finish(id));
  }
  status = await call(() => api.status(id));
  if (status.state !== "complete") throw Error("archive_upload_incomplete");
  const originals = await readArchivePages(after => call(() => api.manifest(id, after)));
  if (originals.length !== plan.files.length) throw Error("archive_manifest_incomplete");
  return {schema: "opengeo-browser-archive/v1", uploadId: id, files: originals,
    filesystemLimits: plan.filesystemLimits};
}

export async function readArchivePages(fetchPage) {
  const files = [];
  let after = -1;
  for (let page = 0; page < 4001; page++) {
    const result = await fetchPage(after);
    if (!Array.isArray(result.files) || result.files.length > 25) throw Error("archive_page_invalid");
    for (const file of result.files) {
      if (file.ordinal !== files.length) throw Error("archive_page_invalid");
      files.push(file);
    }
    if (result.next_after == null) return files;
    if (!Number.isInteger(result.next_after) || result.next_after <= after
      || result.next_after !== files.length - 1) throw Error("archive_page_invalid");
    after = result.next_after;
  }
  throw Error("archive_page_limit");
}

export async function preserveArchiveManifest({api, uploadId, signal, assertScope = async () => {}, onProgress = () => {}}) {
  const records = [];
  let after = -1;
  for (let page = 0; page < 4001; page++) {
    signal?.throwIfAborted(); await assertScope(); signal?.throwIfAborted();
    const result = await api.preserveManifest(uploadId, after);
    signal?.throwIfAborted(); await assertScope(); signal?.throwIfAborted();
    if (!Array.isArray(result.records) || result.records.length > 25
      || result.records.some(record => record.first_ordinal !== after + 1 || !record.object?.version_id)) {
      throw Error("archive_manifest_invalid");
    }
    records.push(...result.records); onProgress(records.length);
    if (result.next_after == null) {
      const indexes = [];
      for (const destination of new Set(records.map(record => record.destination_id))) {
        signal?.throwIfAborted(); await assertScope(); signal?.throwIfAborted();
        const index = await api.preserveIndex(uploadId, destination);
        signal?.throwIfAborted(); await assertScope(); signal?.throwIfAborted();
        if (index.destination_id !== destination || !index.object?.version_id) throw Error("archive_manifest_invalid");
        indexes.push(index);
      }
      return {records, indexes};
    }
    if (result.next_after !== after + 25 || page === 4000) throw Error("archive_page_invalid");
    after = result.next_after;
  }
  throw Error("archive_page_limit");
}
