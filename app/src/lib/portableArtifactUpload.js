import {verifyPortableMapArtifact} from './portableMapArtifact.js';

/** One reviewed file pair; retain progress across deliberate retries in this panel. */
export function portableArtifactUpload({adapter, projectId, resourceId, blob, manifest}) {
  const snapshot = structuredClone(manifest);
  let ticket = null, attempted = false, uploaded = false, receipt = null, verified = false, busy = false;
  return {async register(expectedRevision) {
    if (busy) throw Error('This Artifact upload is already running.');
    busy = true;
    try {
      if (!verified) {
        if (blob.size > 4_194_304) throw Error('Portable Artifact HTML must be at most 4 MiB.');
        await verifyPortableMapArtifact(blob, snapshot);
        if (snapshot.canonicalization !== 'opengeo-codepoint-decimal-v1' || !snapshot.provenance?.originatingProject) {
          throw Error('Export this saved Project again to obtain a registration-ready manifest.');
        }
        verified = true;
      }
      if (!ticket) ticket = await adapter.requestPortableArtifactUpload(projectId, resourceId, snapshot, expectedRevision);
      if (!receipt && attempted && !uploaded) {
        try {receipt = await adapter.completePortableArtifactUpload(projectId, resourceId, ticket.upload_id);}
        catch (error) {
          if (error.code !== 'artifact_upload_object_missing') throw error;
        }
      }
      if (!receipt && !uploaded) {
        if (Date.parse(ticket.expires_at) <= Date.now()) throw Error('This upload ticket expired. Select the files again to start a new upload.');
        attempted = true;
        await adapter.uploadFile(ticket, blob);
        uploaded = true;
      }
      if (!receipt) receipt = await adapter.completePortableArtifactUpload(projectId, resourceId, ticket.upload_id);
      return await adapter.registerPortableArtifactEdition(projectId, resourceId, receipt.output_object_id, snapshot, expectedRevision);
    } finally {busy = false;}
  }};
}
