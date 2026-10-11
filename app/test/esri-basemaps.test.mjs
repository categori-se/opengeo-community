import assert from "node:assert/strict";
import test from "node:test";
import {JSDOM} from "jsdom";
import {ESRI_BASEMAP_OPTIONS, createEsriBasemapSession, esriBasemapDefinition, esriTileConfiguration} from "../src/lib/esriBasemaps.js";
import {EsriBasemapOptions} from "../src/components/EsriBasemapOptions.js";

const ID = "custom-11111111-1111-4111-8111-111111111111";
const KEY = "test-browser-key-not-a-real-credential";
const tile = (option) => option.url.replace("{z}", "2").replace("{x}", "1").replace("{y}", "1");

test("Esri options distinguish public access from keyed services without storing a key", () => {
  const session = createEsriBasemapSession();
  session.configure(KEY);
  for (const option of ESRI_BASEMAP_OPTIONS) {
    const definition = esriBasemapDefinition(option.id, ID);
    assert.equal(definition.kind, "raster");
    assert.equal(new URL(definition.url).search, "");
    assert.ok(!JSON.stringify(definition).includes(KEY));
    assert.equal(esriTileConfiguration(definition.url).tileSize, option.tileSize);
    const request = session.transformRequest(tile(option));
    assert.equal(request.credentials, "omit");
    assert.equal(request.headers?.Authorization, option.requiresKey ? `Bearer ${KEY}` : undefined);
    assert.equal(request.url, tile(option));
  }
  assert.ok(!JSON.stringify(session).includes(KEY));
  session.clear();
  assert.equal(session.configured, false);
  assert.equal(session.transformRequest(tile(ESRI_BASEMAP_OPTIONS[1])).headers, undefined);
  assert.throws(() => esriBasemapDefinition("unknown", ID));
});

test("browser key cannot leak to unrelated hosts, paths, protocols or query URLs", () => {
  const session = createEsriBasemapSession();
  session.configure(KEY);
  for (const url of [
    "https://ibasemaps-api.arcgis.com.evil.example/arcgis/rest/services/World_Imagery/MapServer/tile/2/1/1",
    "http://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/2/1/1",
    "https://ibasemaps-api.arcgis.com:8443/arcgis/rest/services/World_Imagery/MapServer/tile/2/1/1",
    "https://ibasemaps-api.arcgis.com/other-service",
    `${tile(ESRI_BASEMAP_OPTIONS[1])}?redirect=https://evil.example`,
    "https://user:password@ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/2/1/1",
    "https://tiles.arcgis.com/an-unreviewed-organization/tile/2/1/1",
    "https://studio.opengeo.tools/api/projects",
    "not a URL"
  ]) assert.deepEqual(session.transformRequest(url), {url, credentials: "omit"});
  for (const key of ["", "bad\r\nHeader: injected", "bad key", "x".repeat(4097)]) assert.throws(() => session.configure(key));
  assert.equal(createEsriBasemapSession().configured, false);
});

test("Esri configuration requires consent, supports keyed options and clears the password field", () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {value: dom.window.document, configurable: true});
  try {
    const selected = [];
    const session = createEsriBasemapSession();
    const panel = EsriBasemapOptions({session, selectBasemap: (value) => selected.push(value)});
    const use = [...panel.querySelectorAll("button")].find((button) => button.textContent === "Use Esri basemap");
    const consent = panel.querySelector('[type="checkbox"]');
    const select = panel.querySelector("select");
    const input = panel.querySelector('[type="password"]');
    assert.equal(select.value, "public-imagery");
    assert.equal(select.selectedOptions[0].textContent, "World Imagery · no key required");
    assert.equal(input.closest("label").hidden, true);
    assert.equal(use.disabled, true);
    consent.checked = true;
    consent.dispatchEvent(new dom.window.Event("change"));
    assert.equal(use.disabled, false);
    use.click();
    assert.equal(selected.length, 1);
    assert.equal(session.configured, false);
    select.value = "imagery";
    select.dispatchEvent(new dom.window.Event("change"));
    assert.equal(input.closest("label").hidden, false);
    assert.equal(use.disabled, true);
    input.value = KEY;
    input.dispatchEvent(new dom.window.Event("input"));
    use.click();
    assert.equal(session.configured, true);
    assert.equal(input.value, "");
    assert.equal(selected.length, 2);
    assert.ok(!JSON.stringify(selected).includes(KEY));
    [...panel.querySelectorAll("button")].find((button) => button.textContent === "Clear Esri key").click();
    assert.equal(session.configured, false);
    assert.equal(use.disabled, true);
    select.value = "public-imagery";
    select.dispatchEvent(new dom.window.Event("change"));
    assert.equal(input.closest("label").hidden, true);
    assert.equal(use.disabled, false);
    const lunar = EsriBasemapOptions({session, enabled: false, selectBasemap() { assert.fail("must not activate"); }});
    const lunarConsent = lunar.querySelector('[type="checkbox"]');
    lunarConsent.checked = true;
    lunarConsent.dispatchEvent(new dom.window.Event("change"));
    assert.equal(lunar.querySelector("button").disabled, true);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete globalThis.document;
    dom.window.close();
  }
});
