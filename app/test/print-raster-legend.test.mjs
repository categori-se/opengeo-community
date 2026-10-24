import assert from "node:assert/strict";
import {test} from "node:test";
import {capturePrintRasterLegend, rasterLegendGroups} from "../src/lib/printRasterLegend.js";

function fixture() {
  const source = {layerId: "elevation", datasetId: "dataset", datasetVersionId: "version", sourceVersion: 2};
  const layer = {...source, title: "Elevation", sourceType: "cog-raster", sourceUrl: "https://imagery.example/elevation.tif",
    sourceConfiguration: {bands: [2]}, visible: true, opacity: 0.45,
    style: {cogDisplay: {displayRange: {minimum: -120, maximum: 3400}, noDataValue: -9998}}};
  const forbidden = () => {throw Error("Print must reuse the loaded raster without reads or refreshes");};
  const handle = {sourceId: "raster-source", cog: {loading: false,
    result: {displayRange: {...layer.style.cogDisplay.displayRange}, noDataValue: -9998},
    grid: {active: () => true, metadata: {bands: [2], noData: -9999, source: {url: layer.sourceUrl}}, value: forbidden}, refresh: forbidden}};
  const paints = [{type: "raster", source: "raster-source", paint: {"raster-opacity": 0.45, "raster-fade-duration": 0}}];
  const captured = () => capturePrintRasterLegend(layer, handle, paints);
  const capture = () => {const value = captured();return {legend: [{label: "Previous Layer"}, ...value.rows],
    rasterLegends: [{start: 1, count: value.rows.length, ...value.descriptor}],
    presentation: [{...source, visible: true, opacity: layer.opacity, style: structuredClone(layer.style)}],
    sourceMetadata: [{...source, title: layer.title, license: "CC BY 4.0"}]};};
  return {layer, handle, paints, captured, capture};
}

test("captures the explicit negative-to-positive band scale and transparency from cached metadata without reads", () => {
  const data = fixture(), before = JSON.stringify({layer: data.layer, result: data.handle.cog.result, paints: data.paints});
  const {rows, descriptor} = data.captured();
  assert.equal(rows.length, 4);assert.deepEqual(rows.slice(0, 2).map(row => row.color), ["#000000", "#ffffff"]);
  assert.match(rows[0].label, /Band 2 -120$/);assert.match(rows[1].label, /Band 2 3400$/);
  assert.equal(rows[2].color, "none");assert.match(rows[2].label, /source NoData -9999; explicit value -9998/);
  assert.match(descriptor.note, /clamped/);assert.match(descriptor.note, /nonfinite/);assert.match(descriptor.note, /before map opacity \(0\.45\)/);
  assert.deepEqual(descriptor.sourcePin, {layerId: "elevation", datasetId: "dataset", datasetVersionId: "version", sourceVersion: 2});
  assert.equal(descriptor.band, 2);assert.equal(descriptor.sourceNoDataValue, -9999);
  assert.doesNotMatch(JSON.stringify(descriptor), /https:|pixels|rasters|url|window/);
  assert.equal(JSON.stringify({layer: data.layer, result: data.handle.cog.result, paints: data.paints}), before);
});

test("returns ordinary non-raster control and honest unavailable rows for implicit, RGB and transformed displays", () => {
  assert.equal(capturePrintRasterLegend({sourceType: "geojson-object"}), null);
  const implicit = fixture();implicit.layer.style = {};implicit.handle.cog.result.displayRange = null;implicit.handle.cog.result.noDataValue = null;
  assert.match(implicit.captured().rows[0].label, /explicit grayscale display range/);assert.equal(implicit.captured().descriptor, undefined);
  const rgb = fixture();rgb.layer.sourceConfiguration.bands = [1, 2, 3];rgb.handle.cog.grid.metadata.bands = [1, 2, 3];
  rgb.layer.style = {};rgb.handle.cog.result.displayRange = null;rgb.handle.cog.result.noDataValue = null;
  assert.match(rgb.captured().rows[0].label, /RGB imagery/);assert.equal(rgb.captured().descriptor, undefined);
  for (const paint of [{"raster-contrast": 0.5}, {"raster-color": "#ff0000"}, {"raster-fade-duration": 300}, {"raster-opacity-transition": {duration: 100}}]) {
    const data = fixture();Object.assign(data.paints[0].paint, paint);
    const result = data.captured();assert.equal(result.descriptor, undefined);assert.match(result.rows[0].label, /installed raster paint/);
  }
});

test("refuses loading, released, mismatched source, bands, ranges, transparent values and installed opacity", () => {
  for (const mutate of [data => {data.handle.cog.loading = true;}, data => {data.handle.cog.result = null;},
    data => {data.handle.cog.grid.active = () => false;}, data => {data.handle.cog.grid.metadata.source.url += ".old";},
    data => {data.handle.cog.grid.metadata.bands = [1];}, data => {data.handle.cog.result.displayRange.maximum++;},
    data => {data.handle.cog.result.noDataValue = null;}, data => {data.paints[0].paint["raster-opacity"] = 0.8;},
    data => {data.paints.push({...data.paints[0]});}, data => {data.paints[0].source = "other-source";}]) {
    const data = fixture();mutate(data);assert.throws(data.captured, /raster display changed/);
  }
  const malformed = fixture();malformed.layer.style.cogDisplay.displayRange.maximum = Infinity;assert.throws(malformed.captured, /finite/);
});

test("validates exact rows and source/presentation pins before adapting a raster legend into the existing color bar", () => {
  const data = fixture(), capture = data.capture(), before = JSON.stringify(capture), group = rasterLegendGroups(capture).get(1);
  assert.equal(group.field, "Band 2");assert.equal(group.count, 4);assert.equal(group.opacity, 0.45);
  assert.deepEqual(group.stops, [{value: -120, color: "#000000"}, {value: 3400, color: "#ffffff"}]);
  assert.equal(group.noData.color, "none");assert.match(group.noData.label, /nonfinite values/);
  assert.equal(JSON.stringify(capture), before);group.displayRange.minimum = 10;group.sourcePin.sourceVersion = 99;
  assert.equal(capture.rasterLegends[0].displayRange.minimum, -120);assert.equal(capture.rasterLegends[0].sourcePin.sourceVersion, 2);
  assert.equal(rasterLegendGroups({}).size, 0);
});

test("rejects malformed metadata, injected URLs, changed rows, duplicate or overlapping groups and stale source pins", () => {
  for (const mutate of [capture => {capture.rasterLegends[0].url = "https://private.example/object";},
    capture => {capture.rasterLegends[0].displayRange.url = "https://private.example/object";},
    capture => {capture.rasterLegends[0].sourcePin.url = "https://private.example/object";},
    capture => {capture.rasterLegends[0].displayRange.minimum = -Infinity;},
    capture => {capture.rasterLegends[0].band = 0;}, capture => {capture.rasterLegends[0].opacity = NaN;},
    capture => {capture.rasterLegends[0].sourceNoDataValue = [1, 2];}, capture => {capture.rasterLegends[0].note = "Invented";},
    capture => {capture.legend[1].color = "#000001";}, capture => {capture.legend[3].color = "#ffffff";},
    capture => {capture.legend[1].extra = "secret";}, capture => {capture.rasterLegends[0].start = 0;},
    capture => {capture.rasterLegends.push({...capture.rasterLegends[0]});},
    capture => {capture.rasterLegends = Array(21).fill(capture.rasterLegends[0]);},
    capture => {capture.presentation[0].sourceVersion++;}, capture => {capture.sourceMetadata[0].datasetVersionId = "stale";},
    capture => {capture.presentation[0].style.cogDisplay.displayRange.minimum--;},
    capture => {capture.presentation[0].opacity = 1;}, capture => {capture.presentation[0].visible = false;},
    capture => {capture.presentation.push({...capture.presentation[0]});}, capture => {capture.sourceMetadata[0].title = "Changed";}]) {
    const capture = fixture().capture();mutate(capture);assert.throws(() => rasterLegendGroups(capture), /raster/);
  }
});

test("retains NaN source NoData and absent explicit transparency without inventing a numeric nodata color", () => {
  const data = fixture();data.layer.style.cogDisplay.noDataValue = null;data.handle.cog.result.noDataValue = null;
  data.handle.cog.grid.metadata.noData = "NaN";
  const result = data.captured();assert.equal(result.descriptor.noDataValue, null);assert.equal(result.descriptor.sourceNoDataValue, "NaN");
  assert.match(result.rows[2].label, /source NoData NaN/);assert.doesNotMatch(result.rows[2].label, /explicit value/);
  assert.match(rasterLegendGroups(data.capture()).get(1).noData.label, /nonfinite values; source NoData NaN/);
});

test("managed native COG legends bind the exact logical original without tickets or new reads", () => {
  const data = fixture();
  Object.assign(data.layer, {sourceType: "governed-dataset", geometryType: "Raster",
    datasetId: "10000000-0000-4000-8000-000000000011", datasetVersionId: "10000000-0000-4000-8000-000000000012"});
  delete data.layer.sourceUrl;
  data.handle.cog.grid.metadata.source.url = `urn:opengeo:dataset:${data.layer.datasetId}:version:${data.layer.datasetVersionId}:original`;
  const result = data.captured();
  assert.equal(result.descriptor.sourcePin.datasetId, data.layer.datasetId);
  assert.equal(result.descriptor.sourcePin.datasetVersionId, data.layer.datasetVersionId);
  assert.equal(result.descriptor.band, 2);
  assert.doesNotMatch(JSON.stringify(result), /https:|X-Amz-|sourceUrl|pixels|rasters/);
  data.handle.cog.loading = true;
  assert.throws(data.captured, /raster display changed/);
  data.handle.cog.loading = false;
  data.handle.cog.grid.metadata.source.url += "-stale";
  assert.throws(data.captured, /raster display changed/);
});

test("managed raster legends refuse mismatched pins, malformed identities and transport URLs", () => {
  for (const mutate of [data => {data.layer.datasetVersionId = "10000000-0000-4000-8000-000000000013";},
    data => {data.layer.datasetId = "not-a-dataset";},
    data => {data.layer.sourceUrl = "https://private.invalid/secret?X-Amz-Signature=private";}]) {
    const data = fixture();
    Object.assign(data.layer, {sourceType: "governed-dataset", geometryType: "Raster",
      datasetId: "10000000-0000-4000-8000-000000000011", datasetVersionId: "10000000-0000-4000-8000-000000000012"});
    delete data.layer.sourceUrl;
    data.handle.cog.grid.metadata.source.url = `urn:opengeo:dataset:${data.layer.datasetId}:version:${data.layer.datasetVersionId}:original`;
    mutate(data);assert.throws(data.captured, /raster display changed/);
  }
});
