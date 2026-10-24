import {canonicalJson} from './artifactCanonicalJson.js';
import {createManagedUploadSession,sha256Hex} from './managedUpload.js';
import {archivedBuildingReviewReceipt} from './buildingReviewArchive.js';
import {archivedReceptorScreeningReceipt,assertReceptorScreeningFeatures} from './receptorScreeningArchive.js';
import {rasterAnalysisEvidence,archivedRasterAnalysisReceipt} from './rasterAnalysisArchive.js';
import {verifyRasterValidationPlanIdentity} from './rasterValidation.js';
import {mappedFieldSourceEvidence} from './fieldInventory.js';
import {assertKnowledgeSize} from './sourceReferenceKnowledge.js';
import {FTW_GLOBAL} from './publishedBaselineSources.js';

const DCT = 'http://purl.org/dc/terms/';
const PROV = 'http://www.w3.org/ns/prov#';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OUTPUT_PREFLIGHT_ID = '00000000-0000-4000-8000-000000000000';
const FIELD_SUMMARY = 'opengeo.mapped-field-inventory.1.0.0';
const plain = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function analysisKnowledge({datasetId, datasetVersionId, receipt, review, timestamp, reviewArchiveSha256, screeningArchiveSha256,
  rasterEvidence, rasterArchiveSha256}) {
  if (![datasetId, datasetVersionId].every(id => UUID.test(id ?? ''))) throw Error('Analysis identity is missing.');
  if (!Number.isFinite(Date.parse(timestamp)) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)) throw Error('Timestamp must include a timezone.');
  const external = publicFieldReceipt(receipt);
  if (external) receipt = external.receipt;
  const distribution = `urn:opengeo:dataset:${datasetId}:version:${datasetVersionId}:original`;
  if (receipt?.operation === 'building-reconcile-reviewed') {
    receipt = archivedBuildingReviewReceipt(receipt, {distributionId: distribution, sha256: reviewArchiveSha256});
  }
  if (receipt?.operation === 'receptor-screen') {
    receipt = archivedReceptorScreeningReceipt(receipt, {distributionId: distribution, sha256: screeningArchiveSha256});
  }
  if (rasterEvidence) {
    if (canonicalJson(receipt) !== canonicalJson({[rasterEvidence.kind]: rasterEvidence.report})) throw Error('The raster report changed.');
    receipt = archivedRasterAnalysisReceipt(rasterEvidence, {distributionId: distribution, sha256: rasterArchiveSha256});
  }
  const receiptId = `urn:opengeo:dataset:${datasetId}:analysis`;
  const inputs = [];
  if (!external && !rasterEvidence) {
    if (!UUID.test(receipt?.sourceDatasetId ?? '')) throw Error('Analysis identity is missing.');
    inputs.push([receipt.sourceDatasetId, receipt.source_generation]);
    if (receipt.targetDatasetId) inputs.push([receipt.targetDatasetId, receipt.target_generation]);
    if (receipt.operation === 'receptor-screen') {
      const influence = receipt.screening.inputs.influence;
      if (!inputs.some(([id, generation]) => id === influence.datasetId && generation === influence.generation)) {
        inputs.push([influence.datasetId, influence.generation]);
      }
    }
    if (inputs.some(([id, generation]) => !UUID.test(id) || !Number.isSafeInteger(generation) || generation < 1)) throw Error('Analysis input generation is missing.');
  }
  const claim = (subject, property, value) => ({subject, property, value: value || null,
    provenance: value ? 'curator_asserted' : 'unknown', method: 'derived_layer_review', timestamp});
  const document = {
    schemaVersion: '1.0.0',
    distributions: [{id: distribution, custody: 'derived', format: 'geojson', mediaType: 'application/geo+json'}],
    metadata: {
      source: [{id: receiptId, content: JSON.stringify(receipt), mediaType: 'application/json', sourceUrl: receiptId, retrievedAt: timestamp}],
      normalized: [{subject: 'resource', property: `${PROV}wasGeneratedBy`, value: receipt,
        provenance: 'derived', method: rasterEvidence ? {rasterComparison: 'cached_raster_comparison', rasterPatches: 'cached_raster_patches',
          rasterValidation: 'cached_raster_validation', rasterHeightDifference: 'cached_raster_height_difference'}[rasterEvidence.kind]
          : external ? external.measured ? 'mapped_field_area_inventory' : 'published_product_field_query'
          : receipt.operation === 'building-reconcile-reviewed' ? 'building_inventory_review'
            : receipt.operation === 'receptor-screen' ? 'receptor_overlap_screening' : 'native_vector_analysis',
        timestamp, evidence: external ? [receiptId, external.evidence.source.partitionUrl] : [receiptId]}],
      curated: [claim('resource', `${DCT}title`, review.title), claim('resource', `${DCT}description`, review.description),
        claim(distribution, `${DCT}license`, review.license), claim(distribution, 'https://schema.org/creditText', review.attribution),
        claim(distribution, `${DCT}accessRights`, null), claim(distribution, `${DCT}rights`, null)],
      inferred: []
    },
    context: rasterEvidence ? Object.values(rasterEvidence.inputs).map(input => ({resourceId: input.pins.datasetId && input.pins.datasetVersionId
      ? `urn:opengeo:dataset:${input.pins.datasetId}:version:${input.pins.datasetVersionId}` : input.source.reference.url,
      relationship: `${PROV}wasDerivedFrom`, evidence: [receiptId]}))
      : external ? [{resourceId: external.evidence.source.partitionUrl, relationship: `${PROV}wasDerivedFrom`, evidence: [receiptId]}]
      : inputs.map(([id, generation]) => ({resourceId: `urn:opengeo:dataset:${id}:generation:${generation}`,
        relationship: `${PROV}wasDerivedFrom`, evidence: [receiptId]}))
  };
  prospectiveKnowledge(document);
  return document;
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
  const measured = collection?.fieldInventory?.schemaVersion === FIELD_SUMMARY;
  const rasterEvidence = rasterAnalysisEvidence(collection);
  let receipt = structuredClone(measured ? collection.fieldInventory : collection?.['opengeo:analysis']);
  const external = publicFieldReceipt(receipt);
  if (external) receipt = external.receipt;
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features) || !collection.features.length
    || collection.features.length > (rasterEvidence?.kind === 'rasterValidation' ? 512 : rasterEvidence ? 1024 : 1000)
    || (!external && !rasterEvidence && (receipt?.persisted !== false || receipt.crs !== 'CRS:84'))
    || measured && receipt.featureCount !== collection.features.length) throw Error('A nonempty bounded analysis preview is required.');
  const timestamp = now();
  if (!Number.isFinite(Date.parse(timestamp)) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)) throw Error('Timestamp must include a timezone.');
  // Validate lineage before issuing any write.
  // These IDs stand in only for the not-yet-created output. Public source
  // identity remains the observed partition URL/ETag/size, never a dummy UUID.
  const reviewedBuilding = receipt?.operation === 'building-reconcile-reviewed';
  const screened = receipt?.operation === 'receptor-screen';
  if (reviewedBuilding && receipt.buildingReview?.retainedFeatureCount !== collection.features.length) throw Error('The reviewed footprint count changed.');
  if (screened) assertReceptorScreeningFeatures(collection.features, receipt.screening);
  analysisKnowledge({datasetId: OUTPUT_PREFLIGHT_ID, datasetVersionId: OUTPUT_PREFLIGHT_ID, receipt, review: frozen, timestamp,
    reviewArchiveSha256: reviewedBuilding ? '0'.repeat(64) : undefined,
    screeningArchiveSha256: screened ? '0'.repeat(64) : undefined,
    rasterEvidence, rasterArchiveSha256: rasterEvidence ? '0'.repeat(64) : undefined});
  // Archive the full audit once with its original data. Normal map readers
  // deliberately omit collection properties; metadata retains its exact reference.
  const file = new File([JSON.stringify({type: 'FeatureCollection', features: collection.features,
    ...(reviewedBuilding || screened || rasterEvidence ? {properties: {'opengeo:analysis': receipt}} : {})})], 'derived-analysis.geojson', {type: 'application/geo+json'});
  if (file.size > 2_200_000) throw Error('Analysis exceeds its byte limit.');
  const upload = createManagedUploadSession({adapter, projectId, file, name: frozen.title,
    description: frozen.description, classification: 'restricted', format: 'geojson', tags: ['derived-analysis'], assertCurrentScope, onStage});
  let document, result, inFlight, reviewArchiveSha256, screeningArchiveSha256, rasterArchiveSha256, validationPlanVerified = false;
  const execute = async () => {
    await assertCurrentScope();
    if (result) return result;
    if (rasterEvidence?.kind === 'rasterValidation' && !validationPlanVerified) {
      await verifyRasterValidationPlanIdentity(rasterEvidence.report);
      await assertCurrentScope();
      validationPlanVerified = true;
    }
    if (reviewedBuilding && !reviewArchiveSha256) {
      reviewArchiveSha256 = await sha256Hex(new Blob([canonicalJson(receipt.buildingReview)]));
      await assertCurrentScope();
      analysisKnowledge({datasetId: OUTPUT_PREFLIGHT_ID, datasetVersionId: OUTPUT_PREFLIGHT_ID,
        receipt, review: frozen, timestamp, reviewArchiveSha256});
    }
    if (screened && !screeningArchiveSha256) {
      screeningArchiveSha256 = await sha256Hex(new Blob([canonicalJson(receipt.screening)]));
      await assertCurrentScope();
      analysisKnowledge({datasetId: OUTPUT_PREFLIGHT_ID, datasetVersionId: OUTPUT_PREFLIGHT_ID,
        receipt, review: frozen, timestamp, screeningArchiveSha256});
    }
    if (rasterEvidence && !rasterArchiveSha256) {
      rasterArchiveSha256 = await sha256Hex(new Blob([canonicalJson(rasterEvidence.report)]));
      await assertCurrentScope();
      analysisKnowledge({datasetId: OUTPUT_PREFLIGHT_ID, datasetVersionId: OUTPUT_PREFLIGHT_ID,
        receipt, review: frozen, timestamp, rasterEvidence, rasterArchiveSha256});
    }
    const completion = await upload.run();
    document ??= analysisKnowledge({datasetId: completion.dataset.id, datasetVersionId: completion.datasetVersionId,
      receipt, review: frozen, timestamp, reviewArchiveSha256, screeningArchiveSha256, rasterEvidence, rasterArchiveSha256});
    await assertCurrentScope();
    onStage('metadata', 'Saving lineage and reviewed distribution terms…');
    const current = await adapter.getDatasetKnowledge(completion.dataset.id);
    await assertCurrentScope();
    if (canonicalJson(current.document) === canonicalJson(document)) return result = {...completion, knowledge: current};
    if (current.version !== 0) throw Error('Metadata changed. Review the existing catalog record before saving.');
    await assertCurrentScope();
    const knowledge = await adapter.saveDatasetKnowledge(completion.dataset.id, {expectedVersion: 0, document});
    await assertCurrentScope();
    return result = {...completion, knowledge};
  };
  return {run() {if (!inFlight) inFlight = execute().finally(() => {inFlight = null;}); return inFlight;},
    get datasetId() {return upload.datasetId;}};
}

function publicFieldReceipt(receipt) {
  const measured = receipt?.schemaVersion === FIELD_SUMMARY;
  if (!measured && receipt?.operation !== 'ftw-fields') return null;
  if (!measured && (receipt.persisted !== undefined && receipt.persisted !== false
    || receipt.crs !== undefined && receipt.crs !== 'CRS:84')) throw Error('A temporary CRS:84 field query is required.');
  const evidence = mappedFieldSourceEvidence(measured ? {fieldInventory: receipt} : {'opengeo:analysis': receipt});
  if (!evidence) throw Error('A recognized public field source receipt is required.');
  const source = evidence.source;
  if (source.catalogUrl !== FTW_GLOBAL.catalogUrl || source.collectionUrl !== FTW_GLOBAL.vectorCollectionUrl
    || !source.partitionUrl.startsWith('https://data.source.coop/ftw/global-data/predictions/vectors/')
    || !new URL(source.partitionUrl).pathname.endsWith('.parquet')
    || typeof source.etag !== 'string' || !source.etag.trim() || source.etag.length > 1024
    || !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 1) throw Error('The observed public field partition URL, ETag and byte size are required.');
  if (evidence.ranges?.some(range => range.url !== source.partitionUrl || range.etag !== source.etag
    || ![range.start, range.endExclusive, range.bytes].every(Number.isSafeInteger)
    || range.start < 0 || range.endExclusive <= range.start || range.endExclusive > source.sizeBytes
    || range.bytes !== range.endExclusive - range.start)) throw Error('The observed public field range evidence does not match its partition snapshot.');
  if (!measured) return {measured, evidence, receipt: {operation: 'ftw-fields', persisted: false, crs: 'CRS:84', receipt: evidence}};
  const pick = (value, keys) => {
    if (!plain(value)) throw Error('The field inventory summary is invalid.');
    return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, structuredClone(value[key])]));
  };
  const summary = pick(receipt, ['schemaVersion', 'operation', 'version', 'featureCount', 'polygonPartCount', 'positionCount',
    'totalAreaSquareMeters', 'totalAreaHectares', 'excludedFeatures', 'limitations']);
  summary.source = pick(receipt.source, ['sourceLayerId', 'datasetId', 'sourceGeneration']);
  summary.scope = pick(receipt.scope, ['kind', 'aoiClipped', 'coverageCompleteness', 'rowIndexBase']);
  summary.method = pick(receipt.method, ['id', 'version', 'radiusMeters', 'crs', 'areaUnit', 'secondaryAreaUnit', 'holes', 'aggregation', 'topology']);
  summary.limits = pick(receipt.limits, ['features', 'positions', 'outputBytes', 'milliseconds', 'longitudeSpanDegrees', 'maximumAbsoluteLatitude']);
  summary.sourceEvidence = evidence;
  if (summary.operation !== 'mapped-field-inventory' || summary.version !== '1.0.0'
    || !Number.isSafeInteger(summary.featureCount) || summary.featureCount < 1 || summary.featureCount > 1000
    || !Number.isSafeInteger(summary.polygonPartCount) || summary.polygonPartCount < 1
    || !Number.isSafeInteger(summary.positionCount) || summary.positionCount < 4 || summary.positionCount > 50_000
    || summary.excludedFeatures !== 0 || !Number.isFinite(summary.totalAreaSquareMeters) || summary.totalAreaSquareMeters <= 0
    || !Number.isFinite(summary.totalAreaHectares) || summary.totalAreaHectares <= 0
    || Math.abs(summary.totalAreaHectares * 10_000 - summary.totalAreaSquareMeters) > Math.max(1e-8, summary.totalAreaSquareMeters * 1e-12)
    || summary.method.id !== 'openlayers-spherical-polygon-area' || summary.method.areaUnit !== 'square-meter'
    || summary.method.secondaryAreaUnit !== 'hectare' || summary.scope.aoiClipped !== false
    || !Array.isArray(summary.limitations) || summary.limitations.some(value => typeof value !== 'string')) throw Error('The field inventory method, counts or measured areas are invalid.');
  return {measured, evidence, receipt: summary};
}

function prospectiveKnowledge(document) {
  assertKnowledgeSize(document);
  // Match the server's bounded structure and its JSON spaces. Exponent padding
  // covers Python's e-07 rendering, so a compact browser payload cannot pass
  // this preflight only to exceed the server's 49,152-byte serialization bound.
  const stack = [[document, 0]]; let nodes = 0, spacing = 0;
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (++nodes > 4096 || depth > 24) throw Error('The analysis knowledge structure exceeds its limit.');
    if (Array.isArray(value)) {
      spacing += Math.max(0, value.length - 1);
      stack.push(...value.map(item => [item, depth + 1]));
    } else if (plain(value)) {
      const values = Object.values(value); spacing += values.length + Math.max(0, values.length - 1);
      stack.push(...values.map(item => [item, depth + 1]));
    } else if (typeof value === 'number' && /e-\d$/.test(String(value))) spacing++;
  }
  if (new TextEncoder().encode(JSON.stringify(document)).byteLength + spacing > 49_152) throw Error('The analysis knowledge exceeds 49,152 bytes.');
}
