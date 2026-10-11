import {explainPlaceMatch,placeMatchText} from "../lib/placeMatch.js";
export function CatalogPlaceMatch({adapter,datasetId,placeUri}) {
  const root=document.createElement('div'),details=document.createElement('div'),button=document.createElement('button');
  button.type='button';button.textContent='Why this place matched';details.setAttribute('role','status');
  let busy=false,loaded=false;
  button.addEventListener('click',async()=>{
    if(busy||loaded)return;busy=true;button.disabled=true;details.textContent='Loading current place evidence…';
    try {
      const record=await adapter.getDatasetKnowledge(datasetId);
      if(!root.isConnected)return;
      const match=explainPlaceMatch(record.document,placeUri);details.replaceChildren();
      append(`Metadata revision ${record.version}. Current knowledge may differ from the search result.`);
      if(!match)append('This place no longer matches the current metadata. Search again to update the results.');
      else {
        const text=placeMatchText(match);append(`${text.association}: ${text.tag}`);
        if(!match.path.length)append('Direct curated place association.');
        else {
          for(const step of text.steps)append(step);
          append(`Retained Wikidata context, retrieved ${match.snapshot.retrievedAt ?? 'date not recorded'}.`);
          append('Descriptive relationships from the saved context; not verified geographic containment.');
        }
      }
      loaded=true;
    }catch{if(root.isConnected)details.textContent='Place evidence unavailable. Check current access and retry.';}
    finally{busy=false;button.disabled=loaded;}
  });
  function append(value){const p=document.createElement('p');p.textContent=value;details.append(p);}
  root.append(button,details);return root;
}
