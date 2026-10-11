import {createHash} from 'node:crypto';

export const ARTIFACT_INVOCATION_SCHEMA = 'opengeo.observable-runner-invocation.3.0.0';
export const ARTIFACT_REQUEST_SCHEMA = 'opengeo.observable-build-request.2.0.0';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const keys = (value, expected, fail) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) fail('artifact_inputs_invalid');
};

// Same bounded integer-only PostgreSQL jsonb::text encoding used for coordinator seals.
export function artifactJsonbText(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(artifactJsonbText).join(', ')}]`;
  if (value && typeof value === 'object') {
    const ordered = Object.keys(value).sort((a, b) => {
      const x = Buffer.from(a), y = Buffer.from(b);
      return x.length - y.length || Buffer.compare(x, y);
    });
    return `{${ordered.map(key => `${JSON.stringify(key)}: ${artifactJsonbText(value[key])}`).join(', ')}}`;
  }
  throw Error('artifact_jsonb_value_invalid');
}
export const artifactChecksum = value => createHash('sha256').update(artifactJsonbText(value)).digest('hex');

export function artifactInputFiles(manifest, request, safePath, fail) {
  keys(manifest, ['schemaVersion', 'sourceProjectId', 'sourceRevisionId',
    'sourceManifestChecksumSha256', 'referenceRevision', 'artifacts'], fail);
  if (manifest.schemaVersion !== 'opengeo.publication-artifact-inputs.1.0.0'
      || manifest.sourceProjectId !== request.sourceProjectId
      || manifest.sourceRevisionId !== request.sourceRevisionId
      || manifest.sourceManifestChecksumSha256 !== request.sourceManifestChecksumSha256
      || !Number.isSafeInteger(manifest.referenceRevision) || manifest.referenceRevision < 1
      || manifest.referenceRevision > 2147483647
      || !Array.isArray(manifest.artifacts) || !manifest.artifacts.length || manifest.artifacts.length > 32
      || (request.purpose !== 'preview' && !(request.schemaVersion === 'opengeo.observable-build-request.3.0.0'
        && request.purpose === 'release_candidate' && UUID.test(request.distributionApprovalId ?? '')
        && SHA.test(request.distributionApprovalChecksumSha256 ?? '')))) fail('artifact_inputs_invalid');
  const files = manifest.artifacts.map((pin, index) => {
    keys(pin, ['path', 'artifactId', 'version', 'outputObjectId', 'manifestChecksumSha256', 'output'], fail);
    if (!UUID.test(pin.artifactId) || !UUID.test(pin.outputObjectId)
        || !SHA.test(pin.manifestChecksumSha256) || !safePath(pin.path) || !pin.path.endsWith('.html')
        || !Number.isSafeInteger(pin.version) || pin.version < 1 || pin.version > 2147483647
        || (index > 0 && pin.path <= manifest.artifacts[index - 1].path)) fail('artifact_inputs_invalid');
    keys(pin.output, ['objectId', 'mediaType', 'sizeBytes', 'checksumSha256'], fail);
    if (pin.output.objectId !== null || pin.output.mediaType !== 'text/html'
        || !Number.isSafeInteger(pin.output.sizeBytes) || pin.output.sizeBytes < 1
        || pin.output.sizeBytes > 4194304 || !SHA.test(pin.output.checksumSha256)) fail('artifact_inputs_invalid');
    return {path: pin.path, contentType: 'text/html', sizeBytes: pin.output.sizeBytes,
      checksumSha256: pin.output.checksumSha256};
  });
  if (Buffer.byteLength(artifactJsonbText(manifest)) > 65536
      || artifactChecksum(manifest) !== request.artifactInputsChecksumSha256) fail('artifact_inputs_checksum_mismatch');
  return files;
}
