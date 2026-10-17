import {MetadataRefreshReview} from "./MetadataRefreshReview.js";
import {knowledgeChanges} from "../lib/knowledgeChanges.js";
import {PlaceContext, SavedPlaceContexts} from "./PlaceContext.js";
import {placeReferences} from "../lib/geographicReferences.js";
import {ResourceKnowledgeEditor} from "./ResourceKnowledgeEditor.js";
// Metadata describes knowledge and uncertainty. It never grants a data permission.
export function ResourceKnowledge({adapter, datasetId, resourceKind="layer", resourceId=datasetId, projectId=null, onStateChange=()=>{}}) {
  const readKnowledge = options=>resourceKind==="layer" ? adapter.getDatasetKnowledge(resourceId,options) : adapter.getAuthoredKnowledge(resourceKind,resourceId,options);
  const saveKnowledge = payload=>resourceKind==="layer" ? adapter.saveDatasetKnowledge(resourceId,payload) : adapter.saveAuthoredKnowledge(resourceKind,resourceId,payload);
  const root = element("section", "", "resource-knowledge");
  const projectSpecific = resourceKind === "project";
  root.append(element("h2", projectSpecific ? "Project-specific metadata" : "Resource knowledge"));
  const status = element("p", projectSpecific
    ? "Load this Project's separate metadata revisions to inspect or curate its recorded assertions."
    : "Load recorded source documents, rights and metadata assertions.");
  status.setAttribute("role", "status");
  const load = button("Load metadata record", refresh);
  const content = element("div");
  root.append(status, load, content);
  let record, guidedEditor, edited = false, busy = false, disposed = false;
  root.dispose=()=>{disposed=true;};
  root.hasUnsavedChanges=()=>edited;
  root.shouldBlockNavigation=()=>edited||busy;
  root.stageSourceMetadata=async source=>{
    try {
      if (disposed) throw Error("This metadata editor is closed. Open the Layer again to retain the response.");
      if (busy) throw Error("Wait for the current metadata operation before using this response. Your draft is retained.");
      if (edited || guidedEditor?.hasPendingChanges()) throw Error("Save or discard the existing metadata draft before using this response. Your draft is retained.");
      if (!record && !await refresh()) throw Error("The metadata record could not load. The response remains available for inspection or download.");
      if (disposed) throw Error("This metadata editor is closed. Open the Layer again to retain the response.");
      if (!record.canEdit || !guidedEditor) throw Error("Metadata edit permission is required to retain this response.");
      if (edited || guidedEditor.hasPendingChanges()) throw Error("Save or discard the existing metadata draft before using this response. Your draft is retained.");
      guidedEditor.stageSourceText(source);
      status.textContent="Retrieved metadata is pending in the original source form. Review it, add it to the draft, then save a metadata revision.";
      return {ok:true};
    } catch (error) {
      if (!disposed) status.textContent=error.message;
      throw error;
    }
  };
  const notify=()=>onStateChange({dirty:edited,busy});
  root.load = refresh;
  root.addEventListener("input",()=>notify());root.addEventListener("change",()=>notify());
  function setBusy(value) {
    busy = value;
    notify();
    for (const control of root.querySelectorAll("button, input, textarea, select")) control.disabled = value;
    load.disabled = value || edited;
  }
  async function refresh() {
    if (disposed || busy || edited) return false;
    setBusy(true);
    status.textContent = "Loading metadata record…";
    try {
      const loaded = await readKnowledge();
      if (disposed) return false;
      record = loaded;
      edited = false;
      render();
      status.textContent = record.version ? `Metadata revision ${record.version}.` : projectSpecific
        ? "No Project-specific metadata revision yet."
        : "No metadata assertions recorded yet. Unknown rights remain unknown.";
      load.textContent = "Reload metadata record";
      return true;
    } catch {if (!disposed) status.textContent = "Metadata could not load. Your role or this server may not yet support resource metadata."; return false;}
    finally {setBusy(false);}
  }
  function render() {
    guidedEditor=null;
    content.replaceChildren();
    const document = record.document;
    const unrecorded = projectSpecific ? element("details") : null;
    if (unrecorded) unrecorded.append(element("summary", "Unrecorded Project-specific fields"));
    const places=element("section");places.append(element("h3","Geographic tags"));
    const references = placeReferences(document);
    const tagDetails = projectSpecific && references.length ? element("details") : null;
    if (tagDetails) tagDetails.append(element("summary", "Tag sources and relationships"));
    for(const ref of references) {
      if (projectSpecific) {
        const row = element("p");
        const label = element(ref.identity ? "a" : "span", ref.name);
        if (ref.identity) { label.href=ref.identity; label.target="_blank"; label.rel="noopener noreferrer"; label.referrerPolicy="no-referrer"; }
        row.append(label, element("span", ` · ${ref.relationship === "Discusses this place" ? "Project context" : ref.relationship}`));
        places.append(row);
        tagDetails.append(json(`${ref.name} · ${ref.relationship}`, document.metadata[ref.level][ref.index]));
        continue;
      }
      const row=element("p",`${ref.name} · ${ref.relationship} · ${ref.level} · ${ref.provenance.replaceAll("_"," ")} · `);
      if(ref.identity) {const link=element("a",ref.identity);link.href=ref.identity;link.target="_blank";link.rel="noopener noreferrer";link.referrerPolicy="no-referrer";row.append(link);}
      else row.append(element("span","Unresolved place name"));
      places.append(row);
    }
    if (tagDetails) places.append(tagDetails);
    if (projectSpecific) {
      if (references.length) content.append(places);
      else {places.append(element("p", "No Project-specific place references recorded."));unrecorded.append(places);}
      const contexts = SavedPlaceContexts(document);
      if (contexts.childElementCount) content.append(contexts);
    } else {
      places.append(element("p","Place references do not establish verified country or continent membership. Recorded metadata retains their evidence and method."));
      content.append(places, SavedPlaceContexts(document));
    }
    const distributions = element("section");
    distributions.append(element("h3", "Representations and custody"));
    if (!document.distributions.length) distributions.append(element("p", projectSpecific
      ? "No Project-specific distributions recorded. Layer source records are available from their Catalog links."
      : "No distributions recorded. Custody is unknown."));
    for (const distribution of document.distributions) {
      distributions.append(element("h4", distribution.id), element("p", `Custody: ${distribution.custody ?? "Unknown"}`), json("Distribution", distribution));
    }
    (projectSpecific && !document.distributions.length ? unrecorded : content).append(distributions);
    for (const [key,label] of [["source","Source documents"],["normalized","Normalized metadata"],["curated","Curated metadata"],["inferred","Inferred metadata"]]) {
      const section = element("section"); section.append(element("h3",label));
      if (!document.metadata[key].length) section.append(element("p","Not recorded."));
      for (const item of document.metadata[key]) {
        if (key === "source") {
          section.append(element("p",`${item.sourceUrl} · retrieved ${item.retrievedAt}`), json(item.id,item));
          if(item.retainedResponse) {
            const descriptor=item.retainedResponse, responseStatus=element("p"), responseView=element("div");
            responseStatus.setAttribute("role","status");
            section.append(element("p",`${descriptor.byteLength} exact response bytes stored separately · SHA-256 ${descriptor.sha256}. Reading this metadata record does not fetch them.`));
            if(resourceKind==="layer" && typeof adapter.getKnowledgeSourceResponse==="function") {
              const inspect=async download=>{
                if(disposed || busy) return;
                setBusy(true);responseStatus.textContent="Reading saved response bytes…";
                try {
                  if(descriptor.datasetId!==resourceId || Object.hasOwn(item,"content")
                    || !Number.isSafeInteger(descriptor.byteLength) || descriptor.byteLength<=32_768
                    || descriptor.byteLength>2_097_152 || !/^[0-9a-f]{64}$/.test(descriptor.sha256)) throw Error("Source binding changed");
                  const retained=await adapter.getKnowledgeSourceResponse(resourceId,descriptor.discoveryJobId,
                    {byteLength:descriptor.byteLength,checksumSha256:descriptor.sha256});
                  if(disposed) return;
                  if(retained.discoveryJobId!==descriptor.discoveryJobId || retained.checksumSha256!==descriptor.sha256
                    || !(retained.blob instanceof Blob) || retained.blob.size!==descriptor.byteLength) throw Error("Source binding changed");
                  const bytes=await retained.blob.arrayBuffer();
                  const checksum=[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(n=>n.toString(16).padStart(2,"0")).join("");
                  if(checksum!==descriptor.sha256) throw Error("Source checksum changed");
                  if(disposed) return;
                  if(download) {
                    const url=URL.createObjectURL(retained.blob);
                    try {
                      const anchor=element("a");anchor.href=url;anchor.download=`metadata-${descriptor.discoveryJobId}.bin`;anchor.click();
                    } finally {setTimeout(()=>URL.revokeObjectURL(url),1000);}
                    responseStatus.textContent="Exact saved response downloaded. Metadata and drafts are unchanged.";
                  } else {
                    const text=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes);
                    const pre=element("pre",text);pre.tabIndex=0;responseView.replaceChildren(pre);
                    responseStatus.textContent="Exact saved response verified. Metadata and drafts are unchanged.";
                  }
                } catch {
                  if(!disposed) responseStatus.textContent="The saved response is unavailable or could not be verified. Your metadata draft is retained.";
                } finally {setBusy(false);}
              };
              section.append(button("View retained response",()=>inspect(false)),button("Download retained response",()=>inspect(true)));
            } else section.append(element("p","This view cannot read the separately retained response. Its reference remains in the metadata record."));
            section.append(responseStatus,responseView);
          }
        } else {
          const fact = element("article");
          fact.append(element("h4", propertyLabel(item.property)), element("p", `Applies to: ${item.subject}`),
            element("p", `Provenance: ${item.provenance.replaceAll("_", " ")} · confidence: ${item.confidence ?? "Not recorded"}`),
            json(item.value === null ? "Unknown" : "Recorded value", item.value), json("Evidence and method", item));
          section.append(fact);
        }
      }
      (projectSpecific && !document.metadata[key].length ? unrecorded : content).append(section);
    }
    const related = json("Related contextual resources", document.context);
    if (projectSpecific && !document.context.length) unrecorded.append(related);
    else content.append(related);
    const rightsScope = element("p", "Rights apply to the named resource or distribution. They are not automatically inherited by other representations. Context links do not copy provider data.");
    if (projectSpecific) {
      if (unrecorded.childElementCount > 1) content.append(unrecorded);
      const scope = element("details");scope.append(element("summary", "About this metadata"), rightsScope,
        element("p", "Place relationships retain their recorded evidence and method. A contextual place reference does not assert verified geographic coverage."));
      content.append(scope);
    } else content.append(rightsScope);
    if (record.version > 1) {
      const history = element("div");
      const comparison = element("section"); comparison.setAttribute("aria-label", "Metadata revision comparison");
      const revision = element("input"); revision.type="number";revision.min="1";revision.max=String(record.version);revision.value=String(record.version - 1);revision.setAttribute("aria-label","Metadata revision");
      history.append(revision, button("Read earlier revision", async () => {
        const version=Number(revision.value);
        if (!Number.isSafeInteger(version) || version<1 || version>record.version) return;
        if (busy) return;
        setBusy(true);
        comparison.replaceChildren();
        try {
          const previous=await readKnowledge({version});
          const changes=knowledgeChanges(previous.document, record.document);
          comparison.append(element("h3", `Revision ${version} → loaded revision ${record.version}`),
            element("p", "Compared with the saved record loaded here. Unsaved edits are excluded. Array paths use zero-based positions; reordered entries can appear as changes."),
            element("p", changes.length ? `${changes.length} changed fields.` : "No metadata differences."));
          for (const change of changes) {
            const row=element("article");
            row.append(element("h4", `${change.kind}: ${change.path}`));
            if (Object.hasOwn(change,"before")) row.append(json("Earlier value", change.before));
            if (Object.hasOwn(change,"after")) row.append(json("Loaded value", change.after));
            comparison.append(row);
          }
          comparison.append(json(`Full revision ${version}`,previous.document));
        } catch {status.textContent="That metadata revision could not load.";}
        finally {setBusy(false);}
      }), comparison);content.append(history);
    }
    if (!record.canEdit) return;
    if(resourceKind==="layer" && projectId && typeof adapter.acceptMetadataRefresh==="function") {
      content.append(MetadataRefreshReview({adapter,datasetId:resourceId,projectId,version:record.version,sources:record.document.metadata.source,
        isDirty:()=>edited,isBusy:()=>busy,setBusy,onAccepted:updated=>{
          record=updated;edited=false;render();status.textContent=`Saved metadata revision ${record.version}. Provider response retained; curation unchanged.`;
        }}));
    }

    const editor = element("details"); editor.append(element("summary", "Edit metadata record"),
      element("p", "Advanced JSON editor. Keep original source text in metadata.source. Add claims to normalized, curated or inferred metadata with a vocabulary URI, subject and provenance. Saving preserves the earlier revision."));
    const label=element("label","Metadata JSON");
    const input=element("textarea");input.setAttribute("aria-label","Metadata JSON");input.rows=22;input.value=JSON.stringify(document,null,2);input.spellcheck=false;label.append(input);
    const review=element("section"); review.setAttribute("aria-label", "Review metadata changes");
    let reviewedDraft=null;
    const save=button("Save metadata revision",async()=>{
      if (busy) return;
      if (guided.hasPendingChanges()) {
        status.textContent="Add each edited guided entry to the draft before saving, or discard and reload. Your entries are retained.";
        return;
      }
      let candidate;
      try {candidate=JSON.parse(input.value);} catch {
        status.textContent="Metadata was not saved. Check the JSON structure. Your draft is retained.";
        return;
      }
      const serialized=JSON.stringify(candidate);
      const changes=knowledgeChanges(record.document,candidate);
      if (changes.some(change=>change.kind!=="added") && reviewedDraft!==serialized) {
        review.replaceChildren(element("h3", "Review changes to saved knowledge"),
          element("p", "Earlier revisions remain retained. Check changed and removed values before saving this new revision. Array paths compare positions, so reordered entries may appear changed."));
        for (const change of changes) {
          const row=element("article"); row.append(element("h4", `${change.kind}: ${change.path}`));
          if (Object.hasOwn(change,"before")) row.append(json("Saved value",change.before));
          if (Object.hasOwn(change,"after")) row.append(json("Proposed value",change.after));
          review.append(row);
        }
        review.append(button("Confirm reviewed changes and save",()=>{
          // A changed draft requires a new review, including edits made in guided fields.
          let current;
          try {current=JSON.stringify(JSON.parse(input.value));} catch {current=null;}
          if (current!==serialized || guided.hasPendingChanges()) {
            status.textContent="The draft changed. Save again to review its current changes.";
            return;
          }
          reviewedDraft=serialized;save.click();
        }));
        status.textContent="Review changed or removed knowledge below before saving.";
        return;
      }
      edited=true;
      setBusy(true);
      try {
        const result=await saveKnowledge({expectedVersion:record.version,document:candidate});
        record=result;edited=false;load.disabled=false;render();status.textContent=`Saved metadata revision ${record.version}.`;
      } catch(error) {
        status.textContent=error?.status===409
          ? "Another revision was saved. Your draft is retained; copy it before discarding and reloading the latest record."
          : "Metadata was not saved. Check the JSON structure and your edit access. Your draft is retained.";
      } finally {setBusy(false);}
    });
    input.addEventListener("input",()=>{edited=true;load.disabled=true;notify();});
    const discard=button("Discard draft and reload",()=>{edited=false;void refresh();});
    const guided = ResourceKnowledgeEditor({
      searchPlaces: resourceKind==="layer" && typeof adapter.searchPlaceNames === "function" ? query=>adapter.searchPlaceNames(datasetId,query) : undefined,
      setBusy,
      readDraft: () => JSON.parse(input.value),
      writeDraft: draft => {input.value=JSON.stringify(draft,null,2);},
      onChange: () => {edited=true;load.disabled=true;notify();},
      onError: message => {status.textContent=message;}
    });
    guidedEditor=guided;
    // Typing a guided field is also unsaved work: a reload must not erase it.
    guided.addEventListener("input",()=>{edited=true;load.disabled=true;notify();});
    guided.addEventListener("change",()=>{edited=true;load.disabled=true;notify();});
    editor.append(label);
    content.append(guided);
    if(resourceKind==="layer" && typeof adapter.resolvePlaceContext === "function") content.append(PlaceContext({
      readDraft:()=>JSON.parse(input.value),writeDraft:draft=>{input.value=JSON.stringify(draft,null,2);},
      resolve:item=>adapter.resolvePlaceContext(datasetId,item),setBusy,
      onChange:()=>{edited=true;load.disabled=true;notify();},onError:message=>{status.textContent=message;}
    }));
    content.append(editor,save,discard,review);
  }
  return root;
}
function element(tag,value="",className=""){const node=document.createElement(tag);node.textContent=value;node.className=className;return node;}
function button(label,handler){const node=element("button",label,"platform-button secondary");node.type="button";node.addEventListener("click",handler);return node;}
function json(label,value){const node=element("details");node.append(element("summary",label),element("pre",JSON.stringify(value,null,2)));return node;}

function propertyLabel(uri) {
  const terms = {"http://purl.org/dc/terms/license": "License", "http://purl.org/dc/terms/accessRights": "Access rights",
    "http://purl.org/dc/terms/rights": "Rights statement", "http://purl.org/dc/terms/creator": "Creator",
    "http://purl.org/dc/terms/publisher": "Publisher", "http://purl.org/dc/terms/subject": "Subject",
    "http://purl.org/dc/terms/conformsTo": "Conforms to", "http://www.w3.org/ns/odrl/2/hasPolicy": "Usage policy",
    "http://www.w3.org/ns/prov#wasDerivedFrom": "Derived from"};
  return terms[uri] ?? uri;
}
