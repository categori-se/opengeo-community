import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

export async function inspectDiscoveryKnowledge(page, origin, datasetId) {
  const open = async () => {
    await page.goto(`${origin}/layers?id=${datasetId}`);
    const response = page.waitForResponse(r => r.url().endsWith(`/datasets/${datasetId}/discovery-metadata`));
    await page.getByRole('button', {name:'Inspect preserved discovery response',exact:true}).click();
    const record = await (await response).json();
    await page.getByText('Exact response-body bytes retained.',{exact:false}).waitFor();
    return record;
  };
  const initial = await open();
  const [download] = await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Download retained response',exact:true}).click()]);
  assert.equal(await download.failure(),null);
  const bytes = readFileSync(await download.path());
  assert.equal(createHash('sha256').update(bytes).digest('hex'),initial.document.sha256);
  assert.equal(bytes.length,initial.document.byte_length);
  await page.getByRole('button',{name:'Load metadata record',exact:true}).click();
  await page.getByText('Edit metadata record',{exact:true}).click();
  const editor = page.getByLabel('Metadata JSON',{exact:true});
  const before = JSON.parse(await editor.inputValue());
  const draft = structuredClone(before);
  draft.metadata.curated.push(
    {subject:'resource',property:'http://purl.org/dc/terms/title',value:'Curated facilities title',provenance:'curator_asserted'},
    {subject:'resource',property:'http://purl.org/dc/terms/license',value:null,provenance:'unknown'}
  );
  await editor.fill(JSON.stringify(draft));
  await page.getByRole('button',{name:'Save metadata revision',exact:true}).click();
  await page.getByText('Saved metadata revision 1.',{exact:true}).waitFor();
  const reopened = await open();
  assert.deepEqual(reopened,initial,'Curation cannot alter the retained discovery response');
  await page.getByRole('button',{name:'Load metadata record',exact:true}).click();
  await page.getByText('Edit metadata record',{exact:true}).click();
  assert.deepEqual(JSON.parse(await editor.inputValue()),draft);
  assert.deepEqual(draft.metadata.source,before.metadata.source);
  assert.deepEqual(draft.metadata.normalized,before.metadata.normalized);
  assert.deepEqual(draft.metadata.inferred,before.metadata.inferred);
  return {status:'passed',discovery:initial,downloadSha256:createHash('sha256').update(bytes).digest('hex'),curated: draft.metadata.curated,sourceAndNormalizedUnchanged:true};
}
