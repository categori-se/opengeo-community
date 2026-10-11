import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {gzipSync} from "node:zlib";
import {describe, it} from "node:test";
import {
  ArchivedGeojsonError,
  loadArchivedGeojson
} from "../src/lib/archivedGeojson.js";

const URL = "https://s3.us-east-1.amazonaws.com/example-geodata/usa/ma/demo.geojson.gz";

function fixture() {
  const collection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: 1,
        properties: {name: "Example", percentile: 84},
        geometry: {
          type: "Polygon",
          coordinates: [[[-71.2, 42.1], [-71.1, 42.1], [-71.1, 42.2], [-71.2, 42.1]]]
        }
      },
      {
        type: "Feature",
        id: 2,
        properties: {name: "Example two", percentile: 41},
        geometry: {
          type: "MultiPolygon",
          coordinates: [[[[-71.4, 42.3], [-71.3, 42.3], [-71.3, 42.4], [-71.4, 42.3]]]]
        }
      }
    ]
  };
  const decoded = Buffer.from(JSON.stringify(collection));
  const object = gzipSync(decoded, {mtime: 0});
  const sha256 = (value) => createHash("sha256").update(value).digest("hex");
  return {
    collection,
    object,
    configuration: {
      contentEncoding: "gzip",
      objectSha256: sha256(object),
      decodedSha256: sha256(decoded),
      sizeBytes: object.byteLength,
      decodedSizeBytes: decoded.byteLength,
      featureCount: 2,
      geometryType: "MultiPolygon",
      bounds: [-73.6, 41.1, -69.7, 43],
      attribution: "MassGIS",
      license: "LicenseRef-Public-Domain",
      authoritativeUrl: "https://services.example.test/FeatureServer/0",
      rightsUrl: "https://example.test/rights"
    }
  };
}

function response(body, {url = URL, contentType = "application/gzip"} = {}) {
  return {
    status: 200,
    url,
    headers: {get: (name) => ({
      "content-type": contentType,
      "content-length": String(body.byteLength)
    })[name.toLowerCase()] ?? null},
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
  };
}

describe("governed immutable GeoJSON archives", () => {
  it("reads checksum-pinned historical S3 metadata types while preserving Overpass provenance", async () => {
    const item=fixture();
    Object.assign(item.collection,{generator:'overpass-ide',copyright:'OpenStreetMap contributors; ODbL',timestamp:'2022-08-12T18:36:05Z'});
    const object=Buffer.from(JSON.stringify(item.collection));
    const hash=createHash('sha256').update(object).digest('hex');
    const configuration={...item.configuration,contentEncoding:'identity',objectSha256:hash,decodedSha256:hash,sizeBytes:object.length,decodedSizeBytes:object.length};
    const url=URL.replace('.gz','');
    for(const contentType of ['application/octet-stream','binary/octet-stream','application/x-www-form-urlencoded; charset=utf-8']) {
      const result=await loadArchivedGeojson({url,configuration,fetchImpl:async()=>response(object,{url,contentType})});
      assert.deepEqual(result,item.collection);
      const altered=Buffer.from(object);altered[30]^=1;
      await assert.rejects(loadArchivedGeojson({url,configuration,fetchImpl:async()=>response(altered,{url,contentType})}),{code:'object_checksum_mismatch'});
    }
    await assert.rejects(loadArchivedGeojson({url,configuration,fetchImpl:async()=>response(object,{url,contentType:'text/html'})}),{code:'invalid_content_type'});
  });
  it("omits credentials and verifies both the compressed object and decoded collection", async () => {
    const item = fixture();
    let request;
    const result = await loadArchivedGeojson({
      url: URL,
      configuration: item.configuration,
      fetchImpl: async (...args) => {
        request = args;
        return response(item.object);
      }
    });
    assert.deepEqual(result.features, item.collection.features);
    assert.equal(result.opengeo.sourceMode, "governed-immutable-archive");
    assert.equal(result.opengeo.featureCount, 2);
    assert.equal(request[0], URL);
    assert.equal(request[1].credentials, "omit");
    assert.equal(request[1].redirect, "error");
    assert.equal(request[1].referrerPolicy, "no-referrer");
  });

  it("fails closed on redirects, checksum drift, unexpected fields, and geometry-family drift", async () => {
    const redirected = fixture();
    await assert.rejects(
      loadArchivedGeojson({
        url: URL,
        configuration: redirected.configuration,
        fetchImpl: async () => response(redirected.object, {url: "https://example.test/redirected.geojson.gz"})
      }),
      (error) => error instanceof ArchivedGeojsonError && error.code === "redirect_rejected"
    );

    const checksum = fixture();
    checksum.configuration.objectSha256 = "0".repeat(64);
    await assert.rejects(
      loadArchivedGeojson({
        url: URL,
        configuration: checksum.configuration,
        fetchImpl: async () => response(checksum.object)
      }),
      (error) => error.code === "object_checksum_mismatch"
    );

    const unexpected = fixture();
    unexpected.configuration.secret = "never accepted";
    await assert.rejects(
      loadArchivedGeojson({url: URL, configuration: unexpected.configuration, fetchImpl: async () => response(unexpected.object)}),
      (error) => error.code === "invalid_contract"
    );

    const geometry = fixture();
    geometry.configuration.geometryType = "Point";
    await assert.rejects(
      loadArchivedGeojson({url: URL, configuration: geometry.configuration, fetchImpl: async () => response(geometry.object)}),
      (error) => error.code === "invalid_geojson"
    );

    const falseDecodedSize = fixture();
    falseDecodedSize.configuration.decodedSizeBytes += 1;
    await assert.rejects(
      loadArchivedGeojson({
        url: URL,
        configuration: falseDecodedSize.configuration,
        fetchImpl: async () => response(falseDecodedSize.object)
      }),
      (error) => error.code === "decoded_size_mismatch"
    );
  });
});

describe('historical Bhutan representation compatibility', () => {
  async function verify(collection) {
    const {verifyReviewedArchiveBytes} = await import('../src/lib/archivedGeojson.js');
    const bytes = new TextEncoder().encode(JSON.stringify(collection));
    const hash = createHash('sha256').update(bytes).digest('hex');
    return verifyReviewedArchiveBytes(bytes, {sizeBytes: bytes.length, decodedSizeBytes: bytes.length,
      objectSha256: hash, decodedSha256: hash, contentEncoding: 'identity',
      featureCount: collection.features.length, geometryType: 'LineString'});
  }
  it('preserves a named capture and all unlocated feature attributes without inventing coordinates', async () => {
    const collection = {type: 'FeatureCollection', name: 'Historical capture', features: [
      {type: 'Feature', id: 1, properties: {label: 'unlocated'}, geometry: {type: 'LineString', coordinates: []}},
      {type: 'Feature', id: 3, properties: {label: 'no geometry supplied'}, geometry: null},
      {type: 'Feature', id: 2, properties: {}, geometry: {type: 'LineString', coordinates: [[90,27],[91,28]]}}
    ]};
    assert.deepEqual(await verify(collection), collection);
  });
  it('still rejects malformed nested coordinates, wrong families and nontext names', async () => {
    for (const geometry of [{type:'LineString',coordinates:[[]]}, {type:'Polygon',coordinates:[]}]) {
      await assert.rejects(verify({type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry}]}), {code:'invalid_geojson'});
    }
    await assert.rejects(verify({type:'FeatureCollection',name:{unexpected:true},features:[]}),{code:'invalid_geojson'});
    await assert.rejects(verify({type:'FeatureCollection',features:[{type:'Feature',properties:{}}]}),{code:'invalid_geojson'});
    await assert.rejects(verify({type:'FeatureCollection',features:[{type:'Feature',properties:{nested:{}},geometry:null}]}),{code:'invalid_geojson'});
  });
});
