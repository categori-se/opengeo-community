const DC = "http://purl.org/dc/terms/";
export const PLACE_LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
export const PLACE_METHOD = "User-supplied place reference; identity and membership not verified";
export const PLACE_RELATIONS = [["Geographic coverage", `${DC}spatial`], ["Discusses this place", `${DC}subject`]];

export function placeIdentity(raw) {
  const text = raw.trim();
  if (!text) return null;
  let url;
  try {url = new URL(text);} catch {throw Error("Enter a GeoNames or Wikidata place URL, or leave it blank for an unresolved name.");}
  if (url.username || url.password || url.search || url.hash || !["http:","https:"].includes(url.protocol) || url.port) throw Error("Use a place URL without credentials, query parameters or fragments.");
  let match;
  if (url.hostname === "www.wikidata.org" && (match = /^\/(?:wiki|entity)\/(Q[1-9][0-9]*)\/?$/.exec(url.pathname))) return `http://www.wikidata.org/entity/${match[1]}`;
  if (url.hostname === "sws.geonames.org" && (match = /^\/([1-9][0-9]*)\/$/.exec(url.pathname))) return `https://sws.geonames.org/${match[1]}/`;
  throw Error("Use a Wikidata item URL or a GeoNames place URI such as https://sws.geonames.org/12345/.");
}
export function appendPlaceReference(document, {name, identity, relationship}) {
  const label = name.trim(), uri = placeIdentity(identity);
  if (!label || label.length > 200) throw Error("Enter a place name of up to 200 characters.");
  if (!PLACE_RELATIONS.some(([,term])=>term===relationship)) throw Error("Choose how this place relates to the resource.");
  const draft = structuredClone(document), claims = draft.metadata.curated;
  if (claims.length >= 64) throw Error("The curated assertion limit has been reached.");
  if (claims.some(c=>c.subject === "resource" && c.property === relationship && (uri ? c.value?.["@id"] === uri : c.method === PLACE_METHOD && !c.value?.["@id"] && c.value?.[PLACE_LABEL] === label))) throw Error("This place relationship is already recorded.");
  claims.push({subject:"resource", property:relationship, value:{...(uri ? {"@id":uri} : {}), [PLACE_LABEL]:label},
    provenance:"curator_asserted", method:PLACE_METHOD, timestamp:new Date().toISOString()});
  return draft;
}
export function placeReferences(document) {
  return ["normalized","curated","inferred"].flatMap(level=>document.metadata[level].flatMap((claim,index)=>{
    if (claim.subject !== "resource" || !PLACE_RELATIONS.some(([,term])=>term===claim.property) || !claim.value || typeof claim.value !== "object" || typeof claim.value[PLACE_LABEL] !== "string") return [];
    let identity = null;
    try {identity = placeIdentity(claim.value["@id"] ?? "");} catch { /* Preserve unrecognized identities in the metadata view. */ }
    return [{level,index,name:claim.value[PLACE_LABEL],identity,relationship:PLACE_RELATIONS.find(([,term])=>term===claim.property)[0],
      removable:level === "curated" && claim.method === PLACE_METHOD, provenance:claim.provenance}];
  }));
}

export const PLACE_CONTEXT_METHOD = "Wikidata P17/P30/P131 projection v1";
const RDF_VALUE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#value";
export function recordedPlaceContexts(document) {
  return document.metadata.normalized.filter(claim=>claim.subject === "resource" &&
    claim.property === `${DC}relation` && claim.method === PLACE_CONTEXT_METHOD &&
    claim.value?.[RDF_VALUE]?.provider === "Wikidata").map(claim=>claim.value[RDF_VALUE]);
}
export function appendPlaceContext(document, snapshot, item) {
  if (!/^Q[1-9][0-9]{0,15}$/.test(item) || snapshot?.item !== item || snapshot?.provider !== "Wikidata" ||
      snapshot.sourceUrl !== "https://www.wikidata.org/w/api.php" ||
      !Number.isFinite(Date.parse(snapshot.retrievedAt)) || !Array.isArray(snapshot.relationships) ||
      !Array.isArray(snapshot.unresolved) || typeof snapshot.entities !== "object" || !snapshot.entities?.[item]) throw Error("The provider context is incomplete or belongs to a different place.");
  const identity=`http://www.wikidata.org/entity/${item}`;
  if (!placeReferences(document).some(ref=>ref.identity===identity)) throw Error("Add this place to the geographic-tag draft before retaining its context.");
  if (recordedPlaceContexts(document).some(value=>value.item===item && value.retrievedAt===snapshot.retrievedAt)) throw Error("This context snapshot is already retained.");
  const draft=structuredClone(document);
  if (draft.metadata.normalized.length>=64) throw Error("The normalized metadata limit has been reached.");
  draft.metadata.normalized.push({subject:"resource",property:`${DC}relation`,
    value:{"@id":identity,[RDF_VALUE]:structuredClone(snapshot)},provenance:"extracted_from_documentation",
    method:PLACE_CONTEXT_METHOD,timestamp:snapshot.retrievedAt,evidence:[snapshot.sourceUrl,identity]});
  return draft;
}
