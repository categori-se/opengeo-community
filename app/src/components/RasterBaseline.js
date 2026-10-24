/** Inventory the selected band in the loaded window. Numerical code loads only
 * on Calculate; this component has no transport, provider or account API.
 * onDownload receives {text, filename, mimeType} for a deliberate JSON/CSV save.
 */
export function RasterBaseline({getGrid,getAois=()=>[],onDownload}={}) {
  const root=node("details");root.className="gis-raster-baseline";
  root.append(node("summary","Categorical raster inventory"),node("p","Count class codes and estimate their areas within the loaded raster window. Select a published categorical band; class meanings remain your declarations."));
  const source=node("p"),form=node("form"),band=select("Categorical band"),classification=input("Classification name (optional)"),
    start=input("Source period start (optional)","date"),end=input("Source period end (optional)","date"),meanings=textarea("Class meanings (optional; one code = meaning per line)");
  const area=select("Analysis area"),requestedStart=input("Requested baseline start (optional)","date"),requestedEnd=input("Requested baseline end (optional)","date");
  const areaNote=node("p","Choose a loaded polygon feature to intersect its area with cached cells. Up to 100 loaded polygon choices are shown. Areas outside the loaded window stay unobserved.");
  classification.input.maxLength=200;meanings.input.maxLength=8192;
  const confirm=checkbox("This band contains categorical class codes"),calculate=button("Calculate class inventory"),cancel=button("Cancel inventory");
  const publishedProfile=select("Published product interpretation"),profileConfirmed=checkbox("I checked this band against the selected product and release");
  publishedProfile.input.required=false;
  for(const [value,title] of [["","None"],["jrc-tmf-2025-main-classes","JRC TMF 2025 — Transition Map main classes"]]){const option=node("option",title);option.value=value;publishedProfile.input.append(option);}
  const profileNote=node("p","This interpretation applies to band 1. Nominal pixels are 30 m; the loaded window may be a coarser overview. History: 1982–2025. Reporting: 1990–2025. Class 50 retains the published label ‘Ongoing deforestation or degradation (2023-2025)’; this profile does not separate those processes. Selecting it does not verify the raster’s product identity, coverage, rights, forest condition or impact.");
  const updateProfile=()=>{const selected=Boolean(publishedProfile.input.value);profileConfirmed.label.hidden=profileNote.hidden=!selected;profileConfirmed.input.disabled=!selected;};
  updateProfile();
  calculate.type="submit";cancel.disabled=true;
  form.append(area.label,areaNote,band.label,confirm.label,publishedProfile.label,profileConfirmed.label,profileNote,classification.label,start.label,end.label,requestedStart.label,requestedEnd.label,meanings.label,calculate,cancel);
  const status=node("p");status.setAttribute("role","status");const output=node("section");
  const json=button("Download inventory JSON"),csv=button("Download inventory CSV");json.disabled=csv.disabled=true;
  let disposed=false,knownGrid=null,gridUsed=null,result=null,library=null,controller=null,generation=0,aoiUsed=null,choices=[],choiceSignature=null;
  const actions=()=>{json.disabled=csv.disabled=disposed||!result||!gridUsed?.active()||typeof onDownload!=="function";};
  const invalidate=()=>{generation++;controller?.abort();controller=null;result=null;gridUsed=null;aoiUsed=null;output.replaceChildren();cancel.disabled=true;calculate.disabled=disposed;actions();};
  const fingerprint=value=>value?JSON.stringify({geometry:value.geometry,source:value.source}):null;
  function updateAreas() {
    choices=(getAois?.()??[]).slice(0,100);
    const previous=area.input.value||"window",signature=JSON.stringify(choices.map(value=>[value.id,value.title]));
    if(signature!==choiceSignature){choiceSignature=signature;const all=[{id:"window",title:"Entire loaded raster window"},...choices];
      if(previous!=="window"&&!choices.some(value=>value.id===previous))all.push({id:previous,title:"Selected polygon unavailable"});
      area.input.replaceChildren(...all.map(value=>{const option=node("option",value.title);option.value=value.id;return option;}));area.input.value=previous;}
    if(aoiUsed&&!aoiUsed.isCurrent()){invalidate();status.textContent="The selected study area changed. Review it and calculate again.";}
    return previous==="window"||choices.some(value=>value.id===previous);
  }
  root.updateSource=()=>{
    if(disposed)return;
    const availableArea=updateAreas();
    const grid=getGrid?.();
    if(knownGrid&&!knownGrid.active()) {invalidate();knownGrid=null;confirm.input.checked=false;profileConfirmed.input.checked=false;status.textContent="The raster window changed. Review the categorical band before calculating again.";}
    if(!grid){source.textContent="Load and show a raster window before calculating an inventory.";calculate.disabled=true;return;}
    if(!knownGrid){knownGrid=grid;band.input.replaceChildren(...grid.metadata.bands.map(value=>{const option=node("option",`Band ${value}`);option.value=String(value);return option;}));}
    source.textContent=`${grid.width} × ${grid.height} loaded cells · ${grid.metadata.imageIndex===0&&grid.metadata.scaleX===1&&grid.metadata.scaleY===1?"main grid":"overview grid"} · ${grid.metadata.projection}`;
    calculate.disabled=grid.metadata.interpretation!=="area"||Boolean(controller)||!availableArea;
    if(grid.metadata.interpretation!=="area")status.textContent="Area inventories require area cells. Point-sampled rasters are unsupported.";
  };
  const changed=event=>{if(event.target===publishedProfile.input||event.target===band.input)profileConfirmed.input.checked=false;updateProfile();invalidate();root.updateSource();status.textContent="Settings changed. Calculate to create a current inventory.";};
  form.addEventListener("input",changed);form.addEventListener("change",changed);
  cancel.onclick=()=>{invalidate();root.updateSource();status.textContent="Inventory cancelled. The raster remains unchanged.";};
  form.onsubmit=async event=>{
    event.preventDefault();if(disposed||!form.reportValidity())return;
    if(!confirm.input.checked){status.textContent="Confirm that the selected band contains categorical class codes.";return;}
    if(publishedProfile.input.value&&Number(band.input.value)!==1){status.textContent="This published product interpretation requires band 1. Choose band 1 or clear the interpretation.";return;}
    if(publishedProfile.input.value&&!profileConfirmed.input.checked){status.textContent="Confirm that you checked this band against the selected product and release.";return;}
    invalidate();const current=++generation,request=new AbortController();controller=request;
    const grid=getGrid?.();calculate.disabled=true;cancel.disabled=false;status.textContent="Calculating class areas from the loaded cells…";
    try {
      const classMeanings=parseMeanings(meanings.input.value);
      const selected=area.input.value==="window"?null:choices.find(value=>value.id===area.input.value);
      if(area.input.value!=="window"&&!selected)throw Object.assign(Error("baseline_aoi_changed"),{code:"baseline_aoi_changed"});
      const expected=fingerprint(selected),aoi=selected?{geometry:structuredClone(selected.geometry),source:structuredClone(selected.source),
        isCurrent:()=>fingerprint((getAois?.()??[]).find(value=>value.id===selected.id))===expected}:null;
      library??=await import("../lib/rasterBaseline.js");
      if(disposed||current!==generation)return;
      const computed=await library.computeRasterBaseline({grid,band:Number(band.input.value),categoricalConfirmed:true,
        ...(publishedProfile.input.value?{publishedProfileId:publishedProfile.input.value,publishedProfileConfirmed:profileConfirmed.input.checked}:{}),
        classification:classification.input.value.trim()||null,periodStart:start.input.value||null,periodEnd:end.input.value||null,
        requestedStart:requestedStart.input.value||null,requestedEnd:requestedEnd.input.value||null,aoi,
        classMeanings,signal:request.signal,onProgress:({processed,total})=>{if(current===generation)status.textContent=`Processed ${processed} of ${total} loaded cells.`;}});
      if(disposed||current!==generation||!grid.active())return;
      result=computed;gridUsed=grid;aoiUsed=aoi;renderResult();actions();status.textContent=aoi
        ?"Inventory ready for the selected area within the loaded window. No additional raster reads were made."
        :"Inventory ready for the loaded window. No additional raster reads were made.";
    } catch(error) {
      if(disposed||current!==generation)return;
      const code=error.code??(error.message?.startsWith("baseline_period_invalid")?"baseline_period_invalid":null);
      status.textContent=({baseline_class_meanings_invalid:"Use one unique integer code = meaning per line, with at most 256 meanings.",
        baseline_published_profile_invalid:"Choose a supported published product interpretation, or select None.",
        baseline_published_profile_confirmation_required:"Confirm that you checked this band against the selected product and release.",
        baseline_published_profile_band_required:"This published product interpretation requires band 1. Choose band 1 or clear the interpretation.",
        baseline_published_profile_incompatible:"The recognized source is a different published product. Clear the interpretation or choose the matching raster.",
        baseline_period_invalid:"Enter each date pair in chronological order, or leave both dates in that pair empty.",
        baseline_source_invalid:"Show a loaded raster window with no more than 1,048,576 cells and choose one of its bands.",
        baseline_source_changed:"The raster window changed. Review it and calculate again.",baseline_area_grid_required:"Area inventories require area cells; point-sampled rasters are unsupported.",
        baseline_aoi_changed:"The selected study area changed or is unavailable. Review it before calculating again.",
        baseline_aoi_topology_invalid:"The study polygon is invalid or has overlapping parts. Review its boundaries and holes.",
        baseline_aoi_limits:"The study area exceeds the supported size or geometry limits. Choose a simpler, smaller polygon.",
        baseline_cell_geometry_unsupported:"This window has unsupported cell geometry. Area inventories currently require noncrossing cells within the map latitude limits.",
        baseline_class_limit:"More than 256 class codes were found. Choose a categorical band with fewer classes.",
        baseline_metadata_limit:"The class meanings exceed the inventory metadata limit.",baseline_compute_limit:"The calculation time limit was reached. No partial inventory was accepted; load a smaller window and try again.",
        baseline_coverage_overlap:"The cached cell boundaries could not be reconciled with this study area. Review the geometry or choose a smaller raster window."})[code]
        ??(error.name==="AbortError"?"Inventory cancelled.":code?.startsWith("baseline_aoi_")?"The study polygon is unsupported or exceeds the calculation limits. Use valid noncrossing boundaries with at most 256 positions within a six-degree span.":"Inventory unavailable. Review the selected categorical band and declarations.");
    } finally {if(current===generation){controller=null;cancel.disabled=true;root.updateSource();}}
  };
  function renderResult() {
    const facts=node("dl");facts.className="gis-key-values";
    const coverage=result.coverage,profile=result.interpretation.publishedProfile;
    for(const [name,value] of Object.entries({Scope:result.scope.aoiClipped?"Selected study area intersected with cached cells":"Loaded grid window; whole cells, without AOI clipping",Grid:result.scope.grid,
      "Loaded cells":coverage.totalCells,"Touched cells":coverage.touchedCells,"Partial cells":coverage.partialCells,
      "Observed area (m²)":number(coverage.totalAreaSquareMeters),
      ...(result.scope.aoiClipped?{"Study area (m²)":number(coverage.requestedAreaSquareMeters),"Outside loaded window (m²)":number(coverage.outsideWindowAreaSquareMeters),Coverage:coverage.aoiCoverage}:{}),
      "Classified cells":coverage.categoricalCells,
      "Source NoData cells":coverage.noDataCells,"Unclassified cells":coverage.unclassifiedCells,"Source terms":result.source.reference.license??"Not recorded",
      "Source period":result.source.product?`${result.source.product.observationPeriod.start} to ${result.source.product.observationPeriod.end}`:result.interpretation.period?`${result.interpretation.period.start} to ${result.interpretation.period.end} (declared)`:"Not recorded",
      "Period comparison":({"not-assessed":"Not assessed",matches:"Source period covers the request",partial:"Source period overlaps only part of the request",disjoint:"Source period does not cover the request"})[result.method.temporalSuitability],
      "Source snapshot":result.source.reference.verified?"Provider snapshot pinned":"Unverified"}))facts.append(node("dt",name),node("dd",String(value)));
    if(profile){
      for(const [name,value] of Object.entries({"Published product interpretation":profile.title,"Product identity":"Declared by you; unverified",
        "Published release":profile.releaseYear,"Nominal source pixels":`${profile.nominalResolutionMeters} m; loaded ${result.scope.grid} cells remain the analysis resolution`,
        "Published history period":periodLabel(profile.historyPeriod),"Published reporting period":periodLabel(profile.reportingPeriod),
        "Recent class 50 ambiguity":`${periodLabel(profile.recentAmbiguityPeriod)}: ongoing deforestation or degradation; these processes are not separated`,
        "Interpretation rights":"Unknown; selecting the product grants no rights or access"}))facts.append(node("dt",name),node("dd",String(value)));
      const evidence=node("dd");
      for(const [index,href] of profile.evidenceUrls.entries()){const link=node("a",`Published evidence ${index+1}`);link.href=href;link.target="_blank";link.rel="noopener noreferrer";evidence.append(link,document.createTextNode(" "));}
      facts.append(node("dt","Interpretation evidence"),evidence,node("dt","Legend SHA-256"));
      const hash=node("dd",profile.legend.sha256);hash.style.overflowWrap="anywhere";facts.append(hash);
    }
    const table=node("table"),caption=node("caption",result.scope.aoiClipped?"Study-area class areas (mean sphere, partial cells)":"Class areas in the loaded window (mean sphere, whole cells)"),head=node("thead"),headers=node("tr");
    for(const title of ["Source code",...(profile?["Published product meaning or coverage status","Source-identified meaning","User meaning"]:["Class meaning"]),"Cells touched","Area (m²)",result.scope.aoiClipped?"Study area share (%)":"Window share (%)"])headers.append(node("th",title));head.append(headers);
    const body=node("tbody");
    const row=(code,meaning,cells,area,share,entry=null)=>{const tr=node("tr"),meanings=profile?entry
      ?[entry.profileMeaning??"Unknown code",entry.sourceMeaning??"Not identified",result.interpretation.classMeanings[String(code)]??"Not declared"]:[meaning,"—","—"]:[meaning];
      for(const value of [code,...meanings,cells,number(area),(share*100).toFixed(2)])tr.append(node("td",String(value)));body.append(tr);};
    const share=area=>coverage.requestedAreaSquareMeters>0?area/coverage.requestedAreaSquareMeters:0;
    for(const entry of result.classes)row(entry.code,entry.meaning??"Not declared",entry.cells,entry.areaSquareMeters,result.scope.aoiClipped?entry.shareOfAoi:entry.shareOfWindow,entry);
    row("—","Source NoData",coverage.noDataCells,coverage.noDataAreaSquareMeters,share(coverage.noDataAreaSquareMeters));
    row("—","Noninteger or unsafe integer",coverage.unclassifiedCells,coverage.unclassifiedAreaSquareMeters,share(coverage.unclassifiedAreaSquareMeters));
    if(result.scope.aoiClipped)row("—","Outside loaded window","—",coverage.outsideWindowAreaSquareMeters,share(coverage.outsideWindowAreaSquareMeters));
    table.append(caption,head,body);const limits=node("ul");for(const value of result.limitations)limits.append(node("li",value));
    let rows=table;if(profile){rows=node("div");rows.style.maxWidth="100%";rows.style.overflowX="auto";rows.tabIndex=0;rows.setAttribute("role","region");rows.setAttribute("aria-label","Published product class inventory");rows.append(table);}
    output.replaceChildren(facts,rows,limits);
  }
  const download=format=>{
    if(disposed||!result)return;
    try {const text=format==="json"?library.rasterBaselineJson(result):library.rasterBaselineCsv(result);
      onDownload?.({text,filename:`raster-class-inventory.${format}`,mimeType:format==="json"?"application/json":"text/csv;charset=utf-8"});}
    catch {invalidate();root.updateSource();status.textContent="The source window changed or the export exceeded its limit. Calculate again from the current window.";}
  };
  json.onclick=()=>download("json");csv.onclick=()=>download("csv");
  root.dispose=()=>{disposed=true;invalidate();knownGrid=null;calculate.disabled=true;};
  root.append(source,form,status,output,json,csv,node("p","No provider reads or processing jobs are started by this inventory. Review source terms before sharing derived summaries."));
  root.updateSource();return root;
}
function parseMeanings(value) {
  const result=Object.create(null);let count=0;
  for(const line of value.split(/\r?\n/)) {
    if(!line.trim())continue;
    const match=/^\s*(-?(?:0|[1-9]\d*))\s*=\s*(.+?)\s*$/.exec(line);
    if(!match||Object.hasOwn(result,match[1])||++count>256)throw Object.assign(Error("baseline_class_meanings_invalid"),{code:"baseline_class_meanings_invalid"});
    result[match[1]]=match[2];
  }
  return result;
}
function node(tag,value=""){const element=document.createElement(tag);element.textContent=value;return element;}
function button(title){const element=node("button",title);element.type="button";element.className="gis-button";return element;}
function input(title,type="text"){const label=node("label",title),element=node("input");element.type=type;element.setAttribute("aria-label",title);label.append(element);return {label,input:element};}
function select(title){const label=node("label",title),element=node("select");element.required=true;element.setAttribute("aria-label",title);label.append(element);return {label,input:element};}
function textarea(title){const label=node("label",title),element=node("textarea");element.rows=4;element.setAttribute("aria-label",title);label.append(element);return {label,input:element};}
function checkbox(title){const label=node("label"),element=node("input");element.type="checkbox";element.setAttribute("aria-label",title);label.append(element,document.createTextNode(" "+title));return {label,input:element};}
function number(value){return value.toLocaleString("en-US",{maximumFractionDigits:2});}
function periodLabel(value){return value?`${value.start} to ${value.end}`:"Not recorded";}
