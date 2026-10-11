import {appendPlaceReference, placeReferences, PLACE_RELATIONS} from "../lib/geographicReferences.js";
import {appendBackupReference, appendSourceEdition, assertKnowledgeSize} from "../lib/sourceReferenceKnowledge.js";
const TERMS = [
  ["Title", "http://purl.org/dc/terms/title"],
  ["Description", "http://purl.org/dc/terms/description"],
  ["Publisher", "http://purl.org/dc/terms/publisher"],
  ["Creator", "http://purl.org/dc/terms/creator"],
  ["License", "http://purl.org/dc/terms/license"],
  ["Access rights", "http://purl.org/dc/terms/accessRights"],
  ["Rights statement", "http://purl.org/dc/terms/rights"],

  ["Usage policy", "http://www.w3.org/ns/odrl/2/hasPolicy"],
  ["Meaning / subject", "http://purl.org/dc/terms/subject"],
  ["Derived from", "http://www.w3.org/ns/prov#wasDerivedFrom"],
  ["Other vocabulary property", "custom"]
];
// Guided changes append to the same draft used by the advanced editor.
// Persisting it remains one deliberate, optimistic-concurrency API operation.
export function ResourceKnowledgeEditor({readDraft, writeDraft, onError, onChange, searchPlaces, setBusy = () => {}}) {
  const root = el("section");
  root.append(el("h3", "Curate resource knowledge"), el("p",
    "Add a claim, representation or retained source to the draft, then save a metadata revision. Existing claims stay intact, including disagreements and unknowns."));
  const notice = el("p"); notice.setAttribute("role", "status");
  function append(operation, message, group) {
    try {
      const draft = readDraft();
      operation(draft);
      assertKnowledgeSize(draft);
      writeDraft(draft); group.dataset.pending="false"; onChange(); notice.textContent = message;
    } catch (error) {onError(error.message || "The draft could not be updated.");}
  }

  const places = detail("Geographic tags");
  const placeName = input("text"), placeUri = input("url"), placeRelation = select(PLACE_RELATIONS);
  placeName.maxLength=200;placeUri.maxLength=2048;
  const placeList=el("div");
  function refreshPlaces() {
    try {
      const references=placeReferences(readDraft());placeList.replaceChildren();
      for(const ref of references) {
        const row=el("p",`${ref.name} · ${ref.relationship} · ${ref.identity ?? "Unresolved place name"} · ${ref.provenance.replaceAll("_"," ")}`);
        if(ref.removable) row.append(action(`Remove geographic tag: ${ref.name}`,()=>{
          if(places.dataset.pending==="true") {onError("Add or clear the pending place entry before removing a tag.");return;}
          // Re-read the shared draft: advanced edits must never shift an old index onto another claim.
          append(draft=>{
            const current=placeReferences(draft).find(item=>item.removable && item.name===ref.name && item.identity===ref.identity && item.relationship===ref.relationship);
            if(!current) throw Error("The tag changed in the draft. Reopen Geographic tags to refresh.");
            draft.metadata.curated.splice(current.index,1);
          },"Tag removed from the draft. Earlier saved revisions retain it.",places);
          refreshPlaces();
        }));
        placeList.append(row);
      }
    } catch { /* Retain malformed advanced JSON for correction. */ }
  }
  places.addEventListener("toggle",()=>{if(places.open) refreshPlaces();});
  places.append(el("p","Reference a place using its GeoNames or Wikidata identity. A name alone stays unresolved. This entry does not verify country or continent membership or fetch provider data."),
    field("Place name",placeName),field("Place identity URL (optional)",placeUri),field("Place relationship",placeRelation),
    action("Add geographic tag to draft",()=>{
      append(draft=>{
        const next=appendPlaceReference(draft,{name:placeName.value,identity:placeUri.value,relationship:placeRelation.value});
        draft.metadata.curated=next.metadata.curated;
      },"Geographic tag added. Save a metadata revision to retain it.",places);
      refreshPlaces();
    }),placeList);

  if(typeof searchPlaces === "function") {
    const candidates=el("div");candidates.setAttribute("role","status");let searching=false;
    const search=action("Find place by name",async()=>{
      if(searching)return;
      const name=placeName.value, identity=placeUri.value, query=name.trim();
      if(query.length<2||query.length>120){onError("Enter a place name of 2–120 characters to search.");return;}
      searching=true;setBusy(true);candidates.replaceChildren(el("p","Finding matching Wikidata items…"));
      try {
        const result=await searchPlaces(query);
        if(placeName.value!==name||placeUri.value!==identity)throw Error("The place entry changed. Search again to choose a match.");
        if(result?.provider!=="Wikidata"||!Array.isArray(result.candidates))throw Error("Place search returned an unsupported response.");
        candidates.replaceChildren(el("p",result.candidates.length?"Choose the intended place. Results may include similarly named items that are not places.":"No matching items. Refine the name or enter a known place URL."));
        for(const candidate of result.candidates) {
          if(!/^Q[1-9][0-9]{0,15}$/.test(candidate.id)||typeof candidate.label!=="string")continue;
          const row=el("p",`${candidate.label} — ${candidate.description || "No description recorded"} (${candidate.id}) `);
          row.append(action(`Use ${candidate.label} (${candidate.id})`,()=>{
            if(placeName.value!==name||placeUri.value!==identity){onError("The place entry changed. Search again before choosing a result.");return;}
            placeName.value=candidate.label;placeUri.value=`http://www.wikidata.org/entity/${candidate.id}`;
            places.dataset.pending="true";onChange();candidates.replaceChildren(el("p","Place selected. Choose its relationship and add the tag to the draft."));
          }));candidates.append(row);
        }
        if(result.moreAvailable)candidates.append(el("p","More results exist. Refine the name to narrow the choice."));
      }catch(error){candidates.replaceChildren();onError(error.message || "Place search unavailable. Your entry is unchanged.");}
      finally{searching=false;setBusy(false);}
    });
    places.append(el("p","Find place by name sends the entered name to Wikidata when a cached result is unavailable. Search runs only when requested; selecting an item does not verify its geography."),search,candidates);
  }

  const claims = detail("Add a metadata claim");
  const subject = select([["Whole resource", "resource"]]);
  function subjects() {
    try {
      const current = subject.value, draft = readDraft();
      subject.replaceChildren(option("Whole resource", "resource"), ...draft.distributions.map(d=>option(d.id,d.id)));
      if ([...subject.options].some(o=>o.value===current)) subject.value=current;
    } catch { /* A malformed advanced draft must remain available for correction. */ }
  }
  claims.addEventListener("toggle",()=>{if(claims.open) subjects();});
  subject.addEventListener("focus", subjects);
  const property = select(TERMS), custom = input("url"), value = el("textarea"); value.rows=3;
  const representation = select([["Text", "text"],["Structured JSON", "json"]]);
  const state = select([["Record a value", "known"],["Explicitly unknown", "unknown"]]);
  const authority = select([["Human curation", "curated"],["Machine inference", "inferred"]]);
  const evidence = input("text"), method = input("text"), confidence = input("number");
  confidence.min="0";confidence.max="1";confidence.step="0.01";
  claims.append(field("Applies to",subject),field("Property",property),field("Other property URI",custom),
    field("Knowledge state",state),field("Value format",representation),field("Claim value",value),
    field("Claim authority",authority),field("Evidence URI (optional)",evidence),field("Method (optional)",method),field("Confidence 0–1 (optional)",confidence),
    el("p","A blank field is not an assertion. Choose explicitly unknown when the absence itself should be recorded. Distribution terms do not inherit from the resource."),
    action("Add claim to draft",()=>append(draft=>{
      const propertyUri=property.value==="custom"?uri(custom.value):property.value;
      if (!['resource',...draft.distributions.map(d=>d.id)].includes(subject.value)) throw Error("Select a current resource or distribution.");
      const unknown=state.value==="unknown";
      if (!unknown&&!value.value.trim()) throw Error("Enter a claim value or select explicitly unknown.");
      const claim={subject:subject.value,property:propertyUri,
        value:unknown?null:representation.value==="json"?JSON.parse(value.value):value.value,
        provenance:unknown?"unknown":authority.value==="inferred"?"machine_inferred":"curator_asserted",
        timestamp:new Date().toISOString()};
      if (!unknown&&claim.value===null) throw Error("Use explicitly unknown for a null claim.");
      if(evidence.value.trim()) claim.evidence=[uri(evidence.value)];
      if(method.value.trim()) claim.method=method.value.trim();
      if(confidence.value.trim()) {
        const number=Number(confidence.value);
        if(!Number.isFinite(number)||number<0||number>1) throw Error("Confidence must be between zero and one.");
        claim.confidence=number;
      }
      const level=authority.value;
      if(draft.metadata[level].length>=64) throw Error("This assertion section has reached its limit.");
      draft.metadata[level].push(claim);
    },"Claim added to the draft. Save a revision to retain it.",claims)));

  const distributions=detail("Add a representation");
  const identity=input("text"), custody=select([["Unknown", ""],...["referenced","hosted","cached","mirrored","derived","locally_created"].map(v=>[v.replaceAll("_"," "),v])]);
  const endpoint=input("url"), media=input("text");
  distributions.append(field("Distribution URI",identity),field("Custody relationship",custody),field("Access URL (optional)",endpoint),field("Media type (optional)",media),
    el("p","This describes a representation. It does not upload, copy, download or authorize access to data."),
    action("Add representation to draft",()=>append(draft=>{
      const id=uri(identity.value);
      if(draft.distributions.some(d=>d.id===id)) throw Error("That distribution URI already exists.");
      if(draft.distributions.length>=32) throw Error("The distribution limit has been reached.");
      const distribution={id,custody:custody.value||null};
      if(endpoint.value.trim()) distribution.accessUrl=uri(endpoint.value);
      if(media.value.trim()) distribution.mediaType=media.value.trim();
      draft.distributions.push(distribution);
    },"Representation added to the draft. Open the claim form to record its terms.",distributions)));

  const backups=detail("Backup references");
  const backupUri=input("text"), backupVersion=input("text"), backupEdition=input("text"), backupNote=el("textarea");backupNote.rows=2;
  backupUri.placeholder="s3://bucket/key or https://…";
  backups.append(el("p","Link an existing backup. Its equivalence and access stay unverified; saving this pointer does not copy data or set an automatic fallback."),
    field("Backup URI",backupUri),field("Object version (optional)",backupVersion),field("Edition or snapshot label (optional)",backupEdition),field("Backup note (optional)",backupNote),
    action("Add backup reference to draft",()=>append(draft=>{
      const next=appendBackupReference(draft,{uri:backupUri.value,objectVersion:backupVersion.value,edition:backupEdition.value,note:backupNote.value});
      draft.distributions=next.distributions;draft.metadata.curated=next.metadata.curated;
    },"Backup pointer added. Save a metadata revision to retain it.",backups)));

  const editions=detail("Source editions");
  const editionLabel=input("text"), editionUri=input("url"), editionSnapshot=input("text"), editionSeries=input("url"), editionNote=el("textarea");editionNote.rows=2;
  editionSnapshot.placeholder="YYYY-MM-DD or timestamp with timezone";
  editions.append(el("p","Record an edition or snapshot mentioned by the source. Labels and snapshot dates do not establish dataset identity or release, modification or acquisition dates."),
    field("Source edition label",editionLabel),field("Edition source URI",editionUri),field("Snapshot date or time (optional)",editionSnapshot),field("Source series URI (optional)",editionSeries),field("Edition note (optional)",editionNote),
    action("Add source edition to draft",()=>append(draft=>{
      const next=appendSourceEdition(draft,{label:editionLabel.value,sourceUri:editionUri.value,snapshotAt:editionSnapshot.value,seriesUri:editionSeries.value,note:editionNote.value});
      draft.metadata.curated=next.metadata.curated;
    },"Source edition claim added. Saved data and source versions stay separate.",editions)));

  const sources=detail("Retain source metadata");
  const sourceId=input("text"), sourceUrl=input("url"), retrieved=input("text"), sourceMedia=input("text"), sourceText=el("textarea");
  let stagedSourceText=null;
  sourceMedia.value="application/json";sourceText.rows=6;
  retrieved.placeholder="2026-09-19T12:00:00Z";
  sources.append(el("p","Paste source metadata to retain the text as entered. These are user-supplied source and retrieval details, not a verified fetch. They remain separate from curated claims; no normalization or rights inference occurs."),
    field("Source document URI",sourceId),field("Source URL",sourceUrl),field("Retrieved at (with timezone)",retrieved),field("Source media type",sourceMedia),field("Original source text",sourceText),
    action("Add source text to draft",()=>append(draft=>{
      const content=stagedSourceText && sourceText.value===stagedSourceText.formValue ? stagedSourceText.content : sourceText.value;
      addSourceEntry(draft,{id:sourceId.value,sourceUrl:sourceUrl.value,retrievedAt:retrieved.value,mediaType:sourceMedia.value,content});
    },"Source text added as entered. Save a revision to retain it.",sources)));
  // Provider inspection hands off exact text to this existing form. It remains
  // pending until the person adds it to the same draft and deliberately saves.
  root.stageSourceText=({sourceUrl:source,retrievedAt,mediaType,content})=>{
    if(sources.dataset.pending==="true") throw Error("Add or clear the pending source entry before retaining another response.");
    const id=`urn:source:${crypto.randomUUID()}`;
    const draft=structuredClone(readDraft());
    const entry=addSourceEntry(draft,{id,sourceUrl:source,retrievedAt,mediaType,content});
    assertKnowledgeSize(draft);
    sourceId.value=entry.id;sourceUrl.value=entry.sourceUrl;retrieved.value=entry.retrievedAt;sourceMedia.value=entry.mediaType;sourceText.value=entry.content;
    // Textareas normalize CRLF. Retain the captured bytes unless the person
    // edits the text control, so inspection handoff preserves the source text.
    stagedSourceText={content:entry.content,formValue:sourceText.value};
    sources.open=true;sources.dataset.pending="true";onChange();
    notice.textContent="Source response is ready to review. Add it to the draft, then save a metadata revision.";
    return {ok:true};
  };
  for (const [group,title] of [[places,"Clear place entry"],[claims,"Clear claim entry"],[distributions,"Clear representation entry"],[backups,"Clear backup entry"],[editions,"Clear edition entry"],[sources,"Clear source entry"]]) {
    const defaults=[...group.querySelectorAll("input,select,textarea")].map(control=>[control,control.value]);
    group.append(action(title,()=>{
      for(const [control,value] of defaults) control.value=value;
      if(group===sources) stagedSourceText=null;
      group.dataset.pending="false";
      notice.textContent="Entry cleared. Changes already added to the shared draft are retained.";
    }));
  }
  root.hasPendingChanges = () => [places,claims,distributions,backups,editions,sources].some(group=>group.dataset.pending==="true");
  for (const type of ["input","change"]) root.addEventListener(type,event=>{
    if(event.target===sourceText) stagedSourceText=null;
    const group=event.target.closest("details");
    if(group) group.dataset.pending="true";
  });
  root.append(places,backups,editions,distributions,claims,sources,notice);
  return root;
}
function addSourceEntry(draft,{id,sourceUrl,retrievedAt,mediaType,content}) {
  const identity=uri(id), source=uri(sourceUrl), time=typeof retrievedAt==="string"?retrievedAt.trim():"";
  if(!/(?:Z|[+-]\d{2}:\d{2})$/i.test(time)||!Number.isFinite(Date.parse(time))) throw Error("Enter a retrieval timestamp with a timezone.");
  if(typeof mediaType!=="string"||!mediaType.trim()||mediaType.trim().length>200||typeof content!=="string"||!content) throw Error("Supply a media type of up to 200 characters and the source text.");
  if(draft.metadata.source.some(s=>s.id===identity)) throw Error("That source document URI already exists; use a distinct identity for a new retrieval.");
  if(draft.metadata.source.length>=16) throw Error("The source document limit has been reached.");
  const entry={id:identity,sourceUrl:source,retrievedAt:time,mediaType:mediaType.trim(),content};
  draft.metadata.source.push(entry);
  return entry;
}
function uri(value){const text=value.trim();let parsed;try{parsed=new URL(text);}catch{throw Error("Enter an absolute HTTP(S) URI or URN.");}if(!["http:","https:","urn:"].includes(parsed.protocol)||parsed.username||parsed.password||/\s/.test(text))throw Error("Enter an absolute HTTP(S) URI or URN without credentials.");return text;}
function el(tag,text=""){const node=document.createElement(tag);node.textContent=text;return node;}
function input(type){const node=el("input");node.type=type;return node;}
function field(title,node){const label=el("label",title);node.setAttribute("aria-label",title);label.append(node);return label;}
function option(title,value){const node=el("option",title);node.value=value;return node;}
function select(items){const node=el("select");node.append(...items.map(([title,value])=>option(title,value)));return node;}
function detail(title){const node=el("details");node.append(el("summary",title));return node;}
function action(title,handler){const node=el("button",title);node.type="button";node.className="platform-button secondary";node.addEventListener("click",handler);return node;}
