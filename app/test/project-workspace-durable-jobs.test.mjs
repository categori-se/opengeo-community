import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {afterEach, beforeEach, describe, it} from "node:test";
import {gzipSync} from "node:zlib";
import {JSDOM} from "jsdom";

import {ProjectWorkspacePage} from "../src/components/ProjectWorkspacePage.js";
import {StudioAccountControls} from "../src/components/StudioAccountControls.js";
import {definitionWithPrintLayouts, newProjectPrintLayout} from "../src/lib/printLayouts.js";
import {parseMap} from "../src/lib/apiClient.js";

const IDS = Object.freeze({
  organization: "10000000-0000-4000-8000-000000000001",
  user: "10000000-0000-4000-8000-000000000002",
  project: "10000000-0000-4000-8000-000000000003",
  map: "10000000-0000-4000-8000-000000000004",
  dataset: "10000000-0000-4000-8000-000000000005",
  version: "10000000-0000-4000-8000-000000000006",
  job: "10000000-0000-4000-8000-000000000007"
});

let harness;

beforeEach(() => {
  harness = installDom();
});

afterEach(async () => {
  await Promise.resolve();
  harness.restore();
  harness.dom.window.close();
  harness = null;
});

it("keeps the save indicator honest across pending edits, conflict, failure and Help recovery", async () => {
  const adapter = projectAdapter({kind: "managed"});
  let finishFirst, writes = 0;
  adapter.updateMap = async (_project, _map, update) => {
    const definition = structuredClone(update.changes.definition);
    writes++;
    if (writes === 1) return new Promise(resolve => {
      finishFirst = async () => resolve({...((await adapter.listMaps())[0]), version: 4, definition});
    });
    if (writes === 2) throw Object.assign(Error("version changed"), {status: 409});
    if (writes === 3) throw Error("temporarily unavailable");
    return {...((await adapter.listMaps())[0]), version: 5, definition};
  };
  const page = mountPage(adapter);
  try {
    const editor = await waitFor(() => page.querySelector(".opengeo-workbench"));
    const indicator = () => editor.querySelector('[aria-label="Project save status"]');
    clickButton(editor, "Save");
    await waitFor(() => finishFirst);
    assert.equal(indicator().dataset.state, "saving");
    editor.querySelector(".gis-theme-command").click();
    await finishFirst();
    await waitFor(() => editor.dataset.saveState === "saved");
    assert.equal(indicator().dataset.state, "unsaved", "The acknowledgement saved the earlier snapshot only");
    clickButton(editor, "Save");
    await waitFor(() => editor.dataset.saveState === "conflict");
    assert.match(indicator().textContent, /Save conflict/);
    clickButton(editor, "Help");
    clickButton(editor, "Task guides and recovery");
    assert.match(indicator().textContent, /Save conflict/, "Help status cannot erase the save outcome");
    assert.ok(editor.querySelector('a[href$="examples/esia-screening/README.md"]'));
    assert.match(editor.textContent, /check the Layer list before adding again/);
    clickButton(editor, "Save");
    await waitFor(() => editor.dataset.saveState === "error");
    assert.match(indicator().textContent, /Save failed/);
    clickButton(editor, "Save");
    await waitFor(() => editor.dataset.saveState === "saved");
    assert.equal(indicator().dataset.state, "saved");
    assert.match(indicator().textContent, /Saved to account · v5/);
    assert.equal(writes, 4, "Only deliberate Save clicks perform writes");
  } finally {page.dispose?.();page.remove();}
});

it("retains one registered native result through explicit readiness, exact-version Add, deliberate temporary removal and acknowledged Project reopening", async () => {
  const adapter = projectAdapter({kind: "managed"});
  adapter.organizationProvider = async () => IDS.organization;
  const derivedId = "80000000-0000-4000-8000-000000000001", derivedVersion = "83000000-0000-4000-8000-000000000001";
  const source = structuredClone((await adapter.listDatasets())[0]);
  let saved = structuredClone((await adapter.listMaps())[0]), registered = false, active = false, acknowledgeSave;
  let knowledge = {datasetId: derivedId, version: 0, document: {}}, knowledgeReads = 0;
  const counts = {request: 0, upload: 0, complete: 0, knowledgeSave: 0, collection: 0, analysis: 0, metadata: 0, preview: 0};
  const saves = [], previewPins = [];
  const collection = {type: "FeatureCollection", features: [{type: "Feature", properties: {}, geometry: {type: "Point", coordinates: [-71, 42]}}],
    "opengeo:analysis": {operation: "centroid", version: "1.0.0", sourceDatasetId: IDS.dataset, source_generation: 3,
      targetDatasetId: null, persisted: false, crs: "CRS:84"}};
  const derived = () => ({...source, id: derivedId, name: "Saved screening centers", sourceType: "upload", format: "geojson",
    status: active ? "active" : "processing", currentVersionId: derivedVersion, currentVersionNumber: 1,
    currentVersionState: active ? "active" : "queued", geometryType: "Point", featureCount: 1});
  adapter.listMaps = async () => [structuredClone(saved)];
  adapter.listDatasets = async () => [structuredClone(source), ...(registered ? [derived()] : [])];
  adapter.createMap = async () => assert.fail("Retention must save the existing Project");
  adapter.getFeatureCollection = async (projectId, datasetId) => {
    counts.collection++; assert.deepEqual([projectId, datasetId], [IDS.project, IDS.dataset]);
    return {datasetId, generation: 3, geometryType: "Polygon", featureCount: 1};
  };
  adapter.previewVectorAnalysis = async (projectId, datasetId, request) => {
    counts.analysis++; assert.deepEqual([projectId, datasetId], [IDS.project, IDS.dataset]);
    assert.equal(request.operation, "centroid"); assert.equal(request.source_generation, 3);
    return structuredClone(collection);
  };
  adapter.requestUpload = async (projectId, metadata) => {
    counts.request++; assert.equal(projectId, IDS.project); assert.equal(metadata.classification, "restricted");
    assert.equal(metadata.format, "geojson");
    return {dataset: {id: derivedId}, uploadId: derivedVersion, expiresAt: "2099-01-01T00:00:00Z", upload: {fixture: true}};
  };
  adapter.uploadFile = async (_upload, file) => {
    counts.upload++;
    assert.deepEqual(JSON.parse(await file.text()), {type: "FeatureCollection", features: collection.features});
  };
  adapter.completeUpload = async (projectId, uploadId) => {
    counts.complete++; assert.deepEqual([projectId, uploadId], [IDS.project, derivedVersion]); registered = true;
    return {dataset: {id: derivedId}, datasetVersionId: derivedVersion, versionNumber: 1};
  };
  adapter.getDatasetKnowledge = async datasetId => {knowledgeReads++; assert.equal(datasetId, derivedId); return structuredClone(knowledge);};
  adapter.saveDatasetKnowledge = async (datasetId, draft) => {
    counts.knowledgeSave++; assert.equal(datasetId, derivedId); assert.equal(draft.expectedVersion, 0);
    knowledge = {datasetId: derivedId, version: 1, document: structuredClone(draft.document)}; return structuredClone(knowledge);
  };
  adapter.getDataset = async (projectId, datasetId, {signal}) => {
    counts.metadata++; assert.deepEqual([projectId, datasetId], [IDS.project, derivedId]); assert.equal(signal.aborted, false);
    return derived();
  };
  adapter.getDatasetSpatialPreview = async (projectId, datasetId, versionId) => {
    counts.preview++; previewPins.push([projectId, datasetId, versionId]);
    assert.deepEqual([projectId, datasetId, versionId], [IDS.project, derivedId, derivedVersion]);
    return {datasetVersionId: versionId, numberReturned: 1, numberMatched: 1, mayBeTruncated: false,
      geojson: {type: "FeatureCollection", features: structuredClone(collection.features)}};
  };
  adapter.updateMap = async (projectId, mapId, update) => {
    assert.deepEqual([projectId, mapId, update.expectedVersion], [IDS.project, IDS.map, saved.version]);
    saves.push(structuredClone(update));
    if (saves.length === 1) throw Object.assign(Error("version changed"), {status: 409});
    if (saves.length === 3) {
      saved = {...saved, version: 5, definition: structuredClone(update.changes.definition)};
      return structuredClone(saved);
    }
    assert.equal(saves.length, 2, "Only deliberate retention Saves update the map");
    return new Promise(resolve => {acknowledgeSave = () => {
      saved = {...saved, version: 4, definition: structuredClone(update.changes.definition)};
      resolve(structuredClone(saved));
    };});
  };
  let page = mountPage(adapter, {startPanel: "processing"}), reopened;
  try {
    const editor = await waitFor(() => page.querySelector(".opengeo-workbench"));
    const layers = () => editor.__opengeoLayers;
    const savedLayers = () => layers().filter(layer => layer.datasetId === derivedId);
    const reopenLink = () => [...page.querySelectorAll("a")].find(link => link.textContent === "Reopen saved Project");
    await waitFor(() => findButton(page, "Preview analysis"));
    assert.equal(counts.metadata + counts.request + counts.analysis, 0);
    clickButton(page, "Preview analysis"); await waitFor(() => findButton(page, "Add preview to map"));
    clickButton(page, "Add preview to map");
    const temporary = layers().find(layer => layer.sourceType === "geojson-object"); assert.ok(temporary);
    const originalTitle = temporary.title;
    clickButton(page, "Save as catalog Layer");
    await waitFor(() => findButton(page, "Check saved Layer readiness"));
    assert.deepEqual([counts.request, counts.upload, counts.complete, counts.knowledgeSave], [1, 1, 1, 1]);
    assert.equal(counts.metadata, 0, "Registration and rendering do not refresh readiness");
    clickButton(page, "Check saved Layer readiness");
    await waitFor(() => counts.metadata === 1 && !findButton(page, "Check saved Layer readiness").disabled);
    assert.equal(findButton(page, "Add saved Layer to this Project").disabled, true);
    assert.match(page.textContent, /Processing is not ready/);
    active = true;
    clickButton(page, "Check saved Layer readiness");
    await waitFor(() => counts.metadata === 2 && !findButton(page, "Add saved Layer to this Project").disabled);
    const add = findButton(page, "Add saved Layer to this Project");
    add.click(); add.dispatchEvent(new harness.dom.window.Event("click"));
    await waitFor(() => savedLayers().length === 1 && !findButton(page, "Check saved Layer readiness").disabled);
    assert.equal(savedLayers()[0].datasetVersionId, derivedVersion); assert.equal(savedLayers()[0].sourceVersion, 1);
    assert.equal(counts.preview, 1); assert.equal(counts.metadata, 2);
    assert.equal(findButton(page, "Add saved Layer to this Project").disabled, true);
    assert.ok(layers().includes(temporary), "Adding the saved Layer preserves the temporary result");
    assert.equal(findButton(page, "Save this Project with retained result").disabled, true);
    const renameTemporary = title => {
      const style = page.querySelector(`[aria-label="Style ${temporary.title}"]`); assert.ok(style); style.click();
      const input = page.querySelector('[aria-label="Layer name"]'); assert.ok(input);
      input.value = title; input.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
      clickButton(page, "Processing"); clickButton(page, "Count features (browser)");
    };
    renameTemporary(`${originalTitle} edited`);
    assert.equal(temporary.title, `${originalTitle} edited`);
    const removeEdited = findButton(page, "Remove checked temporary result"); assert.ok(removeEdited); assert.equal(removeEdited.disabled, true);
    removeEdited.dispatchEvent(new harness.dom.window.Event("click"));
    assert.ok(layers().includes(temporary), "Edited temporary data is preserved even if its disabled handler is dispatched");
    await waitFor(() => !findButton(page, "Check saved Layer readiness").disabled);
    renameTemporary(originalTitle);
    assert.equal(findButton(page, "Remove checked temporary result").disabled, false);
    clickButton(page, "Remove checked temporary result");
    await waitFor(() => !layers().includes(temporary) && !findButton(page, "Save this Project with retained result").disabled);
    assert.equal(savedLayers().length, 1); assert.equal(layers().length, 2);
    clickButton(page, "Save this Project with retained result");
    await waitFor(() => editor.dataset.saveState === "conflict" && !findButton(page, "Save this Project with retained result").disabled);
    assert.equal(saves.length, 1); assert.equal(reopenLink(), undefined);
    assert.equal(savedLayers().length, 1); assert.ok(findButton(page, "Check saved Layer readiness"));
    assert.deepEqual([counts.request, counts.upload, counts.complete, counts.knowledgeSave], [1, 1, 1, 1]);
    clickButton(page, "Save this Project with retained result"); await waitFor(() => acknowledgeSave);
    assert.equal(editor.dataset.saveState, "saving"); assert.equal(reopenLink(), undefined);
    assert.equal(saved.version, 3, "No reopening claim precedes the actual map acknowledgement");
    acknowledgeSave(); await waitFor(() => editor.dataset.saveState === "saved" && reopenLink());
    assert.equal(saved.version, 4); assert.deepEqual(saves[1].changes.definition, saves[0].changes.definition);
    const retained = saved.definition.layers.filter(layer => layer.datasetId === derivedId);
    assert.equal(retained.length, 1); assert.equal(retained[0].datasetVersionId, derivedVersion);
    assert.equal(saved.definition.layers.some(layer => layer.layerId === temporary.layerId), false);
    assert.ok(reopenLink().href.includes(IDS.map));
    page.dispose(); page.remove(); page = null;
    reopened = mountPage(adapter, {mapId: IDS.map, startPanel: "processing"});
    const fresh = await waitFor(() => reopened.querySelector(".opengeo-workbench"));
    await waitFor(() => counts.preview === 2);
    assert.deepEqual(fresh.__opengeoLayers.map(layer => [layer.layerId, layer.datasetId, layer.datasetVersionId ?? null]),
      saved.definition.layers.map(layer => [layer.layerId, layer.datasetId, layer.datasetVersionId ?? null]));
    assert.equal(fresh.__opengeoLayers.filter(layer => layer.datasetId === derivedId).length, 1);
    assert.equal(fresh.__opengeoLayers.some(layer => layer.layerId === temporary.layerId), false);
    assert.deepEqual(previewPins, [[IDS.project, derivedId, derivedVersion], [IDS.project, derivedId, derivedVersion]]);
    assert.deepEqual([counts.request, counts.upload, counts.complete, counts.knowledgeSave, counts.collection, counts.analysis, counts.metadata, saves.length],
      [1, 1, 1, 1, 1, 1, 2, 2], "Reopening reuses registration and the acknowledged existing Project");
    const priorKnowledgeReads = knowledgeReads;
    const existingLayers = [...fresh.__opengeoLayers];
    assert.ok(findButton(reopened, "Resume saved result"), "A fresh account Project exposes a normal durable continuation entry");
    clickButton(reopened, "Resume saved result");
    await waitFor(() => findButton(reopened, "Check saved Layer readiness"));
    assert.equal(knowledgeReads, priorKnowledgeReads + 1, "Resume deliberately reads the existing committed metadata once");
    assert.equal(counts.metadata, 3, "Resume validates the exact current dataset version once");
    assert.match(fresh.textContent, /The exact saved Layer is already in this Project/);
    assert.match(fresh.textContent, /No temporary result was restored/);
    assert.equal(findButton(reopened, "Add saved Layer to this Project").disabled, true);
    assert.equal(findButton(reopened, "Remove checked temporary result"), null);
    assert.deepEqual(fresh.__opengeoLayers, existingLayers, "Resuming preserves every existing Layer and its edits");
    clickButton(reopened, "Check saved Layer readiness");
    await waitFor(() => !findButton(reopened, "Check saved Layer readiness").disabled);
    assert.equal(counts.metadata, 4, "Only the separate deliberate readiness action refreshes again");
    clickButton(reopened, "Save this Project with retained result");
    await waitFor(() => fresh.dataset.saveState === "saved" && [...reopened.querySelectorAll("a")].some(link => link.textContent === "Reopen saved Project"));
    assert.equal(saved.version, 5); assert.equal(saves.length, 3);
    assert.deepEqual(saved.definition.layers.map(layer => [layer.layerId, layer.datasetVersionId]),
      existingLayers.map(layer => [layer.layerId, layer.datasetVersionId]));
    reopened.dispose(); reopened.remove(); reopened = mountPage(adapter, {mapId: IDS.map, startPanel: "processing"});
    const resumedFresh = await waitFor(() => reopened.querySelector(".opengeo-workbench"));
    await waitFor(() => counts.preview === 3);
    assert.equal(resumedFresh.__opengeoLayers.filter(layer => layer.datasetId === derivedId && layer.datasetVersionId === derivedVersion).length, 1);
    assert.equal(resumedFresh.__opengeoLayers.some(layer => layer.layerId === temporary.layerId), false);
    assert.ok(findButton(reopened, "Resume saved result"), "The entry survives another actual account-component reload");
    assert.deepEqual([counts.request, counts.upload, counts.complete, counts.knowledgeSave, counts.collection, counts.analysis, counts.metadata, saves.length],
      [1, 1, 1, 1, 1, 1, 4, 3], "Durable resume, Save and reopen do not replay upload, registration, analysis or readiness");
  } finally {page?.dispose?.(); page?.remove(); reopened?.dispose?.(); reopened?.remove();}
});

describe("project durable-job hydration", () => {
  it("identifies publication loading and gives a stalled request a bounded recovery", async () => {
    const originalTimeout = globalThis.setTimeout;
    let deadline, sessionSignal;
    globalThis.setTimeout = (callback, milliseconds, ...args) => {
      if (milliseconds === 90_000) {deadline = callback; return originalTimeout(() => {}, 90_000);}
      return originalTimeout(callback, milliseconds, ...args);
    };
    let page;
    try {
      const adapter = projectAdapter({kind: "managed"});
      adapter.getSession = ({signal}) => {sessionSignal = signal; return new Promise(() => {});};
      page = ProjectWorkspacePage({adapter, publicationId: "10000000-0000-4000-8000-000000000009"});
      document.body.append(page);
      assert.equal(page.querySelector("h2").textContent, "Loading publication");
      assert.equal(page.querySelector('[aria-current="page"]').textContent, "Publications");
      assert.ok(deadline);
      await waitFor(() => sessionSignal);
      deadline();
      assert.equal(sessionSignal.aborted, true);
      assert.match(page.textContent, /temporarily unavailable/);
      assert.ok([...page.querySelectorAll("button")].some(button => /Retry/i.test(button.textContent)));
    } finally {page?.dispose(); page?.remove(); globalThis.setTimeout = originalTimeout;}
  });

  it("revalidates retained editors without rebuilding and refuses changed authority or data", async () => {
    const adapter = projectAdapter({kind: "managed"});
    adapter.getComposition = async () => ({id: IDS.map, resourceType: "project", accessContainerId: IDS.project});
    const page = mountPage(adapter, {compositionId: IDS.map});
    const editor = await waitFor(() => page.querySelector(".opengeo-workbench"));
    let releases = 0, resumes = 0;
    editor.releaseRendererCredentials = () => {releases++;};
    editor.resumeRenderer = async () => {resumes++; return true;};
    const check = () => page.canResume({signal: new AbortController().signal});
    assert.equal(await check(), true);
    assert.equal(page.querySelector(".opengeo-workbench"), editor);
    const session = adapter.getSession;
    adapter.getSession = async (...args) => ({...await session(...args), userId: "different-user"});
    assert.equal(await check(), false);
    assert.equal(releases, 1);
    assert.equal(resumes, 1, "Changed authority cannot restart an optional renderer");
    adapter.getSession = session;
    const project = adapter.getProject;
    adapter.getProject = async (...args) => ({...await project(...args), callerRole: "viewer"});
    assert.equal(await check(), false);
    adapter.getProject = project;
    const datasets = adapter.listDatasets;
    adapter.listDatasets = async () => [];
    assert.equal(await check(), false);
    adapter.listDatasets = datasets;
    assert.equal(await check(), true);
    assert.equal(resumes, 2);
    assert.equal(page.querySelector(".opengeo-workbench"), editor);
    page.dispose();
    assert.equal(await check(), false);
    page.remove();
  });

  it("resumes the retained editor after its own map save and still denies revoked access", async () => {
    const adapter = projectAdapter({kind: "managed"});
    let savedMap = {...structuredClone((await adapter.listMaps())[0]), ownerUserId: IDS.user,
      description: null, createdAt: "2026-08-29T12:00:00Z"}, writes = 0, acknowledgement;
    const rawMapResponse = () => ({id: savedMap.id, project_id: savedMap.projectId, name: savedMap.name,
      description: savedMap.description, status: savedMap.status, definition: structuredClone(savedMap.definition),
      version: savedMap.version, created_at: savedMap.createdAt, updated_at: savedMap.updatedAt});
    adapter.baseUrl = "/api";
    adapter.tokenProvider = () => "same-user-token";
    adapter.organizationProvider = () => IDS.organization;
    adapter.getComposition = async () => ({...parseMap({...rawMapResponse(), owner_user_id: savedMap.ownerUserId}),
      accessContainerId: IDS.project, resourceType: "project"});
    adapter.updateMap = async (projectId, mapId, update) => {
      assert.deepEqual([projectId, mapId, update.expectedVersion], [IDS.project, IDS.map, 3]);
      writes++;
      savedMap = {...savedMap, version: 4, definition: structuredClone(update.changes.definition), updatedAt: "2026-10-24T18:00:00Z"};
      const response = rawMapResponse();
      assert.equal(Object.hasOwn(response, "owner_user_id"), false, "Legacy MapResponse omits ownership");
      acknowledgement = parseMap(response);
      return acknowledgement;
    };
    const page = mountPage(adapter, {compositionId: IDS.map});
    try {
      const editor = await waitFor(() => page.querySelector(".opengeo-workbench"));
      let releases = 0, resumes = 0;
      editor.releaseRendererCredentials = () => {releases++;};
      editor.resumeRenderer = async () => {resumes++; return true;};
      clickButton(editor, "Save");
      await waitFor(() => editor.dataset.saveState === "saved");
      assert.equal(writes, 1);
      assert.equal(savedMap.version, 4);
      assert.equal(acknowledgement.ownerUserId, null, "The actual parser synthesizes null for omitted ownership");
      assert.equal((await adapter.getComposition()).ownerUserId, IDS.user);
      assert.equal(Object.hasOwn(acknowledgement, "resourceType"), false, "Save returns a MapRecord, not the authored composition wrapper");
      const check = () => page.canResume({signal: new AbortController().signal});
      assert.equal(await check(), true, "The editor's acknowledged save must become its retained baseline");
      assert.equal(page.querySelector(".opengeo-workbench"), editor);
      assert.deepEqual([releases, resumes], [0, 1]);
      savedMap.ownerUserId = IDS.job;
      assert.equal(await check(), false, "A fresh ownership change must still invalidate the retained editor");
      assert.deepEqual([releases, resumes], [1, 1]);
      savedMap.ownerUserId = IDS.user;
      adapter.getProject = async () => {throw {status: 403};};
      assert.equal(await check(), false);
      assert.equal(page.resumeStatus, "forbidden");
      assert.deepEqual([releases, resumes], [2, 1], "Revocation must release credentials without resuming the renderer");
      assert.equal(writes, 1, "Access revalidation cannot replay the save");
    } finally {page.dispose(); page.remove();}
  });

  it("stops abandoned startup before account/project reads or retries continue", async () => {
    const adapter = projectAdapter({kind: "managed"});
    let release, signal, followups = 0;
    adapter.getSession = options => {
      signal = options.signal;
      return new Promise(resolve => {release = resolve;});
    };
    adapter.getCurrentOrganization = async () => {followups++; throw Error("abandoned load");};
    adapter.listProjects = async () => {followups++; throw Error("abandoned load");};
    const page = ProjectWorkspacePage({adapter, projectId: IDS.project});
    document.body.append(page);
    const before = page.textContent;
    page.dispose();
    assert.equal(signal.aborted, true);
    release({selectedOrganizationId: IDS.organization, memberships: [{organizationId: IDS.organization}]});
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(followups, 0);
    assert.equal(page.textContent, before);
    page.remove();
  });

  it("protects Project metadata from actual account controls outside the workspace", async () => {
    const adapter = projectAdapter({kind: "managed"});
    adapter.getComposition = async () => ({id: IDS.map, resourceType: "project", accessContainerId: IDS.project});
    const knowledge = {schemaVersion: "1.0.0", distributions: [], metadata: {source: [], normalized: [], curated: [], inferred: []}, context: []};
    let revision = 0, saves = 0, signouts = 0, mapWrites = 0;
    adapter.getAuthoredKnowledge = async (kind, id) => {
      assert.equal(kind, "project"); assert.equal(id, IDS.map);
      return {version: revision, canEdit: true, document: structuredClone(knowledge)};
    };
    adapter.saveAuthoredKnowledge = async (kind, id, payload) => {
      assert.equal(kind, "project"); assert.equal(id, IDS.map); assert.equal(payload.expectedVersion, revision);
      saves++; revision++; Object.assign(knowledge, payload.document);
      return {version: revision, canEdit: true, document: structuredClone(knowledge)};
    };
    adapter.updateMap = async () => {mapWrites++; throw Error("Metadata must not save map content");};
    const controls = StudioAccountControls({signedIn: true, auth: {signOut: async () => {signouts++;}}, hasUnsavedChanges: () => false});
    document.body.append(controls);
    const page = mountPage(adapter, {compositionId: IDS.map});
    const metadata = await waitFor(() => page.querySelector(".authored-resource-metadata"));
    metadata.open = true; metadata.dispatchEvent(new harness.dom.window.Event("toggle"));
    metadata.querySelector("button").click();
    const input = await waitFor(() => metadata.querySelector('[aria-label="Metadata JSON"]'));
    const draft = structuredClone(knowledge);
    draft.metadata.curated.push({subject: "resource", property: "http://purl.org/dc/terms/license", value: null, provenance: "unknown"});
    input.value = JSON.stringify(draft); input.dispatchEvent(new harness.dom.window.Event("input", {bubbles: true}));
    clickButton(controls, "Sign out");
    assert.equal(signouts, 0); assert.equal(controls.querySelector("dialog").open, false);
    assert.equal(input.value, JSON.stringify(draft));
    clickButton(metadata, "Save metadata revision");
    await waitFor(() => metadata.textContent.includes("Saved metadata revision 1"));
    clickButton(controls, "Sign out"); await waitFor(() => signouts === 1);
    assert.equal(saves, 1); assert.equal(mapWrites, 0);
    page.remove(); controls.remove();
  });

  it("supplies only the selected saved composition's Layer context before separate metadata loads", async () => {
    const adapter = projectAdapter({kind: "wms"});
    const map = {...(await adapter.listMaps())[0], description: "A saved regional comparison."};
    map.definition.layers[0] = {...map.definition.layers[0], sourceVersion: 2,
      sourceUrl: "https://example.org/saved/wms", attribution: "Saved MassGIS attribution"};
    adapter.getComposition = async () => ({...map, resourceType: "project", accessContainerId: IDS.project});
    const dataset = (await adapter.listDatasets())[0];
    adapter.listDatasets = async () => [dataset, {...dataset, id: IDS.job, name: "Unrelated container Layer"}];
    let reads = 0;
    adapter.getAuthoredKnowledge = async (kind, id) => {
      reads++;assert.equal(kind, "project");assert.equal(id, IDS.map);
      return {version: 0, canEdit: false, document: {schemaVersion: "1.0.0", distributions: [],
        metadata: {source: [], normalized: [], curated: [], inferred: []}, context: []}};
    };
    const page = mountPage(adapter, {compositionId: IDS.map});
    const metadata = await waitFor(() => page.querySelector(".authored-resource-metadata"));
    metadata.open = true;metadata.dispatchEvent(new harness.dom.window.Event("toggle"));
    assert.equal(reads, 1);
    metadata.dispatchEvent(new harness.dom.window.Event("toggle"));assert.equal(reads, 1);
    const overview = metadata.querySelector(".project-metadata-context");
    assert.match(overview.textContent, /Durable jobs map/);assert.match(overview.textContent, /A saved regional comparison/);
    assert.match(overview.textContent, /saved source revision 2/);assert.match(overview.textContent, /Saved MassGIS attribution/);
    assert.doesNotMatch(overview.textContent, /Unrelated container Layer/);
    assert.equal(overview.querySelector('[aria-label="Layers in this Project"]').children.length, 1);
    assert.equal(overview.querySelector("a").getAttribute("href"), `/layers?id=${IDS.dataset}`);
    await waitFor(() => metadata.textContent.includes("No Project-specific metadata revision yet"));
    assert.match(metadata.textContent, /No Project-specific metadata revision yet/);
    page.dispose();page.remove();
  });

  it("opens Print Studio for the exact selected composition without a Publication or automatic save", async () => {
    const adapter = projectAdapter({kind: "managed"});
    const map = (await adapter.listMaps())[0];let writes = 0, sites = 0;
    adapter.getComposition = async () => ({...map, resourceType: "project", accessContainerId: IDS.project});
    adapter.updateMap = async () => {writes++;throw Error("Opening Print Studio must not save");};
    adapter.listSites = async () => {sites++;return [];};
    const page = mountPage(adapter, {compositionId: IDS.map, managementTarget: "print"});
    const studio = await waitFor(() => page.querySelector(".project-print-editor"));
    assert.equal(studio.querySelector("h2").textContent, "Print Studio");assert.match(studio.textContent, /Durable jobs map/);
    assert.ok(studio.querySelector('[aria-label="Layout title"]'));
    assert.doesNotMatch(studio.textContent, /Open Publishing|Live API adapter|PostgreSQL-backed/);
    assert.equal(writes, 0);assert.equal(sites, 0);assert.equal(studio.hasUnsavedChanges(), false);
    page.dispose();page.remove();
  });

  it("starts a new Print layout from the current scoped Layer presentation while isolating Print drafts", async () => {
    const adapter = projectAdapter({kind: "managed"}), original = (await adapter.listMaps())[0];
    adapter.getComposition = async () => ({...original, resourceType: "project", accessContainerId: IDS.project});
    const key = `opengeo.project.${IDS.project}.${IDS.organization}:${IDS.user}:${IDS.map}`;
    const draft = {...original.definition, extensions: {opengeoRenderer: {id: "cesium"}},
      layers: original.definition.layers.map(layer => ({...layer, opacity: 0.25, visible: false})),
      mapViews: [{id: "draft", title: "Current view", center: [-70, 43], zoom: 8, pitch: 0, bearing: 20}]};
    const bytes = JSON.stringify(draft);localStorage.setItem(key, bytes);
    const page = mountPage(adapter, {compositionId: IDS.map, managementTarget: "print"});
    const view = await waitFor(() => page.querySelector(".project-print-editor .opengeo-workbench"));
    assert.equal(view.__opengeoLayers[0].opacity, 0.25);assert.equal(view.__opengeoLayers[0].visible, false);
    assert.equal(view.getPrintContext().project.extensions.opengeoRenderer.id, "maplibre");
    assert.equal(view.saveDraftForNavigation(), true);
    assert.equal(localStorage.getItem(key), bytes, "Print edits must not replace the ordinary map draft");
    assert.ok(localStorage.getItem(key + ":print"));
    page.dispose();page.remove();
  });

  it("keeps saved Print frames authoritative over an ordinary map draft", async () => {
    const adapter = projectAdapter({kind: "managed"}), original = (await adapter.listMaps())[0];
    const layout = newProjectPrintLayout(original);layout.frames[0].presentation[0].opacity = 0.8;
    const saved = {...original, definition: definitionWithPrintLayouts(original, {schemaVersion: "opengeo.project-print-layouts.1", projectId: original.id, layouts: [layout]})};
    adapter.getComposition = async () => ({...saved, resourceType: "project", accessContainerId: IDS.project});
    localStorage.setItem(`opengeo.project.${IDS.project}.${IDS.organization}:${IDS.user}:${IDS.map}`,
      JSON.stringify({...original.definition, layers: original.definition.layers.map(layer => ({...layer, opacity: 0.25}))}));
    const page = mountPage(adapter, {compositionId: IDS.map, managementTarget: "print"});
    const view = await waitFor(() => page.querySelector(".project-print-editor .opengeo-workbench"));
    assert.equal(view.__opengeoLayers[0].opacity, 0.8);
    page.dispose();page.remove();
  });

  it("ignores current-view Print presentation from a different source version", async () => {
    const adapter = projectAdapter({kind: "managed"}), original = (await adapter.listMaps())[0];
    adapter.getComposition = async () => ({...original, resourceType: "project", accessContainerId: IDS.project});
    localStorage.setItem(`opengeo.project.${IDS.project}.${IDS.organization}:${IDS.user}:${IDS.map}`,
      JSON.stringify({...original.definition, layers: original.definition.layers.map(layer => ({...layer, sourceVersion: 999, opacity: 0.25}))}));
    const page = mountPage(adapter, {compositionId: IDS.map, managementTarget: "print"});
    const view = await waitFor(() => page.querySelector(".project-print-editor .opengeo-workbench"));
    assert.equal(view.__opengeoLayers[0].opacity, original.definition.layers[0].opacity);
    page.dispose();page.remove();
  });

  it("isolates drafts across sibling Projects and keeps publication previews on saved state", async () => {
    const adapter = projectAdapter({kind: "managed"});
    const original = (await adapter.listMaps())[0];
    const sibling = {...structuredClone(original), id: IDS.job, name: "Sibling Project"};
    adapter.listMaps = async () => [original, sibling];
    const legacyKey = `opengeo.project.${IDS.project}`;
    const scopedKey = `${legacyKey}.${IDS.organization}:${IDS.user}:${IDS.map}`;
    const draft = {...original.definition, layers: original.definition.layers.map(layer => ({...layer, opacity: 0.25}))};
    localStorage.setItem(legacyKey, JSON.stringify({...draft, layers: draft.layers.map(layer => ({...layer, opacity: 0.1}))}));
    localStorage.setItem(scopedKey, JSON.stringify(draft));

    const first = mountPage(adapter, {mapId: IDS.map, startPanel: "settings"});
    const firstView = await waitFor(() => first.querySelector(".opengeo-workbench"));
    assert.equal(firstView.__opengeoLayers[0].opacity, 0.25);
    assert.match(first.querySelector(".gis-brand").textContent, /Durable jobs map/);
    assert.match(first.textContent, /Older workspace draft/);
    first.remove();

    const second = mountPage(adapter, {mapId: sibling.id});
    const secondView = await waitFor(() => second.querySelector(".opengeo-workbench"));
    assert.equal(secondView.__opengeoLayers[0].opacity, 1);
    assert.match(second.querySelector(".gis-brand").textContent, /Sibling Project/);
    clickButton(second, "Project");
    const saveDraft = [...second.querySelectorAll(".gis-menu-item")].find(node => node.querySelector("span")?.textContent === "Save to browser draft");
    assert.ok(saveDraft);
    saveDraft.click();
    assert.ok(localStorage.getItem(`${legacyKey}.${IDS.organization}:${IDS.user}:${sibling.id}`));
    assert.equal(JSON.parse(localStorage.getItem(scopedKey)).layers[0].opacity, 0.25);
    assert.equal(JSON.parse(localStorage.getItem(legacyKey)).layers[0].opacity, 0.1);
    second.remove();

    const preview = mountPage(adapter, {mapId: IDS.map, onPublicationMapExport() {}});
    const previewView = await waitFor(() => preview.querySelector(".opengeo-workbench"));
    assert.equal(previewView.__opengeoLayers[0].opacity, 1);
  });

  it("renders stable project applications instead of an intermediary management disclosure", async () => {
    const adapter = projectAdapter({kind: "managed"});
    for (const surface of [
      "data", "discussions", "resources", "publishing", "print", "settings"
    ]) {
      const page = mountPage(adapter, {managementTarget: surface});
      await waitFor(() => page.querySelector(`#project-${surface}`));
      assert.equal(page.querySelector(".opengeo-workbench"), null);
      assert.equal(page.querySelector(".project-management"), null);
      if (surface === "publishing") {
        assert.equal(page.querySelector('.studio-navigation [aria-current="page"]')?.textContent, "Publications");
      } else {
        assert.equal(
          page.querySelector('.platform-project-sections [aria-current="page"]')?.textContent.toLowerCase(),
          surface
        );
        assert.deepEqual([...page.querySelectorAll(".platform-project-sections a")].map(item => item.textContent),
          ["Maps", "Data", "Discussions", "Resources", "Services", "Print", "Settings"]);
      }
      page.remove();
    }
  });

  it("hydrates a saved governed GeoJSON archive layer instead of showing an empty shell", async () => {
    const collection = {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {name: "MassGIS example"},
        geometry: {type: "Polygon", coordinates: [[[-71.2, 42.1], [-71.1, 42.1], [-71.1, 42.2], [-71.2, 42.1]]]}
      }]
    };
    const decoded = Buffer.from(JSON.stringify(collection));
    const object = gzipSync(decoded, {mtime: 0});
    const sha256 = (value) => createHash("sha256").update(value).digest("hex");
    const adapter = projectAdapter({
      kind: "geojson",
      archive: {
        object,
        objectSha256: sha256(object),
        decodedSha256: sha256(decoded),
        decodedSizeBytes: decoded.byteLength
      }
    });
    const previousFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (url, options) => {
        assert.equal(url, "https://data.example.test/massgis.geojson.gz");
        assert.equal(options.credentials, "omit");
        return {
          status: 200,
          url,
          headers: {get: (name) => ({
            "content-type": "application/gzip",
            "content-length": String(object.byteLength)
          })[name.toLowerCase()] ?? null},
          arrayBuffer: async () => object.buffer.slice(object.byteOffset, object.byteOffset + object.byteLength)
        };
      }
    });
    try {
      const page = mountPage(adapter, {startPanel: "catalog"});
      const workbench = await waitFor(() => page.querySelector(".opengeo-workbench"));
      await waitFor(() => workbench.__opengeoData?.has("active-source"));
      assert.equal(workbench.__opengeoLayers.length, 1);
      assert.equal(workbench.__opengeoLayers[0].sourceType, "geojson-archive");
      assert.equal(workbench.__opengeoData.get("active-source").features.length, 1);
      assert.match(page.textContent, /1 layer/);
    } finally {
      if (previousFetch) Object.defineProperty(globalThis, "fetch", previousFetch);
      else delete globalThis.fetch;
    }
  });

  it("retains the immutable object URL when resolving a governed PMTiles layer", async () => {
    const page = mountPage(projectAdapter({kind: "pmtiles"}), {startPanel: "catalog"});
    const workbench = await waitFor(() => page.querySelector(".opengeo-workbench"));

    assert.equal(workbench.__opengeoLayers.length, 1);
    assert.equal(workbench.__opengeoLayers[0].sourceType, "pmtiles-vector");
    assert.equal(
      workbench.__opengeoLayers[0].tileUrl,
      "https://data.example.test/reviewed.pmtiles"
    );
  });

  it("hydrates the active managed version on initial load and a recreated page", async () => {
    const adapter = projectAdapter({kind: "managed"});
    const first = mountPage(adapter, {startPanel: "catalog"});
    await waitFor(() => first.dataset.durableJobState === "ready" && first.querySelector(".opengeo-workbench"));

    assert.equal(adapter.calls.listPmtiles.length, 1);
    assert.deepEqual(adapter.calls.listPmtiles[0], {
      projectId: IDS.project,
      datasetId: IDS.dataset,
      versionId: IDS.version,
      page: {limit: 100}
    });
    assert.match(first.querySelector(".gis-durable-jobs").textContent, new RegExp(IDS.job));

    first.remove();
    const reloaded = mountPage(adapter, {startPanel: "catalog"});
    await waitFor(() => adapter.calls.listPmtiles.length === 2 && reloaded.querySelector(".opengeo-workbench"));
    assert.match(reloaded.querySelector(".gis-durable-jobs").textContent, new RegExp(IDS.job));
  });

  it("opens the map while saved jobs load and reuses a concurrent manual refresh", async () => {
    const adapter = projectAdapter({kind: "managed"});
    const list = adapter.listPmtilesDerivatives;
    const history = Promise.withResolvers();
    adapter.listPmtilesDerivatives = async (...args) => {
      const records = await list(...args);
      await history.promise;
      return records;
    };
    const page = mountPage(adapter, {startPanel: "processing"});
    const editor = await waitFor(() => page.querySelector(".opengeo-workbench"));
    assert.equal(page.dataset.durableJobState, "loading");
    assert.match(page.querySelector(".gis-durable-jobs").textContent, /Loading saved jobs/);
    assert.equal(editor.__opengeoLayers[0].datasetId, IDS.dataset);
    clickButton(page, "Refresh jobs");
    assert.equal(adapter.calls.listPmtiles.length, 1);
    history.resolve();
    await waitFor(() => page.querySelector(".gis-durable-job-row"));
    assert.equal(page.dataset.durableJobState, "ready");
    assert.equal(page.querySelector(".opengeo-workbench"), editor);
    assert.match(page.querySelector(".gis-durable-jobs").textContent, new RegExp(IDS.job));
  });

  it("does not apply history that finishes after the page is disposed", async () => {
    const adapter = projectAdapter({kind: "managed"});
    const list = adapter.listPmtilesDerivatives;
    const history = Promise.withResolvers();
    adapter.listPmtilesDerivatives = async (...args) => {
      const records = await list(...args);
      await history.promise;
      return records;
    };
    const page = mountPage(adapter, {startPanel: "processing"});
    await waitFor(() => page.querySelector(".opengeo-workbench"));
    page.dispose();
    const before = page.textContent;
    history.resolve();
    await new Promise(setImmediate);
    assert.equal(page.textContent, before);
    assert.equal(page.dataset.durableJobState, "loading");
    assert.equal(page.querySelector(".gis-durable-job-row"), null);
  });

  it("ignores an older history read after another layer's history is refreshed", async () => {
    const adapter = projectAdapter({kind: "managed"});
    const maps = await adapter.listMaps();
    const datasets = await adapter.listDatasets();
    const otherDataset = "10000000-0000-4000-8000-000000000008";
    const otherJob = "10000000-0000-4000-8000-000000000009";
    maps[0].definition.layers.push({...maps[0].definition.layers[0],
      layerId: "other-managed", datasetId: otherDataset, title: "Other layer", order: 1});
    datasets.push({...datasets[0], id: otherDataset, name: "Other layer"});
    adapter.listMaps = async () => maps;
    adapter.listDatasets = async () => datasets;
    const first = Promise.withResolvers();
    const second = Promise.withResolvers();
    adapter.listPmtilesDerivatives = async (_project, datasetId) => (
      datasetId === IDS.dataset ? first.promise : second.promise
    );
    const page = mountPage(adapter, {startPanel: "processing"});
    await waitFor(() => page.querySelector(".opengeo-workbench"));
    page.querySelector('[aria-label="Select layer Other layer"]').click();
    clickButton(page, "Refresh jobs");
    second.resolve([{jobId: otherJob, datasetId: otherDataset, datasetVersionId: IDS.version,
      state: "queued", cancellable: true}]);
    await waitFor(() => page.querySelector(".gis-durable-job-row")?.textContent.includes(otherJob));
    first.resolve([{jobId: IDS.job, datasetId: IDS.dataset, datasetVersionId: IDS.version,
      state: "queued", cancellable: true}]);
    await new Promise(setImmediate);
    assert.match(page.querySelector(".gis-durable-jobs").textContent, new RegExp(otherJob));
    assert.doesNotMatch(page.querySelector(".gis-durable-jobs").textContent, new RegExp(IDS.job));
    page.querySelector('[aria-label="Select layer Managed screening polygons"]').click();
    assert.equal(page.querySelector(".gis-durable-job-row"), null, "The superseded read never commits stale records");
  });

  it("keeps the map usable when initial history fails", async () => {
    const adapter = projectAdapter({kind: "managed"});
    adapter.listPmtilesDerivatives = async () => {throw Error("history unavailable");};
    const page = mountPage(adapter, {startPanel: "processing"});
    await waitFor(() => page.dataset.durableJobState === "degraded");
    assert.ok(page.querySelector(".opengeo-workbench"));
    assert.match(page.querySelector(".gis-durable-jobs").textContent, /Could not refresh PMTiles derivatives/);
  });

  it("refreshes and cancels the exact active PMTiles version", async () => {
    const adapter = projectAdapter({kind: "managed"});
    const page = mountPage(adapter, {startPanel: "processing"});
    await waitFor(() => page.dataset.durableJobState === "ready" && page.querySelector(".opengeo-workbench"));
    const workbench = page.querySelector(".opengeo-workbench");

    clickButton(page, "Refresh jobs");
    await waitFor(() => adapter.calls.listPmtiles.length === 2);
    await waitFor(() => findButton(page, "Refresh jobs")?.disabled === false);
    clickButton(page, "Cancel job");
    await waitFor(() => adapter.calls.cancelPmtiles.length === 1);

    assert.deepEqual(adapter.calls.cancelPmtiles[0], {
      projectId: IDS.project,
      datasetId: IDS.dataset,
      versionId: IDS.version,
      jobId: IDS.job
    });
    await waitFor(() => page.querySelector(".gis-durable-job-row")?.textContent.includes("cancelled"));
    assert.equal(page.querySelector(".opengeo-workbench"), workbench);
    assert.equal(findButton(page, "Cancel job"), null);
  });

  it("hydrates and cancels a protected copy through its source dataset route", async () => {
    const adapter = projectAdapter({kind: "wms"});
    const page = mountPage(adapter, {startPanel: "catalog"});
    await waitFor(() => page.dataset.durableJobState === "ready" && page.querySelector(".opengeo-workbench"));

    assert.equal(adapter.calls.listProtected.length, 1);
    assert.deepEqual(adapter.calls.listProtected[0], {
      projectId: IDS.project,
      datasetId: IDS.dataset,
      page: {limit: 100}
    });
    clickButton(page, "Cancel job");
    await waitFor(() => adapter.calls.cancelProtected.length === 1);
    assert.deepEqual(adapter.calls.cancelProtected[0], {
      projectId: IDS.project,
      datasetId: IDS.dataset,
      jobId: IDS.job
    });
    await waitFor(() => page.querySelector(".gis-durable-job-row")?.textContent.includes("cancelled"));
  });

  it("lets viewers read durable history without request or cancel controls", async () => {
    const adapter = projectAdapter({kind: "managed", role: "viewer"});
    const page = mountPage(adapter, {startPanel: "processing"});
    await waitFor(() => page.dataset.durableJobState === "ready" && page.querySelector(".opengeo-workbench"));

    selectFieldValue(page, "Tool", "vector-to-pmtiles");
    assert.equal(adapter.calls.listPmtiles.length, 1);
    assert.match(page.querySelector(".gis-pmtiles-derivative-editor").textContent, /role cannot create archived derivatives/);
    assert.equal(findButton(page, "Queue on-demand conversion"), null);
    assert.equal(findButton(page, "Cancel job"), null);
    assert.equal(adapter.calls.createPmtiles.length, 0);
    assert.equal(adapter.calls.cancelPmtiles.length, 0);
  });

  it("lets an account admin select and save a Style despite a viewer project role, retaining the draft after access denial", async () => {
    const adapter = projectAdapter({kind: "managed", role: "viewer", organizationRole: "admin"});
    const definition = JSON.stringify({version: 8, sources: {}, layers: [{id: "areas", type: "fill", paint: {
      "fill-color": "#123456", "fill-opacity": 0.7, "fill-outline-color": "#654321"
    }}]});
    const style = {id: IDS.map, resourceId: IDS.job, title: "Area Style", versionNumber: 1,
      format: "maplibre", definition, checksumSha256: createHash("sha256").update(definition).digest("hex")};
    const record = {id: IDS.job, projectId: IDS.project, datasetId: IDS.dataset, title: "Areas"};
    let resolveRecords;
    adapter.listDatasetResources = () => new Promise(resolve => { resolveRecords = resolve; });
    adapter.listResourceStyles = async () => [style];
    adapter.getResourceStyleVersion = async () => style;
    adapter.getResource = async () => record;
    const saves = [];
    adapter.updateMap = async (_project, _map, update) => {
      saves.push(structuredClone(update));
      if (saves.length === 1) throw Object.assign(new Error("unavailable"), {status: 409, code: "map_style_reference_unavailable"});
      return {...(await adapter.listMaps())[0], version: 4, definition: update.changes.definition};
    };
    const page = mountPage(adapter, {startPanel: "style"});
    await waitFor(() => findButton(page, "Find Styles for this Layer"));

    const pickerButton = findButton(page, "Find Styles for this Layer");
    pickerButton.click();
    page.querySelector('.opengeo-workbench').dispatchEvent(new harness.dom.window.Event("workbench:render"));
    assert.equal(findButton(page, "Find Styles for this Layer"), pickerButton);
    resolveRecords([record]);
    await waitFor(() => findButton(page, "Styles in Areas"));
    clickButton(page, "Styles in Areas");
    await waitFor(() => findButton(page, "Apply Area Style"));
    clickButton(page, "Apply Area Style");
    await waitFor(() => findButton(page, "Use previous inline styling"));
    clickButton(page, "Save");
    await waitFor(() => page.querySelector('.opengeo-workbench').dataset.saveState === "error");
    assert.match(page.textContent, /selected Style is no longer available/);
    assert.doesNotMatch(page.textContent, /Save conflict/);
    assert.equal(saves[0].changes.definition.layers[0].styleReference.styleId, style.id);
    assert.equal(saves[0].changes.definition.schemaVersion, "opengeo.map-definition.1.4.0");
    clickButton(page, "Save");
    await waitFor(() => page.querySelector('.opengeo-workbench').dataset.saveState === "saved");
    assert.deepEqual(saves[1].changes.definition, saves[0].changes.definition);
  });

  it("does not hydrate, request, or cancel PMTiles jobs for an ineligible source", async () => {
    const adapter = projectAdapter({kind: "managed", format: "cog"});
    const page = mountPage(adapter, {startPanel: "processing"});
    await waitFor(() => page.dataset.durableJobState === "ready" && page.querySelector(".opengeo-workbench"));

    selectFieldValue(page, "Tool", "vector-to-pmtiles");
    assert.equal(adapter.calls.listPmtiles.length, 0);
    assert.match(page.querySelector(".gis-pmtiles-derivative-editor").textContent, /active managed vector upload/);
    assert.equal(findButton(page, "Queue on-demand conversion"), null);
    assert.equal(findButton(page, "Cancel job"), null);
    assert.equal(adapter.calls.createPmtiles.length, 0);
    assert.equal(adapter.calls.cancelPmtiles.length, 0);
  });

  it("adds and saves a lowercase native COG through the exact-version production binding without a ticket", async () => {
    const {adapter, reads, saved} = managedCogAdapter();
    const page = mountPage(adapter, {mapDatasetTarget: {mapId: IDS.map,
      datasetId: IDS.dataset, datasetVersionId: IDS.version}});
    await waitFor(() => findButton(page, "Add exact v4"));
    assert.deepEqual(reads, {versions: 0, tickets: 0, previews: 0});
    clickButton(page, "Add exact v4");
    const editor = await waitFor(() => {
      const view = page.querySelector(".opengeo-workbench");
      return view?.__opengeoLayers.length === 1 && view;
    });
    const layer = editor.__opengeoLayers[0];
    assert.equal(layer.geometryType, "Raster");
    assert.equal(layer.sourceType, "governed-dataset");
    assert.equal(layer.datasetVersionId, IDS.version);
    assert.equal(layer.sourceVersion, 4);
    assert.equal(layer.sourceUrl, undefined);
    assert.equal(layer.sourceConfiguration.license, undefined);
    assert.deepEqual(reads, {versions: 1, tickets: 0, previews: 0});
    clickButton(page, "Save");
    await waitFor(() => saved.length === 1);
    assert.equal(saved[0].layers[0].datasetVersionId, IDS.version);
    assert.doesNotMatch(JSON.stringify(saved[0]), /X-Amz/);
    assert.doesNotMatch(JSON.stringify(saved[0].layers[0]), /https:\/\/|CC-BY|ESA WorldCover/);
    assert.equal(reads.tickets, 0);
    page.dispose(); page.remove();
  });

  it("reuses an exact COG descriptor within one editor after removal and a deliberate second Add", async () => {
    const {adapter, reads} = managedCogAdapter();
    const page = mountPage(adapter, {mapDatasetTarget: {mapId: IDS.map,
      datasetId: IDS.dataset, datasetVersionId: IDS.version}});
    await waitFor(() => findButton(page, "Add exact v4"));
    clickButton(page, "Add exact v4");
    const editor = await waitFor(() => {
      const view = page.querySelector(".opengeo-workbench");
      return view?.__opengeoLayers.length === 1 && view;
    });
    editor.querySelector(".gis-layer-more > summary").click();
    editor.querySelector('[aria-label="Remove layer from this project"]').click();
    assert.equal(editor.__opengeoLayers.length, 0);
    clickButton(page, "Add data");
    clickButton(page, "Add exact v4");
    await waitFor(() => editor.__opengeoLayers.length === 1);
    assert.deepEqual(reads, {versions: 1, tickets: 0, previews: 0});
    page.dispose(); page.remove();
  });

  for (const changedScope of ["account", "signed-in user"]) it(`rejects a COG descriptor when the ${changedScope} changes while exact-version metadata resolves`, async () => {
    const {adapter, reads} = managedCogAdapter();
    const listVersions = adapter.listDatasetVersions;
    const getSession = adapter.getSession;
    let release, changedUser = false, organization = IDS.organization;
    adapter.getSession = async (...args) => ({...await getSession(...args),
      ...(changedUser ? {userId: "10000000-0000-4000-8000-000000000098"} : {})});
    adapter.organizationProvider = async () => organization;
    adapter.listDatasetVersions = async (...args) => {
      await new Promise(resolve => {release = resolve;});
      return listVersions(...args);
    };
    const page = mountPage(adapter, {mapDatasetTarget: {mapId: IDS.map,
      datasetId: IDS.dataset, datasetVersionId: IDS.version}});
    await waitFor(() => findButton(page, "Add exact v4"));
    clickButton(page, "Add exact v4");
    await waitFor(() => release);
    if (changedScope === "account") organization = "10000000-0000-4000-8000-000000000099";
    else changedUser = true;
    release();
    await waitFor(() => findButton(page, "Add exact v4")?.disabled === false);
    assert.equal(page.querySelector(".opengeo-workbench").__opengeoLayers.length, 0);
    assert.deepEqual(reads, {versions: 1, tickets: 0, previews: 0});
    page.dispose(); page.remove();
  });

  it("deduplicates omitted preserved dataset metadata before refusing any raw preview", async () => {
    const adapter = projectAdapter({kind: "managed"});
    const dataset = {...(await adapter.listDatasets())[0], format: "geojson", status: "draft", currentVersionState: "preserved", geometryType: null, featureCount: null, extent: null};
    const saved = (await adapter.listMaps())[0];
    saved.definition.layers[0].datasetVersionId = IDS.version; saved.definition.layers[0].sourceVersion = 4;
    let metadataReads = 0, rawReads = 0, release;
    adapter.organizationProvider = async () => IDS.organization;
    adapter.listDatasets = async () => [];
    adapter.listMaps = async () => [saved];
    adapter.getDataset = async () => {metadataReads++; await new Promise(resolve => {release = resolve;}); return dataset;};
    adapter.getDatasetSpatialPreview = async () => {rawReads++; throw Error("An uninspected original has no raw preview");};
    adapter.listPmtilesDerivatives = async () => [{jobId: IDS.job, datasetId: IDS.dataset, datasetVersionId: IDS.version, state: "completed", cancellable: false}];
    adapter.getPmtilesDisplayReview = async () => pmtilesDisplayReview();
    const page = mountPage(adapter, {startPanel: "processing"});
    await waitFor(() => release); assert.equal(metadataReads, 1); release();
    await waitFor(() => findButton(page, "Review tiled display"));
    assert.deepEqual([metadataReads, rawReads], [1, 0]);
    page.dispose(); page.remove();
  });

  for (const preserved of [false, true]) it(`reviews a completed PMTiles output, saves its exact selection and reopens without read consent (${preserved ? "preserved draft" : "active upload"})`, async () => {
    const adapter = projectAdapter({kind: "managed"});
    let saved = (await adapter.listMaps())[0], reviews = 0, admissions = 0, reads = 0, listings = 0, saves = 0, previews = 0;
    if (preserved) {
      const dataset = {...(await adapter.listDatasets())[0], format: "geojson", status: "draft", currentVersionState: "preserved", geometryType: null, featureCount: null, extent: null};
      adapter.listDatasets = async () => [dataset];
      saved.definition.layers[0].datasetVersionId = IDS.version;
      saved.definition.layers[0].sourceVersion = 4;
    }
    adapter.organizationProvider = async () => IDS.organization;
    adapter.listMaps = async () => [structuredClone(saved)];
    adapter.listPmtilesDerivatives = async () => [{jobId: IDS.job, datasetId: IDS.dataset, datasetVersionId: IDS.version, state: "completed", cancellable: false}];
    adapter.getPmtilesDisplayReview = async (...args) => {
      assert.deepEqual(args, [IDS.project, IDS.dataset, IDS.version, IDS.job]); reviews++;
      return pmtilesDisplayReview();
    };
    adapter.admitPmtilesDisplayReview = async (project, dataset, version, job, request) => {
      assert.deepEqual([project, dataset, version, job], [IDS.project, IDS.dataset, IDS.version, IDS.job]);
      assert.deepEqual(request, {expectedReviewSha256: "a".repeat(64), title: "Reviewed screening tiles", rightsBasis: "Internal analysis of retained source", attribution: "Original source retained", acknowledgeConversionLimits: true});
      admissions++; return {jobId: job, datasetId: dataset, datasetVersionId: version, reviewSha256: "a".repeat(64), displayId: job};
    };
    if (!preserved) adapter.listLayerArchives = async () => {throw Error("Wrong custody kind");};
    adapter.listManagedDisplays = async (...args) => {
      assert.deepEqual(args.slice(0,3), [IDS.project, IDS.dataset, IDS.version]); listings++;
      return {dataset_id: IDS.dataset, dataset_version_id: IDS.version, archives: [{id: IDS.job, title: "Reviewed screening tiles", format: "pmtiles", download_bytes: 14855, feature_count: 6, tile_layers: []}]};
    };
    adapter.readManagedDisplay = async () => {reads++; throw Error("No storage consent was given");};
    adapter.getDatasetSpatialPreview = async () => {previews++; throw Error("A saved tiled display cannot fall back to original preview");};
    adapter.updateMap = async (project, map, update) => {
      assert.equal(project, IDS.project); assert.equal(map, IDS.map); assert.equal(update.expectedVersion, 3);
      saved = {...saved, version: 4, definition: structuredClone(update.changes.definition)}; saves++;return saved;
    };
    const page = mountPage(adapter, {startPanel: "processing"});
    await waitFor(() => findButton(page, "Review tiled display"));
    assert.equal(reviews + admissions + reads + listings, 0);
    clickButton(page, "Review tiled display");
    await waitFor(() => findButton(page, "Admit tiled display"));
    assert.match(page.textContent, /Tile fragments are not source records/);
    const enter = (label, value) => {const input=page.querySelector(`[aria-label="${label}"]`);assert.ok(input);input.value=value;input.dispatchEvent(new harness.dom.window.Event("input", {bubbles:true}));};
    enter("Tiled display title", "Reviewed screening tiles");enter("Display rights basis", "Internal analysis of retained source");enter("Display attribution", "Original source retained");
    const acknowledged = [...page.querySelectorAll("label")].find(label => label.textContent.includes("I reviewed the conversion limits")).querySelector("input");
    acknowledged.checked=true;acknowledged.dispatchEvent(new harness.dom.window.Event("change", {bubbles:true}));
    clickButton(page, "Admit tiled display");
    await waitFor(() => findButton(page, "Choose admitted tiled display"));
    assert.equal(reads + listings, 0);
    clickButton(page, "Choose admitted tiled display");
    const dialog = document.querySelector(".gis-layer-archive-dialog");assert.equal(dialog.open, true);
    clickButton(dialog, "Review tiled displays");await waitFor(() => listings === 1 && dialog.querySelector("select").value === IDS.job);
    assert.equal(dialog.querySelector('input[type="checkbox"]').checked, false);
    assert.equal(findButton(dialog, "Use selected tiled display").disabled, true);
    clickButton(page, "Save");await waitFor(() => saves === 1);
    assert.equal(saved.definition.schemaVersion, "opengeo.map-definition.1.5.0");
    assert.equal(saved.definition.layers[0].managedDisplayId, IDS.job);assert.equal(saved.definition.layers[0].datasetVersionId, IDS.version);assert.equal(saved.definition.layers[0].sourceVersion, 4);
    assert.doesNotMatch(JSON.stringify(saved.definition), /acknowledge_storage_cost|X-Amz|ticket|reviewSha256|rightsBasis/);
    page.dispose();page.remove();
    const reopened = mountPage(adapter);
    await waitFor(() => reopened.querySelector(".opengeo-workbench"));
    assert.equal(reads, 0);assert.equal(listings, 1);assert.equal(previews, 0);
    assert.equal(reopened.querySelector(".opengeo-workbench").__opengeoLayers[0].managedDisplayId, IDS.job);
    clickButton(reopened, "Map display");
    const fresh = document.querySelector(".gis-layer-archive-dialog");assert.equal(fresh.querySelector('input[type="checkbox"]').checked, false);
    assert.equal(findButton(fresh, "Use selected tiled display").disabled, true);
    clickButton(fresh, preserved ? "Pause tiled display" : "Return to saved data");
    assert.equal(Object.hasOwn(reopened.querySelector(".opengeo-workbench").__opengeoLayers[0], "managedDisplayId"), preserved);
    if (preserved) {
      assert.match(fresh.textContent, /tiled display paused/);
      assert.equal((await adapter.listDatasets())[0].currentVersionState, "preserved");
      assert.equal(previews, 0);
    }
    assert.deepEqual([reviews, admissions, saves, reads], [1, 1, 1, 0]);
    reopened.dispose();reopened.remove();
  });

  it("retains ineligible completed PMTiles review limits without offering admission or reads", async () => {
    const adapter = projectAdapter({kind: "managed"});adapter.organizationProvider=async()=>IDS.organization;
    adapter.listPmtilesDerivatives=async()=>[{jobId:IDS.job,datasetId:IDS.dataset,datasetVersionId:IDS.version,state:"completed",cancellable:false}];
    adapter.getPmtilesDisplayReview=async()=>({...pmtilesDisplayReview(),eligible:false,tileLayers:[]});
    adapter.admitPmtilesDisplayReview=async()=>{throw Error("Ineligible output must not be admitted");};
    const page=mountPage(adapter,{startPanel:"processing"});await waitFor(()=>findButton(page,"Review tiled display"));clickButton(page,"Review tiled display");
    await waitFor(()=>page.textContent.includes("not eligible for map display"));
    assert.equal(findButton(page,"Admit tiled display"),null);assert.match(page.textContent,/Source-record preservation has not been verified/);
    page.dispose();page.remove();
  });

  it("discards a PMTiles review after its selected Layer identity changes", async () => {
    const adapter=projectAdapter({kind:"managed"});adapter.organizationProvider=async()=>IDS.organization;let release;
    adapter.listPmtilesDerivatives=async()=>[{jobId:IDS.job,datasetId:IDS.dataset,datasetVersionId:IDS.version,state:"completed",cancellable:false}];
    adapter.getPmtilesDisplayReview=()=>new Promise(resolve=>{release=resolve;});
    const page=mountPage(adapter,{startPanel:"processing"});await waitFor(()=>findButton(page,"Review tiled display"));clickButton(page,"Review tiled display");await waitFor(()=>release);
    page.querySelector(".opengeo-workbench").__opengeoLayers[0].sourceVersion=99;release(pmtilesDisplayReview());
    await waitFor(()=>page.textContent.includes("selected Layer or saved dataset version changed"));assert.equal(findButton(page,"Admit tiled display"),null);
    page.dispose();page.remove();
  });

  it("loads only the active saved Layer metadata outside the first100 Catalog records", async () => {
    const adapter=projectAdapter({kind:"managed"});adapter.organizationProvider=async()=>IDS.organization;
    const target=(await adapter.listDatasets())[0];let metadataReads=0,catalogReads=0;
    adapter.listDatasets=async(project,options)=>{catalogReads++;assert.equal(options.limit,100);return Array.from({length:100},(_,index)=>({...target,id:`20000000-0000-4000-8000-${String(index).padStart(12,"0")}`}));};
    adapter.getDataset=async(project,id,options)=>{metadataReads++;assert.deepEqual([project,id],[IDS.project,IDS.dataset]);assert.ok(options.signal);return target;};
    adapter.listPmtilesDerivatives=async(project,id,version)=>{assert.deepEqual([project,id,version],[IDS.project,IDS.dataset,IDS.version]);return[{jobId:IDS.job,datasetId:IDS.dataset,datasetVersionId:IDS.version,state:"completed",cancellable:false}];};
    adapter.getPmtilesDisplayReview=async()=>pmtilesDisplayReview();
    const page=mountPage(adapter,{startPanel:"processing"});await waitFor(()=>findButton(page,"Review tiled display"));
    selectFieldValue(page,"Tool","vector-to-pmtiles");
    assert.doesNotMatch(page.querySelector(".gis-pmtiles-derivative-editor").textContent,/active managed vector upload/);
    assert.equal(findButton(page,"Queue on-demand conversion").disabled,false);
    page.querySelector(".opengeo-workbench").dispatchEvent(new harness.dom.window.Event("workbench:render"));
    await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual([metadataReads,catalogReads],[1,1]);
    page.dispose();page.remove();
  });

  it("retains a failed active Layer metadata lookup without an automatic retry", async () => {
    const adapter=projectAdapter({kind:"managed"});adapter.organizationProvider=async()=>IDS.organization;let metadataReads=0;
    adapter.listDatasets=async()=>[];adapter.getDataset=async()=>{metadataReads++;throw Error("unavailable");};
    const page=mountPage(adapter,{startPanel:"processing"});await waitFor(()=>findButton(page,"Retry selected Layer metadata"));
    page.querySelector(".opengeo-workbench").dispatchEvent(new harness.dom.window.Event("workbench:render"));await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(metadataReads,1);assert.equal(findButton(page,"Review tiled display"),null);assert.match(page.textContent,/metadata is unavailable/);
    page.dispose();page.remove();
  });

  it("never queues the current dataset head for a Layer pinned to an older saved version", async () => {
    const adapter=projectAdapter({kind:"managed"}), saved=(await adapter.listMaps())[0];
    saved.definition.layers[0].datasetVersionId="10000000-0000-4000-8000-000000000099";saved.definition.layers[0].sourceVersion=3;
    adapter.listMaps=async()=>[saved];adapter.organizationProvider=async()=>IDS.organization;
    const pinned=saved.definition.layers[0].datasetVersionId;let historyReads=0,reviewReads=0;
    adapter.listPmtilesDerivatives=async(project,dataset,version)=>{assert.deepEqual([project,dataset,version],[IDS.project,IDS.dataset,pinned]);historyReads++;return[{jobId:IDS.job,datasetId:IDS.dataset,datasetVersionId:pinned,state:"completed",cancellable:false}];};
    adapter.getPmtilesDisplayReview=async(project,dataset,version,job)=>{assert.deepEqual([project,dataset,version,job],[IDS.project,IDS.dataset,pinned,IDS.job]);reviewReads++;return{...pmtilesDisplayReview(),datasetVersionId:pinned};};
    adapter.admitPmtilesDisplayReview=async(project,dataset,version,job)=>({jobId:job,datasetId:dataset,datasetVersionId:version,displayId:job,reviewSha256:"a".repeat(64)});
    const page=mountPage(adapter,{startPanel:"processing"});await waitFor(()=>findButton(page,"Review tiled display"));
    selectFieldValue(page,"Tool","vector-to-pmtiles");
    assert.match(page.querySelector(".gis-pmtiles-derivative-editor").textContent,/pins a different saved dataset version/);
    assert.equal(findButton(page,"Queue on-demand conversion"),null);assert.equal(adapter.calls.createPmtiles.length,0);
    clickButton(page,"Review tiled display");await waitFor(()=>findButton(page,"Admit tiled display"));
    for (const [label,value] of [["Tiled display title","Pinned tiles"],["Display rights basis","Retained source rights"],["Display attribution","Original source"]]) {const input=page.querySelector(`[aria-label="${label}"]`);input.value=value;input.dispatchEvent(new harness.dom.window.Event("input",{bubbles:true}));}
    const ack=[...page.querySelectorAll("label")].find(label=>label.textContent.includes("I reviewed the conversion limits")).querySelector("input");ack.checked=true;ack.dispatchEvent(new harness.dom.window.Event("change",{bubbles:true}));
    clickButton(page,"Admit tiled display");await waitFor(()=>findButton(page,"Choose admitted tiled display"));clickButton(page,"Choose admitted tiled display");
    assert.equal(page.querySelector(".opengeo-workbench").__opengeoLayers[0].datasetVersionId,pinned);
    assert.equal(page.querySelector(".opengeo-workbench").__opengeoLayers[0].sourceVersion,3);assert.equal(page.querySelector(".opengeo-workbench").__opengeoLayers[0].managedDisplayId,IDS.job);
    assert.deepEqual([historyReads,reviewReads],[1,1]);assert.equal(adapter.calls.createPmtiles.length,0);
    page.dispose();page.remove();
  });

});

function managedCogAdapter() {
  const adapter = projectAdapter({kind: "managed", format: "cog"});
  const reads = {versions: 0, tickets: 0, previews: 0}, saved = [];
  const datasetPromise = adapter.listDatasets().then(([dataset]) => ({...dataset,
    name: "Native land cover", geometryType: "raster", featureCount: null,
    capabilities: {read: true, edit: true, download: true}}));
  const mapPromise = adapter.listMaps().then(([map]) => ({...map,
    definition: {...map.definition, activeLayerId: null, layers: []}}));
  adapter.organizationProvider = async () => IDS.organization;
  adapter.listDatasets = async () => [await datasetPromise];
  adapter.listMaps = async () => [await mapPromise];
  adapter.listDatasetVersions = async (project, dataset, options) => {
    assert.deepEqual([project, dataset, options.limit, options.offset], [IDS.project, IDS.dataset, 100, 0]);
    reads.versions++;
    return [{id: IDS.version, versionNumber: 4, state: "active", format: "cog", geometryType: "raster",
      extent: [-73.5, 41.2, -69.8, 43.1],
      qualityResults: {checks: [{code: "cog_layout_verified", status: "passed"}]},
      objects: [{id: IDS.job, role: "original", filename: "native-land-cover.tif", contentType: "image/tiff", sizeBytes: 4096}]}];
  };
  adapter.requestDatasetDownload = async () => {reads.tickets++; assert.fail("No raster read was requested");};
  adapter.getDatasetSpatialPreview = async () => {reads.previews++; assert.fail("COGs cannot use vector previews");};
  adapter.updateMap = async (project, map, update) => {
    assert.deepEqual([project, map], [IDS.project, IDS.map]);
    saved.push(structuredClone(update.changes.definition));
    return {...await mapPromise, version: 4, definition: update.changes.definition};
  };
  return {adapter, reads, saved};
}

function mountPage(adapter, options = {}) {
  const page = ProjectWorkspacePage({
    adapter,
    projectId: IDS.project,
    ...options
  });
  harness.dom.window.document.body.append(page);
  return page;
}

function projectAdapter({kind, role = "owner", organizationRole = "member", format = "geopackage", archive = null}) {
  const calls = {
    listProtected: [],
    listPmtiles: [],
    cancelProtected: [],
    cancelPmtiles: [],
    createPmtiles: []
  };
  const layer = ["wms", "geojson", "pmtiles"].includes(kind)
    ? {
        layerId: "active-source",
        datasetId: IDS.dataset,
        title: kind === "wms" ? "MassGIS WMS" : kind === "geojson" ? "MassGIS archive" : "Reviewed vector tiles",
        sourceType: kind === "wms" ? "wms-raster" : kind === "geojson" ? "geojson-archive" : "pmtiles-vector",
        visible: true,
        opacity: 1,
        order: 0,
        style: {},
        labels: {enabled: false, field: null}
      }
    : {
        layerId: "active-managed",
        datasetId: IDS.dataset,
        title: "Managed screening polygons",
        sourceType: "governed-dataset",
        sourceLayer: "screening",
        geometryType: "Polygon",
        visible: true,
        opacity: 1,
        order: 0,
        style: {},
        labels: {enabled: false, field: null}
      };
  const project = {
    id: IDS.project,
    name: "Durable jobs",
    description: "Focused UI fixture",
    status: "active",
    callerRole: role,
    updatedAt: "2026-08-29T12:00:00Z"
  };
  const map = {
    id: IDS.map,
    projectId: IDS.project,
    name: "Durable jobs map",
    status: "active",
    version: 3,
    definition: {
      activeLayerId: layer.layerId,
      layers: [layer],
      mapViews: [{id: "default", title: "Default", center: [-71, 42], zoom: 7, pitch: 0, bearing: 0}],
      basemaps: [],
      bookmarks: []
    },
    updatedAt: "2026-08-29T12:00:00Z"
  };
  const dataset = {
    id: IDS.dataset,
    projectId: IDS.project,
    name: kind === "wms" ? "MassGIS WMS" : kind === "geojson" ? "MassGIS archive" : kind === "pmtiles" ? "Reviewed vector tiles" : "Managed screening polygons",
    description: null,
    sourceType: ["wms", "geojson", "pmtiles"].includes(kind) ? kind : "upload",
    format: ["wms", "geojson", "pmtiles"].includes(kind) ? kind : format,
    status: "active",
    currentVersionId: IDS.version,
    currentVersionNumber: 4,
    currentVersionState: "active",
    geometryType: kind === "wms" ? null : "Polygon",
    extent: [-73.5, 41.2, -69.8, 43.1],
    featureCount: 12,
    crs: "EPSG:4326",
    classification: "internal",
    capabilities: {read: true, edit: role !== "viewer"},
    tags: [],
    ownerUserId: IDS.user,
    createdAt: "2026-08-29T11:00:00Z",
    updatedAt: "2026-08-29T12:00:00Z"
  };
  const source = kind === "wms"
    ? {
        datasetId: IDS.dataset,
        name: "MassGIS WMS",
        sourceType: "wms",
        sourceUrl: "https://maps.massgis.digital.mass.gov/geoserver/wms",
        versionNumber: 4,
        status: "active",
        configuration: {
          version: "1.3.0",
          layers: ["massgis:screening"],
          styles: [""],
          imageFormat: "image/png",
          transparent: true,
          crs: "EPSG:3857",
          tileSize: 256,
          attribution: "MassGIS"
        }
      }
    : kind === "geojson" ? {
        datasetId: IDS.dataset,
        name: "MassGIS archive",
        sourceType: "geojson",
        sourceUrl: "https://data.example.test/massgis.geojson.gz",
        versionNumber: 1,
        status: "active",
        configuration: {
          contentEncoding: "gzip",
          objectSha256: archive.objectSha256,
          decodedSha256: archive.decodedSha256,
          sizeBytes: archive.object.byteLength,
          decodedSizeBytes: archive.decodedSizeBytes,
          featureCount: 1,
          geometryType: "Polygon",
          bounds: [-73.6, 41.1, -69.7, 43],
          attribution: "MassGIS",
          license: "Public domain",
          authoritativeUrl: "https://source.example.test/FeatureServer/0",
          rightsUrl: "https://source.example.test/rights"
        }
      }
    : kind === "pmtiles" ? {
        datasetId: IDS.dataset,
        name: "Reviewed vector tiles",
        sourceType: "pmtiles",
        sourceUrl: "https://data.example.test/reviewed.pmtiles",
        versionNumber: 2,
        status: "active",
        configuration: {
          tileType: "vector",
          sourceLayer: "screening",
          minZoom: 0,
          maxZoom: 14,
          attribution: "Reviewed example"
        }
      }
    : null;
  const pmtilesJob = () => ({
    jobId: IDS.job,
    datasetId: IDS.dataset,
    datasetVersionId: IDS.version,
    state: "queued",
    cancellable: true
  });
  const protectedJob = () => ({
    jobId: IDS.job,
    sourceDatasetId: IDS.dataset,
    sourceRevisionNumber: 4,
    state: "queued",
    cancellable: true
  });
  return {
    kind: "api",
    calls,
    async getSession() {
      return {
        userId: IDS.user,
        email: "reader@example.test",
        displayName: "Reader",
        memberships: [{organizationId: IDS.organization, role: organizationRole}],
        selectedOrganizationId: IDS.organization
      };
    },
    selectOrganization() {},
    async getCurrentOrganization() {
      return {id: IDS.organization, name: "OpenGeo Test", callerRole: organizationRole};
    },
    async listProjects() { return [project]; },
    async listClients() { return []; },
    async getProject() { return project; },
    async listMaps() { return [map]; },
    async listDatasets() { return [dataset]; },
    async listSources() { return source ? [source] : []; },
    async listProtectedCopies(projectId, datasetId, page) {
      calls.listProtected.push({projectId, datasetId, page});
      return [protectedJob()];
    },
    async listPmtilesDerivatives(projectId, datasetId, versionId, page) {
      calls.listPmtiles.push({projectId, datasetId, versionId, page});
      return [pmtilesJob()];
    },
    async cancelProtectedCopy(projectId, datasetId, jobId) {
      calls.cancelProtected.push({projectId, datasetId, jobId});
      return {...protectedJob(), state: "cancelled", cancellable: false};
    },
    async cancelPmtilesDerivative(projectId, datasetId, versionId, jobId) {
      calls.cancelPmtiles.push({projectId, datasetId, versionId, jobId});
      return {...pmtilesJob(), state: "cancelled", cancellable: false};
    },
    async createPmtilesDerivative(...args) {
      calls.createPmtiles.push(args);
      return pmtilesJob();
    },
    async updateMap() { return map; },
    async createMap() { return map; }
  };
}

function clickButton(root, label) {
  const button = findButton(root, label);
  assert.ok(button, `expected button ${JSON.stringify(label)}`);
  button.click();
}

function findButton(root, label) {
  return [...root.querySelectorAll("button")]
    .find((button) => button.textContent.trim() === label) ?? null;
}

function selectFieldValue(root, labelPrefix, value) {
  const wrapper = [...root.querySelectorAll("label.gis-field")]
    .find((candidate) => candidate.querySelector(":scope > span")?.textContent.startsWith(labelPrefix));
  assert.ok(wrapper, `expected field ${JSON.stringify(labelPrefix)}`);
  const input = wrapper.querySelector("select");
  input.value = value;
  input.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("timed out waiting for durable-job UI state");
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: `https://studio.opengeo.tools/workspaces?project=${IDS.project}`
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () {this.open = true;};
  dom.window.HTMLDialogElement.prototype.close = function () {this.open = false;};
  const media = {matches: false, addEventListener() {}, removeEventListener() {}};
  const replacements = {
    document: dom.window.document,
    Option: dom.window.Option,
    location: dom.window.location,
    history: dom.window.history,
    sessionStorage: dom.window.sessionStorage,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    matchMedia: () => media,
    addEventListener: dom.window.addEventListener.bind(dom.window),
    removeEventListener: dom.window.removeEventListener.bind(dom.window),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    __OPEN_GEO_DISABLE_INTERACTIVE_MAP_FOR_LAYOUT_TESTS__: true
  };
  const previous = new Map();
  for (const [name, value] of Object.entries(replacements)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
  }
  return {
    dom,
    restore() {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  };
}

function pmtilesDisplayReview() {return {jobId: IDS.job, datasetId: IDS.dataset, datasetVersionId: IDS.version, reviewSha256: "a".repeat(64), downloadBytes: 14855, minZoom: 0, maxZoom: 12, reportedFragmentCount: 6, eligible: true, tileLayers: [], conversionLimits: {geometry: "Tile geometry may be clipped or simplified.", attributes: "Properties may be omitted or normalized.", featureIds: "Source row identities are not retained."}};}
