import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {applyGeoLibreReturnCameraChoice, createGeoLibreHandoff, reviewGeoLibreReturn} from "../src/lib/geolibreHandoff.js";
import {importGeoLibreProject} from "../src/lib/geolibreProject.js";
import {prepareGeoLibreImport} from "../src/lib/geolibreImport.js";
import {emptyMapDefinition} from "../src/lib/mapDefinition.js";

const projectId = "project-1";
function fixture() {
  const map = {
    id: "map-1", version: 3, name: "Study sites",
    definition: {
      ...emptyMapDefinition(),
      activeLayerId: "sites",
      layers: [{
        layerId: "sites", datasetId: "dataset-sites", datasetVersionId: "version-sites",
        objectId: "object-sites", sourceType: "governed-dataset", sourceVersion: 2,
        sourceConfiguration: {featureGeneration: 4}, sharedSourceId: null,
        title: "Sites", visible: true, opacity: 1, order: 0,
        style: {fillColor: "#14b8a6", strokeColor: "#0f766e"},
        labels: {enabled: false, field: null}, metadata: {authoritative: true}
      }],
      extensions: {opengeoRenderer: {id: "maplibre"}, protectedBase: {keep: true}}
    }
  };
  const data = {type: "FeatureCollection", features: [{
    type: "Feature", id: "site-1", geometry: {type: "Point", coordinates: [1, 2]},
    properties: {name: "Field site", count: 4}
  }]};
  return {map, data, embeddedDataByLayerId: new Map([["sites", {data, complete: true}]])};
}

function cameraFixture() {
  const f = fixture();
  f.map.definition.mapViews = [
    {viewId: "overview", center: [-77.04, 38.91], zoom: 11, bearing: 15, pitch: 20,
      bbox: [-77.12, 38.84, -76.96, 38.98], title: "Detailed observations"},
    {viewId: "comparison", center: [-77.04, 38.91], zoom: 9, bearing: 0, pitch: 0,
      label: "Regional context", viewKind: "maplibre", layerVisibility: {sites: true}}
  ];
  return f;
}

async function exchange(edit = () => {}, f = fixture()) {
  const handoff = await createGeoLibreHandoff({projectId, ...f});
  const returned = structuredClone(handoff.project);
  edit(returned);
  const reviewed = await reviewGeoLibreReturn({
    conversion: importGeoLibreProject(returned), projectId,
    baseMap: f.map, currentMap: f.map, embeddedDataByLayerId: f.embeddedDataByLayerId
  });
  return {...f, handoff, returned, ...reviewed};
}

describe("saved-revision GeoLibre handoff and return review", () => {
  it("exports complete native governed data and the exact saved-revision digest without mutating it", async () => {
    const f = fixture();
    const before = structuredClone(f);
    const first = await createGeoLibreHandoff({projectId, ...f});
    const second = await createGeoLibreHandoff({projectId, ...f});
    assert.deepEqual(first.project.layers[0].geojson, f.data);
    assert.deepEqual(JSON.parse(first.json), first.project);
    assert.deepEqual(first.project.metadata.opengeo.handoff, {
      schemaVersion: "opengeo.geolibre-handoff.1.0.0", projectId,
      mapId: f.map.id, mapVersion: 3,
      definitionSha256: first.project.metadata.opengeo.handoff.definitionSha256
    });
    assert.match(first.project.metadata.opengeo.handoff.definitionSha256, /^[a-f0-9]{64}$/);
    assert.equal(first.json, second.json);
    assert.deepEqual(f, before);
  });

  it("refuses a preview, partial page, or unversioned map as a handoff", async () => {
    const f = fixture();
    for (const entry of [f.data, {data: f.data, complete: false}, undefined]) {
      await assert.rejects(createGeoLibreHandoff({projectId, map: f.map, embeddedDataByLayerId: {sites: entry}}), {code: "geolibre_complete_data_required"});
    }
    await assert.rejects(createGeoLibreHandoff({projectId, map: {...f.map, version: 0}}), /saved OpenGeo Project/);
    f.map.definition.layers[0].sourceType = "geojson-object";
    await assert.rejects(createGeoLibreHandoff({projectId, map: f.map, embeddedDataByLayerId: {sites: f.data}}), {code: "geolibre_complete_data_required"});
  });

  it("reuses unchanged Layers without uploading, even when external metadata forges identities", async () => {
    const result = await exchange((returned) => {
      returned.layers[0].metadata.opengeo.layer = {
        layerId: "stolen", datasetId: "another-account", objectId: "private-object", sourceVersion: 900
      };
      returned.metadata.opengeo.definitionExtensions = {protectedBase: {keep: false}};
    });
    assert.deepEqual(result.conversion.map.definition.layers, result.map.definition.layers);
    assert.deepEqual(result.review.unchanged, ["sites"]);
    assert.deepEqual(result.review.changed, []);
    assert.deepEqual(result.conversion.records.embeddedDatasets, []);
    assert.deepEqual(result.conversion.map.definition.extensions.protectedBase, {keep: true});
    const prepared = await prepareGeoLibreImport({conversion: result.conversion, sourceText: JSON.stringify(result.returned), mapId: "map-1", expectedMapVersion: 3});
    assert.deepEqual(prepared.embeddedDatasets, []);
    assert.equal(prepared.mapDefinition.layers[0].datasetId, "dataset-sites");
  });

  it("applies supported presentation changes while preserving source and dataset identity", async () => {
    const result = await exchange((returned) => {
      returned.layers[0].name = "Reviewed sites";
      returned.layers[0].visible = false;
      returned.layers[0].opacity = 0.6;
      returned.layers[0].style.fillColor = "#ef4444";
    });
    const layer = result.conversion.map.definition.layers[0];
    for (const field of ["layerId", "datasetId", "datasetVersionId", "objectId", "sourceType", "sourceVersion", "sourceConfiguration", "sharedSourceId", "metadata"]) {
      assert.deepEqual(layer[field], result.map.definition.layers[0][field]);
    }
    assert.equal(layer.title, "Reviewed sites");
    assert.equal(layer.visible, false);
    assert.equal(layer.opacity, 0.6);
    assert.equal(layer.style.fill, "#ef4444");
    assert.deepEqual(result.review.changed, [{layerId: "sites", changes: ["style", "presentation"]}]);
    assert.deepEqual(result.review.styles, ["sites"]);
    assert.deepEqual(result.conversion.records.embeddedDatasets, []);
  });

  it("clears a managed Style reference after explicit native style edits", async () => {
    const f = fixture();
    f.map.definition.schemaVersion = "opengeo.map-definition.1.4.0";
    f.map.definition.layers[0].styleReference = {styleId: "style-1", versionNumber: 1};
    const handoff = await createGeoLibreHandoff({projectId, ...f});
    handoff.project.layers[0].style.fillColor = "#ef4444";
    const result = await reviewGeoLibreReturn({conversion: importGeoLibreProject(handoff.project), projectId, baseMap: f.map, currentMap: f.map, embeddedDataByLayerId: f.embeddedDataByLayerId});
    assert.equal(Object.hasOwn(result.conversion.map.definition.layers[0], "styleReference"), false);
    assert.equal(result.conversion.map.definition.schemaVersion, "opengeo.map-definition.1.4.0");
    assert.ok(f.map.definition.layers[0].styleReference);
  });

  it("preserves native-only root state and unchanged alternate basemaps while applying mapped edits", async () => {
    const f = fixture();
    Object.assign(f.map.definition, {
      colorMode: "light", bookmarks: [{title: "Study extent"}], measurements: [{id: "measure-1"}],
      metadata: {source: {authoritative: true}}, customState: {keep: [1, 2]},
      mapViews: [{viewId: "saved-overview", center: [1, 2], zoom: 4, bearing: 0, pitch: 0}],
      basemaps: [{basemapId: "primary", url: "https://maps.example.test/style.json", visible: true}, {basemapId: "alternate", visible: false, url: "https://maps.example.test/alternate.json"}]
    });
    const handoff = await createGeoLibreHandoff({projectId, ...f});
    handoff.project.layers[0].geojson.features[0].properties.count = 5;
    handoff.project.mapView.zoom = 7;
    const result = await reviewGeoLibreReturn({conversion: importGeoLibreProject(handoff.project), projectId, baseMap: f.map, currentMap: f.map, embeddedDataByLayerId: f.embeddedDataByLayerId});
    for (const key of ["schemaVersion", "colorMode", "bookmarks", "measurements", "metadata", "customState", "basemaps"]) {
      assert.deepEqual(result.conversion.map.definition[key], f.map.definition[key]);
    }
    assert.deepEqual(result.conversion.map.definition.mapViews, f.map.definition.mapViews);
    applyGeoLibreReturnCameraChoice(result, true);
    assert.equal(result.conversion.map.definition.mapViews[0].zoom, 7);
    assert.equal(result.conversion.map.definition.mapViews[0].viewId, "saved-overview");
  });

  it("retains canonical cameras after actual-peer camera drift while applying style, legend and layout edits", async () => {
    const f = cameraFixture();
    const canonical = structuredClone(f.map.definition);
    const result = await exchange(returned => {
      returned.mapView.bbox = [-77.13502037172688, 38.807371736704425, -76.9187397220274, 39.040753881906824];
      Object.assign(returned.secondaryMapViews[0].view, {zoom: 11, bearing: 15, pitch: 20,
        bbox: structuredClone(returned.mapView.bbox)});
      Object.assign(returned.secondaryMapViews[0], {label: "Regional context revised", viewKind: "deckgl",
        layerVisibility: {sites: false}});
      returned.layers[0].style.fillColor = "#ef4444";
      returned.legend = {title: "Reviewed legend", layerIds: ["sites"]};
      returned.mapLayout = {title: "Reviewed layout", page: {width: 210, height: 297}};
    }, f);
    const mappedViews = structuredClone(canonical.mapViews);
    Object.assign(mappedViews[1], {label: "Regional context revised", viewKind: "deckgl", layerVisibility: {sites: false}});
    assert.deepEqual(result.conversion.map.definition.mapViews, mappedViews);
    assert.deepEqual(result.cameraChoices.canonicalViews, canonical.mapViews);
    assert.equal(result.review.cameraChoice, "canonical");
    assert.deepEqual(result.cameraChanges.find(change => change.viewId === "comparison" && change.field === "zoom"),
      {viewId: "comparison", field: "zoom", before: 9, returned: 11});
    assert.deepEqual(result.cameraChanges.filter(change => change.viewId === "comparison").map(change => change.field),
      ["zoom", "bearing", "pitch", "bbox"]);
    assert.ok(result.cameraChanges.some(change => change.viewId === "overview" && change.field === "bbox"));
    assert.match(result.review.limits.join(" "), /comparison.*zoom.*9.*11.*canonical saved camera is retained/);
    assert.match(result.conversion.report.losses.join(" "), /comparison.*pitch.*0.*20/);
    assert.equal(result.conversion.map.definition.layers[0].style.fill, "#ef4444");
    assert.deepEqual(result.conversion.map.definition.legend, result.returned.legend);
    assert.deepEqual(result.conversion.map.definition.mapLayout, result.returned.mapLayout);
    assert.deepEqual(result.conversion.map.definition.extensions.geolibre.project.secondaryMapViews,
      result.returned.secondaryMapViews);
    assert.equal(importGeoLibreProject(result.returned).map.definition.mapViews[1].zoom, 11,
      "A generic raw import still uses its incoming cameras without a trusted saved base");
    assert.deepEqual(f.map.definition, canonical);
  });

  it("keeps report status consistent with camera losses without changing conversion counts", async () => {
    const unchanged = await exchange(() => {}, cameraFixture());
    assert.equal(unchanged.cameraChanges.length, 0);
    assert.equal(unchanged.conversion.report.losses.length, 0);
    assert.equal(unchanged.conversion.report.summary.status, "lossless");
    const changed = await exchange(returned => {returned.secondaryMapViews[0].view.zoom = 11;}, cameraFixture());
    const originalSummary = importGeoLibreProject(changed.returned).report.summary;
    const counts = {...originalSummary};
    delete counts.status;
    for (const selected of [false, true, true, false]) {
      applyGeoLibreReturnCameraChoice(changed, selected);
      assert.ok(changed.conversion.report.losses.length);
      assert.equal(changed.conversion.report.summary.status, "lossy");
      const currentCounts = {...changed.conversion.report.summary};
      delete currentCounts.status;
      assert.deepEqual(currentCounts, counts);
    }
  });

  it("preserves secondary presentation edits and intentional removals independently of camera choice", async () => {
    const f = cameraFixture();
    f.map.definition.mapViews[1].title = "Saved title";
    const canonical = structuredClone(f.map.definition.mapViews);
    const unchanged = await exchange(() => {}, f);
    assert.deepEqual(unchanged.conversion.map.definition.mapViews, canonical,
      "An unchanged native label must not rewrite the saved title/label aliases");

    const edited = await exchange(returned => {
      returned.secondaryMapViews[0].label = "Edited title";
      returned.secondaryMapViews[0].view.zoom = 11;
    }, f);
    assert.equal(edited.conversion.map.definition.mapViews[1].label, "Edited title");
    assert.equal(edited.conversion.map.definition.mapViews[1].title, "Edited title");
    assert.equal(edited.conversion.map.definition.mapViews[1].zoom, 9);

    const removed = await exchange(returned => {
      delete returned.secondaryMapViews[0].label;
      delete returned.secondaryMapViews[0].viewKind;
      delete returned.secondaryMapViews[0].layerVisibility;
      returned.secondaryMapViews[0].view.zoom = 11;
    }, f);
    for (const selected of [false, true, false]) {
      applyGeoLibreReturnCameraChoice(removed, selected);
      const view = removed.conversion.map.definition.mapViews[1];
      for (const key of ["label", "title", "viewKind", "layerVisibility"]) assert.equal(Object.hasOwn(view, key), false);
      assert.equal(view.zoom, selected ? 11 : 9);
      assert.equal(view.viewId, "comparison");
    }
    assert.deepEqual(f.map.definition.mapViews, canonical);
    assert.deepEqual(removed.cameraChoices.canonicalViews, canonical);
  });

  it("discloses invalid secondary presentation values while retaining canonical values", async () => {
    const result = await exchange(returned => {
      returned.secondaryMapViews[0].label = {unmapped: true};
      returned.secondaryMapViews[0].viewKind = {unmapped: true};
      returned.secondaryMapViews[0].layerVisibility = "unmapped";
    }, cameraFixture());
    assert.deepEqual(result.conversion.map.definition.mapViews, result.map.definition.mapViews);
    assert.equal(result.cameraChoices.notices.length, 3);
    assert.match(result.conversion.report.losses.join(" "), /unsupported label.*unsupported viewKind.*unsupported layerVisibility/);
    assert.deepEqual(result.conversion.map.definition.extensions.geolibre.project.secondaryMapViews,
      result.returned.secondaryMapViews);
  });

  it("applies only explicitly selected camera patches and restores the same review deterministically", async () => {
    const f = cameraFixture();
    const canonical = structuredClone(f.map.definition.mapViews);
    const result = await exchange(returned => {
      returned.mapView.zoom = 7;
      Object.assign(returned.secondaryMapViews[0].view, {zoom: 11, bearing: 15, pitch: 20});
    }, f);
    const conversion = result.conversion;
    const review = result.review;
    const layers = conversion.map.definition.layers;
    const raw = structuredClone(conversion.map.definition.extensions.geolibre.project);
    const originalLosses = structuredClone(conversion.report.losses);
    assert.equal(applyGeoLibreReturnCameraChoice(result, true), result);
    assert.equal(result.conversion, conversion);
    assert.equal(result.review, review);
    assert.equal(result.conversion.map.definition.layers, layers);
    assert.deepEqual(result.conversion.map.definition.mapViews.map(view => view.viewId), ["overview", "comparison"]);
    assert.equal(result.conversion.map.definition.mapViews[0].zoom, 7);
    assert.equal(result.conversion.map.definition.mapViews[1].zoom, 11);
    assert.equal(result.conversion.map.definition.mapViews[1].bearing, 15);
    assert.equal(result.conversion.map.definition.mapViews[1].pitch, 20);
    assert.equal(result.conversion.map.definition.mapViews[1].label, canonical[1].label);
    assert.deepEqual(result.conversion.map.definition.mapViews[1].layerVisibility, canonical[1].layerVisibility);
    assert.equal(review.cameraChoice, "returned");
    assert.match(conversion.report.losses.join(" "), /explicitly selected/);
    const selectedLosses = structuredClone(conversion.report.losses);
    applyGeoLibreReturnCameraChoice(result, true);
    assert.deepEqual(conversion.report.losses, selectedLosses, "Retry cannot duplicate camera notices");
    applyGeoLibreReturnCameraChoice(result, false);
    assert.deepEqual(conversion.map.definition.mapViews, canonical);
    assert.deepEqual(conversion.report.losses, originalLosses);
    assert.deepEqual(conversion.map.definition.extensions.geolibre.project, raw);
    assert.deepEqual(result.cameraChoices.canonicalViews, canonical);
    assert.deepEqual(f.map.definition.mapViews, canonical);
    assert.throws(() => applyGeoLibreReturnCameraChoice(result, "false"), TypeError);
  });

  it("matches secondary cameras by stable identity and keeps missing, added or reordered views explicit", async () => {
    const f = cameraFixture();
    f.map.definition.mapViews.push({viewId: "third", center: [10, 20], zoom: 3, bearing: 0, pitch: 0});
    const result = await exchange(returned => {
      returned.secondaryMapViews.reverse();
      returned.secondaryMapViews[0].view.zoom = 8;
      returned.secondaryMapViews.push({id: "untrusted-new", view: {center: [30, 40], zoom: 6}});
    }, f);
    applyGeoLibreReturnCameraChoice(result, true);
    assert.deepEqual(result.conversion.map.definition.mapViews.map(view => view.viewId), ["overview", "comparison", "third"]);
    assert.equal(result.conversion.map.definition.mapViews[1].zoom, 9);
    assert.equal(result.conversion.map.definition.mapViews[2].zoom, 8);
    assert.match(result.review.limits.join(" "), /identities or order.*canonical view identities and order are retained/);
    assert.equal(result.conversion.map.definition.extensions.geolibre.project.secondaryMapViews[2].id, "untrusted-new");

    const missing = await exchange(returned => {returned.secondaryMapViews = [];}, cameraFixture());
    applyGeoLibreReturnCameraChoice(missing, true);
    assert.equal(missing.conversion.map.definition.mapViews[1].zoom, 9);
    assert.match(missing.conversion.report.losses.join(" "), /comparison.*missing or ambiguous/);
  });

  it("keeps ambiguous secondary cameras and makes selected bbox removal reversible", async () => {
    const duplicate = await exchange(returned => {
      returned.secondaryMapViews[0].view.zoom = 18;
      returned.secondaryMapViews.push(structuredClone(returned.secondaryMapViews[0]));
    }, cameraFixture());
    applyGeoLibreReturnCameraChoice(duplicate, true);
    assert.equal(duplicate.conversion.map.definition.mapViews[1].zoom, 9);
    assert.match(duplicate.review.limits.join(" "), /comparison.*missing or ambiguous/);

    const f = cameraFixture();
    const bbox = structuredClone(f.map.definition.mapViews[0].bbox);
    const removed = await exchange(returned => {delete returned.mapView.bbox;}, f);
    assert.deepEqual(removed.cameraChanges.find(change => change.field === "bbox"),
      {viewId: "overview", field: "bbox", before: bbox, returned: null});
    applyGeoLibreReturnCameraChoice(removed, true);
    assert.equal(Object.hasOwn(removed.conversion.map.definition.mapViews[0], "bbox"), false);
    applyGeoLibreReturnCameraChoice(removed, false);
    assert.deepEqual(removed.conversion.map.definition.mapViews[0].bbox, bbox);
  });

  it("retains the original and creates a deterministic derivative for edited geometries and attributes", async () => {
    const edit = (returned) => {
      returned.layers[0].geojson.features[0].geometry.coordinates[0] = 5;
      returned.layers[0].geojson.features[0].properties.count = 8;
    };
    const first = await exchange(edit);
    const second = await exchange(edit);
    const [original, derivative] = first.conversion.map.definition.layers;
    assert.deepEqual(original, first.map.definition.layers[0]);
    assert.notEqual(derivative.layerId, original.layerId);
    assert.equal(derivative.layerId, second.conversion.map.definition.layers[1].layerId);
    assert.equal(derivative.datasetId, `import:${derivative.layerId}`);
    assert.equal(derivative.datasetVersionId, undefined);
    assert.equal(first.conversion.records.embeddedDatasets.length, 1);
    assert.equal(first.conversion.records.embeddedDatasets[0].data.features[0].properties.count, 8);
    assert.equal(first.conversion.map.definition.activeLayerId, derivative.layerId);
    assert.deepEqual(first.review.changed, [{layerId: "sites", derivativeLayerId: derivative.layerId, changes: ["data", "geometries", "attributes"]}]);
    const provenance = first.conversion.map.definition.extensions.opengeoGeoLibreReturn;
    assert.deepEqual(provenance.inputs, [{layerId: "sites", datasetId: "dataset-sites", datasetVersionId: "version-sites"}]);
    assert.deepEqual(provenance.outputs, [{layerId: derivative.layerId, importRef: derivative.importRef, inputLayerIds: ["sites"], retention: "retained-output", reproducible: false}]);
    assert.match(first.review.limits.join(" "), /not declared reproducible/);
  });

  it("gives new outputs fresh identities without inventing exact input lineage", async () => {
    const result = await exchange((returned) => {
      returned.layers.push({...structuredClone(returned.layers[0]), id: "untrusted-new-id", name: "Buffer output"});
    });
    const output = result.conversion.map.definition.layers[1];
    assert.notEqual(output.layerId, "untrusted-new-id");
    assert.deepEqual(result.review.added, [output.layerId]);
    assert.deepEqual(result.conversion.map.definition.extensions.opengeoGeoLibreReturn.outputs[0].inputLayerIds, []);
    assert.match(result.review.limits.join(" "), /no verified input lineage/);
  });

  it("reviews layer removal independently from persistent data deletion", async () => {
    const result = await exchange((returned) => {returned.layers = [];});
    assert.deepEqual(result.review.removed, ["sites"]);
    assert.deepEqual(result.conversion.map.definition.layers, []);
    assert.deepEqual(result.conversion.map.definition.extensions.opengeoGeoLibreReturn.inputs, [{layerId: "sites", datasetId: "dataset-sites", datasetVersionId: "version-sites"}]);
    assert.equal(result.map.definition.layers[0].datasetId, "dataset-sites");
  });

  it("detects concurrent edits and rejects a forged saved-revision or Project identity", async () => {
    const f = fixture();
    const handoff = await createGeoLibreHandoff({projectId, ...f});
    const conversion = importGeoLibreProject(handoff.json);
    const options = {conversion, projectId, baseMap: f.map, currentMap: {...f.map, version: 4}, embeddedDataByLayerId: f.embeddedDataByLayerId};
    assert.equal((await reviewGeoLibreReturn(options)).review.conflict, true);
    for (const change of [{projectId: "wrong-project"}, {baseMap: {...f.map, version: 2}}, {baseMap: {...f.map, definition: {...f.map.definition, projection: "modified"}}}]) {
      await assert.rejects(reviewGeoLibreReturn({...options, ...change}), {code: "geolibre_handoff_mismatch"});
    }
    handoff.project.metadata.opengeo.handoff.definitionSha256 = "0".repeat(64);
    await assert.rejects(reviewGeoLibreReturn({...options, conversion: importGeoLibreProject(handoff.project)}), {code: "geolibre_handoff_mismatch"});
  });

  it("registers changed external references as derivatives without copying remote data", async () => {
    const f = fixture();
    f.map.definition.layers[0] = {
      layerId: "tiles", datasetId: "dataset-tiles", datasetVersionId: null, sourceType: "xyz-raster", sourceVersion: 1,
      title: "Tiles", sourceUrl: "https://tiles.example.test/{z}/{x}/{y}.png", visible: true,
      opacity: 1, order: 0, style: {}, labels: {enabled: false, field: null}
    };
    const handoff = await createGeoLibreHandoff({projectId, ...f});
    handoff.project.layers[0].source.url = "https://other.example.test/{z}/{x}/{y}.png";
    handoff.project.layers[0].source.tiles = [handoff.project.layers[0].source.url];
    const result = await reviewGeoLibreReturn({conversion: importGeoLibreProject(handoff.project), projectId, baseMap: f.map, currentMap: f.map});
    assert.equal(result.conversion.records.embeddedDatasets.length, 0);
    assert.equal(result.conversion.records.externalSources.length, 1);
    assert.equal(result.conversion.map.definition.layers.length, 2);
    assert.equal(result.conversion.records.externalSources[0].source.url, "https://other.example.test/{z}/{x}/{y}.png");
    assert.deepEqual(result.conversion.map.definition.extensions.opengeoGeoLibreReturn.inputs, [{layerId: "tiles", datasetId: "dataset-tiles"}]);
    assert.equal(result.conversion.map.definition.layers[0].datasetVersionId, null);
  });

  it("preserves unsupported source originals and discloses unpersistable return changes", async () => {
    const f = fixture();
    f.map.definition.layers[0].sourceType = "postgis-live";
    const handoff = await createGeoLibreHandoff({projectId, ...f});
    const options = {projectId, baseMap: f.map, currentMap: f.map};
    const unchanged = await reviewGeoLibreReturn({...options, conversion: importGeoLibreProject(handoff.json)});
    assert.deepEqual(unchanged.conversion.map.definition.layers, f.map.definition.layers);
    assert.match(unchanged.review.limits.join(" "), /hidden empty placeholder/);
    handoff.project.layers[0].source.url = "https://data.example.test/sites.geojson";
    delete handoff.project.layers[0].geojson;
    const changed = await reviewGeoLibreReturn({...options, conversion: importGeoLibreProject(handoff.project)});
    assert.deepEqual(changed.conversion.map.definition.layers, f.map.definition.layers);
    assert.match(changed.review.limits.join(" "), /no governed return adapter/);
    assert.deepEqual(changed.conversion.records.embeddedDatasets, []);
  });
});
