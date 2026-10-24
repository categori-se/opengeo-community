/** Compare declared surface and terrain elevations in resident aligned windows.
 * The numerical module loads only after an explicit calculation. */
export function RasterHeightDifference({getCandidates=()=>[],captureScope=()=>()=>true,onDownload,onAdd}={}) {
  const root=node("details");root.className="gis-raster-comparison gis-raster-height-difference";
  root.append(node("summary","Compare surface and terrain heights"),node("p","Subtract terrain elevation (DTM) from surface elevation (DSM) in aligned, already loaded raster windows. Declare each band's role and units, then review vertical references, source dates and methods. No resampling or additional raster reads occur."));
  const source=node("p"),form=node("form"),surface=sourceFields("Surface","DSM"),terrain=sourceFields("Terrain","DTM"),
    compatible=checkbox("The vertical references and source methods are compatible"),basis=textarea("Height comparison basis");
  basis.input.required=true;basis.input.maxLength=500;basis.input.rows=3;
  const calculate=button("Calculate height differences"),cancel=button("Cancel height comparison");calculate.type="submit";cancel.disabled=true;
  form.append(surface.group,terrain.group,compatible.label,basis.label,node("p","Record the vertical datum or reference, source dates, method compatibility and known limits. These are your declarations; matching grids do not establish compatible vertical references."),calculate,cancel);
  const status=node("p");status.setAttribute("role","status");status.setAttribute("aria-live","polite");
  const output=node("section");output.className="raster-comparison-results";
  const json=button("Download height JSON"),csv=button("Download height summary CSV"),geojson=button("Download height cells GeoJSON"),add=button("Add height cells to map");
  let disposed=false,generation=0,controller=null,library=null,result=null,captured=null,added=false,choiceSignature=null;
  const known={surface:null,terrain:null},sides={surface,terrain},fields=[surface.raster,surface.band,surface.units,surface.confirm,terrain.raster,terrain.band,terrain.units,terrain.confirm,compatible,basis];
  const criteria=()=>JSON.stringify(fields.map(({input})=>input.type==="checkbox"?input.checked:input.value));
  const candidates=()=>{try{return (getCandidates?.()??[]).filter(value=>value?.id!==undefined&&value?.id!==null&&value.grid);}catch{return [];}};
  const find=(items,id)=>items.find(value=>String(value.id)===id);
  function capture(candidate) {
    const pins=structuredClone(candidate.pins??null);
    return {id:String(candidate.id),grid:candidate.grid,pins,pinsKey:signature(pins),gridKey:gridKey(candidate.grid),isCurrent:candidate.isCurrent};
  }
  function sourceCurrent(saved,items) {
    try {
      const candidate=saved&&find(items,saved.id);
      return Boolean(candidate&&saved.grid.active()&&candidate.grid.active()&&saved.isCurrent?.()!==false&&candidate.isCurrent?.()!==false
        &&saved.pinsKey===signature(saved.pins)&&saved.pinsKey===signature(candidate.pins??null)
        &&saved.gridKey===gridKey(saved.grid)&&saved.gridKey===gridKey(candidate.grid));
    }catch{return false;}
  }
  const current=(saved,items=candidates())=>{
    try{return Boolean(saved&&!disposed&&saved.generation===generation&&saved.criteria===criteria()&&saved.scope()!==false
      &&sourceCurrent(saved.surface,items)&&sourceCurrent(saved.terrain,items));}catch{return false;}
  };
  const actions=()=>{
    const ready=Boolean(result&&current(captured)),mapped=ready&&result.map.available;
    json.disabled=csv.disabled=!ready||typeof onDownload!=="function";
    geojson.disabled=!mapped||typeof onDownload!=="function";
    add.disabled=!mapped||result.map.totalCells===0||typeof onAdd!=="function"||added;
  };
  function invalidate() {
    generation++;controller?.abort();controller=null;result=null;captured=null;added=false;
    output.replaceChildren();cancel.disabled=true;calculate.disabled=disposed;actions();
  }
  const sameInput=(first,second)=>surface.band.input.value===terrain.band.input.value&&Boolean(first&&second
    &&(String(first.id)===String(second.id)||first.grid===second.grid||first.pins?.layerId&&first.pins.layerId===second.pins?.layerId));
  root.updateSource=()=>{
    if(disposed)return;
    const items=candidates();
    if(captured&&!current(captured,items)){invalidate();status.textContent="The height settings, source windows or Project context changed. Review both inputs and calculate again.";}
    const nextSignature=JSON.stringify(items.map(value=>[String(value.id),String(value.title??value.id)]));
    if(nextSignature!==choiceSignature){
      choiceSignature=nextSignature;
      for(const side of Object.values(sides)){
        const selected=side.raster.input.value,options=[option("","Choose a loaded raster"),...items.map(value=>option(String(value.id),String(value.title??value.id)))];
        if(selected&&!find(items,selected))options.push(option(selected,"Selected raster unavailable"));
        side.raster.input.replaceChildren(...options);side.raster.input.value=selected;
      }
    }
    for(const [name,side] of Object.entries(sides)){
      const candidate=find(items,side.raster.input.value);
      if(known[name]&&!sourceCurrent(known[name],items)){
        side.confirm.input.checked=false;compatible.input.checked=false;known[name]=null;invalidate();
        status.textContent="A selected raster window or source version changed. Review the elevation band, units and compatibility before calculating again.";
      }
      if(candidate&&!known[name]){try{known[name]=capture(candidate);}catch{known[name]=null;}}
      const bands=candidate?.grid.metadata?.bands??[],key=JSON.stringify(bands);
      if(side.bandKey!==key){
        side.bandKey=key;const previous=side.band.input.value;
        side.band.input.replaceChildren(...bands.map(value=>option(String(value),`Band ${value}`)));
        if(bands.some(value=>String(value)===previous))side.band.input.value=previous;
      }
      side.note.textContent=candidate?`${candidate.grid.width} × ${candidate.grid.height} loaded cells · ${candidate.grid.metadata?.imageIndex===0?"main grid":"overview grid"} · ${candidate.grid.metadata?.projection??"Unknown projection"}`:"Choose an already loaded raster window.";
    }
    const first=find(items,surface.raster.input.value),second=find(items,terrain.raster.input.value),usable=first&&second&&!sameInput(first,second)
      &&sourceCurrent(known.surface,items)&&sourceCurrent(known.terrain,items);
    source.textContent=items.length?"Choose the surface and terrain inputs. Different bands may share one loaded raster. Only resident cached cells are used.":"Load surface and terrain elevation windows before comparing heights.";
    calculate.disabled=Boolean(disposed||controller||!usable);actions();
  };
  const changed=event=>{
    if(disposed)return;invalidate();
    for(const [name,side] of Object.entries(sides)){
      if(event.target===side.raster.input){known[name]=null;side.confirm.input.checked=false;side.units.input.value="";compatible.input.checked=false;}
      if(event.target===side.band.input||event.target===side.units.input){side.confirm.input.checked=false;compatible.input.checked=false;}
    }
    root.updateSource();status.textContent="Settings changed. Review the declarations and calculate a current height comparison.";
  };
  form.addEventListener("input",changed);form.addEventListener("change",changed);
  cancel.onclick=()=>{if(disposed)return;invalidate();root.updateSource();status.textContent="Height comparison cancelled.";};
  form.onsubmit=async event=>{
    event.preventDefault();if(disposed||controller)return;
    if(!form.reportValidity()){status.textContent="Choose both elevation bands and units, and enter the height comparison basis.";return;}
    if(!surface.confirm.input.checked||!terrain.confirm.input.checked){status.textContent="Confirm the surface (DSM) and terrain (DTM) elevation roles for both selected bands.";return;}
    if(!compatible.input.checked){status.textContent="Confirm that the vertical references and source methods are compatible before calculating.";return;}
    if(!basis.input.value.trim()||basis.input.value.trim().length>500){status.textContent="Enter a height comparison basis of no more than 500 characters, including vertical references, source dates and known limits.";return;}
    invalidate();const run=++generation,request=new AbortController();controller=request;calculate.disabled=true;cancel.disabled=false;
    status.textContent="Comparing the aligned loaded elevations…";
    try{
      const items=candidates(),first=find(items,surface.raster.input.value),second=find(items,terrain.raster.input.value);
      if(!first||!second)throw failure("height_difference_source_invalid");
      if(sameInput(first,second))throw failure("height_difference_distinct_inputs_required");
      const saved={generation:run,criteria:criteria(),scope:captureScope(),surface:capture(first),terrain:capture(second)};
      if(!current(saved,items))throw failure("height_difference_source_changed");captured=saved;
      const declarations=side=>({band:Number(side.band.input.value),units:side.units.input.value,elevationConfirmed:side.confirm.input.checked});
      const left=declarations(surface),right=declarations(terrain),review={confirmed:compatible.input.checked,basis:basis.input.value.trim()};
      library??=await import("../lib/rasterHeightDifference.js");
      if(disposed||run!==generation)return;if(!current(saved))throw failure("height_difference_source_changed");
      const input=(side,values)=>({...values,grid:side.grid,pins:side.pins,isCurrent:()=>current(saved)});
      const computed=await library.computeRasterHeightDifference({surface:input(saved.surface,left),terrain:input(saved.terrain,right),review,signal:request.signal,
        onProgress:({processed,total})=>{if(current(saved))status.textContent=`Compared ${processed} of ${total} loaded elevation pairs.`;}});
      if(disposed||run!==generation)return;if(!current(saved))throw failure("height_difference_source_changed");
      result=computed;renderResult();actions();status.textContent="Height comparison ready for the loaded windows. No additional raster reads were made.";
    }catch(error){
      if(disposed||run!==generation)return;result=null;captured=null;output.replaceChildren();actions();status.textContent=errorMessage(error);
    }finally{if(!disposed&&run===generation){controller=null;cancel.disabled=true;root.updateSource();}}
  };
  function renderResult(){
    const facts=node("dl");facts.className="gis-key-values raster-comparison-facts";
    const rows={Scope:"Aligned cached windows; whole cells","Loaded cell pairs":result.coverage.totalCells,"Valid elevation pairs":result.coverage.validPairs,
      "Excluded elevation pairs":result.coverage.excludedPairs,"Minimum difference (m)":number(result.statistics.minimumMeters),"Maximum difference (m)":number(result.statistics.maximumMeters),
      "Mean difference (m)":number(result.statistics.meanMeters),"Negative differences (cells)":result.statistics.negativeCells,"Zero differences (cells)":result.statistics.zeroCells,
      "Positive differences (cells)":result.statistics.positiveCells,"Role and compatibility authority":"User declared; unverified","Height comparison basis":result.review.basis};
    for(const [name,title] of [["surface","Surface"],["terrain","Terrain"]]){
      const input=result.inputs[name],counts=result.coverage.inputStatus[name];
      rows[`${title} band`]=input.band;rows[`${title} declared units`]=unitTitle(input.units);
      for(const [key,label] of [["nullCells","missing/null"],["noDataCells","source NoData"],["nanCells","NaN"],["missingCells","unavailable"],["invalidCells","invalid"]])rows[`${title} ${label} cells`]=counts[key];
    }
    for(const [name,value] of Object.entries(rows))facts.append(node("dt",name),node("dd",String(value)));
    const map=node("p",result.map.available?`All ${result.map.totalCells} loaded cell pairs are available as complete polygons, including excluded pairs with their input status.`
      :result.map.status==="export-limit-exceeded"?"Cell map output exceeds the supported export size. No partial map is produced; the complete summary remains available."
      :`Cell map output is unavailable above ${result.map.featureLimit??1024} loaded cell pairs. No partial map is produced; the complete summary remains available.`);
    const limits=node("ul");for(const value of result.limitations??[])limits.append(node("li",value));
    output.replaceChildren(facts,node("p","Differences are continuous metres: declared DSM minus declared DTM. Negative values are retained. The result does not identify buildings or establish true object height, datum compatibility, source accuracy or independent validation."),map,limits);
  }
  function checkedResult(){
    if(!result||!current(captured)){invalidate();root.updateSource();status.textContent="The settings, raster sources or Project context changed. Calculate again before exporting or adding height cells.";return null;}
    return result;
  }
  const download=format=>{
    if(disposed)return;const saved=checkedResult();if(!saved||typeof onDownload!=="function"||format==="geojson"&&!saved.map.available)return;
    try{
      const text=format==="json"?library.rasterHeightDifferenceJson(saved):format==="csv"?library.rasterHeightDifferenceCsv(saved):JSON.stringify(library.rasterHeightDifferenceGeoJson(saved));
      onDownload({text,filename:`raster-height-difference.${format}`,mimeType:format==="csv"?"text/csv;charset=utf-8":format==="geojson"?"application/geo+json":"application/json"});
    }catch(error){invalidate();root.updateSource();status.textContent=errorMessage(error);}
  };
  json.onclick=()=>download("json");csv.onclick=()=>download("csv");geojson.onclick=()=>download("geojson");
  add.onclick=async()=>{
    if(disposed||added)return;const saved=checkedResult();if(!saved||!saved.map.available||!saved.map.totalCells||typeof onAdd!=="function")return;
    const run=generation;added=true;actions();
    try{await onAdd(JSON.parse(JSON.stringify(library.rasterHeightDifferenceGeoJson(saved))));}
    catch{if(!disposed&&run===generation&&current(captured)){added=false;actions();status.textContent="The height cells could not be added. Review the map and try Add again.";}}
  };
  const accountChanged=()=>{if(disposed)return;invalidate();surface.confirm.input.checked=terrain.confirm.input.checked=compatible.input.checked=false;root.updateSource();status.textContent="Account context changed. Review the current sources and declarations before calculating again.";};
  const events=root.ownerDocument.defaultView;events?.addEventListener("opengeo:account-navigation",accountChanged);
  root.dispose=()=>{if(disposed)return;disposed=true;events?.removeEventListener("opengeo:account-navigation",accountChanged);invalidate();known.surface=known.terrain=null;for(const {input} of fields)input.disabled=true;calculate.disabled=true;};
  root.append(source,form,status,output,json,csv,geojson,add,node("p","Review source terms before sharing derived outputs. Referenced, cached and derived data retain their recorded custody. This comparison makes no provider request or account write."));
  root.updateSource();return root;
}
function sourceFields(name,role){
  const group=node("fieldset"),raster=select(`${name} raster (${role})`),band=select(`${name} elevation band`),units=select(`${name} elevation units`),
    confirm=checkbox(`The ${name.toLowerCase()} band represents ${name.toLowerCase()} elevation (${role})`),note=node("p");
  units.input.append(option("","Choose units"),option("metres","Metres"),option("international-feet","International feet"),option("us-survey-feet","US survey feet"));
  group.append(node("legend",`${name} input (${role})`),raster.label,note,band.label,units.label,confirm.label);
  return {group,raster,band,units,confirm,note,bandKey:null};
}
function gridKey(grid){return signature({width:grid.width,height:grid.height,metadata:grid.metadata});}
function signature(value){return JSON.stringify(value,(_key,item)=>item&&typeof item==="object"&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);}
function failure(code){return Object.assign(Error(code),{code});}
function errorMessage(error){
  if(error?.name==="AbortError")return "Height comparison cancelled.";
  const code=error?.code??error?.message??"";
  if(code.includes("changed")||code.includes("stale"))return "The raster sources, pins or context changed. Review both inputs and calculate again.";
  if(code.includes("distinct"))return "Choose different surface and terrain inputs or different elevation bands in the same loaded raster.";
  if(code.includes("align")||code.includes("area_grid"))return "The loaded raster area grids are not aligned or supported. Use matching grid windows; no resampling or partial comparison is performed.";
  if(code.includes("units"))return "Choose the elevation units for both bands. Units are never inferred.";
  if(code.includes("review"))return "Confirm compatible vertical references and source methods, and enter a height comparison basis of no more than 500 characters.";
  if(code.includes("elevation_confirmation"))return "Confirm the surface (DSM) and terrain (DTM) elevation roles for both selected bands.";
  if(code.includes("limit"))return "The comparison exceeded its supported size, time or export limit. No partial result was accepted. Use smaller loaded windows.";
  return "Height comparison unavailable. Review the loaded elevation grids, selected bands, source pins and declarations.";
}
function node(tag,value=""){const element=document.createElement(tag);element.textContent=value;return element;}
function button(title){const element=node("button",title);element.type="button";element.className="gis-button";return element;}
function option(value,title){const element=node("option",title);element.value=value;return element;}
function select(title){const label=node("label",title),input=node("select");input.required=true;input.setAttribute("aria-label",title);label.append(input);return {label,input};}
function textarea(title){const label=node("label",title),input=node("textarea");input.setAttribute("aria-label",title);label.append(input);return {label,input};}
function checkbox(title){const label=node("label"),input=node("input");input.type="checkbox";input.setAttribute("aria-label",title);label.append(input,document.createTextNode(" "+title));return {label,input};}
function number(value){return typeof value==="number"&&Number.isFinite(value)?value.toLocaleString("en-US",{maximumFractionDigits:6}):"Not available";}
function unitTitle(value){return ({metres:"Metres","international-feet":"International feet","us-survey-feet":"US survey feet"})[value]??"Not declared";}
