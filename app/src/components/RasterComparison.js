/** Compare two resident categorical grids. Computation loads only on deliberate
 * submit; this panel has no transport, provider or canonical-record writes. */
export function RasterComparison({getCandidates=()=>[],initialBeforeId=null,onDownload,onAdd}={}) {
  const root=node("details");root.className="gis-raster-comparison";
  root.append(node("summary","Compare categorical rasters"),node("p","Compare aligned, already loaded raster windows using an explicit class crosswalk for each source. No resampling or additional data acquisition occurs. Matching class codes do not imply matching meanings."));
  const source=node("p"),form=node("form"),before=sourceFields("Before"),after=sourceFields("After");
  before.raster.input.value=initialBeforeId===null?"":String(initialBeforeId);
  const basis=textarea("Comparability basis"),comparable=checkbox("Source methods and classifications are comparable");
  basis.input.required=true;basis.input.maxLength=500;basis.input.rows=3;
  const reference=select("Reference raster (optional)"),referenceBasis=textarea("Reference evaluation basis");
  reference.input.required=false;reference.input.append(option("","Do not evaluate agreement"),option("before","Before raster"),option("after","After raster"));
  referenceBasis.input.maxLength=500;referenceBasis.input.rows=3;
  const calculate=button("Compare loaded cells"),cancel=button("Cancel comparison");calculate.type="submit";cancel.disabled=true;
  form.append(before.group,after.group,basis.label,comparable.label,node("p","Describe why these sources may be compared, or the known uncertainty. The methods confirmation is optional: raw class disagreements remain available when change is not established."),
    reference.label,referenceBasis.label,node("p","Optionally choose a reference to describe class agreement on paired mapped cached cells, with equal weight per cell. Independent reference validation, classification accuracy and uncertainty remain unknown; agreement is not verified accuracy."),calculate,cancel);
  const status=node("p");status.setAttribute("role","status");
  const output=node("section");output.className="raster-comparison-results";
  const json=button("Download comparison JSON"),csv=button("Download comparison CSV"),agreementCsv=button("Download agreement CSV"),geojson=button("Download transition GeoJSON"),add=button("Add transitions to map");
  let disposed=false,generation=0,controller=null,library=null,result=null,captured=null,added=false,choices=[],choiceSignature=null;
  const known={before:null,after:null};
  const fields=[before.raster,before.band,before.confirm,before.classification,before.start,before.end,before.crosswalk,
    after.raster,after.band,after.confirm,after.classification,after.start,after.end,after.crosswalk,basis,comparable,reference,referenceBasis];
  const criteria=()=>JSON.stringify(fields.map(({input})=>input.type==="checkbox"?input.checked:input.value));
  const candidates=()=>{try{return (getCandidates?.()??[]).filter(value=>value?.id!==undefined&&value?.id!==null&&value.grid);}catch{return [];}};
  const find=(items,id)=>items.find(value=>String(value.id)===id);
  const sourceCurrent=(saved,items)=>{
    try {
      const candidate=find(items,saved.id);
      return Boolean(candidate&&saved.grid.active()&&candidate.grid.active()&&saved.isCurrent?.()!==false&&candidate.isCurrent?.()!==false
        &&saved.pinsKey===signature(saved.pins)&&saved.pinsKey===signature(candidate.pins??null)
        &&saved.gridKey===gridKey(saved.grid)&&saved.gridKey===gridKey(candidate.grid));
    }catch{return false;}
  };
  const current=(saved,items=candidates())=>Boolean(saved&&!disposed&&saved.generation===generation&&saved.criteria===criteria()
    &&sourceCurrent(saved.before,items)&&sourceCurrent(saved.after,items));
  const actions=()=>{
    const ready=Boolean(result&&current(captured));
    json.disabled=csv.disabled=!ready||typeof onDownload!=="function";
    agreementCsv.disabled=!ready||!result?.referenceEvaluation||typeof onDownload!=="function";
    geojson.disabled=!ready||!result.map.available||typeof onDownload!=="function";
    add.disabled=!ready||!result.map.available||result.map.changedCells===0||typeof onAdd!=="function"||added;
  };
  function invalidate() {
    generation++;controller?.abort();controller=null;result=null;captured=null;added=false;
    output.replaceChildren();cancel.disabled=true;calculate.disabled=disposed;actions();
  }
  function capture(candidate) {
    const pins=structuredClone(candidate.pins??null);
    return {id:String(candidate.id),grid:candidate.grid,pins,pinsKey:signature(pins),gridKey:gridKey(candidate.grid),isCurrent:candidate.isCurrent};
  }
  root.updateSource=()=>{
    if(disposed)return;
    referenceBasis.input.required=reference.input.value!=="";
    choices=candidates();
    if(captured&&!current(captured,choices)) {
      invalidate();status.textContent="The comparison settings or either raster changed. Review both sources and compare again.";
    }
    const nextSignature=JSON.stringify(choices.map(value=>[String(value.id),String(value.title??value.id)]));
    if(nextSignature!==choiceSignature) {
      choiceSignature=nextSignature;
      for(const side of [before,after]) {
        const selected=side.raster.input.value;
        const options=[option("","Choose a loaded raster"),...choices.map(value=>option(String(value.id),String(value.title??value.id)))];
        if(selected&&!find(choices,selected))options.push(option(selected,"Selected raster unavailable"));
        side.raster.input.replaceChildren(...options);side.raster.input.value=selected;
      }
    }
    for(const [name,side] of [["before",before],["after",after]]) {
      const candidate=find(choices,side.raster.input.value);
      if(known[name]&&!sourceCurrent(known[name],choices)) {
        side.confirm.input.checked=false;known[name]=null;
        invalidate();status.textContent="A selected raster window or source version changed. Review its categorical band and crosswalk before comparing again.";
      }
      if(candidate&&!known[name])known[name]=capture(candidate);
      const bands=candidate?.grid.metadata?.bands??[],key=JSON.stringify(bands);
      if(side.bandKey!==key) {
        side.bandKey=key;const previous=side.band.input.value;
        side.band.input.replaceChildren(...bands.map(value=>option(String(value),`Band ${value}`)));
        if(bands.some(value=>String(value)===previous))side.band.input.value=previous;
      }
      side.note.textContent=candidate?`${candidate.grid.width} × ${candidate.grid.height} loaded cells · ${candidate.grid.metadata?.imageIndex===0?"main grid":"overview grid"} · ${candidate.grid.metadata?.projection??"Unknown projection"}`:"Choose an already loaded raster window.";
    }
    const first=find(choices,before.raster.input.value),second=find(choices,after.raster.input.value);
    const usable=first&&second&&before.raster.input.value!==after.raster.input.value
      &&sourceCurrent(known.before,choices)&&sourceCurrent(known.after,choices);
    source.textContent=choices.length<2?"Load two raster windows before comparing their categorical cells.":"Choose different before and after rasters. Only resident cached cells are used.";
    calculate.disabled=Boolean(disposed||controller||!usable);
    actions();
  };
  const changed=event=>{
    if(disposed)return;
    invalidate();
    for(const [name,side] of [["before",before],["after",after]])if(event.target===side.raster.input) {
      known[name]=null;side.confirm.input.checked=false;
    }
    root.updateSource();status.textContent="Settings changed. Compare loaded cells to create a current result.";
  };
  form.addEventListener("input",changed);form.addEventListener("change",changed);
  cancel.onclick=()=>{if(disposed)return;invalidate();root.updateSource();status.textContent="Comparison cancelled.";};
  form.onsubmit=async event=>{
    event.preventDefault();referenceBasis.input.required=reference.input.value!=="";if(disposed||!form.reportValidity())return;
    if(!before.confirm.input.checked||!after.confirm.input.checked) {status.textContent="Confirm that both selected bands contain categorical class codes.";return;}
    invalidate();
    const run=++generation,request=new AbortController();controller=request;calculate.disabled=true;cancel.disabled=false;
    status.textContent="Comparing the aligned loaded cells…";
    try {
      const items=candidates(),first=find(items,before.raster.input.value),second=find(items,after.raster.input.value);
      if(!first||!second||String(first.id)===String(second.id))throw failure("comparison_sources_distinct");
      if(!basis.input.value.trim()||basis.input.value.trim().length>500)throw failure("comparison_basis_invalid");
      let evaluation=null;
      if(reference.input.value!=="") {
        if(!["before","after"].includes(reference.input.value)||!referenceBasis.input.value.trim()||referenceBasis.input.value.trim().length>500)
          throw failure("comparison_reference_evaluation_invalid");
        evaluation={reference:reference.input.value,basis:referenceBasis.input.value.trim()};
      }
      const saved={generation:run,criteria:criteria(),before:capture(first),after:capture(second)};
      if(!current(saved,items))throw failure("comparison_source_changed");
      captured=saved;
      const declarations=side=>({band:Number(side.band.input.value),categoricalConfirmed:side.confirm.input.checked,
        classification:side.classification.input.value.trim()||null,periodStart:side.start.input.value||null,periodEnd:side.end.input.value||null,
        crosswalk:parseCrosswalk(side.crosswalk.input.value)});
      const left=declarations(before),right=declarations(after),comparability={confirmed:comparable.input.checked,basis:basis.input.value.trim()};
      library??=await import("../lib/rasterComparison.js");
      if(disposed||run!==generation)return;
      if(!current(saved))throw failure("comparison_source_changed");
      const input=(side,values)=>({...values,grid:side.grid,pins:side.pins,isCurrent:()=>current(saved)});
      const computed=await library.computeRasterComparison({before:input(saved.before,left),after:input(saved.after,right),comparability,referenceEvaluation:evaluation,signal:request.signal,
        onProgress:({processed,total})=>{if(!disposed&&run===generation)status.textContent=`Compared ${processed} of ${total} loaded cell pairs.`;}});
      if(disposed||run!==generation)return;
      if(!current(saved))throw failure("comparison_source_changed");
      result=computed;renderResult();actions();
      status.textContent="Comparison ready for the aligned loaded windows. No additional raster reads were made.";
    }catch(error) {
      if(disposed||run!==generation)return;
      result=null;captured=null;output.replaceChildren();actions();status.textContent=errorMessage(error);
    }finally {
      if(!disposed&&run===generation){controller=null;cancel.disabled=true;root.updateSource();}
    }
  };
  function renderResult() {
    const facts=node("dl");facts.className="gis-key-values raster-comparison-facts";
    const coverage=result.coverage,comparison=result.comparability;
    const rows={Scope:"Aligned cached grid windows; whole cells",Grid:`${result.scope.width} × ${result.scope.height} cells`,
      "Loaded cell pairs":coverage.totalCells,"Loaded area (m²)":number(coverage.totalAreaSquareMeters),
      "Paired mapped cells":coverage.pairedMappedCells,"Paired mapped area (m²)":number(coverage.pairedMappedAreaSquareMeters),
      "Excluded cells":coverage.excludedCells,"Excluded area (m²)":number(coverage.excludedAreaSquareMeters),
      "Different mapped groups (cells)":coverage.changedCells,"Different mapped groups (m²)":number(coverage.changedAreaSquareMeters),
      "Same mapped group (cells)":coverage.unchangedCells,"Same mapped group (m²)":number(coverage.unchangedAreaSquareMeters),
      Comparability:({"declared-comparable":"Declared comparable","not-established":"Change not established","known-incompatible":"Known incompatible"})[comparison.status]??comparison.status,
      "Period order":comparison.periodOrder,"Algorithm compatibility":comparison.algorithmCompatibility,"Comparability basis":comparison.basis};
    for(const [name,key] of [["Before","before"],["After","after"]]) {
      const input=result.inputs[key],counts=coverage.inputStatus[key];
      rows[`${name} classification`]=input.interpretation.classification??"Not declared";
      rows[`${name} source period`]=period(input.sourcePeriod);
      rows[`${name} period authority`]=input.periodAuthority;
      for(const [title,prefix] of [["source NoData","noData"],["noncategorical","unclassified"],["unmapped class","unmapped"]]) {
        rows[`${name} ${title} cells`]=counts[`${prefix}Cells`];
        rows[`${name} ${title} area (m²)`]=number(counts[`${prefix}AreaSquareMeters`]);
      }
    }
    for(const [name,value] of Object.entries(rows))facts.append(node("dt",name),node("dd",String(value)));
    const interpretation=node("p",comparison.changeInterpretation);
    const wrap=node("div");wrap.className="raster-comparison-table-scroll";wrap.tabIndex=0;wrap.setAttribute("role","region");wrap.setAttribute("aria-label","Categorical transition table");
    const table=node("table"),head=node("thead"),headers=node("tr"),body=node("tbody");
    for(const title of ["Before code","Before meaning","Before group","After code","After meaning","After group","Cells","Area (m²)","Group disagreement"])headers.append(node("th",title));
    head.append(headers);
    for(const row of result.transitions.slice(0,200)) {
      const tr=node("tr");
      for(const value of [row.beforeCode,row.beforeMeaning??"Not recorded",row.beforeGroup??"Unmapped",row.afterCode,row.afterMeaning??"Not recorded",row.afterGroup??"Unmapped",row.cells,number(row.areaSquareMeters),row.changed===null?"Unknown (unmapped)":row.changed?"Different":"Same"])
        tr.append(node("td",String(value)));
      body.append(tr);
    }
    table.append(node("caption","Raw class transitions in the aligned loaded cells"),head,body);wrap.append(table);
    const shown=node("p",`Showing ${Math.min(200,result.transitions.length)} of ${result.transitions.length} raw class transitions. JSON and CSV retain the full table.`);
    const map=node("p",result.map.available?(result.map.changedCells===0?"No mapped group disagreements are available to add to the map.":`${result.map.changedCells} mapped group disagreements are available as complete cell polygons.`)
      :result.map.status==="export-limit-exceeded"?"Map output exceeds the supported export size. No partial map is produced; the complete transition table remains available."
      :`Map output is unavailable because more than ${result.map.featureLimit} changed cells exceed the feature limit. No partial map is produced; the complete transition table remains available.`);
    const limits=node("ul");for(const value of result.limitations??[])limits.append(node("li",value));
    output.replaceChildren(facts,interpretation,wrap,shown,map,limits);
    if(result.referenceEvaluation)output.append(renderAgreement(result.referenceEvaluation));
  }
  function renderAgreement(evaluation) {
    const section=node("section");section.className="raster-reference-agreement";
    section.append(node("h4","Categorical reference agreement"),node("p","Descriptive agreement uses equal weight for each paired mapped cached cell. Independent reference validation, classification accuracy and uncertainty remain unknown. This is not verified accuracy."));
    const facts=node("dl");facts.className="gis-key-values raster-comparison-facts";
    const overall=evaluation.overall;
    for(const [name,value] of Object.entries({"Reference raster":evaluation.roles.reference==="before"?"Before raster":"After raster",
      "Candidate raster":evaluation.roles.candidate==="before"?"Before raster":"After raster","Reference evaluation basis":evaluation.basis,
      "Paired mapped cells":overall.pairedCells,"Matched cells":overall.matchedCells,"Disagreed cells":overall.disagreedCells,
      "Overall cell agreement":fraction(overall.agreementFraction)}))facts.append(node("dt",name),node("dd",String(value)));
    const wrap=node("div");wrap.className="raster-comparison-table-scroll";wrap.tabIndex=0;wrap.setAttribute("role","region");wrap.setAttribute("aria-label","Class agreement table");
    const table=node("table");table.setAttribute("aria-label","Class agreement by group");
    const head=node("thead"),headers=node("tr"),body=node("tbody");
    for(const title of ["Group","Reference cells","Candidate cells","Matched cells","Precision","Recall","F1","IoU","Count difference (candidate − reference)"])headers.append(node("th",title));
    head.append(headers);
    for(const row of evaluation.classes.slice(0,200)) {
      const tr=node("tr");
      for(const value of [row.group,row.referenceCells,row.candidateCells,row.matchedCells,fraction(row.precision),fraction(row.recall),fraction(row.f1),fraction(row.iou),row.countDifference])tr.append(node("td",String(value)));
      body.append(tr);
    }
    table.append(node("caption","Class agreement on paired mapped cached cells"),head,body);wrap.append(table);
    section.append(facts,wrap,node("p",`Showing ${Math.min(200,evaluation.classes.length)} of ${evaluation.classes.length} agreement classes. Comparison JSON and agreement CSV retain every class and the full sparse confusion table.`));
    return section;
  }
  function checkedResult() {
    if(!result||!current(captured)) {
      invalidate();root.updateSource();status.textContent="The comparison settings or either raster changed. Compare again before exporting or adding transitions.";return null;
    }
    return result;
  }
  const download=format=>{
    if(disposed)return;const saved=checkedResult();if(!saved||typeof onDownload!=="function")return;
    try {
      if(format==="geojson"&&!saved.map.available)return;
      if(format==="agreement"&&!saved.referenceEvaluation)return;
      const text=format==="json"?library.rasterComparisonJson(saved):format==="csv"?library.rasterComparisonCsv(saved):format==="agreement"?library.rasterAgreementCsv(saved):JSON.stringify(library.rasterComparisonGeoJson(saved));
      onDownload({text,filename:format==="agreement"?"raster-agreement.csv":`raster-comparison.${format}`,mimeType:["csv","agreement"].includes(format)?"text/csv;charset=utf-8":format==="geojson"?"application/geo+json":"application/json"});
    }catch(error){invalidate();root.updateSource();status.textContent=errorMessage(error);}
  };
  json.onclick=()=>download("json");csv.onclick=()=>download("csv");agreementCsv.onclick=()=>download("agreement");geojson.onclick=()=>download("geojson");
  add.onclick=()=>{
    if(disposed||added)return;const saved=checkedResult();if(!saved||!saved.map.available||saved.map.changedCells===0||typeof onAdd!=="function")return;
    try {const collection=library.rasterComparisonGeoJson(saved);onAdd(collection);added=true;actions();}
    catch(error){invalidate();root.updateSource();status.textContent=errorMessage(error);}
  };
  root.dispose=()=>{disposed=true;invalidate();known.before=known.after=null;calculate.disabled=true;};
  root.append(source,form,status,output,json,csv,agreementCsv,geojson,add,node("p","This compares resident aligned cached cells, without resampling. It does not establish real loss, regrowth, acquisition completeness or classification accuracy. Review source terms before sharing derived outputs."));
  // Set the initial choice after options exist; later updates preserve deliberate selections.
  root.updateSource();
  if(initialBeforeId!==null&&find(choices,String(initialBeforeId))){before.raster.input.value=String(initialBeforeId);root.updateSource();}
  return root;
}
function sourceFields(name) {
  const group=node("fieldset"),raster=select(`${name} raster`),band=select(`${name} categorical band`),confirm=checkbox(`${name} band contains categorical class codes`),
    classification=input(`${name} classification (optional)`),start=input(`${name} source period start (optional)`,"date"),end=input(`${name} source period end (optional)`,"date"),crosswalk=textarea(`${name} crosswalk (code = group per line)`),note=node("p");
  classification.input.maxLength=200;crosswalk.input.maxLength=8192;crosswalk.input.required=true;
  group.append(node("legend",`${name} source`),raster.label,note,band.label,confirm.label,classification.label,start.label,end.label,crosswalk.label);
  return {group,raster,band,confirm,classification,start,end,crosswalk,note,bandKey:null};
}
function parseCrosswalk(text) {
  const result=Object.create(null);let count=0;
  for(const line of text.split(/\r?\n/)) {
    if(!line.trim())continue;
    const match=/^\s*(-?(?:0|[1-9]\d*))\s*=\s*(.+?)\s*$/.exec(line),code=match?Number(match[1]):NaN;
    if(!match||!Number.isSafeInteger(code)||Object.hasOwn(result,String(code))||match[2].length>160||++count>256)throw failure("comparison_crosswalk_invalid");
    result[String(code)]=match[2];
  }
  if(!count)throw failure("comparison_crosswalk_invalid");
  return result;
}
function gridKey(grid){return signature({width:grid.width,height:grid.height,metadata:grid.metadata});}
function signature(value){return JSON.stringify(value,(_key,item)=>item&&typeof item==="object"&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);}
function failure(code){return Object.assign(Error(code),{code});}
function errorMessage(error) {
  if(error.name==="AbortError")return "Comparison cancelled.";
  const code=error.code??error.message??"";
  if(code.includes("reference_evaluation"))return "Choose a before or after reference and enter a reference evaluation basis of no more than 500 characters.";
  if(code.includes("crosswalk"))return "Enter one unique integer code = group per line for each source, with at most 256 mappings. Class groups require an explicit crosswalk.";
  if(code.includes("basis")||code.includes("comparability"))return "Enter a comparability basis of no more than 500 characters.";
  if(code.includes("period"))return "Enter a complete, chronological source date pair for each declaration, or leave both dates empty.";
  if(code.includes("changed")||code.includes("stale"))return "The comparison settings or either raster changed. Review both sources and compare again.";
  if(code.includes("distinct"))return "Choose two different loaded rasters.";
  if(code.includes("align")||code.includes("grid_mismatch"))return "The loaded raster grids are not aligned. Use matching grid windows; no resampling or partial comparison is performed.";
  if(code.includes("grid_metadata"))return "The loaded grids have unsupported origin, resolution or window metadata. No partial comparison was accepted.";
  if(code.includes("limit"))return "The comparison exceeded its supported size, time or export limit. No partial result was accepted. Use smaller loaded windows.";
  return "Comparison unavailable. Review the two loaded area grids, categorical bands and explicit crosswalks.";
}
function node(tag,value=""){const element=document.createElement(tag);element.textContent=value;return element;}
function button(title){const element=node("button",title);element.type="button";element.className="gis-button";return element;}
function option(value,title){const element=node("option",title);element.value=value;return element;}
function input(title,type="text"){const label=node("label",title),element=node("input");element.type=type;element.setAttribute("aria-label",title);label.append(element);return {label,input:element};}
function select(title){const control=input(title);const element=node("select");element.required=true;element.setAttribute("aria-label",title);control.input.replaceWith(element);return {label:control.label,input:element};}
function textarea(title){const label=node("label",title),element=node("textarea");element.rows=4;element.setAttribute("aria-label",title);label.append(element);return {label,input:element};}
function checkbox(title){const label=node("label"),element=node("input");element.type="checkbox";element.setAttribute("aria-label",title);label.append(element,document.createTextNode(" "+title));return {label,input:element};}
function number(value){return typeof value==="number"?value.toLocaleString("en-US",{maximumFractionDigits:2}):"Unknown";}
function fraction(value){return typeof value==="number"?`${number(value*100)}%`:"Unavailable";}
function period(value){return value?.start&&value?.end?`${value.start} to ${value.end}`:"Not recorded";}
