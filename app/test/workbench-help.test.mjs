import test from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {WorkbenchHelp, loadedWorkbenchIdentity} from "../src/components/WorkbenchHelp.js";

test("Help identifies the loaded interface and distinguishes Demo, local and account storage", () => {
  const dom = new JSDOM('<meta name="latest-release" content="new-server-release">', {url: "https://studio.opengeo.tools/"});
  const previousDocument = globalThis.document, previousFetch = globalThis.fetch;
  globalThis.document = dom.window.document;
  globalThis.fetch = () => {throw Error("Help must use loaded code identity without a request");};
  try {
    const loaded = "https://studio.opengeo.tools/_import/components/WorkbenchView.9141e4ba.js";
    const account = WorkbenchHelp({persistenceMode: "api", interfaceModuleURL: loaded});
    assert.equal(account.querySelector("code").textContent, loaded);
    assert.match(account.textContent, /Loaded interface fingerprint9141e4ba/);
    assert.match(account.textContent, /Account Project; server saves enforce account and role permissions/);
    assert.doesNotMatch(account.textContent, /new-server-release/);
    assert.match(account.textContent, /API and deployment versions are separate/);
    assert.equal(account.querySelectorAll(".gis-task-help a").length, 3);
    const demo = WorkbenchHelp({publicDemo: true, demoSurface: true, persistenceMode: "demo", interfaceModuleURL: loaded});
    assert.match(demo.textContent, /Public Demo/);assert.match(demo.textContent, /Browser-only Demo draft/);
    assert.doesNotMatch(demo.textContent, /Account Project; server saves/);
    const local = WorkbenchHelp({publicDemo: true, landingMode: true, persistenceMode: "local", interfaceModuleURL: "http://localhost:3000/components/WorkbenchView.js"});
    assert.match(local.textContent, /Development module; build fingerprint unavailable/);
    assert.match(local.textContent, /Local browser draft/);assert.equal(local.querySelector("code"), null);
    assert.doesNotMatch(local.textContent, /Public Demo/);
    const savedOnDevice = WorkbenchHelp({publicDemo: true, persistenceMode: "local", interfaceModuleURL: loaded});
    assert.match(savedOnDevice.textContent, /Local browser draft/);assert.doesNotMatch(savedOnDevice.textContent, /Public Demo/);
    const fixture = WorkbenchHelp({persistenceMode: "fixture", interfaceModuleURL: loaded});
    assert.match(fixture.textContent, /OpenGeo Studio · local fixture/);assert.match(fixture.textContent, /Local fixture data; no managed account storage/);
    assert.equal(loadedWorkbenchIdentity(undefined).fingerprint, null);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;else globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;dom.window.close();
  }
});
