import assert from "node:assert/strict";
export async function inspectProjectVersion(page,config,origin,calls) {
  await page.goto(`${origin}/workspaces?composition=${config.compositionId}`);
  const pin=()=>page.locator(".opengeo-workbench").evaluate(s=>s.__opengeoLayers.find(l=>l.layerId==="old-point").datasetVersionId);
  await page.waitForFunction(()=>document.querySelector(".opengeo-workbench")?.__opengeoMap?.isStyleLoaded());
  await page.getByLabel("Layer actions for Pinned old point",{exact:true}).click();
  await page.getByRole("button",{name:"Style layer",exact:true}).click();
  const openStyle=async()=>{await page.getByLabel("Layer actions for Pinned old point",{exact:true}).click();await page.getByRole("button",{name:"Style layer",exact:true}).click();};
  const save=async()=>{const response=page.waitForResponse(r=>r.request().method()==="PATCH"&&/\/maps\//.test(r.url())&&r.status()===200);await page.getByRole("button",{name:"Save",exact:true}).first().click();await response;};
  if(config.persistFilters){
    await page.getByLabel("Filter field",{exact:true}).selectOption("name");
    await page.getByLabel("Filter value",{exact:true}).fill("WFS point");
    await page.getByRole("button",{name:"Apply map filter",exact:true}).click();
    await save();await page.reload();await page.waitForFunction(()=>document.querySelector(".opengeo-workbench")?.__opengeoMap?.isStyleLoaded());
    await openStyle();
    assert.deepEqual(await page.locator(".opengeo-workbench").evaluate(s=>s.__opengeoLayers.find(l=>l.layerId==="old-point").filter),["==",["get","name"],"WFS point"]);
  }
  await page.getByRole("button",{name:"Find data versions",exact:true}).click();
  await page.getByLabel("Project Layer data version",{exact:true}).selectOption(config.candidateVersionId);
  await page.getByText(/Missing field “name” used by/).waitFor();
  assert.equal(await pin(),config.baseVersionId);
  assert.equal(await page.getByRole("button",{name:"Apply version to Project draft",exact:true}).count(),0);
  await page.getByRole("button",{name:"Cancel version selection",exact:true}).click();
  assert.equal(await pin(),config.baseVersionId);
  await page.getByLabel("Show labels on map",{exact:true}).uncheck();
  if(config.persistFilters){
    await page.getByLabel("Project Layer data version",{exact:true}).selectOption(config.candidateVersionId);
    await page.getByText(/Missing field “name” used by filter/).waitFor();
    assert.equal(await pin(),config.baseVersionId);
    await page.getByRole("button",{name:"Clear map filter",exact:true}).click();
  }

  await page.getByLabel("Project Layer data version",{exact:true}).selectOption(config.candidateVersionId);
  await page.getByRole("button",{name:"Review version dependencies",exact:true}).click();
  await page.route("https://s3.us-east-1.amazonaws.com/**",route=>route.fulfill({status:503,body:"Local read failure fixture"}),{times:1});
  await page.getByRole("button",{name:"Apply version to Project draft",exact:true}).click();
  await page.getByText("The selected dataset could not be read.",{exact:true}).waitFor();
  assert.equal(await pin(),config.baseVersionId);
  await page.getByRole("button",{name:"Apply version to Project draft",exact:true}).click();
  await page.getByText("Layer version applied to this draft.",{exact:false}).waitFor();
  assert.equal(await pin(),config.candidateVersionId);
  assert.equal(calls.filter(c=>c.method==="PATCH"&&/\/maps\//.test(c.path)).length,config.persistFilters?1:0);
  await page.getByRole("button",{name:"Fit",exact:true}).first().click();
  await page.waitForFunction(()=>document.querySelector(".opengeo-workbench").__opengeoMap.queryRenderedFeatures().some(f=>f.properties?.status==="reviewed"));
  if(config.persistFilters){
    await page.getByLabel("Filter field",{exact:true}).selectOption("status");
    await page.getByLabel("Filter value",{exact:true}).fill("reviewed");
    await page.getByRole("button",{name:"Apply map filter",exact:true}).click();
  }
  const saved=page.waitForResponse(r=>r.request().method()==="PATCH"&&/\/maps\//.test(r.url())&&r.status()===200);
  await page.getByRole("button",{name:"Save",exact:true}).first().click();await saved;
  await page.reload();await page.waitForFunction(()=>document.querySelector(".opengeo-workbench")?.__opengeoLayers?.some(l=>l.layerId==="old-point"));
  assert.equal(await pin(),config.candidateVersionId);
  await page.waitForFunction(()=>document.querySelector(".opengeo-workbench").__opengeoMap?.queryRenderedFeatures().some(f=>f.properties?.status==="reviewed"));
  if(config.persistFilters){
    const expected=["==",["get","status"],"reviewed"];
    assert.deepEqual(await page.locator(".opengeo-workbench").evaluate(s=>s.__opengeoLayers.find(l=>l.layerId==="old-point").filter),expected);
    await openStyle();
    await page.getByLabel("Filter field",{exact:true}).selectOption("status");
    await page.getByLabel("Filter value",{exact:true}).fill("not present");
    await page.getByRole("button",{name:"Apply map filter",exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector(".opengeo-workbench").__opengeoMap.queryRenderedFeatures().some(f=>f.properties?.status==="reviewed"));
    await page.getByLabel("Filter value",{exact:true}).fill("reviewed");
    await page.getByRole("button",{name:"Apply map filter",exact:true}).click();
    await page.waitForFunction(()=>document.querySelector(".opengeo-workbench").__opengeoMap.queryRenderedFeatures().some(f=>f.properties?.status==="reviewed"));
  }
  assert.equal(calls.filter(c=>c.method==="PATCH"&&/\/maps\//.test(c.path)).length,config.persistFilters?2:1);
  assert.ok(!calls.some(c=>c.method==="POST"&&/build-jobs|protected-copies|refresh-reviews/.test(c.path)));
  return {status:"passed",filterSavedAndReopened:!!config.persistFilters,filterHidesAndRestoresFeatures:!!config.persistFilters,removedFilterFieldBlocked:!!config.persistFilters,missingLabelBlocked:true,cancelPreservedPin:true,failedReadPreservedPin:true,draftThenExplicitSave:true,projectSaves:config.persistFilters?2:1,candidateRenderedAndReopened:true};
}
