import {compareWfsSchemas} from "../lib/wfsSchemaComparison.js";
/** Compare preserved text only. Never infer that document identities or terms match. */
export function ProviderResponseComparison({sources=[],text,sourceType,collectionRef}) {
  const root=el("section");root.setAttribute("aria-label","Compare provider responses");
  root.append(el("h4","Compare with retained source text"),el("p","Choose an earlier document explicitly. A shared provider URL does not establish the same collection, scope or rights. Comparison uses exact text; it does not interpret licenses or normalize metadata."));
  if(!sources.length) {root.append(el("p","No earlier source text is retained in this metadata record."));return root;}
  const label=el("label","Earlier source document"),select=el("select"),result=el("div");
  select.setAttribute("aria-label","Earlier source document");
  const blank=el("option","Choose a retained document");blank.value="";select.append(blank);
  sources.forEach((source,index)=>{const option=el("option",`${source.sourceUrl} · ${source.retrievedAt} · ${source.id}`);option.value=String(index);select.append(option);});
  select.addEventListener("change",()=>{
    result.replaceChildren();
    if(select.value==="") return;
    const source=sources[Number(select.value)];
    if(!source || typeof source.content!=="string") return;
    let first=0;
    while(first<source.content.length && first<text.length && source.content[first]===text[first]) first++;
    const equal=source.content===text;
    result.append(el("p",equal?"Exact source text is unchanged. Retrieval time and document identity may still differ.":`Source text differs, beginning at line ${source.content.slice(0,first).split("\n").length}. Whitespace and line endings are included.`));
    if(sourceType==="wfs") {
      const comparison=compareWfsSchemas(source.content,text,collectionRef,document.defaultView?.DOMParser);
      const summary=el("section");summary.setAttribute("aria-label","WFS field changes");
      summary.append(el("h4","WFS field changes"));
      if(!comparison.available) summary.append(el("p","A field summary is unavailable for these documents. Review the exact text; imported types, complex groups or different collection namespaces may need separate inspection."));
      else {
        summary.append(el("p",comparison.changes.length
          ? `${comparison.changes.length} declared field changes for ${collectionRef}.`
          : "Selected field declarations match. This does not establish identical schemas, data or provider behavior."));
        summary.append(el("p","This summary covers local field types, cardinality and nillability. It does not resolve imported type definitions or establish feature identity, rights or compatibility. Accepting metadata does not change the registered field selection or saved Projects."));
        for(const change of comparison.changes) {
          const details=el("details");details.append(el("summary",`${change.kind}: ${change.name}`),el("pre",JSON.stringify({before:change.before,after:change.after},null,2)));summary.append(details);
        }
      }
      result.append(summary);
    }
    for(const [title,value] of [["Earlier retained text",source.content],["Reviewed provider response",text]]) {
      const details=el("details"),pre=el("pre",value);pre.tabIndex=0;
      details.append(el("summary",title),pre);result.append(details);
    }
  });
  label.append(select);root.append(label,result);return root;
}
function el(tag,text=""){const node=document.createElement(tag);node.textContent=text;return node;}
