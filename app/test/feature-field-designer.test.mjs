import assert from "node:assert/strict";
import {afterEach, describe, it} from "node:test";

import {JSDOM} from "jsdom";

import {
  featureCollectionInitializer,
  featureFieldDesigner
} from "../src/components/ProjectDatasets.js";

const previousDocument = globalThis.document;

afterEach(() => {
  globalThis.document = previousDocument;
});

function browser() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.document = dom.window.document;
  return dom.window;
}

function clickNamed(root, name) {
  const button = [...root.querySelectorAll("button")]
    .find((candidate) => candidate.textContent === name && !candidate.disabled);
  assert.ok(button, `expected enabled ${name} button`);
  button.click();
}

describe("visual feature field designer", () => {
  it("creates, orders, removes, and serializes type-specific immutable rules", () => {
    browser();
    const designer = featureFieldDesigner([
      {
        name: "status",
        type: "string",
        required: true,
        label: "Review status",
        description: "Current review state",
        choices: ["Open", "Closed"],
        minLength: 4,
        maxLength: 6
      },
      {
        name: "score",
        type: "number",
        minimum: 0,
        maximum: 100,
        visibleWhen: {field: "status", equals: "Open"}
      }
    ]);

    assert.equal(designer.element.querySelectorAll(".project-feature-schema-row").length, 2);
    assert.equal(designer.element.querySelector("output").value, "2 of 64 fields");
    assert.deepEqual(designer.read(), [
      {
        name: "status",
        type: "string",
        required: true,
        label: "Review status",
        description: "Current review state",
        choices: ["Open", "Closed"],
        minLength: 4,
        maxLength: 6
      },
      {
        name: "score",
        type: "number",
        required: false,
        minimum: 0,
        maximum: 100,
        visibleWhen: {field: "status", equals: "Open"}
      }
    ]);

    clickNamed(designer.element.querySelector('[data-field-index="0"]'), "Move down");
    assert.throws(
      designer.read,
      (error) => error.code === "feature_schema_invalid"
        && /must reference a field above/u.test(error.userMessage)
    );
    clickNamed(designer.element.querySelector('[data-field-index="0"]'), "Move down");
    clickNamed(designer.element, "Add field");
    assert.deepEqual(designer.read().map(({name}) => name), ["status", "score", "field_1"]);
    clickNamed(designer.element.querySelector('[data-field-index="2"]'), "Remove");
    assert.equal(designer.element.querySelector("output").value, "2 of 64 fields");
  });

  it("reports duplicate names and invalid choice and range rules before submission", () => {
    browser();
    const duplicate = featureFieldDesigner([
      {name: "Status", type: "string"},
      {name: "status", type: "boolean"}
    ]);
    assert.throws(
      duplicate.read,
      (error) => error.code === "feature_schema_invalid"
        && /duplicates another stable field name/u.test(error.userMessage)
    );

    const choice = featureFieldDesigner([{
      name: "status",
      type: "string",
      choices: ["Open", "Open"],
      minLength: 5,
      maxLength: 4
    }]);
    assert.throws(
      choice.read,
      (error) => error.code === "feature_schema_invalid"
        && /at most 32 unique lines/u.test(error.userMessage)
    );

    const range = featureFieldDesigner([{
      name: "score",
      type: "integer",
      minimum: 10,
      maximum: 5
    }]);
    assert.throws(
      range.read,
      (error) => error.code === "feature_schema_invalid"
        && /minimum value exceeds/u.test(error.userMessage)
    );
  });

  it("caps the visual workflow at the server's 64-field boundary", () => {
    browser();
    const designer = featureFieldDesigner(Array.from(
      {length: 64},
      (_, index) => ({name: `field_${index + 1}`, type: "string"})
    ));
    const add = [...designer.element.querySelectorAll("button")]
      .find(({textContent}) => textContent === "Add field");

    assert.equal(designer.read().length, 64);
    assert.equal(add.disabled, true);
    assert.equal(designer.element.querySelector("output").value, "64 of 64 fields");
    assert.throws(
      () => featureFieldDesigner(Array.from(
        {length: 65},
        (_, index) => ({name: `field_${index + 1}`, type: "string"})
      )),
      (error) => error.code === "feature_schema_invalid"
    );
  });

  it("authors bounded nested and repeating groups without a parallel JSON editor", () => {
    browser();
    const designer = featureFieldDesigner([
      {name: "inspection_type", type: "string", required: true},
      {
        name: "samples",
        type: "group",
        repeat: true,
        minItems: 1,
        maxItems: 3,
        fields: [
          {name: "value", type: "number", required: true, minimum: 0},
          {name: "note", type: "string"}
        ]
      }
    ]);

    assert.match(designer.element.textContent, /Allow repeated records/u);
    assert.equal(designer.element.querySelectorAll(".project-feature-schema-row").length, 4);
    assert.equal(
      designer.element.querySelector(":scope > .project-feature-schema-toolbar output").value,
      "4 of 64 fields across this level and its groups"
    );
    assert.deepEqual(designer.read(), [
      {name: "inspection_type", type: "string", required: true},
      {
        name: "samples",
        type: "group",
        required: false,
        fields: [
          {name: "value", type: "number", required: true, minimum: 0},
          {name: "note", type: "string", required: false}
        ],
        repeat: true,
        minItems: 1,
        maxItems: 3
      }
    ]);
  });

  it("submits the visual schema directly to governed collection creation", async () => {
    const window = browser();
    let resolveCall;
    const called = new Promise((resolve) => {
      resolveCall = resolve;
    });
    const view = featureCollectionInitializer(
      {
        project: {id: "50000000-0000-4000-8000-000000000001"},
        adapter: {
          async createFeatureCollection(projectId, datasetId, payload) {
            resolveCall({projectId, datasetId, payload});
            throw Object.assign(new Error("stop after capture"), {code: "test_stop"});
          }
        }
      },
      {
        id: "80000000-0000-4000-8000-000000000001",
        geometryType: "Point"
      },
      window.document.createElement("div")
    );

    assert.doesNotMatch(view.textContent, /Property fields \(JSON\)/u);
    view.querySelector("form").dispatchEvent(new window.Event("submit", {
      bubbles: true,
      cancelable: true
    }));
    const request = await called;

    assert.equal(request.projectId, "50000000-0000-4000-8000-000000000001");
    assert.equal(request.datasetId, "80000000-0000-4000-8000-000000000001");
    assert.deepEqual(request.payload, {
      geometryType: "Point",
      fields: [{
        name: "status",
        type: "string",
        required: true,
        label: "Status",
        description: "Current review status",
        choices: ["Open", "Closed"]
      }],
      features: []
    });
  });
});

it("preserves and edits numeric comparison rules without changing legacy equality", () => {
  browser();
  const designer = featureFieldDesigner([
    {name: "score", type: "number", required: false},
    {name: "reason", type: "string", required: true,
      visibleWhen: {field: "score", equals: 10, operator: "gte"}}
  ]);
  const comparison = designer.element.querySelector('[aria-label="Field 2 visibility comparison"]');
  assert.equal(comparison.value, "gte");
  assert.equal(designer.read()[1].visibleWhen.operator, "gte");
  comparison.value = "eq";
  comparison.dispatchEvent(new document.defaultView.Event("change"));
  assert.deepEqual(designer.read()[1].visibleWhen, {field: "score", equals: 10});
});

it("offers compatible earlier fields as comparison operands", () => {
  browser();
  const designer = featureFieldDesigner([
    {name: "measured", type: "number"}, {name: "limit", type: "integer"},
    {name: "reason", type: "string", visibleWhen: {field: "measured", value_field: "limit", operator: "gt"}}
  ]);
  assert.deepEqual(designer.read()[2].visibleWhen,
    {field: "measured", value_field: "limit", operator: "gt"});
  const operand = designer.element.querySelector('[aria-label="Field 3 comparison source"]');
  assert.equal(operand.value, "limit");
  assert.equal(designer.element.querySelector('[aria-label="Field 3 visibility value"]'), null);
});

it("preserves bounded calculations in the schema designer", () => {
  browser();
  const calculation={"*": [{var:"quantity"}, 2]};
  const designer=featureFieldDesigner([{name:"quantity",type:"number"},
    {name:"total",type:"number",calculation}]);
  assert.deepEqual(designer.read()[1].calculation,calculation);
  const control=designer.element.querySelector('[aria-label="Field 2 calculation"]');
  control.value='{"var":"later"}';
  control.dispatchEvent(new document.defaultView.Event('input'));
  assert.throws(designer.read, error => error.code === "feature_schema_invalid"
    && /earlier numeric field/.test(error.userMessage));
});

it("offers catalog attachments without carrying ordinary string choice rules", () => {
  browser();
  const designer=featureFieldDesigner([{name:"photo",type:"string",choices:["old"]}]);
  const checkbox=designer.element.querySelector('[aria-label="Field 1 is an attachment"]');
  checkbox.checked=true;checkbox.dispatchEvent(new document.defaultView.Event('change'));
  assert.deepEqual(designer.read(),[{name:"photo",type:"string",required:false,attachment:true}]);
});
