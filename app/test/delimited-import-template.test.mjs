import assert from "node:assert/strict";
import {afterEach, beforeEach, it} from "node:test";
import {JSDOM} from "jsdom";
import {DelimitedTextImport} from "../src/components/DelimitedTextImport.js";
import {DELIMITED_TEMPLATE_SCHEMA, normalizeDelimitedImportTemplate, readDelimitedImportTemplate, writeDelimitedImportTemplate} from "../src/lib/delimitedImportTemplate.js";

const template = () => ({schemaVersion: DELIMITED_TEMPLATE_SCHEMA, delimiter: ";", sourceProjection: "EPSG:4326", xColumn: "east", yColumn: "north", elevationColumn: "height", elevationUnit: "foot", verticalDatum: "Survey datum", labelColumn: "site", color: "#123456", categoryColumn: "kind", paletteName: "opengeo"});
const csv = "east;north;height;site;kind\n85;27;100;Clinic;Health\n86;28;;School;Education\n";
let dom, priorDocument, created, priorCreate, priorRevoke;
beforeEach(() => {
  dom = new JSDOM("<!doctype html><body><div id='shell'></div></body>", {url: "https://studio.example.test"});
  priorDocument = globalThis.document;globalThis.document = dom.window.document;
  dom.window.HTMLDialogElement.prototype.showModal = function () {this.open = true;};
  dom.window.HTMLDialogElement.prototype.close = function () {this.open = false;};
  dom.window.HTMLAnchorElement.prototype.click = function () {};
  created = [];priorCreate = URL.createObjectURL;priorRevoke = URL.revokeObjectURL;
  URL.createObjectURL = blob => {created.push(blob);return "blob:template";};URL.revokeObjectURL = () => {};
});
afterEach(() => {globalThis.document = priorDocument;URL.createObjectURL = priorCreate;URL.revokeObjectURL = priorRevoke;dom.window.close();});
const field = (dialog, label) => dialog.querySelector(`[aria-label="${label}"]`);
const button = (dialog, label) => [...dialog.querySelectorAll("button")].find(n => n.textContent === label);
async function upload(dialog, value) {
  const input = field(dialog, "Import coordinate template"), text = typeof value === "string" ? value : JSON.stringify(value);
  Object.defineProperty(input, "files", {configurable: true, value: [{size: new TextEncoder().encode(text).length, text: async () => text}]});
  await input.onchange();
}
const open = (onReview = () => {}, options = {}) => DelimitedTextImport({file: new File([csv], "survey.csv"), shell: document.querySelector("#shell"), onReview, ...options});

it("reuses a source-free template across two files through actual dialog import, download and Layer review", async () => {
  let result;
  const dialog = await open(value => {result = value;});
  field(dialog, "Omit records that cannot be mapped").checked = true;
  await upload(dialog, template());
  assert.equal(field(dialog, "Separator").value, ";");
  assert.equal(field(dialog, "Omit records that cannot be mapped").checked, false);
  assert.equal(field(dialog, "Label column").value, "site");
  button(dialog, "Download coordinate template").onclick();
  const downloaded = await created[0].text();assert.deepEqual(JSON.parse(downloaded), template());
  assert(!downloaded.includes("Clinic"));assert(!downloaded.includes("85"));assert(!downloaded.includes("skipInvalid"));
  dialog.querySelector("form").dispatchEvent(new dom.window.Event("submit", {cancelable: true}));
  assert.deepEqual(result.geojson.features[0].geometry.coordinates, [85, 27, 30.48]);
  assert.equal(result.style.renderer, "category");assert.equal(result.style.categoryField, "kind");assert.equal(result.style.circleColor, "#123456");assert.equal(result.labelField, "site");
  assert.equal(result.report.rejectedRecords.length, 0);
  const next = await open();await upload(next, downloaded);
  assert.equal(field(next, "Source coordinate system").value, "EPSG:4326");
  assert.equal(field(next, "Elevation unit").value, "foot");assert.equal(field(next, "Category palette").disabled, false);
});

it("refuses unmatched or hostile templates atomically without changing current mapping or source", async () => {
  const dialog = await open();await upload(dialog, template());
  for (const changed of [{xColumn: "missing"}, {delimiter: ","}, {skipInvalid: true}, {schemaVersion: "future"}, {color: "url(https://bad.test/)"}, {xColumn: "constructor"}]) {
    await upload(dialog, {...template(), ...changed});
    assert.equal(field(dialog, "Separator").value, ";");assert.equal(field(dialog, "Longitude / easting column").value, "east");
    assert(!dialog.querySelector('[role="status"]').textContent.startsWith("Template applied"));
  }
  assert.throws(() => readDelimitedImportTemplate(" ".repeat(16385)), /16 KiB/);
  assert.throws(() => readDelimitedImportTemplate("{"), /valid JSON/);
  assert.throws(() => normalizeDelimitedImportTemplate({...template(), xColumn: "north"}), /distinct/);
  assert.throws(() => writeDelimitedImportTemplate({...template(), verticalDatum: "bad\u0000datum"}), /elevation/);
});

it("ignores an asynchronous template read after cancellation or Project change", async () => {
  for (const cancel of [true, false]) {
    let current = true, complete;
    const dialog = await open(() => assert.fail("Import must not add a Layer"), {isCurrent: () => current});
    const input = field(dialog, "Import coordinate template");
    Object.defineProperty(input, "files", {value: [{size: 1, text: () => new Promise(resolve => {complete = resolve;})}]});
    const pending = input.onchange();
    if (cancel) button(dialog, "Cancel").onclick();else current = false;
    complete(JSON.stringify(template()));await pending;
    assert.equal(field(dialog, "Source coordinate system").value, "");
    if (!cancel) assert.match(dialog.querySelector('[role="status"]').textContent, /Project has changed/);
  }
});

it("keeps the latest selected template when an earlier read resolves last", async () => {
  const dialog = await open(), input = field(dialog, "Import coordinate template");let complete;
  Object.defineProperty(input, "files", {configurable: true, value: [{size: 1, text: () => new Promise(resolve => {complete = resolve;})}]});
  const pending = input.onchange();
  await upload(dialog, {...template(), color: "#abcdef"});
  complete(JSON.stringify(template()));await pending;
  assert.equal(field(dialog, "Point color").value, "#abcdef");
  assert.match(dialog.querySelector('[role="status"]').textContent, /Template applied/);
});
