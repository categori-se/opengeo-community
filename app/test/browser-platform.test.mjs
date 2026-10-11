import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {
  BROWSER_PLATFORM_LIMITS,
  MAP_EXPORT_SCHEMA_VERSION,
  accessibleFeaturePopup,
  browserLoadingSummary,
  canvasJpegBlob,
  canvasPngBlob,
  createMapExportManifest,
  evaluateExtensionCapability,
  extensionPolicy,
  recordExtensionAudit,
  renderedFeatureHit
} from "../src/lib/browserPlatform.js";

describe("governed browser-platform boundary", () => {
  it("allows only fixed UI capabilities and audits denied authority requests", () => {
    assert.deepEqual(extensionPolicy("catalog").capabilities, ["catalog:navigate"]);
    assert.equal(evaluateExtensionCapability("catalog", "catalog:navigate").allowed, true);
    for (const capability of ["source:read", "data:write", "permission:grant", "audit:erase"]) {
      const decision = evaluateExtensionCapability("catalog", capability);
      assert.deepEqual(decision, {
        extensionId: "catalog",
        capability,
        allowed: false,
        reason: "capability_not_granted"
      });
    }
    const unknown = evaluateExtensionCapability("remote-code", "source:read");
    assert.equal(unknown.allowed, false);
    assert.equal(unknown.reason, "extension_not_registered");
    const audit = recordExtensionAudit([], unknown, {
      now: () => new Date("2026-08-31T18:00:00Z")
    });
    assert.deepEqual(audit[0], {
      schemaVersion: "opengeo.browser-platform.1.0.0",
      observedAt: "2026-08-31T18:00:00.000Z",
      extensionId: "remote-code",
      capability: "source:read",
      outcome: "denied",
      reason: "extension_not_registered"
    });
    let bounded = [];
    for (let index = 0; index < BROWSER_PLATFORM_LIMITS.maximumExtensionAuditEvents + 5; index += 1) {
      bounded = recordExtensionAudit(bounded, unknown);
    }
    assert.equal(bounded.length, BROWSER_PLATFORM_LIMITS.maximumExtensionAuditEvents);
  });

  it("exposes one aggregate loading and retained-error status", () => {
    assert.deepEqual(browserLoadingSummary({
      loadingDatasetLayerIds: new Set(["archive"]),
      liveFeatureRequests: new Map([["live", {}]]),
      layers: [{liveFeatureState: "ready"}, {liveFeatureState: "error"}],
      basemapActivationState: "loading"
    }), {
      schemaVersion: "opengeo.browser-platform.1.0.0",
      pending: 3,
      ready: 1,
      failed: 1,
      message: "Loading 3 map sources."
    });
    assert.match(browserLoadingSummary({
      layers: [{liveFeatureState: "error"}]
    }).message, /source could not load/);
  });

  it("bounds hit detection to declared rendered layers", () => {
    const calls = [];
    const map = {
      getLayer: (id) => id === "visible",
      queryRenderedFeatures(point, options) {
        calls.push({point, options});
        return [{id: 1}];
      }
    };
    assert.equal(renderedFeatureHit(map, {x: 4, y: 7}, ["visible", "hidden", "visible"]), true);
    assert.deepEqual(calls, [{point: {x: 4, y: 7}, options: {layers: ["visible"]}}]);
    assert.equal(renderedFeatureHit(map, {x: 4, y: 7}, ["hidden"]), false);
  });

  it("creates a keyboard-focusable popup without HTML injection", () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    const previous = globalThis.document;
    globalThis.document = dom.window.document;
    try {
      const popup = accessibleFeaturePopup({
        title: "Road <script>",
        properties: {name: "<img src=x onerror=alert(1)>", surveyed: true}
      });
      assert.equal(popup.role, "dialog");
      assert.equal(popup.tabIndex, -1);
      assert.match(popup.getAttribute("aria-label"), /Road <script> details/);
      assert.equal(popup.querySelector("script"), null);
      assert.equal(popup.querySelector("img"), null);
      assert.match(popup.textContent, /<img src=x onerror=alert\(1\)>/);
    } finally {
      globalThis.document = previous;
      dom.window.close();
    }
  });

  it("exports a bounded PNG plus credential-free source and attribution receipt", async () => {
    const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const canvas = {
      width: 1200,
      height: 800,
      toBlob(callback, type) {
        assert.equal(type, "image/png");
        callback(new Blob([signature], {type}));
      }
    };
    const map = {
      getCenter: () => ({lng: -71.1, lat: 42.3}),
      getZoom: () => 8,
      getBearing: () => 12,
      getPitch: () => 30
    };
    const manifest = createMapExportManifest({
      workspace: {workspaceId: "workspace-1", title: "MassGIS", classification: "internal"},
      project: {projectId: "project-1", mapId: "map-1", name: "Screening map"},
      map,
      canvas,
      basemap: {basemapId: "positron", title: "Positron", kind: "maplibre-style", attribution: "© Basemap"},
      layers: [{
        layerId: "pm25",
        datasetId: "dataset-1",
        title: "PM2.5",
        sourceType: "governed-dataset",
        sourceVersion: 3,
        sourceUrl: "https://user:secret@example.test/data?token=secret",
        attribution: "MassGIS",
        opacity: 0.8,
        visible: true
      }],
      observedAt: new Date("2026-08-31T18:05:00Z")
    });
    assert.equal(manifest.schemaVersion, MAP_EXPORT_SCHEMA_VERSION);
    assert.deepEqual(manifest.image, {mediaType: "image/png", width: 1200, height: 800, pixels: 960000});
    assert.deepEqual(manifest.camera, {center: [-71.1, 42.3], zoom: 8, bearing: 12, pitch: 30});
    assert.deepEqual(manifest.attribution, ["© Basemap", "MassGIS"]);
    assert.equal(manifest.authorityIncluded, false);
    assert.equal(manifest.sourceUrlsIncluded, false);
    assert.doesNotMatch(JSON.stringify(manifest), /secret|token=/);
    const png = await canvasPngBlob(canvas);
    assert.equal(png.type, "image/png");
    assert.equal(png.size, signature.byteLength);
  });

  it("rejects oversized canvases and non-PNG bytes", async () => {
    assert.throws(() => createMapExportManifest({
      canvas: {width: 4096, height: 4096},
      observedAt: new Date()
    }), (error) => error.code === "map_export_dimensions_exceeded");
    await assert.rejects(canvasPngBlob({
      width: 100,
      height: 100,
      toBlob: (callback) => callback(new Blob(["not a png"], {type: "image/png"}))
    }), (error) => error.code === "map_export_invalid_png");
  });

  it("records JPEG format and white background without disclosing source credentials", () => {
    const manifest = createMapExportManifest({
      format: "jpeg",
      canvas: {width: 1200, height: 800},
      layers: [{layerId: "roads", sourceUrl: "https://user:secret@example.test/data?token=secret"}],
      observedAt: new Date("2026-10-07T22:00:00Z")
    });
    assert.deepEqual(manifest.image, {
      mediaType: "image/jpeg", width: 1200, height: 800, pixels: 960000,
      background: "#ffffff", quality: 0.92
    });
    assert.equal(manifest.authorityIncluded, false);
    assert.equal(manifest.sourceUrlsIncluded, false);
    assert.doesNotMatch(JSON.stringify(manifest), /secret|token=/);
    for (const format of ["jpg", "webp", "image/jpeg", null]) {
      assert.throws(() => createMapExportManifest({format, canvas: {width: 10, height: 10}}),
        (error) => error.code === "map_export_format_unsupported");
    }
  });

  it("flattens JPEG transparency onto a separate white canvas before encoding", async () => {
    const fixture = jpegCanvasFixture();
    const jpeg = await canvasJpegBlob(fixture.canvas);
    assert.equal(jpeg.type, "image/jpeg");
    assert.deepEqual(fixture.operations, [
      ["context", "2d", {alpha: false}],
      ["fill", "#ffffff", 0, 0, 1200, 800],
      ["draw", fixture.canvas, 0, 0],
      ["encode", "image/jpeg", 0.92]
    ]);
    assert.notEqual(fixture.opaqueCanvas, fixture.canvas);
    assert.equal(fixture.opaqueCanvas.width, fixture.canvas.width);
    assert.equal(fixture.opaqueCanvas.height, fixture.canvas.height);
    assert.equal(fixture.canvas.getContext, undefined);
  });

  it("rejects invalid JPEG media, markers, excessive bytes and dimensions", async () => {
    const validMarkers = Uint8Array.from([255, 216, 255, 224, 255, 217]);
    for (const blob of [
      new Blob([validMarkers], {type: "image/png"}),
      new Blob(["not a jpeg"], {type: "image/jpeg"}),
      new Blob([validMarkers.subarray(0, 4)], {type: "image/jpeg"})
    ]) {
      await assert.rejects(canvasJpegBlob(jpegCanvasFixture({blob}).canvas),
        (error) => error.code === "map_export_invalid_jpeg");
    }
    const oversized = {type: "image/jpeg", size: BROWSER_PLATFORM_LIMITS.maximumExportBytes + 1};
    await assert.rejects(canvasJpegBlob(jpegCanvasFixture({blob: oversized}).canvas),
      (error) => error.code === "map_export_size_exceeded");
    const largeCanvas = jpegCanvasFixture();
    largeCanvas.canvas.width = 4096;
    largeCanvas.canvas.height = 4096;
    await assert.rejects(canvasJpegBlob(largeCanvas.canvas),
      (error) => error.code === "map_export_dimensions_exceeded");
    assert.deepEqual(largeCanvas.operations, []);
  });

  it("fails safely when JPEG composition or encoding is unavailable", async () => {
    await assert.rejects(canvasJpegBlob({width: 10, height: 10}),
      (error) => error.code === "map_export_unavailable");
    const missingContext = jpegCanvasFixture();
    missingContext.opaqueCanvas.getContext = () => null;
    await assert.rejects(canvasJpegBlob(missingContext.canvas),
      (error) => error.code === "map_export_unavailable");
    await assert.rejects(canvasJpegBlob(jpegCanvasFixture({blob: null}).canvas),
      (error) => error.code === "map_export_unavailable");
    const blocked = jpegCanvasFixture();
    blocked.opaqueCanvas.toBlob = () => {throw new Error("blocked canvas");};
    await assert.rejects(canvasJpegBlob(blocked.canvas), /blocked canvas/);
  });
});

function jpegCanvasFixture({blob = new Blob([Uint8Array.from([255, 216, 255, 224, 255, 217])], {type: "image/jpeg"})} = {}) {
  const operations = [];
  const context = {
    fillStyle: "",
    fillRect(...args) {operations.push(["fill", this.fillStyle, ...args]);},
    drawImage(...args) {operations.push(["draw", ...args]);}
  };
  const opaqueCanvas = {
    getContext(type, attributes) {
      operations.push(["context", type, attributes]);
      return context;
    },
    toBlob(callback, mediaType, quality) {
      operations.push(["encode", mediaType, quality]);
      callback(blob);
    }
  };
  const canvas = {
    width: 1200, height: 800,
    ownerDocument: {createElement(tag) {assert.equal(tag, "canvas"); return opaqueCanvas;}}
  };
  return {canvas, opaqueCanvas, operations};
}
