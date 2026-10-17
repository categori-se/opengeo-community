import {normalizePmtilesOptions,validatePmtilesDraft,matchingPmtilesJob,pmtilesUnconfirmedRetry} from '../lib/pmtilesOptions.js';

/** Shared controls only. Callers own authorization, durable submission and job refresh. */
export function PmtilesConversionEditor({draft,versionLabel,busy=false,jobs=[],availability={allowed:true,message:''},onSubmit}){
  const node=(tag,text='')=>{const e=document.createElement(tag);e.textContent=text;return e;};
  const field=(name,value,type='text')=>{const wrapper=node('label');wrapper.className='gis-field';const input=node('input');input.type=type;input.value=value;input.setAttribute('aria-label',name);wrapper.append(node('span',name),input);return{wrapper,input};};
  const choice=(name,value,items,onChange)=>{const wrapper=node('label');wrapper.className='gis-field';const input=node('select');input.setAttribute('aria-label',name);for(const [id,label]of items){const option=node('option',label);option.value=id;input.append(option);}input.value=value;wrapper.append(node('span',name),input);if(onChange)input.addEventListener('change',()=>onChange(input.value));return{wrapper,input};};
  const root=node('section');root.className='pmtiles-conversion-editor';root.setAttribute('aria-busy',String(busy));
  root.append(node('h3','Convert vector to PMTiles'),node('p','Create reusable map tiles from this saved dataset version. The original remains available for analysis.'),node('p',`Dataset version: ${versionLabel??draft.datasetVersionId} · GDAL adaptive generalization`));
  draft.options??=normalizePmtilesOptions({});
  const bounds=field('WGS84 bounds · west, south, east, north',draft.bounds.join(', '));
  const inputLayer=field('Input layer · blank auto-detects a single layer',draft.options.inputLayer??'');inputLayer.input.placeholder='Auto-detect one source layer';
  const sourceLayer=field('Output tile layer',draft.sourceLayer);sourceLayer.input.maxLength=63;
  const minimum=field('Minimum zoom',String(draft.minZoom),'number'),maximum=field('Maximum zoom',String(draft.maxZoom),'number');
  for(const input of [minimum.input,maximum.input])Object.assign(input,{min:'0',max:'22',step:'1',required:true});
  const details=node('details');details.append(node('summary','Geometry detail, tile budgets and attributes'));
  const extent=choice('Tile coordinate extent',String(draft.options.extent),[['2048','2048 · compact'],['4096','4096 · balanced'],['8192','8192 · more detail']]);
  const numeric=[['simplification','Simplification below maximum zoom',0,10,.1],['simplificationMaxZoom','Simplification at maximum zoom',0,10,.1],['buffer','Tile buffer',0,256,1],['maxSize','Tile budget · bytes',50000,2000000,1000],['maxFeatures','Tile budget · features',1000,500000,1000]].map(([key,name,min,max,step])=>{const control=field(name,String(draft.options[key]),'number');Object.assign(control.input,{min:String(min),max:String(max),step:String(step),required:true});return{key,...control};});
  const attributes=field('Included attribute fields · comma-separated',(draft.options.attributeNames??[]).join(', '));
  const mode=choice('Attributes',draft.options.attributeNames?'include':'all',[['all','All source attributes'],['include','Choose fields']]);attributes.wrapper.hidden=mode.input.value==='all';
  details.append(extent.wrapper,...numeric.map(control=>control.wrapper),node('p','Extent controls coordinate precision within each tile. Higher simplification removes more geometry detail; zero disables simplification.'),mode.wrapper,attributes.wrapper);
  const validation=node('p');validation.setAttribute('role','status');
  const submit=node('button',busy?'Queuing conversion…':'Queue on-demand conversion');submit.type='button';
  const inputs=[bounds.input,inputLayer.input,sourceLayer.input,minimum.input,maximum.input,extent.input,...numeric.map(control=>control.input),mode.input,attributes.input];
  const update=()=>{
    draft.bounds=bounds.input.value.split(',').map(value=>Number(value.trim()));draft.sourceLayer=sourceLayer.input.value;
    draft.minZoom=minimum.input.value===''?NaN:Number(minimum.input.value);draft.maxZoom=maximum.input.value===''?NaN:Number(maximum.input.value);
    draft.options={inputLayer:inputLayer.input.value.trim()||null,extent:Number(extent.input.value),...Object.fromEntries(numeric.map(control=>[control.key,control.input.value===''?NaN:Number(control.input.value)])),attributeNames:mode.input.value==='all'?null:attributes.input.value.split(',').map(value=>value.trim()).filter(Boolean)};
    attributes.wrapper.hidden=mode.input.value==='all';
    try{
      validatePmtilesDraft(draft);const existing=matchingPmtilesJob(draft,jobs);
      const retry=pmtilesUnconfirmedRetry(draft,jobs);
      validation.textContent=existing?`A matching conversion is ${existing.state}. Review the saved job below; no duplicate conversion is needed.`:availability.message+(!availability.allowed&&retry?' You may retry the unchanged request to confirm its outcome; no new request key is created.':'');
      submit.textContent=busy?'Queuing conversion…':!availability.allowed&&retry?'Retry unchanged request':'Queue on-demand conversion';
      submit.disabled=busy||Boolean(existing)||(!availability.allowed&&!retry);
    }catch(error){validation.textContent=error.message;submit.disabled=true;}
  };
  for(const input of inputs){input.disabled=busy;input.addEventListener(input.tagName==='SELECT'?'change':'input',update);}
  submit.addEventListener('click',()=>{update();if(!submit.disabled)onSubmit();});
  root.append(bounds.wrapper,inputLayer.wrapper,sourceLayer.wrapper,minimum.wrapper,maximum.wrapper,details,node('p','Adaptive conversion may reduce coordinate precision or omit features to meet tile budgets. Use the preserved original for analysis.'),node('p','Higher maximum zooms increase conversion work and archive size.'),validation,submit);
  update();return root;
}
