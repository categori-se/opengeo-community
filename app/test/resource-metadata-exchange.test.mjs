import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";
import {ResourceMetadataExchange, metadataExportArtifacts} from "../src/components/ResourceMetadataExchange.js";

const formats = ["dcat_3", "stac_1_1", "ogc_records_1_0", "iso_19115_3", "schema_org_dataset", "datacite_4_7", "datacite_4_7_xml", "geodcat_ap_3_1"];
const xml = '<?xml version="1.0"?><metadata>é\r\n&lt;script&gt;</metadata>';
const report = {mapped: ["title"], defaulted: [], unmapped: ["content"], conformanceClaimed: false};
function response(target, overrides = {}) {
  const isXml = target === "iso_19115_3" || target === "datacite_4_7_xml";
  return {target, targetVersion: "test-version", status: "mapped_with_explicit_losses",
    document: isXml ? null : {title: "é", description: '<img src="https://untrusted.invalid" onerror="alert(1)">'},
    documentText: isXml ? xml : null, report, ...overrides};
}
function artifacts(target, overrides = {}) {
  return metadataExportArtifacts({target, projectId: "project-1", resourceId: "resource-1", exported: response(target), ...overrides});
}
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
const button = (root, name) => [...root.querySelectorAll("button")].find((value) => value.textContent === name);
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("metadata export did not settle");
}
function open(adapter) {
  const root = ResourceMetadataExchange({adapter, projectId: "project-1", resource: {id: "resource-1", language: "en"}});
  document.body.append(root);
  return root;
}

describe("metadata exchange", () => {
  it("produces separate standards documents and checksum-linked loss reports for all eight formats", async () => {
    for (const target of formats) {
      const value = await artifacts(target);
      const receipt = JSON.parse(value.report.body);
      assert.deepEqual(receipt.report, report);
      assert.equal(receipt.document.checksumSha256, createHash("sha256").update(value.document.body).digest("hex"));
      assert.equal(receipt.resourceId, "resource-1");
      assert.match(receipt.source, /no immutable resource revision is asserted/);
      if (target === "iso_19115_3" || target === "datacite_4_7_xml") {
        assert.equal(value.document.body, xml);
        assert.match(value.document.filename, /\.xml$/);
        assert.equal(value.document.mediaType, "application/xml;charset=utf-8");
      } else {
        assert.deepEqual(JSON.parse(value.document.body), response(target).document);
        assert.equal(JSON.parse(value.document.body).report, undefined);
      }
    }
  });

  it("exports only the report when metadata is missing or the target is not applicable", async () => {
    for (const status of ["not_applicable", "not_exportable_missing_required_metadata"]) {
      const value = await artifacts("datacite_4_7_xml", {exported: response("datacite_4_7_xml", {status, documentText: null, report: {...report, missingRequired: ["doi"]}})});
      assert.equal(value.document, null);
      assert.deepEqual(JSON.parse(value.report.body).report.missingRequired, ["doi"]);
    }
  });

  it("rejects wrong targets, unsafe filenames, ambiguous or oversized documents and unrecognized statuses", async () => {
    for (const override of [
      {target: "constructor"}, {resourceId: "../../secret"},
      {exported: response("stac_1_1")},
      {exported: response("dcat_3", {documentText: xml})},
      {exported: response("dcat_3", {document: null})},
      {exported: response("dcat_3", {status: "mapped_maybe"})},
      {exported: response("dcat_3", {status: "not_applicable"})},
      {exported: response("dcat_3", {document: {large: "x".repeat(262_144)}})},
      {exported: response("dcat_3", {report: {large: "x".repeat(65_536)}})}
    ]) await assert.rejects(artifacts("dcat_3", override));
  });

  it("uses a compact selector, keeps XML and its report inert, and sends only OGC language options", async () => {
    const calls = [];
    const root = open({exportResourceMetadata: async (...args) => {calls.push(args); return response(args[2]);}});
    const format = root.querySelector("select");
    const language = root.querySelector("input");
    assert.equal(format.options.length, 8);
    assert.equal(root.querySelectorAll("button").length, 1);
    assert.equal(language.parentElement.hidden, true);
    for (const target of ["iso_19115_3", "ogc_records_1_0"]) {
      format.value = target;
      format.dispatchEvent(new dom.window.Event("change"));
      language.value = "FR-ca";
      button(root, "Prepare metadata export").click();
      assert.equal(format.disabled, true);
      await until(() => !format.disabled);
      assert.ok(button(root, "Download metadata"));
      assert.ok(button(root, "Download conversion report"));
      assert.match(root.textContent, /Ready with omitted fields/);
      assert.match(root.querySelector('[aria-label="Conversion report"]').textContent, /conformanceClaimed/);
      assert.equal(root.querySelectorAll("img, script").length, 0);
    }
    assert.deepEqual(calls[0], ["project-1", "resource-1", "iso_19115_3", undefined]);
    assert.deepEqual(calls[1], ["project-1", "resource-1", "ogc_records_1_0", {language: "fr-ca"}]);
    language.dispatchEvent(new dom.window.Event("input"));
    assert.equal(button(root, "Download metadata"), undefined);
  });

  it("withholds documents for non-applicable results and clears old output on a failed request", async () => {
    let fail = false;
    const root = open({exportResourceMetadata: async (_project, _resource, target) => {
      if (fail) throw new Error("unavailable");
      return response(target, {status: "not_applicable", document: null});
    }});
    button(root, "Prepare metadata export").click();
    await until(() => !button(root, "Prepare metadata export").disabled);
    assert.equal(button(root, "Download metadata"), undefined);
    assert.ok(button(root, "Download conversion report"));
    assert.match(root.textContent, /No metadata document is available/);
    fail = true;
    button(root, "Prepare metadata export").click();
    await until(() => !button(root, "Prepare metadata export").disabled);
    assert.equal(button(root, "Download conversion report"), undefined);
    assert.match(root.textContent, /Nothing was downloaded or changed/);
  });

  it("requires valid language before making a request and handles unavailable adapters", () => {
    assert.equal(button(open({}), "Prepare metadata export").disabled, true);
    let calls = 0;
    const root = open({exportResourceMetadata: () => {calls++;}});
    root.querySelector("select").value = "ogc_records_1_0";
    root.querySelector("input").value = "bad language";
    button(root, "Prepare metadata export").click();
    assert.equal(calls, 0);
  });
});
