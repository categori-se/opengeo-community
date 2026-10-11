// Provider response-body bytes are independent of normalized source configuration.
export async function DiscoveryMetadata({adapter,datasetId}) {
  const root=el("section");
  root.append(el("h3","Preserved discovery response"));
  let record;
  try {record=await adapter.getDatasetDiscoveryMetadata(datasetId);}
  catch(error){if(error?.status!==404) throw error;root.append(el("p","No discovery response is linked to this Layer. Manual registration and older discoveries may have no retained response."));return root;}
  root.append(el("p",`Initial registration discovery: ${record.discovery_job_id}`),
    el("p",`Provider service: ${record.service_url} · collection: ${record.collection_ref}`),
    el("p","This response was obtained by discovery and linked during registration. It may predate the current source revision. It is separate from curated metadata and does not establish reuse rights."));
  const source=record.document;
  if(!source){root.append(el("p","The linked discovery predates response preservation. Original response bytes were not retained."));return root;}
  root.append(el("p",`Retrieved ${source.retrieved_at} · ${source.byte_length} bytes · SHA-256 ${source.sha256}`));
  if(source.status==="retained_object"){
    root.append(el("p","The exact provider response is saved privately. Download it to inspect the original bytes. Opening this panel does not download the response or contact its provider."));
    const download=el("button","Download retained response");download.type="button";download.className="platform-button secondary";
    const status=el("p");status.setAttribute("role","status");
    download.addEventListener("click",async()=>{
      if(download.disabled)return;
      const wasConnected=root.isConnected;
      download.disabled=true;status.textContent="Downloading saved response…";
      try{
        const result=await adapter.downloadDatasetDiscoveryResponse(datasetId,{discoveryJobId:record.discovery_job_id,byteLength:source.byte_length,checksumSha256:source.sha256});
        if(wasConnected&&!root.isConnected)return;
        const url=URL.createObjectURL(result.blob);
        try{
          const anchor=el("a");anchor.href=url;anchor.download=`discovery-${record.discovery_job_id}.bin`;anchor.click();
        }finally{setTimeout(()=>URL.revokeObjectURL(url),1000);}
        status.textContent="Saved response downloaded.";
      }catch{if(!wasConnected||root.isConnected)status.textContent="The saved response could not be downloaded. Try again.";}
      finally{download.disabled=false;}
    });
    root.append(download,status);return root;
  }
  if(source.status!=="retained"){
    root.append(el("p","Response bytes were not retained because they exceeded the 32 KiB metadata limit. The checksum identifies the observed response; it is not a recoverable copy. No truncated source is stored."));return root;
  }
  const bytes=Uint8Array.from(atob(source.body_base64),c=>c.charCodeAt(0));
  const digest=[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(b=>b.toString(16).padStart(2,"0")).join("");
  if(bytes.length!==source.byte_length||digest!==source.sha256) throw Error("Retained source checksum mismatch");
  root.append(el("p","Exact response-body bytes retained. HTTP headers and transport encoding are not preserved. No provider request is made during this inspection."));
  try {root.append(el("pre",new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes)));}
  catch{root.append(el("p","This response is not UTF-8 text. Download the retained bytes to inspect it with the declared source format."));}
  const download=el("button","Download retained response");download.type="button";download.className="platform-button secondary";
  download.addEventListener("click",()=>{
    const url=URL.createObjectURL(new Blob([bytes],{type:"application/octet-stream"}));
    const anchor=el("a");anchor.href=url;anchor.download=`discovery-${record.discovery_job_id}.bin`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });root.append(download);return root;
}
function el(tag,text=""){const node=document.createElement(tag);node.textContent=text;return node;}
