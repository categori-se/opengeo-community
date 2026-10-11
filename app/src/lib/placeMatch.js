import {PLACE_CONTEXT_METHOD, PLACE_LABEL} from "./geographicReferences.js";
const DC="http://purl.org/dc/terms/", WD="http://www.wikidata.org/entity/";
const properties={"http://www.wikidata.org/prop/direct/P17":"country","http://www.wikidata.org/prop/direct/P30":"continent","http://www.wikidata.org/prop/direct/P131":"administrative parent"};
const canonical=/^(http:\/\/www.wikidata.org\/entity\/Q[1-9][0-9]{0,15}|https:\/\/sws.geonames.org\/[1-9][0-9]*\/)$/;
// Match migration 0121: current curated associations, latest valid snapshot, three hops.
export function explainPlaceMatch(document, requested) {
  const active=(document.metadata?.curated??[]).filter(c=>c.subject==='resource' && c.provenance==='curator_asserted' &&
    [DC+'spatial',DC+'subject'].includes(c.property) && canonical.test(c.value?.['@id']??''));
  for(const tag of active) if(tag.value['@id']===requested) return {tag,path:[],snapshot:null};
  const latest=new Map();
  for(const claim of document.metadata?.normalized??[]) {
    const root=claim.value?.['@id'],snapshot=claim.value?.['http://www.w3.org/1999/02/22-rdf-syntax-ns#value'];
    if(claim.subject==='resource' && claim.property===DC+'relation' && claim.method===PLACE_CONTEXT_METHOD &&
       snapshot?.provider==='Wikidata' && WD+snapshot.item===root && Array.isArray(snapshot.relationships)) latest.set(root,snapshot);
  }
  for(const tag of active) {
    const root=tag.value['@id'],snapshot=latest.get(root);if(!snapshot)continue;
    const reached=new Set([root]);let frontier=[{uri:root,path:[]}];
    for(let depth=0;depth<3 && frontier.length;depth++) {
      const next=[];
      for(const edge of snapshot.relationships) {
        if(!edge || !Object.hasOwn(properties,edge.property) || !['normal','preferred'].includes(edge.rank) ||
          !/^http:\/\/www.wikidata.org\/entity\/Q[1-9][0-9]{0,15}$/.test(edge.object??'') || reached.has(edge.object))continue;
        const parent=frontier.find(item=>item.uri===edge.subject);if(!parent)continue;
        reached.add(edge.object);const path=[...parent.path,edge];
        if(edge.object===requested)return {tag,path,snapshot};
        next.push({uri:edge.object,path});
      }
      frontier=next;
    }
  }
  return null;
}
export function placeMatchText(match) {
  const root=match.tag.value['@id'];
  const label=uri=>match.snapshot?.entities?.[uri.split('/').at(-1)]?.labels?.en?.value ?? (uri===root ? match.tag.value[PLACE_LABEL]??uri : uri);
  const association=match.tag.property===DC+'spatial'?'Geographic coverage':'Discusses this place';
  return {association,tag:`${label(root)} (${root})`,steps:match.path.map(edge=>`${label(edge.subject)} → ${properties[edge.property]} → ${label(edge.object)}`)};
}
