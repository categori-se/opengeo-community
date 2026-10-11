import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {PublicDemoWorkbench, createPublicDemoSource} from "../src/components/PublicDemoWorkbench.js";
import {DEFAULT_WORKBENCH_COLOR_MODE} from "../src/components/WorkbenchView.js";
import {BASEMAPS} from "../src/lib/workbenchConfig.js";

const CATALOG = JSON.parse(await readFile(
  new URL("../src/data/public-demo-catalog.json", import.meta.url),
  "utf8"
));
const COMMUNITY_GEOJSON = JSON.parse(await readFile(
  new URL("../src/data/sample-public-facilities.geojson", import.meta.url),
  "utf8"
));
const MASSGIS = JSON.parse(await readFile(
  new URL("../src/data/massgis-enviroscreen.json", import.meta.url),
  "utf8"
));

describe("public workbench demo source boundary", () => {
  it("starts in the shared Observable near-midnight workbench theme", () => {
    assert.equal(DEFAULT_WORKBENCH_COLOR_MODE, "dark");
  });

  it("uses an attributed key-free default instead of a stale anonymous CARTO endpoint", () => {
    assert.ok(BASEMAPS.some(({basemapId}) => basemapId === "openfreemap-positron"));
    assert.ok(BASEMAPS.every(({url}) => !url?.includes("cartocdn.com")));
    assert.ok(BASEMAPS.every(({url}) => !url?.includes("tile.openstreetmap.org")));
    for (const basemap of BASEMAPS.filter(({url}) => url)) {
      assert.match(basemap.attribution, /NASA|USGS/);
      assert.match(basemap.url, /^https:/);
      assert.doesNotMatch(basemap.url, /[?&](?:key|token|api_key)=/i);
    }
  });

  it("offers the six key-free OpenFreeMap styles indexed from GeoLibre 2.6.0", () => {
    const expected = new Map([
      ["Liberty", "https://tiles.openfreemap.org/styles/liberty"],
      ["Liberty 3D", "https://tiles.openfreemap.org/styles/liberty"],
      ["Positron", "https://tiles.openfreemap.org/styles/positron"],
      ["Bright", "https://tiles.openfreemap.org/styles/bright"],
      ["Dark", "https://tiles.openfreemap.org/styles/dark"],
      ["Fiord", "https://tiles.openfreemap.org/styles/fiord"]
    ]);
    const openFreeMap = BASEMAPS.filter(({section}) => section === "OpenFreeMap");
    assert.equal(openFreeMap.length, expected.size);
    for (const basemap of openFreeMap) {
      assert.equal(basemap.kind, "maplibre-style");
      assert.equal(basemap.styleUrl, expected.get(basemap.title));
      assert.match(basemap.attribution, /OpenFreeMap.*OpenMapTiles.*OpenStreetMap/);
      assert.doesNotMatch(basemap.styleUrl, /[?#]|@/);
    }
  });

  it("accepts a bounded public HTTPS tile source without persisting credentials", async () => {
    const source = await createPublicDemoSource({
      name: "Public tiles",
      source: {
        type: "xyz",
        url: "https://tiles.example.org/{z}/{x}/{y}.png",
        minZoom: 0,
        maxZoom: 18,
        tileSize: 256
      }
    });
    assert.equal(source.sourceType, "xyz");
    assert.equal(source.sourceUrl, "https://tiles.example.org/{z}/{x}/{y}.png");
    assert.equal(source.classification, "browser-only-demo");
    assert.equal(source.configuration.url, undefined);
  });

  for (const url of [
    "http://tiles.example.org/{z}/{x}/{y}.png",
    "https://localhost/tiles",
    "https://127.0.0.1/tiles",
    "https://10.2.3.4/tiles",
    "https://169.254.169.254/latest/meta-data",
    "https://user:password@tiles.example.org/tiles",
    "https://tiles.example.org/tiles?api_key=secret"
  ]) {
    it(`rejects unsafe demo URL ${url}`, async () => {
      await assert.rejects(
        createPublicDemoSource({name: "Unsafe", source: {type: "xyz", url}}),
        TypeError
      );
    });
  }

  it("rejects connector types that would imply private or server-side access", async () => {
    await assert.rejects(
      createPublicDemoSource({
        name: "Database",
        source: {type: "postgres", url: "https://db.example.org"}
      }),
      /supports XYZ, WMS, and PMTiles/
    );
  });

  it("aborts an in-flight statewide request when the public workbench is detached", async () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "https://demo.opengeo.tools/?map=massgis-pm25-concentration"
    });
    const restoreGlobals = installDomGlobals(dom.window);
    let requestSignal = null;
    try {
      const root = PublicDemoWorkbench({
        catalog: CATALOG,
        geojson: COMMUNITY_GEOJSON,
        massgis: MASSGIS,
        fetchImpl: async (_url, {signal}) => {
          requestSignal = signal;
          return new Promise(() => {});
        }
      });
      dom.window.document.body.append(root);
      await waitFor(() => requestSignal);
      assert.equal(requestSignal.aborted, false);

      root.remove();
      await waitFor(() => requestSignal.aborted);
      assert.equal(requestSignal.aborted, true);
    } finally {
      restoreGlobals();
      dom.window.close();
    }
  });

  it("publishes a metadata-only directory with direct links to all MassGIS maps", async () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "https://demo.studio.opengeo.tools/?view=examples"
    });
    const restoreGlobals = installDomGlobals(dom.window);
    let requests = 0;
    try {
      const root = PublicDemoWorkbench({
        catalog: CATALOG,
        geojson: COMMUNITY_GEOJSON,
        massgis: MASSGIS,
        fetchImpl: async () => {
          requests += 1;
          throw new Error("the publication directory must not load the statewide archive");
        }
      });
      dom.window.document.body.append(root);

      assert.equal(root.dataset.surface, "published-examples");
      assert.equal(root.querySelector("h1")?.textContent, "Explore OpenGeo Studio");
      assert.equal(root.querySelector('a[href="/workspaces"]'), null);
      assert.ok(root.querySelector('a[href="https://studio.opengeo.tools/workspaces"]'));
      assert.equal(root.querySelectorAll("#example-catalog [data-catalog-layer]").length, 31);
      assert.equal(root.querySelectorAll("#example-publications a").length, 4);
      assert.deepEqual([...root.querySelectorAll('#example-publications a')].map(link => link.getAttribute('href')),
        ['/?publication=framework', '/?publication=notebook', '/?publication=jupyter', '/?publication=html']);
      assert.equal(root.querySelectorAll('nav[aria-label="Map briefings"] a').length, 2);
      assert.equal(root.querySelectorAll('a[data-page-id^="massgis-"]').length, 31);
      assert.equal(
        root.querySelector('a[data-page-id="massgis-pm25-concentration"]')?.getAttribute("href"),
        "/?map=massgis-pm25-concentration"
      );
      assert.equal(requests, 0);
      assert.ok(root.querySelector("#satellite-scenes .platform-static-item-search"));
      assert.equal(root.querySelector("#satellite-scenes .platform-static-item-search").open, false);
      assert.ok(root.querySelector('a[href="https://studio.opengeo.tools/workspaces?view=publishing"]'));
      assert.ok(root.querySelector('a[href="https://studio.opengeo.tools/workspaces?view=data"]'));
    } finally {
      restoreGlobals();
      dom.window.close();
    }
  });

  it("shows Catalog and Publications at the root without loading providers", () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {url: "https://demo.studio.opengeo.tools/"});
    const restoreGlobals = installDomGlobals(dom.window);
    try {
      const root = PublicDemoWorkbench({catalog: CATALOG, geojson: COMMUNITY_GEOJSON, massgis: MASSGIS,
        fetchImpl: async () => { throw Error("provider reads are forbidden on the overview"); }});
      assert.ok(root.querySelector("#example-catalog"));
      assert.ok(root.querySelector("#example-publications"));
      const query = root.querySelector('input[type="search"]'); query.value = "Public community";
      query.dispatchEvent(new dom.window.Event("input"));
      assert.equal(root.querySelectorAll("[data-catalog-layer]").length, 1);
      assert.equal(root.querySelector("[data-catalog-layer] a").getAttribute("href"), "/?layer=community-facilities");
    } finally { restoreGlobals(); dom.window.close(); }
  });

  it("opens an authored Publication and computes its summary from the same Layer", () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {url: "https://demo.studio.opengeo.tools/?publication=community-access"});
    const restoreGlobals = installDomGlobals(dom.window);
    try {
      const root = PublicDemoWorkbench({catalog: CATALOG, geojson: COMMUNITY_GEOJSON, massgis: MASSGIS});
      assert.equal(root.dataset.surface, "example-publication");
      assert.equal(root.querySelector("h1").textContent, "Community facilities: a spatial briefing");
      assert.equal([...root.querySelectorAll("tbody tr")].reduce((sum, row) => sum + Number(row.lastChild.textContent), 0), COMMUNITY_GEOJSON.features.length);
      assert.match(root.textContent, /invented facilities/);
      assert.equal(root.querySelector(".gis-workbench"), null);
    } finally { restoreGlobals(); dom.window.close(); }
  });
});

function installDomGlobals(window) {
  const replacements = {
    document: window.document,
    location: window.location,
    history: window.history,
    MutationObserver: window.MutationObserver,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window)
  };
  const previous = new Map();
  for (const [name, value] of Object.entries(replacements)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
  }
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("timed out waiting for public workbench lifecycle state");
}
