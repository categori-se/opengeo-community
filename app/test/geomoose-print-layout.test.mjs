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

  it("leaves title and date text the remaining page width instead of clipping to guessed source-font metrics", () => {
    const layout = sourceLayout();
    layout.elements[3].text = "Printed on {{month}}/{{day}}/{{year}}";
    const result = convert(layout);
    const texts = result.printLayout.pages[0].elements.filter(({type}) => type === "text");
    assert.deepEqual(texts.map(({text}) => text), ["MassGIS review", "Printed on 9/1/2026", "Legend"]);
    assert.deepEqual(
      Object.fromEntries(["x", "y", "width", "height"].map((key) => [key, texts[0][key]])),
      {x: 45, y: 43, width: 955, height: 40}
    );
    for (const text of texts) assert.equal(text.x + text.width, 1000, "native text has no box constraint before the page edge");
    const longer = sourceLayout();
    longer.elements[0].text = "A longer complete title remains text, rather than a source-font width estimate";
    assert.equal(convert(longer).printLayout.pages[0].elements[0].width, texts[0].width);
    assert.match(result.report.losses.find(({code}) => code === "text_style_coarsened").detail, /metrics may differ/);
    assert.equal(result.report.losses.filter(({code}) => code === "drawing_omitted").length, 2);
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
        detail: "OpenGeo Studio retained unsupported template tokens literally: organization.secret."
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

describe("opt-in GeoMoose drawing conversion", () => {
  const schema = "opengeo.print-layout.1.2.0";
  it("preserves legacy output/reports by default and retains rectangle order only on explicit 1.2", () => {
    assert.deepEqual(convert(), convert(sourceLayout(), {targetSchemaVersion: "opengeo.print-layout.1.1.0"}));
    const result = convert(sourceLayout(), {targetSchemaVersion: schema});
    const parsed = parseSitePrintLayout(result.printLayout, new Set(["massgis-map"]));
    assert.equal(parsed.schemaVersion, schema);
    assert.deepEqual(parsed.pages[0].elements.map(element => element.type),
      ["text", "map_frame", "shape_frame", "text", "text", "legend_frame", "shape_frame"]);
    const border = parsed.pages[0].elements[2];
    assert.equal(border.shape, "rectangle"); assert.equal(border.stroke, "#000000"); assert.equal(border.fill, null);
    assert.equal(border.strokeWidth, 1);
    assert.equal(result.report.convertedElementCount, 7); assert.equal(result.report.omittedElementCount, 0);
    assert.equal(result.report.losses.filter(loss => loss.code === "stroke_width_quantized").length, 2);
    assert(result.report.externalContextLosses.some(loss => loss.code === "legend_async_paint_order_not_converted"));
    assert.equal(result.report.networkRequests, 0); assert.equal(result.report.externalResourcesOpened, false);
    assert.throws(() => convert(sourceLayout(), {targetSchemaVersion: "opengeo.print-layout.1.0.0"}), /target schema/);
    assert.throws(() => convert(sourceLayout(), {targetSchemaVersion: "future"}), /target schema/);
  });

  it("maps ellipse centre/radii, fill-only semantics and exact RGB colors without inventing a stroke", () => {
    const source = sourceLayout(); source.units = "pt"; source.elements = [
      {type: "map", x: 0, y: 0, width: 300, height: 300},
      {type: "ellipse", x: 144, y: 144, rx: 72, ry: 36, filled: true, strokeWidth: 0, fill: [12, 34, 56]},
      {type: "rect", x: 72, y: 36, width: 144, height: 72, filled: true, strokeWidth: 2, stroke: [1, 2, 3]}
    ];
    const result = convert(source, {targetSchemaVersion: schema}), shapes = result.printLayout.pages[0].elements.slice(1);
    assert.deepEqual([shapes[0].x, shapes[0].y, shapes[0].width, shapes[0].height], [91, 176, 182, 118]);
    assert.equal(shapes[0].shape, "ellipse"); assert.equal(shapes[0].fill, "#0c2238"); assert.equal(shapes[0].stroke, null);
    assert.equal(shapes[1].fill, "#ffffff"); assert.equal(shapes[1].stroke, "#010203"); assert.equal(shapes[1].strokeWidth, 2);
    assert(result.report.losses.some(loss => loss.code === "drawing_geometry_quantized"));
    assert(shapes.every(shape => shape.clip === false));
    parseSitePrintLayout(result.printLayout, new Set(["massgis-map"]));
  });

  it("converts explicit layout-unit widths and discloses the upstream unusual omitted-width default", () => {
    const source = sourceLayout(); source.units = "mm"; source.elements = [
      {type: "map", x: 1, y: 1, width: 100, height: 100},
      {type: "rect", x: 5, y: 5, width: 20, height: 20, strokeWidth: 0.25},
      {type: "ellipse", x: 60, y: 60, rx: 10, ry: 10}
    ];
    const result = convert(source, {targetSchemaVersion: schema});
    assert.equal(result.printLayout.pages[0].elements[1].strokeWidth, 1);
    assert.equal(result.printLayout.pages[0].elements[2].strokeWidth, 4);
    assert.match(result.report.losses.find(loss => loss.sourceElementIndex === 1 && loss.code === "stroke_width_quantized").detail, /0\.70866/);
    const inches = sourceLayout(); inches.elements.push({type: "rect", x: 1, y: 1, width: 1, height: 1});
    const unsupported = convert(inches, {targetSchemaVersion: schema});
    assert.equal(unsupported.report.sourceElementOutcomes.at(-1).disposition, "omitted");
    assert.match(unsupported.report.losses.find(loss => loss.code === "drawing_omitted_stroke_width").detail, /96pt/);
  });

  it("reports out-of-page, undersized and unsupported-width drawings without clamping or enlarging", () => {
    const source = sourceLayout(); source.elements = [source.elements[1],
      {type: "ellipse", x: 0.1, y: 0.1, rx: 0.2, ry: 0.2, strokeWidth: 0.01},
      {type: "rect", x: 1, y: 1, width: 0.01, height: 0.01, strokeWidth: 0.01},
      {type: "rect", x: 10.5, y: 1, width: 1, height: 1, strokeWidth: 0.01},
      {type: "rect", x: 1, y: 1, width: 1, height: 1, strokeWidth: 1},
      {type: "rect", x: 2, y: 2, width: 1, height: 1, filled: false, strokeWidth: 0, fill: [255, 0, 0]}
    ];
    const result = convert(source, {targetSchemaVersion: schema});
    assert.equal(result.printLayout.pages[0].elements.length, 1);
    assert.equal(result.report.losses.filter(loss => loss.code === "drawing_omitted_bounds").length, 3);
    assert.equal(result.report.losses.filter(loss => loss.code === "drawing_omitted_stroke_width").length, 1);
    assert.equal(result.report.losses.filter(loss => loss.code === "drawing_omitted_fill_state").length, 1);
    const unsafe = sourceLayout(); unsafe.elements[2].fill = "url(https://bad.example/)";
    assert.throws(() => convert(unsafe, {targetSchemaVersion: schema}), /fill/);
  });
});


describe("opt-in physical GeoMoose text formatting", () => {
  it("preserves native baseline, fractional point size, exact RGB and remaining-page width in 1.3", () => {
    const source = sourceLayout(); source.elements[0].color = [33, 66, 99];
    const result = convert(source, {targetSchemaVersion: "opengeo.print-layout.1.3.0"});
    const parsed = parseSitePrintLayout(result.printLayout, new Set(["massgis-map"]));
    const title = parsed.pages[0].elements[0];
    assert.equal(title.fontSize, 18); assert.equal(title.color, "#214263");
    assert.deepEqual([title.x, title.y, title.width, title.height], [45, 53, 955, 40]);
    assert.equal(parsed.pages[0].elements.find(element => element.text?.startsWith("Printed")).fontSize, 13);
    assert(result.report.losses.some(loss => loss.code === "text_geometry_quantized"));
    assert(result.report.losses.some(loss => loss.code === "text_font_substituted"));
    assert(!result.report.losses.some(loss => loss.code === "text_style_coarsened"));
    assert.equal(parsed.pages[0].elements.filter(element => element.type === "shape_frame").length, 2);
    source.elements[0].size = 18.25;
    assert.equal(convert(source, {targetSchemaVersion: "opengeo.print-layout.1.3.0"}).printLayout.pages[0].elements[0].fontSize, 18.25);
    assert(!Object.hasOwn(convert(source).printLayout.pages[0].elements[0], "fontSize"));
    assert(!Object.hasOwn(convert(source, {targetSchemaVersion: "opengeo.print-layout.1.2.0"}).printLayout.pages[0].elements[0], "color"));
  });
  it("rejects native baselines above the page and overflowing text without clamping", () => {
    const source = sourceLayout(); source.elements[0].y = 0.01;
    assert.throws(() => convert(source, {targetSchemaVersion: "opengeo.print-layout.1.3.0"}), /text frame falls outside/);
    source.elements[0].y = 8.5;
    assert.throws(() => convert(source, {targetSchemaVersion: "opengeo.print-layout.1.3.0"}), /text frame falls outside/);
    source.elements[0].y = 0.7; source.elements[0].x = 10.99;
    assert.throws(() => convert(source, {targetSchemaVersion: "opengeo.print-layout.1.3.0"}), /text frame falls outside/);
  });
});
