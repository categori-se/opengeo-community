import {declaredCoordinateLayouts, coordinateLayoutNotice} from "../lib/coordinateLayout.js";
import {knowledgeChanges} from "../lib/knowledgeChanges.js";

/** Inspection of authorized retained versions; never promotes a current pointer. */
export function DatasetVersionComparison({versions}) {
  const root=el("section");root.setAttribute("aria-label","Compare data versions");
  root.append(el("h3","Compare data versions"),el("p","Compare recorded counts, geometry, CRS and schema. This does not verify provider completeness or replace the current Layer version."));
  if(versions.length<2){root.append(el("p","At least two accessible data versions are needed for comparison."));return root;}
  const choices=label=>{
    const select=el("select");select.setAttribute("aria-label",label);
    const blank=el("option","Choose a version");blank.value="";select.append(blank);
    for(const version of versions){const item=el("option",`Version ${version.versionNumber} · ${version.state}${version.current?" · current":""}`);item.value=version.id;select.append(item);}
    const wrapper=el("label",label);wrapper.append(select);root.append(wrapper);return select;
  };
  const before=choices("Earlier data version"),after=choices("Comparison data version"),result=el("div");
  function render(){
    result.replaceChildren();
    const left=versions.find(v=>v.id===before.value),right=versions.find(v=>v.id===after.value);
    if(!left||!right)return;
    if(left.id===right.id){result.append(el("p","Choose two different versions."));return;}
    result.append(el("p",`Comparing version ${left.versionNumber} to version ${right.versionNumber}.`));
    if(left.state!=="active"||right.state!=="active")result.append(el("p","One or both versions are not active; inspection may be incomplete."));
    const table=el("table"),head=el("tr");
    for(const title of ["Recorded property","Earlier","Comparison"])head.append(el("th",title));table.append(head);
    for(const [key,title] of [["featureCount","Feature count"],["geometryType","Geometry type"],["crs","CRS"]]){
      const row=el("tr");row.append(el("th",title),el("td",left[key]??"Unknown"),el("td",right[key]??"Unknown"));table.append(row);
    }
    const layoutRow=el("tr");layoutRow.append(el("th","Declared coordinate layout"),el("td",declaredCoordinateLayouts(left.schemaDefinition)??"Unknown"),el("td",declaredCoordinateLayouts(right.schemaDefinition)??"Unknown"));table.append(layoutRow);
    result.append(table,el("p",coordinateLayoutNotice(left.schemaDefinition,right.schemaDefinition)));
    if(left.featureCount>0&&right.featureCount===0)result.append(el("p","The comparison version is empty; the earlier version contains features."));
    const changes=knowledgeChanges(left.schemaDefinition,right.schemaDefinition);
    result.append(el("p",changes.length?`${changes.length} recorded schema differences. Paths use array positions; reordered fields may appear changed.`:"Recorded schemas match. This does not establish identical data or provider completeness."));
    // Bound rendered disclosures even when an imported schema is large.
    for(const change of changes.slice(0,100)){
      const details=el("details");details.append(el("summary",`${change.kind}: ${change.path}`),el("pre",JSON.stringify(change,null,2)));result.append(details);
    }
    if(changes.length>100)result.append(el("p","Showing the first 100 schema differences. Full schemas remain available in each version below."));
  }
  before.addEventListener("change",render);after.addEventListener("change",render);root.append(result);return root;
}
function el(tag,text=""){const node=document.createElement(tag);node.textContent=text;return node;}
