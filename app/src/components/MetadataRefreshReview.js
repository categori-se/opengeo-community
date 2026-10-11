import {WfsConnectionRevision} from "./WfsConnectionRevision.js";
import {ProviderResponseComparison} from "./ProviderResponseComparison.js";
import {MetadataRefreshDiscovery} from "./MetadataRefreshDiscovery.js";
// Discovery dispatch is explicit; listing/review never contacts the provider.
export function MetadataRefreshReview({adapter,datasetId,projectId,version,sources=[],isDirty,isBusy,setBusy,onAccepted}) {
  const root=el("section"), results=el("div"), status=el("p");status.setAttribute("role","status");
  root.append(el("h3","Review provider metadata"),el("p","Choose a completed discovery response to retain alongside existing knowledge. Accepting preserves curation and earlier sources; it does not update data or establish reuse rights."));
  const run=async action=>{
    if(isBusy()) return;
    if(isDirty()){status.textContent="Save or discard metadata edits before reviewing a provider response.";return;}
    setBusy(true);
    try {await action();} catch(error){status.textContent=error?.status===409
      ? "The source or metadata changed, or this response cannot be retained. Reload metadata and review again."
      : "Response unavailable. Check access and source compatibility, then retry.";}
    finally{setBusy(false);}
  };
  if(typeof adapter.getSource==="function" && typeof adapter.createSourceDiscovery==="function")
    root.append(MetadataRefreshDiscovery({adapter,datasetId,projectId,run}));
  root.append(button("Find completed metadata discoveries",()=>run(async()=>{
    results.replaceChildren();status.textContent="Loading recent discoveries…";
    const jobs=await adapter.listSourceDiscoveries(projectId,{limit:50});
    if(jobs.some(job=>job.projectId!==projectId)) throw Error("Workspace changed");
    const completed=jobs.filter(job=>job.state==="completed"&&job.kind==="collection");
    for(const job of completed) {
      const entry=el("article"),preview=el("div");
      entry.append(el("p",`${job.serviceUrl} · ${job.collectionRef} · ${job.finishedAt}`),button("Review response",()=>run(async()=>{
        preview.replaceChildren();
        const candidate=await adapter.getMetadataRefreshCandidate(datasetId,projectId,job.jobId);
        if(candidate.dataset_id!==datasetId||candidate.discovery_job_id!==job.jobId) throw Error("Binding changed");
        const doc=candidate.document;
        if(!Number.isSafeInteger(doc.byte_length)||doc.byte_length<1||doc.byte_length>2_097_152) throw Error("Response unavailable");
        let bytes;
        if(doc.status==="retained") {
          if(doc.byte_length>32_768||typeof doc.body_base64!=="string"||doc.body_base64.length>43_692) throw Error("Response unavailable");
          bytes=Uint8Array.from(atob(doc.body_base64),c=>c.charCodeAt(0));
        } else if(doc.status==="retained_object") {
          if(doc.byte_length<=32_768 || typeof adapter.getMetadataRefreshResponse!=="function") throw Error("Response unavailable");
          status.textContent="Reading saved response bytes…";
          const retained=await adapter.getMetadataRefreshResponse(datasetId,projectId,job.jobId,
            {byteLength:doc.byte_length,checksumSha256:doc.sha256});
          if(retained.discoveryJobId!==job.jobId || retained.checksumSha256!==doc.sha256
            || !(retained.blob instanceof Blob) || retained.blob.size!==doc.byte_length) throw Error("Binding changed");
          bytes=new Uint8Array(await retained.blob.arrayBuffer());
        } else throw Error("Response unavailable");
        const checksum=[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(n=>n.toString(16).padStart(2,"0")).join("");
        if(bytes.length!==doc.byte_length||checksum!==doc.sha256) throw Error("Checksum mismatch");
        const text=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes);
        preview.append(el("p",`Retrieved ${doc.retrieved_at} · source revision ${candidate.source_revision} · ${bytes.length} bytes · SHA-256 ${checksum}`),el("pre",text));
        const inlineSources=sources.filter(source=>typeof source.content==="string");
        const separateSources=sources.filter(source=>source.retainedResponse);
        if(separateSources.length) preview.append(el("p","Earlier response bytes are stored separately. This review does not compare them automatically. Open them from Source documents to inspect the retained text."));
        if(inlineSources.length || !separateSources.length)
          preview.append(ProviderResponseComparison({sources:inlineSources,text,sourceType:job.sourceType,collectionRef:job.collectionRef}));
        preview.append(button("Accept reviewed response",()=>run(async()=>{
            const updated=await adapter.acceptMetadataRefresh(datasetId,projectId,job.jobId,{expectedVersion:version,sourceRevision:candidate.source_revision});
            onAccepted(updated);
          })));
        if(job.sourceType==="wfs" && typeof adapter.updateSource==="function")
          preview.append(WfsConnectionRevision({adapter,datasetId,projectId,job,sourceRevision:candidate.source_revision,run}));
        status.textContent="Response bytes verified. Review the text before accepting.";
      })),preview);results.append(entry);
    }
    status.textContent=completed.length?`${completed.length} completed responses among the latest 50 discoveries. Source compatibility is checked when reviewed.`:"No completed collection responses in the latest 50 discoveries. Run source discovery first.";
  })),status,results);
  return root;
}
function el(tag,text=""){const node=document.createElement(tag);node.textContent=text;return node;}
function button(text,action){const node=el("button",text);node.type="button";node.className="platform-button secondary";node.addEventListener("click",action);return node;}
