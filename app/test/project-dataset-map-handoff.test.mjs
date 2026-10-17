import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {WorkbenchView} from "../src/components/WorkbenchView.js";

const IDS = Object.freeze({
  project: "50000000-0000-4000-8000-000000000083",
  map: "60000000-0000-4000-8000-000000000083",
  dataset: "80000000-0000-4000-8000-000000000083",
  version: "81000000-0000-4000-8000-000000000083",
  staleVersion: "81000000-0000-4000-8000-000000000084"
});

const DISPLAY = "82000000-0000-4000-8000-000000000083";
const preservedDataset = () => ({datasetId: IDS.dataset, workspaceId: IDS.project, title: "Preserved source",
  sourceType: "upload", format: "geojson", status: "draft", currentVersionState: "preserved",
  currentVersionId: IDS.version, currentVersionNumber: 3, featureCount: null, geometryType: null,
  capabilities: {read: true, edit: true}});
const displayMetadata = () => ({dataset_id: IDS.dataset, dataset_version_id: IDS.version, archives: [{
  id: DISPLAY, title: "Reviewed source tiles", format: "pmtiles", download_bytes: 4096, feature_count: 17,
  tile_layers: [{source_layer: "retained", title: "Retained polygons", geometry_type: "Polygon", feature_count: 17, geometry_method: "quantized display"}]
}]});

let harness;

beforeEach(() => {
  harness = installDom();
});

afterEach(() => {
  harness.restore();
  harness.dom.window.close();
  harness = null;
});

describe("exact dataset-to-map handoff", () => {
  for (const routed of [false, true]) it(`adds a preserved original only through an explicitly chosen admitted display (${routed ? "routed" : "ordinary"})`, async () => {
    let lists = 0, reads = 0, raw = 0;
    const saves = [];
    const dataset = preservedDataset();
    const access = {assertScope: async () => {}, authorize: async () => {},
      list: async layer => {lists++; assert.equal(layer.datasetId, IDS.dataset); assert.equal(layer.datasetVersionId, IDS.version); return displayMetadata();},
      read: async () => {reads++; throw Error("No tile download consent was given");}};
    const options = {datasets: [dataset], layerArchiveAccess: access,
      initialDatasetTarget: routed ? target(IDS.version) : null,
      async loadDatasetVersionPreview() {raw++; throw Error("No raw preview exists");},
      async loadDatasetFeatures() {raw++; throw Error("No editable collection exists");},
      async saveProject(definition) {saves.push(definition); return {id: IDS.map, version: 3, definition};}};
    const shell = createWorkbench(options);
    if (!routed) clickButton(shell, "Add data");
    assert.equal(lists + reads + raw, 0);
    assert.equal(findButton(shell, "Add exact v3"), null);
    assert.equal(findButton(shell, "Add authoritative features"), null);
    clickButton(shell, "Review tiled displays");
    await waitFor(() => shell.querySelector('[aria-label="Admitted tiled display for Preserved source"]'));
    assert.equal(findButton(shell, "Add selected tiled display").disabled, true);
    const choice = shell.querySelector('[aria-label="Admitted tiled display for Preserved source"]');
    choice.value = DISPLAY; choice.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    clickButton(shell, "Add selected tiled display");
    await waitFor(() => shell.__opengeoLayers.length === 1);
    assert.equal(shell.__opengeoData.size, 0);
    assert.equal(shell.__opengeoLayers[0].geometryType, "Polygon", "Display metadata supplies the uninspected original's unknown geometry");
    clickButton(shell, "Save"); await waitFor(() => saves.length === 1);
    assert.equal(saves[0].schemaVersion, "opengeo.map-definition.1.5.0");
    assert.equal(saves[0].layers[0].managedDisplayId, DISPLAY);
    assert.equal(saves[0].layers[0].datasetVersionId, IDS.version);
    assert.equal(saves[0].layers[0].sourceVersion, 3);
    assert.doesNotMatch(JSON.stringify(saves[0]), /ticket|X-Amz|acknowledge_storage_cost/);
    shell.dispose(); shell.remove();
    const reopened = createWorkbench({...options, datasets: routed ? [dataset] : [], initialDatasetTarget: null, project: saves[0], layers: saves[0].layers});
    await new Promise(resolve => setTimeout(resolve, 0));
    clickButton(reopened, "Map display");
    const dialog = document.querySelector(".gis-layer-archive-dialog");
    assert.equal(dialog.querySelector('input[type="checkbox"]').checked, false);
    clickButton(dialog, "Pause tiled display");
    assert.equal(reopened.__opengeoLayers[0].managedDisplayId, DISPLAY);
    assert.match(dialog.textContent, /tiled display paused/);
    assert.equal(findButton(dialog, "Use selected tiled display").disabled, true);
    assert.deepEqual([lists, reads, raw], [1, 0, 0]);
    reopened.dispose(); reopened.remove();
  });

  for (const result of ["empty", "wrong-version", "changed-during-review"])
    it(`keeps a preserved original out of raw previews when display review is ${result}`, async () => {
      const dataset = preservedDataset(); let raw = 0, release;
      const shell = createWorkbench({datasets: [dataset], initialDatasetTarget: target(IDS.version),
        layerArchiveAccess: {assertScope: async () => {}, list: async () => {
          if (result === "changed-during-review") await new Promise(resolve => {release = resolve;});
          return {...displayMetadata(), ...(result === "empty" ? {archives: []}
            : result === "wrong-version" ? {dataset_version_id: IDS.staleVersion} : {})};
        }},
        async loadDatasetVersionPreview() {raw++;}, async loadDatasetFeatures() {raw++;}});
      clickButton(shell, "Review tiled displays");
      if (result === "changed-during-review") {
        await waitFor(() => release); dataset.currentVersionId = IDS.staleVersion; release();
      }
      await waitFor(() => !findButton(shell, "Reviewing tiled displays…"));
      assert.equal(findButton(shell, "Add selected tiled display"), null);
      assert.equal(shell.__opengeoLayers.length, 0); assert.equal(raw, 0);
      shell.dispose(); shell.remove();
    });

  it("does not request raw data when a preserved-version Layer has no saved display", async () => {
    let raw = 0;
    const shell = createWorkbench({datasets: [preservedDataset()], layers: [{layerId: "preserved-without-display",
      datasetId: IDS.dataset, datasetVersionId: IDS.version, sourceVersion: 3, sourceType: "governed-dataset",
      title: "Preserved original", geometryType: "Polygon", visible: true, opacity: 0.5, order: 0,
      style: {fill: "#9933aa"}, labels: {enabled: false}}],
      geojsonByLayerId: new Map([["preserved-without-display", featureCollection()]]),
      async loadDatasetVersionPreview() {raw++;}, async loadDatasetFeatures() {raw++;}});
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(raw, 0); assert.equal(shell.__opengeoData.size, 0);
    assert.match(shell.textContent, /preserved original without a raw map preview/);
    assert.equal(shell.__opengeoLayers[0].style.fill, "#9933aa");
    shell.dispose(); shell.remove();
  });

  it("closes other Layer action menus and dismisses a chosen action before rerender", () => {
    const layers = ["First", "Second"].map((title, index) => ({layerId: `menu-${index}`, datasetId: `data-${index}`,
      title, sourceType: "geojson", geometryType: "Polygon", visible: true, opacity: 1,
      order: index, style: {}, labels: {enabled: false}}));
    const shell = createWorkbench({layers, geojsonByLayerId: new Map(layers.map(l => [l.layerId, featureCollection()]))});
    const row = title => shell.querySelector(`[aria-label="Layer actions for ${title}"]`).closest("details");
    row("First").querySelector("summary").click();
    assert.equal(row("First").open, true);
    row("Second").querySelector("summary").click();
    assert.equal(row("First").open, false);
    assert.equal(row("Second").open, true);
    row("Second").querySelector('[aria-label="Style layer"]').click();
    assert.equal(shell.querySelectorAll(".gis-layer-more[open]").length, 0);
    assert.ok(shell.querySelector(".gis-panel-right"));
  });

  for (const [name, options, permitted] of [
    ["local draft", {role: "local", persistenceMode: "local"}, true],
    ["public demo draft", {publicDemo: true}, true],
    ["landing draft", {landingMode: true}, true],
    ["managed viewer", {}, false],
    ["missing packaged assets", {role: "local", persistenceMode: "local", mapFontAttachments: null}, false]
  ]) it(`keeps pinned-font adoption deliberate for a ${name}`, () => {
    let reads = 0, saves = 0;
    const layer = {layerId: "font-names", datasetId: "font-dataset", title: "Font names", sourceType: "geojson",
      geometryType: "Polygon", visible: true, opacity: 1, order: 0, style: {}, labels: {enabled: false, field: "name"}};
    const shell = createWorkbench({role: "viewer", layers: [layer], geojsonByLayerId: new Map([[layer.layerId, featureCollection()]]),
      mapFontAttachments: {manifest() { reads++; return new Promise(() => {}); }},
      saveProject() { saves++; }, ...options});
    shell.querySelector('[aria-label="Layer actions for Font names"]').click();
    shell.querySelector('[aria-label="Style layer"]').click();
    const adopt = findButton(shell, "Use Open Sans v1 for this map’s enabled labels");
    assert.ok(adopt);
    assert.equal(adopt.disabled, !permitted);
    assert.equal(reads, 0, "Inspecting legacy labels does not load font assets");
    assert.equal(Object.hasOwn(shell.__opengeoLayers[0].labels, "fontRef"), false);
    adopt.click();
    assert.equal(Object.hasOwn(shell.__opengeoLayers[0].labels, "fontRef"), permitted);
    assert.equal(reads, 0, "Disabled labels need no glyph files yet");
    assert.equal(saves, 0, "Choosing a font never saves the map automatically");
  });

  for (const routed of [false, true]) it(`keeps failed uploads out of ${routed ? "routed" : "ordinary"} map additions`, () => {
    let previews = 0;
    const shell = createWorkbench({
      initialDatasetTarget: routed ? target(IDS.version) : null,
      datasets: [{datasetId: IDS.dataset, title: "Invalid format", sourceType: "upload",
        status: "failed", currentVersionState: "failed", currentVersionId: IDS.version,
        currentVersionNumber: 3, classification: "internal", featureCount: null}],
      async loadDatasetVersionPreview() { previews += 1; throw new Error("must not load"); },
      async loadDatasetFeatures() { previews += 1; throw new Error("must not load"); }
    });
    if (!routed) clickButton(shell, "Add data");
    const button = findButton(shell, "Processing failed");
    assert.ok(button);
    assert.equal(button.disabled, true);
    assert.match(shell.querySelector(".gis-panel-right").textContent, /Review the processing error in Project Data/);
    button.click();
    assert.equal(previews, 0);
    assert.equal(shell.__opengeoLayers.length, 0);
  });

  it("reviews, adds, and explicitly saves the selected immutable version", async () => {
    const previews = [];
    const saves = [];
    const shell = createWorkbench({
      initialDatasetTarget: target(IDS.version),
      async loadDatasetVersionPreview(datasetId, versionId) {
        previews.push({datasetId, versionId});
        return {
          datasetVersionId: versionId,
          numberReturned: 1,
          numberMatched: 1,
          mayBeTruncated: false,
          geojson: featureCollection()
        };
      },
      async saveProject(definition) {
        saves.push(definition);
        return {id: IDS.map, version: 3, definition};
      }
    });

    assert.equal(shell.classList.contains("right-collapsed"), false);
    assert.match(shell.querySelector(".gis-panel-right").textContent, /Ready to add MassGIS indicators/);
    clickButton(shell, "Add exact v3");
    await waitFor(() => shell.__opengeoLayers.length === 1);

    assert.deepEqual(previews, [{datasetId: IDS.dataset, versionId: IDS.version}]);
    assert.equal(shell.__opengeoLayers[0].datasetId, IDS.dataset);
    assert.equal(shell.__opengeoLayers[0].datasetVersionId, IDS.version);
    assert.equal(shell.__opengeoLayers[0].sourceVersion, 3);
    assert.equal(shell.__opengeoData.get(shell.__opengeoLayers[0].layerId).features.length, 1);
    assert.equal(saves.length, 0);

    clickButton(shell, "Save");
    await waitFor(() => saves.length === 1);
    assert.equal(saves[0].layers[0].datasetVersionId, IDS.version);
    assert.equal(saves[0].layers[0].sourceVersion, 3);
  });

  it("adds a managed upload from the ordinary chooser using its exact preview and preserves existing map work", async () => {
    const previews = [], saves = [];
    const existing = {
      layerId: "existing-notes", datasetId: "existing-dataset", title: "Unsaved survey notes",
      sourceType: "geojson", geometryType: "Polygon", visible: true, opacity: 0.7,
      order: 0, style: {fill: "#2563eb"}, labels: {enabled: false}
    };
    const shell = createWorkbench({
      layers: [existing],
      async loadDatasetVersionPreview(datasetId, versionId) {
        previews.push({datasetId, versionId});
        return {datasetVersionId: versionId, numberReturned: 1, numberMatched: 1,
          mayBeTruncated: false, geojson: featureCollection()};
      },
      async loadDatasetFeatures() { assert.fail("Managed uploads must not request a live feature collection"); },
      async saveProject(definition) { saves.push(definition); return {id: IDS.map, version: 3, definition}; }
    });
    clickButton(shell, "Add data");
    assert.equal(previews.length, 0, "Opening the ordinary chooser does not fetch or create anything");
    clickButton(shell, "Add exact v3");
    await waitFor(() => shell.__opengeoLayers.length === 2);
    assert.deepEqual(previews, [{datasetId: IDS.dataset, versionId: IDS.version}]);
    const added = shell.__opengeoLayers.find(({datasetId}) => datasetId === IDS.dataset);
    assert.equal(added.datasetVersionId, IDS.version);
    assert.equal(added.sourceVersion, 3);
    assert.equal(added.featureGeneration, undefined);
    const inspector = shell.querySelector(".gis-panel-right");
    for (const label of ["Renderer", "Primary color", "Opacity"]) {
      assert.ok(inspector.querySelector(`[aria-label="${label}"]`), `${label} has a stable accessible field name`);
    }
    assert.equal(shell.__opengeoLayers.find(({layerId}) => layerId === "existing-notes").style.fill, "#2563eb");
    assert.equal(shell.__opengeoLayers.find(({layerId}) => layerId === "existing-notes").title, "Unsaved survey notes");
    assert.equal(saves.length, 0, "Adding a layer does not silently save the map");
    clickButton(shell, "Save");
    await waitFor(() => saves.length === 1);
    assert.equal(saves[0].layers.find(({datasetId}) => datasetId === IDS.dataset).datasetVersionId, IDS.version);
    assert.equal(saves[0].layers.length, 2);
  });

  for (const failure of ["unavailable", "wrong-version", "truncated", "forbidden"]) {
    it(`does not fall back to live features when an ordinary managed preview is ${failure}`, async () => {
      let liveReads = 0;
      const shell = createWorkbench({
        loadDatasetVersionPreview: failure === "unavailable" ? null : async () => {
          if (failure === "forbidden") throw Object.assign(new Error("Forbidden"), {code: "action_forbidden"});
          return {datasetVersionId: failure === "wrong-version" ? IDS.staleVersion : IDS.version,
            numberReturned: 1, numberMatched: failure === "truncated" ? 2 : 1,
            mayBeTruncated: failure === "truncated", geojson: featureCollection()};
        },
        async loadDatasetFeatures() { liveReads++; throw new Error("Must not load current features"); }
      });
      clickButton(shell, "Add data");
      clickButton(shell, "Add exact v3");
      await waitFor(() => !findButton(shell, "Add exact v3")?.disabled);
      assert.equal(shell.__opengeoLayers.length, 0);
      assert.equal(shell.__opengeoData.size, 0);
      assert.equal(liveReads, 0);
    });
  }

  it("retains the live feature collection path for unversioned legacy data", async () => {
    const requested = [];
    const shell = createWorkbench({
      datasets: [{datasetId: IDS.dataset, title: "Legacy collection", sourceType: "upload", status: "active",
        currentVersionId: null, currentVersionNumber: null, geometryType: "Polygon", featureCount: 1}],
      async loadDatasetVersionPreview() { assert.fail("There is no immutable version to select"); },
      async loadDatasetFeatures(datasetId) {
        requested.push(datasetId);
        return {numberReturned: 1, numberMatched: 1, collection: {geometryType: "Polygon", generation: 4, fields: []},
          features: featureCollection().features};
      }
    });
    clickButton(shell, "Add data");
    clickButton(shell, "Add to map");
    await waitFor(() => shell.__opengeoLayers.length === 1);
    assert.deepEqual(requested, [IDS.dataset]);
    assert.equal(shell.__opengeoLayers[0].featureGeneration, 4);
    assert.equal(shell.__opengeoLayers[0].datasetVersionId, undefined);
  });

  it("offers initialized live collections separately from saved upload versions and preserves query generation", async () => {
    const requests = [], queries = [];
    const shell = createWorkbench({
      layers: [{layerId: "saved-presentation", datasetId: IDS.dataset, title: "Saved presentation",
        sourceType: "geojson", geometryType: "Polygon", visible: true, opacity: 0.6, style: {}, labels: {enabled: false}}],
      async loadDatasetVersionPreview() { assert.fail("The explicit live action must not load immutable upload bytes"); },
      async loadDatasetFeatures(datasetId) {
        requests.push(datasetId);
        return {numberReturned: 1, numberMatched: 1, collection: {geometryType: "Polygon", generation: 7,
          fields: [{name: "name", type: "string"}]}, features: featureCollection().features};
      },
      async queryDatasetFeatures(datasetId, query) {
        queries.push({datasetId, query});
        return {numberReturned: 1, numberMatched: 1, generation: 7, features: featureCollection().features,
          query, querySha256: "a".repeat(64)};
      }
    });
    clickButton(shell, "Add data");
    assert.equal(requests.length, 0);
    assert.ok(shell.querySelector('[aria-label="Add exact saved version of MassGIS indicators"]'));
    const live = shell.querySelector('[aria-label="Add authoritative features for MassGIS indicators"]');
    assert.ok(live);
    assert.equal(live.closest("details").open, false);
    shell.querySelector('[aria-label="Editable feature collection for MassGIS indicators"]').click();
    assert.equal(live.closest("details").open, true);
    assert.match(shell.querySelector(".gis-project-dataset-choice").textContent, /existing editable collection.*not the saved upload version/);
    live.click();
    await waitFor(() => shell.__opengeoLayers.length === 2);
    const layer = shell.__opengeoLayers.find(({sourceType}) => sourceType === "governed-dataset");
    assert.equal(layer.datasetVersionId, undefined);
    assert.equal(layer.featureGeneration, 7);
    assert.deepEqual(layer.featureFields, [{name: "name", type: "string"}]);
    assert.deepEqual(requests, [IDS.dataset]);
    shell.querySelector('.gis-menu-wrap[data-menu="layer"] > button').click();
    clickButton(shell, "Query features…");
    const value = shell.querySelector('[aria-label="Value"]');
    assert.ok(value);
    value.value = "Census";
    value.dispatchEvent(new harness.dom.window.Event("input", {bubbles: true}));
    const operator = shell.querySelector('[aria-label="Operator"]');
    operator.value = "equals";
    operator.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    clickButton(shell, "Run query");
    await waitFor(() => queries.length === 1);
    assert.equal(queries[0].datasetId, IDS.dataset);
    assert.equal(queries[0].query.expectedGeneration ?? queries[0].query.expected_generation, 7);
  });

  it("does not create or substitute a collection when the explicit live choice is unavailable", async () => {
    let previews = 0, collections = 0;
    const shell = createWorkbench({
      async loadDatasetVersionPreview() { previews++; throw new Error("No automatic substitution"); },
      async loadDatasetFeatures() {
        collections++;
        throw Object.assign(new Error("Missing collection"), {code: "feature_collection_not_found", status: 404});
      }
    });
    clickButton(shell, "Add data");
    shell.querySelector('[aria-label="Editable feature collection for MassGIS indicators"]').click();
    clickButton(shell, "Add authoritative features");
    await waitFor(() => !findButton(shell, "Add authoritative features").disabled);
    assert.equal(collections, 1);
    assert.equal(previews, 0);
    assert.equal(shell.__opengeoLayers.length, 0);
    assert.match(shell.textContent, /Use its exact saved version instead; no collection was created/);
    assert.equal(findButton(shell, "Add exact v3").disabled, false);
  });

  for (const firstKind of ["snapshot", "live"]) {
    it(`keeps exact and editable presentations separate when ${firstKind} is added first, including after reopen`, async () => {
      const reads = [], saves = [];
      const snapshotData = featureCollection();
      snapshotData.features[0].properties.name = "Archived tract";
      const liveData = featureCollection();
      liveData.features[0].properties.name = "Current editable tract";
      const readers = {
        async loadDatasetVersionPreview(datasetId, versionId) {
          reads.push({kind: "snapshot", datasetId, versionId});
          return {datasetVersionId: versionId, numberReturned: 1, numberMatched: 1,
            mayBeTruncated: false, geojson: structuredClone(snapshotData)};
        },
        async loadDatasetFeatures(datasetId) {
          reads.push({kind: "live", datasetId});
          return {numberReturned: 1, numberMatched: 1, collection: {geometryType: "Polygon",
            generation: 7, fields: [{name: "name", type: "string"}]}, features: structuredClone(liveData.features)};
        }
      };
      const shell = createWorkbench({...readers,
        async saveProject(definition) { saves.push(definition); return {id: IDS.map, version: 3, definition}; }
      });
      const secondKind = firstKind === "snapshot" ? "live" : "snapshot";
      for (const [index, kind] of [firstKind, secondKind].entries()) {
        const before = reads.length;
        clickButton(shell, "Add data");
        assert.equal(reads.length, before, "Browsing choices does not read or initialize a collection");
        if (index && firstKind === "snapshot") {
          assert.equal(findButton(shell, "Exact version in map").disabled, true);
        }
        if (index && firstKind === "live") {
          assert.equal(shell.querySelector('[aria-label="Editable feature collection for MassGIS indicators"]'), null);
        }
        if (kind === "live") {
          const summary = shell.querySelector('[aria-label="Editable feature collection for MassGIS indicators"]');
          assert.ok(summary);
          assert.equal(summary.closest("details").open, false);
          summary.click();
          assert.equal(reads.length, before, "Opening the editable disclosure remains read-only");
          clickButton(shell, "Add authoritative features");
        } else clickButton(shell, "Add exact v3");
        await waitFor(() => shell.__opengeoLayers.length === index + 1);
      }
      const exact = shell.__opengeoLayers.find(layer => layer.datasetVersionId === IDS.version);
      const live = shell.__opengeoLayers.find(layer => !layer.datasetVersionId);
      assert.notEqual(exact.layerId, live.layerId);
      assert.equal(exact.title, "MassGIS indicators · saved v3");
      assert.equal(live.title, "MassGIS indicators · authoritative features");
      assert.deepEqual(shell.__opengeoData.get(exact.layerId), snapshotData);
      assert.deepEqual(shell.__opengeoData.get(live.layerId), liveData);
      assert.equal(live.featureGeneration, 7);
      assert.deepEqual(reads.map(({kind}) => kind), [firstKind, secondKind]);
      clickButton(shell, "Add data");
      assert.equal(shell.querySelector(".gis-project-dataset-choice"), null, "Neither exact nor live can be added twice");
      assert.equal(reads.length, 2);
      assert.equal(saves.length, 0);
      clickButton(shell, "Save");
      await waitFor(() => saves.length === 1);
      const savedLayers = saves[0].layers;
      assert.equal(savedLayers.length, 2);
      assert.deepEqual(savedLayers.map(({layerId}) => layerId), shell.__opengeoLayers.map(({layerId}) => layerId));
      shell.remove();
      reads.length = 0;
      const reopened = createWorkbench({...readers, project: saves[0], layers: savedLayers});
      await waitFor(() => reopened.__opengeoData.size === 2);
      assert.deepEqual(reopened.__opengeoData.get(exact.layerId), snapshotData);
      assert.deepEqual(reopened.__opengeoData.get(live.layerId), liveData);
      assert.equal(reopened.__opengeoLayers.find(layer => layer.layerId === live.layerId).featureGeneration, 7);
      assert.deepEqual(reads.map(({kind}) => kind).sort(), ["live", "snapshot"]);
      assert.equal(saves.length, 1, "Reopening only reloads each persisted source through its own read path");
    });
  }

  for (const existingKind of ["snapshot", "live"]) {
    it(`preserves a legacy ${existingKind} ID and styling when adding the other source kind`, async () => {
      const legacy = {layerId: `dataset_${IDS.dataset}`, datasetId: IDS.dataset,
        ...(existingKind === "snapshot" ? {datasetVersionId: IDS.version} : {}),
        title: "Existing styled presentation", sourceType: "governed-dataset", sourceVersion: 3,
        geometryType: "Polygon", visible: true, opacity: 0.45, order: 0,
        style: {fill: "#9933aa"}, labels: {enabled: false}};
      const reads = [];
      const shell = createWorkbench({layers: [legacy],
        async loadDatasetVersionPreview(_datasetId, versionId) {
          reads.push("snapshot");
          return {datasetVersionId: versionId, numberReturned: 1, numberMatched: 1,
            mayBeTruncated: false, geojson: featureCollection()};
        },
        async loadDatasetFeatures() {
          reads.push("live");
          return {numberReturned: 1, numberMatched: 1, collection: {geometryType: "Polygon", generation: 7, fields: []},
            features: featureCollection().features};
        }
      });
      await waitFor(() => shell.__opengeoData.has(legacy.layerId));
      clickButton(shell, "Add data");
      assert.deepEqual(reads, [existingKind]);
      if (existingKind === "snapshot") {
        shell.querySelector('[aria-label="Editable feature collection for MassGIS indicators"]').click();
        clickButton(shell, "Add authoritative features");
      } else clickButton(shell, "Add exact v3");
      await waitFor(() => shell.__opengeoLayers.length === 2);
      const retained = shell.__opengeoLayers.find(layer => layer.layerId === legacy.layerId);
      assert.equal(retained.title, legacy.title);
      assert.equal(retained.opacity, legacy.opacity);
      assert.deepEqual(retained.style, legacy.style);
      assert.equal(retained.datasetVersionId, legacy.datasetVersionId);
      assert.equal(new Set(shell.__opengeoLayers.map(layer => layer.layerId)).size, 2);
      assert.deepEqual(reads, [existingKind, existingKind === "snapshot" ? "live" : "snapshot"]);
    });
  }

  it("fails closed when the selected version is no longer current", () => {
    let previewCalls = 0;
    const shell = createWorkbench({
      initialDatasetTarget: target(IDS.staleVersion),
      async loadDatasetVersionPreview() {
        previewCalls += 1;
        throw new Error("must not load");
      }
    });

    assert.match(shell.querySelector(".gis-panel-right").textContent, /changed before it was added/);
    const button = findButton(shell, "Version changed");
    assert.ok(button);
    assert.equal(button.disabled, true);
    button.click();
    assert.equal(previewCalls, 0);
    assert.equal(shell.__opengeoLayers.length, 0);
  });

  for (const sourceType of ["governed-dataset", "geojson-archive"]) it(`does not read a hidden ${sourceType} on map open`, async () => {
    let reads = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { reads++; throw new Error("Hidden archive must not be fetched"); };
    try {
      const shell = createWorkbench({layers: [{layerId: "hidden-archive", datasetId: IDS.dataset,
        datasetVersionId: sourceType === "governed-dataset" ? IDS.version : undefined,
        sourceType, sourceUrl: "https://s3.us-east-1.amazonaws.com/example-geodata/bhutan/example.geojson",
        sourceConfiguration: {}, title: "Hidden archive", geometryType: "Polygon", visible: false,
        opacity: 1, order: 0, style: {}, labels: {enabled: false, field: null}}],
        async loadDatasetVersionPreview() { reads++; throw new Error("Hidden version must not be fetched"); }});
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(reads, 0);
      assert.equal(shell.__opengeoData.has("hidden-archive"), false);
    } finally { globalThis.fetch = originalFetch; }
  });

  it("loads a saved archive only when enabled and reuses it across visibility toggles", async () => {
    let reads = 0;
    const shell = createWorkbench({layers: [{layerId: "deferred", datasetId: IDS.dataset,
      datasetVersionId: IDS.version, sourceType: "governed-dataset", sourceVersion: 1,
      title: "Deferred archive", geometryType: "Polygon", visible: false,
      opacity: 1, order: 0, style: {}, labels: {enabled: false, field: null}}],
      async loadDatasetVersionPreview() {
        reads++;
        return {datasetVersionId: IDS.version, mayBeTruncated: false, geojson: featureCollection()};
      }});
    const toggle = value => {
      const input = shell.querySelector('input[aria-label="Show Deferred archive"]');
      assert.ok(input);
      input.checked = value;
      input.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    };
    assert.equal(reads, 0);
    toggle(true);
    await waitFor(() => shell.__opengeoData.has("deferred"));
    assert.equal(reads, 1);
    toggle(false);
    toggle(true);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(reads, 1);
  });

  it("reopens a saved layer from its pinned version after the dataset advances", async () => {
    const requested = [];
    const savedLayer = {
      layerId: `dataset_${IDS.dataset}`,
      datasetId: IDS.dataset,
      datasetVersionId: IDS.version,
      title: "MassGIS indicators · authoritative features",
      sourceType: "governed-dataset",
      sourceVersion: 3,
      geometryType: "Polygon",
      bbox: [-73.6, 41.2, -69.8, 42.9],
      visible: true,
      opacity: 0.9,
      order: 0,
      style: {},
      labels: {enabled: false, field: null}
    };
    const shell = createWorkbench({
      project: {
        workspaceId: IDS.project,
        activeLayerId: savedLayer.layerId,
        layers: [savedLayer],
        mapViews: [{id: "default", title: "Default", center: [-71, 42], zoom: 7, pitch: 0, bearing: 0}],
        basemaps: [],
        bookmarks: []
      },
      layers: [savedLayer],
      datasets: [{
        datasetId: IDS.dataset,
        workspaceId: IDS.project,
        title: "MassGIS indicators",
        sourceType: "upload",
        format: "geojson",
        geometryType: "Polygon",
        status: "active",
        currentVersionState: "active",
        currentVersionId: IDS.staleVersion,
        currentVersionNumber: 4,
        classification: "internal",
        featureCount: 1,
        bbox: [-73.6, 41.2, -69.8, 42.9],
        capabilities: {read: true, edit: true}
      }],
      async loadDatasetVersionPreview(datasetId, versionId) {
        requested.push({datasetId, versionId});
        return {
          datasetVersionId: versionId,
          numberReturned: 1,
          numberMatched: 1,
          mayBeTruncated: false,
          geojson: featureCollection()
        };
      }
    });

    await waitFor(() => shell.__opengeoData.has(savedLayer.layerId));
    assert.deepEqual(requested, [{datasetId: IDS.dataset, versionId: IDS.version}]);
    assert.equal(shell.__opengeoLayers[0].sourceVersion, 3);
  });

  it("does not restore a removed persisted layer when its delayed preview arrives", async () => {
    let finish;
    const layer = {layerId: "pending-layer", datasetId: IDS.dataset, datasetVersionId: IDS.version,
      title: "Pending exact preview", sourceType: "governed-dataset", sourceVersion: 3,
      geometryType: "Polygon", visible: true, opacity: 0.8, order: 0, style: {}, labels: {enabled: false}};
    const shell = createWorkbench({layers: [layer],
      loadDatasetVersionPreview() { return new Promise(resolve => { finish = resolve; }); }});
    const row = shell.querySelector('[data-layer-id="pending-layer"]');
    row.querySelector(".gis-layer-more > summary").click();
    row.querySelector('[aria-label="Remove layer from this project"]').click();
    assert.equal(shell.__opengeoLayers.length, 0);
    finish({datasetVersionId: IDS.version, numberReturned: 1, numberMatched: 1,
      mayBeTruncated: false, geojson: featureCollection()});
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(shell.__opengeoData.has("pending-layer"), false);
    assert.equal(shell.__opengeoLayers.length, 0);
  });

  it("loads both persisted previews when their layers are reordered during the first read", async () => {
    let finishFirst;
    const requested = [], saves = [];
    const first = {layerId: "pending-first", datasetId: IDS.dataset, datasetVersionId: IDS.version,
      title: "First pending preview", sourceType: "governed-dataset", sourceVersion: 3,
      geometryType: "Polygon", visible: true, opacity: 0.8, order: 0, style: {}, labels: {enabled: false}};
    const second = {...first, layerId: "pending-second", datasetId: "80000000-0000-4000-8000-000000000084",
      datasetVersionId: IDS.staleVersion, title: "Second pending preview", order: 1};
    const shell = createWorkbench({layers: [first, second],
      async loadDatasetVersionPreview(datasetId, versionId) {
        requested.push({datasetId, versionId});
        if (datasetId === first.datasetId) await new Promise(resolve => { finishFirst = resolve; });
        return {datasetVersionId: versionId, numberReturned: 1, numberMatched: 1,
          mayBeTruncated: false, geojson: featureCollection()};
      },
      async saveProject(definition) { saves.push(definition); return {id: IDS.map, version: 3, definition}; }
    });
    assert.deepEqual(requested, [{datasetId: first.datasetId, versionId: first.datasetVersionId}]);
    const moveUp = shell.querySelector('[data-layer-id="pending-second"] [aria-label="Move Second pending preview up"]');
    assert.ok(moveUp);
    assert.equal(moveUp.disabled, false);
    moveUp.click();
    assert.deepEqual(shell.__opengeoLayers.map(({layerId}) => layerId), [second.layerId, first.layerId]);
    finishFirst();
    await waitFor(() => shell.__opengeoData.has(first.layerId) && shell.__opengeoData.has(second.layerId));
    assert.deepEqual(requested, [
      {datasetId: first.datasetId, versionId: first.datasetVersionId},
      {datasetId: second.datasetId, versionId: second.datasetVersionId}
    ], "Both original layers are fetched exactly once despite the in-place reorder");
    assert.equal(saves.length, 0, "Preview completion does not silently save the reordered map");
    clickButton(shell, "Save");
    await waitFor(() => saves.length === 1);
    assert.deepEqual(saves[0].layers.map(({layerId}) => layerId), [second.layerId, first.layerId]);
  });

  it("does not expose the add action to a view-only role", () => {
    const shell = createWorkbench({
      role: "viewer",
      initialDatasetTarget: target(IDS.version),
      async loadDatasetVersionPreview() {
        throw new Error("must not load");
      }
    });

    assert.match(shell.querySelector(".gis-panel-right").textContent, /Project owner or editor access is required/);
    assert.equal(findButton(shell, "View only")?.disabled, true);
    assert.equal(shell.__opengeoLayers.length, 0);
  });
});

function createWorkbench(overrides = {}) {
  const role = overrides.role ?? "owner";
  const shell = WorkbenchView({
    workspace: {workspaceId: IDS.project, tenantId: "10000000-0000-4000-8000-000000000083", title: "MassGIS"},
    role,
    project: {
      workspaceId: IDS.project,
      activeLayerId: null,
      layers: [],
      mapViews: [{id: "default", title: "Default", center: [-71, 42], zoom: 7, pitch: 0, bearing: 0}],
      basemaps: [],
      bookmarks: []
    },
    layers: [],
    datasets: [{
      datasetId: IDS.dataset,
      workspaceId: IDS.project,
      title: "MassGIS indicators",
      sourceType: "upload",
      format: "geojson",
      geometryType: "Polygon",
      status: "active",
      currentVersionState: "active",
      currentVersionId: IDS.version,
      currentVersionNumber: 3,
      classification: "internal",
      featureCount: 1,
      bbox: [-73.6, 41.2, -69.8, 42.9],
      capabilities: {read: true, edit: role !== "viewer"}
    }],
    mapVersion: 2,
    persistenceMode: "api",
    ...overrides
  });
  harness.dom.window.document.body.append(shell);
  return shell;
}

function target(datasetVersionId) {
  return {
    mapId: IDS.map,
    datasetId: IDS.dataset,
    datasetVersionId
  };
}

function featureCollection() {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {name: "Census tract"},
      geometry: {
        type: "Polygon",
        coordinates: [[[-71.2, 42.1], [-71.1, 42.1], [-71.1, 42.2], [-71.2, 42.1]]]
      }
    }]
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

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("timed out waiting for dataset-to-map handoff");
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: `https://studio.opengeo.tools/workspaces?project=${IDS.project}&map=${IDS.map}`
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () {this.open = true;};
  dom.window.HTMLDialogElement.prototype.close = function () {this.open = false;};
  const media = {matches: false, addEventListener() {}, removeEventListener() {}};
  const replacements = {
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    sessionStorage: dom.window.sessionStorage,
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
