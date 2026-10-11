import {createHash} from "node:crypto";
import {pathToFileURL} from "node:url";

import {VectorTile} from "@mapbox/vector-tile";
import Pbf from "pbf";

import {
  OPEN_3D_SCENE_RECEIPT,
  OPEN_3D_SCENE_SOURCE
} from "../src/lib/openScene3d.js";

const MAX_TILEJSON_BYTES = 65_536;
const MAX_VECTOR_TILE_BYTES = 2_097_152;
const REPRESENTATIVE_TILE = Object.freeze({z: 14, x: 8802, y: 5373, place: "Berlin, Germany"});

export async function auditOpenScene3dSource({fetchImpl = fetch, now = () => new Date(), observeLatest = false} = {}) {
  const tileJsonResponse = await boundedFetch(
    fetchImpl,
    OPEN_3D_SCENE_SOURCE.tileJsonUrl,
    MAX_TILEJSON_BYTES,
    ["application/json"]
  );
  const tileJson = parseJson(tileJsonResponse.bytes, "OpenFreeMap TileJSON");
  assertTileJson(tileJson, {observeLatest});

  const tileTemplate = tileJson.tiles[0];
  const tileUrl = tileTemplate
    .replace("{z}", String(REPRESENTATIVE_TILE.z))
    .replace("{x}", String(REPRESENTATIVE_TILE.x))
    .replace("{y}", String(REPRESENTATIVE_TILE.y));
  const tileResponse = await boundedFetch(
    fetchImpl,
    tileUrl,
    MAX_VECTOR_TILE_BYTES,
    ["application/vnd.mapbox-vector-tile", "application/x-protobuf"]
  );
  const decoded = decodeRepresentativeTile(tileResponse.bytes);

  const receipt = {
    observedAt: now().toISOString(),
    snapshotVersion: tileTemplate.split("/")[4],
    tileTemplate,
    mode: observeLatest ? "candidate-observation" : "pinned-verification",
    tileJson: {
      url: OPEN_3D_SCENE_SOURCE.tileJsonUrl,
      bytes: tileJsonResponse.bytes.length,
      sha256: sha256(tileJsonResponse.bytes),
      mediaType: tileJsonResponse.mediaType,
      contentEncoding: tileJsonResponse.contentEncoding,
      tilejson: tileJson.tilejson,
      version: tileJson.version,
      bounds: tileJson.bounds,
      layers: tileJson.vector_layers.length,
      attribution: tileJson.attribution
    },
    representativeTile: {
      ...REPRESENTATIVE_TILE,
      url: tileUrl,
      bytes: tileResponse.bytes.length,
      declaredCompressedBytes: tileResponse.declaredBytes,
      sha256: sha256(tileResponse.bytes),
      mediaType: tileResponse.mediaType,
      contentEncoding: tileResponse.contentEncoding,
      ...decoded
    }
  };
  if (!observeLatest && (receipt.tileJson.sha256 !== OPEN_3D_SCENE_RECEIPT.tileJsonSha256
    || receipt.representativeTile.sha256 !== OPEN_3D_SCENE_RECEIPT.representativeTileSha256)) {
    throw new Error("OpenFreeMap source bytes drifted outside the pinned OpenGeo 3D-scene receipt");
  }
  return receipt;
}

async function boundedFetch(fetchImpl, url, maximumBytes, allowedMediaTypes) {
  const response = await fetchImpl(url, {
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok || response.url !== url) {
    throw new Error(`open 3D source ${url} returned ${response.status} or changed origin`);
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!allowedMediaTypes.includes(mediaType)) {
    throw new Error(`open 3D source ${url} returned ${mediaType ?? "no media type"}`);
  }
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) {
    throw new Error(`open 3D source ${url} exceeds ${maximumBytes} declared bytes`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > maximumBytes) {
    throw new Error(`open 3D source ${url} returned ${bytes.length} decoded bytes`);
  }
  return {
    bytes,
    declaredBytes: Number.isFinite(declaredBytes) ? declaredBytes : null,
    mediaType,
    contentEncoding: response.headers.get("content-encoding")?.toLowerCase() ?? null
  };
}

function assertTileJson(value, {observeLatest = false} = {}) {
  const building = value?.vector_layers?.find(({id}) => id === "building");
  const landcover = value?.vector_layers?.find(({id}) => id === "landcover");
  if (!value || typeof value !== "object"
    || value.tilejson !== "3.0.0"
    || value.version !== "3.16.0"
    || !Array.isArray(value.tiles) || value.tiles.length !== 1
    || (observeLatest
      ? !/^https:\/\/tiles\.openfreemap\.org\/planet\/[0-9]{8}_[0-9]{6}_pt\/\{z\}\/\{x\}\/\{y\}\.pbf$/.test(value.tiles[0])
      : value.tiles[0] !== OPEN_3D_SCENE_SOURCE.tileUrl)
    || value.minzoom !== 0 || value.maxzoom !== 14
    || JSON.stringify(value.bounds) !== JSON.stringify(OPEN_3D_SCENE_SOURCE.bounds)
    || typeof value.attribution !== "string"
    || !value.attribution.includes("OpenFreeMap")
    || !value.attribution.includes("OpenMapTiles")
    || !value.attribution.includes("OpenStreetMap")
    || !building || building.minzoom !== 13 || building.maxzoom !== 14
    || building.fields?.render_height !== "Number"
    || building.fields?.render_min_height !== "Number"
    || building.fields?.hide_3d !== "Boolean"
    || !landcover || landcover.minzoom !== 0 || landcover.maxzoom !== 14
    || landcover.fields?.class !== "String" || landcover.fields?.subclass !== "String") {
    throw new Error("OpenFreeMap TileJSON drifted outside the pinned OpenGeo 3D-scene contract");
  }
}

function decodeRepresentativeTile(bytes) {
  let vectorTile;
  try {
    vectorTile = new VectorTile(new Pbf(bytes));
  } catch {
    throw new Error("representative open 3D source tile is not a valid bounded MVT");
  }
  const buildings = vectorTile.layers.building;
  const landcover = vectorTile.layers.landcover;
  if (!buildings || !landcover || buildings.length < 1 || landcover.length < 1) {
    throw new Error("representative open 3D source tile lacks building or landcover features");
  }
  let numericBuildingHeights = 0;
  let hiddenBuildings = 0;
  let minimumBuildingHeight = Number.POSITIVE_INFINITY;
  let maximumBuildingHeight = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < buildings.length; index += 1) {
    const feature = buildings.feature(index);
    if (feature.type !== 3) throw new Error("representative building feature is not polygonal");
    const height = feature.properties.render_height;
    if (Number.isFinite(height)) {
      numericBuildingHeights += 1;
      minimumBuildingHeight = Math.min(minimumBuildingHeight, height);
      maximumBuildingHeight = Math.max(maximumBuildingHeight, height);
    }
    if (feature.properties.hide_3d === true) hiddenBuildings += 1;
  }
  const landcoverClasses = {};
  for (let index = 0; index < landcover.length; index += 1) {
    const feature = landcover.feature(index);
    if (feature.type !== 3) throw new Error("representative landcover feature is not polygonal");
    const name = String(feature.properties.class ?? "unknown");
    landcoverClasses[name] = (landcoverClasses[name] ?? 0) + 1;
  }
  if (numericBuildingHeights < 1 || !(landcoverClasses.wood > 0)) {
    throw new Error("representative tile lacks numeric building height or woodland evidence");
  }
  return {
    layerIds: Object.keys(vectorTile.layers).sort(),
    buildingFeatures: buildings.length,
    numericBuildingHeights,
    hiddenBuildings,
    minimumBuildingHeight,
    maximumBuildingHeight,
    landcoverFeatures: landcover.length,
    landcoverClasses
  };
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Observation never writes application pins or grants runtime permission.
  console.log(JSON.stringify(await auditOpenScene3dSource({observeLatest: process.argv.includes("--observe-latest")}), null, 2));
}
