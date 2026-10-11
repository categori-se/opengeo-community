import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  LIVE_FEATURE_SOURCE_LIMITS,
  LiveFeatureSourceError,
  buildLiveFeatureRequest,
  loadLiveFeaturePage,
  parseLiveFeatureCollection
} from "../src/lib/liveFeatureSource.js";

const ARCGIS_URL = "https://services.example.test/arcgis/rest/services/environment/FeatureServer/4";
const WFS_URL = "https://features.example.test/geoserver/wfs";
const BOUNDS = [-73.6, 41.1, -69.7, 43];
const ARCGIS_CONFIGURATION = Object.freeze({
  attribution: "Example authority",
  fields: ["OBJECTID", "NAME", "SCORE"],
  geometryType: "Polygon",
  objectIdField: "OBJECTID",
  pageSize: 500
});
const WFS_CONFIGURATION = Object.freeze({
  attribution: null,
  fields: ["sample_id", "name"],
  geometryName: "geom",
  geometryType: "Point",
  pageSize: 250,
  sortBy: "sample_id",
  typeName: "water:samples",
  version: "2.0.0"
});

it("promotes a single polygon into a declared multipart collection without changing its rings", () => {
  const request = buildLiveFeatureRequest({sourceType: "arcgis", url: ARCGIS_URL,
    configuration: {...ARCGIS_CONFIGURATION, geometryType: "MultiPolygon"}, bounds: BOUNDS});
  const input = polygonCollection();
  const result = parseLiveFeatureCollection(new TextEncoder().encode(JSON.stringify(input)), request.contract);
  assert.equal(result.collection.features[0].geometry.type, "MultiPolygon");
  assert.deepEqual(result.collection.features[0].geometry.coordinates, [input.features[0].geometry.coordinates]);
  input.features[0].geometry = {type: "Point", coordinates: [90, 27]};
  assert.throws(() => parseLiveFeatureCollection(new TextEncoder().encode(JSON.stringify(input)), request.contract), /shape/);
  const single = buildLiveFeatureRequest({sourceType: "arcgis", url: ARCGIS_URL,
    configuration: ARCGIS_CONFIGURATION, bounds: BOUNDS});
  const invalid = polygonCollection();
  delete invalid.features[0].geometry.type;
  assert.throws(() => parseLiveFeatureCollection(new TextEncoder().encode(JSON.stringify(invalid)), single.contract), /shape/);
});

function polygonCollection({features = 1, provider = {}} = {}) {
  return {
    type: "FeatureCollection",
    ...provider,
    features: Array.from({length: features}, (_, index) => ({
      type: "Feature",
      id: index + 1,
      properties: {OBJECTID: index + 1, NAME: `Area ${index + 1}`, SCORE: 72},
      geometry: {
        type: "Polygon",
        coordinates: [[[-71.2, 42.1], [-71.1, 42.1], [-71.1, 42.2], [-71.2, 42.1]]]
      }
    }))
  };
}

function pointCollection({provider = {}} = {}) {
  return {
    type: "FeatureCollection",
    ...provider,
    features: [{
      type: "Feature",
      id: "samples.1",
      properties: {sample_id: "one", name: "Harbor"},
      geometry: {type: "Point", coordinates: [-71.05, 42.35]}
    }]
  };
}

function jsonResponse(value, {url, status = 200, mediaType = "application/geo+json", length} = {}) {
  const body = new TextEncoder().encode(JSON.stringify(value));
  return {
    status,
    redirected: false,
    url: url ?? "",
    headers: {
      get(name) {
        if (name.toLowerCase() === "content-type") return mediaType;
        if (name.toLowerCase() === "content-length") return String(length ?? body.byteLength);
        return null;
      }
    },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
  };
}

function errorCode(code) {
  return (error) => error instanceof LiveFeatureSourceError && error.code === code;
}

describe("bounded live feature source pages", () => {
  it("constructs one deterministic ArcGIS visible-extent query", () => {
    const request = buildLiveFeatureRequest({
      sourceType: "arcgis",
      url: ARCGIS_URL,
      configuration: ARCGIS_CONFIGURATION,
      bounds: BOUNDS
    });
    const parsed = new URL(request.url);

    assert.equal(parsed.origin + parsed.pathname, `${ARCGIS_URL}/query`);
    assert.deepEqual(Object.fromEntries(parsed.searchParams), {
      f: "geojson",
      where: "1=1",
      geometry: "-73.6,41.1,-69.7,43",
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outSR: "4326",
      outFields: "OBJECTID,NAME,SCORE",
      orderByFields: "OBJECTID ASC",
      resultOffset: "0",
      resultRecordCount: "500",
      returnGeometry: "true",
      returnExceededLimitFeatures: "true"
    });
    assert.deepEqual(request.contract.bounds, BOUNDS);
  });

  it("constructs one deterministic WFS 2.0 CRS84 page", () => {
    const request = buildLiveFeatureRequest({
      sourceType: "wfs",
      url: WFS_URL,
      configuration: WFS_CONFIGURATION,
      bounds: BOUNDS
    });
    const parsed = new URL(request.url);

    assert.equal(parsed.origin + parsed.pathname, WFS_URL);
    assert.deepEqual(Object.fromEntries(parsed.searchParams), {
      SERVICE: "WFS",
      VERSION: "2.0.0",
      REQUEST: "GetFeature",
      TYPENAMES: "water:samples",
      SRSNAME: "urn:ogc:def:crs:OGC::CRS84",
      BBOX: "-73.6,41.1,-69.7,43,urn:ogc:def:crs:OGC::CRS84",
      COUNT: "250",
      STARTINDEX: "0",
      SORTBY: "sample_id A",
      OUTPUTFORMAT: "application/json",
      PROPERTYNAME: "geom,sample_id,name"
    });
  });

  it("omits browser authority and returns a non-enumerable bounded receipt", async () => {
    const expected = buildLiveFeatureRequest({
      sourceType: "arcgis",
      url: ARCGIS_URL,
      configuration: ARCGIS_CONFIGURATION,
      bounds: BOUNDS
    });
    let observed;
    const collection = await loadLiveFeaturePage({
      sourceType: "arcgis",
      url: ARCGIS_URL,
      configuration: ARCGIS_CONFIGURATION,
      bounds: BOUNDS,
      fetchImpl: async (...request) => {
        observed = request;
        return jsonResponse(polygonCollection({
          provider: {exceededTransferLimit: true}
        }), {url: expected.url});
      }
    });

    assert.equal(observed[0], expected.url);
    assert.deepEqual(observed[1].headers, {accept: "application/geo+json, application/json;q=0.9"});
    assert.equal(observed[1].credentials, "omit");
    assert.equal(observed[1].redirect, "error");
    assert.equal(observed[1].referrerPolicy, "no-referrer");
    assert.equal(observed[1].cache, "no-store");
    assert.deepEqual(Object.keys(collection), ["type", "features"]);
    assert.deepEqual(collection.opengeo, {
      schemaVersion: "opengeo.live-feature-page.1.0.0",
      sourceType: "arcgis",
      sourceMode: "anonymous-direct-browser",
      bounds: BOUNDS,
      numberReturned: 1,
      numberMatched: null,
      mayBeTruncated: true,
      requestCount: 1,
      maximumBytes: LIVE_FEATURE_SOURCE_LIMITS.maximumBytes,
      maximumFeatures: 500
    });
  });

  it("preserves only reviewed WFS fields and reports provider truncation", async () => {
    const expected = buildLiveFeatureRequest({
      sourceType: "wfs",
      url: WFS_URL,
      configuration: WFS_CONFIGURATION,
      bounds: BOUNDS
    });
    const collection = await loadLiveFeaturePage({
      sourceType: "wfs",
      url: WFS_URL,
      configuration: WFS_CONFIGURATION,
      bounds: BOUNDS,
      fetchImpl: async () => jsonResponse(pointCollection({
        provider: {numberMatched: "12", numberReturned: 1}
      }), {url: expected.url, mediaType: "application/json; charset=utf-8"})
    });

    assert.deepEqual(collection.features[0].properties, {sample_id: "one", name: "Harbor"});
    assert.equal(collection.opengeo.numberMatched, 12);
    assert.equal(collection.opengeo.mayBeTruncated, true);
  });

  it("rejects unsafe endpoints and contract drift before fetching", async () => {
    for (const url of [
      "http://services.example.test/FeatureServer/4",
      "https://localhost/FeatureServer/4",
      "https://127.0.0.1/FeatureServer/4",
      `${ARCGIS_URL}?token=secret`,
      "https://user:secret@services.example.test/FeatureServer/4",
      "https://services.example.test/FeatureServer"
    ]) {
      await assert.rejects(loadLiveFeaturePage({
        sourceType: "arcgis",
        url,
        configuration: ARCGIS_CONFIGURATION,
        bounds: BOUNDS,
        fetchImpl: async () => assert.fail("unsafe endpoint reached fetch")
      }), errorCode("invalid_contract"));
    }
    await assert.rejects(loadLiveFeaturePage({
      sourceType: "wfs",
      url: WFS_URL,
      configuration: {...WFS_CONFIGURATION, password: "never accepted"},
      bounds: BOUNDS,
      fetchImpl: async () => assert.fail("drifted contract reached fetch")
    }), errorCode("invalid_contract"));
  });

  it("rejects redirects, wrong media, declared oversize, and inconsistent counts", async () => {
    const request = buildLiveFeatureRequest({
      sourceType: "arcgis", url: ARCGIS_URL, configuration: ARCGIS_CONFIGURATION, bounds: BOUNDS
    });
    const base = {sourceType: "arcgis", url: ARCGIS_URL, configuration: ARCGIS_CONFIGURATION, bounds: BOUNDS};
    await assert.rejects(loadLiveFeaturePage({
      ...base,
      fetchImpl: async () => jsonResponse(polygonCollection(), {url: `${request.url}&redirected=true`})
    }), errorCode("redirect_rejected"));
    await assert.rejects(loadLiveFeaturePage({
      ...base,
      fetchImpl: async () => jsonResponse(polygonCollection(), {url: request.url, mediaType: "text/html"})
    }), errorCode("response_media_rejected"));
    await assert.rejects(loadLiveFeaturePage({
      ...base,
      fetchImpl: async () => jsonResponse(polygonCollection(), {
        url: request.url,
        length: LIVE_FEATURE_SOURCE_LIMITS.maximumBytes + 1
      })
    }), errorCode("response_too_large"));
    await assert.rejects(loadLiveFeaturePage({
      ...base,
      fetchImpl: async () => jsonResponse(polygonCollection({provider: {numberReturned: 2}}), {url: request.url})
    }), errorCode("response_invalid"));
  });

  it("rejects unreviewed fields, duplicate identities, wrong geometry, and non-WGS84 coordinates", () => {
    const contract = buildLiveFeatureRequest({
      sourceType: "arcgis", url: ARCGIS_URL, configuration: ARCGIS_CONFIGURATION, bounds: BOUNDS
    }).contract;
    const unexpected = polygonCollection();
    unexpected.features[0].properties.secret = "not selected";
    assert.throws(() => parseLiveFeatureCollection(JSON.stringify(unexpected), contract), errorCode("response_invalid"));

    const duplicate = polygonCollection({features: 2});
    duplicate.features[1].properties.OBJECTID = 1;
    assert.throws(() => parseLiveFeatureCollection(JSON.stringify(duplicate), contract), errorCode("response_invalid"));

    const geometry = polygonCollection();
    geometry.features[0].geometry = {type: "Point", coordinates: [-71, 42]};
    assert.throws(() => parseLiveFeatureCollection(JSON.stringify(geometry), contract), errorCode("response_invalid"));

    const longitude = polygonCollection();
    longitude.features[0].geometry.coordinates[0][0][0] = 181;
    assert.throws(() => parseLiveFeatureCollection(JSON.stringify(longitude), contract), errorCode("response_invalid"));

    const ring = polygonCollection();
    ring.features[0].geometry.coordinates[0].at(-1)[0] = -71;
    assert.throws(() => parseLiveFeatureCollection(JSON.stringify(ring), contract), errorCode("response_invalid"));
  });

  it("distinguishes caller cancellation from the bounded timeout", async () => {
    const base = {sourceType: "arcgis", url: ARCGIS_URL, configuration: ARCGIS_CONFIGURATION, bounds: BOUNDS};
    const cancelled = new AbortController();
    const pending = loadLiveFeaturePage({
      ...base,
      signal: cancelled.signal,
      fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {once: true});
      })
    });
    cancelled.abort();
    await assert.rejects(pending, errorCode("request_cancelled"));

    await assert.rejects(loadLiveFeaturePage({
      ...base,
      timeoutMilliseconds: 1,
      fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {once: true});
      })
    }), errorCode("request_timeout"));
  });
});

const NON_PAGINATED_METADATA = {
  advancedQueryCapabilities: {supportsPagination: false},
  fields: ARCGIS_CONFIGURATION.fields.map(name => ({name, type: name === "OBJECTID" ? "esriFieldTypeOID" : "esriFieldTypeString"}))
};

it("negotiates non-paginated ArcGIS IDs only after a query error, within the original extent and budget", async () => {
  const calls = [];
  const replies = [{error: {code: 400}}, NON_PAGINATED_METADATA,
    {objectIdFieldName: "OBJECTID", objectIds: [3, 1, 2]}, polygonCollection({features: 2})];
  const result = await loadLiveFeaturePage({sourceType: "arcgis", url: ARCGIS_URL,
    configuration: {...ARCGIS_CONFIGURATION, pageSize: 2}, bounds: BOUNDS,
    fetchImpl: async (url, options) => {
      calls.push({url: new URL(url), options});
      return jsonResponse(replies.shift(), {url});
    }});
  assert.equal(calls.length, 4);
  assert.equal(calls[1].url.href, `${ARCGIS_URL}?f=json`);
  assert.equal(calls[2].url.searchParams.get("returnIdsOnly"), "true");
  assert.equal(calls[3].url.searchParams.get("objectIds"), "1,2");
  for (const call of calls.slice(2)) {
    assert.equal(call.url.searchParams.get("geometry"), BOUNDS.join(","));
    for (const key of ["orderByFields", "resultOffset", "resultRecordCount"]) assert.equal(call.url.searchParams.has(key), false);
    assert.equal(call.options.credentials, "omit");
    assert.equal(call.options.redirect, "error");
  }
  assert.equal(result.opengeo.numberMatched, 3);
  assert.equal(result.opengeo.mayBeTruncated, true);
  assert.equal(result.opengeo.requestCount, 4);
});

it("uses known non-paginated metadata without a failing query and stops at an empty inventory", async () => {
  let calls = 0;
  const result = await loadLiveFeaturePage({sourceType: "arcgis", url: ARCGIS_URL,
    configuration: ARCGIS_CONFIGURATION, bounds: BOUNDS, arcgisMetadata: NON_PAGINATED_METADATA,
    fetchImpl: async url => {
      calls++;
      assert.equal(new URL(url).searchParams.get("returnIdsOnly"), "true");
      return jsonResponse({objectIdFieldName: "OBJECTID", objectIds: []}, {url});
    }});
  assert.equal(calls, 1);
  assert.equal(result.features.length, 0);
  assert.equal(result.opengeo.mayBeTruncated, false);
});

it("rejects incomplete, duplicate, mismatched and excessive ID inventories before feature reads", async () => {
  for (const inventory of [
    {objectIdFieldName: "OTHER", objectIds: [1]},
    {objectIdFieldName: "OBJECTID", objectIds: [1, 1]},
    {objectIdFieldName: "OBJECTID", objectIds: [1], exceededTransferLimit: true},
    {objectIdFieldName: "OBJECTID", objectIds: ["1"]},
    {objectIdFieldName: "OBJECTID", objectIds: Array.from({length: 50001}, (_, i) => i)}
  ]) {
    let calls = 0;
    await assert.rejects(loadLiveFeaturePage({sourceType: "arcgis", url: ARCGIS_URL,
      configuration: ARCGIS_CONFIGURATION, bounds: BOUNDS, arcgisMetadata: NON_PAGINATED_METADATA,
      fetchImpl: async url => {calls++; return jsonResponse(inventory, {url});}}), errorCode("response_invalid"));
    assert.equal(calls, 1);
  }
});

it("does not substitute different features or use archive URLs when ID selection fails", async () => {
  const replies = [{objectIdFieldName: "OBJECTID", objectIds: [2]}, polygonCollection()];
  await assert.rejects(loadLiveFeaturePage({sourceType: "arcgis", url: ARCGIS_URL,
    configuration: ARCGIS_CONFIGURATION, bounds: BOUNDS, arcgisMetadata: NON_PAGINATED_METADATA,
    fetchImpl: async url => {
      assert.equal(new URL(url).hostname, "services.example.test");
      return jsonResponse(replies.shift(), {url});
    }}), errorCode("response_invalid"));
});

it("does not retry authorization failures or invent non-paginated support", async () => {
  for (const status of [401, 403]) {
    let calls = 0;
    await assert.rejects(loadLiveFeaturePage({sourceType: "arcgis", url: ARCGIS_URL,
      configuration: ARCGIS_CONFIGURATION, bounds: BOUNDS,
      fetchImpl: async url => {calls++; return jsonResponse({}, {url, status});}}), errorCode("source_unavailable"));
    assert.equal(calls, 1);
  }
  const replies = [{error: {code: 400}}, {...NON_PAGINATED_METADATA, advancedQueryCapabilities: {supportsPagination: true}}];
  await assert.rejects(loadLiveFeaturePage({sourceType: "arcgis", url: ARCGIS_URL,
    configuration: ARCGIS_CONFIGURATION, bounds: BOUNDS,
    fetchImpl: async url => jsonResponse(replies.shift(), {url})}), errorCode("response_invalid"));
  assert.equal(replies.length, 0);
});

it("sends long generated ID selections by credential-free form POST to the same endpoint", async () => {
  let calls = 0;
  const result = await loadLiveFeaturePage({sourceType: "arcgis", url: ARCGIS_URL,
    configuration: ARCGIS_CONFIGURATION, bounds: BOUNDS, arcgisMetadata: NON_PAGINATED_METADATA,
    fetchImpl: async (url, options) => {
      calls++;
      if (calls === 1) return jsonResponse({objectIdFieldName: "OBJECTID", objectIds: Array.from({length: 500}, (_, i) => i + 1)}, {url});
      assert.equal(url, `${ARCGIS_URL}/query`);
      assert.equal(options.method, "POST");
      assert.equal(options.credentials, "omit");
      assert.equal(options.headers['content-type'], 'application/x-www-form-urlencoded');
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('objectIds').split(',').length, 500);
      assert.equal(form.get('geometry'), BOUNDS.join(','));
      assert.equal(form.has('resultOffset'), false);
      return jsonResponse(polygonCollection({features: 500}), {url});
    }});
  assert.equal(result.features.length, 500);
  assert.equal(calls, 2);
});


it("accepts ArcGIS nested truncation metadata without accepting ambiguous claims", () => {
  const request = buildLiveFeatureRequest({sourceType: "arcgis", url: ARCGIS_URL,
    configuration: ARCGIS_CONFIGURATION, bounds: BOUNDS});
  for (const flag of [false, true]) {
    const input = polygonCollection({provider: {properties: {exceededTransferLimit: flag}}});
    assert.equal(parseLiveFeatureCollection(JSON.stringify(input), request.contract).provider.exceededTransferLimit, flag);
    input.exceededTransferLimit = !flag;
    assert.throws(() => parseLiveFeatureCollection(JSON.stringify(input), request.contract), /conflicts/);
  }
  for (const properties of [{exceededTransferLimit: "true"}, {unreviewed: true}, [], null]) {
    assert.throws(() => parseLiveFeatureCollection(JSON.stringify(polygonCollection({provider: {properties}})), request.contract), /properties/);
  }
});

it("accepts the ArcGIS null geometry CRS only under its explicit WGS84 query contract", () => {
  const request = buildLiveFeatureRequest({sourceType: "arcgis", url: ARCGIS_URL,
    configuration: ARCGIS_CONFIGURATION, bounds: BOUNDS});
  const input = polygonCollection();
  input.features[0].geometry.crs = null;
  assert.equal(parseLiveFeatureCollection(JSON.stringify(input), request.contract).collection.features.length, 1);
  input.features[0].geometry.crs = "EPSG:3857";
  assert.throws(() => parseLiveFeatureCollection(JSON.stringify(input), request.contract), /not WGS84/);
});
