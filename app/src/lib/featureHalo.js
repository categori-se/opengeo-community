// Temporary screen-space aid; never changes source geometry or saved Style bytes.
export function clearFeatureHalo(state) {
  for (const id of state.featureHaloIds ?? []) if (state.map?.getLayer(id)) state.map.removeLayer(id);
  state.featureHaloIds=[];state.featureHaloLayerId=null;
}
function haloTarget(context) {
  const {state}=context;
  const layer=context.layers.find(item=>item.layerId===state.activeLayerId);
  const handle=state.layerHandles.get(layer?.layerId);
  const parts=(state.map?.getStyle()?.layers ?? []).filter(p=>handle?.paintLayerIds?.includes(p.id));
  const part=parts.find(p=>p.type==='fill') ?? parts.find(p=>p.type==='line') ?? parts.find(p=>p.type==='circle');
  return {layer,part};
}
export function syncFeatureHalo(context) {
  const {state}=context;
  clearFeatureHalo(state);
  if (!state.featureHaloEnabled || !state.map?.isStyleLoaded?.()) return;
  const {layer,part}=haloTarget(context);
  if (!layer || layer.visible===false) return;
  if (!part) return;
  const width=Math.max(1,Math.min(24,Number(state.featureHaloWidth)||6));
  const opacity=Math.max(0,Math.min(1,Number(state.featureHaloOpacity??0.65)));
  const id=`${layer.layerId}-visibility-halo`;
  const paint=part.type==='circle'
    ? {'circle-color':'#ffce00','circle-radius':['+',part.paint?.['circle-radius']??5,width],'circle-opacity':opacity}
    : {'line-color':'#ffce00','line-width':width*2,'line-opacity':opacity};
  state.map.addLayer({id,type:part.type==='circle'?'circle':'line',source:part.source,
    ...(part['source-layer']?{'source-layer':part['source-layer']}:{}),
    ...(part.filter?{filter:part.filter}:{}),
    ...(part.minzoom!==undefined?{minzoom:part.minzoom}:{}),
    ...(part.maxzoom!==undefined?{maxzoom:part.maxzoom}:{}),
    layout:{visibility:part.layout?.visibility??'visible'},paint},part.id);
  state.featureHaloIds=[id];state.featureHaloLayerId=layer.layerId;
}
export function FeatureHaloControls(context) {
  const {state}=context;
  const {layer,part}=haloTarget(context);
  const root=document.createElement('div');root.className='gis-feature-halo-controls';
  const label=document.createElement('label'),enabled=document.createElement('input');enabled.type='checkbox';enabled.checked=state.featureHaloEnabled===true;
  label.append(enabled,document.createTextNode(' Highlight selected layer'));
  const target=document.createElement('p');target.textContent=layer?`Selected: ${layer.title??layer.name??layer.layerId}`:'Select a vector layer to highlight its features.';
  target.style.overflowWrap='anywhere';
  const size=document.createElement('input');size.type='range';size.min='1';size.max='24';size.step='1';size.value=String(state.featureHaloWidth??6);size.setAttribute('aria-label','Feature halo width');size.disabled=!enabled.checked;
  const sizeLabel=document.createElement('label');sizeLabel.className='gis-feature-halo-slider';sizeLabel.append(document.createTextNode('Halo width'),size);
  const output=document.createElement('output');output.textContent=`${size.value} px`;
  const intensity=document.createElement('input');intensity.type='range';intensity.min='0';intensity.max='100';intensity.step='1';intensity.value=String(Math.round((state.featureHaloOpacity??0.65)*100));intensity.setAttribute('aria-label','Feature halo intensity');intensity.disabled=!enabled.checked;
  const intensityLabel=document.createElement('label');intensityLabel.className='gis-feature-halo-slider';intensityLabel.append(document.createTextNode('Halo intensity'),intensity);
  const intensityOutput=document.createElement('output');intensityOutput.textContent=`${intensity.value}%`;
  const status=document.createElement('p');status.setAttribute('role','status');
  const updateStatus=()=>{status.textContent=!enabled.checked?'':!layer?'Select a vector layer.':layer.visible===false?'Show the selected layer to see its halo.':!part?'Halos are available for vector points, lines and polygons.':'Increase width to make small features and nearby groups easier to spot.'};
  const note=document.createElement('p');note.textContent='Temporary visual aid in screen pixels. Geometry stays unchanged; the halo is not a ground-distance buffer or a cluster count.';
  enabled.addEventListener('change',()=>{state.featureHaloEnabled=enabled.checked;size.disabled=intensity.disabled=!enabled.checked;syncFeatureHalo(context);updateStatus()});
  size.addEventListener('input',()=>{state.featureHaloWidth=Number(size.value);output.textContent=`${size.value} px`;syncFeatureHalo(context)});
  intensity.addEventListener('input',()=>{state.featureHaloOpacity=Number(intensity.value)/100;intensityOutput.textContent=`${intensity.value}%`;syncFeatureHalo(context)});
  updateStatus();root.append(label,target,sizeLabel,output,intensityLabel,intensityOutput,status,note);return root;
}
