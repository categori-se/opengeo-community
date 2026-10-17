/** The numerical code loads only after Calculate. All input comes from the
 * already loaded raster window; this component has no transport or account API.
 */
export function RasterViewshed({getGrid,initialObserver=()=>[0,0],pickObserver=null,clearPick=()=>{},onDownload,onAdd=null}={}) {
  const root=document.createElement("details");root.className="gis-grid-viewshed";
  root.append(text("summary","Raster viewshed"),text("p","Choose a loaded elevation band and an observer. Visibility is evaluated at cell centres on a triangulated terrain surface."));
  const form=document.createElement("form"),source=text("p","");source.className="gis-viewshed-source";
  const band=select("Elevation band",[]),units=select("Interpret elevation units",[["","Choose units"],["metres","Metres"],["international-feet","International feet"],["us-survey-feet","US survey feet"]]);
  const origin=initialObserver(),longitude=number("Observer longitude",origin[0],-180,180),latitude=number("Observer latitude",origin[1],-90,90);
  const pick=button("Choose observer on map"),observerHeight=number("Observer height above ground (m)",1.75,0,1000),targetHeight=number("Target height above ground (m)",0,0,1000);
  const size=select("Analysis grid (maximum cells per side)",[["9","9"],["17","17"],["33","33"],["63","63"]]);size.input.value="17";
  const distance=number("Maximum visibility distance (m)",10000,1,100000),uncertainty=number("Elevation uncertainty ± (m, optional)","",0,1000,true);
  const confirm=check("Use this band as elevation"),curvature=check("Include world curvature");curvature.input.checked=true;
  const calculate=button("Calculate viewshed"),cancel=button("Cancel calculation");calculate.type="submit";cancel.disabled=true;
  const status=text("p","");status.role="status";
  form.append(band.label,units.label,confirm.label,longitude.label,latitude.label,...(pickObserver?[pick]:[]),observerHeight.label,targetHeight.label,
    size.label,distance.label,uncertainty.label,curvature.label,calculate,cancel);
  const output=document.createElement("section"),consent=check("I have reviewed the source terms for this derived output"),download=button("Download viewshed GeoJSON"),add=button("Add temporary result to map");
  download.disabled=add.disabled=true;
  let disposed=false,controller=null,result=null,gridUsed=null,knownGrid=null,library=null,generation=0,picking=false,added=false;
  const stopPick=()=>{clearPick();picking=false;pick.textContent="Choose observer on map";};
  const actions=()=>{download.disabled=disposed||!result||!gridUsed?.active()||!consent.input.checked||!onDownload;add.disabled=download.disabled||!onAdd||added;};
  const invalidate=()=>{generation++;controller?.abort();controller=null;result=null;gridUsed=null;added=false;output.replaceChildren();cancel.disabled=true;calculate.disabled=false;actions();};
  root.cancelPick=()=>{stopPick();};
  root.updateSource=()=>{
    if(disposed)return;
    const next=getGrid?.();
    if(knownGrid&&!knownGrid.active()){invalidate();knownGrid=null;confirm.input.checked=false;status.textContent="The raster window changed. Review its elevation band and units before calculating.";}
    if(!next){source.textContent="Load the raster window to analyse its cached cells.";calculate.disabled=true;return;}
    if(!knownGrid){knownGrid=next;const prior=band.input.value;band.input.replaceChildren(...next.metadata.bands.map(value=>option(String(value),`Band ${value}`)));if(next.metadata.bands.includes(Number(prior)))band.input.value=prior;calculate.disabled=false;}
    source.textContent=`${next.width} × ${next.height} loaded cells · ${next.metadata.imageIndex===0?"main grid":"overview grid"} · ${next.metadata.projection}`;
  };
  pick.onclick=()=>{
    if(disposed)return;
    if(picking){stopPick();status.textContent="Observer selection cancelled.";return;}
    if(!pickObserver)return;
    const accepted=pickObserver(location=>{stopPick();invalidate();longitude.input.value=location[0];latitude.input.value=location[1];status.textContent="Observer selected. Calculate when ready.";});
    if(accepted!==false){picking=true;pick.textContent="Cancel observer selection";status.textContent="Click the map to choose the observer.";}
  };
  form.addEventListener("input",()=>{stopPick();invalidate();});
  form.addEventListener("change",()=>{stopPick();invalidate();});
  cancel.onclick=()=>{invalidate();status.textContent="Viewshed calculation cancelled. The raster remains unchanged.";};
  consent.input.onchange=actions;
  form.onsubmit=async event=>{
    event.preventDefault();if(disposed||!form.reportValidity())return;
    if(!confirm.input.checked){status.textContent="Confirm that the selected band represents elevation.";return;}
    stopPick();invalidate();const current=++generation,request=new AbortController();controller=request;
    const grid=getGrid?.();calculate.disabled=true;cancel.disabled=false;status.textContent="Preparing the cached terrain grid…";
    try {
      library??=await import("../lib/gridViewshed.js");
      if(disposed||current!==generation)return;
      const computed=await library.computeGridViewshed({grid,observer:[longitude.input.valueAsNumber,latitude.input.valueAsNumber],band:Number(band.input.value),
        unit:units.input.value,elevationConfirmed:true,side:Number(size.input.value),maximumDistanceMeters:distance.input.valueAsNumber,
        observerHeightMeters:observerHeight.input.valueAsNumber,targetHeightMeters:targetHeight.input.valueAsNumber,
        uncertaintyMeters:uncertainty.input.value===""?null:uncertainty.input.valueAsNumber,curvature:curvature.input.checked,signal:request.signal,
        onProgress:progress=>{if(current===generation)status.textContent=`Processed ${progress.processed} of ${progress.total} cell centres.`;}});
      if(disposed||current!==generation||!grid.active())return;
      result=computed;gridUsed=grid;renderResult();actions();
      status.textContent=computed.status==="complete"?"Viewshed ready. No additional raster reads were made.":"Compute limit reached. Unprocessed cells remain marked in the partial result.";
    } catch(error) {
      if(disposed||current!==generation)return;
      status.textContent=({viewshed_observer_nodata:"The observer falls on missing elevation. Choose a valid cell.",viewshed_observer_outside_window:"The observer is outside the loaded window.",
        viewshed_grid_extent_limit:"This grid extends beyond the 100 km model limit. Choose a smaller grid or a finer raster window.",
        viewshed_source_changed:"The raster window changed. Calculate again from the current source.",viewshed_source_invalid:"Show and load the raster window before calculating.",
        viewshed_compute_limit:"The compute limit was reached before a result was available.",viewshed_grid_too_small:"A window with at least two rows and two columns is required."})[error.code]
        ??(error.name==="AbortError"?"Viewshed calculation cancelled.":"Viewshed unavailable. Review the selected band, units, location and heights.");
    } finally {if(current===generation){controller=null;cancel.disabled=true;calculate.disabled=false;}}
  };
  function renderResult() {
    const facts=document.createElement("dl");facts.className="gis-key-values";
    for(const [name,value] of Object.entries({Status:result.status,Visible:result.counts.visible,Occluded:result.counts.occluded,Grazing:result.counts.grazing,
      Unknown:result.counts.unknown,"Outside distance":result.counts["outside-distance"],"Not computed":result.counts["not-computed"],
      "Observer cell":`${result.observer.pixel.column}, ${result.observer.pixel.row}`,"Source terms":result.source.source.license??"Not recorded"}))facts.append(text("dt",name),text("dd",String(value)));
    const canvas=document.createElement("canvas");canvas.width=canvas.height=252;canvas.role="img";canvas.setAttribute("aria-label","Cell-centre viewshed preview; inspect a cell below for its record");
    const ink=canvas.getContext("2d"),width=result.input.width,height=result.input.height,codes={visible:3,occluded:1,grazing:2,observer:4};
    if(ink)for(const cell of result.cells){ink.fillStyle=result.legend[codes[cell.visibility]??0].color;ink.fillRect((cell.column-result.input.window[0])*252/width,(cell.row-result.input.window[1])*252/height,252/width+.5,252/height+.5);}
    const legend=document.createElement("ul");legend.className="gis-viewshed-legend";
    for(const row of result.legend){const item=text("li",`${row.code}: ${row.label}`);const swatch=text("span","");swatch.style.backgroundColor=row.color;swatch.setAttribute("aria-hidden","true");item.prepend(swatch);legend.append(item);}
    const inspect=document.createElement("form"),column=number("Inspect cached column",result.observer.pixel.column,result.input.window[0],result.input.window[2]-1),row=number("Inspect cached row",result.observer.pixel.row,result.input.window[1],result.input.window[3]-1),show=button("Inspect cell"),record=document.createElement("dl");
    show.type="submit";column.input.step=row.input.step="1";record.className="gis-key-values";
    const inspectCell=()=>{const cell=result.cells.find(c=>c.column===column.input.valueAsNumber&&c.row===row.input.valueAsNumber);if(!cell)return;record.replaceChildren();for(const [name,value] of Object.entries({Visibility:cell.visibility,Uncertainty:cell.uncertainty,"Distance (m)":cell.distanceMeters.toFixed(2),"Elevation (m)":cell.elevationMeters??"Missing",Location:cell.location.join(", ")}))record.append(text("dt",name),text("dd",String(value)));};
    inspect.append(column.label,row.label,show);inspect.onsubmit=event=>{event.preventDefault();if(inspect.reportValidity())inspectCell();};
    canvas.onclick=event=>{const bounds=canvas.getBoundingClientRect();column.input.value=result.input.window[0]+Math.min(width-1,Math.floor((event.clientX-bounds.left)/bounds.width*width));row.input.value=result.input.window[1]+Math.min(height-1,Math.floor((event.clientY-bounds.top)/bounds.height*height));inspectCell();};
    inspectCell();output.replaceChildren(facts,canvas,legend,inspect,record);
  }
  function exported(){if(!result||!gridUsed?.active())throw Error("viewshed_source_changed");return library.viewshedGeojson(result,gridUsed,{sourceTermsConfirmed:consent.input.checked});}
  download.onclick=()=>{if(disposed)return;try{onDownload?.(exported());}catch{status.textContent="The result could not be exported. Review the current source window and source terms.";}};
  add.onclick=()=>{if(disposed)return;try{const data=JSON.parse(exported());added=true;actions();onAdd?.(data);}catch{status.textContent="Review map Layers before adding this result again.";}};
  root.addEventListener("toggle",()=>{if(!root.open)stopPick();});
  root.dispose=()=>{disposed=true;stopPick();invalidate();knownGrid=null;calculate.disabled=true;};
  root.append(source,form,status,output,consent.label,download,...(onAdd?[add]:[]),text("p","Cells use the loaded grid and chosen elevation units. Source NoData remains unknown; display transparency does not remove terrain. Curvature uses a mean sphere without atmospheric refraction. Buildings and vegetation are excluded. Source elevation accuracy is undeclared; uncertainty is your assumption."));
  root.updateSource();return root;
}
function text(tag,value){const node=document.createElement(tag);node.textContent=value;return node;}
function button(label){const node=text("button",label);node.type="button";node.className="gis-button";return node;}
function number(name,value,min,max,optional=false){const label=text("label",name),input=document.createElement("input");input.type="number";input.step="any";input.min=String(min);input.max=String(max);input.required=!optional;input.value=value;input.setAttribute("aria-label",name);label.append(input);return {label,input};}
function option(value,label){const node=text("option",label);node.value=value;return node;}
function select(name,values){const label=text("label",name),input=document.createElement("select");input.required=true;input.setAttribute("aria-label",name);input.append(...values.map(([value,title])=>option(value,title)));label.append(input);return {label,input};}
function check(name){const label=document.createElement("label"),input=document.createElement("input");label.className="gis-viewshed-check";input.type="checkbox";label.append(input,document.createTextNode(" "+name));return {label,input};}
