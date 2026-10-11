import assert from "node:assert/strict";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";
import {ProjectResources} from "../src/components/ProjectResources.js";

const IDS = Object.freeze({
  project: "50000000-0000-4000-8000-000000000083",
  dataset: "80000000-0000-4000-8000-000000000083",
  resource: "90000000-0000-4000-8000-000000000083",
  profile: "a0000000-0000-4000-8000-000000000083",
  job: "b0000000-0000-4000-8000-000000000083"
});

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

async function open(overrides = {}) {
  const resource = {
    id: IDS.resource, projectId: IDS.project, datasetId: IDS.dataset,
    kind: "dataset", slug: "observations", title: "Observations", state: "draft",
    visibility: "restricted", versionNumber: 2, spatialExtent: [-72, 41, -71, 42],
    language: "en", license: "CC-BY-4.0", attribution: "Survey team",
    keywords: [], metadataProfile: "opengeo.core.v1", metadataExtensions: {},
    translations: {}, externalIdentifiers: [], relationships: [],
    content: {blocks: []}, provenance: {}
  };
  const adapter = {
    async getResource() { return resource; },
    async getResourceCapabilities() {
      return {canRead: true, canUpdate: true, canPublish: false, canManagePermissions: false};
    },
    async listRenderProfiles() {
      return [{id: IDS.profile, title: "Survey map", versionNumber: 3,
        datasetVersionId: "dataset-version-2", styleVersionId: "style-version-4"}];
    },
    ...overrides
  };
  const root = ProjectResources({state: {
    adapter, session: {userId: "owner"},
    organization: {id: "organization", callerRole: "member"},
    project: {id: IDS.project, name: "Survey", callerRole: "owner"},
    datasets: [], maps: [], resources: [resource], metadataProfiles: []
  }});
  document.body.append(root);
  button(root, "Open resource").click();
  await until(() => root.querySelector('.project-resource-detail[data-state="ready"]'));
  return field(root, "Render format").closest(".project-resource-editor-panel");
}

function button(root, label) {
  const found = [...root.querySelectorAll("button")].find((element) => element.textContent === label);
  assert.ok(found, `button ${label} is present`);
  return found;
}
function field(root, label) {
  const found = root.querySelector(`[aria-label="${label}"]`);
  assert.ok(found, `field ${label} is present`);
  return found;
}
function select(root, format) {
  const control = field(root, "Render format");
  control.value = format;
  control.dispatchEvent(new dom.window.Event("change", {bubbles: true}));
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("render editor did not settle");
}
function job(format, state = "queued") {
  return {id: IDS.job, state, format, profileVersionNumber: 3,
    datasetVersionId: "dataset-version-2", styleVersionId: "style-version-4",
    requestChecksumSha256: "a".repeat(64),
    outputChecksumSha256: state === "completed" ? "b".repeat(64) : null};
}

describe("governed render format interaction", () => {
  it("defaults to SVG and changes the requested format without starting work", async () => {
    let writes = 0;
    const root = await open({async requestResourceRender() { writes++; }});
    assert.equal(field(root, "Render format").value, "svg");
    assert.deepEqual([...field(root, "Render format").options].map(({value, textContent}) => [value, textContent]),
      [["svg", "SVG"], ["png", "PNG"]]);
    assert.equal(button(root, "Request SVG render").disabled, false);
    assert.equal(field(root, "Render width").value, "1200");
    assert.equal(field(root, "Render height").value, "800");
    select(root, "png");
    assert.equal(button(root, "Request PNG render").disabled, false);
    select(root, "svg");
    assert.equal(button(root, "Request SVG render").disabled, false);
    await Promise.resolve();
    assert.equal(writes, 0);
  });

  for (const format of ["svg", "png"]) {
    it(`requests ${format.toUpperCase()} explicitly and retains its identity through status and download`, async () => {
      const requests = [];
      const reads = [];
      const downloads = [];
      let resolveRequest;
      const root = await open({
        requestResourceRender(...args) {
          requests.push(args);
          return new Promise((resolve) => { resolveRequest = resolve; });
        },
        async getResourceRender(...args) {
          reads.push(args);
          return job(format, "completed");
        },
        async downloadResourceRender(...args) {
          downloads.push(args);
          return {url: `https://downloads.invalid/exact.${format}`};
        }
      });
      select(root, format);
      field(root, "Render extent (west, south, east, north)").value = "-71.8, 41.5, -71.1, 41.9";
      field(root, "Render width").value = "320";
      field(root, "Render height").value = "240";
      const request = button(root, `Request ${format.toUpperCase()} render`);
      request.click();
      assert.equal(request.disabled, true);
      assert.match(root.querySelector(".project-render-result").textContent,
        new RegExp(`Queueing exact-version ${format.toUpperCase()} render`));
      request.click();
      assert.equal(requests.length, 1, "a disabled control does not submit twice");
      const [projectId, resourceId, profileId, submitted] = requests[0];
      assert.deepEqual([projectId, resourceId, profileId], [IDS.project, IDS.resource, IDS.profile]);
      assert.deepEqual({...submitted, idempotencyKey: "checked"}, {
        idempotencyKey: "checked", bbox: [-71.8, 41.5, -71.1, 41.9], width: 320, height: 240, format
      });
      assert.match(submitted.idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

      // Selecting the next output must not relabel or change the in-flight job.
      const nextFormat = format === "svg" ? "png" : "svg";
      select(root, nextFormat);
      assert.equal(button(root, `Request ${nextFormat.toUpperCase()} render`).disabled, true);
      assert.equal(submitted.format, format);
      assert.match(root.querySelector(".project-render-result").textContent,
        new RegExp(`Queueing exact-version ${format.toUpperCase()} render`));
      resolveRequest(job(format));
      await until(() => root.textContent.includes("State queued"));
      assert.equal(request.disabled, false);
      assert.equal(reads.length, 0, "queue completion does not start a hidden polling loop");
      button(root, "Refresh render status").click();
      await until(() => root.textContent.includes("State completed"));
      assert.deepEqual(reads, [[IDS.project, IDS.resource, IDS.job]]);
      assert.equal(downloads.length, 0, "a completed render still needs an explicit download action");
      button(root, `Authorize exact ${format.toUpperCase()} download`).click();
      await until(() => root.querySelector(".project-render-result a"));
      const link = root.querySelector(".project-render-result a");
      assert.equal(link.textContent, `Download exact ${format.toUpperCase()}`);
      assert.equal(link.href, `https://downloads.invalid/exact.${format}`);
      assert.deepEqual(downloads, [[IDS.project, IDS.resource, IDS.job]]);
      assert.equal(requests.length, 1);
    });
  }

  it("retains the chosen format and dimensions after rejection and only retries on request", async () => {
    const requests = [];
    const root = await open({async requestResourceRender(...args) {
      requests.push(args);
      if (requests.length === 1) throw Object.assign(new Error("capacity unavailable"), {code: "render_capacity_exceeded"});
      return job("png", "completed");
    }});
    select(root, "png");
    field(root, "Render width").value = "640";
    field(root, "Render height").value = "480";
    button(root, "Request PNG render").click();
    await until(() => root.textContent.includes("Render request failed safely (render_capacity_exceeded)"));
    assert.equal(button(root, "Request PNG render").disabled, false);
    assert.equal(field(root, "Render format").value, "png");
    assert.equal(field(root, "Render width").value, "640");
    assert.equal(field(root, "Render height").value, "480");
    await Promise.resolve();
    assert.equal(requests.length, 1);
    button(root, "Request PNG render").click();
    await until(() => root.textContent.includes("Authorize exact PNG download"));
    assert.equal(requests.length, 2);
    assert.equal(requests[1][3].format, "png");
    assert.equal(requests[1][3].width, 640);
    assert.equal(requests[1][3].height, 480);
  });
});
