// A scoped scenario in the maintained compiled-Studio/PostgreSQL acceptance runner.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile, rename} from "node:fs/promises";
import {join, resolve, extname} from "node:path";
import {unzipSync} from "fflate";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export async function finishGeoNodePublication({context, origin, config}) {
  const profile=config.geonodePublication, directory=resolve(profile.artifactDirectory);
  const path=join(directory,"browser-progress.json"), facts=JSON.parse(await readFile(path,"utf8"));
  const site=facts.committed.siteReview.document, expected=profile.expected;
  assert.equal(facts.projectId,profile.projectId);
  assert.ok(facts.steps.includes("site-theme-menu-saved-reopened"));
  const receipt={schemaVersion:"opengeo.geonode-publication-finish.1",status:"running",method:"Retain accepted compiled Studio stages; publish existing reviewed site through ordinary owner API, anonymous HTML/ZIP, isolated portable browser, revoke",api:[],writes:0,browserRequests:0};
  const persist=async()=>{
    await writeFile(path,JSON.stringify(facts,null,2)+"\n",{mode:0o600});
    await writeFile(join(directory,"finish-result.json"),JSON.stringify(receipt,null,2)+"\n",{mode:0o600});
  };
  const call=async(suffix,{method="GET",body,authenticated=false}={})=>{
    assert.ok(receipt.api.length<20);if(method!=="GET")assert.ok(++receipt.writes<=2);
    const response=await fetch(`${origin}/api${suffix}`,{method,redirect:"error",signal:AbortSignal.timeout(8000),headers:{...(authenticated?{authorization:`Bearer ${profile.token ?? profile.actors.owner.token}`,"x-opengeo-organization":config.organizationId}:{}),...(body?{"content-type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});
    receipt.api.push({path:suffix,method,status:response.status,authenticated});return response;
  };
  try {
    let published=facts.committed.sitePublish?.document;
    if(!published){
      const response=await call(`/projects/${profile.projectId}/sites/${site.id}/publish`,{method:"POST",authenticated:true,body:{expected_version:site.version_number,reason:"Approve reviewed original CC-BY narrative",map_snapshots:[]}});
      assert.equal(response.status,200);published=await response.json();
      facts.committed.sitePublish={method:"POST",path:`/projects/${profile.projectId}/sites/${site.id}/publish`,status:200,document:published};await persist();
    }
    const publicPath=`/public/organizations/${config.organizationId}/projects/${profile.projectId}/sites/${site.slug}`;
    const htmlResponse=await call(publicPath);assert.equal(htmlResponse.status,200);const html=await htmlResponse.text();
    const zipResponse=await call(publicPath+"/export.zip");assert.equal(zipResponse.status,200);const bytes=Buffer.from(await zipResponse.arrayBuffer()),zip=unzipSync(bytes);
    assert.ok(zip["index.html"]);const home=Buffer.from(zip["index.html"]).toString();
    for(const text of [expected.convertedHeading,expected.convertedText,expected.editedText??expected.editedMarkdown,"Reviewed observations","CC-BY-4.0",profile.package.resources[0].attribution]){assert.ok(html.includes(text));assert.ok(home.includes(text));}
    await writeFile(join(directory,"publication.zip"),bytes,{mode:0o600});
    receipt.zip={sha256:sha256(bytes),bytes:bytes.length,paths:Object.keys(zip).sort()};await persist();
    const offline=await context.browser().newContext(),prefix=`${origin}/__geonode_finished_portable/`;
    await offline.route("**/*",async route=>{
      assert.ok(++receipt.browserRequests<=20);const url=route.request().url(),name=url.startsWith(prefix)?decodeURIComponent(new URL(url).pathname.slice(new URL(prefix).pathname.length))||"index.html":null;
      assert.ok(name&&zip[name],"Portable browser reads archive files only");
      return route.fulfill({status:200,contentType:({".html":"text/html",".css":"text/css",".js":"text/javascript"})[extname(name)]??"application/octet-stream",body:Buffer.from(zip[name])});
    });
    try{const page=await offline.newPage();page.setDefaultTimeout(5000);await page.goto(prefix+"index.html");await page.getByRole("heading",{name:expected.convertedHeading}).first().waitFor();await page.getByText(expected.editedText??expected.editedMarkdown,{exact:true}).first().waitFor();await page.getByRole("navigation").getByRole("link",{name:"Reviewed observations",exact:true}).click();await page.getByText(expected.convertedText,{exact:true}).first().waitFor();await page.screenshot({path:join(directory,"portable-site.png"),fullPage:true});}finally{await offline.close();}
    receipt.portableBrowserWithoutGeoNode=true;await persist();
    if(!facts.committed.siteRevoke){const suffix=`/projects/${profile.projectId}/sites/${site.id}/editions/${published.active_edition.id}/revoke`;const response=await call(suffix,{method:"POST",authenticated:true});assert.equal(response.status,200);facts.committed.siteRevoke={method:"POST",path:suffix,status:200,document:await response.json()};await persist();}
    for(const suffix of [publicPath,publicPath+"/export.zip"]){const response=await call(suffix);assert.ok([404,410].includes(response.status));await response.arrayBuffer();}
    facts.status="passed";facts.publicDeliveryRevoked=true;facts.nativeSourceEditSaveReopen=true;facts.portableBrowserWithoutGeoNode=true;
    facts.steps.push("api-finished-publication-anonymous-html-zip-offline-browser-revocation");receipt.status="passed";receipt.publicDeliveryRevoked=true;await persist();return {...facts,finish:receipt};
  }catch(error){receipt.status="failed";receipt.failure={type:error.name,message:String(error.message).slice(0,1000)};await persist();throw error;}
}

export async function exerciseGeoNodePublication({page, context, origin, config, requests}) {
  const profile = config.geonodePublication;
  const expected = profile.expected;
  const title = expected.importedTitle ?? expected.title;
  const projectId = profile.projectId;
  const directory = resolve(profile.artifactDirectory);
  await mkdir(directory, {recursive:true, mode:0o700});
  const progressPath = join(directory, "browser-progress.json");
  const retained = await readFile(progressPath, "utf8").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const profileSha256 = sha256(JSON.stringify({projectId, package:profile.package, expected}));
  const facts = retained ? JSON.parse(retained) : {schemaVersion:"opengeo.geonode-publication-browser.1", status:"running",
    realCompiledStudio:true, realHttpAndRuntimeRolePostgres:true, syntheticAuthentication:true,
    projectId, packageSha256:sha256(JSON.stringify(profile.package)), profileSha256, attempts:1,
    steps:[], denials:[], committed:{}};
  if (retained) {
    assert.equal(profile.resume, true, "Retained work requires the explicitly diagnosed continuation");
    assert.equal(facts.status, "failed", "Only a failed browser journey may resume");
    assert.equal(facts.attempts, 1, "Only one targeted continuation is admitted");
    assert.equal(facts.profileSha256, profileSha256, "Resume must preserve the fixture and expected authored content");
    assert.ok(typeof profile.resumeReason === "string" && profile.resumeReason.trim(), "Resume requires its diagnosed method change");
    facts.failures = [...(facts.failures ?? []), facts.failure];
    delete facts.failure;
    facts.attempts++;
    facts.resumeReason = profile.resumeReason;
    facts.status = "running";
    assert.ok(!facts.pendingMutation?.requestIssued || facts.committed[facts.pendingMutation.key],
      "A write with no retained response requires diagnosed database readback before continuation; never replay it blindly");
  } else assert.ok(!profile.resume, "Cannot resume without retained committed receipts");
  async function persist() {
    const temporary = progressPath+".pending";
    await writeFile(temporary, JSON.stringify(facts, null, 2)+"\n", {mode:0o600});
    await rename(temporary, progressPath);
  }
  async function checkpoint(step, update = {}) {
    Object.assign(facts, update);
    if (!facts.steps.includes(step)) facts.steps.push(step);
    await persist();
  }
  function siteSelect(scope, label) {
    // ProjectSites uses a wrapping label without aria-label. Match its label
    // span separately so option text is never part of the selector's name.
    return scope.locator("label").filter({has:page.getByText(label, {exact:true})}).locator(":scope > select");
  }
  async function changed(key, suffix, method, action, status = 200, target = page) {
    assert.equal(facts.committed[key], undefined, `Never replay committed ${key}`);
    const siteId = suffix.match(/\/sites\/([a-f0-9-]+)(?:\/|$)/)?.[1];
    const card = siteId && await target.locator(`#site-${siteId}`).count()
      ? await target.locator(`#site-${siteId}`).elementHandle() : null;
    const pending = target.waitForResponse(response => new URL(response.url()).pathname === `/api${suffix}`
      && response.request().method() === method);
    facts.pendingMutation = {key, path:suffix, method, requestIssued:false};
    await persist();
    const observed = request => {
      if (request.method() === method && (new URL(request.url()).pathname === `/api${suffix}`
        || key === "sourceVersion" && new URL(request.url()).pathname.endsWith("/page-source-uploads")))
        facts.pendingMutation.requestIssued = true;
    };
    target.on("request", observed);
    try {
      await action();
      const response = await pending;
      assert.equal(response.status(), status, `${method} ${suffix}`);
      const document = await response.json();
      // Record the successful write before checking replacement DOM or content.
      facts.committed[key] = {method, path:suffix, status, document};
      delete facts.pendingMutation;
      await persist();
      if (card) {
        await target.waitForFunction(element => !element.isConnected, card);
        await card.dispose();
      }
      return document;
    } finally {
      target.off("request", observed);
    }
  }
  async function openResource(target = page, actor = null) {
    const query = new URLSearchParams({project:projectId, view:"resources"});
    if (actor) query.set("acceptanceActor", actor);
    await target.goto(`${origin}/workspaces?${query}`);
    const card = target.locator(`.project-resource-card[data-resource-id="${facts.resourceId}"]`);
    await card.getByRole("button", {name:"Open resource", exact:true}).click();
    const detail = target.locator(".project-resource-detail");
    await detail.getByRole("heading", {name:title, exact:true}).waitFor();
    return detail;
  }
  async function actorPage(actor, route) {
    const target = await context.newPage();
    target.setDefaultTimeout(10_000);
    const query = new URLSearchParams({...route, acceptanceActor:actor});
    await target.goto(`${origin}/workspaces?${query}`);
    return target;
  }
  async function denied(target, actor, suffix, method, body, statuses) {
    const identity = profile.actors[actor];
    const result = await target.evaluate(async ({suffix, method, body, identity}) => {
      const response = await fetch(`/api${suffix}`, {method,
        headers:{authorization:`Bearer ${identity.token}`, "x-opengeo-organization":identity.organizationId,
          ...(body ? {"content-type":"application/json"} : {})},
        ...(body ? {body:JSON.stringify(body)} : {})});
      let document;
      try { document = await response.json(); } catch { document = {}; }
      return {status:response.status, code:document.detail?.code ?? document.error?.code ?? null};
    }, {suffix, method, body, identity});
    assert.ok(statuses.includes(result.status), `${actor} ${method} ${suffix} must deny: ${result.status}`);
    facts.denials.push({actor, method, path:suffix, ...result});
    await persist();
  }
  try {
    await persist();
    let imported = facts.committed.import?.document;
    if (!imported) {
      await page.goto(`${origin}/workspaces?project=${projectId}&view=resources`);
      const importer = page.locator(".project-resource-geonode-import");
      await importer.getByLabel("GeoNode package JSON", {exact:true}).fill(JSON.stringify(profile.package));
      imported = await changed("import", `/projects/${projectId}/resources/imports/geonode`, "POST",
        () => importer.getByRole("button", {name:"Import GeoNode package", exact:true}).click(), 201);
      await importer.getByRole("status").getByText(/Imported: 1 resource; 1 converted publication; 0 publication conversion losses/).waitFor();
    }
    const resource = imported.resources.find(resource => resource.title === title);
    assert.ok(resource, "The deliberate Studio import returns the authored GeoStory");
    assert.equal(imported.idempotent, false);
    assert.equal(resource.license, "CC-BY-4.0");
    assert.equal(resource.attribution, profile.package.resources[0].attribution);
    assert.ok(resource.content.blocks.some(block => block.type === "heading" && block.text === expected.convertedHeading));
    assert.ok(resource.content.blocks.some(block => block.type === "markdown" && block.markdown === expected.convertedText));
    await checkpoint("studio-import", {resourceId:resource.id, importedVersion:resource.version_number,
      conversionReport:imported.report});

    // Preserve the converted native blocks and append an ordinary authored source
    // block. Saving uses the production upload-ticket and immutable page-version API.
    let detail;
    let saved = facts.committed.sourceVersion?.document;
    if (!saved) {
      if (!retained) {
        const resourceCard = page.locator(`.project-resource-card[data-resource-id="${resource.id}"]`);
        await resourceCard.getByRole("button", {name:"Open resource", exact:true}).click();
        detail = page.locator(".project-resource-detail");
      } else detail = await openResource();
      await detail.getByLabel("Markdown block", {exact:true}).selectOption({label:"+ New Markdown block"});
      await detail.getByLabel("Markdown source", {exact:true}).fill(expected.editedMarkdown);
      await detail.getByRole("button", {name:"Apply Markdown to draft", exact:true}).click();
      await detail.getByLabel("Change summary", {exact:true}).fill("Review migrated observations in native page source");
      saved = await changed("sourceVersion", `/projects/${projectId}/resources/${resource.id}/page-versions`, "POST",
        () => detail.getByRole("button", {name:"Save new version", exact:true}).click(), 201);
    }
    assert.equal(saved.resource.version_number, resource.version_number+1);
    assert.equal(saved.source.checksum_sha256, sha256(expected.editedMarkdown));
    assert.equal(saved.source.size_bytes, Buffer.byteLength(expected.editedMarkdown));
    for (const importedBlock of resource.content.blocks) {
      assert.deepEqual(saved.resource.content.blocks.find(block => block.id === importedBlock.id), importedBlock,
        "Native source editing preserves every imported heading, paragraph and source-custody block");
    }
    await checkpoint("native-source-version-saved", {pageVersion:saved.resource.version_number,
      sourceChecksum:saved.source.checksum_sha256, sourceObjectVersion:saved.source.s3_version_id});
    if (!facts.steps.includes("native-source-fresh-reopen")) {
      detail = await openResource();
      await detail.getByLabel("Markdown block", {exact:true}).selectOption(saved.source.source_block_id);
      assert.equal(await detail.getByLabel("Markdown source", {exact:true}).inputValue(), expected.editedMarkdown);
      await detail.getByRole("button", {name:`Inspect exact source v${saved.resource.version_number}`, exact:true}).click();
      await detail.locator(".page-source-history-output").waitFor({state:"visible"});
      assert.equal(await detail.locator(".page-source-history-output").textContent(), expected.editedMarkdown);
      await checkpoint("native-source-fresh-reopen");
    }

    if (!facts.committed.idempotentReimport) {
      if (!detail) detail = await openResource();
      const importer = page.locator(".project-resource-geonode-import");
      await importer.getByLabel("GeoNode package JSON", {exact:true}).fill(JSON.stringify(profile.package));
      await changed("idempotentReimport", `/projects/${projectId}/resources/imports/geonode`, "POST",
        () => importer.getByRole("button", {name:"Import GeoNode package", exact:true}).click(), 201);
    }
    const reimported = facts.committed.idempotentReimport.document;
    assert.equal(reimported.idempotent, true);
    assert.equal(reimported.resources.length, 1);
    assert.equal(reimported.resources[0].id, resource.id);
    assert.equal(reimported.resources[0].version_number, saved.resource.version_number);
    assert.deepEqual(reimported.resources[0].content, saved.resource.content,
      "A deliberate identical-package reimport preserves the saved native edit and version");
    await checkpoint("native-edit-survives-idempotent-reimport");
    if (!facts.steps.includes("exact-original-source-export-with-native-edit")) {
      detail ??= await openResource();
      const exported = await page.evaluate(({projectId,resourceId}) =>
        globalThis.__acceptanceAdapter.exportResourceToGeoNode(projectId,resourceId), {projectId,resourceId:resource.id});
      assert.deepEqual(exported.resource._opengeo.metadataExtensions.geonode.data, profile.package.resources[0].data);
      assert.deepEqual(exported.resource._opengeo.content, saved.resource.content);
      assert.ok(exported.resource._opengeo.content.blocks.some(block => block.type === "markdown"
        && block.id === saved.source.source_block_id && block.markdown === expected.editedMarkdown));
      await writeFile(join(directory, "source-export.json"), JSON.stringify(exported, null, 2)+"\n", {mode:0o600});
      await checkpoint("exact-original-source-export-with-native-edit", {exportSourceDataSha256:sha256(JSON.stringify(exported.resource._opengeo.metadataExtensions.geonode.data))});
    }

    if (!facts.committed.resourceReview) {
      detail ??= await openResource();
      await detail.getByLabel("Decision note", {exact:true}).fill("Migrated source and explicit publication rights reviewed");
      await changed("resourceReview", `/projects/${projectId}/resources/${resource.id}/transitions`, "POST",
        () => detail.getByRole("button", {name:"Submit for review", exact:true}).click());
    }
    let publishedResource = facts.committed.resourcePublish?.document;
    if (!publishedResource) {
      detail ??= await openResource();
      await detail.getByRole("button", {name:"Publish", exact:true}).waitFor();
      await detail.getByLabel("Publication visibility", {exact:true}).selectOption("public");
      await detail.getByLabel("Decision note", {exact:true}).fill("Approve original CC-BY-4.0 narrative for public reuse");
      publishedResource = await changed("resourcePublish", `/projects/${projectId}/resources/${resource.id}/transitions`, "POST",
        () => detail.getByRole("button", {name:"Publish", exact:true}).click());
    }
    await checkpoint("resource-reviewed-and-published", {publishedResourceVersion:publishedResource.version_number});

    let site = facts.committed.siteCreate?.document;
    if (!site) {
      await page.goto(`${origin}/workspaces?project=${projectId}&view=publishing`);
      await page.getByRole("button", {name:"New publication…", exact:true}).first().click();
      await page.getByRole("tab", {name:"Maps and pages", exact:true}).click();
      const creator = page.locator('.publication-new-dialog .project-site-editor[data-site-destination="new"]');
      await creator.getByLabel("Site title", {exact:true}).fill("Reviewed field observations");
      await creator.getByLabel("Permanent site slug", {exact:true}).fill("geonode-field-observations");
      await siteSelect(creator, "Accessible theme").selectOption("atlas");
      await creator.getByLabel("Accent color", {exact:true}).fill("#176b87");
      await creator.getByLabel(`Include ${title}`, {exact:true}).check();
      await creator.getByLabel(`${title} is the home page`, {exact:true}).check();
      await creator.getByLabel(`${title} navigation label`, {exact:true}).fill("Observations");
      site = await changed("siteCreate", `/projects/${projectId}/sites`, "POST",
        () => creator.getByRole("button", {name:"Create draft site", exact:true}).click(), 201);
    }
    await checkpoint("site-composed", {siteId:site.id});
    await page.goto(`${origin}/workspaces?publication=${site.id}`);
    const siteCard = page.locator(`#site-${site.id}`);
    if (!facts.committed.siteEdit) {
      await siteCard.getByRole("tab", {name:"Settings", exact:true}).click();
      await siteSelect(siteCard, "Accessible theme").selectOption("minimal");
      await siteCard.getByLabel("Footer text (optional)", {exact:true}).fill("Original narrative · CC-BY-4.0");
      await siteCard.getByRole("tab", {name:"Pages", exact:true}).click();
      await siteCard.getByLabel(`${title} navigation label`, {exact:true}).fill("Reviewed observations");
      await siteCard.getByLabel("Revision note", {exact:true}).fill("Review theme and navigation for the portable edition");
      await changed("siteEdit", `/projects/${projectId}/sites/${site.id}`, "PUT",
        () => siteCard.getByRole("button", {name:"Save draft revision", exact:true}).click());
    }
    site = facts.committed.siteEdit.document;
    assert.equal(site.theme, "minimal");
    assert.equal(site.pages[0].navigation_label, "Reviewed observations");
    if (!facts.steps.includes("site-theme-menu-saved-reopened")) {
      await page.reload();
      await siteCard.getByRole("tab", {name:"Pages", exact:true}).waitFor();
      assert.equal(await siteCard.getByLabel(`${title} navigation label`, {exact:true}).inputValue(), "Reviewed observations");
      await siteCard.getByRole("tab", {name:"Settings", exact:true}).click();
      assert.equal(await siteSelect(siteCard, "Accessible theme").inputValue(), "minimal");
      await checkpoint("site-theme-menu-saved-reopened", {siteVersion:site.version_number, theme:site.theme});
    }

    if (!facts.committed.destination) {
      await siteCard.getByRole("tab", {name:"Publish", exact:true}).click();
      await siteCard.getByRole("button", {name:"Configure public addresses…", exact:true}).click();
      await siteSelect(siteCard, "Reach").selectOption("listed");
      await changed("destination", `/projects/${projectId}/sites/${site.id}/publication-destination`, "PUT",
        () => siteCard.getByRole("button", {name:"Save destination", exact:true}).click());
    }
    if (!facts.committed.siteReview) {
      await siteCard.getByRole("tab", {name:"Publish", exact:true}).click();
      await changed("siteReview", `/projects/${projectId}/sites/${site.id}/review`, "POST",
        () => siteCard.getByRole("button", {name:"Submit revision for review", exact:true}).click());
    }
    site = facts.committed.siteReview.document;
    await checkpoint("site-destination-reviewed", {siteVersion:site.version_number});

    for (const actor of ["viewer", "editor"].filter(actor => profile.actors?.[actor]
      && !facts.denials.some(denial => denial.actor === actor && denial.path.endsWith("/publish")))) {
      const other = await actorPage(actor, {publication:site.id});
      const otherCard = other.locator(`#site-${site.id}`);
      await otherCard.getByRole("tab", {name:"Publish", exact:true}).click();
      await otherCard.locator(".project-site-review-handoff").waitFor();
      assert.equal(await otherCard.getByRole("button", {name:"Publish reviewed edition", exact:true}).count(), 0);
      await denied(other, actor, `/projects/${projectId}/sites/${site.id}/publish`, "POST",
        {expected_version:site.version_number, reason:"Acceptance confirms edit/read access cannot publish", map_snapshots:[]}, [403]);
      await other.close();
    }
    if (profile.actors?.foreign && !facts.denials.some(denial => denial.actor === "foreign"))
      await denied(page, "foreign", `/projects/${projectId}/resources/${resource.id}`, "GET", null, [403,404]);
    await checkpoint("administration-denials");

    if (!facts.committed.sitePublish) {
      await siteCard.getByRole("tab", {name:"Publish", exact:true}).click();
      await changed("sitePublish", `/projects/${projectId}/sites/${site.id}/publish`, "POST",
        () => siteCard.getByRole("button", {name:"Publish reviewed edition", exact:true}).click());
    }
    const edition = facts.committed.sitePublish.document;
    const delivered = facts.steps.includes("anonymous-html-and-network-isolated-portable-browser");
    let publicUrl = facts.publicUrl && new URL(new URL(facts.publicUrl).pathname, origin).href;
    let zipUrl = facts.zipUrl && new URL(new URL(facts.zipUrl).pathname, origin).href;
    if (!delivered) {
    await siteCard.getByRole("tab", {name:"Publish", exact:true}).click();
    publicUrl = new URL(await siteCard.getByRole("link", {name:"Open listed site", exact:true}).getAttribute("href"), origin).href;
    const zipLink = siteCard.getByRole("link", {name:"Download portable ZIP", exact:true});
    zipUrl = new URL(await zipLink.getAttribute("href"), origin).href;
    const downloaded = page.waitForEvent("download");
    await zipLink.click();
    const zipBytes = await readFile(await (await downloaded).path());
    assert.ok(zipBytes.length > 0 && zipBytes.length <= 1_048_576);
    const zip = unzipSync(zipBytes);
    assert.ok(zip["index.html"]);
    const home = Buffer.from(zip["index.html"]).toString("utf8");
    for (const text of [expected.convertedHeading, expected.convertedText, expected.editedText ?? expected.editedMarkdown,
      "Reviewed observations", "CC-BY-4.0", profile.package.resources[0].attribution]) assert.ok(home.includes(text), `Portable HTML retains ${text}`);
    assert.ok(!/geonode\.example\.test[^<]*\.js|mapstore[^<]*\.js/i.test(home), "Portable content needs no upstream runtime");
    await writeFile(join(directory, "publication.zip"), zipBytes, {mode:0o600});
    await checkpoint("site-published-and-zip-exported", {editionId:edition.active_edition?.id,
      zipSha256:sha256(zipBytes), zipBytes:zipBytes.length, zipPaths:Object.keys(zip).sort(), publicUrl, zipUrl});

    const anonymous = await context.newPage();
    await anonymous.goto(publicUrl);
    await anonymous.getByRole("heading", {name:expected.convertedHeading}).first().waitFor();
    await anonymous.getByText(expected.editedText ?? expected.editedMarkdown, {exact:true}).first().waitFor();
    await anonymous.getByRole("navigation").getByRole("link", {name:"Reviewed observations", exact:true}).waitFor();
    assert.equal(await anonymous.locator("body").evaluate(body => body.classList.contains("theme-minimal")), true);
    await anonymous.screenshot({path:join(directory, "published-site.png"), fullPage:true});
    await anonymous.close();

    const offline = await context.browser().newContext();
    const prefix = `${origin}/__geonode_portable/`;
    const offlineRequests = [];
    await offline.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      const relative = request.url().startsWith(prefix) ? decodeURIComponent(url.pathname.slice(new URL(prefix).pathname.length)) || "index.html" : null;
      offlineRequests.push({path:url.pathname, archiveEntry:relative, served:Boolean(relative && zip[relative])});
      if (!relative || !zip[relative] || request.method() !== "GET") return route.abort();
      return route.fulfill({status:200, contentType:({".html":"text/html", ".css":"text/css", ".js":"text/javascript", ".svg":"image/svg+xml", ".png":"image/png"})[extname(relative)] ?? "application/octet-stream", body:Buffer.from(zip[relative])});
    });
    try {
      const portable = await offline.newPage();
      await portable.goto(prefix+"index.html");
      await portable.getByRole("heading", {name:expected.convertedHeading}).first().waitFor();
      await portable.getByText(expected.editedText ?? expected.editedMarkdown, {exact:true}).first().waitFor();
      await portable.getByRole("navigation").getByRole("link", {name:"Reviewed observations", exact:true}).click();
      await portable.getByText(expected.convertedText, {exact:true}).first().waitFor();
      assert.ok(offlineRequests.length > 0 && offlineRequests.every(item => item.served), "Offline browser reads only the exported archive");
      await portable.screenshot({path:join(directory, "portable-site.png"), fullPage:true});
    } finally { await offline.close(); }
    await checkpoint("anonymous-html-and-network-isolated-portable-browser", {offlineRequests});
    }
    if (!facts.committed.siteRevoke) {
      await siteCard.getByRole("tab", {name:"Publish", exact:true}).click();
      await changed("siteRevoke", `/projects/${projectId}/sites/${site.id}/editions/${edition.active_edition.id}/revoke`, "POST",
        () => siteCard.getByRole("button", {name:"Revoke public edition", exact:true}).click());
    }
    const after = await context.newPage();
    for (const url of [publicUrl, zipUrl]) {
      const response = await after.goto(url);
      assert.ok([404,410].includes(response.status()), "Revoked public HTML and ZIP must be unavailable");
    }
    await after.close();
    assert.ok(!requests.some(item => item.status >= 500), "No local API server failure");
    await checkpoint("public-edition-revoked", {status:"passed", publicDeliveryRevoked:true,
      nativeSourceEditSaveReopen:true, portableBrowserWithoutGeoNode:true});
    return facts;
  } catch (error) {
    facts.status = "failed";
    facts.failure = {type:error.name, message:String(error.message).slice(0, 1_200), url:page.url()};
    await persist();
    throw error;
  }
}
