import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {JSDOM} from "jsdom";
import {
  OPENLAYERS_WFS_FILTERS,
  SPATIAL_INTERCHANGE_FORMATS,
  SPATIAL_INTERCHANGE_LIMITS,
  buildOpenLayersWfsGetFeature,
  parseSpatialInterchange,
  readSpatialInterchangeFile,
  prepareManagedSpatialFile,
  serializeSpatialInterchange,
  spatialProjectionContract,
  transformSpatialCoordinate,
  transformSpatialExtent
} from "../src/lib/spatialInterchange.js";

const window = new JSDOM("").window;
globalThis.document = window.document;
globalThis.XMLSerializer = window.XMLSerializer;

const COLLECTION = Object.freeze({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "boston",
      properties: {name: "Boston", count: 7},
      geometry: {type: "Point", coordinates: [-71.0589, 42.3601]}
    },
    {
      type: "Feature",
      id: "harbor-route",
      properties: {name: "Harbor route"},
      geometry: {
        type: "LineString",
        coordinates: [[-71.061, 42.356], [-70.99, 42.35]]
      }
    }
  ]
});

describe("bounded OpenLayers spatial interchange", () => {
  it("declares parse and write separately for GeoJSON, WKT, and WKB", () => {
    assert.deepEqual(Object.keys(SPATIAL_INTERCHANGE_FORMATS), ["geojson", "wkt", "wkb"]);
    for (const [id, definition] of Object.entries(SPATIAL_INTERCHANGE_FORMATS)) {
      assert.equal(definition.parse, true, `${id} parse`);
      assert.equal(definition.write, true, `${id} write`);
      assert.ok(definition.extensions.length >= 1);
      assert.ok(definition.mediaType);
    }
    assert.equal(SPATIAL_INTERCHANGE_FORMATS.wkt.payload, "geometry-only");
    assert.equal(SPATIAL_INTERCHANGE_FORMATS.wkb.payload, "geometry-and-optional-srid");
  });

  it("round-trips GeoJSON without loss and reports WKT/EWKB property loss explicitly", () => {
    const geojson = serializeSpatialInterchange(COLLECTION, {format: "geojson"});
    const geojsonRoundTrip = parseSpatialInterchange(geojson.content, {format: "geojson"});
    assert.deepEqual(geojsonRoundTrip.geojson, COLLECTION);
    assert.deepEqual(geojson.report.losses, []);
    assert.equal(geojsonRoundTrip.report.propertiesPreserved, true);

    for (const format of ["wkt", "wkb"]) {
      const written = serializeSpatialInterchange(COLLECTION, {
        format,
        wkbEncoding: "hex"
      });
      const read = parseSpatialInterchange(written.content, {format});
      assert.equal(read.geojson.features.length, 2);
      assert.deepEqual(
        read.geojson.features.map(({geometry}) => geometry),
        COLLECTION.features.map(({geometry}) => geometry)
      );
      assert.equal(written.report.propertiesPreserved, false);
      assert.equal(written.report.losses.length, 1);
      assert.equal(read.report.losses.length, 1);
    }
  });

  it("reads binary and hexadecimal EWKB files with SRID-derived projection", async () => {
    const binary = serializeSpatialInterchange(COLLECTION, {
      format: "wkb",
      dataProjection: "EPSG:4326",
      wkbEncoding: "binary"
    });
    const binaryFile = {
      name: "harbor.wkb",
      size: binary.content.byteLength,
      arrayBuffer: async () => binary.content
    };
    const readBinary = await readSpatialInterchangeFile(binaryFile);
    assert.equal(readBinary.report.sourceProjection, "EPSG:4326");
    assert.equal(readBinary.geojson.features.length, 2);

    const hexadecimal = serializeSpatialInterchange(COLLECTION, {
      format: "wkb",
      dataProjection: "EPSG:4326",
      wkbEncoding: "hex"
    });
    const encoded = new TextEncoder().encode(`\n${hexadecimal.content}\n`);
    const hexFile = {
      name: "harbor.ewkb",
      size: encoded.byteLength,
      arrayBuffer: async () => encoded.buffer
    };
    assert.equal((await readSpatialInterchangeFile(hexFile)).geojson.features.length, 2);
  });

  it("covers declared CRS axes, authoritative Web Mercator fixtures, and round-trip tolerances", () => {
    assert.deepEqual(
      spatialProjectionContract().map(({code, authorityAxis, runtimeAxis}) => ({
        code,
        authorityAxis,
        runtimeAxis
      })),
      [
        {code: "CRS:84", authorityAxis: "enu", runtimeAxis: "enu"},
        {code: "EPSG:4326", authorityAxis: "neu", runtimeAxis: "neu"},
        {code: "EPSG:3857", authorityAxis: "enu", runtimeAxis: "enu"}
      ]
    );
    const xy = transformSpatialCoordinate([-71.0589, 42.3601], {
      sourceProjection: "CRS:84",
      targetProjection: "EPSG:3857"
    });
    const authority = transformSpatialCoordinate([42.3601, -71.0589], {
      sourceProjection: "EPSG:4326",
      targetProjection: "EPSG:3857",
      sourceAxis: "authority"
    });
    assert.deepEqual(authority, xy);
    assert.ok(Math.abs(xy[0] - -7_910_240.564330148) < 1e-6);
    assert.ok(Math.abs(xy[1] - 5_215_074.239663489) < 1e-6);
    const roundTrip = transformSpatialCoordinate(xy, {
      sourceProjection: "EPSG:3857",
      targetProjection: "EPSG:4326",
      targetAxis: "authority"
    });
    assert.ok(Math.abs(roundTrip[0] - 42.3601) < 1e-10);
    assert.ok(Math.abs(roundTrip[1] - -71.0589) < 1e-10);
    const worldEdge = transformSpatialCoordinate([180, 85.0511287798066], {
      sourceProjection: "CRS:84",
      targetProjection: "EPSG:3857"
    });
    assert.ok(Math.abs(worldEdge[0] - 20_037_508.342789244) < 1e-6);
    assert.ok(Math.abs(worldEdge[1] - 20_037_508.342789244) < 1e-6);
    assert.deepEqual(
      transformSpatialExtent([-1, -1, 1, 1], {
        sourceProjection: "CRS:84",
        targetProjection: "CRS:84"
      }),
      [-1, -1, 1, 1]
    );
  });

  it("serializes service-compatible BBOX and ResourceId requests through OpenLayers 10.10.0", () => {
    assert.equal(OPENLAYERS_WFS_FILTERS.bbox.openGeoService, true);
    assert.equal(OPENLAYERS_WFS_FILTERS.resourceId.openGeoService, true);
    const bbox = buildOpenLayersWfsGetFeature({
      filter: {kind: "bbox", extent: [-72, 41, -70, 43]}
    });
    assert.equal(bbox.contentType, "application/xml");
    assert.equal(bbox.serviceCompatible, true);
    assert.match(bbox.xml, /<BBOX>/);
    assert.match(bbox.xml, /<ValueReference>geometry<\/ValueReference>/);
    assert.match(bbox.xml, /<lowerCorner>-72 41<\/lowerCorner>/);
    assert.match(bbox.xml, /srsName="urn:ogc:def:crs:OGC::CRS84"/);

    const resource = buildOpenLayersWfsGetFeature({
      filter: {
        kind: "resourceId",
        value: "features.90000000-0000-4000-8000-000000000121"
      },
      count: 1
    });
    assert.match(resource.xml, /<ResourceId rid="features\.90000000-0000-4000-8000-000000000121"\/>/);
  });

  it("serializes service-compatible comparison, temporal, and bounded And filters", () => {
    for (const filter of [
      {kind: "equalTo", property: "name", value: "Station", matchCase: true},
      {
        kind: "during",
        property: "opengeo_updated_at",
        begin: "2026-08-01T00:00:00Z",
        end: "2026-09-01T00:00:00Z"
      },
      {
        kind: "and",
        conditions: [
          {kind: "equalTo", property: "status", value: "ready"},
          {
            kind: "during",
            property: "opengeo_updated_at",
            begin: "2026-08-01T00:00:00Z",
            end: "2026-09-01T00:00:00Z"
          }
        ]
      }
    ]) {
      const serialized = buildOpenLayersWfsGetFeature({filter});
      assert.equal(serialized.serviceCompatible, true);
      assert.ok(serialized.byteLength < SPATIAL_INTERCHANGE_LIMITS.maximumWfsXmlBytes);
    }
    assert.throws(
      () => buildOpenLayersWfsGetFeature({
        filter: {
          kind: "during",
          property: "observed_at",
          begin: "2026-08-01T00:00:00Z",
          end: "2026-09-01T00:00:00Z"
        }
      }),
      (error) => error.code === "wfs_filter_not_supported_by_opengeo"
    );
    assert.throws(
      () => buildOpenLayersWfsGetFeature({
        filter: {
          kind: "or",
          conditions: [
            {kind: "equalTo", property: "name", value: "A"},
            {kind: "equalTo", property: "name", value: "B"}
          ]
        }
      }),
      (error) => error.code === "wfs_filter_not_supported_by_opengeo"
    );
    assert.throws(
      () => buildOpenLayersWfsGetFeature({
        filter: {
          kind: "and",
          conditions: Array.from({length: 5}, (_, index) => ({
            kind: "equalTo",
            property: "ordinal",
            value: index
          }))
        }
      }),
      (error) => error.code === "wfs_filter_not_supported_by_opengeo"
    );
  });

  it("rejects unsupported projections, oversized feature sets, invalid extents, and filter amplification", () => {
    assert.throws(
      () => transformSpatialCoordinate([0, 0], {sourceProjection: "EPSG:32618"}),
      (error) => error.code === "projection_not_supported"
    );
    assert.throws(
      () => transformSpatialExtent([1, 2, 0, 3]),
      (error) => error.code === "projection_extent_invalid"
    );
    const tooMany = {
      type: "FeatureCollection",
      features: Array.from(
        {length: SPATIAL_INTERCHANGE_LIMITS.maximumFeatures + 1},
        (_, index) => ({
          type: "Feature",
          properties: {},
          geometry: {type: "Point", coordinates: [index % 180, 0]}
        })
      )
    };
    assert.throws(
      () => serializeSpatialInterchange(tooMany, {format: "geojson"}),
      (error) => error.code === "interchange_feature_limit_exceeded"
    );
    assert.throws(
      () => buildOpenLayersWfsGetFeature({
        filter: {
          kind: "and",
          conditions: Array.from({length: 8}, () => ({
            kind: "and",
            conditions: [
              {kind: "equalTo", property: "name", value: "a"},
              {kind: "equalTo", property: "name", value: "b"}
            ]
          }))
        },
        serviceProfile: false
      }),
      (error) => ["wfs_filter_count_exceeded", "wfs_filter_depth_exceeded"].includes(error.code)
    );
  });
});


it("preserves attributes named geometry and internal-looking keys through GeoJSON and projected exchange", () => {
  const input = {type: "FeatureCollection", features: [
    {type: "Feature", id: "kathmandu", properties: {geometry: "survey meaning", __opengeo_geometry__: "ordinary field", nested: {unit: "m"}}, geometry: {type: "Point", coordinates: [85.324, 27.7172]}},
    {type: "Feature", id: "nepal", properties: {geometry: null, __opengeo_geometry___: 7}, geometry: {type: "Point", coordinates: [84, 28]}}
  ]};
  assert.deepEqual(parseSpatialInterchange(JSON.stringify(input), {format: "geojson"}).geojson, input);
  const output = serializeSpatialInterchange(input, {format: "geojson", dataProjection: "EPSG:3857"});
  const reopened = parseSpatialInterchange(output.content, {format: "geojson", dataProjection: "EPSG:3857"}).geojson;
  for (let index = 0; index < input.features.length; index++) {
    assert.deepEqual(reopened.features[index].properties, input.features[index].properties);
    assert.equal(reopened.features[index].id, input.features[index].id);
    for (let axis = 0; axis < 2; axis++) assert.ok(Math.abs(reopened.features[index].geometry.coordinates[axis] - input.features[index].geometry.coordinates[axis]) < 1e-10);
  }
});

it("preserves opaque GeoJSON rights and provenance without copying stale spatial declarations", () => {
  const input = {type:'FeatureCollection', license:null, properties:{owner:'Community'},
    provenance:{source:'survey', confidence:0.5}, bbox:[0,0,1,1],
    features:[{type:'Feature', id:'one', license:'source-specific', coordinates:'foreign feature note',
      properties:{name:'Sample'}, geometry:{type:'Point', coordinates:[85,28], meaning:{unit:'degrees'}}}]};
  const original=structuredClone(input);
  const parsed=parseSpatialInterchange(JSON.stringify(input),{format:'geojson'});
  assert.equal(parsed.geojson.license,null);
  assert.deepEqual(parsed.geojson.provenance,input.provenance);
  assert.deepEqual(parsed.geojson.properties,input.properties);
  assert.equal(parsed.geojson.features[0].license,'source-specific');
  assert.equal(parsed.geojson.features[0].coordinates,'foreign feature note');
  assert.deepEqual(parsed.geojson.features[0].geometry.meaning,{unit:'degrees'});
  assert.equal(Object.hasOwn(parsed.geojson,'bbox'),false);
  assert.deepEqual(parsed.report.preservedSpatialMetadata,[{path:'',member:'bbox',value:input.bbox}]);
  assert.match(parsed.report.losses[0],/conversion report/);
  const output=serializeSpatialInterchange(input,{format:'geojson',dataProjection:'EPSG:3857'});
  const json=JSON.parse(output.content);
  assert.deepEqual(json.provenance,input.provenance);
  assert.equal(json.license,null);
  assert.equal(Object.hasOwn(json,'bbox'),false);
  assert.deepEqual(output.report.preservedSpatialMetadata,parsed.report.preservedSpatialMetadata);
  assert.deepEqual(input,original);
  const reopened=parseSpatialInterchange(output.content,{format:'geojson',dataProjection:'EPSG:3857'});
  assert.deepEqual(reopened.geojson.provenance,input.provenance);
  assert.equal(reopened.geojson.features[0].license,'source-specific');
});


describe("managed geometry conversion provenance", () => {
  it("uploads structured conversion knowledge alongside normalized geometry", async () => {
    const original = new File(["POINT (85.324 27.7172)"], "survey.wkt", {type: "text/plain"});
    const converted = await prepareManagedSpatialFile(original);
    const data = JSON.parse(await converted.file.text());
    assert.equal(converted.file.name, "survey.geojson");
    assert.deepEqual(data.features[0].geometry.coordinates, [85.324, 27.7172]);
    const provenance = data["opengeo:conversion"];
    assert.equal(provenance.source.fileName, "survey.wkt");
    assert.equal(provenance.source.originalBytesArchived, false);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await original.arrayBuffer()));
    assert.equal(provenance.source.checksumSha256, [...digest].map(v => v.toString(16).padStart(2, "0")).join(""));
    assert.deepEqual(provenance.report, converted.report.report);
    assert.deepEqual(parseSpatialInterchange(await converted.file.text(), {format: "geojson"}).geojson["opengeo:conversion"], provenance);
    assert.equal(await original.text(), "POINT (85.324 27.7172)");
  });
});
