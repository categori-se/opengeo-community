import assert from "node:assert/strict";
import {afterEach, describe, it} from "node:test";

import {JSDOM} from "jsdom";

import {featurePropertyFields} from "../src/components/ProjectDatasets.js";

const previousDocument = globalThis.document;

afterEach(() => {
  globalThis.document = previousDocument;
});

describe("schema-driven feature fields", () => {
  it("requires deliberate attachment selection and preserves exact saved references", () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    globalThis.document = dom.window.document;
    const fields = [
      {name: "required_file", type: "string", required: true, attachment: true},
      {name: "optional_file", type: "string", required: false, attachment: true}
    ];
    const editor = featurePropertyFields(fields);
    const required = editor.element.querySelector('[aria-label="Feature property required_file"]');
    assert.equal(required.value, "");
    assert.throws(() => editor.read(), {code: "feature_properties_invalid"});
    required.value = "value";
    assert.throws(() => editor.read(), {code: "feature_properties_invalid"});
    const version = "81000000-0000-4000-8000-000000000001";
    editor.write({required_file: version});
    assert.deepEqual(editor.read(), {required_file: version});
    editor.write({});
    assert.equal(required.value, "");
    assert.throws(() => editor.read(), {code: "feature_properties_invalid"});
    editor.write({required_file: `device-file:${version}`});
    assert.throws(() => editor.read(), {code: "feature_properties_invalid"});
    assert.deepEqual(editor.read({allowDeviceFiles:true}),{required_file:`device-file:${version}`});
    dom.window.close();
  });
  it("renders field guidance and enforces immutable choice, length, and range rules", () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    globalThis.document = dom.window.document;
    const editor = featurePropertyFields([
      {
        name: "status",
        type: "string",
        required: true,
        label: "Review status",
        description: "Current field review state",
        choices: ["Open", "Closed"],
        minLength: 4,
        maxLength: 6,
        minimum: null,
        maximum: null
      },
      {
        name: "score",
        type: "number",
        required: false,
        label: "Inspection score",
        description: null,
        choices: [],
        minLength: null,
        maxLength: null,
        minimum: 0,
        maximum: 100
      },
      {
        name: "code",
        type: "string",
        required: true,
        label: null,
        description: null,
        choices: [],
        minLength: 2,
        maxLength: 3,
        minimum: null,
        maximum: null
      }
    ]);
    const controls = editor.element.querySelectorAll("select, input");

    assert.match(editor.element.textContent, /Review status · string · required/);
    assert.match(editor.element.textContent, /Current field review state/);
    assert.deepEqual([...controls[0].options].map(({value}) => value), ["Open", "Closed"]);
    assert.equal(controls[0].value, "Open");
    assert.equal(controls[1].min, "0");
    assert.equal(controls[1].max, "100");
    assert.equal(controls[2].value, "xx");

    editor.write({status: "Closed", score: 82.5, code: "MA"});
    assert.deepEqual(editor.read(), {status: "Closed", score: 82.5, code: "MA"});

    controls[1].value = "101";
    assert.throws(editor.read, (error) => error.code === "feature_properties_invalid");
    controls[1].value = "82.5";
    controls[2].value = "LONG";
    assert.throws(editor.read, (error) => error.code === "feature_properties_invalid");
  });

  it("shows dependent fields only when their earlier controller matches", () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    globalThis.document = dom.window.document;
    const editor = featurePropertyFields([
      {
        name: "inspection_type",
        type: "string",
        required: true,
        label: "Inspection type",
        choices: ["Routine", "Incident"],
        minimum: null,
        maximum: null,
        minLength: null,
        maxLength: null,
        visibleWhen: null
      },
      {
        name: "incident_reference",
        type: "string",
        required: true,
        label: "Incident reference",
        choices: [],
        minimum: null,
        maximum: null,
        minLength: 2,
        maxLength: 20,
        visibleWhen: {field: "inspection_type", equals: "Incident"}
      }
    ]);
    const [controller, dependent] = editor.element.querySelectorAll("select, input");

    assert.equal(controller.value, "Routine");
    assert.equal(dependent.closest("label").hidden, true);
    assert.deepEqual(editor.read(), {inspection_type: "Routine"});

    controller.value = "Incident";
    controller.dispatchEvent(new dom.window.Event("change"));
    assert.equal(dependent.closest("label").hidden, false);
    assert.equal(dependent.required, true);
    dependent.value = "";
    assert.throws(editor.read, (error) => error.code === "feature_properties_invalid");

    dependent.value = "INC-7";
    assert.deepEqual(editor.read(), {
      inspection_type: "Incident",
      incident_reference: "INC-7"
    });
    controller.value = "Routine";
    controller.dispatchEvent(new dom.window.Event("change"));
    assert.deepEqual(editor.read(), {inspection_type: "Routine"});
  });

  it("edits ordered repeating records and nested required values compactly", () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    globalThis.document = dom.window.document;
    const editor = featurePropertyFields([
      {
        name: "contact",
        type: "group",
        required: true,
        label: "Site contact",
        fields: [{name: "name", type: "string", required: true}]
      },
      {
        name: "samples",
        type: "group",
        required: false,
        label: "Samples",
        repeat: true,
        minItems: 1,
        maxItems: 2,
        fields: [
          {name: "value", type: "number", required: true, minimum: 0, maximum: 100},
          {name: "verified", type: "boolean", required: false}
        ]
      }
    ]);

    editor.write({
      contact: {name: "Ada"},
      samples: [{value: 12.5, verified: true}, {value: 18, verified: false}]
    });
    assert.deepEqual(editor.read(), {
      contact: {name: "Ada"},
      samples: [{value: 12.5, verified: true}, {value: 18, verified: false}]
    });
    const add = [...editor.element.querySelectorAll("button")]
      .find(({textContent}) => textContent === "Add Samples");
    assert.equal(add.disabled, true);
    const remove = [...editor.element.querySelectorAll("button")]
      .find(({textContent, disabled}) => textContent === "Remove" && !disabled);
    remove.click();
    assert.deepEqual(editor.read(), {
      contact: {name: "Ada"},
      samples: [{value: 18, verified: false}]
    });
  });
});

it("recomputes read-only fields from inputs and surfaces invalid calculations", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.document = dom.window.document;
  const numeric = name => ({name, type:"number", required:false, minimum:null, maximum:null});
  const editor=featurePropertyFields([numeric("quantity"),numeric("price"),
    {...numeric("total"),calculation:{"*":[{var:"quantity"},{var:"price"}]}},
    {...numeric("unit"),calculation:{"/":[{var:"total"},{var:"quantity"}]}}]);
  editor.write({quantity:3,price:4,total:999});
  assert.deepEqual(editor.read(),{quantity:3,price:4,total:12,unit:4});
  assert.equal(editor.element.querySelector('[aria-label="Feature property total"]').readOnly,true);
  editor.write({quantity:0,price:4});
  assert.throws(editor.read);
});
