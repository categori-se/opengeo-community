import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  HISTORICAL_IMAGERY_LIMITS,
  HISTORICAL_IMAGERY_SCHEMA_VERSION,
  expandDailyPeriods,
  fetchHistoricalAvailability,
  historicalImageryBasemap,
  historicalImageryForProject,
  historicalImageryForSave,
  resolveHistoricalSelection,
  reviewedHistoricalDates,
  reviewedHistoricalImagerySources,
  solarElevationAt,
  solarPosition,
  sunlightGuideGeojson
} from "../src/lib/historicalImagery.js";

describe("governed historical imagery contract", () => {
  it("publishes only reviewed credential-free NASA sources with immutable revisions", () => {
    const sources = reviewedHistoricalImagerySources();
    assert.equal(sources.length, 3);
    for (const source of sources) {
      assert.match(source.sourceId, /^nasa-gibs-/);
      assert.match(source.sourceRevision, /^gibs-epsg3857-/);
      assert.equal(source.authentication, "none");
      assert.equal(source.projection, "EPSG:3857");
      assert.match(source.capabilityDigest, /^sha256:[a-f0-9]{64}$/);
      assert.match(source.tileUrlTemplate, /^https:\/\/gibs\.earthdata\.nasa\.gov\//);
      assert.match(source.describeDomainsUrl, /^https:\/\/gibs\.earthdata\.nasa\.gov\//);
      assert.doesNotMatch(JSON.stringify(source), /token|secret|api[_ -]?key/i);
    }
  });

  it("expands daily periods within the requested bound and leaves visible gaps", () => {
    assert.deepEqual(expandDailyPeriods([
      "2026-08-01/2026-08-03/P1D",
      "2026-08-05"
    ], {startDate: "2026-08-01", endDate: "2026-08-05"}), [
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-05"
    ]);
    assert.throws(
      () => expandDailyPeriods(["2026-01-01/2026-08-01/P1D"], {
        startDate: "2026-01-01",
        endDate: "2026-08-01"
      }),
      ({code}) => code === "historical_window_limit"
    );
    assert.ok(reviewedHistoricalDates("nasa-gibs-modis-terra-true-color").length <= HISTORICAL_IMAGERY_LIMITS.maximumDates);
  });

  it("makes date adjustment policy explicit instead of silently snapping", () => {
    const availableDates = ["2026-08-01", "2026-08-03", "2026-08-07"];
    assert.deepEqual(resolveHistoricalSelection({
      requestedDate: "2026-08-02",
      availableDates,
      policy: "exact"
    }), {
      status: "unavailable",
      requestedDate: "2026-08-02",
      displayedDate: null,
      policy: "exact",
      reason: "no-exact-date"
    });
    assert.equal(resolveHistoricalSelection({requestedDate: "2026-08-02", availableDates, policy: "previous"}).displayedDate, "2026-08-01");
    assert.equal(resolveHistoricalSelection({requestedDate: "2026-08-02", availableDates, policy: "next"}).displayedDate, "2026-08-03");
    assert.equal(resolveHistoricalSelection({requestedDate: "2026-08-02", availableDates, policy: "nearest"}).displayedDate, "2026-08-01");
  });

  it("derives a runnable tile reference while persisting only reviewed source identity and date", () => {
    const selection = {
      status: "resolved",
      requestedDate: "2026-08-20",
      displayedDate: "2026-08-20",
      policy: "exact",
      reason: "exact"
    };
    const basemap = historicalImageryBasemap({
      sourceId: "nasa-gibs-hls-l30-nbar",
      sourceRevision: "gibs-epsg3857-2026-08-23",
      selection
    });
    assert.equal(basemap.kind, "temporal-raster");
    assert.match(basemap.url, /\/2026-08-20\/GoogleMapsCompatible_Level12\/\{z\}\/\{y\}\/\{x\}\.png$/);
    assert.equal(basemap.governance, undefined, "temporal source metadata must not impersonate ordinary basemap health governance");

    const saved = historicalImageryForSave({
      enabled: true,
      sourceId: basemap.sourceId,
      sourceRevision: basemap.sourceRevision,
      selection,
      sunlight: {enabled: true, dateTime: "2026-08-20T16:00:00Z"}
    });
    assert.equal(saved.schemaVersion, HISTORICAL_IMAGERY_SCHEMA_VERSION);
    assert.equal(saved.selection.displayedDate, "2026-08-20");
    assert.equal(saved.sunlight.enabled, true);
    assert.doesNotMatch(JSON.stringify(saved), /https?:\/\//);
    assert.deepEqual(historicalImageryForProject({extensions: {historicalImagery: saved}}), saved);
  });

  it("reads a bounded XML availability response with anonymous authority", async () => {
    const fetchCalls = [];
    const result = await fetchHistoricalAvailability("nasa-gibs-hls-s30-nbar", {
      startDate: "2026-08-19",
      endDate: "2026-08-23",
      fetchImpl: async (url, options) => {
        fetchCalls.push({url, options});
        return new Response(`<?xml version="1.0"?><Domains><DimensionDomain><Identifier>time</Identifier><Domain>2026-08-18/2026-08-20/P1D,2026-08-23</Domain><Size>2</Size></DimensionDomain></Domains>`, {
          status: 200,
          headers: {"content-type": "application/xml"}
        });
      }
    });
    assert.deepEqual(result.dates, ["2026-08-19", "2026-08-20", "2026-08-23"]);
    assert.equal(result.spatiallyConfirmed, false);
    assert.equal(fetchCalls[0].options.credentials, "omit");
    assert.equal(fetchCalls[0].options.redirect, "error");
    assert.equal(fetchCalls[0].options.headers.Authorization, undefined);
    const requestUrl = new URL(fetchCalls[0].url);
    assert.equal(requestUrl.pathname.endsWith("/wmts.cgi"), true);
    assert.equal(requestUrl.searchParams.get("REQUEST"), "DescribeDomains");
    assert.equal(requestUrl.searchParams.get("TIME"), "2026-08-19/2026-08-23");
  });

  it("rejects active XML and oversized provider responses", async () => {
    await assert.rejects(
      fetchHistoricalAvailability("nasa-gibs-modis-terra-true-color", {
        startDate: "2026-08-01",
        endDate: "2026-08-02",
        fetchImpl: async () => new Response("<!DOCTYPE x [<!ENTITY y SYSTEM 'file:///etc/passwd'>]><Value>2026-08-01</Value>", {
          status: 200,
          headers: {"content-type": "application/xml"}
        })
      }),
      ({code}) => code === "historical_xml_invalid"
    );
    await assert.rejects(
      fetchHistoricalAvailability("nasa-gibs-modis-terra-true-color", {
        startDate: "2026-08-01",
        endDate: "2026-08-02",
        fetchImpl: async () => new Response("x", {
          status: 200,
          headers: {
            "content-type": "application/xml",
            "content-length": String(HISTORICAL_IMAGERY_LIMITS.maximumResponseBytes + 1)
          }
        })
      }),
      ({code}) => code === "historical_response_limit"
    );
  });
});

describe("bounded sunlight guide", () => {
  it("places the equinox subsolar point near the equator and noon meridian", () => {
    const sun = solarPosition("2026-03-20T12:00:00Z");
    assert.ok(Math.abs(sun.subsolarLatitude) < 1);
    assert.ok(Math.abs(sun.subsolarLongitude) < 5);
    const local = solarElevationAt({
      longitude: sun.subsolarLongitude,
      latitude: sun.subsolarLatitude,
      dateTime: sun.dateTime
    });
    assert.ok(local.elevationDegrees > 89.9);
  });

  it("produces a finite terminator and labeled subsolar point", () => {
    const geojson = sunlightGuideGeojson("2026-08-20T16:00:00Z");
    assert.equal(geojson.features[0].geometry.type, "MultiLineString");
    assert.equal(geojson.features[1].properties.kind, "subsolar-point");
    assert.ok(geojson.features[0].geometry.coordinates.flat().length >= 180);
    assert.doesNotMatch(JSON.stringify(geojson), /NaN|Infinity/);
  });
});
