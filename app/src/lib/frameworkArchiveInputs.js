import {normalizeObservableRevisionAttachments, normalizeObservableRevisionReferencedFiles, normalizeObservableSourceFiles} from "./apiClient.js";
import {sha256Hex} from "./managedUpload.js";
import {readExactDependency, readPublicFileDependency} from "./publicationSourceBackupInputs.js";

export const MAX_FRAMEWORK_DATA_BYTES = 64 * 1024 * 1024;
const MEDIA = {
  json: ["application/json", "application/geo+json"], geojson: ["application/json", "application/geo+json"],
  csv: ["text/csv"], txt: ["text/plain"], png: ["image/png"], jpg: ["image/jpeg"], jpeg: ["image/jpeg"],
  tif: ["image/tiff", "image/geotiff"], tiff: ["image/tiff", "image/geotiff"]
};
export function frameworkArchiveIsSupported(record) {
  return record && Object.values(MEDIA).some(types => types.includes(record.contentType))
    && Number.isSafeInteger(record.sizeBytes) && record.sizeBytes > 0 && record.sizeBytes <= MAX_FRAMEWORK_DATA_BYTES;
}

// A plan only: callers must register exact dataset objects and bind their paths
// before importing. Never silently discard a large file from a source revision.
export function planFrameworkDataSeparation(selectedFiles) {
  const oneByte = new Blob(["x"]);
  const checked = normalizeObservableSourceFiles(selectedFiles.map(file => ({...file, blob: oneByte})));
  const files = checked.map(file => {
    const original = selectedFiles.find(candidate => candidate.relativePath === file.relativePath);
    if (!(original.blob instanceof Blob) || original.blob.size < 1) throw new TypeError("Source files must be non-empty Blobs.");
    return {...file, blob: original.blob};
  });
  const dataFiles = [];
  const sourceFiles = [...files];
  let sourceBytes = sourceFiles.reduce((total, file) => total + file.blob.size, 0);
  const eligible = file => file.relativePath.startsWith("src/")
    && frameworkArchiveIsSupported({contentType: file.contentType, sizeBytes: file.blob.size});
  const move = file => {
    if (!eligible(file)) throw new TypeError(`${file.relativePath}: exceeds source limits and cannot be bound as a supported data attachment.`);
    dataFiles.push(file); sourceFiles.splice(sourceFiles.indexOf(file), 1); sourceBytes -= file.blob.size;
  };
  for (const file of files) if (file.blob.size > 4_194_304) move(file);
  for (const file of [...sourceFiles].filter(eligible).sort((a, b) => b.blob.size - a.blob.size || a.relativePath.localeCompare(b.relativePath))) {
    if (sourceBytes <= 16_777_216) break;
    move(file);
  }
  const dataBytes = dataFiles.reduce((total, file) => total + file.blob.size, 0);
  if (dataBytes > MAX_FRAMEWORK_DATA_BYTES) throw new TypeError("Data attachments exceed the current 64 MiB build-input limit.");
  return {sourceFiles: normalizeObservableSourceFiles(sourceFiles), dataFiles, sourceBytes, dataBytes};
}
export function validateFrameworkArchiveBindings(bindings, files, inventory) {
  const normalized = normalizeObservableRevisionAttachments(bindings, files);
  let total = 0;
  for (const binding of normalized) {
    const record = inventory.find(item => item.id === binding.attachmentId);
    if (!record?.available) throw new TypeError(`${binding.relativePath}: archived file is unavailable. Reload references or remove this path.`);
    const suffix = binding.relativePath.split(".").at(-1).toLowerCase();
    if (!MEDIA[suffix]?.includes(record.contentType)) throw new TypeError(`${binding.relativePath}: extension does not match ${record.contentType}.`);
    if (!Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 1) throw new TypeError("Archived file size is invalid.");
    total += record.sizeBytes;
  }
  if (total > MAX_FRAMEWORK_DATA_BYTES) throw new TypeError("Archived files exceed 64 MiB; repeated references count at each path.");
  return normalized;
}

export async function reconcileFrameworkArchiveFiles(selectedFiles, bindings, inventory) {
  const paths = selectedFiles.map(file => file.relativePath.toLowerCase());
  if (new Set(paths).size !== paths.length) throw new TypeError("Selected source and archive paths must be unique.");
  const archivePaths = new Set(normalizeObservableRevisionAttachments(bindings).map(binding => binding.relativePath));
  const files = normalizeObservableSourceFiles(selectedFiles.filter(file => !archivePaths.has(file.relativePath)));
  const normalized = validateFrameworkArchiveBindings(bindings, files, inventory);
  const archivedFiles = [];
  for (const binding of normalized) {
    const local = selectedFiles.find(file => file.relativePath === binding.relativePath);
    if (!local) continue; // Existing exact references need no duplicate local file.
    const record = inventory.find(item => item.id === binding.attachmentId);
    if (!(local.blob instanceof Blob) || local.blob.size !== record.sizeBytes
      || !/^[0-9a-f]{64}$/.test(record.checksumSha256)) {
      throw new TypeError(`${binding.relativePath}: local size does not match the exact registered archive.`);
    }
    if (await sha256Hex(local.blob) !== record.checksumSha256) {
      throw new TypeError(`${binding.relativePath}: local checksum does not match the exact registered archive.`);
    }
    archivedFiles.push({relativePath: binding.relativePath, attachmentId: binding.attachmentId,
      sizeBytes: record.sizeBytes, checksumSha256: record.checksumSha256});
  }
  return {files, archivedFiles};
}

/** Resolve a draft alias to an exact authorized object, retaining its bytes only
 * in this editor. Re-rendering never captures data or requests another ticket. */
export function createFrameworkAttachmentReader({adapter, projectId, sourceProjectId, getBindings, getFiles = () => [],
  getReferencedFiles = () => []}) {
  const cache = new Map(), datasets = new Map();
  let controller = new AbortController(), generation = 0, inventoryOperation = 0;
  const tokenProvider = adapter.tokenProvider, organizationProvider = adapter.organizationProvider, baseUrl = adapter.baseUrl;
  const context = typeof tokenProvider === 'function' && typeof organizationProvider === 'function'
    ? Promise.all([tokenProvider.call(adapter), organizationProvider.call(adapter)]) : Promise.resolve(null);
  context.catch(() => {});
  let inventory, inventoryBindings, reservedBytes = 0, disposed = false;
  const current = () => !disposed && adapter.tokenProvider === tokenProvider
    && adapter.organizationProvider === organizationProvider && adapter.baseUrl === baseUrl;
  const checkContext = async () => {
    if (!current()) throw Error('The publication account changed');
    const captured = await context;
    if (captured && (await tokenProvider.call(adapter) !== captured[0]
      || await organizationProvider.call(adapter) !== captured[1])) throw Error('The publication account changed');
    if (!current()) throw Error('The publication editor is closed');
  };
  // Failed reads remain settled until a deliberate reload. Reactive evaluation
  // must not become an unbounded stream of authorization/ticket requests.
  const retryError = error => new Error(`${error instanceof Error ? error.message : 'Registered file read failed'}. Open Data files and use Reload registered files to retry.`, {cause: error});
  const bindingIdentities = () => JSON.stringify([
    [...new Set(getBindings().map(item => item.attachmentId))].sort(),
    [...new Set(getReferencedFiles().map(item => item.referenceId))].sort()
  ]);
  const loadInventory = () => {
    const identities = bindingIdentities();
    if (!inventory || inventoryBindings !== identities) {
      // Adding an existing file changes the inventory needed by this draft.
      // Renaming paths or editing a page retains metadata and verified bytes.
      inventoryBindings = identities;
      inventory = Promise.all([
        getBindings().length ? adapter.listObservableDataAttachments(projectId, sourceProjectId) : [],
        getReferencedFiles().length ? adapter.listObservablePublicFileReferences(projectId, sourceProjectId) : []
      ]).then(([archives, sources]) => ({archives, sources})).catch(error => {throw retryError(error);});
    }
    return inventory;
  };
  const checkGeneration = expected => {
    if (expected !== generation) throw Error('Registered files were reloaded; retry the preview with the current references');
  };
  const releaseReservation = entry => {
    if (entry.reserved) {reservedBytes -= entry.sizeBytes; entry.reserved = false;}
  };
  const resolveDataset = record => {
    if (!datasets.has(record.datasetId)) {
      datasets.set(record.datasetId, Promise.resolve().then(async () => {
        const dataset = typeof adapter.getCatalogDataset === 'function'
          ? await adapter.getCatalogDataset(record.datasetId) : {id: record.datasetId, projectId};
        if (dataset.id !== record.datasetId || !dataset.projectId) throw Error('The registered dataset could not be resolved');
        return dataset;
      }));
    }
    return datasets.get(record.datasetId);
  };
  const checkBinding = (path, binding) => {
    const publicFile = Boolean(binding.referenceId), identity = publicFile ? 'referenceId' : 'attachmentId';
    if (!(publicFile ? getReferencedFiles() : getBindings()).some(item => item.relativePath === path && item[identity] === binding[identity])) {
      throw Error('The draft file reference changed');
    }
  };
  const resolveRecord = async path => {
    const expectedGeneration = generation;
    await checkContext();
    const selected = [...getBindings(), ...getReferencedFiles()].find(item => item.relativePath === path);
    if (!selected) throw Error(`Registered file not found: ${path}`);
    const binding = {...selected};
    const records = await loadInventory();
    await checkContext();
    checkGeneration(expectedGeneration);
    checkBinding(path, binding);
    validateFrameworkArchiveBindings(getBindings(), [...getFiles(), ...getReferencedFiles()], records.archives);
    const references = normalizeObservableRevisionReferencedFiles(getReferencedFiles(), [...getFiles(), ...getBindings()]);
    let total = getBindings().reduce((sum, item) => sum + records.archives.find(record => record.id === item.attachmentId).sizeBytes, 0);
    for (const item of references) {
      const record = records.sources.find(record => record.id === item.referenceId);
      if (!record?.available || record.sourceProjectId !== sourceProjectId) throw Error('The connected public file is unavailable');
      if (!/\.tiff?$/i.test(item.relativePath) || !['image/tiff', 'image/geotiff'].includes(record.contentType)
        || !frameworkArchiveIsSupported(record)) throw TypeError('The connected source TIFF is outside preview limits');
      total += record.sizeBytes;
    }
    if (total > MAX_FRAMEWORK_DATA_BYTES) throw Error('Preview data exceeds 64 MiB; repeated file paths count separately');
    const publicFile = Boolean(binding.referenceId);
    const record = (publicFile ? records.sources : records.archives).find(item => item.id === (binding.referenceId ?? binding.attachmentId));
    if (!record?.available || record.sourceProjectId !== sourceProjectId) throw Error('The registered file is unavailable');
    return {binding, record, publicFile, expectedGeneration};
  };
  const replaceInventory = (records, retryFailures, preserveInventory = false) => {
    ++generation;
    controller.abort();
    controller = new AbortController();
    if (!preserveInventory) {
      inventory = records ? Promise.resolve(records) : null;
      inventoryBindings = records ? bindingIdentities() : null;
    }
    if (retryFailures) datasets.clear();
    for (const [key, entry] of cache) {
      if (entry.state === 'pending' || retryFailures && entry.state === 'rejected') {
        cache.delete(key); releaseReservation(entry);
      }
    }
  };
  return {
    async metadata(path) {
      const {record, publicFile} = await resolveRecord(path);
      // Exact registry facts only. Storage coordinates and unknown rights are
      // never carried into a downloaded publication's attachment manifest.
      if (publicFile) return {referenceId: record.id, datasetId: record.datasetId, resourceId: record.resourceId,
        resourceVersionId: record.resourceVersionId, sizeBytes: record.sizeBytes, checksumSha256: record.checksumSha256,
        contentType: record.contentType};
      return {attachmentId: record.id, datasetId: record.datasetId, datasetVersionId: record.datasetVersionId,
        dataObjectId: record.dataObjectId, sizeBytes: record.sizeBytes, checksumSha256: record.checksumSha256,
        contentType: record.contentType};
    },
    async reload(records, sources = []) {
      if (!Array.isArray(records) || !Array.isArray(sources)) throw TypeError('Reload requires the checked registered-file inventory');
      const operation = ++inventoryOperation;
      await checkContext();
      if (operation !== inventoryOperation) return false;
      // Keep successful exact bytes. Cancel unfinished reads and clear failures
      // only when the user explicitly refreshes the inventory.
      replaceInventory({archives: records, sources}, true);
      return true;
    },
    async invalidateInventory() {
      const operation = ++inventoryOperation;
      await checkContext();
      if (operation !== inventoryOperation) return false;
      // A new registration changes metadata, not the retry decision for an
      // unrelated failed body. Its next evaluation reads the complete inventory.
      replaceInventory(null, false);
      return true;
    },
    async invalidateBindings() {
      const operation = ++inventoryOperation;
      await checkContext();
      if (operation !== inventoryOperation) return false;
      // Stop obsolete reads without reloading the same metadata on each path
      // edit. loadInventory separately notices newly added file identities.
      replaceInventory(null, false, true);
      return true;
    },
    async read(path) {
      const {binding, record, publicFile, expectedGeneration} = await resolveRecord(path);
      const key = JSON.stringify(publicFile
        ? ['public', record.id, record.sourceVersion, record.resourceVersionId, record.distributionId, record.url, record.checksumSha256, record.sizeBytes, record.contentType]
        : ['archive', record.id, record.s3VersionId, record.checksumSha256, record.sizeBytes, record.contentType]);
      if (!cache.has(key)) {
        if (reservedBytes + record.sizeBytes > MAX_FRAMEWORK_DATA_BYTES) throw Error('Preview data exceeds 64 MiB; reopen the draft to clear its file cache');
        reservedBytes += record.sizeBytes;
        const entry = {sizeBytes: record.sizeBytes, reserved: true, state: 'pending'};
        const signal = controller.signal;
        entry.promise = (async () => {
          if (publicFile) {
            const blob = await readPublicFileDependency(record,
              adapter.fetchImplementation?.bind(adapter) ?? globalThis.fetch.bind(globalThis),
              () => current() && generation === expectedGeneration && getReferencedFiles().some(item =>
                item.relativePath === path && item.referenceId === binding.referenceId), signal, MAX_FRAMEWORK_DATA_BYTES);
            await checkContext();
            checkGeneration(expectedGeneration);
            checkBinding(path, binding);
            entry.state = 'fulfilled';
            return blob;
          }
          const dataset = await resolveDataset(record);
          await checkContext();
          checkGeneration(expectedGeneration);
          checkBinding(path, binding);
          const ticket = await adapter.requestDatasetDownload(dataset.projectId, record.datasetId, record.datasetVersionId, record.dataObjectId);
          await checkContext();
          checkGeneration(expectedGeneration);
          checkBinding(path, binding);
          const blob = await readExactDependency(ticket, record,
            adapter.fetchImplementation?.bind(adapter) ?? globalThis.fetch.bind(globalThis),
            () => current() && generation === expectedGeneration && getBindings().some(item =>
              item.relativePath === path && item.attachmentId === binding.attachmentId), signal, MAX_FRAMEWORK_DATA_BYTES);
          await checkContext();
          checkGeneration(expectedGeneration);
          entry.state = 'fulfilled';
          return blob;
        })().catch(error => {entry.state = 'rejected'; releaseReservation(entry); throw retryError(error);});
        cache.set(key, entry);
      }
      const blob = await cache.get(key).promise;
      await checkContext();
      checkGeneration(expectedGeneration);
      checkBinding(path, binding);
      return blob;
    },
    dispose() {disposed = true; controller.abort(); cache.clear(); datasets.clear(); inventory = null;}
  };
}

export function publicationFileAttachmentSnippet(pagePath, relativePath, readMethod = 'arrayBuffer', source = '') {
  if (!/\.(md|html)$/i.test(pagePath ?? '')) throw Error('Open a Framework or Observable notebook page to insert JavaScript');
  if (!['arrayBuffer', 'json', 'csv', 'text', 'url'].includes(readMethod)) throw Error('Unsupported file reader');
  const from = pagePath.split('/').slice(0, -1), to = relativePath.split('/');
  while (from.length && to.length && from[0] === to[0]) {from.shift(); to.shift();}
  const alias = '../'.repeat(from.length) + to.join('/');
  const stem = relativePath.split('/').at(-1).replace(/\.[^.]*$/, '').replace(/[^a-zA-Z0-9_]/g, '_');
  const prefix = `data_${stem || 'file'}`;
  let name = prefix, suffix = 2;
  while (new RegExp(`\\b${name}\\b`).test(source)) name = `${prefix}_${suffix++}`;
  const statement = `const ${name} = await FileAttachment(${JSON.stringify(alias)}).${readMethod}();`;
  if (/\.md$/i.test(pagePath)) return `\n\n\x60\x60\x60js\n${statement}\n\x60\x60\x60\n`;
  return `\n<script type="module">\n${statement}\n</script>\n`;
}
