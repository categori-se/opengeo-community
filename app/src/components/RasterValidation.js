/** Deliberate probability samples and whole-cell reference review. Drafts live on
 * their sample Layer; only generation depends on a resident raster window. */
export function RasterValidation({getCandidates=()=>[],getAssessment=()=>null,captureScope=()=>()=>true,
  onAdd,onUpdate,onFocus,onDownload}={}) {
  const root=node("details");root.className="gis-raster-validation gis-raster-comparison";
  root.append(node("summary","Validate categorical raster classes"),node("p","Freeze a stratified probability sample from loaded eligible whole cells, inspect their complete footprints against reference imagery, then record evidence and reference classes. The sample and all review events remain on a temporary Layer."));
  const source=node("p"),form=node("form"),planning=node("fieldset"),raster=select("Validation raster"),band=select("Validation categorical band"),
    confirm=checkbox("This band contains validation class codes"),classification=input("Validation classification (optional)"),
    start=input("Validation source period start (optional)","date"),end=input("Validation source period end (optional)","date"),
    crosswalk=textarea("Validation crosswalk (code = group per line)"),seed=input("Validation random seed"),draws=input("Draws per mapped stratum","number"),
    referenceClasses=textarea("Reference classes (one per line)"),question=textarea("Validation question"),protocol=textarea("Whole-cell labeling protocol");
  classification.input.maxLength=200;crosswalk.input.maxLength=8192;crosswalk.input.required=true;
  seed.input.required=true;seed.input.maxLength=128;draws.input.required=true;draws.input.min="2";draws.input.max="128";draws.input.step="1";draws.input.value="20";
  referenceClasses.input.required=true;referenceClasses.input.maxLength=5152;question.input.required=true;question.input.maxLength=500;
  protocol.input.required=true;protocol.input.maxLength=1000;question.input.rows=3;protocol.input.rows=4;
  const makeSeed=button("Generate seed"),generate=button("Generate validation sample Layer"),cancel=button("Cancel validation operation");
  generate.type="submit";cancel.disabled=true;
  planning.append(raster.label,band.label,confirm.label,classification.label,start.label,end.label,crosswalk.label,seed.label,makeSeed,draws.label,
    referenceClasses.label,question.label,protocol.label,node("p","Declare every possible reference class before sampling, including a class for observed conditions outside the mapped groups when needed. Define a consistent whole-cell labeling rule; this does not estimate subpixel cover. Sampling is with replacement, proportional to whole-cell area within each mapped group. Do not redraw or change the sample size after seeing labels."),generate);
  form.append(planning);
  const file=input("Saved validation assessment JSON","file");file.input.accept="application/json,.json";
  const open=button("Open saved assessment JSON");
  const status=node("p");status.setAttribute("role","status");status.setAttribute("aria-live","polite");
  const output=node("section");output.className="raster-validation-results";
  const reviewForm=node("form"),reviewFields=node("fieldset"),cell=select("Validation sample cell"),reference=select("Reference class"),reviewer=input("Reviewer"),
    evidence=textarea("Reference evidence (source, date and version)"),basis=textarea("Cell review note"),focus=button("Focus selected cell"),record=button("Record cell review"),evaluate=button("Calculate area-adjusted estimates");
  reviewer.input.required=true;reviewer.input.maxLength=160;evidence.input.required=true;evidence.input.maxLength=1000;basis.input.required=true;basis.input.maxLength=500;
  record.type="submit";reviewFields.append(cell.label,focus,reference.label,reviewer.label,evidence.label,basis.label,
    node("p","Use the map's existing basemap and imagery controls to inspect the entire cell footprint. Record imagery/source date and version and explain the whole-cell label. An unresolved review requires a reason and prevents estimation. Corrections append a new event; prior decisions remain retained."),record);
  reviewForm.append(reviewFields);reviewForm.hidden=true;
  const cellNote=node("p"),json=button("Download assessment JSON"),csv=button("Download validation draws CSV"),geojson=button("Download validation cells GeoJSON");
  const fields=[raster,band,confirm,classification,start,end,crosswalk,seed,draws,referenceClasses,question,protocol];
  let disposed=false,generation=0,controller=null,library=null,selected=null,renderedReport=null,renderedSignature=null,renderedEditable,known=null,choiceKey=null,bandKey=null,planningValues=null;
  const candidates=()=>{try{return (getCandidates?.()??[]).filter(value=>value?.id!=null&&value.grid);}catch{return [];}};
  const active=()=>{try{return getAssessment?.()??null;}catch{return null;}};
  const find=(items,id)=>items.find(value=>String(value.id)===id);
  const values=()=>fields.map(({input})=>input.type==="checkbox"?input.checked:input.value);
  const criteria=()=>JSON.stringify(values());
  const load=async()=>library??=await import("../lib/rasterValidation.js");
  const captureSource=value=>({id:String(value.id),grid:value.grid,pins:structuredClone(value.pins??null),
    pinsKey:signature(value.pins??null),gridKey:gridKey(value.grid),isCurrent:value.isCurrent});
  function sourceCurrent(saved,items=candidates()) {
    try {const value=find(items,saved?.id);return Boolean(saved&&value&&saved.grid.active()&&value.grid.active()
      &&saved.isCurrent?.()!==false&&value.isCurrent?.()!==false&&saved.pinsKey===signature(saved.pins)
      &&saved.pinsKey===signature(value.pins??null)&&saved.gridKey===gridKey(saved.grid)&&saved.gridKey===gridKey(value.grid));}
    catch{return false;}
  }
  const captureReport=entry=>({entry,id:entry.id,report:entry.report,signature:signature(entry.report)});
  function reportCurrent(saved,{editable=false}={}) {
    try {const next=active();return Boolean(!disposed&&saved&&next&&next.id===saved.id&&next.report===saved.report
      &&signature(next.report)===saved.signature&&saved.entry.isCurrent?.()!==false&&next.isCurrent?.()!==false&&(!editable||next.editable!==false));}
    catch{return false;}
  }
  function stop() {generation++;controller?.abort();controller=null;cancel.disabled=true;}
  function actions() {
    const saved=selected?captureReport(selected):null,ready=Boolean(saved&&reportCurrent(saved)),editable=ready&&selected.editable!==false;
    planning.disabled=Boolean(disposed||controller||selected);open.disabled=Boolean(disposed||controller||typeof onAdd!=="function");file.input.disabled=open.disabled;
    reviewFields.disabled=Boolean(!ready||controller);focus.disabled=Boolean(!ready||controller||typeof onFocus!=="function");
    for(const field of [reference,reviewer,evidence,basis])field.input.disabled=Boolean(!editable||controller);
    json.disabled=csv.disabled=geojson.disabled=Boolean(!ready||controller||typeof onDownload!=="function");
    let state=null;try{state=ready?reviewState(selected.report):null;}catch{/* Malformed selected records remain unavailable. */}
    evaluate.disabled=Boolean(!editable||controller||typeof onUpdate!=="function"||!state?.uniqueCells||state.reviewedCells!==state.uniqueCells||state.unresolvedCells);
    generate.disabled=Boolean(disposed||controller||selected||!sourceCurrent(known)||typeof onAdd!=="function");
    record.disabled=Boolean(!editable||controller||typeof onUpdate!=="function");
  }
  root.updateSource=()=>{
    if(disposed)return;
    const next=active(),changed=next?.id!==selected?.id||next?.report!==selected?.report||next?.editable!==renderedEditable||signature(next?.report??null)!==renderedSignature;
    if(changed) {
      stop();
      if(next&&!selected)planningValues=values();
      if(!next&&selected&&planningValues){fields.forEach(({input},index)=>{if(input.type==="checkbox")input.checked=planningValues[index];else input.value=planningValues[index];});known=null;bandKey=null;}
      selected=next;renderedReport=next?.report??null;renderedSignature=signature(next?.report??null);renderedEditable=next?.editable;
      if(selected) {
        populatePlan(selected.report);renderReport();
        status.textContent=selected.editable===false?"This assessment is available for inspection and export. Open a saved assessment JSON as a new temporary Layer to continue review; a started Catalog registration retains its frozen data.":"The sample plan is frozen. Review each distinct whole cell; the original raster window is no longer required.";
      }else {output.replaceChildren();reviewForm.hidden=true;cellNote.textContent="";}
    } else selected=next;
    if(!selected) {
      const items=candidates(),key=JSON.stringify(items.map(value=>[String(value.id),String(value.title??value.id)]));
      if(key!==choiceKey){choiceKey=key;const previous=raster.input.value;
        raster.input.replaceChildren(option("","Choose a loaded raster"),...items.map(value=>option(String(value.id),String(value.title??value.id))));raster.input.value=previous;}
      const value=find(items,raster.input.value);
      if(known&&!sourceCurrent(known,items)){stop();known=null;confirm.input.checked=false;status.textContent="The raster window or source changed. Confirm its categorical band and crosswalk before generating a sample.";}
      if(value&&!known)known=captureSource(value);
      const bands=value?.grid?.metadata?.bands??[],keyBands=JSON.stringify(bands);
      if(keyBands!==bandKey){bandKey=keyBands;const previous=band.input.value;band.input.replaceChildren(...bands.map(value=>option(String(value),`Band ${value}`)));if(bands.some(value=>String(value)===previous))band.input.value=previous;}
      source.textContent=value?`${value.title??"Loaded raster"} · ${value.grid.width} × ${value.grid.height} loaded cells · ${value.grid.metadata?.imageIndex===0?"main grid":"overview grid"}. Only this eligible loaded window enters the frozen population.`:"Choose an already loaded categorical raster, or open a saved assessment JSON to continue review without the original raster.";
    }else source.textContent=`Selected assessment Layer: ${selected.title??selected.id}. Planning fields are locked; existing Layers retain their own drafts when you change the selection.`;
    actions();
  };
  function populatePlan(report) {
    const plan=report?.plan,declared=plan?.input?.interpretation??{},parameters=plan?.criteria??{};
    raster.input.replaceChildren(option(String(plan?.input?.pins?.layerId??"frozen"),"Frozen sample source"));raster.input.selectedIndex=0;
    band.input.replaceChildren(option(String(plan?.input?.band??""),`Band ${plan?.input?.band??"unknown"}`));
    confirm.input.checked=true;classification.input.value=declared.classification??"";start.input.value=declared.period?.start??"";end.input.value=declared.period?.end??"";
    crosswalk.input.value=Object.entries(declared.crosswalk??{}).map(([code,group])=>`${code} = ${group}`).join("\n");
    seed.input.value=parameters.seed??"";draws.input.value=String(parameters.samplesPerStratum??"");referenceClasses.input.value=(parameters.referenceClasses??[]).join("\n");
    question.input.value=parameters.question??"";protocol.input.value=parameters.labelingProtocol??"";choiceKey=null;bandKey=null;
  }
  function changed(event) {
    if(disposed||selected)return;stop();
    if(event.target===raster.input){known=null;bandKey=null;confirm.input.checked=false;}
    root.updateSource();status.textContent="Plan settings changed. Generate a deliberate new sample before reference review.";
  }
  form.addEventListener("input",changed);form.addEventListener("change",changed);
  makeSeed.onclick=()=>{
    if(disposed||selected||controller)return;
    try {const bytes=new Uint8Array(16);globalThis.crypto.getRandomValues(bytes);seed.input.value=Array.from(bytes,value=>value.toString(16).padStart(2,"0")).join("");changed({target:seed.input});}
    catch {status.textContent="Secure random seed generation is unavailable. Enter and retain an explicit seed before sampling.";}
  };
  cancel.onclick=()=>{if(disposed)return;stop();root.updateSource();status.textContent="Validation operation cancelled. Existing sample Layers and reviews are retained.";};
  form.onsubmit=async event=>{
    event.preventDefault();if(disposed||selected||!form.reportValidity())return;
    if(!confirm.input.checked){status.textContent="Confirm that the selected band contains categorical validation class codes.";return;}
    stop();const run=generation,scope=captureScope(),request=new AbortController(),declaration=criteria();controller=request;cancel.disabled=false;actions();
    let saved;
    const current=()=>!disposed&&run===generation&&scope()!==false&&!active()&&declaration===criteria()&&sourceCurrent(saved);
    status.textContent="Freezing eligible cells and drawing the stratified sample…";
    try {
      const value=find(candidates(),raster.input.value);if(!value)throw failure("source_changed");saved=captureSource(value);
      const declared={band:Number(band.input.value),categoricalConfirmed:confirm.input.checked,classification:classification.input.value.trim()||null,
        periodStart:start.input.value||null,periodEnd:end.input.value||null,crosswalk:parseCrosswalk(crosswalk.input.value)},parameters={seed:seed.input.value.trim(),samplesPerStratum:Number(draws.input.value),
          referenceClasses:referenceClasses.input.value.split(/\r?\n/).map(value=>value.trim()).filter(Boolean),question:question.input.value.trim(),labelingProtocol:protocol.input.value.trim()};
      const api=await load();if(!current())throw failure("source_changed");
      const plan=await api.createRasterValidationPlan({input:{...declared,grid:saved.grid,pins:saved.pins,isCurrent:current},...parameters,signal:request.signal,
        onProgress:({processedCells,totalCells})=>{if(current())status.textContent=`Examined ${processedCells} of ${totalCells} loaded cells.`;}});
      if(!current())throw failure("source_changed");
      const report=api.createRasterValidationAssessment(plan),collection=api.rasterValidationGeoJson(report);
      controller=null;cancel.disabled=true;
      onAdd(collection);root.updateSource();status.textContent="Validation sample Layer added. The plan is frozen; inspect each distinct cell against reference imagery and record the evidence.";
    }catch(error){if(!disposed&&run===generation)status.textContent=errorMessage(error);}
    finally {if(!disposed&&run===generation){controller=null;cancel.disabled=true;actions();}}
  };
  function reviewState(report) {
    if(library){const state=library.rasterValidationReviewState(report);return {...state,uniqueCells:Array.isArray(state.uniqueCells)?state.uniqueCells.length:state.uniqueCells};}
    const samples=report?.plan?.samples??[],latest=new Map();for(const event of report?.reviews??[])latest.set(event.cellId,event);
    const unique=new Set(samples.map(value=>value.cellId));let reviewedCells=0,unresolvedCells=0;
    for(const id of unique){const event=latest.get(id);if(event){if(event.referenceClass===null)unresolvedCells++;else reviewedCells++;}}
    return {uniqueCells:unique.size,reviewedCells,unresolvedCells,unreviewedCells:unique.size-reviewedCells-unresolvedCells,latest};
  }
  function renderReport() {
    const report=renderedReport,plan=report?.plan;
    if(!plan||!Array.isArray(plan.samples)||plan.samples.length>512||!Array.isArray(plan.strata)||plan.strata.length>16){output.replaceChildren(node("p","This selected assessment is invalid. Open a valid saved assessment JSON."));reviewForm.hidden=true;return;}
    let state;try{state=reviewState(report);}catch{output.replaceChildren(node("p","This selected assessment is invalid. Open a valid saved assessment JSON."));reviewForm.hidden=true;return;}
    const facts=node("dl");facts.className="gis-key-values raster-comparison-facts";
    for(const [title,value] of Object.entries({Status:report.status,"Validation question":plan.criteria.question,"Whole-cell labeling protocol":plan.criteria.labelingProtocol,
      Scope:"Frozen loaded eligible whole cells; not the full dataset","Loaded cells":plan.coverage.totalCells,"Eligible cells":plan.coverage.eligibleCells,
      "Eligible area (m²)":number(plan.coverage.eligibleAreaSquareMeters),"Excluded cells":plan.coverage.excludedCells,"Excluded area (m²)":number(plan.coverage.excludedAreaSquareMeters),
      Strata:plan.strata.length,"Sample draws":plan.samples.length,"Distinct sampled cells":state.uniqueCells,"Reviewed distinct cells":state.reviewedCells,
      "Unresolved distinct cells":state.unresolvedCells,"Unreviewed distinct cells":state.unreviewedCells,"Pending distinct cell reviews":state.uniqueCells-state.reviewedCells,
      "Retained review events":report.reviews.length,"Random seed":plan.criteria.seed}))facts.append(node("dt",title),node("dd",String(value)));
    const elements=[facts,table("Frozen mapped strata",["Mapped group","Eligible cells","Area (m²)","Draws"],plan.strata.map(value=>[value.group,value.cells,number(value.areaSquareMeters),value.draws])),
      node("p","Repeated draws retain their multiplicity. One current whole-cell reference label applies to every draw of that cell; all distinct sampled cells need resolved labels before estimates are available.")];
    if(report.estimates){const estimate=report.estimates;
      elements.push(table("Area-adjusted reference class areas",["Reference class","Estimated area (m²)","Standard error (m²)","Lower 95% (m²)","Upper 95% (m²)"],estimate.classAreas.map(value=>[value.referenceClass,number(value.areaSquareMeters),number(value.standardErrorSquareMeters),number(value.lower95SquareMeters),number(value.upper95SquareMeters)])),
        table("Area-weighted confusion",["Mapped group","Reference class","Draws","Estimated area (m²)","Area fraction"],estimate.confusion.map(value=>[value.mappedGroup,value.referenceClass,value.draws,number(value.estimatedAreaSquareMeters),number(value.areaFraction)])),
        table("Conditional point metrics",["Class","Precision","Recall","F1"],estimate.classes.map(value=>[value.group,number(value.precision),number(value.recall),number(value.f1)])),
        node("p",`Conditional overall agreement: ${number(estimate.overallAgreement)}. The 95% simultaneous predeclared reference-class area intervals use exact Clopper–Pearson bounds with Bonferroni adjustment across strata and classes. These intervals apply only to class areas; precision, recall, F1 and overall agreement are point estimates without reported intervals.`));
    }else elements.push(node("p","Area-adjusted estimates remain unavailable until every distinct sampled cell has a resolved reference class. Calculate explicitly after completing review."));
    elements.push(node("p","Sampling uncertainty is conditional on fixed reference labels, the frozen eligible domain and the declared cell-area model. Reference quality and classification accuracy remain unknown; interpretation, temporal, positional and area-model errors are outside these intervals. Whole-cell class area is not subpixel cover or ecological truth. Output license and derived permissions are unestablished; review source terms before sharing."));
    const limits=node("ul");for(const limitation of new Set([...(plan.limitations??[]),...(report.limitations??[])]))limits.append(node("li",limitation));elements.push(limits);output.replaceChildren(...elements);
    const previous=cell.input.value,unique=[...new Map(plan.samples.map(value=>[value.cellId,value])).values()];
    cell.input.replaceChildren(...unique.map(value=>{const count=plan.samples.filter(sample=>sample.cellId===value.cellId).length,event=state.latest.get(value.cellId);
      return option(value.cellId,`${value.cellId} · ${value.stratum} · ${count} draw${count===1?"":"s"} · ${!event?"unreviewed":event.referenceClass===null?"unresolved":event.referenceClass}`);}));
    if(unique.some(value=>value.cellId===previous))cell.input.value=previous;
    reference.input.replaceChildren(option("","Unresolved — explain in cell review note"),...plan.criteria.referenceClasses.map(value=>option(value,value)));
    reviewForm.hidden=false;showCell();
  }
  function showCell() {
    if(!selected)return;const report=selected.report,sample=report.plan.samples.find(value=>value.cellId===cell.input.value),latest=reviewState(report).latest.get(cell.input.value);
    reference.input.value=latest?.referenceClass??"";basis.input.value=latest?.basis??"";
    if(latest){reviewer.input.value=latest.reviewer;evidence.input.value=latest.evidence;}
    cellNote.textContent=sample?`Whole cell ${sample.cellId}: row ${sample.row}, column ${sample.column}; mapped group ${sample.stratum}; code ${sample.code}${sample.meaning?` (${sample.meaning})`:""}; area ${number(sample.areaSquareMeters)} m². ${latest?`Latest review: ${latest.reviewedAt}.`:"No reference review yet."}`:"Choose a sampled cell.";
  }
  cell.input.onchange=showCell;
  focus.onclick=()=>{
    const saved=selected?captureReport(selected):null;if(!reportCurrent(saved))return root.updateSource();
    const sample=saved.report.plan.samples.find(value=>value.cellId===cell.input.value);if(sample)onFocus?.(structuredClone(sample),saved.entry);
  };
  async function replaceAssessment(transform,progress) {
    if(disposed||!selected)return;const saved=captureReport(selected);if(!reportCurrent(saved,{editable:true}))return root.updateSource();
    stop();const run=generation,scope=captureScope(),request=new AbortController();controller=request;cancel.disabled=false;actions();
    const current=()=>!disposed&&run===generation&&scope()!==false&&reportCurrent(saved,{editable:true});
    try {const api=await load();if(!current())throw failure("assessment_changed");api.assertRasterValidationAssessment(saved.report);
      const next=await transform(api,saved.report,{signal:request.signal,onProgress:value=>{if(current()&&progress)status.textContent=progress(value);}});
      if(!current())throw failure("assessment_changed");const collection=api.rasterValidationGeoJson(next);
      controller=null;cancel.disabled=true;if(onUpdate(collection,saved.entry)===false)throw failure("assessment_changed");root.updateSource();
    }catch(error){if(!disposed&&run===generation)status.textContent=errorMessage(error);}
    finally {if(!disposed&&run===generation){controller=null;cancel.disabled=true;actions();}}
  }
  reviewForm.onsubmit=async event=>{
    event.preventDefault();if(disposed||!reviewForm.reportValidity())return;
    const choice={cellId:cell.input.value,referenceClass:reference.input.value||null,reviewer:reviewer.input.value.trim(),evidence:evidence.input.value.trim(),basis:basis.input.value.trim(),reviewedAt:new Date().toISOString()};
    if(!choice.reviewer||!choice.evidence||!choice.basis){status.textContent="Record a reviewer, reference evidence and cell review note, including the reason for any unresolved label.";return;}
    await replaceAssessment((api,report)=>api.reviewRasterValidationCell(report,choice));
  };
  evaluate.onclick=async()=>{
    if(disposed||!selected)return;const state=reviewState(selected.report);
    if(state.reviewedCells!==state.uniqueCells||state.unresolvedCells){status.textContent="Resolve every distinct sampled cell before calculating estimates. Unreviewed or unresolved draws are never omitted.";return;}
    status.textContent="Calculating area-adjusted estimates and simultaneous class-area intervals…";
    await replaceAssessment((api,report,options)=>api.evaluateRasterValidationAssessment(report,options),()=>"Calculating area-adjusted estimates and simultaneous class-area intervals…");
  };
  const download=async format=>{
    if(disposed||!selected)return;const saved=captureReport(selected),scope=captureScope();
    try {const api=await load();if(scope()===false||!reportCurrent(saved))throw failure("assessment_changed");api.assertRasterValidationAssessment(saved.report);
      const text=format==="json"?api.rasterValidationJson(saved.report):format==="csv"?api.rasterValidationCsv(saved.report):JSON.stringify(api.rasterValidationGeoJson(saved.report));
      if(!reportCurrent(saved)||scope()===false)throw failure("assessment_changed");onDownload?.({text,filename:`raster-validation.${format}`,mimeType:format==="csv"?"text/csv;charset=utf-8":format==="geojson"?"application/geo+json":"application/json"});
    }catch(error){if(!disposed)status.textContent=errorMessage(error);root.updateSource();}
  };
  json.onclick=()=>download("json");csv.onclick=()=>download("csv");geojson.onclick=()=>download("geojson");
  root.openAssessmentFile=async selectedFile=>{
    if(disposed||controller||typeof onAdd!=="function")return;
    stop();const run=generation,scope=captureScope(),original=active(),saved=original?captureReport(original):null,request=new AbortController();controller=request;cancel.disabled=false;actions();
    const current=()=>!disposed&&run===generation&&scope()!==false&&(saved?reportCurrent(saved):!active());
    status.textContent="Opening the saved assessment as a new temporary Layer…";
    try {if(!selectedFile||!Number.isSafeInteger(selectedFile.size)||selectedFile.size<1||selectedFile.size>1_048_576)throw failure("import_limit");
      const text=await selectedFile.text();if(!current())throw failure("assessment_changed");if(new TextEncoder().encode(text).byteLength>1_048_576)throw failure("import_limit");
      const api=await load();if(!current())throw failure("assessment_changed");const report=await api.parseRasterValidationJson(text);if(!current())throw failure("assessment_changed");
      const collection=api.rasterValidationGeoJson(report);controller=null;cancel.disabled=true;onAdd(collection);root.updateSource();status.textContent="Saved assessment opened as a new temporary Layer. Prior Layers and their review events are retained.";
    }catch(error){if(!disposed&&run===generation)status.textContent=errorMessage(error);}
    finally {if(!disposed&&run===generation){controller=null;cancel.disabled=true;actions();}}
  };
  open.onclick=()=>{if(file.input.files?.[0])void root.openAssessmentFile(file.input.files[0]);else status.textContent="Choose a saved assessment JSON file of at most 1 MiB.";};
  root.dispose=()=>{disposed=true;stop();selected=null;known=null;planning.disabled=reviewFields.disabled=true;actions();};
  root.append(source,form,file.label,open,cancel,status,output,cellNote,reviewForm,evaluate,json,csv,geojson);
  root.updateSource();return root;
}
function parseCrosswalk(text) {
  const result=Object.create(null);let count=0;
  for(const line of text.split(/\r?\n/)){if(!line.trim())continue;const match=/^\s*(-?(?:0|[1-9]\d*))\s*=\s*(.+?)\s*$/.exec(line),code=match?Number(match[1]):NaN;
    if(!match||!Number.isSafeInteger(code)||Object.hasOwn(result,String(code))||match[2].length>160||++count>256)throw failure("crosswalk_invalid");result[String(code)]=match[2];}
  if(!count)throw failure("crosswalk_invalid");return result;
}
function signature(value){return JSON.stringify(value,(_key,item)=>item&&typeof item==="object"&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);}
function gridKey(grid){return signature({width:grid.width,height:grid.height,metadata:grid.metadata});}
function failure(code){return Object.assign(Error(`validation_${code}`),{code:`validation_${code}`});}
function errorMessage(error){
  if(error?.name==="AbortError")return "Validation operation cancelled. Existing sample Layers and review events are retained.";
  const code=error?.code??error?.message??"";
  if(code.includes("changed")||code.includes("stale"))return "The selected source, assessment or account changed. No late result replaced your review work; return to the intended Layer and continue.";
  if(code.includes("crosswalk"))return "Enter one unique integer code = mapped group per line, with at most 256 mappings.";
  if(code.includes("reference")||code.includes("class"))return "Declare unique reference classes before sampling, and use those classes for reference review. Reference quality remains unverified.";
  if(code.includes("review")||code.includes("unresolved"))return "Every distinct cell needs a resolved reference label before estimation. Record the reviewer, source evidence and review note; unresolved cells remain in the assessment.";
  if(code.includes("period"))return "Enter a complete chronological source date pair, or leave both optional source dates blank.";
  if(code.includes("limit"))return "The validation operation exceeded a supported size or time limit. Use at most 16 mapped strata, 512 draws, 1,048,576 loaded cells and 1 MiB saved assessments. Existing reviews remain retained.";
  return "Validation unavailable. Review the categorical band, explicit crosswalk, seed, 2–128 draws per stratum, reference classes, question and whole-cell labeling protocol, or open a valid saved assessment JSON.";
}
function number(value){return value===null||value===undefined?"Not applicable":new Intl.NumberFormat(undefined,{maximumFractionDigits:6}).format(value);}
function node(tag,text=""){const value=document.createElement(tag);value.textContent=text;return value;}
function button(title){const value=node("button",title);value.type="button";value.className="gis-button";return value;}
function option(value,title){const element=node("option",title);element.value=value;return element;}
function input(title,type="text"){const label=node("label",title),element=node("input");element.type=type;element.setAttribute("aria-label",title);label.append(element);return {label,input:element};}
function select(title){const label=node("label",title),element=node("select");element.setAttribute("aria-label",title);label.append(element);return {label,input:element};}
function textarea(title){const label=node("label",title),element=node("textarea");element.setAttribute("aria-label",title);label.append(element);return {label,input:element};}
function checkbox(title){const value=input(title,"checkbox");return value;}
function table(title,headers,rows){const wrap=node("div");wrap.className="raster-comparison-table-scroll";wrap.tabIndex=0;wrap.setAttribute("role","region");wrap.setAttribute("aria-label",title);
  const value=node("table"),head=node("thead"),header=node("tr"),body=node("tbody");for(const name of headers)header.append(node("th",name));head.append(header);
  for(const row of rows){const element=node("tr");for(const cell of row)element.append(node("td",String(cell)));body.append(element);}value.append(node("caption",title),head,body);wrap.append(value);return wrap;}
