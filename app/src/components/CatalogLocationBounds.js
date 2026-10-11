import {geojsonBounds} from "../lib/mapLayers.js";

// Deliberate authorized reads; selecting context never changes Geographic tag knowledge.
export function CatalogLocationBounds({adapter, getDraft, applyBounds}) {
  const root = document.createElement("fieldset");
  root.className = "catalog-location-bounds";
  const legend = text("legend", "Use a saved Geographic tag");
  const status = text("p", "Load Geographic tags to reuse their saved geographic bounds.");status.setAttribute("role", "status");
  const choice = document.createElement("select");choice.setAttribute("aria-label", "Geographic tag for catalog bounds");
  const placeholder = text("option", "Choose a Geographic tag");placeholder.value="";choice.append(placeholder);
  let offset=0,busy=false,done=false;
  const known=new Set();
  const load=button("Load Geographic tags",async()=>{
    if(busy||done)return;lock(true);
    try {
      const records=await adapter.listLocations({limit:50,offset});
      if(!root.isConnected)return;
      for(const record of records)if(!known.has(record.id)){
        known.add(record.id);const option=text("option",record.title);option.value=record.id;choice.append(option);
      }
      offset+=records.length;done=records.length<50||offset>=10000;
      load.textContent="Load more Geographic tags";
      status.textContent=known.size?"Choose a Geographic tag and use its saved bounds.":"No accessible Geographic tags found.";
    }catch{if(root.isConnected)status.textContent="Geographic tags could not load. Check access and retry.";}
    finally{lock(false);}
  });
  const use=button("Use Geographic tag bounds",async()=>{
    if(busy||!choice.value)return;
    const id=choice.value,draft=getDraft();lock(true);
    try {
      const record=await adapter.getLocation(id);
      if(!root.isConnected)return;
      if(getDraft()!==draft){status.textContent="Search bounds changed while loading. Select the Geographic tag again to replace them.";return;}
      const geometry=record.document.geometry;
      const bounds=geometry?geojsonBounds(geometry):null;
      if(!bounds){status.textContent="This Geographic tag has no recorded geometry. Your search bounds are unchanged.";return;}
      if(!applyBounds(bounds.flat())){status.textContent="Switch to accessible Resources to use Geographic tag bounds.";return;}
      status.textContent=`Using ${record.document.title}, saved revision ${record.revision}. Search to apply its enclosing rectangle; no distance buffer is added.`;
    }catch{if(root.isConnected)status.textContent="Geographic tag unavailable. Check access and retry; your search bounds are unchanged.";}
    finally{lock(false);}
  });
  function lock(value){busy=value;load.disabled=value||done;choice.disabled=value;use.disabled=value||!choice.value;}
  choice.addEventListener("change",()=>lock(false));
  root.append(legend,load,choice,use,status);lock(false);return root;
}
function text(tag,value){const node=document.createElement(tag);node.textContent=value;return node;}
function button(label,action){const node=text("button",label);node.type="button";node.addEventListener("click",action);return node;}
