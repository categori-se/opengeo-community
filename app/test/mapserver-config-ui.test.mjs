import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {ProjectResources} from "../src/components/ProjectResources.js";

const IDS = Object.freeze({
  project: "50000000-0000-4000-8000-000000000001",
  resource: "a0000000-0000-4000-8000-000000000001",
  dataset: "80000000-0000-4000-8000-000000000001",
  style: "d0000000-0000-4000-8000-000000000001",
  user: "20000000-0000-4000-8000-000000000001"
});

let harness;

beforeEach(() => {
  harness = installDom();
});

afterEach(() => {
  harness.restore();
  harness.dom.window.close();
  harness = null;
});

describe("MapServer configuration administration", () => {
  it("uses one governed style workflow and explains conversion losses and limits", async () => {
    const calls = [];
    const styles = [];
    const resource = governedDatasetResource();
    const adapter = {
      getResource: async () => resource,
      listResourceStyles: async () => structuredClone(styles),
      importMapServerStyle: async (projectId, resourceId, source) => {
        calls.push({projectId, resourceId, source});
        const canonicalMapfile = source.mapfile.replace(
          /\n\s*(?:CONNECTION|DATA)\s+[^\n]+/gi,
          ""
        );
        const definition = JSON.stringify({
          version: 8,
          sources: {},
          layers: [{
            id: "mapserver-imported-layer",
            type: "line",
            paint: {"line-color": "#275d52", "line-width": 2}
          }],
          metadata: {opengeo: {mapserver_adapter: {
            source_version: "8.6.5",
            canonical_mapfile: canonicalMapfile
          }}}
        });
        const style = portableStyle(definition);
        styles.push(style);
        return {
          style,
          canonicalMapfile,
          report: {
            losses: [{code: "governed_binding_required"}],
            removed_data_bindings: ["CONNECTION", "DATA"],
            mapscript: {supplied: false, executed: false, stored: false}
          },
          activation: {
            styleId: IDS.style,
            geometryLayerId: "mapserver-imported-layer",
            labelLayerId: null,
            minimumScaleDenominator: null,
            maximumScaleDenominator: null,
            includeLegend: false
          },
          requestLimits: {
            requestsPerMinute: 60,
            concurrentRequestsPerProject: 4,
            maximumLayersPerRequest: 16,
            maximumWidth: 2048,
            maximumHeight: 2048,
            maximumPixels: 4_194_304,
            maximumRuntimeSeconds: 8
          }
        };
      },
      exportMapServerStyle: async () => ({
        styleId: IDS.style,
        filename: "imported.map",
        mediaType: "text/vnd.mapserver.mapfile",
        mapfile: "MAP\nEND\n",
        report: {status: "exported_detached_configuration"}
      })
    };
    const state = {
      project: {id: IDS.project},
      organization: {callerRole: "member"},
      adapter,
      resources: [resource],
      datasets: [],
      maps: []
    };
    const panel = ProjectResources({state});
    document.body.append(panel);

    click(panel, "Open resource");
    await waitFor(() => panel.querySelector(".project-resource-detail")?.dataset.state === "ready");
    const format = panel.querySelector('select[aria-label="Style format"]');
    format.value = "mapserver_mapfile";
    format.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));

    assert.ok(button(panel, "Import Mapfile"));
    assert.match(panel.textContent, /MapScript is never executed/);
    const source = panel.querySelector('textarea[aria-label="Detached style definition"]');
    source.value = source.value.replace(
      "    CLASS",
      '    CONNECTION "postgresql://secret"\n    DATA "roads"\n    CLASS'
    );
    click(panel, "Import Mapfile");

    await waitFor(() => state.lastMapServerStyleImport);
    await waitFor(() => panel.textContent.includes("MapServer import completed"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].projectId, IDS.project);
    assert.match(calls[0].source.mapfile, /CONNECTION/);
    assert.match(panel.textContent, /1 declared conversion loss/);
    assert.match(panel.textContent, /2 source bindings removed/);
    assert.match(panel.textContent, /MapScript was not executed/);
    assert.match(panel.textContent, /60 requests\/minute, 4 concurrent requests/);
    assert.match(panel.textContent, /MapServer 8.6.5 → MapLibre/);
    assert.ok(button(panel, "Export detached Mapfile"));
    assert.equal(
      panel.querySelector('input[aria-label="Geometry layer id"]').value,
      "mapserver-imported-layer"
    );
    assert.match(panel.textContent, /validated but inactive/);
    assert.ok(button(panel, "Compile render profile"));
  });

  it("keeps an individual resource rating private while showing only its aggregate", async () => {
    const calls = [];
    const resource = governedDatasetResource();
    let rating = {
      projectId: IDS.project,
      resourceId: IDS.resource,
      ratingCount: 0,
      ratingAverage: null,
      callerScore: null,
      callerVersion: null,
      callerWithdrawn: false,
      updatedAt: null
    };
    const adapter = {
      getResource: async () => resource,
      getResourceRating: async () => structuredClone(rating),
      async setResourceRating(projectId, resourceId, update) {
        calls.push({projectId, resourceId, update});
        const version = (rating.callerVersion ?? 0) + 1;
        const active = update.score !== null;
        rating = {
          ...rating,
          ratingCount: active ? 1 : 0,
          ratingAverage: active ? update.score : null,
          callerScore: update.score,
          callerVersion: version,
          callerWithdrawn: !active,
          updatedAt: new Date().toISOString()
        };
        return {changed: true, summary: structuredClone(rating)};
      }
    };
    const state = {
      project: {id: IDS.project, callerRole: "viewer"},
      organization: {callerRole: "member"},
      adapter,
      resources: [resource],
      metadataProfiles: [],
      datasets: [],
      maps: []
    };
    const panel = ProjectResources({state});
    document.body.append(panel);

    click(panel, "Open resource");
    await waitFor(() => panel.querySelector(".project-resource-rating"));
    assert.match(panel.textContent, /Your rating is private/);
    assert.match(panel.textContent, /voter identities are never returned/);
    const score = panel.querySelector('[aria-label="Your rating"]');
    score.value = "4";
    score.closest("form").dispatchEvent(new harness.dom.window.Event("submit", {
      bubbles: true,
      cancelable: true
    }));
    await waitFor(() => panel.textContent.includes("4.0 of 5 · 1 rating"));
    assert.deepEqual(calls[0], {
      projectId: IDS.project,
      resourceId: IDS.resource,
      update: {score: 4, expectedVersion: null}
    });

    const withdraw = panel.querySelector('[aria-label="Your rating"]');
    withdraw.value = "";
    withdraw.closest("form").dispatchEvent(new harness.dom.window.Event("submit", {
      bubbles: true,
      cancelable: true
    }));
    await waitFor(() => panel.textContent.includes("Your prior rating is withdrawn"));
    assert.deepEqual(calls[1].update, {score: null, expectedVersion: 1});
  });
});

function governedDatasetResource() {
  return {
    id: IDS.resource,
    projectId: IDS.project,
    kind: "dataset",
    slug: "roads",
    datasetId: IDS.dataset,
    mapId: null,
    visibility: "restricted",
    state: "draft",
    versionNumber: 1,
    title: "Roads",
    abstract: "Governed roads",
    language: "en",
    license: "CC-BY-4.0",
    attribution: "OpenGeo",
    keywords: ["roads"],
    spatialExtent: [-71.2, 42.1, -71.0, 42.4],
    temporalStart: null,
    temporalEnd: null,
    ownerUserId: IDS.user,
    originNamespace: null,
    originIdentifier: null,
    relationshipCount: 0,
    createdAt: "2026-08-31T12:00:00Z",
    updatedAt: "2026-08-31T12:00:00Z",
    metadataProfile: "opengeo.core.v1",
    metadataExtensions: {},
    translations: {},
    content: {blocks: []},
    provenance: {sourceSystem: "opengeo"},
    changeMessage: null,
    versionCreatedBy: IDS.user,
    versionCreatedAt: "2026-08-31T12:00:00Z",
    externalIdentifiers: [],
    relationships: [],
    managedMetadataProfileId: null,
    managedMetadataProfileVersion: null,
    metadataValidation: null
  };
}

function portableStyle(definition) {
  return {
    id: IDS.style,
    resourceId: IDS.resource,
    slug: "imported-mapserver",
    format: "maplibre",
    versionNumber: 1,
    title: "Imported MapServer style",
    mediaType: "application/vnd.mapbox.style+json",
    definition,
    checksumSha256: "f".repeat(64),
    changeMessage: null,
    createdBy: IDS.user,
    createdAt: "2026-08-31T12:00:00Z",
    updatedAt: "2026-08-31T12:00:00Z"
  };
}

function button(root, label) {
  return [...root.querySelectorAll("button")]
    .find(({textContent}) => textContent.trim() === label);
}

function click(root, label) {
  const target = button(root, label);
  assert.ok(target, `missing ${label}`);
  target.click();
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("timed out waiting for MapServer configuration UI");
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: `https://studio.opengeo.tools/workspaces?project=${IDS.project}&manage=resources`
  });
  const replacements = {
    document: dom.window.document,
    location: dom.window.location,
    HTMLElement: dom.window.HTMLElement,
    Blob: dom.window.Blob,
    URL: dom.window.URL
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
