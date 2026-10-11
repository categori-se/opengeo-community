import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {describe, it} from "node:test";
import {gzipSync} from "node:zlib";
import {
  MASSGIS_ARCHIVE_BUCKET,
  MASSGIS_ARCHIVE_PREFIX,
  MASSGIS_ARCHIVE_REGION,
  MASSGIS_ATTRIBUTION,
  MASSGIS_FEATURE_LAYER_URL,
  loadMassgisDemoGeojson,
  loadMassgisReferenceGeojson,
  massgisArchiveUrl,
  massgisSourceFields,
  validateMassgisDemoConfig
} from "../src/lib/massgisDemo.js";

const CONFIG_URL = new URL("../src/data/massgis-enviroscreen.json", import.meta.url);
const CONFIG_TEXT = await readFile(CONFIG_URL, "utf8");
const CONFIG = JSON.parse(CONFIG_TEXT);
const REQUESTED_FIELDS = massgisSourceFields(CONFIG);
const RENDERING_FIELDS = new Set([
  ...CONFIG.indicatorGroups.flatMap(({maps}) => maps.map(({style}) => style.field)),
  ...CONFIG.combinedAnalysis.layers.map(({style}) => style.field)
]);

describe("MassGIS MassEnviroScreen demo model", () => {
  it("pins one public-domain collection, five groups, 30 map views, and one shared-source analysis", () => {
    const model = validateMassgisDemoConfig(CONFIG);
    assert.equal(Object.isFrozen(model), true);
    assert.equal(model.collection.attribution, MASSGIS_ATTRIBUTION);
    assert.deepEqual(model.collection.license, {
      name: "LicenseRef-Public-Domain",
      url: "https://www.mass.gov/info-details/massgis-frequently-asked-questions"
    });
    assert.equal(model.collection.officialUrls.item.includes("66f096c285bd4642aca21f64fa86e74f"), true);
    assert.equal(model.collection.officialUrls.service, MASSGIS_FEATURE_LAYER_URL);
    assert.deepEqual(model.collection.version, {
      documentationPublishedDate: "2026-05-08",
      serviceDataLastEditedDate: "2026-04-18",
      serviceSchemaLastEditedDate: "2026-05-05"
    });
    assert.equal(model.collection.limitations.some((item) => item.includes("5,116") && item.includes("5,109")), true);
    assert.equal(model.collection.limitations.some((item) => item.includes("item-specific") && item.includes("blank")), true);
    assert.equal(model.sources.length, 1);
    assert.equal(model.sources[0].itemId, "66f096c285bd4642aca21f64fa86e74f");
    assert.equal(model.sources[0].layerUrl, MASSGIS_FEATURE_LAYER_URL);
    assert.equal(model.schemaVersion, "opengeo.massgis-enviroscreen-demo.1.3.0");
    assert.deepEqual(model.project, {
      id: "public-massgis-massenviroscreen",
      title: "MassGIS · MassEnviroScreen",
      summary: "A dedicated public project with thirty independently styled screening maps and one combined analysis over one shared, versioned MassGIS dataset.",
      visibility: "public",
      organization: "public",
      sourceIds: ["massgis-massenviroscreen-feature-layer"],
      presentationCount: 31
    });
    assert.deepEqual(model.sources[0].archive, {
      schemaVersion: "opengeo.reference-archive.1.1.0",
      bucket: MASSGIS_ARCHIVE_BUCKET,
      region: MASSGIS_ARCHIVE_REGION,
      filename: "massgis-massenviroscreen-2026-04-18-72003a49bbd9.geojson.gz",
      objectKey: "usa/ma/opengeo/reference-archives/massgis/massenviroscreen/2026-04-18/72003a49bbd98780cd4ae6767cb4b45b0951d0f921a5c0e80830db3a2d89dc11/massgis-massenviroscreen-2026-04-18-72003a49bbd9.geojson.gz",
      storageUri: "s3://example-geodata/usa/ma/opengeo/reference-archives/massgis/massenviroscreen/2026-04-18/72003a49bbd98780cd4ae6767cb4b45b0951d0f921a5c0e80830db3a2d89dc11/massgis-massenviroscreen-2026-04-18-72003a49bbd9.geojson.gz",
      retrievedAt: "2026-08-29T00:16:17.865Z",
      sourceDataLastEditedDate: "2026-04-18",
      pageCount: 6,
      featureCount: 5109,
      uncompressedBytes: 12430713,
      uncompressedSha256: "72003a49bbd98780cd4ae6767cb4b45b0951d0f921a5c0e80830db3a2d89dc11",
      compressedBytes: 2944146,
      compressedSha256: "7e280ab1f9ea003ebf699526d281938182214c2c4acce42524da956e58049bb2"
    });
    assert.deepEqual(model.stylePresets.map(({classification, breaks, colors}) => ({
      classification,
      breaks,
      colorCount: colors.length
    })), Array.from({length: 4}, () => ({
      classification: "step",
      breaks: [20, 40, 60, 80],
      colorCount: 5
    })));
    assert.deepEqual(model.indicatorGroups.map(({slug, maps}) => [slug, maps.length]), [
      ["environmental-exposures", 8],
      ["environmental-effects", 5],
      ["climate-risks", 4],
      ["sensitive-populations", 8],
      ["socioeconomic-factors", 5]
    ]);
    const maps = model.indicatorGroups.flatMap(({maps}) => maps);
    assert.equal(maps.length, 30);
    assert.equal(new Set(maps.map(({slug}) => slug)).size, 30);
    assert.equal(maps.find(({slug}) => slug === "wildfire-risk").style.field, "CLIMpctilFIRE");
    assert.deepEqual(model.combinedAnalysis.layers.map(({style}) => style.field), [
      "MassEnviroScore",
      "PollutionBurden",
      "PopCharacteristics"
    ]);
    assert.equal(new Set(model.combinedAnalysis.layers.map(({sourceId}) => sourceId)).size, 1);
    assert.equal(CONFIG_TEXT.includes("PollutionBurden100"), false);
    assert.equal(CONFIG_TEXT.includes("PopCharacteristics100"), false);
    assert.equal(CONFIG_TEXT.includes("CLIMpctilWHP"), false);
  });

  it("derives a bounded out-field allowlist from identity, raw, style, and analysis fields", () => {
    const fields = massgisSourceFields(CONFIG);
    assert.equal(Object.isFrozen(fields), true);
    assert.equal(fields.length, 67);
    for (const field of [
      "OBJECTID", "GEOID", "NAME", "COSUB", "AnnFreqWeight", "CLIMpctilFIRE",
      "MassEnviroScore", "PollutionBurden", "PopCharacteristics"
    ]) assert.equal(fields.includes(field), true, field);
    for (const field of ["CLIMpctilWHP", "PollutionBurden100", "PopCharacteristics100"]) {
      assert.equal(fields.includes(field), false, field);
    }
  });

  it("rejects schema widening, stale sources, altered rights, false fields, and incomplete map sets", () => {
    const mutations = [
      (value) => { value.extra = true; },
      (value) => { value.collection.attribution = "MassGIS"; },
      (value) => { value.collection.license.name = "CC0-1.0"; },
      (value) => { value.collection.officialUrls.item = "https://www.arcgis.com/"; },
      (value) => { value.collection.version.serviceDataLastEditedDate = "2025-12-01"; },
      (value) => { value.sources[0].layerUrl = "https://services1.arcgis.com/7iJyYTjCtKsZS1LR/ArcGIS/rest/services/MassEnviroScreen/FeatureServer/0"; },
      (value) => { value.sources[0].itemId = "f433d783af924b62824c7c5d76f97523"; },
      (value) => { value.sources[0].archive.compressedSha256 = "0".repeat(63); },
      (value) => { value.sources[0].archive.objectKey = "reference-archives/changed"; },
      (value) => { value.sources[0].archive.bucket = "another-bucket"; },
      (value) => { value.project.visibility = "internal"; },
      (value) => { value.indicatorGroups[0].maps.pop(); },
      (value) => { value.indicatorGroups[1].maps[0].slug = "groundwater-threats"; },
      (value) => { value.indicatorGroups[2].maps[1].style.field = "CLIMpctilWHP"; },
      (value) => { value.indicatorGroups[2].maps[1].style.unreviewed = true; },
      (value) => { value.combinedAnalysis.layers[1].style.field = "PollutionBurden100"; },
      (value) => { value.combinedAnalysis.layers[2].sourceId = "another-source"; },
      (value) => { value.viewConfigurations[0].center[0] = 181; },
      (value) => { value.stylePresets[0].classification = "continuous"; },
      (value) => { value.stylePresets[0].breaks = [25, 50, 75, 100]; },
      (value) => { value.stylePresets[0].breaks = [20, "40", 60, 80]; },
      (value) => { value.stylePresets[0].colors.pop(); }
    ];
    for (const mutate of mutations) {
      const value = clone(CONFIG);
      mutate(value);
      assert.throws(() => validateMassgisDemoConfig(value), {code: "massgis_demo_invalid"});
    }
  });
});

describe("anonymous MassGIS ArcGIS GeoJSON loader", () => {
  it("verifies and loads the complete immutable archive before consulting the live service", async () => {
    const {archive, config} = archiveFixture();
    const requests = [];
    const result = await loadMassgisReferenceGeojson(config, {
      archiveUrl: massgisArchiveUrl(config),
      archiveRequired: true,
      fetchImpl: async (url, options) => {
        requests.push({url, options});
        return new Response(archive, {status: 200, headers: {"content-type": "application/gzip"}});
      }
    });

    assert.equal(result.features.length, 25);
    assert.equal(result.opengeo.sourceMode, "aws-archive");
    assert.equal(result.opengeo.authoritativeUrl, MASSGIS_FEATURE_LAYER_URL);
    assert.equal(result.opengeo.archiveSha256, config.sources[0].archive.uncompressedSha256);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.credentials, "omit");
    assert.equal(requests[0].options.redirect, "error");
    assert.equal(requests[0].options.mode, "cors");
    assert.equal(requests[0].url, massgisArchiveUrl(config));
  });

  it("paginates deterministically and sends a no-credential, no-redirect CORS request", async () => {
    const calls = [];
    const pages = [
      featureCollection([feature(1), feature(2)], {nestedExceeded: true}),
      featureCollection([feature(3)], {exceeded: false})
    ];
    pages[0].crs = {type: "name", properties: {name: "EPSG:4326"}};
    const result = await loadMassgisDemoGeojson(CONFIG, {
      pageSize: 2,
      maximumFeatures: 5,
      fetchImpl: async (url, options) => {
        calls.push({url, options});
        return jsonResponse(pages.shift());
      }
    });

    assert.equal(result.type, "FeatureCollection");
    assert.deepEqual(result.features.map(({properties}) => properties.OBJECTID), [1, 2, 3]);
    assert.deepEqual(result.opengeo, {
      schemaVersion: "opengeo.massgis-geojson-receipt.1.0.0",
      itemId: "66f096c285bd4642aca21f64fa86e74f",
      sourceId: "massgis-massenviroscreen-feature-layer",
      layerUrl: MASSGIS_FEATURE_LAYER_URL,
      attribution: MASSGIS_ATTRIBUTION,
      pageCount: 2,
      featureCount: 3,
      responseBytes: result.opengeo.responseBytes,
      outSpatialReference: 4326,
      fields: result.opengeo.fields,
      requestedFields: result.opengeo.requestedFields,
      observedFields: result.opengeo.observedFields
    });
    assert.equal(result.opengeo.responseBytes > 0, true);
    assert.equal(Object.isFrozen(result.opengeo.fields), true);
    assert.equal(Object.isFrozen(result.opengeo.requestedFields), true);
    assert.equal(Object.isFrozen(result.opengeo.observedFields), true);
    assert.equal(result.opengeo.fields, result.opengeo.requestedFields);
    assert.notEqual(result.opengeo.requestedFields, result.opengeo.observedFields);
    assert.deepEqual(result.opengeo.requestedFields, REQUESTED_FIELDS);
    assert.deepEqual(result.opengeo.observedFields, REQUESTED_FIELDS);
    assert.equal(calls.length, 2);

    const first = new URL(calls[0].url);
    const second = new URL(calls[1].url);
    assert.equal(`${first.origin}${first.pathname}`, `${MASSGIS_FEATURE_LAYER_URL}/query`);
    assert.equal(first.searchParams.get("where"), "1=1");
    assert.equal(first.searchParams.get("f"), "geojson");
    assert.equal(first.searchParams.get("outSR"), "4326");
    assert.equal(first.searchParams.get("geometryPrecision"), "5");
    assert.equal(first.searchParams.get("orderByFields"), "OBJECTID ASC");
    assert.equal(first.searchParams.get("resultOffset"), "0");
    assert.equal(second.searchParams.get("resultOffset"), "2");
    assert.equal(first.searchParams.get("resultRecordCount"), "2");
    assert.equal(second.searchParams.get("resultRecordCount"), "2");
    const outFields = first.searchParams.get("outFields").split(",");
    assert.equal(outFields.includes("CLIMpctilFIRE"), true);
    assert.equal(outFields.includes("PollutionBurden"), true);
    assert.equal(outFields.includes("PollutionBurden100"), false);
    assert.equal([...first.searchParams.keys()].some((key) => /token|key|secret|signature/i.test(key)), false);
    for (const {options} of calls) {
      assert.equal(options.method, "GET");
      assert.equal(options.mode, "cors");
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      assert.equal(options.referrerPolicy, "no-referrer");
      assert.equal(options.cache, "no-store");
      assert.equal(options.headers.accept, "application/geo+json, application/json;q=0.9");
      assert.equal(Object.keys(options.headers).some((key) => /authorization|cookie/i.test(key)), false);
      assert.equal(options.signal instanceof AbortSignal, true);
    }
  });

  it("continues full pages without a transfer flag and stops on a short page", async () => {
    const pages = [
      featureCollection([feature(1), feature(2)]),
      featureCollection([feature(3)])
    ];
    let calls = 0;
    const result = await loadMassgisDemoGeojson(CONFIG, {
      pageSize: 2,
      maximumFeatures: 5,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(pages.shift());
      }
    });
    assert.equal(calls, 2);
    assert.equal(result.features.length, 3);
  });

  it("rejects an empty statewide result and any feature missing a requested field", async () => {
    await assert.rejects(loadMassgisDemoGeojson(CONFIG, {
      maximumFeatures: 5,
      fetchImpl: async () => jsonResponse(featureCollection([]))
    }), /statewide response contained no features/);

    const missingRenderingField = feature(1);
    delete missingRenderingField.properties.EXPpctilePM25;
    await assert.rejects(loadMassgisDemoGeojson(CONFIG, {
      maximumFeatures: 5,
      fetchImpl: async () => jsonResponse(featureCollection([missingRenderingField]))
    }), /property EXPpctilePM25 is missing/);

    const missingRawField = feature(1);
    delete missingRawField.properties.PM25;
    await assert.rejects(loadMassgisDemoGeojson(CONFIG, {
      maximumFeatures: 5,
      fetchImpl: async () => jsonResponse(featureCollection([missingRawField]))
    }), /property PM25 is missing/);
  });

  it("accepts documented nullable fields and rejects unsafe rendering or raw-source values", async () => {
    const nullable = feature(1, {
      GEOID: null,
      NAME: null,
      COSUB: null,
      EXPpctilePM25: null,
      PM25: null
    });
    const accepted = await loadMassgisDemoGeojson(CONFIG, {
      maximumFeatures: 5,
      fetchImpl: async () => jsonResponse(featureCollection([nullable]))
    });
    assert.equal(accepted.features[0].properties.EXPpctilePM25, null);

    for (const [field, value] of [
      ["EXPpctilePM25", "50"],
      ["EXPpctilePM25", -0.01],
      ["MassEnviroScore", 100.01]
    ]) {
      await assert.rejects(loadMassgisDemoGeojson(CONFIG, {
        maximumFeatures: 5,
        fetchImpl: async () => jsonResponse(featureCollection([feature(1, {[field]: value})]))
      }), new RegExp(`rendering property ${field}.*0 through 100`));
    }

    for (const value of [{nested: true}, "x".repeat(4_097), Number.MAX_VALUE]) {
      await assert.rejects(loadMassgisDemoGeojson(CONFIG, {
        maximumFeatures: 5,
        fetchImpl: async () => jsonResponse(featureCollection([feature(1, {PM25: value})]))
      }), /raw source property PM25 is invalid/);
    }

    const nonfiniteBody = JSON.stringify(featureCollection([feature(1)]))
      .replace('"EXPpctilePM25":50', '"EXPpctilePM25":1e400');
    await assert.rejects(loadMassgisDemoGeojson(CONFIG, {
      maximumFeatures: 5,
      fetchImpl: async () => rawJsonResponse(nonfiniteBody)
    }), /rendering property EXPpctilePM25.*finite number.*0 through 100/);
  });

  it("rejects unsafe loader limits and unknown loader options before the network", async () => {
    const badOptions = [
      {pageSize: 0},
      {pageSize: 2_001},
      {pageSize: 1, maximumFeatures: 100},
      {maximumFeatures: 10_001},
      {maximumResponseBytes: 1_023},
      {maximumResponseBytes: 2_048, maximumTotalResponseBytes: 1_024},
      {timeoutMilliseconds: 60_001},
      {signal: {aborted: false, addEventListener() {}}},
      {authorization: "secret"}
    ];
    for (const options of badOptions) {
      let called = false;
      await assert.rejects(loadMassgisDemoGeojson(CONFIG, {
        ...options,
        fetchImpl: async () => {
          called = true;
          return jsonResponse(featureCollection([]));
        }
      }), {code: "massgis_demo_invalid"});
      assert.equal(called, false);
    }
  });

  it("rejects HTTP, media-type, ArcGIS-error, byte-limit, and response-shape failures", async () => {
    const malformedBodies = [
      {body: {error: {code: 400, message: "bad query"}}, message: /ArcGIS error/},
      {body: {type: "FeatureCollection", features: [], secret: true}, message: /unexpected field/},
      {body: {type: "Feature", features: []}, message: /FeatureCollection/},
      {body: {...featureCollection([]), crs: {type: "name", properties: {name: "EPSG:3857"}}}, message: /must be EPSG:4326/},
      {body: {...featureCollection([]), crs: {type: "name", properties: {name: "EPSG:4326", token: "secret"}}}, message: /unexpected field/},
      {body: featureCollection([{...feature(1), properties: {OBJECTID: 1, TOKEN: "secret"}}]), message: /property TOKEN/},
      {body: featureCollection([{...feature(1), properties: {NAME: "missing id"}}]), message: /object id is missing/},
      {body: featureCollection([{...feature(1), geometry: {type: "Point", coordinates: [-71, 42]}}]), message: /Polygon or MultiPolygon/},
      {body: featureCollection([{...feature(1), geometry: null}]), message: /Polygon or MultiPolygon/},
      {body: featureCollection([{...feature(1), geometry: {type: "Polygon", coordinates: [[[-71, 42], [-70, 42], [-70, 43], [-71, 43]]]}}]), message: /not closed/}
    ];
    for (const {body, message} of malformedBodies) {
      await assert.rejects(loadMassgisDemoGeojson(CONFIG, {
        maximumFeatures: 5,
        fetchImpl: async () => jsonResponse(body)
      }), message);
    }

    await assert.rejects(loadMassgisDemoGeojson(CONFIG, {
      maximumFeatures: 5,
      fetchImpl: async () => jsonResponse(featureCollection([]), {status: 503})
    }), /HTTP 503/);
    await assert.rejects(loadMassgisDemoGeojson(CONFIG, {
      maximumFeatures: 5,
      fetchImpl: async () => jsonResponse(featureCollection([]), {contentType: "text/html"})
    }), /content type/);
    await assert.rejects(loadMassgisDemoGeojson(CONFIG, {
      maximumFeatures: 5,
      maximumResponseBytes: 1_024,
      fetchImpl: async () => jsonResponse(featureCollection([]), {headers: {"content-length": "2048"}})
    }), /per-page byte limit/);
    await assert.rejects(loadMassgisDemoGeojson(CONFIG, {
      maximumFeatures: 5,
      maximumResponseBytes: 1_024,
      fetchImpl: async () => jsonResponse(featureCollection([feature(1, {NAME: "x".repeat(2_000)})]))
    }), /per-page byte limit/);
  });

  it("rejects duplicate ids, stalled pagination, uncertain truncation, and an aggregate byte overrun", async () => {
    await assert.rejects(runPages([
      featureCollection([feature(1), feature(2)], {exceeded: true}),
      featureCollection([feature(2)], {exceeded: false})
    ], {pageSize: 2, maximumFeatures: 5}), /repeated an object id/);

    await assert.rejects(runPages([
      featureCollection([], {exceeded: true})
    ], {pageSize: 2, maximumFeatures: 5}), /made no progress/);

    await assert.rejects(runPages([
      featureCollection([feature(1), feature(2)], {exceeded: true})
    ], {pageSize: 2, maximumFeatures: 2}), /may exceed the configured feature-count limit/);

    await assert.rejects(runPages([
      featureCollection([feature(1, {NAME: "x".repeat(200)})], {exceeded: true}),
      featureCollection([feature(2, {NAME: "y".repeat(200)})], {exceeded: false})
    ], {
      pageSize: 1,
      maximumFeatures: 3,
      maximumResponseBytes: 2_048,
      maximumTotalResponseBytes: 2_048
    }), /total byte limit/);
  });

  it("enforces timeout and caller cancellation even when the injected fetch ignores its signal", async () => {
    await assert.rejects(loadMassgisDemoGeojson(CONFIG, {
      timeoutMilliseconds: 5,
      maximumFeatures: 5,
      fetchImpl: () => new Promise(() => {})
    }), {code: "massgis_request_timeout"});

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(loadMassgisDemoGeojson(CONFIG, {
      signal: controller.signal,
      maximumFeatures: 5,
      fetchImpl: () => new Promise(() => {})
    }), (error) => error.name === "AbortError" && error.code === "massgis_request_cancelled");
  });
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function archiveFixture() {
  const config = clone(CONFIG);
  const raw = Buffer.from(JSON.stringify(featureCollection(
    Array.from({length: 25}, (_, index) => feature(index + 1))
  )));
  const archive = gzipSync(raw, {level: 9, mtime: 0});
  const uncompressedSha256 = createHash("sha256").update(raw).digest("hex");
  const compressedSha256 = createHash("sha256").update(archive).digest("hex");
  const filename = `massgis-massenviroscreen-2026-04-18-${uncompressedSha256.slice(0, 12)}.geojson.gz`;
  const objectKey = `${MASSGIS_ARCHIVE_PREFIX}/2026-04-18/${uncompressedSha256}/${filename}`;
  config.sources[0].archive = {
    schemaVersion: "opengeo.reference-archive.1.1.0",
    bucket: MASSGIS_ARCHIVE_BUCKET,
    region: MASSGIS_ARCHIVE_REGION,
    filename,
    objectKey,
    storageUri: `s3://${MASSGIS_ARCHIVE_BUCKET}/${objectKey}`,
    retrievedAt: "2026-08-29T00:16:17.865Z",
    sourceDataLastEditedDate: "2026-04-18",
    pageCount: 1,
    featureCount: 25,
    uncompressedBytes: raw.byteLength,
    uncompressedSha256,
    compressedBytes: archive.byteLength,
    compressedSha256
  };
  return {archive, config};
}

function feature(objectId, properties = {}) {
  const shift = objectId / 1_000;
  const defaults = Object.fromEntries(REQUESTED_FIELDS.map((field) => {
    if (field === "OBJECTID") return [field, objectId];
    if (field === "GEOID") return [field, `25000000000${objectId}`];
    if (field === "NAME") return [field, `Block Group ${objectId}`];
    if (field === "COSUB") return [field, "Example subdivision"];
    return [field, RENDERING_FIELDS.has(field) ? 50 : 1];
  }));
  return {
    type: "Feature",
    properties: {...defaults, ...properties},
    geometry: {
      type: "Polygon",
      coordinates: [[
        [-71 + shift, 42],
        [-70.9 + shift, 42],
        [-70.9 + shift, 42.1],
        [-71 + shift, 42]
      ]]
    }
  };
}

function featureCollection(features, {exceeded, nestedExceeded} = {}) {
  return {
    type: "FeatureCollection",
    features,
    ...(exceeded === undefined ? {} : {exceededTransferLimit: exceeded}),
    ...(nestedExceeded === undefined ? {} : {properties: {exceededTransferLimit: nestedExceeded}})
  };
}

function jsonResponse(value, {status = 200, contentType = "application/geo+json; charset=utf-8", headers = {}} = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {"content-type": contentType, ...headers}
  });
}

function rawJsonResponse(value, {status = 200, contentType = "application/geo+json; charset=utf-8"} = {}) {
  return new Response(value, {
    status,
    headers: {"content-type": contentType}
  });
}

async function runPages(pages, options) {
  return loadMassgisDemoGeojson(CONFIG, {
    ...options,
    fetchImpl: async () => jsonResponse(pages.shift())
  });
}
