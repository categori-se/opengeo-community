import assert from "node:assert/strict";
import test from "node:test";
import {
  BASEMAP_ACTIVATION_LIMITS,
  basemapActivationFailureMessage,
  basemapProbeStyle,
  basemapProbeView,
  basemapRequiresNetworkProbe
} from "../src/lib/basemapActivation.js";

test("network-backed styles and rasters require a staged renderer", () => {
  assert.equal(basemapRequiresNetworkProbe({kind: "maplibre-style"}), true);
  assert.equal(basemapRequiresNetworkProbe({kind: "provider-raster"}), true);
  assert.equal(basemapRequiresNetworkProbe({kind: "blank"}), false);
  assert.equal(basemapRequiresNetworkProbe({kind: "planetary-blank"}), false);
  assert.equal(BASEMAP_ACTIVATION_LIMITS.timeoutMilliseconds, 8_000);
});

test("a vector candidate retains its exact public style URL", () => {
  assert.equal(
    basemapProbeStyle({kind: "maplibre-style", styleUrl: "https://maps.example.test/style.json"}),
    "https://maps.example.test/style.json"
  );
});

test("a raster candidate probe retains source limits, attribution, and coverage", () => {
  const style = basemapProbeStyle({
    kind: "governed-raster",
    url: "https://tiles.example.test/{z}/{x}/{y}.png",
    tileSize: 512,
    scheme: "tms",
    minZoom: 3,
    maxZoom: 14,
    attribution: "Example agency",
    sourceConfiguration: {coverageBounds: [80, 26, 89, 31]}
  });
  assert.deepEqual(style.sources.candidate, {
    type: "raster",
    tiles: ["https://tiles.example.test/{z}/{x}/{y}.png"],
    tileSize: 512,
    scheme: "tms",
    minzoom: 3,
    maxzoom: 14,
    bounds: [80, 26, 89, 31],
    attribution: "Example agency"
  });
  assert.deepEqual(style.layers, [{id: "candidate", type: "raster", source: "candidate"}]);
});

test("regional probes use the governed coverage while global probes retain the camera", () => {
  assert.deepEqual(
    basemapProbeView(
      {minZoom: 3, maxZoom: 14, sourceConfiguration: {coverageBounds: [80, 26, 89, 31]}},
      {center: [-77, 39], zoom: 20}
    ),
    {center: [84.5, 28.5], zoom: 14}
  );
  assert.deepEqual(
    basemapProbeView({}, {center: [-77, 39], zoom: 8}),
    {center: [-77, 39], zoom: 8}
  );
});

test("failure copy names the candidate without exposing provider details", () => {
  assert.equal(
    basemapActivationFailureMessage({
      candidateTitle: "Fiord",
      currentTitle: "Positron",
      code: "timeout"
    }),
    "Fiord did not become ready within 8 seconds. Positron is still displayed and remains the saved selection."
  );
});

test("explicit global coverage does not move an in-coverage imagery probe to the ocean", () => {
  assert.deepEqual(basemapProbeView({
    minZoom: 1, maxZoom: 16,
    sourceConfiguration: {coverageBounds: [-180, -85.05112878, 180, 85.05112878]}
  }, {center: [-77.0369, 38.9072], zoom: 12}), {
    center: [-77.0369, 38.9072], zoom: 12
  });
  assert.deepEqual(basemapProbeView({
    minZoom: 3, maxZoom: 14,
    sourceConfiguration: {coverageBounds: [80, 26, 89, 31]}
  }, {center: [85.324, 27.7172], zoom: 8}), {
    center: [85.324, 27.7172], zoom: 8
  });
});
