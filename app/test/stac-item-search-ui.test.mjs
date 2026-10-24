import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {StacItemSearch} from "../src/components/StacItemSearch.js";

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function item(id = "scene-1") {
  return {id, collectionId: "sentinel-2-l2a", datetime: "2021-10-10T05:00:00Z", cloudCover: null,
    bbox: [85.5, 27.6, 85.6, 27.7], spatialMatch: "bounding-extent-candidate", custody: "referenced", license: null,
    adapter: "opengeo.stac-api-items.1", assets: [
      {key: "red", href: "https://imagery.example/red.tif", type: "image/tiff; application=geotiff; profile=cloud-optimized", roles: ["data"], bands: [{name: "red"}], license: null, cogCompatible: true, unsupportedReasons: []},
      {key: "metadata", href: "https://imagery.example/metadata.xml", type: "application/xml", cogCompatible: false, unsupportedReasons: ["Only TIFF raster assets are supported."]}
    ], original: {type: "Feature", id, properties: {datetime: "2021-10-10T05:00:00Z", extra: {preserve: true}}, assets: {red: {href: "https://imagery.example/red.tif"}}}};
}
function result(items = [item()], overrides = {}) {
  return {items, query: {endpoint: "https://stac.example/search", collections: ["sentinel-2-l2a"], limit: 1},
    usage: {requests: 1, bytes: 1024, milliseconds: 100, pages: 1, items: items.length},
    snapshot: {url: "https://stac.example/search", sha256: "fixture", bytes: 1024, readAt: "2026-10-23T12:00:00Z", etag: null},
    complete: true, issues: [], next: null, ...overrides};
}
async function fixture(options, body) {
  const dom = new JSDOM("<!doctype html><body></body>"), previous = globalThis.document;
  globalThis.document = dom.window.document;
  const root = StacItemSearch(options); document.body.append(root);
  const button = name => [...root.querySelectorAll("button")].find(node => node.textContent === name);
  const submit = () => root.querySelector("form").dispatchEvent(new dom.window.Event("submit", {bubbles: true, cancelable: true}));
  try {await body({root, dom, button, submit});}
  finally {root.dispose(); globalThis.document = previous; dom.window.close();}
}

it("waits for deliberate search, submits bounded UTC filters and presents unknowns and metadata usage", async () => {
  const calls = [];
  await fixture({client: {search: async (query, options) => {calls.push({query, options}); return result();}}}, async ({root, dom, button, submit}) => {
    assert.equal(calls.length, 0); root.open = true; assert.equal(calls.length, 0);
    root.querySelector("input").dispatchEvent(new dom.window.Event("change"));
    assert.equal(calls.length, 0); submit(); await flush();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].query, {endpoint: "https://earth-search.aws.element84.com/v1/search", collections: ["sentinel-2-l2a"],
      bbox: [85.533, 27.6119167, 85.5340833, 27.613], start: "2021-10-01T00:00:00Z", end: "2021-10-31T23:59:00Z", limit: 1});
    assert.match(root.textContent, /Collection: sentinel-2-l2a/); assert.match(root.textContent, /Cloud cover: unknown/);
    assert.match(root.textContent, /Candidate coverage only/); assert.match(root.textContent, /1 requests; 1024 bytes; 0\.1 seconds; 1 pages; 1 returned Items/);
    assert.match(root.textContent, /does not establish imagery access or permission to analyse/);
    assert.equal(button("Next page").hidden, true);
  });
});

it("reviews returned assets without another read and passes the unchanged reference to registration", async () => {
  const reference = item(); let calls = 0, registered;
  await fixture({client: {search: async () => {calls++; return result([reference]);}}, onReference: value => {
    registered = value; const panel = document.createElement("section"); panel.className = "static-item-registration"; return panel;
  }}, async ({root, button, submit}) => {
    submit(); await flush(); button("View asset references").click(); await flush();
    assert.equal(calls, 1); assert.equal(registered, undefined);
    assert.match(root.textContent, /https:\/\/imagery.example\/red.tif/); assert.match(root.textContent, /Reference only: Only TIFF raster assets are supported/);
    assert.match(root.textContent, /Item terms: unknown/); assert.match(root.textContent, /asset terms: unknown/);
    assert.match(root.querySelector("pre").textContent, /"preserve": true/);
    assert.equal(root.querySelectorAll("a[href^='https://imagery.example']").length, 0);
    button("Review Catalog registration").click(); await flush(); assert.equal(registered, reference);
    assert.ok(root.querySelector(".static-item-registration"));
  });
});

it("downloads the complete returned reference and original Item without provider work", async () => {
  const reference = item(); let blob, clicked = false, reads = 0;
  const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
  URL.createObjectURL = value => {blob = value; return "blob:stac-fixture";}; URL.revokeObjectURL = () => {};
  try {
    await fixture({client: {search: async () => {reads++; return result([reference]);}}}, async ({dom, button, submit}) => {
      dom.window.HTMLAnchorElement.prototype.click = function () {clicked = true; assert.equal(this.download, "stac-item-scene-1.json");};
      submit(); await flush(); button("View asset references").click(); await flush(); button("Download Item references").click(); await flush();
      assert.equal(reads, 1); assert.equal(clicked, true); assert.deepEqual(JSON.parse(await blob.text()), reference);
    });
  } finally {URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke;}
});

it("keeps unsupported assets visible without offering a raster registration", async () => {
  const reference = item(); reference.assets = reference.assets.filter(asset => !asset.cogCompatible);
  await fixture({client: {search: async () => result([reference])}, onReference: () => {throw Error("unsupported registration");}}, async ({root, button, submit}) => {
    submit(); await flush(); button("View asset references").click(); await flush();
    assert.match(root.textContent, /metadata.xml/); assert.match(root.textContent, /no asset supported/);
    assert.equal(button("Review Catalog registration"), undefined);
    assert.ok(button("Download Item references"));
  });
});

it("requests the next page only on click using the same result, clears registration and shows cumulative Items", async () => {
  const first = result([item()], {complete: false, next: "https://stac.example/search?token=next"});
  let searches = 0, pages = 0, released = 0;
  await fixture({client: {search: async () => {searches++; return first;}, next: async previous => {
    pages++; assert.equal(previous, first); return result([first.items[0], item("scene-2")], {usage: {requests: 2, bytes: 2048, milliseconds: 200, pages: 2, items: 2}});
  }}, onReference: () => {const panel = document.createElement("section"); panel.className = "static-item-registration"; panel.dispose = () => released++; return panel;}}, async ({root, button, submit}) => {
    submit(); await flush(); assert.equal(searches, 1); assert.equal(pages, 0); assert.equal(button("Next page").hidden, false);
    button("View asset references").click(); await flush(); button("Review Catalog registration").click(); await flush();
    button("Next page").click(); await flush(); assert.equal(pages, 1); assert.equal(searches, 1); assert.equal(released, 1);
    assert.equal(root.querySelectorAll(".platform-stac-item-result").length, 2); assert.match(root.textContent, /2 Items shown/);
    assert.equal(button("Next page").hidden, true);
  });
});

for (const departure of ["filter", "cancel", "dispose", "new search"]) it(`discards late metadata after ${departure}`, async () => {
  const requests = [];
  await fixture({client: {search: (_query, options) => new Promise(resolve => requests.push({resolve, ...options}))}}, async ({root, dom, button, submit}) => {
    submit(); await flush(); assert.equal(requests.length, 1);
    if (departure === "filter") root.querySelector("input").dispatchEvent(new dom.window.Event("input"));
    else if (departure === "cancel") button("Cancel").click();
    else if (departure === "dispose") root.dispose();
    else {submit(); await flush(); assert.equal(requests.length, 2);}
    assert.equal(requests[0].signal.aborted, true);
    requests[0].onStatus("late status"); requests[0].resolve(result([item("late-item")])); await flush();
    assert.doesNotMatch(root.textContent, /late-item|late status/);
    if (departure === "new search") {requests[1].resolve(result([item("current-item")])); await flush(); assert.match(root.textContent, /current-item/);}
  });
});

for (const departure of ["filter", "dispose", "new search"]) it(`disposes registration on ${departure}`, async () => {
  let released = 0;
  await fixture({client: {search: async () => result()}, onReference: () => {
    const panel = document.createElement("section"); panel.className = "static-item-registration"; panel.dispose = () => released++; return panel;
  }}, async ({root, dom, button, submit}) => {
    submit(); await flush(); button("View asset references").click(); await flush(); button("Review Catalog registration").click(); await flush();
    if (departure === "filter") root.querySelector("input").dispatchEvent(new dom.window.Event("change"));
    else if (departure === "dispose") root.dispose();
    else {submit(); await flush();}
    assert.equal(released, 1); assert.equal(root.querySelector(".static-item-registration"), null);
  });
});

it("clears old references and registrations if account context changes before another interaction", async () => {
  let account = "account-a", releases = 0, reads = 0, registrations = 0;
  const adapter = {baseUrl: "https://api.example", tokenProvider: async () => "fixture-token", organizationProvider: async () => account,
    assertCollectionContext: async context => {if (context.organization !== account) throw Object.assign(Error("changed account"), {code: "scope_changed"});}};
  await fixture({adapter, client: {search: async () => {reads++; return result();}}, onReference: () => {
    registrations++; const panel = document.createElement("section"); panel.className = "static-item-registration"; panel.dispose = () => releases++; return panel;
  }}, async ({root, button, submit}) => {
    submit(); await flush(); button("View asset references").click(); await flush(); button("Review Catalog registration").click(); await flush();
    assert.equal(registrations, 1); account = "account-b";
    button("Review Catalog registration").click(); await flush();
    assert.equal(reads, 1); assert.equal(registrations, 1); assert.equal(releases, 1);
    assert.equal(root.querySelectorAll(".platform-stac-item-result").length, 0); assert.match(root.textContent, /selected account changed/);
  });
});

it("reports incomplete results and the lack of a supported next page without retrying", async () => {
  let reads = 0;
  await fixture({client: {search: async () => {reads++; return result([], {complete: false, issues: ["The metadata request limit was reached."]});}}}, async ({root, button, submit}) => {
    submit(); await flush(); assert.equal(reads, 1); assert.match(root.textContent, /Results are incomplete/);
    assert.match(root.textContent, /metadata request limit was reached/); assert.match(root.textContent, /No further page is available/);
    assert.equal(button("Next page").hidden, true);
  });
});
