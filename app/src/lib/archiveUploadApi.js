const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = value => {if (!UUID.test(value)) throw Error("archive_identity_invalid"); return value;};
const ordinal = value => {
  if (!Number.isInteger(value) || value < 0 || value >= 100_000) throw Error("archive_ordinal_invalid");
  return value;
};

export function archiveUploadApi(client, projectId) {
  const base = `/projects/${id(projectId)}`;
  const session = uploadId => `${base}/archive-uploads/${id(uploadId)}`;
  const object = (uploadId, index) => `${session(uploadId)}/objects/${ordinal(index)}`;
  const post = (path, body) => client.request(path, {method: "POST", body});
  return {
    destinations: () => client.request(`${base}/archive-upload-destinations`),
    create: creationKey => post(`${base}/archive-uploads`, {creation_key: id(creationKey)}),
    append: (uploadId, files) => client.request(`${session(uploadId)}/files`, {method: "PUT", body: {files}}),
    files: (uploadId, after = -1) => client.request(`${session(uploadId)}/files?after=${cursor(after, -1, 99999)}`),
    seal: (uploadId, count, bytes) => post(`${session(uploadId)}/seal`, {expected_files: count, expected_bytes: bytes}),
    status: uploadId => client.request(session(uploadId)),
    start: uploadId => post(`${session(uploadId)}/start`),
    prepare: (uploadId, index) => post(`${object(uploadId, index)}/prepare`),
    part: (uploadId, index, number, sha256) => post(`${object(uploadId, index)}/parts`, {number, sha256}),
    parts: (uploadId, index, after = 0) => client.request(`${object(uploadId, index)}/parts?after=${cursor(after, 0, 10000)}`),
    complete: (uploadId, index) => post(`${object(uploadId, index)}/complete`),
    abortMultipart: (uploadId, index) => post(`${object(uploadId, index)}/abort-multipart`),
    finish: uploadId => post(`${session(uploadId)}/finish`),
    preserveManifest: (uploadId, after = -1) => post(`${session(uploadId)}/preserve-manifest?after=${cursor(after, -1, 99999)}`),
    preserveIndex: (uploadId, destinationId) => post(`${session(uploadId)}/manifest-index/${id(destinationId)}`),
    restore: (uploadId, index) => post(`${session(uploadId)}/restore/${ordinal(index)}`),
    manifest: (uploadId, after = -1) => client.request(`${session(uploadId)}/manifest?after=${cursor(after, -1, 99999)}`)
  };
}

function cursor(value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw Error("archive_cursor_invalid");
  return value;
}

// Signed storage transfers never go through the authenticated API client's fetch.
// XHR supplies real byte progress; cookies and application authorization are absent.
export function uploadArchiveBlob(ticket, blob, {signal, onProgress = () => {}, xhrFactory = () => new XMLHttpRequest()} = {}) {
  if (!(blob instanceof Blob)) throw Error("archive_blob_invalid");
  const url = new URL(ticket?.url);
  if (url.origin !== "https://s3.us-east-1.amazonaws.com" || url.username || url.password
    || url.hash || !url.searchParams.has("X-Amz-Signature") || ticket.method !== "PUT") throw Error("archive_ticket_invalid");
  const allowed = new Set(["x-amz-checksum-sha256", "x-amz-expected-bucket-owner",
    "x-amz-server-side-encryption", "x-amz-meta-sha256", "if-none-match"]);
  if (!ticket.headers || Object.keys(ticket.headers).some(key => !allowed.has(key))) throw Error("archive_ticket_invalid");
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {reject(signal.reason); return;}
    const xhr = xhrFactory();
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => {xhr.abort(); finish(signal.reason ?? new DOMException("Aborted", "AbortError"));};
    xhr.onload = () => {
      // XHR follows redirects; reject their results and rely on S3's fixed signed
      // regional endpoint and browser CORS. No app credentials are attached.
      if (xhr.responseURL && xhr.responseURL !== ticket.url) return finish(Error("archive_upload_redirect"));
      finish(xhr.status >= 200 && xhr.status < 300 ? null : Error("archive_signed_upload_failed"));
    };
    xhr.onerror = () => finish(Error("archive_upload_network_unavailable"));
    xhr.ontimeout = () => finish(Error("archive_upload_timeout"));
    xhr.onabort = () => finish(new DOMException("Aborted", "AbortError"));
    xhr.upload.onprogress = event => {
      if (!settled && event.lengthComputable) {
        try {onProgress({uploadedBytes: Math.min(event.loaded, blob.size), totalBytes: blob.size});}
        catch (error) {xhr.abort(); finish(error);}
      }
    };
    try {
      xhr.open("PUT", ticket.url);
      xhr.withCredentials = false;
      xhr.timeout = 10 * 60 * 1000;
      for (const [key, value] of Object.entries(ticket.headers)) xhr.setRequestHeader(key, value);
      signal?.addEventListener("abort", abort, {once: true});
      xhr.send(blob);
    } catch (error) {finish(error);}
  });
}
