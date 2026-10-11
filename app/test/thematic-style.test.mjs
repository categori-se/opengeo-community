import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  DEFAULT_GRADUATED_BREAKS,
  DEFAULT_GRADUATED_COLORS,
  DEFAULT_GRADUATED_NO_DATA_COLOR,
  graduatedColorExpression,
  graduatedLegendEntries,
  isSafeThematicFieldName,
  normalizeGraduatedStyle,
  numericPropertyFields
} from "../src/lib/thematicStyle.js";

describe("numeric graduated thematic styles", () => {
  it("discovers only consistently numeric, finite, safe property fields", () => {
    const geojson = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {
            population: 10,
            ratio: 0.25,
            mixed: 1,
            label: "North",
            empty: null,
            "unsafe field": 8,
            "safe.field": 3
          },
          geometry: null
        },
        {
          type: "Feature",
          properties: {
            population: 30,
            ratio: null,
            mixed: "2",
            empty: null,
            "safe.field": 4
          },
          geometry: null
        }
      ]
    };

    assert.deepEqual(numericPropertyFields(geojson), ["population", "ratio", "safe.field"]);
    assert.equal(isSafeThematicFieldName("population_2026"), true);
    assert.equal(isSafeThematicFieldName("constructor"), false);
    assert.equal(isSafeThematicFieldName("unsafe field"), false);
  });

  it("normalizes the default percentile breaks and accessible five-bin palette", () => {
    const normalized = normalizeGraduatedStyle({field: "population"});

    assert.deepEqual(normalized, {
      field: "population",
      breaks: [20, 40, 60, 80],
      colors: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"],
      noDataColor: "#9ca3af",
      noDataLabel: "No data"
    });
    assert.notEqual(normalized.breaks, DEFAULT_GRADUATED_BREAKS);
    assert.notEqual(normalized.colors, DEFAULT_GRADUATED_COLORS);
  });

  it("builds a typed MapLibre step expression with an explicit no-data result", () => {
    assert.deepEqual(
      graduatedColorExpression({field: "population"}, "#ffffff"),
      [
        "case",
        [
          "all",
          ["has", "population"],
          ["==", ["typeof", ["get", "population"]], "number"]
        ],
        [
          "step",
          ["get", "population"],
          "#440154",
          20,
          "#3b528b",
          40,
          "#21918c",
          60,
          "#5ec962",
          80,
          "#fde725"
        ],
        "#ffffff"
      ]
    );
    assert.equal(graduatedColorExpression({field: "population"}).at(-1), DEFAULT_GRADUATED_NO_DATA_COLOR);
  });

  it("uses each exact class break as the inclusive start of the next legend bin", () => {
    const style = {
      field: "percentile",
      breaks: [20, 40, 60, 80],
      colors: ["#111111", "#222222", "#333333", "#444444", "#555555"]
    };
    const step = graduatedColorExpression(style)[2];
    const legend = graduatedLegendEntries(style);

    assert.deepEqual(step.slice(3), [
      20, "#222222", 40, "#333333", 60, "#444444", 80, "#555555"
    ]);
    assert.deepEqual(legend.slice(0, 5).map(({minimum, maximum}) => [minimum, maximum]), [
      [null, 20], [20, 40], [40, 60], [60, 80], [80, null]
    ]);
  });

  it("returns range labels that match step thresholds plus a no-data row", () => {
    const entries = graduatedLegendEntries({
      field: "score",
      breaks: [-10, 0, 2.5, 9],
      colors: ["#111111", "#222222", "#333333", "#444444", "#555555"],
      noDataColor: "#abcdef",
      noDataLabel: "Unavailable"
    });

    assert.deepEqual(entries.map(({label, color, kind}) => ({label, color, kind})), [
      {kind: "range", color: "#111111", label: "< -10"},
      {kind: "range", color: "#222222", label: "-10 \u2013 < 0"},
      {kind: "range", color: "#333333", label: "0 \u2013 < 2.5"},
      {kind: "range", color: "#444444", label: "2.5 \u2013 < 9"},
      {kind: "range", color: "#555555", label: "\u2265 9"},
      {kind: "no-data", color: "#abcdef", label: "Unavailable"}
    ]);
    assert.deepEqual(entries[1], {
      kind: "range",
      color: "#222222",
      label: "-10 \u2013 < 0",
      minimum: -10,
      maximum: 0
    });
  });

  it("fails closed on unsafe fields, malformed breaks, and invalid colors", () => {
    assert.throws(() => normalizeGraduatedStyle({field: "__proto__.score"}), /field is invalid/);
    assert.throws(
      () => normalizeGraduatedStyle({field: "score", breaks: [20, 40, 40, 80]}),
      /strictly increasing/
    );
    assert.throws(
      () => normalizeGraduatedStyle({field: "score", breaks: [20, 40, Number.NaN, 80]}),
      /finite numbers/
    );
    assert.throws(
      () => normalizeGraduatedStyle({field: "score", colors: ["#000000"]}),
      /five colors/
    );
    assert.throws(
      () => normalizeGraduatedStyle({field: "score", noDataColor: "transparent"}),
      /no-data color is invalid/
    );
    assert.throws(
      () => graduatedColorExpression({field: "score"}, ["get", "color"]),
      /fallback color is invalid/
    );
  });

  it("rejects malformed feature records rather than exposing guessed fields", () => {
    assert.deepEqual(numericPropertyFields(null), []);
    assert.throws(() => numericPropertyFields({features: [{}]}), /properties/);
    assert.throws(() => numericPropertyFields({features: "many"}), /features array/);
  });
});
