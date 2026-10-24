const MAX_EXPORT_BYTES=2_097_152;
const defaultClient=async()=>{
  const {createFieldsOfTheWorldClient}=await import("../lib/fieldsOfTheWorld.js");
  return createFieldsOfTheWorldClient();
};

/** Explicit public-product retrieval. Mounting, opening and editing perform no
 * reads. Callbacks receive detached copies of the accepted result, never its
 * retained snapshot. onDownload receives {filename, blob}.
 */
export function FieldsOfTheWorld({getClient=defaultClient,onAdd,onDownload}={}) {
  const root=node("details");root.className="gis-fields-of-the-world";
  root.append(node("summary","Find mapped agricultural fields"),node("p","Use Fields of the World 2024 or 2025 predictions for a country and a small rectangle. Results retain whole footprints; they are not clipped to a study polygon."));
  const form=node("form");form.className="platform-controls";
  const country=input("Country code (two letters)");country.input.maxLength=2;country.input.minLength=2;country.input.pattern="[A-Za-z]{2}";
  country.input.autocomplete="country";
  const year=select("Field observation year",[["","Choose year"],["2024","2024"],["2025","2025"]]);
  const west=input("West longitude","number"),south=input("South latitude","number"),east=input("East longitude","number"),north=input("North latitude","number");
  for(const control of [west,east]){control.input.min="-180";control.input.max="180";}
  for(const control of [south,north]){control.input.min="-90";control.input.max="90";}
  const find=button("Find fields");find.type="submit";
  const cancel=button("Cancel field search");cancel.disabled=true;
  form.append(...[country,year,west,south,east,north].map(control=>control.label),find,cancel);
  const status=node("p","Search runs only when you choose Find fields. Limits: 32 requests, 8 MiB transferred and 30 seconds. Larger selections need a prepared native subset.");
  status.setAttribute("role","status");status.setAttribute("aria-live","polite");
  const output=node("section"),add=button("Add temporary field Layer"),download=button("Download field query JSON");
  const saved=input("Open saved field query","file");saved.input.required=false;saved.input.accept=".json,application/json";
  add.disabled=download.disabled=true;
  root.append(form,saved.label,node("p","Open a previously downloaded query JSON locally (up to 2 MiB). This does not contact or reverify its provider."),status,output,add,download,node("p","CC BY 4.0 source terms and attribution remain attached to the result. Confidence describes regional model reliability, not a calibrated polygon probability. Predicted fields do not establish crops, cadastral parcels, tenure or field verification."));
  let disposed=false,client=null,controller=null,generation=0,snapshot=null,resultSignature=null,added=false,confidenceDispose=null;
  const controls=[country,year,west,south,east,north].map(control=>control.input);
  const signature=()=>JSON.stringify(controls.map(control=>control.value));
  const actions=()=>{
    add.disabled=disposed||!snapshot||added||typeof onAdd!=="function"||JSON.parse(snapshot).geojson.features.length===0;
    download.disabled=disposed||!snapshot||typeof onDownload!=="function";
  };
  function invalidate() {
    confidenceDispose?.();confidenceDispose=null;
    generation++;controller?.abort();controller=null;snapshot=null;resultSignature=null;added=false;
    output.replaceChildren();cancel.disabled=true;find.disabled=disposed;form.removeAttribute("aria-busy");actions();
  }
  const changed=()=>{if(disposed)return;invalidate();status.textContent="Selection changed. Choose Find fields to retrieve a current result.";};
  form.addEventListener("input",changed);form.addEventListener("change",changed);
  cancel.onclick=()=>{if(disposed)return;invalidate();status.textContent="Field search cancelled. No result was added.";};
  form.onsubmit=async event=>{
    event.preventDefault();if(disposed||controller)return;
    if(!form.reportValidity()){status.textContent="Enter a two-letter country code, choose 2024 or 2025, and enter all four rectangle coordinates.";return;}
    const query={countryCode:country.input.value.trim().toUpperCase(),year:Number(year.input.value),
      bounds:[west,south,east,north].map(control=>control.input.value.trim()?Number(control.input.value):NaN)};
    if(!/^[A-Z]{2}$/.test(query.countryCode)||![2024,2025].includes(query.year)||!query.bounds.every(Number.isFinite)
      ||query.bounds[0]>=query.bounds[2]||query.bounds[1]>=query.bounds[3]){
      status.textContent="Use a two-letter country code and ordered west, south, east, north coordinates. The rectangle must not cross the date line.";return;
    }
    invalidate();const current=++generation,request=new AbortController(),requestedSignature=signature();controller=request;
    find.disabled=true;cancel.disabled=false;form.setAttribute("aria-busy","true");status.textContent="Finding published field footprints…";
    const currentRequest=()=>!disposed&&generation===current&&!request.signal.aborted&&signature()===requestedSignature;
    try {
      client??=await getClient();if(!currentRequest())return;
      const result=await client.search(query,{signal:request.signal,onStatus:message=>{
        if(currentRequest()&&typeof message==="string")status.textContent=message;
      }});
      if(!currentRequest())return;
      // The client owns the versioned record. Retain only its two public result
      // members as immutable serialized bytes; callbacks cannot mutate them.
      const record={geojson:result.geojson,receipt:result.receipt};
      if(record.geojson?.type!=="FeatureCollection"||!Array.isArray(record.geojson.features)
        ||record.receipt?.schemaVersion!=="opengeo.ftw-query.1.0.0"||record.receipt.status!=="complete"
        ||record.receipt.query?.countryCode!==query.countryCode||record.receipt.query?.year!==query.year
        ||JSON.stringify(record.receipt.query?.bounds)!==JSON.stringify(query.bounds))throw Object.assign(Error(),{code:"ftw_invalid"});
      const serialized=JSON.stringify(record);
      if(new TextEncoder().encode(serialized).byteLength>MAX_EXPORT_BYTES)throw Object.assign(Error(),{code:"ftw_limit"});
      snapshot=serialized;resultSignature=requestedSignature;added=false;renderResult(JSON.parse(snapshot));actions();
      const count=record.geojson.features.length;
      status.textContent=count?`${count} field footprint${count===1?"":"s"} returned for ${query.year}. Review the source and scope before adding or sharing.`
        :`0 field footprints returned for ${query.year}. This does not establish that fields are absent or that source coverage is complete.`;
    } catch(error) {
      if(!currentRequest())return;
      snapshot=null;output.replaceChildren();actions();status.textContent=errorMessage(error);
    } finally {
      if(!disposed&&generation===current){controller=null;find.disabled=false;cancel.disabled=true;form.removeAttribute("aria-busy");}
    }
  };
  saved.input.onchange=async()=>{
    const file=saved.input.files?.[0];if(disposed||!file)return;
    saved.input.value="";invalidate();const current=++generation,request=new AbortController(),previousSignature=signature();controller=request;
    find.disabled=true;cancel.disabled=false;form.setAttribute("aria-busy","true");status.textContent="Opening the saved field query locally…";
    const currentImport=()=>!disposed&&generation===current&&!request.signal.aborted&&signature()===previousSignature;
    try {
      const {restoreFieldsOfTheWorldQuery}=await import("../lib/fieldsOfTheWorld.js");if(!currentImport())return;
      const record=await restoreFieldsOfTheWorldQuery(file,{signal:request.signal});if(!currentImport())return;
      const query=record.receipt.query;
      country.input.value=query.countryCode;year.input.value=String(query.year);
      for(const [index,control] of [west,south,east,north].entries())control.input.value=String(query.bounds[index]);
      snapshot=JSON.stringify(record);resultSignature=signature();added=false;renderResult(JSON.parse(snapshot));actions();
      const count=record.geojson.features.length;
      status.textContent=`Opened a user-supplied saved query: ${count} field footprint${count===1?"":"s"} for ${query.year}. No provider was contacted or reverified.${count===0?" An empty query does not establish that fields are absent.":" Review the source and scope before adding or sharing."}`;
    } catch(error) {if(currentImport())status.textContent=errorMessage(error);}
    finally {if(!disposed&&generation===current){controller=null;find.disabled=false;cancel.disabled=true;form.removeAttribute("aria-busy");}}
  };
  function renderResult({geojson,receipt}) {
    const facts=node("dl");facts.className="gis-key-values";
    const usage=receipt.usage??{},source=receipt.source??{};
    const entries={"Returned footprints":geojson.features.length,"Selected country":receipt.query.countryCode,
      "Observation year":receipt.query.year,"Query rectangle":receipt.query.bounds.join(", "),
      Selection:"Whole footprints intersecting the rectangle; not clipped",Coverage:"Not independently verified",
      "Source terms":source.license??"Not supplied","Source attribution":source.attribution??"See the producer citation and query receipt",
      "Source citation":source.citation??"See the producer citation and query receipt","Source edition":source.distributionVersion??"Not recorded",
      "Source snapshot":source.etag?"Object ETag recorded; see query receipt":"Not recorded",
      "Retained query requests":number(usage.requests),"Retained query bytes":number(usage.bytes),"Retained query time (ms)":number(usage.milliseconds),
      "Scanned rows":number(receipt.counts?.scannedRows),Method:"Year and spatial selection from a published country partition"};
    if(receipt.localImport)Object.assign(entries,{"Evidence origin":"User-supplied local query; provider not reverified",
      "Imported file":receipt.localImport.filename,"File SHA-256":receipt.localImport.sha256,"Local import time":receipt.localImport.importedAt});
    for(const [name,value] of Object.entries(entries))facts.append(node("dt",name),node("dd",String(value)));
    const partition=node("p","Source partition: ");
    let url;try{url=new URL(source.partitionUrl);if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash)url=null;}catch{}
    if(url){const link=node("a",url.href);link.href=url.href;link.target="_blank";link.rel="noopener noreferrer";partition.append(link);}
    else partition.append(document.createTextNode("Not recorded"));
    const notes=node("ul");
    for(const message of receipt.limitations??[])if(typeof message==="string")notes.append(node("li",message));
    confidenceDispose?.();
    const confidence=confidenceReview({geojson,receipt});
    confidenceDispose=confidence.dispose;
    output.replaceChildren(facts,partition,notes,confidence);
  }
  function confidenceReview(record) {
    const section=node("details");section.className="gis-field-confidence";
    section.append(node("summary","Inspect field confidence"),node("p","Inspect the published 0–100 scores and missing values. These describe regional model reliability sampled at a field point from a 500 m raster, not calibrated field probabilities or independently measured boundary accuracy."));
    const threshold=input("Flag scores below (optional, 0–100)","number");threshold.input.required=false;threshold.input.min="0";threshold.input.max="100";
    const review=button("Review field confidence"),json=button("Download confidence JSON"),csv=button("Download confidence CSV"),
      message=node("p","Choose Review field confidence to inspect the returned fields. An optional threshold flags scores strictly below it; equal scores are not flagged. Missing scores remain separate. All original fields remain in the query and Layer."),body=node("section"),
      retained=snapshot;
    message.setAttribute("role","status");message.setAttribute("aria-live","polite");
    let closed=false,report=null,reviewedThreshold=null,page=0;
    const current=()=>!closed&&!disposed&&snapshot===retained&&signature()===resultSignature;
    const clear=()=>{report=null;reviewedThreshold=null;page=0;body.replaceChildren();json.disabled=csv.disabled=true;};
    clear();review.disabled=!record.geojson.features.length;
    threshold.input.addEventListener("input",()=>{if(!current())return;clear();message.textContent="Review settings changed. Choose Review field confidence to calculate a current report.";});
    function render() {
      if(!current()||!report)return;
      const facts=node("dl");facts.className="gis-key-values";
      const summary=report.summary,entries={"Returned fields":summary.fieldCount,"Scores supplied":summary.scoredCount,"Scores missing":summary.missingCount,
        "Lowest supplied score":summary.minScore??"Not supplied","Highest supplied score":summary.maxScore??"Not supplied",
        "User threshold":report.method.threshold??"Not selected","Below threshold":summary.belowThresholdCount??"Not assessed","At or above threshold":summary.atOrAboveThresholdCount??"Not assessed"};
      for(const [name,value] of Object.entries(entries))facts.append(node("dt",name),node("dd",String(value)));
      const scroll=node("div");scroll.style.overflowX="auto";
      const table=node("table"),head=node("thead"),heading=node("tr"),rows=node("tbody"),first=page*25,last=Math.min(first+25,report.rows.length);
      table.append(node("caption",`Fields ${first+1}–${last} of ${report.rows.length}; downloads contain every field`));
      for(const title of ["Field ID","Source score","Review flag"]){const th=node("th",title);th.scope="col";heading.append(th);}head.append(heading);
      for(const row of report.rows.slice(first,last)){
        const tr=node("tr"),id=node("td",row.fieldId);id.style.overflowWrap="anywhere";
        tr.append(id,node("td",row.sourceConfidence===null?"Not supplied":String(row.sourceConfidence)),node("td",row.sourceConfidence===null?"Missing":report.method.threshold===null?"Threshold not selected":row.sourceConfidence<report.method.threshold?"Below threshold":"At or above threshold"));rows.append(tr);
      }
      table.append(head,rows);scroll.append(table);
      const previous=button("Previous confidence fields"),next=button("Next confidence fields");previous.disabled=page===0;next.disabled=last>=report.rows.length;
      previous.onclick=()=>{if(current()&&report&&page>0){page--;render();}};next.onclick=()=>{if(current()&&report&&last<report.rows.length){page++;render();}};
      body.replaceChildren(facts,scroll,previous,next);
    }
    review.onclick=()=>{
      if(!current()||!record.geojson.features.length)return;clear();
      const raw=threshold.input.value.trim(),value=raw===""?null:Number(raw);
      if(!threshold.input.checkValidity()||value!==null&&(!Number.isFinite(value)||value<0||value>100)){message.textContent="Use a threshold from 0 to 100, or leave it empty.";return;}
      try{
        report=reviewFieldConfidence({record,threshold:value});reviewedThreshold=threshold.input.value;render();json.disabled=csv.disabled=typeof onDownload!=="function";
        message.textContent="Confidence review complete. Flags prioritize inspection; no fields were accepted, removed or changed. Independent accuracy remains unassessed.";
      }catch{clear();message.textContent="The retained query cannot be reviewed safely. Open a complete saved field query or review the source values. No query or Layer was changed.";}
    };
    const download=kind=>{
      if(!current()||!report||typeof onDownload!=="function")return;
      if(threshold.input.value!==reviewedThreshold){clear();message.textContent="Review settings changed. Choose Review field confidence to calculate a current report.";return;}
      try{
        const text=kind==="json"?JSON.stringify(report):fieldConfidenceCsv(report);
        onDownload({filename:`ftw-${record.receipt.query.countryCode.toLowerCase()}-${record.receipt.query.year}-field-confidence.${kind}`,blob:new Blob([text],{type:kind==="json"?"application/json":"text/csv;charset=utf-8"})});
      }catch{message.textContent="The confidence download could not be started. Try the download again.";}
    };
    json.onclick=()=>download("json");csv.onclick=()=>download("csv");
    section.append(threshold.label,review,message,body,json,csv);
    section.dispose=()=>{if(closed)return;closed=true;clear();threshold.input.disabled=review.disabled=true;};
    return section;
  }
  function currentResult() {
    if(disposed||!snapshot)return null;
    if(signature()!==resultSignature){invalidate();status.textContent="Selection changed. Find fields again before adding or downloading.";return null;}
    return JSON.parse(snapshot);
  }
  add.onclick=async()=>{
    const record=currentResult();if(!record||added||!record.geojson.features.length||typeof onAdd!=="function")return;
    added=true;actions();const current=generation;
    try {await onAdd(record);if(!disposed&&generation===current)status.textContent="Fields added as a temporary Layer. Download the query to retain it. Register the Layer in Catalog before saving an account Project.";}
    catch {if(!disposed&&generation===current){added=false;actions();status.textContent="The temporary Layer could not be added. Review the map and try Add again.";}}
  };
  download.onclick=()=>{
    const record=currentResult();if(!record||typeof onDownload!=="function")return;
    try {onDownload({filename:`ftw-${record.receipt.query.countryCode.toLowerCase()}-${record.receipt.query.year}-fields.json`,
      blob:new Blob([JSON.stringify(record)],{type:"application/json"})});}
    catch {status.textContent="The query download could not be started. Try the download again.";}
  };
  root.dispose=()=>{if(disposed)return;disposed=true;invalidate();for(const control of controls)control.disabled=true;saved.input.disabled=true;status.textContent="Field search closed.";};
  return root;
}

function errorMessage(error) {
  if(error?.name==="AbortError")return "Field search cancelled. No result was added.";
  if(["ftw_limit","ftw_native_subset_required"].includes(error?.code))return "This selection exceeds the bounded field-query limits. Choose a smaller rectangle or use an explicitly prepared native subset; no partial result was accepted.";
  if(error?.code==="ftw_snapshot_changed")return "The published source changed during the query. No result was accepted. Start a new search to use one consistent source edition.";
  if(error?.code==="ftw_invalid")return "This country, year or source is unavailable in the supported field-query profile. Review the selection or use a prepared native subset.";
  if(error?.code==="ftw_import_limit")return "The saved query exceeds the supported file, geometry or time limit. Choose a query JSON of at most 2 MiB with fewer footprints. No partial result was opened.";
  if(error?.code==="ftw_import_invalid")return "The saved query is invalid or outside the supported field profile. Choose a downloaded field-query JSON with matching source, dates and footprint geometry. No result was opened.";
  if(error?.code==="ftw_import_unavailable")return "This browser cannot hash the saved file locally. Open it in a secure browser context before trying again.";
  return "Fields could not be retrieved. Review the country, year and rectangle, or use a prepared native subset. No result was accepted.";
}
function node(tag,value=""){const element=document.createElement(tag);element.textContent=value;return element;}
function button(title){const element=node("button",title);element.type="button";element.className="gis-button";return element;}
function input(title,type="text"){const label=node("label",title),element=node("input");element.type=type;element.required=true;if(type==="number")element.step="any";element.setAttribute("aria-label",title);label.append(element);return {label,input:element};}
function select(title,options){const label=node("label",title),element=node("select");element.required=true;element.setAttribute("aria-label",title);for(const [value,text] of options){const option=node("option",text);option.value=value;element.append(option);}label.append(element);return {label,input:element};}
function number(value){return Number.isFinite(value)?value.toLocaleString("en-US",{maximumFractionDigits:1}):"Not recorded";}
import {reviewFieldConfidence,fieldConfidenceCsv} from "../lib/fieldConfidence.js";
