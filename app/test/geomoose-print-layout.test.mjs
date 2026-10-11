import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {parseSitePrintLayout} from "../src/lib/apiClient.js";
import {
  convertGeoMoosePrintLayout,
  GEOMOOSE_PRINT_CONVERSION_LIMITS
} from "../src/lib/geomoosePrintLayout.js";

const mapResourceId = "20000000-0000-4000-8000-000000000001";

function sourceLayout() {
  return {
    label: "letter-landscape-legend",
    orientation: "landscape",
    page: "letter",
    units: "in",
    elements: [
      {type: "text", size: 18, fontStyle: "bold", x: 0.5, y: 0.7, text: "{{title}}"},
      {type: "map", x: 0.5, y: 0.75, width: 7, height: 7},
      {type: "rect", x: 0.5, y: 0.75, width: 7, height: 7, strokeWidth: 0.01},
      {type: "text", x: 0.5, y: 8, text: "Printed {{year}}-{{month}}-{{day}}"},
      {type: "text", x: 7.6, y: 0.9, text: "Legend"},
      {type: "legend", x: 7.61, y: 1},
      {type: "rect", x: 7.6, y: 0.75, width: 2.4, height: 7, strokeWidth: 0.01}
    ]
  };
}

function convert(value = sourceLayout(), options = {}) {
  return convertGeoMoosePrintLayout(value, {
    sitePageSlug: "massgis-map",
    mapResourceId,
    title: "MassGIS review",
    printedOn: "2026-09-01T12:00:00Z",
    ...options
  });
}

describe("GeoMoose 3.15.2 print-layout conversion", () => {
  it("preserves bounded page, map, legend, text, and exact substitution semantics", () => {
    const result = convert();
    assert.deepEqual(result.themeOptions, {
      printPageSize: "letter",
      printOrientation: "landscape",
      printLayout: "map-sheet",
      printLegend: "true",
      printNorthArrow: "false",
      printScaleBar: "false"
    });
    const parsed = parseSitePrintLayout(result.printLayout, new Set(["massgis-map"]));
    assert.equal(parsed.pages.length, 1);
    assert.deepEqual(
      parsed.pages[0].elements.map(({type}) => type),
      ["text", "map_frame", "text", "text", "legend_frame"]
    );
    assert.equal(parsed.pages[0].elements[0].text, "MassGIS review");
    assert.equal(parsed.pages[0].elements[2].text, "Printed 2026-9-1");
    assert.equal(parsed.pages[0].elements[1].resourceId, mapResourceId);
    assert.deepEqual(
      Object.fromEntries(
        ["x", "y", "width", "height"].map((key) => [key, parsed.pages[0].elements[1][key]])
      ),
      {x: 45, y: 88, width: 636, height: 824}
    );
    assert.equal(parsed.pages[0].elements[4].mapFrameId, "map_1");
    assert.deepEqual(
      Object.fromEntries(
        ["x", "y", "width", "height"].map((key) => [key, parsed.pages[0].elements[4][key]])
      ),
      {x: 691, y: 88, width: 218, height: 824}
    );
    assert.equal(result.report.sourceElementCount, 7);
    assert.equal(result.report.convertedElementCount, 5);
    assert.equal(result.report.omittedElementCount, 2);
    assert.deepEqual(
      result.report.sourceElementOutcomes.map(({disposition}) => disposition),
      ["converted", "converted", "omitted", "converted", "converted", "converted", "omitted"]
    );
    assert.equal(result.report.losses.filter(({code}) => code === "drawing_omitted").length, 2);
    assert.equal(result.report.losses.some(({code}) => code === "legend_source_governed"), true);
    assert.deepEqual(
      result.report.externalContextLosses.map(({code}) => code),
      [
        "runtime_resolution_not_converted",
        "runtime_selection_not_converted",
        "portal_scale_line_not_converted",
        "geopdf_extent_not_converted"
      ]
    );
    assert.equal(result.report.networkRequests, 0);
    assert.equal(result.report.inlineImageBytesRead, false);
    assert.equal(result.report.externalResourcesOpened, false);
  });

  it("retains unknown template tokens literally and reports them", () => {
    const layout = sourceLayout();
    layout.elements[0].text = "{{title}} · {{organization.secret}}";
    const result = convert(layout);
    assert.equal(
      result.printLayout.pages[0].elements[0].text,
      "MassGIS review · {{organization.secret}}"
    );
    assert.deepEqual(
      result.report.losses.find(({code}) => code === "template_tokens_unresolved"),
      {
        sourceElementIndex: 0,
        sourceType: "text",
        code: "template_tokens_unresolved",
        detail: "OpenGeo retained unsupported template tokens literally: organization.secret."
      }
    );
  });

  it("retains unsupported template syntax literally and reports it", () => {
    const layout = sourceLayout();
    layout.elements[0].text = "{{#if admin}}private{{/if}}";
    const result = convert(layout);
    assert.equal(result.printLayout.pages[0].elements[0].text, "{{#if admin}}private{{/if}}");
    assert.match(
      result.report.losses.find(({code}) => code === "template_tokens_unresolved").detail,
      /unsupported template syntax/
    );
  });

  it("requires sealed image bindings and never consumes inline bytes", () => {
    const layout = sourceLayout();
    layout.elements.splice(1, 0, {
      type: "image",
      x: 1,
      y: 1,
      width: 2,
      height: 1,
      image_data: "data:image/png;base64,not-read"
    });
    const omitted = convert(layout);
    assert.equal(omitted.report.losses.some(({code}) => code === "image_omitted_unsealed"), true);
    assert.equal(omitted.printLayout.pages[0].elements.some(({type}) => type === "image_frame"), false);
    const bound = convert(layout, {imageBlockIds: {1: "sealed_image"}});
    const image = bound.printLayout.pages[0].elements.find(({type}) => type === "image_frame");
    assert.equal(image.blockId, "sealed_image");
    assert.equal(bound.report.losses.some(({code}) => code === "inline_image_replaced"), true);
    assert.equal(bound.report.inlineImageBytesRead, false);
  });

  it("fails closed on active extensions, invalid identity, unsupported units, bounds, and limits", () => {
    const cases = [
      () => {
        const value = sourceLayout();
        value.fetchUrl = "https://example.invalid/layout";
        return value;
      },
      () => {
        const value = sourceLayout();
        value.units = "px";
        return value;
      },
      () => {
        const value = sourceLayout();
        value.elements[0].onRender = "alert(1)";
        return value;
      },
      () => {
        const value = sourceLayout();
        value.elements[1].x = 20;
        return value;
      },
      () => {
        const value = sourceLayout();
        value.elements[1].width = 0;
        return value;
      },
      () => {
        const value = sourceLayout();
        value.elements = Array.from(
          {length: GEOMOOSE_PRINT_CONVERSION_LIMITS.maximumElements + 1},
          () => ({type: "map", x: 0, y: 0, width: 1, height: 1})
        );
        return value;
      }
    ];
    for (const make of cases) assert.throws(() => convert(make()), /GeoMoose print layout/);
    assert.throws(() => convert(sourceLayout(), {mapResourceId: "not-a-uuid"}), /map resource id/);
    assert.throws(() => convert(sourceLayout(), {sitePageSlug: "Not a slug"}), /site page slug/);
    assert.throws(
      () => convert(sourceLayout(), {imageBlockIds: {"32": "sealed_image"}}),
      /binding key/
    );
    assert.throws(
      () => convert(sourceLayout(), {imageBlockIds: {"1": "sealed_image"}}),
      /binding target/
    );
  });
});
