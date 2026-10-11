import {sha256} from "@noble/hashes/sha2.js";
import {archiveRelativePath} from "./archiveUploadPlan.js";

// Only called by the explicit restore action. Files stream to a selected empty
// directory; duplicate originals copy already verified local bytes, not another GET.
export async function restoreArchive({api, uploadId, files, directory, signal,
  assertScope = async () => {}, onProgress = () => {}, fetchImpl = fetch}) {
  const check = async () => {signal?.throwIfAborted(); await assertScope(); signal?.throwIfAborted();};
  await check();
  if (!files?.length || files.length > 100000) throw Error("archive_manifest_invalid");
  const paths = new Set();
  for (const file of files) {
    archiveRelativePath(file.path);
    if (paths.has(file.path) || !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0
      || !/^[a-f0-9]{64}$/.test(file.sha256) || !file.object?.version_id) throw Error("archive_manifest_invalid");
    paths.add(file.path);
  }
  for await (const unused of directory.values()) {void unused; throw Error("archive_restore_folder_not_empty");}
  const local = new Map();
  let completed = 0, downloadedBytes = 0;
  for (const file of files) {
    await check();
    // Reauthorize even local duplicate copies, so a revoked account stops the task.
    const authorized = await api.restore(uploadId, file.ordinal);
    await check();
    if (authorized.path !== file.path || authorized.size_bytes !== file.size_bytes
      || authorized.sha256 !== file.sha256 || authorized.object?.bucket !== file.object.bucket
      || authorized.object?.key !== file.object.key || authorized.object?.version_id !== file.object.version_id) {
      throw Error("archive_restore_identity_changed");
    }
    const identity = JSON.stringify([file.object.bucket, file.object.key, file.object.version_id]);
    const previous = local.get(identity);
    let stream;
    if (previous) stream = (await previous.getFile()).stream();
    else {
      const ticket = authorized.ticket, url = new URL(ticket?.url);
      if (ticket.method !== "GET" || url.origin !== "https://s3.us-east-1.amazonaws.com"
        || url.username || url.password || url.hash || !url.searchParams.has("X-Amz-Signature")
        || url.searchParams.get("versionId") !== file.object.version_id
        || !ticket.headers || Object.keys(ticket.headers).some(key => key !== "x-amz-expected-bucket-owner")) {
        throw Error("archive_download_ticket_invalid");
      }
      const response = await fetchImpl(url.href, {method: "GET", headers: ticket.headers,
        credentials: "omit", redirect: "error", cache: "no-store", signal});
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel(); throw Error("archive_download_unavailable");
      }
      stream = response.body;
    }
    const reader = stream.getReader(), hash = sha256.create();
    let parent = directory, handle, writer, length = 0, committed = false;
    const segments = file.path.split("/"), name = segments.pop();
    try {
      for (const segment of segments) parent = await parent.getDirectoryHandle(segment, {create: true});
      try {await parent.getFileHandle(name); throw Error("archive_restore_path_exists");}
      catch (error) {if (error.name !== "NotFoundError") throw error;}
      handle = await parent.getFileHandle(name, {create: true});
      writer = await handle.createWritable();
      while (true) {
        await check();
        const {value, done} = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > file.size_bytes) throw Error("archive_restore_size_mismatch");
        for (let offset = 0; offset < value.byteLength; offset += 4 * 1024 * 1024) {
          const chunk = value.subarray(offset, offset + 4 * 1024 * 1024);
          hash.update(chunk); await writer.write(chunk);
        }
        if (!previous) downloadedBytes += value.byteLength;
        onProgress({path: file.path, bytes: length, completed, totalFiles: files.length, downloadedBytes});
      }
      const digest = Array.from(hash.digest(), byte => byte.toString(16).padStart(2, "0")).join("");
      if (length !== file.size_bytes || digest !== file.sha256) throw Error("archive_restore_checksum_mismatch");
      await check(); await writer.close(); committed = true;
      local.set(identity, handle); completed++;
      onProgress({path: file.path, bytes: length, completed, totalFiles: files.length, downloadedBytes});
    } finally {
      hash.destroy(); await reader.cancel().catch(() => {});
      if (!committed) {
        await writer?.abort().catch(() => {});
        if (handle) await parent.removeEntry(name);
      }
    }
  }
  return {files: completed, downloadedBytes};
}
