import {zipSync, unzipSync, strToU8} from 'fflate';
import {normalizeObservableSourceFiles, normalizeObservableRevisionAttachments, parsePublicationArtifactReferences} from './apiClient.js';

const MAX_CONTEXT_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 18 * 1024 * 1024;
const MANIFEST_PATH = 'opengeo-source-project.json';
const SCHEMA = 'opengeo.publication-source-export.1.0.0';
const BACKUP_SCHEMA = 'opengeo.publication-source-backup.1.0.0';
const BACKUP_CONTEXT_NAME = 'opengeo-source-backup-context.json';
const invalid = detail => new TypeError(`Choose an OpenGeo Studio source-project export: ${detail}`);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const sha256 = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map(value => value.toString(16).padStart(2, '0')).join('');
const CREDENTIAL_PARAMETER = /^(?:x-amz-(?:signature|credential|security-token)|access[_-]?token|token|sig|signature|api[_-]?key|key|client[_-]?secret|password|credential|authorization|session|auth|cap)$/i;
const README = `OpenGeo Studio Publication source project

source/ contains the exact current working-draft files, including unsaved edits.
opengeo-source-project.json records their sizes and SHA-256 checksums, supplied
settings, and external references. This is not an immutable saved revision.

In Studio, choose this file with OpenGeo Studio source project ZIP, review its contents,
then choose Use imported source. This changes the working draft only; publication
rights need review and external dependencies are not automatically rebound.

To reopen the source, extract source/ and select that folder with Studio's
existing folder import. Review the settings and reference manifest separately;
external data and Artifact references require authorized review and rebinding.
An original base revision, when present, is context only. Its saved manifest does
not attest to the current draft. A current binding inherits saved pin details only
when its attachment identity and path both match that original manifest.

External data and Artifact bytes are not bundled, fetched, or copied. References
do not grant access or publication rights. Unknown pin details remain unknown.
This is not a complete offline, workspace, or account backup. It does not include
revision history, credentials, build dependencies, or compiled publications.
`;
const BACKUP_README = `OpenGeo Studio Publication source-project input backup

source/ contains exact source files and every declared archived data and retained
Artifact dependency at its frozen authored path. The manifest records sizes,
SHA-256 checksums and original immutable dependency facts as untrusted provenance.
An Artifact file is compiled output, not recovered editable Project source.
opengeo-source-backup-context.json in the entry directory is a verified sidecar;
it remains in the restored tree so an explicit save can retain that context.

Review this ZIP in Studio before restoring the working tree, then save explicitly.
Original identities, permissions, rights and build policy are context only. They
do not grant access or approval; restored publication rights require review.
The package verifies consistency, not origin, ownership or current authorization.

This is one selected authored input tree, not account/workspace or history backup.
Compiler packages, credentials and undeclared remote libraries/services are not
bundled. No dependency URL is fetched by package creation or verification.
`;

function rejectCredentialUrls(value) {
  // Apply the existing archive-export ticket rule to nested metadata as well.
  if (/X-Amz-(Signature|Credential|Security-Token)|[?&](access_token|token|sig)=/i.test(value)) {
    throw new TypeError('Temporary credentials cannot be exported in the source manifest');
  }
  for (const match of value.matchAll(/[a-z][a-z0-9+.-]{0,31}:\/\/[^\s<>"'\\]+/gi)) {
    let url;
    try {url = new URL(match[0]);} catch {continue;}
    if (url.username || url.password || [...url.searchParams.keys()].some(key => CREDENTIAL_PARAMETER.test(key))
      || [...new URLSearchParams(url.hash.slice(1)).keys()].some(key => CREDENTIAL_PARAMETER.test(key))) {
      throw new TypeError('Credential-bearing URLs cannot be exported in the source manifest');
    }
  }
}

function boundedContext(value) {
  const serialized = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'string') rejectCredentialUrls(item);
    else if (typeof item === 'number' && !Number.isFinite(item)
      || ['undefined', 'function', 'symbol', 'bigint'].includes(typeof item)
      || item && typeof item === 'object' && !Array.isArray(item)
        && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      throw new TypeError('Source export metadata must contain JSON values only');
    }
    return item;
  });
  if (strToU8(serialized).byteLength > MAX_CONTEXT_BYTES) {
    throw new TypeError('Source export metadata and references exceed 256 KiB');
  }
  return JSON.parse(serialized);
}

// Share the same metadata/credential bound with Source history packages.
export const publicationSourceExportContext = value => boundedContext(value);

function validateSettings(metadata) {
  if (!record(metadata)) throw invalid('source settings must be an object.');
  if (Object.hasOwn(metadata, 'title') && (typeof metadata.title !== 'string' || metadata.title.length > 300)) {
    throw invalid('the source title is invalid.');
  }
  for (const key of ['entryPath', 'lockfilePath']) {
    if (!Object.hasOwn(metadata, key) || key === 'lockfilePath' && metadata[key] === null) continue;
    if (typeof metadata[key] !== 'string' || metadata[key].length > 512) {
      throw invalid('entry and lockfile settings must be bounded text.');
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
export function choosePublicationBackupContextPath(entryPath, paths = []) {
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string')) {
    throw invalid('the restoration context requires valid input paths.');
  }
  const directory = typeof entryPath === 'string' && entryPath.includes('/')
    ? entryPath.slice(0, entryPath.lastIndexOf('/') + 1) : '';
  const folded = paths.map(path => path.toLowerCase()), parent = directory.slice(0, -1).toLowerCase();
  if (parent && folded.some(path => parent === path || parent.startsWith(path + '/'))) {
    throw invalid('the restoration context directory collides with an original file.');
  }
  // Each occupied basename can exclude only one candidate. Bound the search,
  // including case and file/directory collisions, without touching any bytes.
  for (let suffix = 1; suffix <= paths.length + 1; suffix++) {
    const name = suffix === 1 ? BACKUP_CONTEXT_NAME : `opengeo-source-backup-context-${suffix}.json`;
    const candidate = directory + name, key = candidate.toLowerCase();
    if (!folded.some(path => path === key || path.startsWith(key + '/') || key.startsWith(path + '/'))) return candidate;
  }
  throw invalid('the restoration context has no unused path.');
}
function validateBackupDependencies({files, dataAttachments, artifactReferences, dependencies, contextPath}) {
  if (!files.length) throw invalid('the backup must include original authored source files.');
  if (!Array.isArray(dependencies) || dependencies.length > 128) throw invalid('a complete dependency inventory is required.');
  const bindings = normalizeObservableRevisionAttachments(dataAttachments, files);
  if (!record(artifactReferences)) throw invalid('the saved Artifact reference inventory is unavailable.');
  const references = parsePublicationArtifactReferences(artifactReferences);
  const expected = new Map([
    ...bindings.map(binding => [binding.relativePath, {kind: 'data', binding}]),
    ...references.references.map(reference => [reference.path, {kind: 'artifact', reference}])
  ]);
  if (expected.size !== bindings.length + references.references.length
    || dependencies.length !== expected.size) throw invalid('every declared dependency must be materialized exactly once.');
  const paths = new Set();
  for (const dependency of dependencies) {
    if (!exactKeys(dependency, ['kind', 'relativePath', 'pin']) || paths.has(dependency.relativePath)) {
      throw invalid('dependency provenance is invalid or duplicated.');
    }
    if (dependency.relativePath?.toLowerCase() === contextPath.toLowerCase()) throw invalid('the restoration context path is reserved.');
    paths.add(dependency.relativePath);
    const target = expected.get(dependency.relativePath), pin = dependency.pin;
    if (!target || target.kind !== dependency.kind) throw invalid('a dependency does not match its declared path and kind.');
    if (dependency.kind === 'data') {
      if (!exactKeys(pin, ['path', 'attachmentId', 'datasetId', 'datasetVersionId', 'dataObjectId',
        's3VersionId', 'checksumSha256', 'sizeBytes', 'contentType'])
        || pin.path !== dependency.relativePath || pin.attachmentId !== target.binding.attachmentId
        || !['attachmentId', 'datasetId', 'datasetVersionId', 'dataObjectId'].every(key => UUID.test(pin[key]))
        || typeof pin.s3VersionId !== 'string' || !pin.s3VersionId.trim() || pin.s3VersionId === 'null'
        || pin.s3VersionId.length > 1024) throw invalid('an archived data dependency lacks exact immutable facts.');
    } else if (!exactKeys(pin, ['artifactId', 'version', 'outputObjectId', 'manifestChecksumSha256',
      'checksumSha256', 'sizeBytes', 'contentType']) || pin.artifactId !== target.reference.artifact_id
      || !UUID.test(pin.artifactId) || !UUID.test(pin.outputObjectId) || !SHA.test(pin.manifestChecksumSha256)
      || !Number.isSafeInteger(pin.version) || pin.version < 1 || pin.version > 2147483647
      || target.reference.mode === 'pinned' && pin.version !== target.reference.version
      || pin.contentType !== 'text/html') throw invalid('a retained Artifact dependency lacks its frozen edition and output facts.');
    if (!SHA.test(pin.checksumSha256) || !Number.isSafeInteger(pin.sizeBytes)
      || pin.sizeBytes < 1 || pin.sizeBytes > 4_194_304 || typeof pin.contentType !== 'string') {
      throw invalid('dependency size, media or checksum facts are invalid.');
    }
  }
  return {bindings, references};
}

function backupContextBytes(manifest) {
  const context = boundedContext({schemaVersion: 'opengeo.publication-source-backup-context.1.0.0',
    purpose: 'inert-provenance-only', contextPath: manifest.contextPath,
    custody: 'explicit-restoration-copy', rightsStatus: 'unreviewed',
    dependencyRights: 'unknown-not-inherited', grantsAuthority: false,
    original: {metadata: manifest.metadata, baseRevision: manifest.baseRevision,
      dataAttachments: manifest.dataAttachments, artifactReferences: manifest.artifactReferences,
      dependencies: manifest.dependencies, files: manifest.files.filter(file => file.path !== manifest.contextPath)}});
  const bytes = strToU8(JSON.stringify(context, null, 2) + '\n');
  if (bytes.byteLength > MAX_CONTEXT_BYTES) throw invalid('the restoration context exceeds 256 KiB.');
  return bytes;
}

// Our exporter writes stored files with no attributes, extras, comments or data
// descriptors. Accept that finite format, not arbitrary ZIP features. fflate's
// filter does not expose attributes or verify local/central consistency or CRC.
const CRC_TABLE = Uint32Array.from({length: 256}, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}
function preflight(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  const u16 = offset => view.getUint16(offset, true), u32 = offset => view.getUint32(offset, true);
  const require = (condition, message) => {if (!condition) throw invalid(message);};
  require(end >= 0 && u32(end) === 0x06054b50, 'the ZIP end record is missing or has comments.');
  const count = u16(end + 10), centralSize = u32(end + 12), centralStart = u32(end + 16);
  require(u16(end + 4) === 0 && u16(end + 6) === 0 && u16(end + 8) === count && u16(end + 20) === 0
    && count >= 3 && count <= 130 && centralStart + centralSize === end, 'ZIP disks, entry count or directory bounds are unsupported.');
  const entries = new Map(), folded = new Set();
  let central = centralStart, local = 0, sourceBytes = 0;
  for (let index = 0; index < count; index++) {
    require(central + 46 <= end && u32(central) === 0x02014b50, 'a central ZIP header is invalid.');
    const length = u16(central + 28), size = u32(central + 20), originalSize = u32(central + 24);
    require(length > 0 && length <= 519 && central + 46 + length <= end, 'a ZIP filename is invalid.');
    require(u16(central + 4) === 20 && u16(central + 6) === 20 && u16(central + 8) === 0
      && u16(central + 10) === 0 && u16(central + 30) === 0 && u16(central + 32) === 0
      && u16(central + 34) === 0 && u16(central + 36) === 0 && u32(central + 38) === 0
      && u32(central + 42) === local && size === originalSize,
    'only stored regular files without ZIP64, encryption, attributes, extras or descriptors are supported.');
    const nameBytes = bytes.subarray(central + 46, central + 46 + length);
    require(nameBytes.every(byte => byte >= 32 && byte < 127), 'ZIP paths must use the source-path character set.');
    const name = String.fromCharCode(...nameBytes), key = name.toLowerCase();
    require(!folded.has(key), 'duplicate ZIP paths are not supported.');
    folded.add(key);
    const source = name.startsWith('source/');
    require(source || name === MANIFEST_PATH || name === 'README.txt', 'the archive contains unexpected entries.');
    if (source) {
      const path = name.slice(7);
      // Reuse the existing path/media guard before allocating any file body.
      normalizeObservableSourceFiles([{relativePath: path, blob: new Blob(['x'])}]);
      sourceBytes += size;
      require(size >= 1 && size <= 4_194_304 && sourceBytes <= 16_777_216, 'source files exceed 4 MiB per file or 16 MiB per tree.');
    } else require(size >= 1 && size <= (name === MANIFEST_PATH ? MAX_MANIFEST_BYTES : 16_384), 'an archive sidecar exceeds its size limit.');
    require(local + 30 + length <= centralStart && u32(local) === 0x04034b50, 'a local ZIP header is invalid.');
    require(u16(local + 28) === 0 && u16(local + 26) === length, 'local filename or extra fields differ from the directory.');
    for (const [a, b] of [[6, 4], [8, 6], [10, 8], [12, 10], [14, 12]]) {
      require(u16(central + a) === u16(local + b), 'local ZIP metadata differs from the directory.');
    }
    for (const [a, b] of [[16, 14], [20, 18], [24, 22]]) {
      require(u32(central + a) === u32(local + b), 'local ZIP sizes or CRC differ from the directory.');
    }
    require(nameBytes.every((byte, offset) => byte === bytes[local + 30 + offset]), 'local ZIP paths differ from the directory.');
    const from = local + 30 + length, to = from + size;
    require(to <= centralStart, 'a ZIP file overlaps the directory or leaves the archive.');
    require(crc32(bytes.subarray(from, to)) === u32(central + 16), 'a ZIP file failed its CRC check.');
    entries.set(name, {size}); local = to; central += 46 + length;
  }
  require(local === centralStart && central === end && entries.has(MANIFEST_PATH) && entries.has('README.txt'),
    'the ZIP tree is incomplete, overlapping or has trailing records.');
  require(entries.size - 2 <= 128, 'source files exceed 128 entries.');
  return entries;
}

/** Verify a complete source export before returning any files. Metadata is inert. */
export async function readPublicationSourceArchive(blob) {
  if (!(blob instanceof Blob) || blob.size < 22 || blob.size > MAX_ARCHIVE_BYTES) throw invalid('the ZIP must be at most 18 MiB.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength !== blob.size || bytes.byteLength > MAX_ARCHIVE_BYTES) throw invalid('the ZIP size changed.');
  const expected = preflight(bytes);
  const entries = unzipSync(bytes, {filter(info) {
    const entry = expected.get(info.name);
    if (!entry || info.compression !== 0 || info.size !== entry.size || info.originalSize !== entry.size) throw invalid('ZIP extraction metadata changed.');
    return true;
  }});
  let manifest;
  try {manifest = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(entries[MANIFEST_PATH]));}
  catch {throw invalid('the source manifest is not valid UTF-8 JSON.');}
  const backup = manifest?.schemaVersion === BACKUP_SCHEMA;
  if (!exactKeys(manifest, ['schemaVersion', 'content', 'metadata', 'baseRevision', 'dataAttachments', 'artifactReferences', 'files', ...(backup ? ['dependencies', 'contextPath'] : [])])
    || !(backup || manifest.schemaVersion === SCHEMA) || manifest.content !== (backup ? 'complete-input-tree' : 'working-draft')
    || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 128
    || manifest.files.length + 2 !== expected.size) throw invalid('the source manifest schema or file count is unsupported.');
  boundedContext({metadata: manifest.metadata, baseRevision: manifest.baseRevision,
    dataAttachments: manifest.dataAttachments, artifactReferences: manifest.artifactReferences,
    ...(backup ? {dependencies: manifest.dependencies} : {})});
  validateSettings(manifest.metadata);
  if (manifest.baseRevision !== null && (!exactKeys(manifest.baseRevision, ['purpose', 'revision'])
    || manifest.baseRevision.purpose !== 'original-context-only' || !record(manifest.baseRevision.revision))) throw invalid('the original revision context is invalid.');
  if (manifest.artifactReferences !== null && (!exactKeys(manifest.artifactReferences, ['bundled', 'references'])
    || manifest.artifactReferences.bundled !== backup || !record(manifest.artifactReferences.references))) throw invalid('Artifact reference context does not match this package.');
  if (!Array.isArray(manifest.dataAttachments) || manifest.dataAttachments.some(binding =>
    !exactKeys(binding, ['attachmentId', 'relativePath', 'bundled', 'pinDetails', 'pin']) || binding.bundled !== backup
    || !(backup ? binding.pinDetails === 'frozen-backup' && record(binding.pin)
      : binding.pinDetails === 'unknown' && binding.pin === null || binding.pinDetails === 'retained-base-revision' && record(binding.pin)))) {
    throw invalid('data reference context does not match this package.');
  }
  const selected = new Set();
  const files = normalizeObservableSourceFiles(manifest.files.map(file => {
    if (!exactKeys(file, ['path', 'archivePath', 'contentType', 'sizeBytes', 'checksumSha256'])
      || typeof file.path !== 'string' || file.archivePath !== 'source/' + file.path || selected.has(file.archivePath)
      || typeof file.contentType !== 'string' || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 1
      || !/^[a-f0-9]{64}$/.test(file.checksumSha256) || !expected.has(file.archivePath)
      || entries[file.archivePath]?.byteLength !== file.sizeBytes || expected.get(file.archivePath).size !== file.sizeBytes) {
      throw invalid('a source file does not match its manifest record.');
    }
    selected.add(file.archivePath);
    return {relativePath: file.path, contentType: file.contentType, blob: new Blob([entries[file.archivePath]], {type: file.contentType})};
  }));
  if (backup) {
    const contextPath = choosePublicationBackupContextPath(manifest.metadata.entryPath,
      files.filter(file => file.relativePath !== manifest.contextPath).map(file => file.relativePath));
    if (manifest.contextPath !== contextPath) throw invalid('the restoration context path differs from its unused entry-directory path.');
    if (!Array.isArray(manifest.dependencies)) throw invalid('a complete dependency inventory is required.');
    normalizeObservableRevisionAttachments([], files);
    const dependencyPaths = new Set(manifest.dependencies.map(dependency => dependency?.relativePath));
    validateBackupDependencies({files: files.filter(file => !dependencyPaths.has(file.relativePath) && file.relativePath !== manifest.contextPath),
      dataAttachments: manifest.dataAttachments, artifactReferences: manifest.artifactReferences?.references,
      dependencies: manifest.dependencies, contextPath: manifest.contextPath});
    for (const dependency of manifest.dependencies) {
      const file = manifest.files.find(file => file.path === dependency.relativePath);
      if (!file || file.contentType !== dependency.pin.contentType || file.sizeBytes !== dependency.pin.sizeBytes
        || file.checksumSha256 !== dependency.pin.checksumSha256) throw invalid('a materialized dependency does not match its frozen facts.');
      if (dependency.kind === 'data') {
        const binding = manifest.dataAttachments.find(binding => binding.relativePath === dependency.relativePath);
        if (!exactKeys(binding.pin, Object.keys(dependency.pin))
          || Object.keys(dependency.pin).some(key => binding.pin[key] !== dependency.pin[key])) throw invalid('archived data pin context differs from its dependency.');
      }
    }
    const context = entries['source/' + manifest.contextPath], expectedContext = backupContextBytes(manifest);
    if (!context || !manifest.files.some(file => file.path === manifest.contextPath && file.contentType === 'application/json')
      || context.byteLength !== expectedContext.byteLength || !context.every((byte, index) => byte === expectedContext[index])) {
      throw invalid('the restoration provenance sidecar is missing or inconsistent.');
    }
  } else normalizeObservableRevisionAttachments(manifest.dataAttachments, files);
  // Original paths can be incomplete draft settings. UI review must choose and
  // validate actual source paths before applying them to the destination.
  validateSettings(manifest.metadata);
  for (const file of manifest.files) {
    if (await sha256(entries[file.archivePath]) !== file.checksumSha256) throw invalid('a source file failed its SHA-256 check.');
  }
  return {files, manifest};
}

/** Export already-authorized, materialized source bytes; never resolve external references. */
export async function createPublicationSourceArchive({files, metadata = {}, dataAttachments = [], artifactReferences = null, baseRevision = null}) {
  const sourceFiles = normalizeObservableSourceFiles(files);
  // This also rejects file/directory prefix collisions within the source files.
  const bindings = normalizeObservableRevisionAttachments(dataAttachments, sourceFiles);
  const context = boundedContext({metadata, artifactReferences, baseRevision});
  if (context.baseRevision !== null && !record(context.baseRevision)
    || context.artifactReferences !== null && !record(context.artifactReferences)) {
    throw invalid('original revision and Artifact reference context must be objects.');
  }
  const savedPins = Array.isArray(context.baseRevision?.manifest?.dataAttachments)
    ? context.baseRevision.manifest.dataAttachments : [];
  const references = bindings.map(binding => {
    const matches = savedPins.filter(pin => pin?.attachmentId === binding.attachmentId && pin.path === binding.relativePath);
    return {...binding, bundled: false, pinDetails: matches.length === 1 ? 'retained-base-revision' : 'unknown',
      pin: matches.length === 1 ? matches[0] : null};
  });
  const manifest = {
    schemaVersion: SCHEMA,
    content: 'working-draft',
    ...boundedContext({metadata: context.metadata,
      baseRevision: context.baseRevision === null ? null : {purpose: 'original-context-only', revision: context.baseRevision},
      dataAttachments: references,
      artifactReferences: context.artifactReferences === null ? null : {bundled: false, references: context.artifactReferences}}),
    files: []
  };
  const entries = Object.create(null);
  for (const file of sourceFiles) {
    const bytes = new Uint8Array(await file.blob.arrayBuffer());
    const checksumSha256 = await sha256(bytes);
    const archivePath = 'source/' + file.relativePath;
    entries[archivePath] = bytes;
    manifest.files.push({path: file.relativePath, archivePath, contentType: file.contentType, sizeBytes: bytes.byteLength, checksumSha256});
  }
  entries[MANIFEST_PATH] = strToU8(JSON.stringify(manifest, null, 2) + '\n');
  if (entries[MANIFEST_PATH].byteLength > MAX_MANIFEST_BYTES) throw invalid('the source manifest exceeds 1 MiB.');
  entries['README.txt'] = strToU8(README);
  const archive = zipSync(entries, {level: 0, mtime: new Date(1980, 0, 1)});
  if (archive.byteLength > MAX_ARCHIVE_BYTES) throw invalid('the source archive exceeds 18 MiB.');
  return {blob: new Blob([archive], {type: 'application/zip'}), manifest};
}

/** Package only already-authorized bytes. Missing dependencies never become a partial backup. */
export async function createPublicationSourceBackup({files, metadata = {}, dataAttachments = [], artifactReferences,
  baseRevision = null, dependencies}) {
  const sourceFiles = normalizeObservableSourceFiles(files);
  if (!Array.isArray(dependencies) || dependencies.some(dependency =>
    !exactKeys(dependency, ['kind', 'relativePath', 'pin', 'blob']) || !(dependency.blob instanceof Blob))) {
    throw invalid('every declared dependency requires materialized bytes and frozen facts.');
  }
  const context = boundedContext({metadata, baseRevision, artifactReferences,
    dependencies: dependencies.map(({kind, relativePath, pin}) => ({kind, relativePath, pin}))});
  if (context.baseRevision !== null && !record(context.baseRevision)) throw invalid('original revision context must be an object.');
  validateSettings(context.metadata);
  const contextPath = choosePublicationBackupContextPath(context.metadata.entryPath,
    [...sourceFiles.map(file => file.relativePath), ...context.dependencies.map(dependency => dependency.relativePath)]);
  const {bindings, references} = validateBackupDependencies({files: sourceFiles, dataAttachments,
    artifactReferences: context.artifactReferences, dependencies: context.dependencies, contextPath});
  const inputFiles = [...sourceFiles, ...dependencies.map(dependency => ({
    relativePath: dependency.relativePath, contentType: dependency.pin.contentType, blob: dependency.blob}))];
  // Reserve the generated sidecar before any file body is read; never overwrite
  // an original path or let the additional file escape the total path/byte caps.
  const reservedFiles = normalizeObservableSourceFiles([...inputFiles, {relativePath: contextPath,
    contentType: 'application/json', blob: new Blob(['x'], {type: 'application/json'})}]);
  normalizeObservableRevisionAttachments([], reservedFiles);
  const allFiles = normalizeObservableSourceFiles(inputFiles);
  const sortedDependencies = context.dependencies.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  const manifest = {schemaVersion: BACKUP_SCHEMA, content: 'complete-input-tree', contextPath,
    ...boundedContext({metadata: context.metadata,
      baseRevision: context.baseRevision === null ? null : {purpose: 'original-context-only', revision: context.baseRevision},
      dataAttachments: bindings.map(binding => ({...binding, bundled: true, pinDetails: 'frozen-backup',
        pin: sortedDependencies.find(dependency => dependency.relativePath === binding.relativePath).pin})),
      artifactReferences: {bundled: true, references}, dependencies: sortedDependencies}), files: []};
  const entries = Object.create(null);
  for (const file of allFiles) {
    const bytes = new Uint8Array(await file.blob.arrayBuffer()), checksumSha256 = await sha256(bytes);
    if (bytes.byteLength !== file.blob.size) throw invalid('an input file changed size during backup.');
    const dependency = sortedDependencies.find(dependency => dependency.relativePath === file.relativePath);
    if (dependency && (bytes.byteLength !== dependency.pin.sizeBytes || checksumSha256 !== dependency.pin.checksumSha256)) {
      throw invalid('materialized dependency bytes do not match their frozen facts.');
    }
    const archivePath = 'source/' + file.relativePath;
    entries[archivePath] = bytes;
    manifest.files.push({path: file.relativePath, archivePath, contentType: file.contentType, sizeBytes: bytes.byteLength, checksumSha256});
  }
  const contextBytes = backupContextBytes(manifest), contextArchivePath = 'source/' + contextPath;
  if (manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0) + contextBytes.byteLength > 16_777_216) {
    throw invalid('source files and restoration context exceed 16 MiB per tree.');
  }
  entries[contextArchivePath] = contextBytes;
  manifest.files.push({path: contextPath, archivePath: contextArchivePath, contentType: 'application/json',
    sizeBytes: contextBytes.byteLength, checksumSha256: await sha256(contextBytes)});
  entries[MANIFEST_PATH] = strToU8(JSON.stringify(manifest, null, 2) + '\n');
  if (entries[MANIFEST_PATH].byteLength > MAX_MANIFEST_BYTES) throw invalid('the source manifest exceeds 1 MiB.');
  entries['README.txt'] = strToU8(BACKUP_README);
  const archive = zipSync(entries, {level: 0, mtime: new Date(1980, 0, 1)});
  if (archive.byteLength > MAX_ARCHIVE_BYTES) throw invalid('the source archive exceeds 18 MiB.');
  return {blob: new Blob([archive], {type: 'application/zip'}), manifest};
}
