/** A reviewed discovery proposes configuration; only an explicit save creates a revision. */
export function WfsConnectionRevision({adapter, datasetId, projectId, job, sourceRevision, run}) {
  const root=el("section"),content=el("div"),status=el("p");
  status.setAttribute("role","status");
  root.append(button("Review WFS connection changes",()=>run(async()=>{
    const source=await adapter.getSource(projectId,datasetId);
    const proposal=job.result?.sourceDefinition;
    if(source.datasetId!==datasetId || source.projectId!==projectId || source.sourceType!=="wfs"
      || source.versionNumber!==sourceRevision || proposal?.type!=="wfs"
      || source.sourceUrl!==proposal.url || source.configuration.typeName!==proposal.type_name
      || proposal.type_name!==job.collectionRef) throw Object.assign(Error("Source changed"),{status:409});
    const available=proposal.available_fields;
    if(!Array.isArray(available) || !available.length || available.some(v=>typeof v!=="string")) throw Error("Reviewed fields unavailable");
    content.replaceChildren();
    const previous=source.configuration;
    content.append(el("h4","Review WFS connection revision"),
      el("p",`Based on source revision ${sourceRevision}. Available fields: ${available.join(", ")}.`),
      el("p","Saved Projects keep their pinned source configuration. Removed fields may be used by Styles, filters or labels; those dependencies are not checked here. Existing captures and published outputs remain unchanged. This action does not request provider data."));
    const fields=input(content,"Selected WFS fields",previous.fields.filter(v=>available.includes(v)).join(", "));
    const sort=input(content,"Confirmed WFS sort field",available.includes(previous.sortBy)?previous.sortBy:"");
    const definition=()=>({...previous,type:"wfs",url:source.sourceUrl,geometryName:proposal.geometry_name,
      geometryType:proposal.geometry_type,fields:fields.value.split(",").map(v=>v.trim()).filter(Boolean),sortBy:sort.value.trim()});
    const removed=previous.fields.filter(v=>!available.includes(v));
    if(removed.length)content.append(el("p",`Previously selected fields absent from this discovery: ${removed.join(", ")}.`));
    const preview=el("pre");
    const render=()=>{preview.textContent=JSON.stringify({earlier:{...previous,url:source.sourceUrl},proposed:definition()},null,2);};
    const confirmed=el("input");confirmed.type="checkbox";
    const label=el("label","I reviewed these fields and confirm the selected sort field provides stable ordering. ");label.append(confirmed);
    const save=button("Save WFS connection revision",()=>run(async()=>{
      const next=definition();
      if(!confirmed.checked || !next.fields.length || next.fields.length>64
        || new Set(next.fields).size!==next.fields.length
        || next.fields.some(v=>!available.includes(v)) || !next.fields.includes(next.sortBy)) {
        status.textContent="Choose up to 64 distinct available fields, include the sort field, and confirm stable ordering.";return;
      }
      const updated=await adapter.updateSource(projectId,datasetId,{expectedVersion:sourceRevision,source:next,
        changeMessage:`Reviewed WFS discovery ${job.jobId}`});
      if(updated.datasetId!==datasetId || updated.projectId!==projectId || updated.versionNumber!==sourceRevision+1) throw Error("Saved source identity changed");
      content.replaceChildren(el("p",`Saved source revision ${updated.versionNumber}. Reload the Layer to inspect it. A data capture or Project update requires a separate action.`));
      status.textContent="Connection revision saved.";
      open.disabled=true;
    }));
    for(const field of [fields,sort])field.addEventListener("input",()=>{confirmed.checked=false;render();});
    render();content.append(preview,label,save);
    status.textContent="Review the proposed configuration before saving.";
  })),content,status);
  const open=root.querySelector("button");
  return root;
}
function el(tag,text=""){const node=document.createElement(tag);node.textContent=text;return node;}
function input(root,title,value){const label=el("label",title),node=el("input");node.value=value;node.setAttribute("aria-label",title);label.append(node);root.append(label);return node;}
function button(title,action){const node=el("button",title);node.type="button";node.className="platform-button secondary";node.onclick=action;return node;}
