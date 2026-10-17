import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {StyleLibrary} from "../src/components/StyleLibrary.js";
import {pointSymbolStyleDefinition, savedPointSymbolStyle} from "../src/lib/layerStyleReference.js";
import {POINT_SYMBOLS} from "../src/lib/pointSymbols.js";

function record(value = {}) {
  const definition = value.definition ?? pointSymbolStyleDefinition({pointSymbol: "hospital", circleColor: "#2563eb", circleRadius: 8}, "Hospitals");
  return {id: "style", resourceId: "resource", slug: "hospitals", format: "maplibre", title: "Hospitals",
    versionNumber: 1, ...value, definition, checksumSha256: createHash("sha256").update(definition).digest("hex")};
}
async function until(predicate) {
  for (let i = 0; i < 30; i++) {if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5));}
  assert.ok(predicate(), "expected UI state did not arrive");
}
async function setup(adapter, action) {
  const dom = new JSDOM("<body/>"), previous = new Map();
  for (const name of ["document", "DOMParser", "Option"]) {previous.set(name, globalThis[name]);globalThis[name] = dom.window[name];}
  const root = StyleLibrary({adapter, containers: [{id: "container", name: "Account data"}, {id: "other", name: "Other data"}]});
  document.body.append(root);
  const field = label => root.querySelector(`[aria-label="${label}"]`);
  const button = text => [...root.querySelectorAll("button")].find(item => item.textContent === text);
  const choose = async (label, value) => {
    const control = field(label);control.value = value;control.dispatchEvent(new dom.window.Event("change"));
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  const input = (label, value) => {const control = field(label);control.value = value;control.dispatchEvent(new dom.window.Event("input"));};
  try {await action({root, field, button, choose, input});}
  finally {root.dispose();for (const [name, value] of previous) globalThis[name] = value;dom.window.close();}
}
function adapter(overrides = {}) {
  return {kind: "fixture", listResources: async () => [{id: "resource", title: "Facilities", kind: "dataset", state: "draft"}],
    listResourceStyles: async () => [], getResourceCapabilities: async () => ({canUpdate: true}), ...overrides};
}

it("offers the complete local point symbol library before storage selection and saves only with explicit resource edit authority", async () => {
  const writes = [];let stored = [];
  await setup(adapter({getResourceCapabilities: async () => ({canUpdate:true}), listResourceStyles: async () => stored,
    createResourceStyle: async (projectId, resourceId, value) => {writes.push({projectId, resourceId, value});
      const created = record({...value, resourceId});stored = [created];return created;}}), async ({root, field, button, choose, input}) => {
    assert.deepEqual([...field("Point symbol").options].map(option => option.value), POINT_SYMBOLS.map(symbol => symbol.id));
    assert.ok(POINT_SYMBOLS.length > 1000, "The gallery includes the imported symbol collections");
    assert.match(root.querySelector(".style-point-preview").src, /^data:image\/svg\+xml/);
    assert.equal(button("Save point Style").disabled, true);assert.equal(writes.length, 0);
    await choose("Point symbol", "clinic");input("Point color", "#a12345");input("Point radius", "11");
    await choose("Data library", "container");await choose("Style resource", "resource");
    assert.equal(field("Point symbol").value, "clinic", "new preview survives first storage selection");
    await until(() => !button("Save point Style").disabled);
    button("Save point Style").click();button("Save point Style").click();
    await until(() => root.textContent.includes("Existing maps keep their chosen version"));
    assert.equal(writes.length, 1);assert.equal(writes[0].projectId, "container");assert.equal(writes[0].resourceId, "resource");
    assert.equal(writes[0].value.format, "maplibre");
    assert.deepEqual(savedPointSymbolStyle(stored[0]), {pointSymbol: "clinic", circleColor: "#a12345", circleRadius: 11});
    assert.equal(root.shouldBlockNavigation(), false);assert.ok(root.querySelector(".style-saved-thumbnail img"));
    assert.equal(button("Edit point symbol").hidden, false);
  });
  await setup(adapter({getResourceCapabilities:async()=>({canUpdate:false})}),async({button,choose})=>{
    await choose("Data library","container");await choose("Style resource","resource");
    assert.equal(button("Save point Style").disabled,true);assert.equal(writes.length,1);
  });
});

it("keeps point drafts and version pins through a conflicting update and an explicit latest-base review", async () => {
  const original = record(), writes = [];let reads = 0, archives = 0;
  await setup(adapter({listResourceStyles: async () => [reads++ === 0 ? original : record({versionNumber: 2, title: "Colleague version"})],
    archiveResourceStyle:async()=>{archives++;return {...original,archived:true};},
    updateResourceStyle: async (projectId, resourceId, styleId, value) => {writes.push(value);
      if (writes.length === 1) throw Object.assign(Error("conflict"), {code: "resource_style_version_conflict"});
      return record({...value, versionNumber: 3});}}), async ({root, field, button, choose, input}) => {
    await choose("Data library", "container");await choose("Style resource", "resource");button("Edit point symbol").click();
    await until(() => button("Save point changes"));
    input("Point color", "#de1234");await choose("Point symbol", "star");
    button("Delete").click();assert.match(root.textContent,/Save or discard the current draft before deleting/);
    assert.equal(root.querySelector('.style-delete-confirm').hidden,true);assert.equal(archives,0);
    button("Save point changes").click();await until(() => root.textContent.includes("Someone saved a newer point Style"));
    await choose("Data library", "other");assert.equal(field("Data library").value, "container");
    button("Check latest point version").click();await until(() => !button("Use latest point as edit base").hidden);
    assert.match(field("Latest saved point Style for comparison").textContent, /Version 2: Colleague version/);
    button("Use latest point as edit base").click();assert.equal(field("Point symbol").value, "star");assert.equal(field("Point color").value, "#de1234");
    button("Save point changes").click();await until(() => root.textContent.includes("Saved Hospitals · version 3"));
    assert.equal(writes[0].expectedVersion, 1);assert.equal(writes[1].expectedVersion, 2);
    assert.equal(savedPointSymbolStyle(original).pointSymbol, "hospital");
    assert.equal(original.versionNumber, 1);assert.equal(root.shouldBlockNavigation(), false);
  });
});

it("keeps uncertain creation disabled until resource readback and never silently rewrites categorized styles", async () => {
  const category = record({definition: pointSymbolStyleDefinition({pointSymbol: "circle", circleColor: "#123456", circleRadius: 8,
    renderer: "category", categoryField: "kind", categorySymbols: {Hospital: "hospital"}}, "Facilities")});
  let writes = 0;
  await setup(adapter({listResourceStyles: async () => [category], createResourceStyle: async () => {writes++;throw Error("lost response");}}),
    async ({root, button, choose}) => {
      await choose("Data library", "container");await choose("Style resource", "resource");
      assert.equal(button("Edit point symbol").hidden, true);
      assert.ok(root.querySelector(".resource-style-version-editor"));
      button("Save point Style").click();await until(() => root.textContent.includes("reload the resource before trying again"));
      assert.equal(button("Save point Style").disabled, true);button("Save point Style").click();assert.equal(writes, 1);
    });
});
