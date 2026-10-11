import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";
import {ResourceStyleVersionEditor, savedStyleArtifact} from "../src/components/ResourceStyleVersionEditor.js";
import {FixturePlatformAdapter} from "../src/lib/fixturePlatform.js";

let dom;
let previousDocument;
beforeEach(() => {
  dom = new JSDOM("<!doctype html><body></body>");
  previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {configurable: true, value: dom.window.document});
});
afterEach(() => {
  if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
  else delete globalThis.document;
  dom.window.close();
});

function style(overrides = {}) {
  const result = {
    id: "style-1", resourceId: "resource-1", slug: "roads", title: "Roads",
    format: "sld_1_0", versionNumber: 1,
    definition: '<StyledLayerDescriptor version="1.0.0">é\r\n</StyledLayerDescriptor>',
    ...overrides
  };
  result.checksumSha256 = createHash("sha256").update(result.definition).digest("hex");
  return result;
}
function open(adapter, canUpdate = true, saved = style()) {
  const root = ResourceStyleVersionEditor({adapter, projectId: "project-1", resourceId: "resource-1", style: saved, canUpdate});
  document.body.append(root);
  root.open = true;
  return root;
}
function button(root, name) {
  return [...root.querySelectorAll("button")].find((element) => element.textContent === name);
}
function field(root, name) { return root.querySelector(`[aria-label="${name}"]`); }
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("style editor did not settle");
}

describe("saved portable style workflow", () => {
  it("exports all five exact formats with UTF-8 checksum validation and safe versioned filenames", async () => {
    for (const [format, extension] of [["maplibre", "json"], ["geostyler", "json"], ["sld_1_0", "sld"], ["sld_1_1", "sld"], ["mapserver_mapfile", "map"]]) {
      const saved = style({format});
      const artifact = await savedStyleArtifact(saved);
      assert.equal(artifact.definition, saved.definition);
      assert.equal(artifact.filename, `roads-v1.${extension}`);
      assert.match(artifact.mediaType, /charset=utf-8$/);
    }
    await assert.rejects(savedStyleArtifact({...style(), checksumSha256: "0".repeat(64)}), /checksum_mismatch/);
    await assert.rejects(savedStyleArtifact(style({slug: "../../escape"})), /invalid_style/);
    await assert.rejects(savedStyleArtifact(style({format: "html"})), /invalid_style/);
    await assert.rejects(savedStyleArtifact(style({definition: "x".repeat(49_153)})), /invalid_style/);
  });

  it("saves a new version through the existing API, preserves the format, and keeps text inert", async () => {
    const calls = [];
    const saved = style();
    const root = open({updateResourceStyle: async (...args) => {
      calls.push(args);
      return style({...args[3], versionNumber: 2});
    }}, true, saved);
    const source = field(root, "Saved style definition");
    source.value = '<script>throw new Error("never execute")</script>\né';
    field(root, "Saved style title").value = "Road labels";
    field(root, "Style change note").value = "Improve labels";
    root.open = false;
    root.open = true;
    assert.match(source.value, /never execute/);
    button(root, "Save style version").click();
    await until(() => root.textContent.includes("Saved style version 2"));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 3), ["project-1", "resource-1", "style-1"]);
    assert.equal(calls[0][3].expectedVersion, 1);
    assert.equal(calls[0][3].format, "sld_1_0");
    assert.equal(calls[0][3].changeMessage, "Improve labels");
    assert.equal(saved.versionNumber, 2);
    assert.equal(root.querySelector("script"), null);
    assert.equal(field(root, "Style change note").value, "");
    assert.match(root.textContent, /Existing render profiles retain their earlier style version/);
  });

  it("retains draft text on conflict and requires explicit comparison before using the latest base", async () => {
    const calls = [];
    const latest = style({versionNumber: 2, title: "Colleague's style", definition: "<another-style/>"});
    const root = open({
      listResourceStyles: async () => [latest],
      updateResourceStyle: async (...args) => {
        calls.push(args[3]);
        if (calls.length === 1) throw Object.assign(new Error("conflict"), {code: "resource_style_version_conflict"});
        return style({...args[3], versionNumber: 3});
      }
    });
    field(root, "Saved style definition").value = "<my-draft/>";
    field(root, "Saved style title").value = "My draft";
    field(root, "Style change note").value = "Keep this note";
    button(root, "Save style version").click();
    await until(() => root.textContent.includes("Someone saved another version"));
    assert.equal(button(root, "Save style version").disabled, true);
    button(root, "Check latest version").click();
    await until(() => !button(root, "Use latest as edit base").hidden);
    assert.match(field(root, "Latest saved style for comparison").textContent, /another-style/);
    assert.equal(field(root, "Saved style definition").value, "<my-draft/>");
    assert.equal(field(root, "Style change note").value, "Keep this note");
    assert.equal(calls.length, 1);
    button(root, "Use latest as edit base").click();
    assert.equal(calls.length, 1);
    button(root, "Save style version").click();
    await until(() => root.textContent.includes("Saved style version 3"));
    assert.equal(calls[1].expectedVersion, 2);
    assert.equal(calls[1].definition, "<my-draft/>");
  });

  it("does not retry ambiguous saves or accept another resource's version", async () => {
    let writes = 0;
    const root = open({
      updateResourceStyle: async () => { writes++; throw new Error("response lost"); },
      listResourceStyles: async () => [style({resourceId: "other-resource", versionNumber: 2})]
    });
    field(root, "Saved style definition").value = "<draft/>";
    button(root, "Save style version").click();
    await until(() => root.textContent.includes("save could not be confirmed"));
    button(root, "Save style version").click();
    button(root, "Check latest version").click();
    await until(() => root.textContent.includes("latest version could not be read"));
    assert.equal(writes, 1);
    assert.equal(button(root, "Save style version").disabled, true);
    assert.equal(button(root, "Use latest as edit base").hidden, true);
    assert.equal(field(root, "Saved style definition").value, "<draft/>");
  });

  it("offers read-only inspection without an edit grant, even for programmatic clicks", async () => {
    let calls = 0;
    const root = open({updateResourceStyle: async () => { calls++; }}, false);
    assert.equal(field(root, "Saved style definition").readOnly, true);
    assert.equal(button(root, "Save style version").hidden, true);
    button(root, "Save style version").click();
    await Promise.resolve();
    assert.equal(calls, 0);
    assert.equal(root.querySelector("summary").textContent, "Inspect definition");
  });

  it("verifies an older version without replacing a draft and rejects corrupt or substituted history", async () => {
    let record = style();
    let writes = 0;
    const root = open({getResourceStyleVersion: async (p, r, id, version) => {
      assert.equal(version, 1); return structuredClone(record);
    }, updateResourceStyle: async () => { writes++; }});
    field(root, "Saved style definition").value = "unsaved draft";
    button(root, "Load exact Style version").click();
    await until(() => root.textContent.includes("Verified saved version 1"));
    assert.equal(field(root, "Saved style definition").value, "unsaved draft");
    assert.equal(root.querySelectorAll('[aria-label="Saved style definition"]')[1].readOnly, true);
    assert.equal(root.querySelectorAll('[aria-label="Style version number"]').length, 1);
    for (const bad of [style({versionNumber: 2}), {...style(), checksumSha256: "0".repeat(64)}]) {
      record = bad;
      button(root, "Load exact Style version").click();
      await until(() => root.textContent.includes("could not be loaded and verified"));
      assert.equal(root.querySelectorAll('[aria-label="Saved style definition"]').length, 1);
    }
    assert.equal(writes, 0);
    assert.equal(root.hasUnsavedChanges(), true);
  });

  it("keeps fixture checksums current and rejects stale versions or format changes", async () => {
    // Exercise the production fixture methods with a minimal isolated project store.
    const adapter = Object.create(FixturePlatformAdapter.prototype);
    adapter.getResource = async () => ({id: "resource-1"});
    adapter.resourceStyles = new Map([["resource-1", []]]);
    adapter.spatialServiceCatalogs = new Map();
    const first = await adapter.createResourceStyle("project-1", "resource-1", style());
    const update = {title: "Edited", format: first.format, definition: "<updated/>", expectedVersion: 1};
    const edited = await adapter.updateResourceStyle("project-1", "resource-1", first.id, update);
    assert.equal((await savedStyleArtifact(first)).definition, first.definition);
    assert.equal((await savedStyleArtifact(edited)).definition, "<updated/>");
    const historical = await adapter.getResourceStyleVersion("project-1", "resource-1", first.id, 1);
    assert.equal(historical.definition, first.definition);
    assert.equal(historical.checksumSha256, first.checksumSha256);
    historical.definition = "mutated caller copy";
    assert.equal((await adapter.getResourceStyleVersion("project-1", "resource-1", first.id, 1)).definition, first.definition);
    await assert.rejects(adapter.getResourceStyleVersion("project-1", "resource-1", first.id, 3), {code: "resource_style_version_not_found"});
    await assert.rejects(adapter.updateResourceStyle("project-1", "resource-1", first.id, update), {code: "resource_style_version_conflict"});
    await assert.rejects(adapter.updateResourceStyle("project-1", "resource-1", first.id, {...update, expectedVersion: 2, format: "maplibre"}), {code: "resource_style_format_immutable"});
  });
});
