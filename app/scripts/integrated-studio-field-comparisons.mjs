import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync,crc32} from 'node:zlib';
import {zipSync,strToU8} from 'fflate';
import {resumeManagedUpload} from '../src/lib/managedUpload.js';

export async function exerciseFieldComparisons({page, project, origin, worker, readApi, apiRequest, organization}) {
  if(process.env.OPENGEO_ATTACHMENT_RENEWAL_ONLY === '1') {
    const headers={authorization:'Bearer synthetic-local-owner','x-opengeo-organization':organization,'content-type':'application/json'};
    const content=JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:{type:'Point',coordinates:[85,27]}}]});
    const checksumSha256=createHash('sha256').update(content).digest('hex');
    const post=async(path,body)=>{
      const response=await apiRequest(path,{method:'POST',headers,body:body?JSON.stringify(body):undefined});
      const result=JSON.parse(response.body);
      if(response.status>=400)throw Object.assign(Error(JSON.stringify(result)),{code:result.detail?.code,status:response.status});
      return result;
    };
    const ticket=await post(`/projects/${project.id}/uploads/request`,{
      name:'Renewal pilot',classification:'internal',format:'geojson',filename:'renewal-short-lived.geojson',
      content_type:'application/geo+json',size_bytes:Buffer.byteLength(content),checksum_sha256:checksumSha256,tags:[]
    });
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(ticket.expires_at)-Date.now())+150));
    await assert.rejects(post(`/projects/${project.id}/uploads/${ticket.upload_id}/complete`),error=>error.code==='upload_expired');
    let transfers=0,renewals=0;
    const result=await resumeManagedUpload({projectId:project.id,uploadId:ticket.upload_id,
      file:new Blob([content],{type:'application/geo+json'}),checksumSha256,adapter:{
        completeUpload:async(p,id)=>post(`/projects/${p}/uploads/${id}/complete`),
        renewUpload:async(p,id)=>{
          renewals++;const renewed=await post(`/projects/${p}/uploads/${id}/renew`);
          assert.equal(renewed.dataset.id,ticket.dataset.id);
          assert.equal(renewed.upload.fields.key,ticket.upload.fields.key);
          return {uploadId:renewed.upload_id,expiresAt:renewed.expires_at,upload:renewed.upload};
        },
        uploadFile:async(instructions)=>{
          transfers++;
          const status=await page.evaluate(async({instructions,content})=>{
            const form=new FormData();for(const [key,value] of Object.entries(instructions.fields))form.append(key,value);
            form.append('file',new Blob([content],{type:'application/geo+json'}),'renewal-short-lived.geojson');
            return (await fetch(instructions.url,{method:'POST',body:form})).status;
          },{instructions,content});
          assert.ok(status>=200&&status<300);
        }
      }});
    assert.equal(result.dataset.id,ticket.dataset.id);assert.equal(result.version_number,1);
    const repeated=await post(`/projects/${project.id}/uploads/${ticket.upload_id}/complete`);
    assert.equal(repeated.dataset_version_id,result.dataset_version_id);
    await assert.rejects(post(`/projects/${project.id}/uploads/${ticket.upload_id}/renew`),error=>error.code==='upload_already_completed');
    const anonymous=await apiRequest(`/projects/${project.id}/uploads/${ticket.upload_id}/renew`,{method:'POST'});
    assert.equal(anonymous.status,401);assert.equal(transfers,1);assert.equal(renewals,1);
    return {mode:'attachment-upload-renewal',expiredPolicyObserved:true,sameDatasetAndUpload:true,
      transfers,renewals,idempotentVersionCompletion:true,completedAndAnonymousRenewalDenied:true,
      limits:'Real local API/runtime PostgreSQL and production recovery helper; synthetic storage/identity. Cached UI creates project only; full capture UI, worker activation and AWS signing are not re-proven.'};
  }
  const dataUrl = `${origin}/workspaces?project=${project.id}&manage=data`;
  await page.goto(dataUrl);
  const features = [{type:'Feature',properties:{},geometry:{type:'Point',coordinates:[85,27]}}];
  await page.getByLabel('Dataset, image, or document file',{exact:true}).setInputFiles({
    name:'field-comparisons.geojson',mimeType:'application/geo+json',
    buffer:Buffer.from(JSON.stringify({type:'FeatureCollection',features}))});
  await page.getByLabel('Dataset, image, or document name',{exact:true}).fill('Field comparison pilot');
  const completed = page.waitForResponse(r=>r.url().endsWith('/complete')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Hash and upload',exact:true}).click();
  const response=await completed; assert.equal(response.status(),200);
  const source=await response.json();
  await worker();
  if (process.env.OPENGEO_ATTACHMENT_RESOLVER_ONLY === '1') {
    const versions=await readApi(`/projects/${project.id}/datasets/${source.dataset.id}/versions?limit=1&offset=0`);
    const version=versions[0];
    const ref=await readApi(`/feature-attachments/${version.id}`);
    assert.equal(ref.version_id,version.id);assert.equal(ref.dataset_id,source.dataset.id);
    assert.equal(ref.project_id,project.id);assert.equal(ref.name,'Field comparison pilot');
    const headers={authorization:'Bearer synthetic-local-owner','x-opengeo-organization':organization};
    const download=await apiRequest(`/projects/${ref.project_id}/datasets/${ref.dataset_id}/versions/${ref.version_id}/objects/${ref.object_id}/download`,{method:'POST',headers});
    assert.equal(download.status,200);
    const missing=await apiRequest('/feature-attachments/81000000-0000-4000-8000-000000000099',{method:'GET',headers});
    assert.equal(missing.status,404);
    const anonymous=await apiRequest(`/feature-attachments/${version.id}`,{method:'GET',headers:{}});
    assert.equal(anonymous.status,401);
    return {mode:'attachment-resolver-only',exactVersionMetadata:true,originalDownloadAuthorized:true,
      missingAndAnonymousDenied:true,limits:'Reuses earlier observed picker/save/reopen results; does not rerun final built UI details/download interaction. Existing Project link required.'};
  }

  await page.goto(dataUrl);
  await page.locator(`#dataset-${source.dataset.id}`).getByRole('button',{name:'Edit features',exact:true}).click();
  await page.getByLabel('Collection geometry type',{exact:true}).selectOption('Point');
  const calculated=process.env.OPENGEO_CALCULATED_FIELDS_ONLY === '1';
  const attachments=process.env.OPENGEO_ATTACHMENT_FIELDS_ONLY === '1';
  const formula={'*':[{var:'measured'},{var:'limit'}]};
  const names=attachments?['file']:calculated?['measured','limit','total']:['measured','limit','review','threshold_note'];
  for(let i=1;i<=names.length;i++) {
    if(i>1) await page.getByRole('button',{name:'Add field',exact:true}).click();
    await page.getByLabel(`Field ${i} stable name`,{exact:true}).fill(names[i-1]);
    await page.getByLabel(`Field ${i} display label`,{exact:true}).fill(names[i-1]);
    await page.getByLabel(`Field ${i} type`,{exact:true}).selectOption(attachments?'string':calculated||i<=2?'number':'string');
    await page.getByLabel(`Field ${i} is required`,{exact:true}).check();
  }
  if (attachments) {
    await page.getByLabel('Field 1 is an attachment',{exact:true}).check();
  } else if (calculated) {
    await page.getByLabel('Field 3 calculation',{exact:true}).fill(JSON.stringify(formula));
  } else {
  for(const i of [3,4]) {
    await page.getByLabel(`Field ${i} visibility`,{exact:true}).selectOption('measured');
    await page.getByLabel(`Field ${i} visibility comparison`,{exact:true}).selectOption(i===3?'gt':'gte');
  }
  await page.getByLabel('Field 3 comparison source',{exact:true}).selectOption('limit');
  await page.getByLabel('Field 4 visibility value',{exact:true}).fill('10');
  }
  const initialized=page.waitForResponse(r=>r.url().endsWith('/feature-collection')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Create empty feature collection',exact:true}).click();
  assert.equal((await initialized).status(),201);
  if(process.env.OPENGEO_ATTACHMENT_MEDIA_ONLY === '1') {
    const picker=page.locator('.project-feature-attachment');
    const alternate=process.env.OPENGEO_ATTACHMENT_ALTERNATE_MEDIA_ONLY === '1';
    const jpeg=alternate?await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;
      const context=canvas.getContext('2d');context.fillStyle='red';context.fillRect(0,0,2,2);return canvas.toDataURL('image/jpeg').split(',')[1];}):null;
    const fixtures=alternate?[{name:'attachment-image.jpeg',mimeType:'image/jpeg',buffer:Buffer.from(jpeg,'base64')},
      {name:'attachment-document.odt',mimeType:'application/vnd.oasis.opendocument.text',buffer:attachmentOdt()}]
      :[{name:'attachment-image.png',mimeType:'image/png',buffer:attachmentPng()},
        {name:'attachment-document.pdf',mimeType:'application/pdf',buffer:attachmentPdf()}];
    const versions=[];
    for(const input of fixtures) {
      await picker.getByLabel('Choose a new attachment file',{exact:true}).setInputFiles(input);
      const completed=page.waitForResponse(r=>r.url().endsWith('/complete')&&r.request().method()==='POST');
      await picker.getByRole('button',{name:'Register attachment file',exact:true}).click();
      const response=await completed;assert.equal(response.status(),200);
      versions.push((await response.json()).dataset_version_id);
      await picker.getByText(/registered. Use Check registered file/).waitFor();
    }
    await worker();
    for(let i=0;i<fixtures.length;i++) {
      const name=fixtures[i].name.replace(/\.[^.]+$/,'');
      await picker.getByLabel('Find attachment in catalog',{exact:true}).fill(name);
      await picker.getByRole('button',{name:'Search catalog',exact:true}).click();
      await picker.getByRole('button',{name,exact:true}).click();
      await picker.getByRole('button',{name:`${name} · v1`,exact:true}).click();
      assert.equal(await page.getByLabel('Feature property file',{exact:true}).inputValue(),versions[i]);
      await picker.getByRole('button',{name:'Preview selected file',exact:true}).click();
      const preview=picker.getByRole('region',{name:'Selected attachment preview'});
      if(i===0) {
        const image=preview.getByRole('img',{name:'attachment-image · version 1',exact:true});
        await image.waitFor();await page.waitForFunction(()=>document.querySelector('.project-feature-attachment img')?.naturalWidth===2);
        assert.equal(await image.getAttribute('referrerpolicy'),'no-referrer');
      } else {
        await preview.getByText('Attachment preview acceptance',{exact:true}).waitFor();
        assert.equal(await preview.locator('img').count(),0);
      }
    }
    return {mode:alternate?'attachment-jpeg-odt-preview':'attachment-image-document-preview',
      ...(alternate?{jpegDecoded:true,odtSemanticText:true}:{pngDecoded:true,pdfSemanticText:true}),
      exactVersionsSelected:true,actualWorkerActivation:true,noImageReferrer:true,selectionReplacesPreview:true,
      limits:`Representative ${alternate?'JPEG/ODT':'PNG/PDF'} with real built UI/API/worker/PostgreSQL; local identity/storage. Physical devices and deployment remain separate.`};
  }
  if(process.env.OPENGEO_ATTACHMENT_CAPTURE_ONLY === '1') {
    const openCapture=async()=>{
      await page.goto(dataUrl);
      await page.locator(`#dataset-${source.dataset.id}`).getByRole('button',{name:'Field capture',exact:true}).click();
    };
    await openCapture();
    await page.getByRole('button',{name:'Create version 1 form',exact:true}).click();
    const panel=page.locator('.project-field-capture');
    const picker=panel.locator('.project-feature-attachment');
    const filename='capture-attachment.geojson';
    await picker.getByLabel('Choose a new attachment file',{exact:true}).setInputFiles({
      name:filename,mimeType:'application/geo+json',buffer:Buffer.from(JSON.stringify({type:'FeatureCollection',features}))});
    await picker.getByRole('button',{name:'Keep file on this device',exact:true}).click();
    await picker.getByText(/File kept on this device/).waitFor();
    await picker.getByRole('button',{name:'Show device files',exact:true}).click();
    await picker.getByRole('button',{name:`Use device file in offline observation: ${filename}`,exact:true}).click();
    await panel.getByRole('button',{name:'Save to device queue',exact:true}).click();
    await panel.getByText(/saved only on this device|0 synced · 1 pending/).waitFor();
    await panel.getByRole('button',{name:'Sync device queue',exact:true}).click();
    await panel.getByText(/0 synced · 1 pending/).waitFor();
    await openCapture();
    await picker.getByRole('button',{name:'Show device files',exact:true}).click();
    await picker.getByRole('button',{name:`Choose device file: ${filename}`,exact:true}).click();
    const uploaded=page.waitForResponse(r=>r.url().endsWith('/complete')&&r.request().method()==='POST');
    await picker.getByRole('button',{name:'Register attachment file',exact:true}).click();
    const response=await uploaded;assert.equal(response.status(),200);
    const registration=await response.json();await worker();
    await picker.getByRole('button',{name:'Check registered file',exact:true}).click();
    await picker.getByRole('button',{name:'Use capture-attachment · v1',exact:true}).click();
    assert.equal(await panel.getByLabel('Feature property file',{exact:true}).inputValue(),registration.dataset_version_id);
    await picker.getByRole('button',{name:'Preview selected file',exact:true}).click();
    await picker.getByRole('region',{name:'Selected attachment preview'}).getByText(/1 features shown/).waitFor();
    await panel.getByRole('button',{name:'Sync device queue',exact:true}).click();
    await panel.getByText(/1 synced · 0 pending/).waitFor();
    await panel.getByRole('button',{name:'Start review',exact:true}).click();
    await panel.getByRole('button',{name:'Accept and promote',exact:true}).click();
    await panel.getByText(/ · accepted · /).waitFor();
    await openCapture();
    await panel.getByText(/ · accepted · /).waitFor();
    const persisted=await readApi(`/projects/${project.id}/datasets/${source.dataset.id}/features?limit=10&offset=0`);
    assert.equal(persisted.features.length,1);
    assert.equal(persisted.features[0].properties.file,registration.dataset_version_id);
    return {mode:'attachment-full-capture',deviceFileAndObservationSurviveReload:true,pendingBeforeRegistration:true,
      actualWorkerActivation:true,exactVersionReplayAndPromotion:true,reopenedAcceptedObservation:true,
      selectedVectorPreviewApi:true,limits:'Real built Studio, Chromium IndexedDB, API, worker and runtime PostgreSQL; local identity/storage. Physical devices, other preview formats, demo and deployment remain open.'};
  }
  const property=name=>page.getByLabel(`Feature property ${name}`,{exact:true});
  if (attachments) {
    const picker=page.locator('.project-feature-attachment');
    const uploaded=process.env.OPENGEO_ATTACHMENT_UPLOAD_ONLY === '1';
    const attachmentName=uploaded?'attachment-upload':'Field comparison pilot';
    if(uploaded) {
      const beforeUpload=await property('file').inputValue();
      await picker.getByLabel('Choose a new attachment file',{exact:true}).setInputFiles({
        name:'attachment-upload.geojson',mimeType:'application/geo+json',
        buffer:Buffer.from(JSON.stringify({type:'FeatureCollection',features}))});
      const completed=page.waitForResponse(r=>r.url().endsWith('/complete')&&r.request().method()==='POST');
      await picker.getByRole('button',{name:'Register attachment file',exact:true}).click();
      const response=await completed;assert.equal(response.status(),200);
      const registration=await response.json();
      assert.equal(await property('file').inputValue(),beforeUpload);
      await worker();
      await picker.getByRole('button',{name:'Check registered file',exact:true}).click();
      await picker.getByRole('button',{name:`Use ${attachmentName} · v1`,exact:true}).click();
      assert.equal(await property('file').inputValue(),registration.datasetVersionId??registration.dataset_version_id);
    } else {
      await picker.getByLabel('Find attachment in catalog',{exact:true}).fill(attachmentName);
      await picker.getByRole('button',{name:'Search catalog',exact:true}).click();
      await picker.getByRole('button',{name:attachmentName,exact:true}).click();
      await picker.getByRole('button',{name:`${attachmentName} · v1`,exact:true}).click();
    }
    const pinned=await property('file').inputValue();
    const created=page.waitForResponse(r=>r.url().endsWith('/features')&&r.request().method()==='POST');
    await page.getByRole('button',{name:'Create feature',exact:true}).click();
    const saved=await created;assert.equal(saved.status(),201,await saved.text());
    const feature=await saved.json();assert.equal(feature.properties.file,pinned);
    if(process.env.OPENGEO_ATTACHMENT_REVOCATION_ONLY==='1') {
      const ownerHeaders={authorization:'Bearer synthetic-local-owner','x-opengeo-organization':organization,'content-type':'application/json'};
      const readerHeaders={...ownerHeaders,authorization:'Bearer synthetic-local-reviewer'};
      const call=async(path,method,headers,body,status)=>{
        const response=await apiRequest(path,{method,headers,...(body?{body:JSON.stringify(body)}:{})});
        assert.equal(response.status,status,`${method} ${path}`);
        return response;
      };
      const invitation=JSON.parse((await call('/organizations/current/invitations','POST',ownerHeaders,
        {email:'reviewer@local.invalid',display_name:'Attachment reader',organization_role:'guest'},201)).body);
      await call(`/auth/invitations/${invitation.id}/accept`,'POST',readerHeaders,null,200);
      const reader='20000000-0000-4000-8000-000000000002';
      const ref=await readApi(`/feature-attachments/${pinned}`);
      const featurePath=`/projects/${project.id}/datasets/${source.dataset.id}/features`;
      const filePermission=`/projects/${project.id}/datasets/${ref.dataset_id}/permissions/${reader}`;
      await call(`/projects/${project.id}/datasets/${source.dataset.id}/permissions/${reader}`,'PUT',ownerHeaders,{role:'view'},200);
      await call(filePermission,'PUT',ownerHeaders,{role:'download'},200);
      const downloadPath=`/projects/${project.id}/datasets/${ref.dataset_id}/versions/${pinned}/objects/${ref.object_id}/download`;
      await call(`/feature-attachments/${pinned}`,'GET',readerHeaders,null,200);
      await call(downloadPath,'POST',readerHeaders,null,200);
      await call(filePermission,'DELETE',ownerHeaders,null,204);
      const retained=JSON.parse((await call(featurePath,'GET',readerHeaders,null,200)).body);
      assert.equal(retained.features.find(f=>f.id===feature.id).properties.file,pinned);
      await call(`/feature-attachments/${pinned}`,'GET',readerHeaders,null,404);
      await call(downloadPath,'POST',readerHeaders,null,403);
      return {mode:'attachment-independent-revocation',fileInitiallyReadableAndDownloadable:true,
        featureRemainsReadableWithExactReference:true,revokedResolverAndDownloadDenied:true,
        limits:'Actual local PostgreSQL/API; synthetic identities/storage. No browser revocation or deployed claim.'};
    }

    await page.goto(dataUrl);
    await page.locator(`#dataset-${source.dataset.id}`).getByRole('button',{name:'Edit features',exact:true}).click();
    await page.locator(`[data-feature-id="${feature.id}"]`).getByRole('button',{name:'Edit',exact:true}).click();
    assert.equal(await property('file').inputValue(),pinned);
    await picker.getByRole('button',{name:'File details',exact:true}).click();
    await picker.getByText(`${attachmentName} · v1 · geojson. File access is checked separately from feature access.`,{exact:true}).waitFor();
    const download=page.waitForResponse(r=>r.url().endsWith('/download')&&r.request().method()==='POST');
    await picker.getByRole('button',{name:'Download selected file',exact:true}).click();
    assert.equal((await download).status(),200);
    const unknown=await apiRequest('/feature-attachments/81000000-0000-4000-8000-000000000099',{
      method:'GET',headers:{authorization:'Bearer synthetic-local-owner','x-opengeo-organization':organization}});
    assert.equal(unknown.status,404);
    const unauthorized=await apiRequest(`/feature-attachments/${pinned}`,{method:'GET',headers:{}});
    assert.equal(unauthorized.status,401);
    const stored=await readApi(`/projects/${project.id}/datasets/${source.dataset.id}/features`);
    assert.equal(stored.features.length,1);assert.equal(stored.features[0].properties.file,pinned);
    assert.equal(stored['opengeo:collection'].fields[0].attachment,true);
    return {mode:uploaded?'attachment-upload':'attachments',registeredVersionSelected:uploaded,designerPickerSavedAndReopened:true,exactVersionDetails:true,
      originalDownloadAuthorized:true,unknownAndAnonymousDenied:true,referenceUnchanged:true,
      limits:'Same-project GeoJSON original; synthetic identity/storage. Independent attachment access revocation, preview and device/offline remain unproven.'};
  }

  if (calculated) {
    await property('measured').fill('3');await property('limit').fill('4');
    assert.equal(await property('total').inputValue(),'12');
    assert.equal(await property('total').evaluate(input=>input.readOnly),true);
    const created=page.waitForResponse(r=>r.url().endsWith('/features')&&r.request().method()==='POST');
    await page.getByRole('button',{name:'Create feature',exact:true}).click();
    const savedResponse=await created;assert.equal(savedResponse.status(),201);
    const feature=await savedResponse.json();
    assert.equal(feature.properties.total,12);
    await page.goto(dataUrl);
    await page.locator(`#dataset-${source.dataset.id}`).getByRole('button',{name:'Edit features',exact:true}).click();
    await page.locator(`[data-feature-id="${feature.id}"]`).getByRole('button',{name:'Edit',exact:true}).click();
    assert.equal(await property('total').inputValue(),'12');
    await property('measured').fill('5');
    assert.equal(await property('total').inputValue(),'20');
    const updated=page.waitForResponse(r=>r.url().endsWith(`/features/${feature.id}`)&&r.request().method()==='PUT');
    await page.getByRole('button',{name:'Save v2',exact:true}).click();
    const updateResponse=await updated;assert.equal(updateResponse.status(),200);
    assert.equal((await updateResponse.json()).properties.total,20);
    const rejected=await apiRequest(`/projects/${project.id}/datasets/${source.dataset.id}/features`,{
      method:'POST',headers:{authorization:'Bearer synthetic-local-owner','x-opengeo-organization':organization,
        'content-type':'application/json'},body:JSON.stringify({geometry:feature.geometry,properties:{measured:5,limit:4,total:999}})});
    assert.equal(rejected.status,422);
    const stored=await readApi(`/projects/${project.id}/datasets/${source.dataset.id}/features`);
    assert.equal(stored.features.length,1);
    assert.equal(stored.features[0].properties.total,20);
    assert.equal(stored.features[0]['opengeo:version'],2);
    assert.deepEqual(stored['opengeo:collection'].fields[2].calculation,formula);
    return {mode:'calculated-fields',formulaPreserved:true,readOnlyLiveCalculation:true,
      persistedReopenedAndRecalculated:true,forgedValueRejected:true,oneFeatureTwoVersions:true,
      datasetId:source.dataset.id,limits:'Actual built Studio/API/PostgreSQL; synthetic identity/storage, no device or deployed acceptance.'};
  }

  await property('measured').fill('11');await property('limit').fill('10');
  await property('review').fill('Above recorded limit');
  await property('threshold_note').fill('At least ten');
  const created=page.waitForResponse(r=>r.url().endsWith('/features')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Create feature',exact:true}).click();
  assert.equal((await created).status(),201);
  await page.goto(dataUrl);
  await page.locator(`#dataset-${source.dataset.id}`).getByRole('button',{name:'Edit features',exact:true}).click();
  const stored=await readApi(`/projects/${project.id}/datasets/${source.dataset.id}/features`);
  assert.equal(stored.features.length,1);
  assert.equal(stored.features[0].properties.review,'Above recorded limit');
  const fields=stored['opengeo:collection'].fields;
  assert.deepEqual(fields[2].visible_when,{field:'measured',value_field:'limit',operator:'gt'});
  assert.deepEqual(fields[3].visible_when,{field:'measured',equals:10,operator:'gte'});
  await property('measured').fill('9');await property('limit').fill('10');
  assert.equal(await property('review').isVisible(),false);
  assert.equal(await property('threshold_note').isVisible(),false);
  const below=page.waitForResponse(r=>r.url().endsWith('/features')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Create feature',exact:true}).click();
  const belowResponse=await below;assert.equal(belowResponse.status(),201);
  assert.deepEqual(belowResponse.request().postDataJSON().properties,{measured:9,limit:10});
  return {designerPersistedBothRuleKinds:true,savedFeatureReopened:true,hiddenFieldsOmitted:true,
    datasetId:source.dataset.id,limits:'Synthetic login/storage; real built Studio/API/PostgreSQL and local GIS worker. No deployment or device/offline synchronization claim.'};
}


function attachmentPng() {
  const chunk=(type,data)=>{const name=Buffer.from(type),length=Buffer.alloc(4),checksum=Buffer.alloc(4);
    length.writeUInt32BE(data.length);checksum.writeUInt32BE(crc32(Buffer.concat([name,data])));
    return Buffer.concat([length,name,data,checksum]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(2,0);header.writeUInt32BE(2,4);header[8]=8;header[9]=2;
  const pixels=Buffer.from([0,255,0,0,0,255,0,0,0,0,255,255,255,255]);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}

function attachmentPdf() {
  const text='BT /F1 14 Tf 30 100 Td (Attachment preview acceptance) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${text.length} >>\nstream\n${text}\nendstream`];
  let pdf='%PDF-1.4\n';const offsets=[0];
  objects.forEach((body,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${body}\nendobj\n`;});
  const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  for(const offset of offsets.slice(1))pdf+=`${String(offset).padStart(10,'0')} 00000 n \n`;
  pdf+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}


function attachmentOdt() {
  const media='application/vnd.oasis.opendocument.text';
  const content='<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.4"><office:body><office:text><text:p>Attachment preview acceptance</text:p></office:text></office:body></office:document-content>';
  const manifest=`<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.4"><manifest:file-entry manifest:full-path="/" manifest:media-type="${media}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`;
  return Buffer.from(zipSync({'mimetype':[strToU8(media),{level:0}],'content.xml':strToU8(content),'META-INF/manifest.xml':strToU8(manifest)}));
}
