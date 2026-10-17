import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {currentProjectDefinition} from "../src/components/WorkbenchView.js";
import {
  LEGACY_MAP_DEFINITION_SCHEMA_VERSION,
  MAP_DEFINITION_SCHEMA_VERSION,
  PATH_MAP_DEFINITION_SCHEMA_VERSION,
  emptyMapDefinition,
  DISPLAY_MAP_DEFINITION_SCHEMA_VERSION,
  validateManagedDisplayReference,
  upgradeMapDefinition
} from "../src/lib/mapDefinition.js";
import {spatialBodyDefinition} from "../src/lib/spatialBody.js";
import {createPathMeasurement} from "../src/lib/pathMeasurement.js";
import {definitionForPrintFrame, definitionWithPrintLayouts, newProjectPrintLayout, printLayerPresentation, projectPrintLayouts} from "../src/lib/printLayouts.js";
import {mapboxCompatibility} from "../src/lib/mapboxAdapter.js";
import {PINNED_MAP_FONT} from "../src/lib/mapFonts.js";

describe("versioned map definition", () => {
  it("retains renderer preference and foreign extensions while rejecting SDK options", () => {
    for (const id of ["maplibre", "mapbox", "cesium"]) {
      const value = emptyMapDefinition({extensions: {opengeoRenderer: {id}, foreign: {note: "retained"}}});
      const reopened = upgradeMapDefinition(value);
      assert.deepEqual(reopened.extensions, value.extensions);
      assert.notEqual(reopened.extensions, value.extensions);
    }
    for (const value of [null, [], {}, {id:"unknown"}, {id:"pk.never.echo"}, {id:"mapbox", options:{}}, {id:"mapbox", accessToken:"pk.never.echo"}]) {
      assert.throws(() => upgradeMapDefinition(emptyMapDefinition({extensions:{opengeoRenderer:value}})),
        error => error.message === "map_renderer_preference_invalid");
    }
  });
  it("preserves explicit and unknown font identities without assigning a font to legacy labels", () => {
    const unknown = {...PINNED_MAP_FONT, id: "imported-font", version: 3};
    const definition = {...emptyMapDefinition(), layers: [
      {layerId: "legacy", labels: {enabled: true, field: "name"}},
      {layerId: "pinned", labels: {enabled: true, field: "name", fontRef: {...PINNED_MAP_FONT}}},
      {layerId: "unknown", labels: {enabled: false, field: "name", fontRef: unknown}}
    ]};
    const reopened = upgradeMapDefinition(definition);
    assert.equal(Object.hasOwn(reopened.layers[0].labels, "fontRef"), false);
    assert.deepEqual(reopened.layers[1].labels.fontRef, PINNED_MAP_FONT);
    assert.deepEqual(reopened.layers[2].labels.fontRef, unknown);
    assert.notEqual(reopened.layers[1].labels.fontRef, definition.layers[1].labels.fontRef);
    definition.layers[1].labels.fontRef.version = 2_147_483_648;
    assert.throws(() => upgradeMapDefinition(definition), /map_font_ref_invalid/);
  });

  it("creates a complete empty composition instead of an unversioned layer bag", () => {
    assert.deepEqual(emptyMapDefinition(), {
      schemaVersion: MAP_DEFINITION_SCHEMA_VERSION,
      mapViews: [],
      basemaps: [],
      bookmarks: [],
      activeLayerId: null,
      activeProcessingModelId: null,
      models: [],
      processingHistory: [],
      measurements: [],
      spatialBody: spatialBodyDefinition(),
      projection: "mercator",
      colorMode: "dark",
      layers: []
    });
  });

  it("upgrades legacy and unversioned definitions without mutating them", () => {
    const legacy = {
      schemaVersion: LEGACY_MAP_DEFINITION_SCHEMA_VERSION,
      mapViews: [],
      basemaps: [],
      bookmarks: [],
      activeLayerId: null,
      projection: "mercator",
      colorMode: "dark",
      layers: []
    };
    const upgraded = upgradeMapDefinition(legacy);

    assert.equal(legacy.schemaVersion, LEGACY_MAP_DEFINITION_SCHEMA_VERSION);
    assert.equal(upgraded.schemaVersion, MAP_DEFINITION_SCHEMA_VERSION);
    assert.equal(upgraded.activeProcessingModelId, null);
    assert.deepEqual(upgraded.models, []);
    assert.deepEqual(upgraded.processingHistory, []);
    assert.deepEqual(upgraded.measurements, []);
    assert.equal(upgradeMapDefinition({layers: []}).schemaVersion, MAP_DEFINITION_SCHEMA_VERSION);
    assert.equal(upgradeMapDefinition({schemaVersion: PATH_MAP_DEFINITION_SCHEMA_VERSION, layers: [], measurements: []}).schemaVersion, MAP_DEFINITION_SCHEMA_VERSION);
    assert.throws(
      () => upgradeMapDefinition({schemaVersion: "opengeo.map-definition.9.0.0"}),
      /map_definition_version_unsupported/
    );
  });

  it("serializes governed source identity, immutable revision, and presentation together", () => {
    const sourceConfiguration = {
      minZoom: 0,
      maxZoom: 18,
      tileSize: 256,
      scheme: "xyz",
      attribution: "Example"
    };
    const saved = currentProjectDefinition({
      project: emptyMapDefinition(),
      layers: [{
        layerId: "source_roads",
        datasetId: "70000000-0000-4000-8000-000000000001",
        title: "Road tiles",
        sourceType: "xyz-raster",
        sourceVersion: 2,
        sourceUrl: "https://tiles.example.test/{z}/{x}/{y}.png",
        sourceConfiguration,
        geometryType: "Raster",
        visible: true,
        opacity: 0.8,
        order: 10,
        style: {},
        labels: {enabled: false, field: null}
      }],
      state: {
        map: null,
        activeLayerId: "source_roads",
        globe: false,
        terrainEnabled: false,
        openScene3dEnabled: false,
        kmlPlaces: null,
        kmlInterchangeReport: null,
        kmlNetworkLinkState: {schemaVersion: "1.0.0", receipts: []},
        colorMode: "dark"
      }
    });

    assert.equal(saved.schemaVersion, MAP_DEFINITION_SCHEMA_VERSION);
    assert.equal(saved.layers[0].datasetId, "70000000-0000-4000-8000-000000000001");
    assert.equal(saved.layers[0].sourceVersion, 2);
    assert.equal(saved.layers[0].sourceUrl, "https://tiles.example.test/{z}/{x}/{y}.png");
    assert.deepEqual(saved.layers[0].sourceConfiguration, sourceConfiguration);
    assert.deepEqual(saved.layers[0].style, {});
    assert.equal(saved.activeLayerId, "source_roads");
    assert.deepEqual(saved.measurements, []);
  });

  it("persists a connected basemap binding and flavor without its resolved browser key URL", () => {
    const bindingId = "c1000000-0000-4000-8000-000000000056";
    const saved = currentProjectDefinition({
      project: emptyMapDefinition(),
      layers: [],
      state: {
        map: null,
        activeLayerId: null,
        globe: false,
        terrainEnabled: false,
        openScene3dEnabled: false,
        kmlPlaces: null,
        kmlInterchangeReport: null,
        kmlNetworkLinkState: {schemaVersion: "1.0.0", receipts: []},
        colorMode: "dark",
        basemapOpacity: 0.9,
        currentBasemapId: `provider-protomaps-${bindingId}-dark`,
        customBasemaps: [{
          basemapId: `provider-protomaps-${bindingId}-dark`,
          title: "Protomaps Dark",
          kind: "provider-style",
          provider: "protomaps",
          connectionBindingId: bindingId,
          flavor: "dark",
          styleUrl: "https://api.protomaps.com/styles/v5/dark/en.json?key=must-not-persist",
          attribution: "Protomaps · © OpenStreetMap contributors"
        }]
      }
    });

    assert.deepEqual(saved.basemaps, [{
      basemapId: `provider-protomaps-${bindingId}-dark`,
      title: "Protomaps Dark",
      kind: "provider-style",
      provider: "protomaps",
      connectionBindingId: bindingId,
      flavor: "dark",
      attribution: "Protomaps · © OpenStreetMap contributors",
      visible: true,
      opacity: 0.9
    }]);
    assert.doesNotMatch(JSON.stringify(saved), /must-not-persist|styleUrl|style_url/);
  });

  it("persists a connected CARTO raster binding without its resolved browser key URL", () => {
    const bindingId = "c1000000-0000-4000-8000-000000000057";
    const basemapId = `provider-carto-${bindingId}-positron`;
    const saved = currentProjectDefinition({
      project: emptyMapDefinition(),
      layers: [],
      state: {
        map: null,
        activeLayerId: null,
        globe: false,
        terrainEnabled: false,
        openScene3dEnabled: false,
        kmlPlaces: null,
        kmlInterchangeReport: null,
        kmlNetworkLinkState: {schemaVersion: "1.0.0", receipts: []},
        colorMode: "dark",
        basemapOpacity: 1,
        currentBasemapId: basemapId,
        customBasemaps: [{
          basemapId,
          title: "CARTO Positron",
          kind: "provider-raster",
          provider: "carto",
          connectionBindingId: bindingId,
          flavor: "positron",
          url: "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png?key=must-not-persist",
          attribution: "© CARTO · © OpenStreetMap contributors"
        }]
      }
    });

    assert.equal(saved.basemaps[0].kind, "provider-raster");
    assert.equal(saved.basemaps[0].provider, "carto");
    assert.equal(saved.basemaps[0].connectionBindingId, bindingId);
    assert.equal(saved.basemaps[0].flavor, "positron");
    assert.doesNotMatch(JSON.stringify(saved), /must-not-persist|resourceUrl|resource_url/);
  });

  it("persists a regional basemap as an exact governed XYZ source revision", () => {
    const datasetId = "80000000-0000-4000-8000-000000000071";
    const sourceConfiguration = {
      minZoom: 2,
      maxZoom: 18,
      tileSize: 256,
      scheme: "tms",
      attribution: "Example mapping agency",
      presentationRole: "regional_basemap",
      license: "CC-BY-4.0",
      coverageBounds: [80, 26, 89, 31],
      coordinateBehavior: "wgs84_web_mercator"
    };
    const basemapId = `governed-xyz-${datasetId}-v3`;
    const saved = currentProjectDefinition({
      project: emptyMapDefinition(),
      layers: [],
      state: {
        map: null,
        activeLayerId: null,
        globe: false,
        terrainEnabled: false,
        openScene3dEnabled: false,
        kmlPlaces: null,
        kmlInterchangeReport: null,
        kmlNetworkLinkState: {schemaVersion: "1.0.0", receipts: []},
        colorMode: "dark",
        basemapOpacity: 0.85,
        currentBasemapId: basemapId,
        customBasemaps: [{
          basemapId,
          title: "Mountain district imagery",
          kind: "governed-raster",
          datasetId,
          sourceType: "xyz-raster",
          sourceVersion: 3,
          sourceUrl: "https://tiles.example.test/{z}/{x}/{y}.png",
          sourceConfiguration,
          url: "https://tiles.example.test/{z}/{x}/{y}.png",
          attribution: "Example mapping agency"
        }]
      }
    });

    assert.deepEqual(saved.basemaps, [{
      basemapId,
      title: "Mountain district imagery",
      kind: "governed-raster",
      datasetId,
      sourceType: "xyz-raster",
      sourceVersion: 3,
      sourceUrl: "https://tiles.example.test/{z}/{x}/{y}.png",
      sourceConfiguration,
      attribution: "Example mapping agency",
      visible: true,
      opacity: 0.85
    }]);
  });

  it("persists an exact Moon body and network-free planetary canvas", () => {
    const body = spatialBodyDefinition("moon");
    const saved = currentProjectDefinition({
      project: emptyMapDefinition(),
      layers: [],
      state: {
        map: null,
        activeLayerId: null,
        globe: true,
        terrainEnabled: false,
        openScene3dEnabled: false,
        kmlPlaces: null,
        kmlInterchangeReport: null,
        kmlNetworkLinkState: {schemaVersion: "1.0.0", receipts: []},
        colorMode: "dark",
        spatialBody: body,
        basemapOpacity: 1,
        currentBasemapId: "planetary-blank-moon",
        customBasemaps: [{
          basemapId: "planetary-blank-moon",
          title: "Blank lunar map",
          kind: "planetary-blank",
          spatialBodyId: "moon",
          attribution: "No imagery · Moon angular canvas"
        }]
      }
    });

    assert.deepEqual(saved.spatialBody, body);
    assert.deepEqual(saved.basemaps, [{
      basemapId: "planetary-blank-moon",
      title: "Blank lunar map",
      kind: "planetary-blank",
      spatialBodyId: "moon",
      attribution: "No imagery · Moon angular canvas",
      visible: true,
      opacity: 1
    }]);
    assert.doesNotMatch(JSON.stringify(saved.basemaps), /url|endpoint|token|credential/i);
  });

  it("persists saved measurement geometry, computed distance, and terrain provenance", () => {
    const body = spatialBodyDefinition();
    const measurement = createPathMeasurement({
      id: "measurement-contract",
      title: "Ridge route",
      coordinates: [[-71.3, 42.45], [-71.29, 42.455], [-71.28, 42.45]],
      spatialBody: body,
      elevationAt: ([longitude, latitude]) => 100 + longitude + latitude,
      terrainSource: {
        sourceId: "opengeo-mapterhorn-terrain",
        provider: "Mapterhorn",
        queryMode: "renderer-unexaggerated-point-sample",
        termsUrl: "https://mapterhorn.com/attribution/",
        observedAt: "2026-08-28"
      }
    });
    const saved = currentProjectDefinition({
      project: emptyMapDefinition(),
      layers: [],
      state: {
        map: null,
        activeLayerId: null,
        globe: true,
        terrainEnabled: true,
        openScene3dEnabled: false,
        kmlPlaces: null,
        kmlInterchangeReport: null,
        kmlNetworkLinkState: {schemaVersion: "1.0.0", receipts: []},
        colorMode: "dark",
        spatialBody: body,
        measurements: [measurement]
      }
    });

    assert.deepEqual(saved.measurements, [measurement]);
    assert.equal(saved.measurements[0].terrainProfile.status, "complete");
    assert.equal(saved.measurements[0].terrainProfile.source.queryMode, "renderer-unexaggerated-point-sample");
  });
});


it("retains exact managed display preferences in native1.5 without ticket or consent state", () => {
  const layer = {layerId:"saved", datasetId:"70000000-0000-4000-8000-000000000001", datasetVersionId:"70000000-0000-4000-8000-000000000002", managedDisplayId:"70000000-0000-4000-8000-000000000003", sourceVersion:4, sourceType:"governed-dataset", title:"Tiled data", style:{}, labels:{}, visible:true, ticket:{url:"never persist"}, acknowledgeStorageCost:true};
  const saved = currentProjectDefinition({project:emptyMapDefinition(),layers:[layer],state:{map:null,activeLayerId:"saved",spatialBody:spatialBodyDefinition(),kmlNetworkLinkState:{schemaVersion:"1.0.0",receipts:[]}}});
  assert.equal(saved.schemaVersion,DISPLAY_MAP_DEFINITION_SCHEMA_VERSION);assert.equal(saved.layers[0].managedDisplayId,layer.managedDisplayId);
  assert.doesNotMatch(JSON.stringify(saved),/ticket|never persist|acknowledgeStorageCost/);
  assert.deepEqual(upgradeMapDefinition(saved).layers,saved.layers);
  for (const changed of [{managedDisplayId:null},{managedDisplayId:"bad"},{datasetVersionId:null},{sourceVersion:0},{sourceType:"external-feature-reference"}]) {
    assert.throws(()=>validateManagedDisplayReference({...layer,...changed}),/map_managed_display_reference_invalid/);
  }
  assert.throws(()=>upgradeMapDefinition({...saved,schemaVersion:"opengeo.map-definition.1.4.0"}),/map_managed_display_reference_invalid/);
});


it("binds tiled display identity to Print frames and retains the existing renderer boundary", () => {
  const layer={layerId:"tiled",datasetId:"70000000-0000-4000-8000-000000000001",datasetVersionId:"70000000-0000-4000-8000-000000000002",managedDisplayId:"70000000-0000-4000-8000-000000000003",sourceVersion:4,sourceType:"governed-dataset",title:"Tiled map",style:{},labels:{},visible:true};
  const map={id:"70000000-0000-4000-8000-000000000004",name:"Tiled map",definition:emptyMapDefinition({schemaVersion:DISPLAY_MAP_DEFINITION_SCHEMA_VERSION,layers:[layer]})};
  const layout=newProjectPrintLayout(map,"layout"),collection={schemaVersion:"opengeo.project-print-layouts.1",projectId:map.id,layouts:[layout]};
  const saved=definitionWithPrintLayouts(map,collection),frame=projectPrintLayouts({...map,definition:saved}).layouts[0].frames[0];
  assert.equal(frame.presentation[0].managedDisplayId,layer.managedDisplayId);
  const reopened=definitionForPrintFrame(map,frame);assert.equal(reopened.layers[0].managedDisplayId,layer.managedDisplayId);assert.equal(reopened.schemaVersion,DISPLAY_MAP_DEFINITION_SCHEMA_VERSION);
  const changed={...layer,managedDisplayId:"70000000-0000-4000-8000-000000000005"};
  assert.notDeepEqual(printLayerPresentation(changed),printLayerPresentation(layer));
  assert.throws(()=>projectPrintLayouts({...map,definition:{...saved,layers:[changed]}}),/saved print Layer source changed/);
  assert.ok(mapboxCompatibility({layers:[layer],state:{}}).issues.some(issue=>issue.code==="archive-protocol"));
  assert.equal(structuredClone(layer).managedDisplayId,layer.managedDisplayId);
});
