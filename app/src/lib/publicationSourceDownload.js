/** Deliberate source exports. References, history and account-wide work are separate. */
export function planPublicationSourceDownload(files) {
  if (!Array.isArray(files) || !files.length || files.length > 128) {
    throw new TypeError('Choose up to 128 source files to export');
  }
  let totalBytes = 0, transferBytes = 0, fileReads = 0;
  for (const file of files) {
    const size = file.blob?.size ?? file.sizeBytes;
    if (!Number.isSafeInteger(size) || size < 1 || size > 4_194_304) {
      throw new TypeError('Every source file needs a known size of at most 4 MiB');
    }
    totalBytes += size;
    if (!file.blob) {transferBytes += size; fileReads++;}
  }
  if (totalBytes > 16_777_216) throw new TypeError('Source export exceeds 16 MiB');
  return {fileCount: files.length, totalBytes, transferBytes, fileReads};
}

function pendingRead(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Download cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Select transport deliberately. A failed direct transfer never falls back to GET.
 * compatible-get remains the default until the ticket endpoint AND exact S3 CORS
 * are deployed. Abort stops the HTTP request and subsequent reads; it cannot undo
 * storage/service work that was already issued. */
export function createPublicationSourceDownloadReader({adapter, projectId, sourceProjectId,
  sourceRevisionId, isCurrent = () => true, isSavedFile = file => Boolean(file.checksumSha256),
  signal, transport = 'compatible-get'}) {
  if (!['compatible-get', 'direct-s3-v1'].includes(transport)) throw new TypeError('Unsupported source export transport');
  const tokenProvider = adapter.tokenProvider, organizationProvider = adapter.organizationProvider;
  const baseUrl = adapter.baseUrl;
  const hasContext = typeof tokenProvider === 'function' && typeof organizationProvider === 'function';
  let context;
  try {
    context = hasContext ? Promise.all([
      tokenProvider.call(adapter), organizationProvider.call(adapter)
    ]) : Promise.resolve(null);
  } catch (error) {context = Promise.reject(error);}
  // Keep a rejected context handled even if a synchronous preflight stops the export.
  context.catch(() => {});
  const assertCurrent = async () => {
    signal?.throwIfAborted();
    if (!isCurrent() || adapter.tokenProvider !== tokenProvider
      || adapter.organizationProvider !== organizationProvider || adapter.baseUrl !== baseUrl) {
      throw new TypeError('The source export account, selection or version changed');
    }
    const captured = await pendingRead(context, signal);
    if (captured && (await tokenProvider.call(adapter) !== captured[0]
      || await organizationProvider.call(adapter) !== captured[1])) {
      throw new TypeError('The source export account changed');
    }
    signal?.throwIfAborted();
    if (!isCurrent()) throw new TypeError('The source export selection or version changed');
  };
  const readFile = async file => {
    await assertCurrent();
    planPublicationSourceDownload([file]);
    // A saved cache retains immutable revision facts. Edited draft records are
    // deliberately distinct, even when they retain their original provenance.
    if (file.blob && !isSavedFile(file)) return file.blob;
    if (!sourceRevisionId || !/^[a-f0-9]{64}$/.test(file.checksumSha256 ?? '')) {
      throw new TypeError('The saved source file lacks exact revision and checksum facts');
    }
    const loaded = file.blob ? {blob: file.blob} : await pendingRead(transport === 'direct-s3-v1'
      ? adapter.readObservableSourceRevisionFileDirect(projectId, sourceProjectId, sourceRevisionId, file, {signal})
      : adapter.readObservableSourceRevisionFile(projectId, sourceProjectId, sourceRevisionId, file.relativePath, {signal}), signal);
    await assertCurrent();
    if (!(loaded?.blob instanceof Blob) || loaded.blob.size !== file.sizeBytes
      || loaded.blob.type.split(';', 1)[0] !== file.contentType) {
      throw new TypeError('The saved source file size or media changed');
    }
    const checksum = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await loaded.blob.arrayBuffer()))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    await assertCurrent();
    if (checksum !== file.checksumSha256) throw new TypeError('The saved source file checksum changed');
    file.blob = loaded.blob;
    return loaded.blob;
  };
  return {assertCurrent, readFile, wait: promise => pendingRead(promise, signal)};
}
