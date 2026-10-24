import assert from "node:assert/strict";
import {existsSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {initializeIntegratedStudioSession} from "./integrated-studio-built-shell.mjs";

// The existing development runner owns the browser, API and database. This
// selected journey uses normal Services/Catalog controls and real local rows.
export async function exerciseDevelopmentPostgis({page, context, origin, organization,
  work, apiRequest, readApi, requests, errors}) {
  const ready = JSON.parse(readFileSync(join(work, "postgis-fixture-ready.json"), "utf8"));
  assert.equal(ready.schemaVersion, "opengeo.local-postgis-fixture-ready.1");
  assert.equal(ready.organizationId, organization);
  assert.equal(ready.viewerId, "20000000-0000-4000-8000-000000000002");
  assert.equal(ready.sourceRows, 123);
  for (const key of ["projectId", "connectionId", "ownerId", "viewerId"]) {
    assert.match(ready[key], /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  }
  const proofPath = join(work, "postgis-browser-proof.json");
  const prior = existsSync(proofPath) ? JSON.parse(readFileSync(proofPath, "utf8")) : null;
  const retainedRequests = prior
    ? JSON.parse(readFileSync(join(work, "postgis-attempt-1-requests.json"), "utf8")) : [];
  const facts = prior ?? {mode: "external-postgis-connected-browser", status: "running",
    projectId: ready.projectId, connectionId: ready.connectionId, sourceRows: ready.sourceRows,
    scope: "Compiled Studio and real local API/SQL/connector; synthetic identity, secret and cloud transport.",
    notProven: ["configured provider DNS/TLS", "AWS transport", "deployment", "independent operator"]};
  const checkpoint = () => writeFileSync(proofPath, JSON.stringify(facts, null, 2) + "\n");
  const counters = () => JSON.parse(readFileSync(join(work, "postgis-fixture-result.json"), "utf8"));
  const requestStart = requests.length;
  let viewer;
  if (prior) {
    assert.equal(prior.mode, "external-postgis-connected-browser");
    assert.equal(prior.status, "failed");
    assert.equal(prior.projectId, ready.projectId);
    assert.equal(prior.connectionId, ready.connectionId);
    assert.match(prior.datasetId, /^[0-9a-f-]{36}$/);
    assert.match(prior.discoveryId, /^[0-9a-f-]{36}$/);
    assert.equal(prior.sourceVersion, 1);
    assert.equal(prior.layerCreated, true);
    assert.match(prior.error, /Open Catalog Layer/);
    for (const key of ["owner", "viewer", "viewerRevocation", "resume"]) assert.equal(prior[key], undefined,
      "Only the observed post-registration, pre-preview failure can continue");
    const retained = counters();
    assert.equal(retained.catalogExecutionCount, 1);
    assert.equal(retained.secretReadCount, 1);
    assert.equal(retained.previewInvocationCount, 0);
    assert.equal(retained.featureExecutionCount, 0);
    const committedWrites = retainedRequests.filter(request => request.method === "POST");
    assert.equal(committedWrites.length, 2);
    assert.equal(committedWrites.filter(request => request.path.endsWith("/catalog-discoveries") && request.status < 300).length, 1);
    assert.equal(committedWrites.filter(request => request.path.endsWith("/layers") && request.status < 300).length, 1);
    facts.previousFailure = {error: prior.error, retainedApiRequests: retainedRequests.length,
      committedWrites: committedWrites.map(({method, path, status}) => ({method, path, status}))};
    delete facts.error;
    facts.resume = {from: "Committed discovery and Layer registration before first preview",
      rediscoveryRequested: false, registrationReplayed: false};
    facts.status = "running";
  }
  checkpoint();
  try {
    const mapsBefore = await readApi(`/projects/${ready.projectId}/maps`);
    assert.deepEqual(mapsBefore, [], "Database inspection starts without a Project composition");
    let layerUrl;
    if (prior) {
      const discoveryPath = `/projects/${ready.projectId}/connections/${ready.connectionId}/catalog-discoveries/${facts.discoveryId}`;
      const discovery = await readApi(discoveryPath);
      assert.equal(discovery.discovery_id, facts.discoveryId);
      assert.equal(discovery.state, "completed");
      const source = await readApi(`/projects/${ready.projectId}/datasets/${facts.datasetId}/source`);
      assert.equal(source.dataset_id, facts.datasetId);
      assert.equal(source.project_id, ready.projectId);
      assert.equal(source.source_type, "postgis");
      assert.equal(source.version_number, facts.sourceVersion);
      assert.equal(source.configuration.connection_id, ready.connectionId);
      assert.equal(source.configuration.catalog_discovery_id, facts.discoveryId);
      assert.equal(source.configuration.schema_name, ready.schemaName);
      assert.equal(source.configuration.relation_name, ready.relationName);
      assert.equal(source.configuration.geometry_column, ready.geometryColumn);
      assert.equal(source.configuration.stable_key, ready.stableKey);
      layerUrl = new URL(`/layers?id=${facts.datasetId}`, origin);
      facts.resume.exactSourceAndDiscoveryReadback = true;
      checkpoint();
      await page.goto(layerUrl.href);
    } else {
    await page.goto(`${origin}/workspaces?project=${ready.projectId}&manage=services`);
    const databases = page.locator(".external-database-catalog");
    await databases.locator(":scope > summary").click();
    await databases.getByRole("button", {name: "Load database connections", exact: true}).click();
    const reload = databases.getByRole("button", {name: "Reload database connections", exact: true});
    await reload.waitFor();
    await databases.getByLabel("Database connection", {exact: true}).selectOption(ready.connectionId);
    await databases.getByRole("button", {name: "Check connection status", exact: true}).click();
    const discover = databases.getByRole("button", {name: "Discover database catalog", exact: true});
    await discover.waitFor();
    if (!ready.discoveryId) {
      const submitted = page.waitForResponse(response => response.request().method() === "POST"
        && new URL(response.url()).pathname.endsWith(`/connections/${ready.connectionId}/catalog-discoveries`));
      await discover.click();
      const response = await submitted;
      assert.ok([200, 201, 202].includes(response.status()));
      const discovery = await response.json();
      facts.discoveryId = discovery.discovery_id;
    } else {
      facts.discoveryId = ready.discoveryId;
      await databases.getByLabel("Catalog discovery", {exact: true}).selectOption(ready.discoveryId);
    }
    const discoveryChecked = page.waitForResponse(response => response.request().method() === "GET"
      && new URL(response.url()).pathname.endsWith(`/catalog-discoveries/${facts.discoveryId}`));
    await databases.getByRole("button", {name: "Check selected discovery", exact: true}).click();
    assert.equal((await (await discoveryChecked).json()).state, "completed");
    const relation = `${ready.schemaName}.${ready.relationName}`;
    const layerName = databases.getByLabel(`Layer name for ${relation}`, {exact: true});
    await layerName.waitFor();
    const form = layerName.locator("xpath=ancestor::form");
    await layerName.fill("PostGIS browser acceptance");
    await form.getByLabel(`Geometry for ${relation}`, {exact: true}).selectOption(ready.geometryColumn);
    const registered = page.waitForResponse(response => response.request().method() === "POST"
      && new URL(response.url()).pathname.endsWith("/layers"));
    await form.getByRole("button", {name: "Register Catalog Layer", exact: true}).click();
    const registrationResponse = await registered;
    assert.ok([200, 201].includes(registrationResponse.status()));
    const registration = await registrationResponse.json();
    facts.datasetId = registration.dataset_id;
    facts.sourceVersion = registration.source_version;
    facts.layerCreated = registration.created;
    // Registration replaces the form's input fields. Keep the success locator
    // rooted in the surviving relation page, rather than the removed name input.
    const open = databases.locator(".database-relation-page").getByRole("link", {name: "Open Catalog Layer", exact: true});
    await open.waitFor();
    layerUrl = new URL(await open.getAttribute("href"), origin);
    assert.equal(layerUrl.pathname, "/layers");
    assert.equal(layerUrl.searchParams.get("id"), facts.datasetId);
    await open.click();
    }
    facts.owner = await previewLayer(page, "owner");
    await page.screenshot({path: join(work, "postgis-owner-preview.png"), fullPage: true});

    viewer = await context.newPage();
    viewer.setDefaultTimeout(15_000);
    viewer.on("pageerror", error => errors.push(error.message));
    await viewer.addInitScript(initializeIntegratedStudioSession, {organization, actor: "reviewer"});
    await viewer.goto(layerUrl.href);
    await viewer.locator(".layer-resource").waitFor();
    const viewerConnection = await viewer.evaluate(async ({path, organization}) => {
      const response = await fetch(`/api${path}`, {headers: {
        authorization: `Bearer ${sessionStorage.getItem("opengeo.accessToken")}`,
        "x-opengeo-organization": organization}});
      return {status: response.status, body: response.status === 200 ? await response.json() : null};
    }, {path: `/projects/${ready.projectId}/connections/${ready.connectionId}`, organization});
    assert.ok([200, 403, 404].includes(viewerConnection.status));
    if (viewerConnection.status === 200) {
      assert.equal(viewerConnection.body.capabilities.manage, false, "Viewer can inspect redacted metadata without connection management");
      for (const field of ["credentials", "username", "password", "secret_reference", "secret_arn"]) {
        assert.equal(Object.hasOwn(viewerConnection.body, field), false);
      }
    }
    facts.viewerWithoutConnectionManage = {metadataStatus: viewerConnection.status, manage: false,
      credentialsAbsent: true};
    facts.viewer = await previewLayer(viewer, "viewer");
    await viewer.screenshot({path: join(work, "postgis-viewer-preview.png"), fullPage: true});
    const beforeRevocation = counters();
    assert.equal(beforeRevocation.catalogExecutionCount, 1);
    assert.equal(beforeRevocation.featureExecutionCount, 2);
    assert.equal(beforeRevocation.secretReadCount, 3);
    assert.equal(beforeRevocation.featureWireRows, 202);
    assert.equal(beforeRevocation.namedCursors, 2);
    assert.deepEqual(beforeRevocation.featureReadSizes, [101, 101]);

    const revoked = await apiRequest(`/projects/${ready.projectId}/memberships/${ready.viewerId}`, {
      method: "DELETE", headers: {authorization: "Bearer synthetic-local-owner", "x-opengeo-organization": organization}});
    assert.ok([200, 204].includes(revoked.status), "Owner removes only the fixture's project viewer grant");
    facts.viewerRevocation = {method: "Authenticated existing project-membership API", status: revoked.status,
      organizationMembershipPreserved: true};
    const denied = viewer.waitForResponse(response => response.request().method() === "GET"
      && new URL(response.url()).pathname.endsWith(`/datasets/${facts.datasetId}`));
    await viewer.reload();
    const denialStatus = (await denied).status();
    assert.ok([403, 404].includes(denialStatus));
    await viewer.getByRole("heading", {name: "Resource unavailable", exact: true}).waitFor();
    assert.equal(await viewer.getByRole("button", {name: "Open map", exact: true}).count(), 0);
    const afterRevocation = counters();
    assert.equal(afterRevocation.secretReadCount, beforeRevocation.secretReadCount);
    assert.equal(afterRevocation.featureExecutionCount, beforeRevocation.featureExecutionCount);
    facts.viewerRevocation.denialStatus = denialStatus;
    facts.viewerRevocation.noFurtherSecretRead = true;
    facts.viewerRevocation.noFurtherFeatureExecution = true;
    assert.deepEqual(await readApi(`/projects/${ready.projectId}/maps`), mapsBefore);
    const currentRequests = requests.slice(requestStart);
    if (prior) assert.equal(currentRequests.filter(request => request.method === "POST"
      && (request.path.endsWith("/catalog-discoveries") || request.path.endsWith("/layers"))).length, 0,
      "Continuation never repeats committed discovery or Layer registration");
    const selectedRequests = [...retainedRequests, ...currentRequests];
    const writes = selectedRequests.filter(request => !["GET", "HEAD"].includes(request.method));
    const discoveryPath = `/projects/${ready.projectId}/connections/${ready.connectionId}/catalog-discoveries`;
    for (const request of writes) assert.ok(
      request.method === "POST" && (request.path === discoveryPath
        || request.path.startsWith(`${discoveryPath}/${facts.discoveryId}/relations/`) && request.path.endsWith("/layers")
        || request.path === `/datasets/${facts.datasetId}/postgis-preview`)
      || request.method === "DELETE" && request.path === `/projects/${ready.projectId}/memberships/${ready.viewerId}`,
      `Unplanned mutation during database inspection: ${request.method} ${request.path}`);
    assert.equal(writes.filter(request => request.path.endsWith("/postgis-preview")).length, 2);
    assert.equal(writes.filter(request => request.path.endsWith("/layers")).length, 1);
    assert.ok(writes.filter(request => request.path === discoveryPath).length <= 1);
    facts.noProjectCompositionCreated = true;
    facts.noSourceCopyOrProjectSaveRequested = true;
    facts.counters = {secretReadCount: afterRevocation.secretReadCount,
      catalogExecutionCount: afterRevocation.catalogExecutionCount,
      featureExecutionCount: afterRevocation.featureExecutionCount,
      featureWireRows: afterRevocation.featureWireRows, featureReadSizes: afterRevocation.featureReadSizes,
      namedCursors: afterRevocation.namedCursors,
      managedRowsBaseline: afterRevocation.managedRowsBaseline};
    facts.apiRequests = selectedRequests.length;
    facts.currentAttemptApiRequests = currentRequests.length;
    facts.allowedMutations = writes.map(({method, path, status}) => ({method, path, status}));
    assert.deepEqual(errors, []);
    facts.status = "pass";
    checkpoint();
    return facts;
  } catch (error) {
    facts.status = "failed";
    facts.error = error.stack;
    checkpoint();
    throw error;
  } finally {
    await viewer?.close();
  }

  async function previewLayer(target, actor) {
    const responseReady = target.waitForResponse(response => response.request().method() === "POST"
      && new URL(response.url()).pathname.endsWith(`/datasets/${facts.datasetId}/postgis-preview`));
    await target.getByRole("button", {name: "Open map", exact: true}).click();
    const response = await responseReady;
    assert.equal(response.status(), 200);
    const preview = await response.json();
    assert.equal(preview.datasetId, facts.datasetId);
    assert.equal(preview.sourceVersion, facts.sourceVersion);
    assert.equal(preview.limit, 100);
    assert.equal(preview.returned, 100);
    assert.equal(preview.truncated, true);
    assert.equal(preview.geojson.features.length, 100);
    assert.equal(preview.geojson.features[0].id, ready.expectedFirstId);
    assert.equal(preview.geojson.features[0].properties[ready.stableKey], ready.expectedFirstId);
    assert.equal(preview.geojson.features[0].properties[ready.numericColumn], ready.expectedFirstNumeric);
    assert.equal(preview.propertyEncodings[ready.stableKey], "int64:string");
    assert.equal(preview.propertyEncodings[ready.numericColumn], "numeric:string");
    const panel = target.locator(".catalog-layer-preview");
    await panel.getByText(/100 features.*bounded sample, not complete coverage/).waitFor();
    await panel.getByText(/More matching features were omitted/).waitFor();
    await panel.getByText(/Exact numeric values are represented as text:/).waitFor();
    assert.equal(await panel.getByRole("button", {name: "Save to Project…", exact: true}).count(), 0);
    // The provider refusal can activate the existing blank-background recovery
    // before this control is reached. Use the real control when still present.
    await target.waitForFunction(() => Boolean(document.querySelector(".catalog-layer-preview .map-frame")?.__opengeoMap));
    const basemap = await panel.evaluate(element => {
      const button = [...element.querySelectorAll("button")].find(control => control.textContent === "Use blank basemap");
      if (button) {button.click(); return "selected-blank";}
      return "provider-failure-recovery";
    });
    await target.waitForFunction(stableKey => {
      const map = document.querySelector(".catalog-layer-preview .map-frame")?.__opengeoMap;
      return map?.getLayer("preview-points") && map.isSourceLoaded("preview")
        && new Set(map.queryRenderedFeatures({layers: ["preview-points"]})
          .map(feature => String(feature.properties[stableKey]))).size === 100;
    }, ready.stableKey);
    const rendered = await panel.locator(".map-frame").evaluate((element, stableKey) => {
      const map = element.__opengeoMap;
      const features = map.queryRenderedFeatures({layers: ["preview-points"]});
      return {count: features.length, keys: [...new Set(features.map(feature => String(feature.properties[stableKey])))],
        sourceType: map.getStyle().sources.preview.type,
        blankBackground: map.getStyle().layers.some(layer => layer.id === "preview-background")};
    }, ready.stableKey);
    assert.equal(rendered.sourceType, "geojson");
    assert.equal(rendered.blankBackground, true);
    assert.ok(rendered.keys.includes(ready.expectedFirstId));
    assert.equal(rendered.keys.length, 100, "The real map renders all 100 bounded Point records");
    return {actor, returned: preview.returned, truncated: preview.truncated,
      firstId: preview.geojson.features[0].id, firstNumeric: preview.geojson.features[0].properties[ready.numericColumn],
      sourceVersion: preview.sourceVersion, connectionRevision: preview.connectionRevision,
      schemaFingerprint: preview.schemaFingerprint, bbox: preview.bbox,
      renderedPoints: rendered.count, distinctRenderedKeys: rendered.keys.length,
      basemap, noProjectSaveAction: true};
  }
}
