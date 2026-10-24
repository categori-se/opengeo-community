/** Summarize explicit class groups in a resident raster. Numerical code loads
 * only on deliberate submit; this component has no transport or record writes. */
export function RasterPatches({getInput=()=>null,onDownload,onAdd}={}) {
  const root=node("details");root.className="gis-raster-patches";
  root.append(node("summary","Summarize class patches"),node("p","Describe connected patches of one explicitly mapped group in the selected loaded raster. These are grid-scale summaries of cached whole cells, without resampling or additional data acquisition."));
  const source=node("p"),form=node("form"),band=select("Patch categorical band"),confirm=checkbox("This band contains patch class codes"),
    classification=input("Patch classification (optional)"),start=input("Patch source period start (optional)","date"),end=input("Patch source period end (optional)","date"),
    crosswalk=textarea("Patch crosswalk (code = group per line)"),group=input("Patch group"),connectivity=select("Patch connectivity"),basis=textarea("Patch interpretation basis");
  classification.input.maxLength=200;crosswalk.input.maxLength=8192;crosswalk.input.required=true;group.input.required=true;group.input.maxLength=160;
  basis.input.required=true;basis.input.maxLength=500;basis.input.rows=3;
  connectivity.input.append(option("4","Edge-only (4)"),option("8","Edge-or-corner (8)"));
  const calculate=button("Summarize patches"),cancel=button("Cancel patch summary");calculate.type="submit";cancel.disabled=true;
  form.append(band.label,confirm.label,classification.label,start.label,end.label,crosswalk.label,group.label,connectivity.label,basis.label,calculate,cancel);
  const status=node("p");status.setAttribute("role","status");
  const output=node("section");output.className="raster-patches-results";
  const json=button("Download patch methods JSON"),csv=button("Download patch table CSV"),geojson=button("Download patch cells GeoJSON"),add=button("Add patch cells to map");
  const fields=[band,confirm,classification,start,end,crosswalk,group,connectivity,basis];
  let disposed=false,generation=0,controller=null,library=null,result=null,captured=null,known=null,bandKey=null,added=false;
  const criteria=()=>JSON.stringify(fields.map(({input})=>input.type==="checkbox"?input.checked:input.value));
  const candidate=()=>{try{return getInput?.()??null;}catch{return null;}};
  const sourceCurrent=(saved,next)=>{
    try {
      return Boolean(saved&&next&&saved.id===String(next.id)&&saved.grid.active()&&next.grid.active()
        &&saved.isCurrent?.()!==false&&next.isCurrent?.()!==false&&saved.pinsKey===signature(saved.pins)
        &&saved.pinsKey===signature(next.pins??null)&&saved.gridKey===gridKey(saved.grid)&&saved.gridKey===gridKey(next.grid));
    }catch{return false;}
  };
  const current=(saved,next=candidate())=>Boolean(saved&&!disposed&&saved.generation===generation&&saved.criteria===criteria()&&sourceCurrent(saved.source,next));
  const actions=()=>{
    const ready=Boolean(result&&current(captured));
    json.disabled=csv.disabled=!ready||typeof onDownload!=="function";
    geojson.disabled=!ready||!result.map.available||typeof onDownload!=="function";
    add.disabled=!ready||!result.map.available||result.map.targetCells===0||typeof onAdd!=="function"||added;
  };
  function invalidate() {
    generation++;controller?.abort();controller=null;result=null;captured=null;added=false;
    output.replaceChildren();cancel.disabled=true;calculate.disabled=disposed;actions();
  }
  function capture(next) {
    const pins=structuredClone(next.pins??null);
    return {id:String(next.id),grid:next.grid,pins,pinsKey:signature(pins),gridKey:gridKey(next.grid),isCurrent:next.isCurrent};
  }
  root.updateSource=()=>{
    if(disposed)return;const next=candidate();
    if(captured&&!current(captured,next)) {
      invalidate();status.textContent="The patch settings or selected raster changed. Review the source and summarize again.";
    }
    if(known&&!sourceCurrent(known,next)) {
      invalidate();known=null;confirm.input.checked=false;
      status.textContent="The selected raster window or source version changed. Review the categorical band and crosswalk before summarizing again.";
    }
    if(next&&!known)known=capture(next);
    const bands=next?.grid?.metadata?.bands??[],key=JSON.stringify(bands);
    if(key!==bandKey) {
      bandKey=key;const previous=band.input.value;
      band.input.replaceChildren(...bands.map(value=>option(String(value),`Band ${value}`)));
      if(bands.some(value=>String(value)===previous))band.input.value=previous;
    }
    source.textContent=next?`${next.title??"Selected raster"} · ${next.grid.width} × ${next.grid.height} loaded cells · ${next.grid.metadata?.imageIndex===0?"main grid":"overview grid"} · ${next.grid.metadata?.projection??"Unknown projection"}`:"Select and load a raster window before summarizing its class patches.";
    calculate.disabled=Boolean(disposed||controller||!sourceCurrent(known,next));actions();
  };
  const changed=()=>{if(disposed)return;invalidate();root.updateSource();status.textContent="Settings changed. Summarize patches to create a current result.";};
  form.addEventListener("input",changed);form.addEventListener("change",changed);
  cancel.onclick=()=>{if(disposed)return;invalidate();root.updateSource();status.textContent="Patch summary cancelled.";};
  form.onsubmit=async event=>{
    event.preventDefault();if(disposed||!form.reportValidity())return;
    if(!confirm.input.checked){status.textContent="Confirm that the selected band contains categorical class codes.";return;}
    invalidate();const run=++generation,request=new AbortController();controller=request;calculate.disabled=true;cancel.disabled=false;
    status.textContent="Summarizing connected groups in the loaded cells…";
    try {
      const next=candidate();if(!next)throw failure("patches_source_changed");
      if(!basis.input.value.trim()||basis.input.value.trim().length>500)throw failure("patches_basis_invalid");
      if(!group.input.value.trim()||group.input.value.trim().normalize("NFC").length>160)throw failure("patches_group_invalid");
      const saved={generation:run,criteria:criteria(),source:capture(next)};
      if(!current(saved,next))throw failure("patches_source_changed");captured=saved;
      const declared={band:Number(band.input.value),categoricalConfirmed:confirm.input.checked,classification:classification.input.value.trim()||null,
        periodStart:start.input.value||null,periodEnd:end.input.value||null,crosswalk:parseCrosswalk(crosswalk.input.value)},
        parameters={group:group.input.value.trim(),connectivity:Number(connectivity.input.value),basis:basis.input.value.trim()};
      library??=await import("../lib/rasterPatches.js");
      if(disposed||run!==generation)return;if(!current(saved))throw failure("patches_source_changed");
      const computed=await library.computeRasterPatches({input:{...declared,grid:saved.source.grid,pins:saved.source.pins,isCurrent:()=>current(saved)},
        ...parameters,signal:request.signal,onProgress:({processed,total})=>{if(!disposed&&run===generation)status.textContent=`Processed ${processed} of ${total} loaded cells.`;}});
      if(disposed||run!==generation)return;if(!current(saved))throw failure("patches_source_changed");
      result=computed;renderResult();actions();status.textContent="Patch summary ready for the loaded window. No additional raster reads were made.";
    }catch(error) {
      if(disposed||run!==generation)return;
      result=null;captured=null;output.replaceChildren();actions();status.textContent=errorMessage(error);
    }finally {
      if(!disposed&&run===generation){controller=null;cancel.disabled=true;root.updateSource();}
    }
  };
  function renderResult() {
    const facts=node("dl");facts.className="gis-key-values raster-comparison-facts";
    const coverage=result.coverage,summary=result.summary;
    const rows={Scope:"Loaded raster window; whole cells",Grid:`${result.scope.width} × ${result.scope.height} cells`,
      "Declared group":result.criteria.group,Connectivity:result.criteria.connectivity===4?"Edge-only (4)":"Edge-or-corner (8)","Interpretation basis":result.criteria.basis,
      "Source classification":result.input.interpretation.classification??"Not declared","Source period":period(result.input.sourcePeriod),"Period authority":result.input.periodAuthority,
      "Loaded cells":coverage.totalCells,"Loaded area (m²)":number(coverage.totalAreaSquareMeters),
      "Mapped cells":coverage.mappedCells,"Mapped area (m²)":number(coverage.mappedAreaSquareMeters),
      "Target group cells":summary.targetCells,"Target group area (m²)":number(summary.targetAreaSquareMeters),
      "Other mapped group cells":coverage.mappedOtherCells,"Other mapped group area (m²)":number(coverage.mappedOtherAreaSquareMeters),
      "Patch count":summary.patchCount,"Largest patch area (m²)":number(summary.largestPatchAreaSquareMeters),"Mean patch area (m²)":number(summary.meanPatchAreaSquareMeters),
      "Largest patch share of target (%)":number(summary.largestPatchShareOfTarget===null?null:summary.largestPatchShareOfTarget*100),
      "Patches per 100 ha of mapped area":number(summary.patchesPer100HectaresOfMappedArea),
      "Observed other-group edge (m)":number(summary.observedOtherGroupEdgeMeters),"Missing-data edge (m)":number(summary.missingEdgeMeters),"Window edge (m)":number(summary.windowEdgeMeters)};
    for(const [title,key] of [["Source NoData","noData"],["Noncategorical","unclassified"],["Unmapped class","unmapped"]]) {
      rows[`${title} cells`]=coverage[`${key}Cells`];rows[`${title} area (m²)`]=number(coverage[`${key}AreaSquareMeters`]);
    }
    for(const [name,value] of Object.entries(rows))facts.append(node("dt",name),node("dd",String(value)));
    const wrap=node("div");wrap.className="raster-comparison-table-scroll";wrap.tabIndex=0;wrap.setAttribute("role","region");wrap.setAttribute("aria-label","Class patch table");
    const table=node("table"),head=node("thead"),headers=node("tr"),body=node("tbody");
    for(const title of ["Patch","Cells","Area (m²)","Observed other-group edge (m)","Missing-data edge (m)","Window edge (m)","Touches window","Touches missing data"])headers.append(node("th",title));
    head.append(headers);
    for(const patch of result.patches.slice(0,200)) {
      const row=node("tr");
      for(const value of [patch.id,patch.cells,number(patch.areaSquareMeters),number(patch.observedOtherGroupEdgeMeters),number(patch.missingEdgeMeters),number(patch.windowEdgeMeters),patch.touchesWindowBoundary?"Yes":"No",patch.touchesMissingData?"Yes":"No"])
        row.append(node("td",String(value)));
      body.append(row);
    }
    table.append(node("caption","Grid-scale patches of the declared group"),head,body);wrap.append(table);
    const shown=node("p",`Showing ${Math.min(200,result.patches.length)} of ${result.patches.length} patches. JSON and CSV retain all patch rows.`);
    const map=node("p",result.map.available?(result.map.targetCells===0?"No target group cells are available to add to the map.":`${result.map.targetCells} target group cells are available as complete cell polygons with patch identifiers.`)
      :result.map.status==="export-limit-exceeded"?"Patch cell geometry exceeds the supported export size. No partial map is produced; the full patch report remains available."
      :`Map output is unavailable because more than ${result.map.featureLimit} target cells exceed the feature limit. No partial map is produced; the full patch report remains available.`);
    const limits=node("ul");for(const value of result.limitations??[])limits.append(node("li",value));
    output.replaceChildren(facts,wrap,shown,map,limits);
  }
  function checkedResult() {
    if(!result||!current(captured)) {
      invalidate();root.updateSource();status.textContent="The patch settings or selected raster changed. Summarize again before exporting or adding cells.";return null;
    }
    return result;
  }
  const download=format=>{
    if(disposed)return;const saved=checkedResult();if(!saved||typeof onDownload!=="function")return;
    try {
      if(format==="geojson"&&!saved.map.available)return;
      const text=format==="json"?library.rasterPatchesJson(saved):format==="csv"?library.rasterPatchesCsv(saved):JSON.stringify(library.rasterPatchesGeoJson(saved));
      onDownload({text,filename:`raster-patches.${format}`,mimeType:format==="csv"?"text/csv;charset=utf-8":format==="geojson"?"application/geo+json":"application/json"});
    }catch(error){invalidate();root.updateSource();status.textContent=errorMessage(error);}
  };
  json.onclick=()=>download("json");csv.onclick=()=>download("csv");geojson.onclick=()=>download("geojson");
  add.onclick=()=>{
    if(disposed||added)return;const saved=checkedResult();if(!saved||!saved.map.available||saved.map.targetCells===0||typeof onAdd!=="function")return;
    try {const collection=library.rasterPatchesGeoJson(saved);onAdd(collection);added=true;actions();}
    catch(error){invalidate();root.updateSource();status.textContent=errorMessage(error);}
  };
  root.dispose=()=>{disposed=true;invalidate();known=null;calculate.disabled=true;};
  root.append(source,form,status,output,json,csv,geojson,add,node("p","Connectivity joins cells through edges (4) or edges and corners (8). Areas and shared cell edges use Earth's mean sphere. Observed other-group edges stay separate from unknown missing-data and window boundaries; connectivity beyond the loaded window is unknown. These descriptive patches do not verify forest, habitat condition or temporal change. Review source terms before sharing derived outputs."));
  root.updateSource();return root;
}
function parseCrosswalk(text) {
  const result=Object.create(null);let count=0;
  for(const line of text.split(/\r?\n/)) {
    if(!line.trim())continue;
    const match=/^\s*(-?(?:0|[1-9]\d*))\s*=\s*(.+?)\s*$/.exec(line),code=match?Number(match[1]):NaN;
    if(!match||!Number.isSafeInteger(code)||Object.hasOwn(result,String(code))||match[2].length>160||++count>256)throw failure("patches_crosswalk_invalid");
    result[String(code)]=match[2];
  }
  if(!count)throw failure("patches_crosswalk_invalid");return result;
}
function gridKey(grid){return signature({width:grid.width,height:grid.height,metadata:grid.metadata});}
function signature(value){return JSON.stringify(value,(_key,item)=>item&&typeof item==="object"&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);}
function failure(code){return Object.assign(Error(code),{code});}
function errorMessage(error) {
  if(error.name==="AbortError")return "Patch summary cancelled.";
  const code=error.code??error.message??"";
  if(code.includes("crosswalk"))return "Enter one unique integer code = group per line, with at most 256 mappings. Each group must be explicitly declared.";
  if(code.includes("basis"))return "Enter a patch interpretation basis of no more than 500 characters.";
  if(code.includes("group"))return "Enter a target group exactly as declared in the crosswalk, using no more than 160 characters.";
  if(code.includes("connectivity"))return "Choose edge-only (4) or edge-or-corner (8) connectivity.";
  if(code.includes("period"))return "Enter a complete, chronological source date pair, or leave both source dates empty.";
  if(code.includes("changed")||code.includes("stale"))return "The patch settings or selected raster changed. Review the source and summarize again.";
  if(code.includes("limit"))return "The patch summary exceeded its supported size, time or export limit. No partial report was accepted. Use a smaller loaded window.";
  return "Patch summary unavailable. Review the loaded area grid, categorical band, explicit crosswalk and group.";
}
function node(tag,value=""){const element=document.createElement(tag);element.textContent=value;return element;}
function button(title){const element=node("button",title);element.type="button";element.className="gis-button";return element;}
function option(value,title){const element=node("option",title);element.value=value;return element;}
function input(title,type="text"){const label=node("label",title),element=node("input");element.type=type;element.setAttribute("aria-label",title);label.append(element);return {label,input:element};}
function select(title){const label=node("label",title),element=node("select");element.required=true;element.setAttribute("aria-label",title);label.append(element);return {label,input:element};}
function textarea(title){const label=node("label",title),element=node("textarea");element.rows=4;element.setAttribute("aria-label",title);label.append(element);return {label,input:element};}
function checkbox(title){const label=node("label"),element=node("input");element.type="checkbox";element.setAttribute("aria-label",title);label.append(element,document.createTextNode(" "+title));return {label,input:element};}
function number(value){return typeof value==="number"?value.toLocaleString("en-US",{maximumFractionDigits:2}):"Not applicable";}
function period(value){return value?.start&&value?.end?`${value.start} to ${value.end}`:"Not recorded";}
