import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {identifyProjectFileFormat, readSavedProjectVersionFile} from "../src/lib/projectFileFormat.js";
import {savedProjectVersionFile} from "../src/components/ProjectVersionExport.js";

const dom = new JSDOM("<!doctype html>");
const options = {Parser: dom.window.DOMParser};

it("identifies supported Project formats by content rather than filename", () => {
  assert.equal(identifyProjectFileFormat(JSON.stringify({persistence: {mode: "browser-only-demo"}}), options), "opengeo-browser");
  assert.equal(identifyProjectFileFormat(JSON.stringify({persistence: {provider: "aws"}}), options), "opengeo-managed");
  assert.equal(identifyProjectFileFormat(savedProjectVersionFile("project", {version: 2, definition: {schemaVersion: "opengeo.map-definition.1.0.0"}}), options), "opengeo-managed");
  assert.equal(identifyProjectFileFormat(JSON.stringify({version: "0.2.0", layers: [], mapView: {}}), options), "geolibre");
  assert.equal(identifyProjectFileFormat('<mapbook version="3.0"/>', options), "geomoose");
  assert.equal(identifyProjectFileFormat('<ViewContext xmlns="http://www.opengis.net/context" version="1.1.0"/>', options), "wmc");
});

it("rejects ambiguous input and active XML before an importer is selected", () => {
  for (const input of ['{"version":"0.2.0"}', '{', '<svg/>', '<!DOCTYPE mapbook><mapbook version="3.0"/>']) {
    assert.throws(() => identifyProjectFileFormat(input, options));
  }
});

it("reads inert saved snapshots without converting their original IDs or history into authority", () => {
  const definition = {schemaVersion: "opengeo.map-definition.1.4.0", layers: [{datasetId: "original-layer", visible: false}], extension: {unknown: "Retain 田"}};
  const source = savedProjectVersionFile("original-project", {version: 6, definition, createdBy: "old-owner", changeMessage: "Original"});
  const snapshot = readSavedProjectVersionFile(source);
  assert.deepEqual(snapshot.definition, definition);
  assert.equal(snapshot.projectId, "original-project");
  assert.equal(snapshot.history.createdBy, "old-owner");
  assert.equal(snapshot.accessIncluded, false);
});

it("rejects unsupported managed files, excessive definitions and non-finite snapshot numbers before creation", () => {
  for (const source of [JSON.stringify({persistence: {provider: "aws"}}),
    savedProjectVersionFile("project", {version: 1, definition: {large: "x".repeat(262_144)}}),
    savedProjectVersionFile("project", {version: 1, definition: {coordinate: 1}}).replace('"coordinate":1', '"coordinate":1e400')]) {
    assert.throws(() => readSavedProjectVersionFile(source));
  }
});
