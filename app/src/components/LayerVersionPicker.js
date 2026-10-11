import {layerFieldCompatibility} from "../lib/layerFieldDependencies.js";
export function LayerVersionPicker({adapter,layer,renderedParts=()=>[],onApply}) {
  const root=el("section"),status=el("p"),choices=el("select"),review=el("div");
  root.setAttribute("aria-label","Update Project Layer version");status.setAttribute("role","status");
  choices.setAttribute("aria-label","Project Layer data version");
  let versions=[],busy=false,selected=null;
  const inspect=button("Find data versions",async()=>{
    const dataset=await adapter.getCatalogDataset(layer.datasetId);
    if(dataset.id!==layer.datasetId)throw Error("Layer identity changed.");
    versions=await adapter.listDatasetVersions(dataset.projectId,layer.datasetId,{limit:100});
    choices.replaceChildren(el("option","Choose a version"));choices.firstChild.value="";
    for(const version of versions.filter(v=>v.state==="active")){
      const option=el("option",`Version ${version.versionNumber}${version.id===layer.datasetVersionId?" · used here":""}${version.current?" · current Layer":""}`);
      option.value=version.id;choices.append(option);
    }
    selected=null;review.replaceChildren();
    status.textContent="Select an exact version to review. Listing versions does not fetch provider data.";
  });
  const check=()=> {
    selected=versions.find(v=>v.id===choices.value);review.replaceChildren();
    if(!selected)return;
    const result=compatibility(selected);
    review.append(el("p",`Project uses version ${layer.sourceVersion}; selected version ${selected.versionNumber}.`));
    for(const issue of result.issues)review.append(el("p",issue));
    if(!result.compatible){review.append(el("p","The Project pin is unchanged. Adjust the Style, labels or filters, then review again."));return;}
    review.append(el("p","Recorded field dependencies are available. Matching names do not establish identical meanings or data."));
    review.append(button("Apply version to Project draft",async()=>{
      const candidate=selected;
      if(!candidate||candidate.id!==choices.value||!compatibility(candidate).compatible)throw Error("Dependencies changed. Review again.");
      await onApply(candidate,()=>selected===candidate && choices.value===candidate.id && compatibility(candidate).compatible);
      review.replaceChildren();selected=null;
      status.textContent="Layer version applied to this draft. Save the Project to retain it; Publications keep their existing artifacts.";
    }));
  };
  choices.onchange=check;
  root.append(el("h3","Project Layer version"),el("p","Inspect a saved data version before changing this Project's pin. The catalog Layer's current version and published artifacts are unchanged."),inspect,choices,
    button("Review version dependencies",async()=>check()),button("Cancel version selection",async()=>{choices.value="";selected=null;review.replaceChildren();status.textContent="Selection cancelled. The Project pin is unchanged.";}),review,status);
  function compatibility(version) {
    const result=layerFieldCompatibility(layer,version.schemaDefinition,renderedParts());
    if(version.geometryType!==layer.geometryType)result.issues.push("Geometry type differs; add this version as a separate Layer to configure its presentation.");
    if(version.id===layer.datasetVersionId)result.issues.push("This Project already uses the selected version.");
    result.compatible=!result.issues.length;return result;
  }
  function button(title,action){
    const node=el("button",title);node.type="button";node.className="platform-button secondary";
    node.onclick=async()=>{if(busy)return;busy=true;node.disabled=true;
      try{await action();}catch(error){status.textContent=[403,404].includes(error?.status)?"Version unavailable. Check access; the Project pin is unchanged.":error?.message||"Version could not load; the Project pin is unchanged.";}
      finally{busy=false;node.disabled=false;}
    };return node;
  }
  return root;
}
function el(tag,text=""){const node=document.createElement(tag);node.textContent=text;return node;}
