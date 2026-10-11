import assert from "node:assert/strict";

export async function inspectWfsSchemaReview(page, origin, datasetId, requests, revise=false) {
  const start=requests.length;
  const click=async name=>page.getByRole("button",{name,exact:true}).click();
  const editor=page.getByLabel("Metadata JSON",{exact:true});
  const read=async()=>{
    await page.getByText("Edit metadata record",{exact:true}).click();
    return JSON.parse(await editor.inputValue());
  };
  const before=JSON.parse(await editor.inputValue());
  await click("Find completed metadata discoveries");
  await click("Review response");
  await click("Accept reviewed response");
  await page.getByText("Saved metadata revision 2.",{exact:false}).waitFor();
  // Retain the first exact schema, then explicitly request a changed provider response.
  await click("Check provider metadata");
  await click("Check metadata progress");
  await page.getByText("Provider metadata check: completed.",{exact:false}).waitFor();
  await click("Find completed metadata discoveries");
  await page.getByRole("button",{name:"Review response",exact:true}).first().click();
  await page.getByLabel("Earlier source document",{exact:true}).selectOption("0");
  const summary=page.getByRole("region",{name:"WFS field changes",exact:true});
  await summary.getByText("removed: name",{exact:true}).waitFor();
  await summary.getByText("added: status",{exact:true}).waitFor();
  await summary.getByText("changed: facility_id",{exact:true}).waitFor();
  const writesBefore=requests.filter(r=>r.method!=="GET").length;
  await page.getByLabel("Earlier source document",{exact:true}).selectOption("");
  await page.getByLabel("Earlier source document",{exact:true}).selectOption("0");
  assert.equal(requests.filter(r=>r.method!=="GET").length,writesBefore);
  await click("Accept reviewed response");
  await page.getByText("Saved metadata revision 3.",{exact:false}).waitFor();
  await page.goto(`${origin}/layers?id=${datasetId}`);
  await click("Load metadata record");
  const after=await read();
  assert.deepEqual(after.metadata.curated,before.metadata.curated);
  assert.deepEqual(after.metadata.normalized,before.metadata.normalized);
  assert.deepEqual(after.metadata.inferred,before.metadata.inferred);
  assert.equal(after.metadata.source.length,before.metadata.source.length+2);
  assert.match(after.metadata.source.at(-2).content,/name="name"/);
  assert.match(after.metadata.source.at(-1).content,/name="status"/);
  assert.ok(!requests.slice(start).some(r=>r.method!=="GET"&&(/protected-copies|refresh-reviews|\/maps|\/builds/.test(r.path))));
  let connectionRevision=null;
  if(revise) {
    await click("Find completed metadata discoveries");
    await page.getByRole("button",{name:"Review response",exact:true}).first().click();
    await click("Review WFS connection changes");
    await page.getByText("Previously selected fields absent from this discovery: name.",{exact:true}).waitFor();
    const patches=()=>requests.filter(r=>r.method==="PATCH"&&r.path.endsWith("/source"));
    const prior=patches().length;
    await click("Save WFS connection revision");
    await page.getByText("Choose up to 64 distinct available fields",{exact:false}).waitFor();
    assert.equal(patches().length,prior);
    const selected=page.getByLabel("Selected WFS fields",{exact:true});
    const confirmation=page.getByLabel("I reviewed these fields and confirm the selected sort field provides stable ordering.",{exact:false});
    await selected.fill("status");await confirmation.check();
    await click("Save WFS connection revision");assert.equal(patches().length,prior);
    await selected.fill("facility_id,status");
    assert.equal(await confirmation.isChecked(),false);
    await confirmation.check();await click("Save WFS connection revision");
    await page.getByText("Saved source revision 2.",{exact:false}).waitFor();
    assert.equal(patches().length,prior+1);assert.equal(patches().at(-1).status,200);
    await page.reload();await click("Inspect registered connection");
    await page.getByText("Revision 2",{exact:false}).waitFor();
    connectionRevision={saved:2,explicitConfirmation:true,missingSortRefused:true,reopened:true};
  }
  return {status:"passed",connectionRevision,added:"status",removed:"name",changed:"facility_id",retainedDocuments:after.metadata.source.slice(-2),curationPreserved:true,comparisonReadOnly:true,acceptedAndReopened:true};
}
