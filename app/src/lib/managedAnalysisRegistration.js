import {canonicalJson} from './artifactCanonicalJson.js';
import {createManagedUploadSession} from './managedUpload.js';

const DCT = 'http://purl.org/dc/terms/';
const PROV = 'http://www.w3.org/ns/prov#';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function analysisKnowledge({datasetId, datasetVersionId, receipt, review, timestamp}) {
  if (![datasetId, datasetVersionId, receipt.sourceDatasetId].every(id => UUID.test(id ?? ''))) throw Error('Analysis identity is missing.');
  const distribution = `urn:opengeo:dataset:${datasetId}:version:${datasetVersionId}:original`;
  const receiptId = `urn:opengeo:dataset:${datasetId}:analysis`;
  const inputs = [[receipt.sourceDatasetId, receipt.source_generation]];
  if (receipt.targetDatasetId) inputs.push([receipt.targetDatasetId, receipt.target_generation]);
  if (inputs.some(([id, generation]) => !UUID.test(id) || !Number.isSafeInteger(generation) || generation < 1)) throw Error('Analysis input generation is missing.');
  const claim = (subject, property, value) => ({subject, property, value: value || null,
    provenance: value ? 'curator_asserted' : 'unknown', method: 'derived_layer_review', timestamp});
  return {
    schemaVersion: '1.0.0',
    distributions: [{id: distribution, custody: 'derived', format: 'geojson', mediaType: 'application/geo+json'}],
    metadata: {
      source: [{id: receiptId, content: JSON.stringify(receipt), mediaType: 'application/json', sourceUrl: receiptId, retrievedAt: timestamp}],
      normalized: [{subject: 'resource', property: `${PROV}wasGeneratedBy`, value: receipt,
        provenance: 'derived', method: 'native_vector_analysis', timestamp, evidence: [receiptId]}],
      curated: [claim('resource', `${DCT}title`, review.title), claim('resource', `${DCT}description`, review.description),
        claim(distribution, `${DCT}license`, review.license), claim(distribution, 'https://schema.org/creditText', review.attribution),
        claim(distribution, `${DCT}accessRights`, null), claim(distribution, `${DCT}rights`, null)],
      inferred: []
    },
    context: inputs.map(([id, generation]) => ({resourceId: `urn:opengeo:dataset:${id}:generation:${generation}`,
      relationship: `${PROV}wasDerivedFrom`, evidence: [receiptId]}))
  };
}

// Retain this session on failure: upload and metadata commits are independent checkpoints.
export function createManagedAnalysisRegistration({adapter, projectId, collection, review,
  assertCurrentScope, onStage = () => {}, now = () => new Date().toISOString()}) {
  if (typeof assertCurrentScope !== 'function') throw Error('Registration requires a scope guard.');
  if (!adapter?.getDatasetKnowledge || !adapter?.saveDatasetKnowledge) throw Error('Catalog metadata is unavailable.');
  const frozen = structuredClone(review);
  if (typeof frozen.title !== 'string' || !frozen.title.trim() || frozen.title.length > 160) throw Error('Enter a layer title of at most 160 characters.');
  frozen.title = frozen.title.trim();
  for (const key of ['description', 'license', 'attribution']) {
    if (frozen[key] != null && (typeof frozen[key] !== 'string' || frozen[key].length > 1000)) throw Error('Reviewed metadata exceeds 1,000 characters.');
  }
  const receipt = structuredClone(collection?.['opengeo:analysis']);
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features) || !collection.features.length
    || collection.features.length > 1000 || receipt?.persisted !== false || receipt.crs !== 'CRS:84') throw Error('A nonempty bounded analysis preview is required.');
  const timestamp = now();
  if (!Number.isFinite(Date.parse(timestamp)) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)) throw Error('Timestamp must include a timezone.');
  // Validate lineage before issuing any write.
  analysisKnowledge({datasetId: receipt.sourceDatasetId, datasetVersionId: receipt.sourceDatasetId, receipt, review: frozen, timestamp});
  // Keep the data representation interoperable; the exact receipt is preserved in knowledge.
  const file = new File([JSON.stringify({type: 'FeatureCollection', features: collection.features})], 'derived-analysis.geojson', {type: 'application/geo+json'});
  if (file.size > 2_200_000) throw Error('Analysis exceeds its byte limit.');
  const upload = createManagedUploadSession({adapter, projectId, file, name: frozen.title,
    description: frozen.description, classification: 'restricted', format: 'geojson', tags: ['derived-analysis'], assertCurrentScope, onStage});
  let document, result, inFlight;
  const execute = async () => {
    await assertCurrentScope();
    if (result) return result;
    const completion = await upload.run();
    document ??= analysisKnowledge({datasetId: completion.dataset.id, datasetVersionId: completion.datasetVersionId,
      receipt, review: frozen, timestamp});
    await assertCurrentScope();
    onStage('metadata', 'Saving lineage and reviewed distribution terms…');
    const current = await adapter.getDatasetKnowledge(completion.dataset.id);
    if (canonicalJson(current.document) === canonicalJson(document)) return result = {...completion, knowledge: current};
    if (current.version !== 0) throw Error('Metadata changed. Review the existing catalog record before saving.');
    await assertCurrentScope();
    const knowledge = await adapter.saveDatasetKnowledge(completion.dataset.id, {expectedVersion: 0, document});
    return result = {...completion, knowledge};
  };
  return {run() {if (!inFlight) inFlight = execute().finally(() => {inFlight = null;}); return inFlight;},
    get datasetId() {return upload.datasetId;}};
}
