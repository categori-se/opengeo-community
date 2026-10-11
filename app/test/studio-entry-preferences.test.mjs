import assert from "node:assert/strict";
import {it} from "node:test";
import {readFileSync} from "node:fs";
import {JSDOM} from "jsdom";
import {createStartupPreference, WELCOME_IDLE_MS, WELCOME_RETURN_MS} from "../src/lib/startupPreference.js";
import {InstanceCatalog} from "../src/components/InstanceCatalog.js";

function memory() {
  const values = new Map();
  return {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};
}

it("remembers dismissal across refreshes and new tabs until a day away", () => {
  let now = 10_000;
  const preferences = memory(), session = memory();
  const make = (store = session) => createStartupPreference({preferences, session: store, now: () => now});
  assert.equal(make().shouldShow(), true);
  make().remember();
  now += 60_000;
  assert.equal(make().shouldShow(), false);
  make().remember();
  now += WELCOME_RETURN_MS;
  assert.equal(make().shouldShow(), true);
  make().remember();
  assert.equal(make(memory()).shouldShow(), false);
  make().setMode("session");
  assert.equal(make(memory()).shouldShow(), true);
  now += WELCOME_IDLE_MS;
  assert.equal(make().shouldShow(), true);
});

it("supports explicit welcome preferences and blocked browser storage", () => {
  const preferences = memory(), session = memory();
  const settings = createStartupPreference({preferences, session});
  settings.setMode("manual");
  assert.equal(settings.shouldShow(), false);
  settings.setMode("always");
  settings.remember();
  assert.equal(settings.shouldShow(), true);
  assert.throws(() => settings.setMode("unknown"));
  const denied = {getItem() {throw Error("denied");}, setItem() {throw Error("denied");}};
  assert.equal(createStartupPreference({preferences: denied, session: denied}).shouldShow(), true);
});

it("keeps the anonymous personal catalog empty and pages the demo's published records", () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {value: dom.window.document, configurable: true});
  try {
    const personal = InstanceCatalog();
    assert.match(personal.textContent, /No account projects loaded/);
    assert.doesNotMatch(personal.textContent, /MassGIS|Nepal/);
    const catalog = JSON.parse(readFileSync(new URL("../src/data/public-demo-catalog.json", import.meta.url)));
    const massgis = JSON.parse(readFileSync(new URL("../src/data/massgis-enviroscreen.json", import.meta.url)));
    const demo = InstanceCatalog({publicCatalog: {catalog, massgis}});
    assert.match(demo.textContent, /MassGIS/);
    assert.equal(demo.querySelectorAll(".instance-catalog-results article").length, 12);
    const first = demo.querySelector(".instance-catalog-results a").getAttribute("href");
    const next = [...demo.querySelectorAll("button")].find(b => b.textContent === "Next page");
    next.click();
    assert.notEqual(demo.querySelector(".instance-catalog-results a").getAttribute("href"), first);
    const query = demo.querySelector("input");
    query.value = "adult cancer";
    query.dispatchEvent(new dom.window.Event("input"));
    assert.equal(demo.querySelectorAll(".instance-catalog-results article").length, 1);
    assert.match(demo.querySelector(".instance-catalog-results").textContent, /cancer/i);
    query.value = "no-such-example";
    query.dispatchEvent(new dom.window.Event("input"));
    assert.equal(demo.querySelectorAll(".instance-catalog-results article").length, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete globalThis.document;
    dom.window.close();
  }
});
