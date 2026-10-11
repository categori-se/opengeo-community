import {CatalogTablePreview, canPreviewCatalogTable} from "./CatalogTablePreview.js";
import {documentPreview} from "./DocumentPreview.js";

/** Exact retained-version files; listing never authorizes or fetches storage. */
export function DatasetVersionFiles({adapter,dataset,version}) {
  const root=el('section');root.setAttribute('aria-label',`Files for version ${version.versionNumber}`);
  let disposed=false;const timers=[],previews=[];root.dispose=()=>{disposed=true;for(const timer of timers)clearTimeout(timer);for(const preview of previews)preview.dispose?.();for(const link of root.querySelectorAll("a"))link.remove();};
  if (dataset.capabilities?.read && ["pdf","odt"].includes(dataset.format) && version.schemaDefinition?.document?.accessible_preview_schema && typeof adapter.getDatasetDocumentPreview === "function") {
    const read=el('button','Read accessible document');read.type='button';read.setAttribute('aria-expanded','false');
    const content=el('div');content.hidden=true;let loaded=false;
    read.onclick=async()=>{content.hidden=!content.hidden;read.setAttribute('aria-expanded',String(!content.hidden));if(content.hidden||loaded||disposed)return;read.disabled=true;content.textContent='Loading recorded document text…';try{const preview=await adapter.getDatasetDocumentPreview(dataset.projectId,dataset.id,version.id);if(!disposed){content.replaceChildren(documentPreview(preview));loaded=true;}}catch{if(!disposed)content.textContent='Document preview unavailable. Close and reopen to check access and retry.';}finally{if(!disposed)read.disabled=false;}};
    root.append(read,content);
  }
  const warnings=version.qualityResults?.warnings;
  if(Array.isArray(warnings)){
    for(const warning of warnings.slice(0,100)){
      if(typeof warning?.message==='string')root.append(el('p',warning.message));
      else if(typeof warning?.code==='string')root.append(el('p',`Recorded warning: ${warning.code}`));
    }
    if(warnings.length>100)root.append(el('p','More warnings are retained in Quality observations.'));
  }
  root.append(el('p','Choose an exact retained file. Preview and tile files may omit attributes or coordinate values; inspect quality observations before reuse.'));
  const objects=Array.isArray(version.objects)?version.objects:[];
  if(!objects.length)root.append(el('p','No accessible files are recorded for this version.'));
  for(const object of objects){
    const row=el('section');row.append(el('h4',`${object.role} · ${object.filename}`),el('p',`${object.sizeBytes} bytes · ${object.contentType}`));
    if(object.checksumSha256)row.append(el('p',`SHA-256: ${object.checksumSha256}`));
    const status=el('p');status.setAttribute('role','status');row.append(status);
    if(canPreviewCatalogTable(dataset,object,adapter)){const preview=CatalogTablePreview({adapter,dataset,version,object});previews.push(preview);row.append(preview);}
    if(!dataset.capabilities?.download||typeof adapter.requestDatasetDownload!=='function')row.append(el('p','Download permission required.'));
    else {
      const button=el('button','Prepare download');button.type='button';button.setAttribute('aria-label',`Prepare download: ${object.filename}`);
      const destination=el('span');let timer;
      button.onclick=async()=>{
        if(disposed||button.disabled)return;
        button.disabled=true;destination.replaceChildren();if(timer)clearTimeout(timer);status.textContent='Checking download access…';
        try{
          const ticket=await adapter.requestDatasetDownload(dataset.projectId,dataset.id,version.id,object.id);
          if(disposed)return;
          const expires=Date.parse(ticket.expiresAt),remaining=expires-Date.now();
          if(!Number.isFinite(expires)||remaining<=0)throw Error('expired');
          if(ticket.url==='fixture://memory-only'){status.textContent='Fixture authorization only; no file is stored here.';return;}
          if(new URL(ticket.url).protocol!=='https:')throw Error('invalid_url');
          const link=el('a',`Download ${object.filename}`);link.href=ticket.url;link.download=object.filename;link.rel='noopener noreferrer';link.referrerPolicy='no-referrer';destination.append(link);
          status.textContent='Download ready for this exact version. The link expires shortly.';
          timer=setTimeout(()=>{destination.replaceChildren();status.textContent='Download link expired. Prepare another to continue.';},Math.min(remaining,2147483647));timers.push(timer);
        }catch(error){if(!disposed)status.textContent=error?.status===403?'You no longer have permission to download this file.':'Download could not be prepared. Retry to check current access.';}
        finally{if(!disposed)button.disabled=false;}
      };
      row.append(button,destination);
    }
    root.append(row);
  }
  return root;
}
function el(tag,text=''){const node=document.createElement(tag);node.textContent=text;return node;}
