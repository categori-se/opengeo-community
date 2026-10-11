import {appendPlaceContext, placeReferences, recordedPlaceContexts} from "../lib/geographicReferences.js";

export function PlaceContext({readDraft, writeDraft, resolve, setBusy, onChange, onError}) {
  const root=el("section"), preview=el("div"), choice=el("select");
  choice.setAttribute("aria-label","Wikidata place for context");
  let snapshot=null,busy=false,item=null;
  root.append(el("h3","Sourced place context"),el("p","Choose an added Wikidata place and resolve its country, continent and administrative relationships. Lookup contacts Wikidata when no cached result is available. Retain the result, then save a metadata revision."));
  function choices() {
    try {
      const previous=choice.value, ids=new Set();choice.replaceChildren();
      for(const ref of placeReferences(readDraft())) {
        const match=/^http:\/\/www.wikidata.org\/entity\/(Q[1-9][0-9]{0,15})$/.exec(ref.identity??"");
        if(!match||ids.has(match[1]))continue;ids.add(match[1]);
        const option=el("option",`${ref.name} (${match[1]})`);option.value=match[1];choice.append(option);
      }
      if(ids.has(previous))choice.value=previous;
    }catch {onError("Correct the metadata JSON before choosing a place.");}
  }
  choice.addEventListener("focus",choices);
  const lookup=button("Resolve Wikidata context",async()=>{
    if(busy)return;choices();if(!choice.value){onError("Add a Wikidata place to the geographic-tag draft first.");return;}
    const selected=choice.value;let original;
    try{original=JSON.stringify(readDraft());}catch{onError("Correct the metadata draft first.");return;}
    busy=true;setBusy(true);preview.replaceChildren(el("p","Resolving place context…"));snapshot=null;
    try {
      const result=await resolve(selected);
      if(JSON.stringify(readDraft())!==original)throw Error("The metadata draft changed. Resolve the place again before retaining context.");
      // Validate association before offering retention; never change a tag's identity.
      appendPlaceContext(readDraft(),result,selected);
      snapshot=result;item=selected;preview.replaceChildren(PlaceContextSummary(result));
    }catch(error){preview.replaceChildren();onError(error.message || "Place context unavailable. Your metadata draft is unchanged.");}
    finally{busy=false;setBusy(false);}
  });
  root.append(choice,lookup,preview,button("Retain place context in draft",()=>{
    if(busy||!snapshot){onError("Resolve a place before retaining its context.");return;}
    try {
      const draft=appendPlaceContext(readDraft(),snapshot,item);
      if(new TextEncoder().encode(JSON.stringify(draft)).length>49152)throw Error("The metadata record exceeds 48 KiB. No context was truncated or added.");
      writeDraft(draft);onChange();snapshot=null;preview.replaceChildren(el("p","Place context retained in the draft. Save a metadata revision to keep it."));
    }catch(error){onError(error.message);}
  }));choices();return root;
}
export function PlaceContextSummary(snapshot) {
  const root=el("section");
  root.append(el("h4",`Wikidata context for ${snapshot.item}`),el("p",`Retrieved ${snapshot.retrievedAt}. Selected provider statements; original response bytes are not retained.`));
  const labels={P17:"country",P30:"continent",P131:"administrative parent"};
  const name=uri=>{const id=uri?.split("/").at(-1);return snapshot.entities?.[id]?.labels?.en?.value ?? id ?? "Unknown";};
  for(const edge of snapshot.relationships??[])root.append(el("p",`${name(edge.subject)} → ${labels[edge.property?.split("/").at(-1)] ?? edge.property} → ${name(edge.object)}`));
  root.append(el("p",snapshot.unresolved?.length?`Unresolved within lookup limits: ${snapshot.unresolved.join(", ")}`:"No unresolved entities in this bounded lookup."));
  return root;
}
export function SavedPlaceContexts(document) {
  const root=el("section");
  for(const snapshot of recordedPlaceContexts(document))root.append(PlaceContextSummary(snapshot));
  return root;
}
function el(tag,text=""){const node=document.createElement(tag);node.textContent=text;return node;}
function button(label,action){const node=el("button",label);node.type="button";node.addEventListener("click",action);return node;}
