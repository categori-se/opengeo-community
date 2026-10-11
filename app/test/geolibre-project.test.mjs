import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {describe, it} from "node:test";
import {currentProjectDefinition} from "../src/components/WorkbenchView.js";
import {emptyMapDefinition} from "../src/lib/mapDefinition.js";
import {
  GEOLIBRE_IMPORT_LIMITS,
  exportGeoLibreProject,
  importGeoLibreProject
} from "../src/lib/geolibreProject.js";

const fixtureUrl = new URL("../../parity/fixtures/data/geolibre-2.6-project.geolibre.json", import.meta.url);
const fixtureText = readFileSync(fixtureUrl, "utf8");

describe("GeoLibre 2.6 project interoperability", () => {
  it("exports a workbench snapshot with unset optional properties without weakening JSON validation", () => {
    const definition = currentProjectDefinition({
      project: {...emptyMapDefinition(), extensions: {opengeoRenderer: {id: "cesium"}}},
      layers: [{layerId: "field-sites", title: "Sites", sourceType: "geojson", visible: true, opacity: 1, style: {}, labels: {enabled: false}}],
      state: {map: null}, dataByLayerId: new Map()
    });
    assert.ok(Object.hasOwn(definition.layers[0], "sourceVersion"));
    assert.equal(definition.layers[0].sourceVersion, undefined);
    const before = structuredClone(definition);
    const exported = exportGeoLibreProject({name: "Workbench snapshot", definition});
    assert.equal(exported.project.primaryRenderer, "cesium");
    assert.equal(exported.project.layers[0].id, "field-sites");
    assert.deepEqual(definition, before);
    for (const value of [NaN, Infinity, () => {}, [undefined], new Date()]) {
      assert.throws(() => exportGeoLibreProject({definition: {...definition, extra: value}}), /non-(?:JSON|finite)/);
    }
    assert.throws(() => importGeoLibreProject({...JSON.parse(fixtureText), extra: undefined}), /non-JSON/);
    assert.throws(() => exportGeoLibreProject({definition: JSON.parse('{"constructor":null}')}), /forbidden key/);
  });

  it("preserves the pinned 3.0 primary renderer through format 0.2 import and export", () => {
    const project = JSON.parse(fixtureText);
    project.primaryRenderer = "cesium";
    project.preferences.map.cesiumBasemap = "natural-earth";
    project.preferences.map.terrainEnabled = true;
    const original = structuredClone(project);
    const imported = importGeoLibreProject(project);
    assert.deepEqual(imported.map.definition.extensions.opengeoRenderer, {id: "cesium"});
    assert.equal(imported.map.definition.extensions.geolibre.upstream.version, "3.0.0");
    assert.equal(imported.report.source.version, "0.2.0");
    assert.match(imported.report.warnings.join(" "), /not file provenance/);
    assert.ok(imported.report.fields.some(({path, outcome}) => path === "$.preferences.map" && outcome === "preserved_extension"));
    const data = new Map(imported.records.embeddedDatasets.map((record) => [record.layerId, record.data]));
    const exported = exportGeoLibreProject(imported.map, {embeddedDataByLayerId: data});
    assert.equal(exported.project.primaryRenderer, "cesium");
    assert.equal(exported.report.target.version, "3.0.0");
    assert.deepEqual(importGeoLibreProject(exported.json).map.definition.extensions.opengeoRenderer, {id: "cesium"});
    assert.deepEqual(exported.project.layers.map(({id}) => id), project.layers.map(({id}) => id));
    assert.deepEqual(exported.project.mapView, project.mapView);
    assert.deepEqual(project, original);
  });

  it("exports the current engine without restoring a stale imported Cesium preference", () => {
    const imported = importGeoLibreProject({...JSON.parse(fixtureText), primaryRenderer: "cesium"});
    imported.map.definition.extensions.opengeoRenderer = {id: "maplibre"};
    let exported = exportGeoLibreProject(imported.map);
    assert.equal(Object.hasOwn(exported.project, "primaryRenderer"), false);
    assert.equal(importGeoLibreProject(exported.json).map.definition.extensions.opengeoRenderer, undefined);
    imported.map.definition.extensions.opengeoRenderer = {id: "mapbox"};
    exported = exportGeoLibreProject(imported.map);
    assert.equal(Object.hasOwn(exported.project, "primaryRenderer"), false);
    assert.deepEqual(exported.project.metadata.opengeo.definitionExtensions.opengeoRenderer, {id: "mapbox"});
    assert.ok(exported.report.fields.some(({message}) => message.includes("no native primaryRenderer value")));
  });

  it("exports the current managed bytes after an embedded layer receives a persistent identity", () => {
    const imported = importGeoLibreProject(fixtureText);
    const layer = imported.map.definition.layers[0];
    Object.assign(layer, {sourceType: "governed-dataset", datasetId: "saved-dataset", datasetVersionId: "saved-version", objectId: "saved-object", sourceVersion: 1});
    delete layer.importRef;
    const current = structuredClone(imported.records.embeddedDatasets[0].data);
    current.features[0].properties.name = "Updated managed field site";
    const exported = exportGeoLibreProject(imported.map, {embeddedDataByLayerId: new Map([[layer.layerId, current]])});
    assert.deepEqual(exported.project.layers[0].geojson, current);
    assert.equal(exported.project.layers[0].id, layer.layerId);
    assert.equal(exported.project.layers[0].metadata.opengeo.layer.datasetVersionId, "saved-version");
  });

  it("does not activate an unknown renderer or retain credentials in its source extension", () => {
    const imported = importGeoLibreProject({...JSON.parse(fixtureText), primaryRenderer: {id: "custom", token: "renderer-secret"}});
    assert.equal(imported.map.definition.extensions.opengeoRenderer, undefined);
    assert.deepEqual(imported.map.definition.extensions.geolibre.project.primaryRenderer, {id: "custom"});
    assert.ok(imported.report.fields.some(({path, outcome}) => path === "$.primaryRenderer" && outcome === "unsupported"));
    assert.equal(JSON.stringify(imported).includes("renderer-secret"), false);
    assert.equal(exportGeoLibreProject(imported.map).json.includes("renderer-secret"), false);
  });

  it("maps supported project, view, layer, source, style, and metadata records offline", () => {
    const result = importGeoLibreProject(fixtureText);

    assert.equal(result.map.name, "OpenGeo interoperability fixture");
    assert.deepEqual(result.map.definition.measurements, []);
    assert.equal(result.map.definition.spatialBody.id, "earth");
    assert.equal(result.map.definition.mapViews.length, 2);
    assert.deepEqual(result.map.definition.mapViews[0].center, [-77.04, 38.91]);
    assert.equal(result.map.definition.projection, "mercator");
    assert.equal(result.map.definition.basemaps[0].kind, "maplibre-style");
    assert.equal(result.map.definition.layers.length, 4);
    assert.deepEqual(
      result.map.definition.layers.map((layer) => layer.sourceType),
      ["geojson-object", "xyz-raster", "wms-raster", "pmtiles-vector"]
    );
    assert.equal(result.records.embeddedDatasets.length, 1);
    assert.equal(result.records.embeddedDatasets[0].data.features[0].properties.name, "Public test site");
    assert.equal(result.records.externalSources.length, 3);
    assert.equal(result.records.externalSources[0].source.type, "xyz");
    assert.equal(result.records.externalSources[1].source.type, "wms");
    assert.equal(result.records.externalSources[1].source.layers[0], "public:boundaries");
    assert.equal(result.records.externalSources[2].source.type, "pmtiles");
    assert.equal(result.records.externalSources[2].source.sourceLayer, "public");
    assert.equal(result.records.externalSources[2].importRef, "geolibre:public-pmtiles");
    assert.equal(result.report.policy.networkAccess, "disabled");
    assert.equal(result.report.summary.status, "preserved_with_extensions");
    assert.ok(result.report.fields.some((field) => field.path === "$.layers[4]" && field.outcome === "unsupported"));
  });

  it("restores GeoLibre-only layers and emits a current 0.2.0 project", () => {
    const imported = importGeoLibreProject(fixtureText);
    const data = new Map(imported.records.embeddedDatasets.map((record) => [record.layerId, record.data]));
    const exported = exportGeoLibreProject(imported.map, {embeddedDataByLayerId: data});
    const reopened = JSON.parse(exported.json);

    assert.equal(reopened.version, "0.2.0");
    assert.equal(reopened.layers.length, 5);
    assert.equal(reopened.layers[0].geojson.features.length, 1);
    assert.equal(reopened.layers[1].source.tiles[0], "https://tiles.example.com/{z}/{x}/{y}.png");
    assert.equal(reopened.layers[3].source.tileType, "vector");
    assert.equal(reopened.layers[3].source.sourceLayer, "public");
    assert.equal(reopened.layers[4].type, "duckdb-query");
    assert.equal(reopened.layers[0].style.fillColor, "#14b8a6");
    assert.equal(reopened.layers[0].style.labels.field, "name");
    assert.deepEqual(reopened.metadata.opengeo.definitionExtensions, imported.map.definition.extensions);
    assert.equal(exported.report.summary.status, "preserved_with_extensions");
    assert.ok(exported.report.fields.some((field) => field.message.includes("GeoLibre-only layer")));
  });

  it("removes credential material from fields and URLs without making requests", () => {
    const project = JSON.parse(fixtureText);
    project.preferences.environmentVariables = [{key: "SERVICE_TOKEN", value: "never-store-me", enabled: true}];
    project.preferences.geocoding.apiKeys = {provider: "also-never-store-me"};
    project.plugins.settings = {plugin: {apiKey: "plugin-secret"}};
    project.layers[1].source.url = "https://user:password@tiles.example.com/{z}/{x}/{y}.png?api_key=secret";
    project.layers[1].source.tiles = [project.layers[1].source.url];

    const result = importGeoLibreProject(project);
    const stored = JSON.stringify(result);

    assert.ok(!stored.includes("never-store-me"));
    assert.ok(!stored.includes("also-never-store-me"));
    assert.ok(!stored.includes("plugin-secret"));
    assert.ok(!stored.includes("password"));
    assert.ok(!stored.includes("api_key"));
    assert.equal(result.report.summary.status, "lossy");
    assert.ok(result.report.summary.rejected >= 4);
    assert.equal(result.map.definition.layers.some((layer) => layer.layerId === "public-xyz"), false);
  });

  it("fails closed on prototype keys, duplicate ids, unsupported versions, and size limits", () => {
    const dangerous = `{"version":"0.2.0","name":"Bad","mapView":{},"__proto__":{"polluted":true}}`;
    assert.throws(() => importGeoLibreProject(dangerous), /forbidden key __proto__/);

    const duplicate = JSON.parse(fixtureText);
    duplicate.layers[1].id = duplicate.layers[0].id;
    assert.throws(() => importGeoLibreProject(duplicate), /duplicated/);

    const future = JSON.parse(fixtureText);
    future.version = "9.0.0";
    assert.throws(() => importGeoLibreProject(future), /Unsupported GeoLibre project version/);

    const huge = JSON.stringify({version: "0.2.0", name: "Huge", mapView: {}, metadata: {value: "x".repeat(GEOLIBRE_IMPORT_LIMITS.maxProjectBytes)}});
    assert.throws(() => importGeoLibreProject(huge), /exceeds 1048576 bytes/);
  });

  it("does not turn local or credential-bearing source URLs into governed candidates", () => {
    const project = JSON.parse(fixtureText);
    project.layers = [
      {...project.layers[1], id: "local", source: {...project.layers[1].source, url: "https://127.0.0.1/{z}/{x}/{y}.png", tiles: ["https://127.0.0.1/{z}/{x}/{y}.png"]}},
      {...project.layers[2], id: "credential", source: {...project.layers[2].source, url: "https://maps.example.com/wms?token=secret"}}
    ];

    const result = importGeoLibreProject(project);

    assert.equal(result.records.externalSources.length, 0);
    assert.equal(result.map.definition.layers.length, 0);
    assert.equal(
      result.report.fields.filter((field) => field.path.startsWith("$.layers[") && field.outcome === "unsupported").length,
      2
    );
  });

  it("keeps an unsupported OpenGeo layer reversible inside GeoLibre metadata", () => {
    const opengeo = {
      name: "OpenGeo-only layer",
      definition: {
        mapViews: [{viewId: "map_primary", center: [0, 0], zoom: 2, bearing: 0, pitch: 0}],
        basemaps: [],
        layers: [{layerId: "future", title: "Future source", sourceType: "postgis-live", connectionProfileId: "profile-1", visible: true, opacity: 1, style: {}, labels: {enabled: false, field: null}}],
        extensions: {research: {workflow: "keep-exactly"}}
      }
    };

    const exported = exportGeoLibreProject(opengeo);
    const layer = exported.project.layers[0];

    assert.equal(layer.visible, false);
    assert.deepEqual(layer.metadata.opengeo.layer, opengeo.definition.layers[0]);
    assert.deepEqual(exported.project.metadata.opengeo.definitionExtensions, opengeo.definition.extensions);
    assert.equal(exported.report.summary.status, "lossy");
    assert.ok(exported.report.losses.some((loss) => loss.includes("hidden empty placeholder")));
  });

  it("maps supported processing operations and reports unsupported ones individually", () => {
    const project = JSON.parse(fixtureText);
    project.models = [{
      id: "screening-model",
      name: "Screening extent centers",
      steps: [
        {id: "extent", toolId: "bounding-box", parameters: {}},
        {id: "center", toolId: "centroids", parameters: {}},
        {id: "slope", toolId: "whitebox:slope", parameters: {dem: "public-sites"}}
      ]
    }];
    project.processingHistory = [
      {
        id: "run-count",
        kind: "algorithm",
        toolId: "count-features",
        toolName: "Count features",
        engine: "browser",
        parameters: {},
        startedAt: "2026-08-29T12:00:00.000Z",
        durationMs: 1,
        status: "success"
      },
      {
        id: "run-slope",
        kind: "whitebox",
        toolId: "whitebox:slope",
        toolName: "Slope",
        engine: "sidecar",
        parameters: {dem: "public-sites"},
        startedAt: "2026-08-29T12:01:00.000Z",
        durationMs: 2,
        status: "error"
      }
    ];

    const imported = importGeoLibreProject(project);
    const conversion = imported.records.processingConversion;
    const exported = exportGeoLibreProject(imported.map);

    assert.deepEqual(
      conversion.models[0].steps.map(({openGeoToolId, status}) => [openGeoToolId, status]),
      [["bbox-layer", "mapped"], ["centroids", "mapped"], [null, "preserved-unsupported"]]
    );
    assert.deepEqual(conversion.unsupportedToolIds, ["whitebox:slope"]);
    assert.ok(imported.report.fields.some((field) =>
      field.path.endsWith("steps.slope") && field.outcome === "unsupported"
    ));
    assert.equal(exported.project.models[0].steps[0].toolId, "bounding-box");
    assert.equal(exported.project.processingHistory[0].toolId, "count-features");
  });
});
