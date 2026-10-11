import {createManagedUploadSession, resumeManagedUpload, MANAGED_FILE_ACCEPT} from '../lib/managedUpload.js';
import {documentPreview} from './DocumentPreview.js';
import {MapView} from './MapView.js';
import {OfflineAttachmentFiles, OfflineCaptureQueue, offlineCaptureAllowed} from '../lib/offlineCapture.js';

/** Deliberate catalog selection. Only immutable version IDs enter feature values. */
export function FeatureAttachmentPicker({control, adapter, projectId, classification = "internal", deviceScope, captureStorage}) {
  const attachmentFiles=captureStorage?.files ?? new OfflineAttachmentFiles();
  const captureQueue=captureStorage?.queue ?? new OfflineCaptureQueue();
  const element=document.createElement('div');
  element.className='project-feature-attachment';
  const row=(...children)=>{
    const group=document.createElement('div');group.className='project-feature-attachment-actions';
    group.append(...children);return group;
  };
  const feedback=document.createElement('p');feedback.setAttribute('role','status');
  const results=document.createElement('div');
  const previewRegion=document.createElement('section');
  previewRegion.setAttribute('aria-label','Selected attachment preview');
  let previewSequence=0;
  const clearPreview=()=>{previewSequence++;previewRegion.replaceChildren();};
  control.addEventListener('change',clearPreview);
  const search=document.createElement('input');search.type='search';search.maxLength=200;
  search.ariaLabel='Find attachment in catalog';
  const button=(label, action)=>{
    const b=document.createElement('button');b.type='button';b.textContent=label;
    b.className='platform-button secondary';b.addEventListener('click',action);return b;
  };
  let sequence=0;
  control.addEventListener('attachmentreset',()=>{
    sequence++;clearPreview();results.replaceChildren();
    feedback.textContent=control.value?'Saved attachment reference loaded. Open details or preview to check current file access.':'Choose a catalog version for this draft.';
  });
  const choose=(dataset,version)=>{
    control.value=version.id;sequence++;
    feedback.textContent=`${dataset.name} · v${version.versionNumber} selected. Save the feature to retain this reference.`;
    results.replaceChildren();control.dispatchEvent(new control.ownerDocument.defaultView.Event('change',{bubbles:true}));
  };
  const versions=async dataset=>{
    const turn=++sequence;feedback.textContent='Loading available versions…';
    try {
      const list=await adapter.listDatasetVersions(dataset.projectId,dataset.id,{limit:50});
      if(turn!==sequence)return;
      results.replaceChildren(...list.filter(v=>v.state==='active').map(version=>
        button(`${dataset.name} · v${version.versionNumber}`,()=>choose(dataset,version))));
      feedback.textContent='Select an exact version. Existing selections never follow the latest version automatically.';
    } catch {if(turn===sequence)feedback.textContent='Versions are unavailable or access has changed.';}
  };
  const find=button('Search catalog',async()=>{
    const turn=++sequence;feedback.textContent='Searching catalog…';
    try {
      const datasets=await adapter.searchDatasets({query:search.value.trim()||undefined,limit:25,offset:0});
      if(turn!==sequence)return;
      results.replaceChildren(...datasets.filter(d=>d.status==='active'&&d.currentVersionState==='active')
        .map(dataset=>button(dataset.name,()=>versions(dataset))));
      feedback.textContent='Choose a catalog file, then its version. Up to 25 results shown; refine the search if needed.';
    } catch {if(turn===sequence)feedback.textContent='Catalog unavailable. Your selected reference is unchanged.';}
  });
  const details=button('File details',async()=>{
    const selected=control.value,turn=sequence;if(!selected)return;
    try {
      const ref=await adapter.resolveFeatureAttachment(selected);
      if(control.value===selected&&turn===sequence)feedback.textContent=`${ref.name} · v${ref.versionNumber} · ${ref.format}. File access is checked separately from feature access.`;
    } catch {if(control.value===selected&&turn===sequence)feedback.textContent='File details unavailable or access has changed. The saved reference is preserved.';}
  });
  const preview=button('Preview selected file',async()=>{
    const selected=control.value;if(!selected)return;
    clearPreview();const turn=previewSequence;
    const current=()=>turn===previewSequence && control.value===selected;
    previewRegion.textContent='Loading selected version preview…';
    try {
      const ref=await adapter.resolveFeatureAttachment(selected);
      if(!current())return;
      if(['png','jpeg'].includes(ref.format)) {
        const versions=await adapter.listDatasetVersions(ref.projectId,ref.datasetId,{limit:50});
        if(!current())return;
        const original=versions.find(v=>v.id===selected && v.state==='active')?.objects
          .find(object=>object.id===ref.objectId && object.role==='original');
        if(!original || !['image/png','image/jpeg'].includes(original.contentType)
          || !Number.isSafeInteger(original.sizeBytes) || original.sizeBytes<=0 || original.sizeBytes>10*1024*1024) {
          previewRegion.textContent='This image is not available within the 10 MB preview limit. Use authorized download to inspect the original.';
          return;
        }
        const ticket=await adapter.requestDatasetDownload(ref.projectId,ref.datasetId,selected,ref.objectId);
        if(!current())return;
        const expires=Date.parse(ticket.expiresAt);
        if(!Number.isFinite(expires) || expires<=Date.now())throw Error('Expired preview');
        if(ticket.url==='fixture://memory-only') {
          previewRegion.textContent='Image access checked in memory; this fixture has no stored image bytes.';return;
        }
        if(new URL(ticket.url).protocol!=='https:')throw Error('Invalid preview URL');
        const image=document.createElement('img');image.alt=`${ref.name} · version ${ref.versionNumber}`;
        image.referrerPolicy='no-referrer';image.style.maxWidth='100%';image.style.maxHeight='24rem';
        image.onload=()=>{if(current())feedback.textContent=`${ref.name} · v${ref.versionNumber} image loaded.`;};
        image.onerror=()=>{if(current())previewRegion.textContent='Image could not load. Preview again to check access and renew the link.';};
        image.src=ticket.url;previewRegion.replaceChildren(image);return;
      }
      if(['geojson','csv','shapefile','geopackage','geoparquet'].includes(ref.format)
        && typeof adapter.getDatasetSpatialPreview==='function') {
        const result=await adapter.getDatasetSpatialPreview(ref.projectId,ref.datasetId,selected);
        if(!current())return;
        if(result.datasetVersionId!==selected)throw Error('Preview version mismatch');
        const summary=document.createElement('p');
        summary.textContent=`${result.numberReturned} features shown${result.numberMatched===null?' · source count unknown':` of ${result.numberMatched}`}${result.mayBeTruncated?' · partial preview':' · complete preview'}.`;
        previewRegion.replaceChildren(summary,MapView({geojson:result.geojson,geometryType:'GeometryCollection',height:'22rem'}));
        return;
      }
      if(!['pdf','odt'].includes(ref.format) || typeof adapter.getDatasetDocumentPreview!=='function') {
        previewRegion.textContent='An accessible preview is not available for this file format. File details and authorized download remain available.';
        return;
      }
      const result=await adapter.getDatasetDocumentPreview(ref.projectId,ref.datasetId,selected);
      if(current())previewRegion.replaceChildren(documentPreview(result));
    } catch {
      if(current())previewRegion.textContent='Preview unavailable or file access has changed. The saved reference is preserved.';
    }
  });
  const hidePreview=button('Hide preview',clearPreview);
  const download=button('Download selected file',async()=>{
    const selected=control.value,turn=sequence;if(!selected)return;
    const current=()=>control.value===selected&&turn===sequence;
    download.disabled=true;
    try {
      const ref=await adapter.resolveFeatureAttachment(selected);
      if(!current())return;
      const ticket=await adapter.requestDatasetDownload(ref.projectId,ref.datasetId,selected,ref.objectId);
      if(!current())return;
      const expires=Date.parse(ticket.expiresAt);
      if(!Number.isFinite(expires)||expires<=Date.now())throw new Error('Expired download');
      if(ticket.url==='fixture://memory-only') {feedback.textContent='Demo download authorized in memory only.';return;}
      if(new URL(ticket.url).protocol!=='https:')throw new Error('Invalid download URL');
      const link=document.createElement('a');link.href=ticket.url;link.rel='noopener noreferrer';
      link.referrerPolicy='no-referrer';link.download='';link.hidden=true;
      document.body.append(link);link.click();link.remove();
      feedback.textContent=`Download authorized for ${ref.name} · v${ref.versionNumber}.`;
    } catch {if(current())feedback.textContent='File unavailable or download permission has changed. The saved reference is preserved.';}
    finally {download.disabled=false;}
  });
  const clear=button('Clear attachment',()=>{sequence++;control.value='';results.replaceChildren();
    feedback.textContent='Attachment cleared from this draft.';control.dispatchEvent(new control.ownerDocument.defaultView.Event('change',{bubbles:true}));});
  const searchRow=row(search,find);searchRow.classList.add('project-feature-attachment-search');
  element.append(searchRow,results,row(details,preview,hidePreview,download,clear),previewRegion);
  if(adapter.requestUpload && projectId) {
    const fileOptions=document.createElement('details');fileOptions.className='project-feature-attachment-file-options';
    const summary=document.createElement('summary');summary.textContent='Add a file or use device files';
    fileOptions.append(summary);element.append(fileOptions);
    const file=document.createElement('input');file.type='file';file.accept=captureStorage?.uploadAccept ?? MANAGED_FILE_ACCEPT;
    file.ariaLabel='Choose a new attachment file';
    let deviceFile=null,deviceClassification=null,deviceFileId=null;
    file.addEventListener('change',()=>{deviceFile=null;deviceClassification=null;deviceFileId=null;});
    let uploadSession=null, sessionFile=null, registered=null,recoveryCandidate=null;
    const registrationResults=document.createElement('div');
    const check=button('Check registered file',async()=>{
      const candidate=registered;if(!candidate)return;
      check.disabled=true;registrationResults.replaceChildren();
      feedback.textContent='Checking the registered version…';
      try {
        const ref=await adapter.resolveFeatureAttachment(candidate.datasetVersionId);
        if(registered!==candidate)return;
        if(ref.versionId!==candidate.datasetVersionId)throw Error('Version mismatch');
        registrationResults.append(button(`Use ${ref.name} · v${ref.versionNumber}`,()=>{
          choose({name:ref.name},{id:ref.versionId,versionNumber:ref.versionNumber});
          registrationResults.replaceChildren();
        }));
        feedback.textContent='The registered version is ready. Choose Use to attach it to this draft.';
      } catch {
        if(registered===candidate)feedback.textContent='The registered version is not available yet or access has changed. Check again after processing; your selected attachment is unchanged.';
      } finally {check.disabled=false;}
    });
    check.hidden=true;
    const recover=button('Check interrupted registration',async()=>{
      const candidate=recoveryCandidate;if(!candidate?.uploadId)return;
      recover.disabled=true;
      try {
        const result=await resumeManagedUpload({adapter,projectId,uploadId:candidate.uploadId,
          file:candidate.file,checksumSha256:candidate.checksumSha256});
        await attachmentFiles.register(deviceScope,candidate.id,result.datasetVersionId);
        registered=result;check.hidden=false;recover.hidden=true;
        feedback.textContent='Existing registration recovered. Check registered file after processing; the same catalog record was retained.';
      } catch {feedback.textContent='The existing upload is not ready or access has changed. No replacement upload was started; the device file is retained.';}
      finally {recover.disabled=false;}
    });recover.hidden=true;
    const reconcile=button('Link selected catalog version to device file',async()=>{
      const candidate=recoveryCandidate,selected=control.value;
      if(!candidate?.checksumSha256 || !selected || selected.startsWith('device-file:')) {
        feedback.textContent='First select an accessible active version from Search catalog.';return;
      }
      const current=()=>recoveryCandidate===candidate&&control.value===selected;
      reconcile.disabled=true;
      try {
        const ref=await adapter.resolveFeatureAttachment(selected);
        if(!current())return;
        const versions=await adapter.listDatasetVersions(ref.projectId,ref.datasetId,{limit:50});
        if(!current())return;
        const original=versions.find(version=>version.id===selected&&version.state==='active')?.objects
          .find(object=>object.id===ref.objectId&&object.role==='original');
        if(ref.versionId!==selected || original?.checksumSha256!==candidate.checksumSha256 || original?.sizeBytes!==candidate.file.size) {
          feedback.textContent='The selected original does not have the same recorded checksum and size, or its version is outside this page. The device file remains unresolved.';return;
        }
        await attachmentFiles.register(deviceScope,candidate.id,selected);
        if(!current())return;
        registered={datasetVersionId:selected,dataset:{name:ref.name}};check.hidden=false;recover.hidden=true;reconcile.hidden=true;
        feedback.textContent='Matching catalog version linked to the device file. Queued observations can now resolve it; no bytes were uploaded and catalog rights remain unchanged.';
      } catch {if(current())feedback.textContent='The catalog version could not be linked. Check file access and the original checksum; the device file remains retained.';}
      finally {reconcile.disabled=false;}
    });reconcile.hidden=true;
    const upload=button('Register attachment file',async()=>{
      const selected=deviceFile??file.files?.[0];if(!selected)return;
      const selectedDeviceId=deviceFileId;
      upload.disabled=true;file.disabled=true;
      try {
        if(sessionFile!==selected) {
          registered=null;check.hidden=true;registrationResults.replaceChildren();
          const attemptId=crypto.randomUUID();
          const checkpoint=values=>attachmentFiles.checkpointRegistration(deviceScope,selectedDeviceId,{attemptId,...values});
          uploadSession=createManagedUploadSession({adapter,projectId,file:selected,
            classification:classification==='public'&&deviceClassification==='internal'?'internal':classification,
            ...(selectedDeviceId&&deviceScope?{beforeRequest:checkpoint,onTicket:checkpoint}:{}),
            onStage:(_stage,message)=>{feedback.textContent=captureStorage?.temporary ? "Inspecting the file in this tab…" : message;}});
          sessionFile=selected;
        }
        const result=await uploadSession.run();
        if(selectedDeviceId && deviceScope) await attachmentFiles.register(deviceScope,selectedDeviceId,result.datasetVersionId);
        registered=result;check.hidden=false;
        search.value=result.dataset.name;
        feedback.textContent=`${result.dataset.name} registered. Use Check registered file after processing to select this exact version.`;
      } catch {feedback.textContent='Registration did not complete. Your selected attachment is unchanged.';}
      finally {upload.disabled=false;file.disabled=false;}
    });
    fileOptions.append(row(file,upload),row(check,recover,reconcile),registrationResults);
    if(deviceScope && offlineCaptureAllowed(classification)) {
      const files=attachmentFiles;
      const localResults=document.createElement('div');
      const saveLocal=button('Keep file on this device',async()=>{
        const selected=deviceFile??file.files?.[0];if(!selected)return;
        saveLocal.disabled=true;
        try {
          await files.save(deviceScope,{projectId,classification,file:selected});
          feedback.textContent='File kept on this device. It is not attached yet. Register it when connected, then select its active version. Device files are limited to 5 MB each and 20 MB total.';
        } catch {feedback.textContent='The file could not be kept on this device. Check the file size and browser storage availability.';}
        finally {saveLocal.disabled=false;}
      });
      const listLocal=button('Show device files',async()=>{
        listLocal.disabled=true;
        try {
          const records=await files.list(deviceScope,projectId);
          localResults.replaceChildren(...records.map(record=>{
            const row=document.createElement('div');
            row.append(button(`Use device file in offline observation: ${record.filename}`,()=>{
              control.value=`device-file:${record.id}`;sequence++;clearPreview();
              control.dispatchEvent(new control.ownerDocument.defaultView.Event('change',{bubbles:true}));
              feedback.textContent='Pending device file selected. Save the observation to the device queue; registration and processing are required before sync.';
            }),button(`Choose device file: ${record.filename}`,async()=>{
              let latest;
              try {latest=(await files.list(deviceScope,projectId)).find(item=>item.id===record.id);}
              catch {feedback.textContent='Device files are unavailable.';return;}
              if(!latest){feedback.textContent='This device file was removed. Refresh the list.';return;}
              if(latest.registeredVersionId) {
                deviceFile=null;deviceFileId=null;file.value='';
                registered={datasetVersionId:latest.registeredVersionId,dataset:{name:record.filename}};check.hidden=false;
                feedback.textContent='This file was already registered. Check registered file to select its exact version; no new upload is needed.';return;
              }
              if(latest.registrationAttemptId) {
                deviceFile=null;deviceFileId=null;file.value='';recoveryCandidate=latest;recover.hidden=!latest.uploadId;
                reconcile.hidden=!latest.checksumSha256;
                feedback.textContent=latest.uploadId?'An earlier registration was interrupted. Check interrupted registration to recover the existing upload.':'The registration result is unknown. Check the catalog before retrying; this device file will not start a duplicate upload.';
                return;
              }
              deviceFile=new File([latest.file],latest.filename,{type:latest.file.type});file.value='';
              deviceClassification=latest.classification;
              deviceFileId=record.id;
              feedback.textContent=`${record.filename} ready for deliberate registration. Check the catalog first if it was registered earlier.`;
            }),button(`Remove device file: ${record.filename}`,async()=>{
              try {
                const pending=await captureQueue.list(deviceScope);
                if(pending.some(item=>item.deviceAttachments?.some(ref=>ref.localId===record.id))) {
                  feedback.textContent='A queued observation still needs this device file. Register and sync that observation before removing it.';return;
                }
                await files.remove(deviceScope,record.id);row.remove();feedback.textContent='Device copy removed. Managed files and feature references are unchanged.';
              }
              catch {feedback.textContent='Device copy could not be removed.';}
            }));return row;
          }));
          feedback.textContent=records.length?'Choose a retained file for registration, or remove its device copy.':'No device files are retained for this project.';
        } catch {feedback.textContent='Device files are unavailable.';}
        finally {listLocal.disabled=false;}
      });
      fileOptions.append(row(saveLocal,listLocal),localResults);
    }
  }
  element.append(feedback);
  control.readOnly=true;
  control.hidden=true;
  feedback.textContent="Choose a catalog version, or load details for the saved attachment.";
  return element;
}
