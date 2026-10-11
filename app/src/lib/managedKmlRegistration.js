import {canonicalJson} from './artifactCanonicalJson.js';
import {createManagedUploadSession} from './managedUpload.js';

const DCT = 'http://purl.org/dc/terms/';

export function managedKmlKnowledge({datasetId, datasetVersionId, review, sourceTitle, timestamp}) {
  if (![datasetId,datasetVersionId].every(id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) throw Error('Source version identity is missing.');
  if (!Number.isFinite(Date.parse(timestamp)) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)) throw Error('Metadata timestamp must include a timezone.');
  const distribution = `urn:opengeo:dataset:${datasetId}:version:${datasetVersionId}:original`;
  const claim = (subject, property, value, provenance, method) => ({subject, property:/^https?:/.test(property) ? property : DCT+property,
    value, provenance:value === null ? 'unknown' : provenance, method, timestamp});
  const curated = [claim('resource','title',review.title,'curator_asserted','source_review'),
    claim('resource','description',review.description || null,'curator_asserted','source_review'),
    claim(distribution,'license',review.license || null,'curator_asserted','source_review'),
    claim(distribution,'https://schema.org/creditText',review.attribution || null,'curator_asserted','source_review')];
  const normalized = typeof sourceTitle === 'string' && sourceTitle.length > 0 && sourceTitle.length <= 1000
    ? [{...claim('resource','title',sourceTitle,'source_asserted','kml_document_name'),evidence:[distribution]}] : [];
  return {schemaVersion:'1.0.0', distributions:[{id:distribution,custody:'hosted',format:'kml',
    mediaType:'application/vnd.google-earth.kml+xml'}], metadata:{source:[],normalized,curated,inferred:[]},context:[]};
}

// The owner must bind scope to its account/user/project and retain this session on failure.
export function createManagedKmlRegistration({adapter, projectId, file, review, sourceTitle,
  assertCurrentScope, onStage = () => {}, now = () => new Date().toISOString()}) {
  if (typeof adapter?.getDatasetKnowledge !== 'function' || typeof adapter?.saveDatasetKnowledge !== 'function') throw Error('Managed source metadata is unavailable.');
  if (typeof assertCurrentScope !== 'function') throw Error('Registration requires an account scope guard.');
  const frozen = structuredClone(review);
  if (typeof frozen?.title !== 'string' || !frozen.title.trim() || frozen.title.length > 160) throw Error('Layer title is required.');
  for (const key of ['description','license','attribution']) if (frozen[key] != null && (typeof frozen[key] !== 'string' || frozen[key].length > 1000)) throw Error('Reviewed metadata is too long.');
  const timestamp = now();
  if (!Number.isFinite(Date.parse(timestamp)) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)) throw Error('Metadata timestamp must include a timezone.');
  const upload = createManagedUploadSession({adapter,projectId,file,name:frozen.title,
    description:frozen.description,format:'kml',assertCurrentScope,onStage});
  let document, result, inFlight;
  const execute = async () => {
    await assertCurrentScope();
    if (result) return result;
    const completion = await upload.run();
    document ??= managedKmlKnowledge({datasetId:completion.dataset.id,datasetVersionId:completion.datasetVersionId,
      review:frozen,sourceTitle,timestamp});
    await assertCurrentScope();
    onStage('metadata','Saving reviewed source metadata…');
    const current = await adapter.getDatasetKnowledge(completion.dataset.id);
    if (canonicalJson(current.document) === canonicalJson(document)) return result = {...completion,knowledge:current};
    if (current.version !== 0) throw Object.assign(Error('Metadata changed. Review the existing record before saving.'),{code:'metadata_version_conflict'});
    await assertCurrentScope();
    const knowledge = await adapter.saveDatasetKnowledge(completion.dataset.id,{expectedVersion:0,document:structuredClone(document)});
    return result = {...completion,knowledge};
  };
  return {run() {if (!inFlight) inFlight = execute().finally(()=>{inFlight=null;}); return inFlight;},
    get datasetId() {return upload.datasetId;}};
}
