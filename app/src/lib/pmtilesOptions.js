export const PMTILES_OPTIONS_DEFAULTS = Object.freeze({inputLayer:null,extent:4096,simplification:1,
  simplificationMaxZoom:1,buffer:80,maxSize:500000,maxFeatures:200000,attributeNames:null});
export const PMTILES_ADMISSION_REASONS=Object.freeze(['ready','runtime_not_configured','runtime_not_ready','runtime_disabled','runtime_window_active','runtime_limits_invalid','runtime_budget_exhausted','runtime_job_pending','runtime_binding_changed','runtime_status_unavailable']);
const PMTILES_ADMISSION_MESSAGES={
  runtime_not_configured:'The PMTiles runtime is not configured. Contact the workspace operator.',
  runtime_not_ready:'The PMTiles runtime is not ready. Contact the workspace operator.',
  runtime_disabled:'PMTiles conversion is disabled. Contact the workspace operator.',
  runtime_window_active:'The current conversion window is active. Wait for the current conversion to finish, then refresh metadata.',
  runtime_limits_invalid:'The conversion limits need review. Contact the workspace operator.',
  runtime_budget_exhausted:'The conversion budget is exhausted. Contact the workspace operator.',
  runtime_job_pending:'A conversion is already pending. Wait for the current conversion to finish, then refresh metadata.',
  runtime_binding_changed:'The converter configuration changed. Contact the workspace operator.',
  runtime_status_unavailable:'Converter status is unavailable. Refresh metadata or contact the workspace operator.'
};
const FIELDS = Object.keys(PMTILES_OPTIONS_DEFAULTS);
const WIRE = ['input_layer','extent','simplification','simplification_max_zoom','buffer','max_size','max_features','attribute_names'];
const ATTRIBUTE = /^[A-Za-z_][A-Za-z0-9_.:-]{0,99}$/;
export const PMTILES_OUTPUT_LAYER = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;

export function normalizePmtilesOptions(value) {
  if(value===null||value===undefined)return null;
  if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!FIELDS.includes(key)))throw TypeError('PMTiles options contain unsupported fields');
  const result={...PMTILES_OPTIONS_DEFAULTS,...value};
  if(result.inputLayer!==null){
    if(typeof result.inputLayer!=='string')throw TypeError('PMTiles input layer must be a name or empty');
    result.inputLayer=result.inputLayer.trim();
    if(!result.inputLayer||result.inputLayer.length>200||/^[-]|[\x00-\x1f\x7f]/.test(result.inputLayer))throw TypeError('PMTiles input layer is invalid');
  }
  for(const [key,min,max,integer] of [['simplification',0,10,false],['simplificationMaxZoom',0,10,false],['buffer',0,256,true],['maxSize',50000,2000000,true],['maxFeatures',1000,500000,true]]){
    const number=result[key];
    if(typeof number!=='number'||!Number.isFinite(number)||number<min||number>max||(integer&&!Number.isInteger(number)))throw TypeError(`PMTiles ${key} is outside its supported range`);
  }
  if(![2048,4096,8192].includes(result.extent))throw TypeError('PMTiles extent must be 2048, 4096 or 8192');
  if(result.attributeNames!==null){
    const fields=result.attributeNames;
    if(!Array.isArray(fields)||fields.length<1||fields.length>128||new Set(fields).size!==fields.length||fields.some(field=>typeof field!=='string'||!ATTRIBUTE.test(field)))throw TypeError('Choose 1–128 unique attribute field names');
    result.attributeNames=[...fields];
  }
  return result;
}

export function pmtilesOptionsToWire(value) {
  const options=normalizePmtilesOptions(value);
  return options===null?null:Object.fromEntries(FIELDS.map((key,index)=>[WIRE[index],options[key]]));
}

export function pmtilesOptionsFromWire(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==WIRE.length||WIRE.some(key=>!Object.hasOwn(value,key)))throw TypeError('PMTiles response options are incomplete');
  return normalizePmtilesOptions(Object.fromEntries(FIELDS.map((key,index)=>[key,value[WIRE[index]]])));
}

export function pmtilesOptionsSummary(value) {
  const options=normalizePmtilesOptions(value);
  return options?`GDAL adaptive · detail ${options.extent} · simplify ${options.simplification}/${options.simplificationMaxZoom} · buffer ${options.buffer} · tile budget ${options.maxSize.toLocaleString()} bytes / ${options.maxFeatures.toLocaleString()} features · ${options.attributeNames?options.attributeNames.join(', '):'all attributes'} · input ${options.inputLayer??'auto single layer'}`:'GDAL default conversion';
}

export function createPmtilesConversionDraft({datasetVersionId,bounds,sourceLayer='source'}){
  const area=Array.isArray(bounds)&&bounds.length===4?[...bounds]:[];
  return{datasetVersionId,bounds:area,minZoom:0,maxZoom:area[2]-area[0]>120||area[3]-area[1]>60?10:14,
    sourceLayer:PMTILES_OUTPUT_LAYER.test(sourceLayer)?sourceLayer:'source',options:normalizePmtilesOptions({})};
}

export function pmtilesConversionAvailability(format,capabilities){
  if(capabilities===undefined)return{allowed:false,message:'Loading the deployed converter’s supported input formats…'};
  if(capabilities===null)return{allowed:false,message:'Converter capabilities could not be confirmed. Refresh metadata before submitting.'};
  if(!capabilities.inputFormats.includes(format))return{allowed:false,message:`This converter does not currently support ${format}. Supported input formats: ${capabilities.inputFormats.join(', ')}. The original is retained.`};
  if(capabilities.admissionReady!==true||capabilities.admissionReason!=='ready')return{allowed:false,message:PMTILES_ADMISSION_MESSAGES[capabilities.admissionReason]??PMTILES_ADMISSION_MESSAGES.runtime_status_unavailable};
  return{allowed:true,message:''};
}

export function validatePmtilesDraft(draft){
  const b=draft.bounds;
  if(!Array.isArray(b)||b.length!==4||!b.every(Number.isFinite)||b[0]<-180||b[0]>=b[2]||b[2]>180||b[1]<-90||b[1]>=b[3]||b[3]>90)throw TypeError('Enter ordered WGS84 bounds: west, south, east, north.');
  if(!Number.isInteger(draft.minZoom)||!Number.isInteger(draft.maxZoom)||draft.minZoom<0||draft.minZoom>draft.maxZoom||draft.maxZoom>22)throw TypeError('Choose whole-number zoom levels from 0 to 22, with minimum no greater than maximum.');
  if(typeof draft.sourceLayer!=='string'||!PMTILES_OUTPUT_LAYER.test(draft.sourceLayer.trim()))throw TypeError('The output tile layer must start with a letter and use at most 63 letters, digits or underscores.');
  return normalizePmtilesOptions(draft.options);
}

function conversionParameters(draft){return{bounds:[...draft.bounds],minZoom:draft.minZoom,maxZoom:draft.maxZoom,sourceLayer:draft.sourceLayer.trim(),options:validatePmtilesDraft(draft)};}

export function matchingPmtilesJob(draft,jobs){
  const signature=JSON.stringify(conversionParameters(draft));
  return jobs.find(job=>job.datasetVersionId===draft.datasetVersionId&&['queued','running','completed'].includes(job.state)
    &&job.options&&JSON.stringify(conversionParameters({...job,options:job.options}))===signature)??null;
}

/** An unchanged uncertain request may confirm its existing outcome while new admission is held. */
export function pmtilesUnconfirmedRetry(draft,jobs=[]){
  try{return Boolean(draft.requestIntent&&draft.requestIntent.signature===JSON.stringify(conversionParameters(draft))
    &&!jobs.some(job=>job.idempotencyKey===draft.requestIntent.idempotencyKey));}catch{return false;}
}

/** Retain an unconfirmed POST's key; parameter edits and confirmed failures are new deliberate intents. */
export function pmtilesRequestIntent(draft,jobs=[]){
  const parameters=conversionParameters(draft),signature=JSON.stringify(parameters);
  const existing=matchingPmtilesJob(draft,jobs);
  if(existing)return{existing,request:null};
  const prior=draft.requestIntent;
  const confirmed=prior&&jobs.find(job=>job.idempotencyKey===prior.idempotencyKey);
  if(!prior||prior.signature!==signature||['failed','cancelled'].includes(confirmed?.state)){
    draft.requestIntent={signature,idempotencyKey:crypto.randomUUID()};
  }
  return{existing:null,request:{idempotencyKey:draft.requestIntent.idempotencyKey,...parameters}};
}
