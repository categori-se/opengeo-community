import {createPolygon3DMeasurement,polygon3DGeojson,polygon3DPreview} from "../lib/polygon3dMeasurement.js";

/** Edits one explicit face. XYZ comes from the user; opening, previewing and
 * saving this form never queries terrain or a provider. */
export function Polygon3DMeasurementEditor({measurement=null,polygon=null,spatialBody,onSave,onDownload,onClose=()=>{}}={}) {
  const dialog=document.createElement("dialog");dialog.className="browser-print-studio gis-polygon3d-editor";
  const measurementId=measurement?.id??`measurement-${crypto.randomUUID()}`;
  dialog.setAttribute("aria-label",measurement?"Edit 3D polygon":"New 3D polygon");
  const heading=text("h2",measurement?"Edit 3D polygon":"New 3D polygon"),close=button("Cancel"),form=document.createElement("form");
  const title=field("Measurement title",measurement?.title??(polygon?`${polygon.title} 3D face`:"3D polygon")),label=field("Elevation source",measurement?.source.label??"User-entered vertex elevations"),datum=field("Vertical datum",measurement?.source.verticalDatum??"Unknown");
  title.input.maxLength=label.input.maxLength=200;datum.input.maxLength=120;
  const units=document.createElement("select");units.setAttribute("aria-label","Elevation input units");
  const factors={metres:1,"international-feet":.3048,"us-survey-feet":1200/3937};
  for(const [key,name] of [["metres","Metres"],["international-feet","International feet"],["us-survey-feet","US survey feet"]]){const option=text("option",name);option.value=key;units.append(option);}
  const unitsLabel=text("label","Elevation input units");unitsLabel.append(units);
  const uncertainty=field("Elevation uncertainty ± (m, optional)",measurement?.uncertaintyMeters??"","number");uncertainty.input.required=false;uncertainty.input.min="0";uncertainty.input.max="1000";
  const table=document.createElement("table"),head=document.createElement("thead"),body=document.createElement("tbody"),row=document.createElement("tr");
  for(const name of ["Longitude","Latitude","Elevation","Vertex"])row.append(text("th",name));head.append(row);table.append(head,body);
  let rows=[],disposed=false,generation=0,result=null,inputUnit="metres";
  const add=button("Add vertex"),preview=button("Preview measurement"),save=button("Save measurement"),download=button("Download 3D GeoJSON");save.type="submit";download.disabled=true;
  const output=document.createElement("section"),status=text("p","");status.role="status";
  const invalidate=()=>{generation++;result=null;output.replaceChildren();download.disabled=true;preview.disabled=save.disabled=false;};
  function renderRows() {
    body.replaceChildren();rows.forEach((item,index)=>{const tr=document.createElement("tr");
      item.forEach((input,k)=>{input.setAttribute("aria-label",`Vertex ${index+1} ${["longitude","latitude","elevation"][k]}`);const td=document.createElement("td");td.dataset.field=`Vertex ${index+1} · ${["Longitude","Latitude","Elevation"][k]}`;td.append(input);tr.append(td);});
      const remove=button(`Remove vertex ${index+1}`);remove.textContent="Remove";remove.setAttribute("aria-label",`Remove vertex ${index+1}`);remove.disabled=rows.length<=3;
      remove.onclick=()=>{rows.splice(index,1);invalidate();renderRows();};const cell=document.createElement("td");cell.append(remove);tr.append(cell);body.append(tr);
    });add.disabled=rows.length>=128;
  }
  function appendVertex(values=[]) {
    if(rows.length>=128)return;
    rows.push(values.length===0?[0,1,2].map(k=>numeric(k,undefined)):values.map((v,k)=>numeric(k,v)));
  }
  function numeric(k,value){const input=document.createElement("input");input.type="number";input.required=true;input.step="any";
    input.min=String([-180,-85.05112878,-100000/factors[units.value]][k]);input.max=String([180,85.05112878,100000/factors[units.value]][k]);if(value!==undefined)input.value=value;return input;}
  for(const c of measurement?.coordinates??polygon?.coordinates??[[],[],[]])appendVertex(c.length?[c[0],c[1],c[2]]:[]);
  renderRows();add.onclick=()=>{appendVertex();invalidate();renderRows();rows.at(-1)[0].focus();};
  units.onchange=()=>{const factor=factors[inputUnit]/factors[units.value];for(const item of rows){const value=item[2].valueAsNumber;if(Number.isFinite(value))item[2].value=String(value*factor);item[2].min=String(-100000/factors[units.value]);item[2].max=String(100000/factors[units.value]);}inputUnit=units.value;invalidate();};
  form.addEventListener("input",invalidate);form.addEventListener("change",invalidate);
  function values(){return {id:measurementId,title:title.input.value.trim(),spatialBody,
    coordinates:rows.map(item=>[item[0].valueAsNumber,item[1].valueAsNumber,item[2].valueAsNumber*factors[units.value]]),
    uncertaintyMeters:uncertainty.input.value===""?null:uncertainty.input.valueAsNumber,
    source:{kind:"user-supplied-vertices",label:label.input.value.trim(),verticalDatum:datum.input.value.trim(),geometryMeasurementId:measurement?.source.geometryMeasurementId??polygon?.id??null}};}
  async function calculate(commit) {
    if(disposed||!form.reportValidity())return;const current=++generation,input=values();save.disabled=preview.disabled=true;download.disabled=true;status.textContent="Calculating the recorded face…";
    try {
      const computed=await createPolygon3DMeasurement(input);if(disposed||current!==generation)return;
      result=computed;renderPreview();download.disabled=!onDownload;status.textContent="3D polygon ready. Elevations and datum are recorded as supplied.";
      if(commit){await onSave?.(computed);if(!disposed&&current===generation)finish();}
    } catch(error) {if(disposed||current!==generation)return;status.textContent=({polygon3d_projection_invalid:"The face needs a simple, non-overlapping projection. Reorder its vertices or separate folded faces.",
      polygon3d_topology_invalid:"These vertices could not form a complete face. Reorder them or remove redundant vertices.",polygon3d_extent_limit:"Keep every vertex within 100 km of the first vertex.",
      polygon3d_duplicate_vertex:"Remove duplicate 3D vertices. Vertices may share a map position when their elevations differ.",polygon3d_source_invalid:"Record an elevation source and vertical datum."})[error.code]??"The measurement could not be saved. Review its coordinates, source and input limits.";
    } finally {if(current===generation&&!disposed)save.disabled=preview.disabled=false;}
  }
  function renderPreview() {
    const facts=document.createElement("dl");for(const [name,value] of Object.entries({"3D perimeter (m)":result.summary.perimeterMeters,"Face area (m²)":result.summary.areaSquareMeters,"Horizontal width (m)":result.summary.widthMeters,"Elevation range (m)":result.summary.heightMeters,"Maximum face-plane departure (m)":result.model.maximumPlaneDeviationMeters}))facts.append(text("dt",name),text("dd",String(value)));
    if(result.bounds)for(const [name,value] of Object.entries(result.bounds))facts.append(text("dt",`Bound · ${name}`),text("dd",value.join(" to ")));
    const view=polygon3DPreview(result),ns="http://www.w3.org/2000/svg",svg=document.createElementNS(ns,"svg");svg.setAttribute("viewBox","0 0 320 220");svg.setAttribute("role","img");svg.setAttribute("aria-label","3D face projected onto its dominant plane; elevation vertices and recorded triangulation");
    const xs=view.points.map(p=>p[0]),ys=view.points.map(p=>p[1]),xmin=Math.min(...xs),ymin=Math.min(...ys),dx=Math.max(...xs)-xmin,dy=Math.max(...ys)-ymin,scale=Math.min(280/Math.max(dx,1e-6),180/Math.max(dy,1e-6));
    const points=view.points.map(([x,y])=>[20+(x-xmin)*scale,200-(y-ymin)*scale]);
    for(const t of view.triangles){const triangle=document.createElementNS(ns,"polygon");triangle.setAttribute("points",t.map(i=>points[i].join(",")).join(" "));svg.append(triangle);}
    points.forEach(([x,y],i)=>{const node=document.createElementNS(ns,"text");node.setAttribute("x",x);node.setAttribute("y",y-3);node.textContent=String(i+1);svg.append(node);});
    output.replaceChildren(facts,svg,text("p",`Face projection: ${["north/up","east/up","east/north"][view.axis]}. Area uses planar triangles between the supplied 3D vertices. Horizontal width is the greatest ground distance between vertices; height is the elevation range.`));
  }
  preview.onclick=()=>void calculate(false);form.onsubmit=event=>{event.preventDefault();void calculate(true);};
  download.onclick=()=>{if(!disposed&&result)onDownload?.(polygon3DGeojson(result));};
  function finish(){if(disposed)return;disposed=true;generation++;dialog.close?.();dialog.remove();onClose();}
  close.onclick=finish;dialog.addEventListener("cancel",event=>{event.preventDefault();finish();});dialog.dispose=finish;
  form.append(title.label,label.label,datum.label,unitsLabel,uncertainty.label,table,add,preview,save,download,status,output);
  dialog.append(heading,text("p","Enter the boundary vertices in order, including each elevation. Vertical walls may use the same longitude and latitude at different heights. Known ground polygons can supply the starting boundary."),close,form,
    text("p","Coordinates and input elevations are interpreted using the selected world's mean sphere. This measures the recorded face, without sampling intervening terrain or buildings. Optional uncertainty bounds apply only to radial elevations; source accuracy and horizontal uncertainty are undeclared."));
  return dialog;
}
function text(tag,value){const node=document.createElement(tag);node.textContent=value;return node;}
function button(label){const node=text("button",label);node.type="button";return node;}
function field(name,value,type="text"){const label=text("label",name),input=document.createElement("input");input.type=type;input.required=true;input.step="any";input.value=value;input.setAttribute("aria-label",name);label.append(input);return {label,input};}
