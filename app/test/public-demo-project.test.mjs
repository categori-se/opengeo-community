import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {describe, it} from "node:test";

import {
  COMMUNITY_DEMO_PAGE_ID,
  MASSGIS_PAGE_PREFIX,
  communityDemoPresentation,
  massgisDemoPresentation,
  publicDemoNavigation,
  publicDemoPageIds,
  resolvePublicDemoPageId
} from "../src/lib/publicDemoProject.js";
import {graduatedLegendEntries} from "../src/lib/thematicStyle.js";

const MASSGIS_CONFIG = JSON.parse(await readFile(
  new URL("../src/data/massgis-enviroscreen.json", import.meta.url),
  "utf8"
));
const PUBLIC_CATALOG = JSON.parse(await readFile(
  new URL("../src/data/public-demo-catalog.json", import.meta.url),
  "utf8"
));

const COMMUNITY_GEOJSON = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    id: "community-1",
    properties: {name: "Community center"},
    geometry: {type: "Point", coordinates: [-77.04, 38.91]}
  }]
};

const MASSGIS_GEOJSON = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    id: 1,
    properties: {
      OBJECTID: 1,
      GEOID: "250250001001",
      NAME: "Block Group 1",
      EXPpctilePM25: 72,
      EXPpctileOZONE: 48,
      MassEnviroScore: 83,
      PollutionBurden: 67,
      PopCharacteristics: 91
    },
    geometry: {
      type: "Polygon",
      coordinates: [[[-71.1, 42.3], [-71, 42.3], [-71, 42.4], [-71.1, 42.3]]]
    }
  }],
  opengeo: {
    schemaVersion: "opengeo.massgis-geojson-receipt.1.0.0",
    sourceId: "massgis-massenviroscreen-feature-layer",
    featureCount: 1
  }
};

describe("public demo project collection", () => {
  it("publishes 32 unique, stable page ids and resolves unknown routes to the starter map", () => {
    const pageIds = publicDemoPageIds(MASSGIS_CONFIG);

    assert.equal(Object.isFrozen(pageIds), true);
    assert.equal(pageIds.length, 32);
    assert.equal(new Set(pageIds).size, 32);
    assert.equal(pageIds[0], COMMUNITY_DEMO_PAGE_ID);
    assert.equal(pageIds[1], "massgis-combined-cumulative-burden-analysis");
    assert.equal(pageIds.slice(1).every((pageId) => pageId.startsWith(MASSGIS_PAGE_PREFIX)), true);
    assert.equal(resolvePublicDemoPageId("massgis-wildfire-risk", MASSGIS_CONFIG), "massgis-wildfire-risk");
    assert.equal(resolvePublicDemoPageId("massgis-unknown", MASSGIS_CONFIG), COMMUNITY_DEMO_PAGE_ID);
    assert.equal(resolvePublicDemoPageId(null, MASSGIS_CONFIG), COMMUNITY_DEMO_PAGE_ID);
  });

  it("organizes the starter, combined analysis, and five indicator folders into navigation groups", () => {
    const onSelectPage = () => {};
    const navigation = publicDemoNavigation(MASSGIS_CONFIG, "massgis-wildfire-risk", onSelectPage);
    const [starter, massgisFolder] = navigation.nodes;
    const collectionFolder = massgisFolder.children[0];
    const [combined, ...indicatorFolders] = collectionFolder.children;

    assert.equal(Object.isFrozen(navigation), true);
    assert.equal(navigation.open, false);
    assert.equal(navigation.pageCount, 32);
    assert.deepEqual(navigation.workspaceOptions, [
      {
        workspaceId: "public-opengeo-workbench-demo",
        pageId: COMMUNITY_DEMO_PAGE_ID,
        title: "OpenGeo starter map"
      },
      {
        workspaceId: MASSGIS_CONFIG.project.id,
        pageId: "massgis-combined-cumulative-burden-analysis",
        title: MASSGIS_CONFIG.project.title
      }
    ]);
    assert.equal(navigation.mapOptions.length, 31);
    assert.deepEqual(navigation.mapOptions[0], {
      pageId: "massgis-combined-cumulative-burden-analysis",
      title: "Combined cumulative burden analysis",
      group: "Combined screening layers"
    });
    assert.deepEqual(navigation.mapOptions.at(-1), {
      pageId: "massgis-unemployment",
      title: "Unemployment",
      group: "Socioeconomic Factors"
    });
    assert.equal(navigation.activePageId, "massgis-wildfire-risk");
    assert.equal(navigation.onSelectPage, onSelectPage);
    assert.deepEqual({kind: starter.kind, id: starter.id, title: starter.title}, {
      kind: "page",
      id: COMMUNITY_DEMO_PAGE_ID,
      title: "OpenGeo starter map"
    });
    assert.deepEqual({kind: massgisFolder.kind, id: massgisFolder.id, open: massgisFolder.open}, {
      kind: "group",
      id: "massgis",
      open: true
    });
    assert.deepEqual({kind: collectionFolder.kind, id: collectionFolder.id, open: collectionFolder.open}, {
      kind: "group",
      id: "massgis-massenviroscreen",
      open: true
    });
    assert.deepEqual({kind: combined.kind, id: combined.id, title: combined.title}, {
      kind: "page",
      id: "massgis-combined-cumulative-burden-analysis",
      title: "Combined cumulative burden analysis"
    });
    assert.deepEqual(indicatorFolders.map(({id, children}) => [id, children.length]), [
      ["environmental-exposures", 8],
      ["environmental-effects", 5],
      ["climate-risks", 4],
      ["sensitive-populations", 8],
      ["socioeconomic-factors", 5]
    ]);
    assert.equal(indicatorFolders.find(({id}) => id === "climate-risks").open, true);
    assert.equal(indicatorFolders.filter(({id}) => id !== "climate-risks").every(({open}) => open === false), true);
    assert.deepEqual(navigationPageIds(navigation.nodes), [...publicDemoPageIds(MASSGIS_CONFIG)]);
    assert.equal(publicDemoNavigation(MASSGIS_CONFIG, COMMUNITY_DEMO_PAGE_ID, onSelectPage).open, true);
  });
});

describe("public demo presentations", () => {
  it("builds a complete community starter presentation from reviewed catalog metadata", () => {
    const presentation = communityDemoPresentation({
      catalog: PUBLIC_CATALOG,
      geojson: COMMUNITY_GEOJSON
    });
    const [dataset] = presentation.datasets;
    const [layer] = presentation.layers;

    assert.equal(presentation.pageId, COMMUNITY_DEMO_PAGE_ID);
    assert.equal(presentation.draftScopeId, COMMUNITY_DEMO_PAGE_ID);
    assert.equal(presentation.workspace.workspaceId, "public-opengeo-workbench-demo");
    assert.equal(presentation.workspace.classification, "public");
    assert.deepEqual({
      datasetId: dataset.datasetId,
      geometryType: dataset.geometryType,
      featureCount: dataset.featureCount,
      license: dataset.license,
      attribution: dataset.attribution
    }, {
      datasetId: "public-community-facilities",
      geometryType: "Point",
      featureCount: 1,
      license: "CC0-1.0",
      attribution: "OpenGeo.tools synthetic demonstration data"
    });
    assert.deepEqual({
      layerId: layer.layerId,
      datasetId: layer.datasetId,
      renderer: layer.style.renderer,
      labels: layer.labels,
      order: layer.order
    }, {
      layerId: "public_demo_facilities",
      datasetId: dataset.datasetId,
      renderer: "single",
      labels: {enabled: true, field: "name"},
      order: 0
    });
    assert.equal(presentation.geojsonByLayerId.get(layer.layerId), COMMUNITY_GEOJSON);
    assert.equal(presentation.project.layers[0], layer);
    assert.equal(presentation.project.activeLayerId, layer.layerId);
    assert.deepEqual(presentation.project.mapViews[0], {
      center: [-77.04, 38.91],
      zoom: 12,
      pitch: 0,
      bearing: 0
    });
    assert.equal(presentation.noticeTitle, "Public OpenGeo workbench");
  });

  it("reuses one MassGIS dataset identity while keeping each map style independent", () => {
    const pm25 = massgisPresentation("massgis-pm25-concentration");
    const ozone = massgisPresentation("massgis-ozone-concentration");
    const pm25Layer = pm25.layers.find(({layerId}) => layerId === "massgis_pm25_concentration");
    const ozoneLayer = ozone.layers.find(({layerId}) => layerId === "massgis_ozone_concentration");

    assert.equal(pm25.layers.length, 33);
    assert.equal(ozone.layers.length, 33);
    assert.equal(pm25.datasets[0].datasetId, "massgis-massenviroscreen-feature-layer");
    assert.equal(ozone.datasets[0].datasetId, pm25.datasets[0].datasetId);
    assert.equal(pm25Layer.datasetId, pm25.datasets[0].datasetId);
    assert.equal(ozoneLayer.datasetId, pm25.datasets[0].datasetId);
    assert.equal(pm25Layer.sharedSourceId, pm25.datasets[0].datasetId);
    assert.equal(ozoneLayer.sharedSourceId, ozone.datasets[0].datasetId);
    assert.notEqual(pm25.datasets[0], ozone.datasets[0]);
    assert.notEqual(pm25Layer.style, ozoneLayer.style);
    assert.notEqual(pm25Layer.style.graduated, ozoneLayer.style.graduated);
    assert.notEqual(pm25Layer.style.graduated.colors, ozoneLayer.style.graduated.colors);
    assert.equal(pm25Layer.style.graduated.field, "EXPpctilePM25");
    assert.equal(ozoneLayer.style.graduated.field, "EXPpctileOZONE");
    assert.deepEqual(pm25Layer.style.graduated.breaks, [20, 40, 60, 80]);
    assert.equal(pm25Layer.opacity, 0.76);
    assert.equal(pm25Layer.style.fillOpacityFactor, 1);
    assert.equal(pm25Layer.opacity * pm25Layer.style.fillOpacityFactor, 0.76);
    assert.deepEqual(pm25.layers.filter(({visible}) => visible).map(({layerId}) => layerId), [
      "massgis_pm25_concentration"
    ]);
    assert.deepEqual(ozone.layers.filter(({visible}) => visible).map(({layerId}) => layerId), [
      "massgis_ozone_concentration"
    ]);
    assert.equal(pm25.project.activeLayerId, pm25Layer.layerId);
    assert.equal(ozone.project.activeLayerId, ozoneLayer.layerId);
    assert.deepEqual(pm25.project.layerTree.map(({id, children, open}) => [id, children.length, open]), [
      ["combined-analysis", 3, false],
      ["environmental-exposures", 8, true],
      ["environmental-effects", 5, false],
      ["climate-risks", 4, false],
      ["sensitive-populations", 8, false],
      ["socioeconomic-factors", 5, false]
    ]);
    assert.equal(pm25.draftScopeId, "massgis-pm25-concentration:layer-workspace-v1");
    assert.equal(ozone.draftScopeId, "massgis-ozone-concentration:layer-workspace-v1");
    assert.notEqual(ozone.draftScopeId, pm25.draftScopeId);
    assert.deepEqual(
      graduatedLegendEntries(pm25Layer.style.graduated).map(({label}) => label),
      ["< 20", "20 \u2013 < 40", "40 \u2013 < 60", "60 \u2013 < 80", "\u2265 80", "No data"]
    );
    assert.equal(pm25.geojsonByLayerId.size, 33);
    assert.equal(ozone.geojsonByLayerId.size, 33);
    assert.equal(pm25.geojsonByLayerId.get(pm25Layer.layerId), MASSGIS_GEOJSON);
    assert.equal(ozone.geojsonByLayerId.get(ozoneLayer.layerId), MASSGIS_GEOJSON);
    assert.equal([...pm25.geojsonByLayerId.values()].every((value) => value === MASSGIS_GEOJSON), true);

    const ozoneColor = ozoneLayer.style.graduated.colors[0];
    pm25Layer.style.graduated.colors[0] = "#000000";
    assert.equal(ozoneLayer.style.graduated.colors[0], ozoneColor);
  });

  it("orders the combined analysis as two line layers above one fill and mirrors it in the tree", () => {
    const presentation = massgisPresentation("massgis-combined-cumulative-burden-analysis");
    const expectedLayerIds = [
      "massgis_population_characteristics",
      "massgis_pollution_burden",
      "massgis_massenviroscreen_score"
    ];

    const combinedLayers = presentation.layers.slice(0, 3);
    assert.equal(presentation.layers.length, 33);
    assert.deepEqual(combinedLayers.map(({layerId}) => layerId), expectedLayerIds);
    assert.deepEqual(combinedLayers.map(({order}) => order), [0, 1, 2]);
    assert.deepEqual(combinedLayers.map(({style}) => style.renderer), ["graduated", "graduated", "graduated"]);
    assert.deepEqual(combinedLayers.map(({style}) => style.graduated.field), [
      "PopCharacteristics",
      "PollutionBurden",
      "MassEnviroScore"
    ]);
    assert.deepEqual(combinedLayers.map(({style}) => style.polygonMode), ["line", "line", "fill"]);
    assert.deepEqual(combinedLayers.map(({opacity}) => opacity), [0.9, 0.9, 0.68]);
    assert.deepEqual(combinedLayers.map(({style}) => style.fillOpacityFactor), [0, 0, 1]);
    assert.deepEqual(combinedLayers.map((layer) => (
      layer.style.polygonMode === "line"
        ? layer.opacity
        : layer.opacity * layer.style.fillOpacityFactor
    )), [0.9, 0.9, 0.68]);
    assert.deepEqual(combinedLayers.map(({style}) => style.strokeWidth), [1.2, 1.6, 0.3]);
    assert.equal(combinedLayers.every(({style}) => (
      style.graduated.breaks.join(",") === "20,40,60,80"
    )), true);
    assert.deepEqual(presentation.layers.filter(({visible}) => visible).map(({layerId}) => layerId), expectedLayerIds);
    assert.equal(new Set(presentation.layers.map(({datasetId}) => datasetId)).size, 1);
    assert.equal(new Set(presentation.layers.map(({sharedSourceId}) => sharedSourceId)).size, 1);
    assert.deepEqual(presentation.project.layerTree.map(({id, children, open}) => [id, children.length, open]), [
      ["combined-analysis", 3, true],
      ["environmental-exposures", 8, false],
      ["environmental-effects", 5, false],
      ["climate-risks", 4, false],
      ["sensitive-populations", 8, false],
      ["socioeconomic-factors", 5, false]
    ]);
    assert.equal(presentation.project.activeLayerId, expectedLayerIds[0]);
    assert.equal(presentation.geojsonByLayerId.size, 33);
    for (const layerId of presentation.layers.map(({layerId}) => layerId)) {
      assert.equal(presentation.geojsonByLayerId.get(layerId), MASSGIS_GEOJSON);
    }
    assert.equal(presentation.sourceReceipt, MASSGIS_GEOJSON.opengeo);
  });

  it("rejects pages outside the reviewed MassGIS project collection", () => {
    for (const pageId of [COMMUNITY_DEMO_PAGE_ID, "massgis-unknown", "", null]) {
      assert.throws(
        () => massgisDemoPresentation({
          catalog: PUBLIC_CATALOG,
          massgis: MASSGIS_CONFIG,
          geojson: MASSGIS_GEOJSON,
          pageId
        }),
        /MassGIS public demo page is invalid/
      );
    }
  });
});

function massgisPresentation(pageId) {
  return massgisDemoPresentation({
    catalog: PUBLIC_CATALOG,
    massgis: MASSGIS_CONFIG,
    geojson: MASSGIS_GEOJSON,
    pageId
  });
}

function navigationPageIds(nodes) {
  return nodes.flatMap((node) => node.kind === "page"
    ? [node.id]
    : navigationPageIds(node.children ?? []));
}
