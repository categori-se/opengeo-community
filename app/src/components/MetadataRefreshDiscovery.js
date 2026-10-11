/** Explicit, bounded discovery using a Layer's registered source; never auto-polls. */
export function MetadataRefreshDiscovery({adapter,datasetId,projectId,run}) {
  const root=el("section"),status=el("p"),actions=el("div");status.setAttribute("role","status");
  let request=null, job=null;
  const show=()=>{
    status.textContent=job?`Provider metadata check: ${job.state}.${job.state==="completed"?" Find completed metadata discoveries below to review and retain the response.":job.errorCode?` ${job.errorCode}`:""}`:"No check requested.";
    actions.replaceChildren();
    if(job && ["queued","running"].includes(job.state)) {
      actions.append(button("Check metadata progress",()=>run(async()=>{
        const updated=await adapter.getSourceDiscovery(projectId,job.jobId);
        if(updated.jobId!==job.jobId || updated.projectId!==projectId) throw Error("Job binding changed");
        job=updated;show();
      })));
      if(job.state==="queued" && typeof adapter.cancelSourceDiscovery==="function") actions.append(button("Cancel metadata check",()=>run(async()=>{
        const updated=await adapter.cancelSourceDiscovery(projectId,job.jobId);
        if(updated.jobId!==job.jobId || updated.projectId!==projectId) throw Error("Job binding changed");
        job=updated;show();
      })));
    }
  };
  root.append(el("p","Check the registered ArcGIS or WFS provider for updated metadata. This requests one bounded discovery job. Progress is checked only when you ask; data and curated metadata remain unchanged."),
    button("Check provider metadata",()=>run(async()=>{
      if(job && ["queued","running"].includes(job.state)) {show();return;}
      // An uncertain dispatch retries the same sealed request instead of creating another job.
      if(!request || job) {
        const source=await adapter.getSource(projectId,datasetId);
        if(source.datasetId!==datasetId || source.projectId!==projectId) throw Error("Source binding changed");
        let serviceUrl,collectionRef;
        if(source.sourceType==="arcgis") {
          const match=/^(https:\/\/[^?#]+\/(?:FeatureServer|MapServer))\/(0|[1-9][0-9]{0,4})\/?$/.exec(source.sourceUrl);
          if(!match) throw Error("Unsupported ArcGIS collection URL");
          [,serviceUrl,collectionRef]=match;
        } else if(source.sourceType==="wfs") {
          serviceUrl=source.sourceUrl;collectionRef=source.configuration?.typeName;
          if(typeof collectionRef!=="string"||!collectionRef) throw Error("Missing WFS type name");
        } else {
          status.textContent="Provider metadata checks currently support registered ArcGIS and WFS Layers.";
          return;
        }
        request={sourceType:source.sourceType,kind:"collection",serviceUrl,collectionRef,idempotencyKey:crypto.randomUUID()};
        job=null;
      }
      status.textContent="Requesting provider metadata check…";
      const created=await adapter.createSourceDiscovery(projectId,request);
      if(created.projectId!==projectId) throw Error("Discovery workspace changed");
      job=created;show();
    })),status,actions);
  show();return root;
}
function el(tag,text=""){const node=document.createElement(tag);node.textContent=text;return node;}
function button(text,action){const node=el("button",text);node.type="button";node.className="platform-button secondary";node.addEventListener("click",action);return node;}
