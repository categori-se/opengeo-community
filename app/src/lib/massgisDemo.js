import {gunzipSync} from "fflate";

export const MASSGIS_ATTRIBUTION = "MassGIS (Bureau of Geographic Information), Commonwealth of Massachusetts EOTSS";

export const MASSGIS_FEATURE_LAYER_URL = "https://services1.arcgis.com/7iJyYTjCtKsZS1LR/arcgis/rest/services/MassEnviroScreen20260227_gdb/FeatureServer/0";

export const MASSGIS_ARCHIVE_BUCKET = "example-geodata";
export const MASSGIS_ARCHIVE_REGION = "us-east-1";
export const MASSGIS_ARCHIVE_PREFIX = "usa/ma/opengeo/reference-archives/massgis/massenviroscreen";

export const MASSGIS_DEMO_LIMITS = Object.freeze({
  defaultPageSize: 1_000,
  maximumPageSize: 2_000,
  defaultMaximumFeatures: 6_000,
  absoluteMaximumFeatures: 10_000,
  maximumPageCount: 100,
  defaultMaximumResponseBytes: 8 * 1024 * 1024,
  absoluteMaximumResponseBytes: 16 * 1024 * 1024,
  defaultMaximumTotalResponseBytes: 32 * 1024 * 1024,
  absoluteMaximumTotalResponseBytes: 64 * 1024 * 1024,
  maximumCoordinatePositions: 2_000_000,
  defaultTimeoutMilliseconds: 15_000,
  maximumTimeoutMilliseconds: 60_000
});

const SCHEMA_VERSION = "opengeo.massgis-enviroscreen-demo.1.3.0";
const ARCHIVE_SCHEMA_VERSION = "opengeo.reference-archive.1.1.0";
const PROJECT_ID = "public-massgis-massenviroscreen";
const SOURCE_ID = "massgis-massenviroscreen-feature-layer";
const ITEM_ID = "66f096c285bd4642aca21f64fa86e74f";
const VIEW_ID = "massachusetts-statewide";
const QUERY_URL = `${MASSGIS_FEATURE_LAYER_URL}/query`;
const RIGHTS_URL = "https://www.mass.gov/info-details/massgis-frequently-asked-questions";
// The reviewed ArcGIS layer schema marks OBJECTID as the only non-null identity
// field. These three identity fields are nullable strings with length 255.
const NULLABLE_IDENTITY_FIELDS = new Set(["GEOID", "NAME", "COSUB"]);
const MAXIMUM_IDENTITY_STRING_LENGTH = 255;
const MAXIMUM_PROPERTY_STRING_LENGTH = 4_096;
const MAXIMUM_PROPERTY_NUMBER_MAGNITUDE = Number.MAX_SAFE_INTEGER;
const OFFICIAL_URLS = Object.freeze({
  program: "https://www.mass.gov/info-details/cumulative-impact-analysis",
  technicalDocumentation: "https://www.mass.gov/doc/massenviroscreen-technical-documentation-may-8-2026/download",
  attribution: "https://www.mass.gov/info-details/about-massgis",
  item: `https://www.arcgis.com/home/item.html?id=${ITEM_ID}`,
  service: MASSGIS_FEATURE_LAYER_URL
});
const VERSION_DATES = Object.freeze({
  documentationPublishedDate: "2026-05-08",
  serviceDataLastEditedDate: "2026-04-18",
  serviceSchemaLastEditedDate: "2026-05-05"
});
const EXPECTED_STYLE_PRESETS = Object.freeze([
  "statewide-percentile-fill",
  "cumulative-score-fill",
  "pollution-burden-line",
  "population-characteristics-line"
]);
const EXPECTED_INDICATOR_GROUPS = deepFreeze([
  {
    slug: "environmental-exposures",
    maps: [
      ["pm25-concentration", "PM25", "EXPpctilePM25"],
      ["ozone-concentration", "OZONE", "EXPpctileOZONE"],
      ["diesel-particulate-matter", "DSLPM", "EXPpctileDSLPM"],
      ["nitrogen-dioxide-concentration", "NO2", "EXPpctileNO2"],
      ["heavy-traffic-proximity", "PTRAF", "EXPpctilePTRAF"],
      ["drinking-water-non-compliance", "DWATER", "EXPpctileDWATER"],
      ["air-toxics-cancer-risk", "CancerRisk", "EXPpctileCancerRisk"],
      ["air-toxics-respiratory-hazard", "Respiratory_HI", "EXPpctileRespHI"]
    ]
  },
  {
    slug: "environmental-effects",
    maps: [
      ["pollution-cleanup-sites", "cleanup_score", "EFFCTpctileCleanup"],
      ["groundwater-threats", "gwater_score", "EFFCTpctileGrndWater"],
      ["hazardous-waste-facilities", "BWPScore", "EFFCTpctileBWPMAJOR_PT"],
      ["solid-waste-sites-and-facilities", "SWScore", "EFFCTpctileSW"],
      ["impaired-water-bodies", "IL_count", "EFFCTpctileIL"]
    ]
  },
  {
    slug: "climate-risks",
    maps: [
      ["drought", "AnnFreqWeight", "CLIMpctilDrought"],
      ["wildfire-risk", "AIAmean", "CLIMpctilFIRE"],
      ["flooding", "PopFloodPct", "CLIMpctilFLD"],
      ["heat", "HeatEvents", "CLIMpctilHEAT"]
    ]
  },
  {
    slug: "sensitive-populations",
    maps: [
      ["high-blood-pressure", "High_blood_pressure_among_adults", "SPpctileHPRSSR"],
      ["coronary-heart-disease", "Coronary_heart_disease_among_adults", "SPpctileHRTDIS"],
      ["chronic-obstructive-pulmonary-disease", "Chronic_obstructive_pulmonary_disease_among_adults", "SPpctileCOPD"],
      ["adult-cancer", "Cancer__non_skin__or_melanoma_among_adults", "SPpctileCANCER"],
      ["pediatric-asthma", "pedAsthmaPrevalence", "SPpctileAsthmaPed"],
      ["elevated-blood-lead", "BLL", "SPpctileBLL"],
      ["low-birth-weight", "LBW", "SPpctileLBW"],
      ["premature-mortality", "PMR", "SPpctilePMR"]
    ]
  },
  {
    slug: "socioeconomic-factors",
    maps: [
      ["adults-without-high-school-diploma", "HSlesspctE", "SEpctileHS"],
      ["low-income-housing-burden", "hhburden", "SEpctileHHB"],
      ["limited-english-speaking-households", "limitEngpctE", "SEpctileLEP"],
      ["households-below-poverty", "povHHpctE", "SEpctilePOV"],
      ["unemployment", "unemploypctE", "SEpctileEMP"]
    ]
  }
]);
const EXPECTED_COMBINED_FIELDS = Object.freeze([
  ["massenviroscreen-score", "MassEnviroScore", "cumulative-score-fill"],
  ["pollution-burden", "PollutionBurden", "pollution-burden-line"],
  ["population-characteristics", "PopCharacteristics", "population-characteristics-line"]
]);

export function validateMassgisDemoConfig(value) {
  const config = record(value, "MassGIS demo configuration");
  exactKeys(config, [
    "schemaVersion", "project", "collection", "viewConfigurations", "stylePresets",
    "sources", "indicatorGroups", "combinedAnalysis"
  ], "MassGIS demo configuration");
  if (config.schemaVersion !== SCHEMA_VERSION) invalid("MassGIS demo schema is unsupported");

  validateProject(config.project);
  validateCollection(config.collection);
  const viewIds = validateViews(config.viewConfigurations);
  const presetIds = validateStylePresets(config.stylePresets);
  const sourceIds = validateSources(config.sources);
  validateIndicatorGroups(config.indicatorGroups, sourceIds, viewIds, presetIds);
  validateCombinedAnalysis(config.combinedAnalysis, sourceIds, viewIds, presetIds);

  return deepFreeze(copyJson(config));
}

export function massgisArchiveUrl(value) {
  const config = validateMassgisDemoConfig(value);
  return archivePublicUrl(config.sources[0].archive);
}

export function massgisSourceFields(value) {
  const config = validateMassgisDemoConfig(value);
  return Object.freeze(sourceFields(config));
}

export async function loadMassgisDemoGeojson(value, options = {}) {
  const config = validateMassgisDemoConfig(value);
  const settings = loaderSettings(options, config.sources[0]);
  const source = config.sources[0];
  const fields = Object.freeze(sourceFields(config));
  const expectedFields = new Set(fields);
  const fieldContract = sourceFieldContract(config, expectedFields);
  const observedFields = new Set();
  const features = [];
  const objectIds = new Set();
  const coordinateBudget = {positions: 0};
  let resultOffset = 0;
  let pageCount = 0;
  let totalResponseBytes = 0;
  let complete = false;

  while (!complete) {
    if (pageCount >= settings.maximumPageCount) invalid("MassGIS response exceeded the page-count limit");
    const remaining = settings.maximumFeatures - features.length;
    if (remaining <= 0) invalid("MassGIS response exceeded the feature-count limit");
    const requestedCount = Math.min(settings.pageSize, remaining);
    const requestUrl = buildQueryUrl(source, fields, resultOffset, requestedCount);
    const page = await withRequestBoundary(
      (signal) => fetchGeojsonPage(settings.fetchImpl, requestUrl, signal, settings.maximumResponseBytes),
      settings.timeoutMilliseconds,
      settings.signal
    );
    totalResponseBytes += page.byteLength;
    if (totalResponseBytes > settings.maximumTotalResponseBytes) {
      invalid("MassGIS response exceeded the total byte limit");
    }
    const parsed = validateFeatureCollection(page.value, {
      expectedFields,
      objectIdField: source.objectIdField,
      requestedCount,
      coordinateBudget,
      fieldContract,
      observedFields
    });
    pageCount += 1;
    if (!parsed.features.length && parsed.exceededTransferLimit === true) {
      invalid("MassGIS pagination made no progress");
    }
    for (const feature of parsed.features) {
      const objectId = feature.properties[source.objectIdField];
      if (objectIds.has(objectId)) invalid("MassGIS response repeated an object id across pages");
      objectIds.add(objectId);
      features.push(feature);
    }
    if (features.length > settings.maximumFeatures) invalid("MassGIS response exceeded the feature-count limit");

    if (parsed.exceededTransferLimit === false) {
      complete = true;
    } else if (parsed.exceededTransferLimit !== true && parsed.features.length < requestedCount) {
      complete = true;
    } else if (!parsed.features.length) {
      complete = true;
    } else {
      resultOffset += parsed.features.length;
      if (features.length === settings.maximumFeatures) {
        invalid("MassGIS response may exceed the configured feature-count limit");
      }
    }
  }

  if (!features.length) invalid("MassGIS statewide response contained no features");
  const observedFieldList = Object.freeze(fields.filter((field) => observedFields.has(field)));
  if (observedFieldList.length !== fields.length) {
    invalid("MassGIS response did not contain every requested field");
  }
  const requestedFieldList = Object.freeze([...fields]);

  return {
    type: "FeatureCollection",
    features,
    opengeo: Object.freeze({
      schemaVersion: "opengeo.massgis-geojson-receipt.1.0.0",
      itemId: source.itemId,
      sourceId: source.id,
      layerUrl: source.layerUrl,
      attribution: source.attribution,
      pageCount,
      featureCount: features.length,
      responseBytes: totalResponseBytes,
      outSpatialReference: source.outSpatialReference,
      // `fields` remains the backward-compatible requested-field receipt.
      fields: requestedFieldList,
      requestedFields: requestedFieldList,
      observedFields: observedFieldList
    })
  };
}

export async function loadMassgisReferenceGeojson(value, options = {}) {
  const config = validateMassgisDemoConfig(value);
  const settings = referenceLoaderSettings(options, config.sources[0].archive);
  if (settings.archiveUrl) {
    try {
      return await loadMassgisArchiveGeojson(config, settings);
    } catch (error) {
      if (settings.signal?.aborted || error?.name === "AbortError") throw error;
      if (settings.archiveRequired) throw error;
    }
  }
  const current = await loadMassgisDemoGeojson(config, {
    fetchImpl: settings.fetchImpl,
    timeoutMilliseconds: settings.timeoutMilliseconds,
    signal: settings.signal
  });
  return {
    ...current,
    opengeo: Object.freeze({
      ...current.opengeo,
      sourceMode: settings.archiveUrl ? "authoritative-fallback" : "authoritative",
      authoritativeUrl: config.sources[0].layerUrl,
      archiveObjectKey: config.sources[0].archive.objectKey,
      archiveSha256: config.sources[0].archive.uncompressedSha256
    })
  };
}

function validateProject(value) {
  const project = record(value, "MassGIS public project");
  exactKeys(project, [
    "id", "title", "summary", "visibility", "organization", "sourceIds", "presentationCount"
  ], "MassGIS public project");
  if (slug(project.id, "MassGIS public project id") !== PROJECT_ID
    || project.title !== "MassGIS · MassEnviroScreen"
    || project.visibility !== "public"
    || project.organization !== "public"
    || !Array.isArray(project.sourceIds)
    || project.sourceIds.length !== 1
    || project.sourceIds[0] !== SOURCE_ID
    || project.presentationCount !== 31) {
    invalid("MassGIS public project identity is invalid");
  }
  text(project.summary, "MassGIS public project summary", 500);
}

function validateCollection(value) {
  const collection = record(value, "MassGIS collection");
  exactKeys(collection, [
    "slug", "title", "summary", "attribution", "license", "officialUrls",
    "version", "limitations"
  ], "MassGIS collection");
  if (slug(collection.slug, "MassGIS collection slug") !== "massgis-massenviroscreen") {
    invalid("MassGIS collection slug is not the reviewed collection");
  }
  text(collection.title, "MassGIS collection title", 120);
  text(collection.summary, "MassGIS collection summary", 600);
  if (collection.attribution !== MASSGIS_ATTRIBUTION) invalid("MassGIS attribution is not exact");

  const license = record(collection.license, "MassGIS collection license");
  exactKeys(license, ["name", "url"], "MassGIS collection license");
  if (license.name !== "LicenseRef-Public-Domain" || license.url !== RIGHTS_URL) {
    invalid("MassGIS public-domain rights record is invalid");
  }

  const urls = record(collection.officialUrls, "MassGIS official URLs");
  exactKeys(urls, Object.keys(OFFICIAL_URLS), "MassGIS official URLs");
  for (const [name, expected] of Object.entries(OFFICIAL_URLS)) {
    if (urls[name] !== expected) invalid(`MassGIS official ${name} URL is invalid`);
    publicHttpsUrl(urls[name], `MassGIS official ${name} URL`);
  }

  const version = record(collection.version, "MassGIS version record");
  exactKeys(version, Object.keys(VERSION_DATES), "MassGIS version record");
  for (const [name, expected] of Object.entries(VERSION_DATES)) {
    if (date(version[name], `MassGIS ${name}`) !== expected) invalid(`MassGIS ${name} is not version-pinned`);
  }

  if (!Array.isArray(collection.limitations) || collection.limitations.length < 4 || collection.limitations.length > 8) {
    invalid("MassGIS limitations are invalid");
  }
  collection.limitations.forEach((item, index) => text(item, `MassGIS limitation ${index + 1}`, 500));
}

function validateViews(value) {
  if (!Array.isArray(value) || value.length !== 1) invalid("MassGIS view configurations are invalid");
  const view = record(value[0], "MassGIS view configuration");
  exactKeys(view, ["id", "center", "zoom", "bearing", "pitch"], "MassGIS view configuration");
  if (slug(view.id, "MassGIS view id") !== VIEW_ID) invalid("MassGIS statewide view is missing");
  if (!Array.isArray(view.center) || view.center.length !== 2) invalid("MassGIS view center is invalid");
  boundedNumber(view.center[0], -180, 180, "MassGIS view longitude");
  boundedNumber(view.center[1], -90, 90, "MassGIS view latitude");
  boundedNumber(view.zoom, 0, 24, "MassGIS view zoom");
  boundedNumber(view.bearing, -180, 180, "MassGIS view bearing");
  boundedNumber(view.pitch, 0, 85, "MassGIS view pitch");
  return new Set([view.id]);
}

function validateStylePresets(value) {
  if (!Array.isArray(value) || value.length !== EXPECTED_STYLE_PRESETS.length) {
    invalid("MassGIS style presets are invalid");
  }
  const ids = new Set();
  value.forEach((item, index) => {
    const preset = record(item, `MassGIS style preset ${index + 1}`);
    exactKeys(preset, [
      "id", "geometry", "classification", "breaks", "colors", "opacity",
      "outlineColor", "outlineWidth", "nullColor"
    ], "MassGIS style preset");
    const id = slug(preset.id, "MassGIS style preset id");
    if (id !== EXPECTED_STYLE_PRESETS[index] || ids.has(id)) invalid("MassGIS style preset ids are invalid");
    ids.add(id);
    if (!["fill", "line"].includes(preset.geometry) || preset.classification !== "step") {
      invalid(`MassGIS style preset ${id} renderer is invalid`);
    }
    const expectedBreaks = [20, 40, 60, 80];
    if (!Array.isArray(preset.breaks) || preset.breaks.length !== expectedBreaks.length
      || preset.breaks.some((item, breakIndex) => (
        typeof item !== "number" || !Number.isFinite(item) || item !== expectedBreaks[breakIndex]
      ))) invalid(`MassGIS style preset ${id} breaks are invalid`);
    if (!Array.isArray(preset.colors) || preset.colors.length !== 5) {
      invalid(`MassGIS style preset ${id} colors are invalid`);
    }
    preset.colors.forEach((item, colorIndex) => color(
      item,
      `MassGIS style preset ${id} color ${colorIndex + 1}`
    ));
    boundedNumber(preset.opacity, 0, 1, `MassGIS style preset ${id} opacity`);
    color(preset.outlineColor, `MassGIS style preset ${id} outline color`);
    boundedNumber(preset.outlineWidth, 0, 8, `MassGIS style preset ${id} outline width`);
    color(preset.nullColor, `MassGIS style preset ${id} null color`);
  });
  return ids;
}

function validateSources(value) {
  if (!Array.isArray(value) || value.length !== 1) invalid("MassGIS sources are invalid");
  const source = record(value[0], "MassGIS source");
  exactKeys(source, [
    "id", "type", "itemId", "layerUrl", "queryUrl", "objectIdField", "identityFields",
    "outSpatialReference", "maximumRecordCount", "attribution", "archive"
  ], "MassGIS source");
  if (slug(source.id, "MassGIS source id") !== SOURCE_ID || source.type !== "arcgis-feature-layer"
    || source.itemId !== ITEM_ID || source.layerUrl !== MASSGIS_FEATURE_LAYER_URL
    || source.queryUrl !== QUERY_URL || source.objectIdField !== "OBJECTID"
    || source.outSpatialReference !== 4326 || source.maximumRecordCount !== 2_000
    || source.attribution !== MASSGIS_ATTRIBUTION) invalid("MassGIS source is not the reviewed feature layer");
  publicHttpsUrl(source.layerUrl, "MassGIS source layer URL", {allowQuery: false});
  publicHttpsUrl(source.queryUrl, "MassGIS source query URL", {allowQuery: false});
  if (!Array.isArray(source.identityFields)
    || source.identityFields.join(",") !== "OBJECTID,GEOID,NAME,COSUB") {
    invalid("MassGIS identity fields are invalid");
  }
  source.identityFields.forEach((item) => fieldName(item, "MassGIS identity field"));
  validateArchive(source.archive);
  return new Set([source.id]);
}

function validateArchive(value) {
  const archive = record(value, "MassGIS reference archive");
  exactKeys(archive, [
    "schemaVersion", "bucket", "region", "filename", "objectKey", "storageUri", "retrievedAt", "sourceDataLastEditedDate",
    "pageCount", "featureCount", "uncompressedBytes", "uncompressedSha256",
    "compressedBytes", "compressedSha256"
  ], "MassGIS reference archive");
  if (archive.schemaVersion !== ARCHIVE_SCHEMA_VERSION) invalid("MassGIS reference archive schema is unsupported");
  if (archive.sourceDataLastEditedDate !== VERSION_DATES.serviceDataLastEditedDate) {
    invalid("MassGIS reference archive source version is not pinned");
  }
  if (archive.filename !== `massgis-massenviroscreen-${archive.sourceDataLastEditedDate}-${archive.uncompressedSha256.slice(0, 12)}.geojson.gz`) {
    invalid("MassGIS reference archive filename is invalid");
  }
  const expectedKey = `${MASSGIS_ARCHIVE_PREFIX}/${archive.sourceDataLastEditedDate}/${archive.uncompressedSha256}/${archive.filename}`;
  if (archive.bucket !== MASSGIS_ARCHIVE_BUCKET
    || archive.region !== MASSGIS_ARCHIVE_REGION
    || archive.objectKey !== expectedKey
    || archive.storageUri !== `s3://${MASSGIS_ARCHIVE_BUCKET}/${expectedKey}`) {
    invalid("MassGIS reference archive object key is invalid");
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(archive.retrievedAt)
    || !Number.isFinite(Date.parse(archive.retrievedAt))
    || Date.parse(archive.retrievedAt) < Date.parse(`${archive.sourceDataLastEditedDate}T00:00:00Z`)) {
    invalid("MassGIS reference archive retrieval time is invalid");
  }
  boundedInteger(archive.pageCount, 1, MASSGIS_DEMO_LIMITS.maximumPageCount, "MassGIS archive page count");
  boundedInteger(archive.featureCount, 1, MASSGIS_DEMO_LIMITS.absoluteMaximumFeatures, "MassGIS archive feature count");
  boundedInteger(archive.uncompressedBytes, 1_024, MASSGIS_DEMO_LIMITS.absoluteMaximumResponseBytes, "MassGIS archive uncompressed bytes");
  boundedInteger(archive.compressedBytes, 1_024, 4 * 1024 * 1024, "MassGIS archive compressed bytes");
  hexSha256(archive.uncompressedSha256, "MassGIS archive uncompressed checksum");
  hexSha256(archive.compressedSha256, "MassGIS archive compressed checksum");
}

function validateIndicatorGroups(value, sourceIds, viewIds, presetIds) {
  if (!Array.isArray(value) || value.length !== EXPECTED_INDICATOR_GROUPS.length) {
    invalid("MassGIS must contain the five reviewed indicator groups");
  }
  const mapSlugs = new Set();
  let mapCount = 0;
  value.forEach((item, groupIndex) => {
    const group = record(item, `MassGIS indicator group ${groupIndex + 1}`);
    exactKeys(group, ["slug", "title", "description", "maps"], "MassGIS indicator group");
    const expected = EXPECTED_INDICATOR_GROUPS[groupIndex];
    if (slug(group.slug, "MassGIS indicator group slug") !== expected.slug) {
      invalid("MassGIS indicator group order or id is invalid");
    }
    text(group.title, "MassGIS indicator group title", 120);
    text(group.description, "MassGIS indicator group description", 500);
    if (!Array.isArray(group.maps) || group.maps.length !== expected.maps.length) {
      invalid(`MassGIS ${group.slug} map collection is invalid`);
    }
    group.maps.forEach((item, mapIndex) => {
      const map = record(item, `MassGIS ${group.slug} map ${mapIndex + 1}`);
      exactKeys(map, ["slug", "title", "summary", "sourceId", "viewId", "style"], "MassGIS indicator map");
      const [expectedSlug, expectedSourceField, expectedField] = expected.maps[mapIndex];
      const mapSlug = slug(map.slug, "MassGIS indicator map slug");
      if (mapSlug !== expectedSlug || mapSlugs.has(mapSlug)) invalid("MassGIS indicator map ids are invalid");
      mapSlugs.add(mapSlug);
      text(map.title, "MassGIS indicator map title", 160);
      text(map.summary, "MassGIS indicator map summary", 500);
      reference(map.sourceId, sourceIds, "MassGIS indicator map source");
      reference(map.viewId, viewIds, "MassGIS indicator map view");
      const style = validateIndicatorStyle(map.style, presetIds);
      if (style.presetId !== "statewide-percentile-fill" || style.sourceField !== expectedSourceField
        || style.field !== expectedField || style.unit !== "statewide percentile") {
        invalid(`MassGIS indicator map ${map.slug} field metadata is invalid`);
      }
      mapCount += 1;
    });
  });
  if (mapCount !== 30) invalid("MassGIS demo must contain exactly 30 individual indicator maps");
}

function validateIndicatorStyle(value, presetIds) {
  const style = record(value, "MassGIS indicator style");
  exactKeys(style, [
    "presetId", "field", "fieldAlias", "sourceField", "sourceFieldAlias", "unit"
  ], "MassGIS indicator style");
  reference(style.presetId, presetIds, "MassGIS indicator style preset");
  fieldName(style.field, "MassGIS indicator style field");
  fieldName(style.sourceField, "MassGIS indicator source field");
  text(style.fieldAlias, "MassGIS indicator field alias", 300);
  text(style.sourceFieldAlias, "MassGIS indicator source field alias", 300);
  text(style.unit, "MassGIS indicator unit", 80);
  return style;
}

function validateCombinedAnalysis(value, sourceIds, viewIds, presetIds) {
  const analysis = record(value, "MassGIS combined analysis");
  exactKeys(analysis, ["slug", "title", "summary", "viewId", "layers"], "MassGIS combined analysis");
  if (slug(analysis.slug, "MassGIS combined analysis slug") !== "combined-cumulative-burden-analysis") {
    invalid("MassGIS combined analysis id is invalid");
  }
  text(analysis.title, "MassGIS combined analysis title", 160);
  text(analysis.summary, "MassGIS combined analysis summary", 500);
  reference(analysis.viewId, viewIds, "MassGIS combined analysis view");
  if (!Array.isArray(analysis.layers) || analysis.layers.length !== EXPECTED_COMBINED_FIELDS.length) {
    invalid("MassGIS combined analysis layers are invalid");
  }
  const sourceSet = new Set();
  analysis.layers.forEach((item, index) => {
    const layer = record(item, `MassGIS combined layer ${index + 1}`);
    exactKeys(layer, ["slug", "title", "sourceId", "style"], "MassGIS combined layer");
    const [expectedSlug, expectedField, expectedPreset] = EXPECTED_COMBINED_FIELDS[index];
    if (slug(layer.slug, "MassGIS combined layer slug") !== expectedSlug) {
      invalid("MassGIS combined layer id is invalid");
    }
    text(layer.title, "MassGIS combined layer title", 160);
    reference(layer.sourceId, sourceIds, "MassGIS combined layer source");
    sourceSet.add(layer.sourceId);
    const style = record(layer.style, "MassGIS combined layer style");
    exactKeys(style, ["presetId", "field", "fieldAlias", "unit"], "MassGIS combined layer style");
    reference(style.presetId, presetIds, "MassGIS combined layer style preset");
    fieldName(style.field, "MassGIS combined layer style field");
    text(style.fieldAlias, "MassGIS combined layer field alias", 300);
    text(style.unit, "MassGIS combined layer unit", 80);
    if (style.field !== expectedField || style.presetId !== expectedPreset) {
      invalid(`MassGIS combined layer ${layer.slug} field metadata is invalid`);
    }
  });
  if (sourceSet.size !== 1 || !sourceSet.has(SOURCE_ID)) {
    invalid("MassGIS combined analysis must compose one shared source");
  }
}

function sourceFields(config) {
  const fields = new Set(config.sources[0].identityFields);
  for (const group of config.indicatorGroups) {
    for (const map of group.maps) {
      fields.add(map.style.sourceField);
      fields.add(map.style.field);
    }
  }
  for (const layer of config.combinedAnalysis.layers) fields.add(layer.style.field);
  return [...fields];
}

function sourceFieldContract(config, expectedFields) {
  const identityFields = new Set(config.sources[0].identityFields);
  const rawSourceFields = new Set();
  const renderingFields = new Set();
  for (const group of config.indicatorGroups) {
    for (const map of group.maps) {
      rawSourceFields.add(map.style.sourceField);
      renderingFields.add(map.style.field);
    }
  }
  for (const layer of config.combinedAnalysis.layers) renderingFields.add(layer.style.field);

  const classifiedFields = new Set([...identityFields, ...rawSourceFields, ...renderingFields]);
  if (classifiedFields.size !== expectedFields.size
    || [...expectedFields].some((field) => !classifiedFields.has(field))
    || renderingFields.size !== 33) {
    invalid("MassGIS requested-field contract is invalid");
  }
  return {identityFields, rawSourceFields, renderingFields};
}

function referenceLoaderSettings(value, archive) {
  const options = record(value, "MassGIS reference loader options");
  onlyKeys(options, ["archiveUrl", "archiveRequired", "fetchImpl", "timeoutMilliseconds", "signal"], "MassGIS reference loader options");
  const fetchImpl = options.fetchImpl
    ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined);
  if (typeof fetchImpl !== "function") invalid("MassGIS reference loader fetch implementation is required");
  const timeoutMilliseconds = boundedInteger(
    options.timeoutMilliseconds ?? MASSGIS_DEMO_LIMITS.defaultTimeoutMilliseconds,
    1,
    MASSGIS_DEMO_LIMITS.maximumTimeoutMilliseconds,
    "MassGIS reference loader timeout"
  );
  if (options.signal !== undefined && (!options.signal || typeof options.signal.aborted !== "boolean"
    || typeof options.signal.addEventListener !== "function"
    || typeof options.signal.removeEventListener !== "function")) invalid("MassGIS reference loader signal is invalid");
  return {
    archiveUrl: options.archiveUrl ? String(options.archiveUrl) : archivePublicUrl(archive),
    archiveRequired: options.archiveRequired !== false,
    fetchImpl,
    timeoutMilliseconds,
    signal: options.signal
  };
}

async function loadMassgisArchiveGeojson(config, settings) {
  const source = config.sources[0];
  const archive = source.archive;
  const requestUrl = archiveRequestUrl(settings.archiveUrl, archive);
  const response = await withRequestBoundary(
    (signal) => settings.fetchImpl(requestUrl, {
      method: "GET",
      headers: {accept: "application/gzip, application/octet-stream;q=0.9"},
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "force-cache",
      signal
    }),
    settings.timeoutMilliseconds,
    settings.signal
  );
  if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
    invalid(`MassGIS archive request failed with HTTP ${response?.status ?? "unknown"}`);
  }
  if (response.url && response.url !== requestUrl) invalid("MassGIS archive response URL did not match the requested URL");
  const contentType = String(response.headers?.get?.("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (!["application/gzip", "application/x-gzip", "application/octet-stream"].includes(contentType)) {
    invalid("MassGIS archive response content type is invalid");
  }
  const compressed = await readBoundedBody(response, archive.compressedBytes);
  if (compressed.byteLength !== archive.compressedBytes
    || await sha256Hex(compressed) !== archive.compressedSha256) {
    invalid("MassGIS archive compressed artifact did not match its checksum");
  }
  let raw;
  try {
    raw = gunzipSync(compressed);
  } catch {
    invalid("MassGIS archive could not be decompressed");
  }
  if (raw.byteLength !== archive.uncompressedBytes
    || raw.byteLength > MASSGIS_DEMO_LIMITS.absoluteMaximumResponseBytes
    || await sha256Hex(raw) !== archive.uncompressedSha256) {
    invalid("MassGIS archive content did not match its checksum");
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    invalid("MassGIS archive is not valid JSON");
  }
  const fields = Object.freeze(sourceFields(config));
  const observedFields = new Set();
  const parsed = validateFeatureCollection(value, {
    expectedFields: new Set(fields),
    objectIdField: source.objectIdField,
    requestedCount: archive.featureCount,
    coordinateBudget: {positions: 0},
    fieldContract: sourceFieldContract(config, new Set(fields)),
    observedFields
  });
  if (parsed.features.length !== archive.featureCount
    || observedFields.size !== fields.length
    || parsed.exceededTransferLimit !== null) {
    invalid("MassGIS archive feature inventory is invalid");
  }
  const objectIds = new Set(parsed.features.map(({properties}) => properties[source.objectIdField]));
  if (objectIds.size !== parsed.features.length) invalid("MassGIS archive contains duplicate object ids");
  return {
    type: "FeatureCollection",
    features: parsed.features,
    opengeo: Object.freeze({
      schemaVersion: "opengeo.massgis-geojson-receipt.2.0.0",
      itemId: source.itemId,
      sourceId: source.id,
      sourceMode: "aws-archive",
      authoritativeUrl: source.layerUrl,
      archiveObjectKey: archive.objectKey,
      archiveRetrievedAt: archive.retrievedAt,
      archiveSha256: archive.uncompressedSha256,
      attribution: source.attribution,
      pageCount: archive.pageCount,
      featureCount: parsed.features.length,
      responseBytes: raw.byteLength,
      outSpatialReference: source.outSpatialReference,
      fields,
      requestedFields: fields,
      observedFields: fields
    })
  };
}

function archiveRequestUrl(value, archiveRecord) {
  if (typeof value !== "string" || !value || value.length > 2_048) invalid("MassGIS archive URL is invalid");
  let url;
  try {
    url = new URL(value);
  } catch {
    invalid("MassGIS archive URL is invalid");
  }
  if (url.href !== archivePublicUrl(archiveRecord)) {
    invalid("MassGIS archive URL is outside the reviewed artifact path");
  }
  return url.href;
}

function archivePublicUrl(archive) {
  // The bucket name contains a dot, so a virtual-host URL would not match the
  // regional S3 wildcard certificate. Path-style addressing retains ordinary
  // TLS hostname verification for anonymous browser reads.
  return `https://s3.${MASSGIS_ARCHIVE_REGION}.amazonaws.com/${MASSGIS_ARCHIVE_BUCKET}/${archive.objectKey}`;
}

async function sha256Hex(value) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) invalid("MassGIS archive checksum support is unavailable");
  const digest = new Uint8Array(await subtle.digest("SHA-256", value));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function loaderSettings(value, source) {
  const options = record(value, "MassGIS loader options");
  onlyKeys(options, [
    "fetchImpl", "pageSize", "maximumFeatures", "maximumResponseBytes",
    "maximumTotalResponseBytes", "timeoutMilliseconds", "signal"
  ], "MassGIS loader options");
  const fetchImpl = options.fetchImpl
    ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined);
  if (typeof fetchImpl !== "function") invalid("MassGIS loader fetch implementation is required");
  const pageSize = boundedInteger(
    options.pageSize ?? MASSGIS_DEMO_LIMITS.defaultPageSize,
    1,
    Math.min(source.maximumRecordCount, MASSGIS_DEMO_LIMITS.maximumPageSize),
    "MassGIS loader page size"
  );
  const maximumFeatures = boundedInteger(
    options.maximumFeatures ?? MASSGIS_DEMO_LIMITS.defaultMaximumFeatures,
    1,
    MASSGIS_DEMO_LIMITS.absoluteMaximumFeatures,
    "MassGIS loader maximum feature count"
  );
  const maximumPageCount = Math.ceil(maximumFeatures / pageSize) + 1;
  if (maximumPageCount > MASSGIS_DEMO_LIMITS.maximumPageCount) {
    invalid("MassGIS loader page-size and feature limits require too many requests");
  }
  const maximumResponseBytes = boundedInteger(
    options.maximumResponseBytes ?? MASSGIS_DEMO_LIMITS.defaultMaximumResponseBytes,
    1_024,
    MASSGIS_DEMO_LIMITS.absoluteMaximumResponseBytes,
    "MassGIS loader maximum response bytes"
  );
  const maximumTotalResponseBytes = boundedInteger(
    options.maximumTotalResponseBytes ?? MASSGIS_DEMO_LIMITS.defaultMaximumTotalResponseBytes,
    maximumResponseBytes,
    MASSGIS_DEMO_LIMITS.absoluteMaximumTotalResponseBytes,
    "MassGIS loader maximum total response bytes"
  );
  const timeoutMilliseconds = boundedInteger(
    options.timeoutMilliseconds ?? MASSGIS_DEMO_LIMITS.defaultTimeoutMilliseconds,
    1,
    MASSGIS_DEMO_LIMITS.maximumTimeoutMilliseconds,
    "MassGIS loader timeout"
  );
  if (options.signal !== undefined && (!options.signal || typeof options.signal.aborted !== "boolean"
    || typeof options.signal.addEventListener !== "function"
    || typeof options.signal.removeEventListener !== "function")) invalid("MassGIS loader signal is invalid");
  return {
    fetchImpl,
    pageSize,
    maximumFeatures,
    maximumPageCount,
    maximumResponseBytes,
    maximumTotalResponseBytes,
    timeoutMilliseconds,
    signal: options.signal
  };
}

function buildQueryUrl(source, fields, resultOffset, resultRecordCount) {
  const url = new URL(source.queryUrl);
  url.searchParams.set("where", "1=1");
  url.searchParams.set("outFields", fields.join(","));
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("returnZ", "false");
  url.searchParams.set("returnM", "false");
  url.searchParams.set("outSR", String(source.outSpatialReference));
  url.searchParams.set("geometryPrecision", "5");
  url.searchParams.set("orderByFields", `${source.objectIdField} ASC`);
  url.searchParams.set("resultOffset", String(resultOffset));
  url.searchParams.set("resultRecordCount", String(resultRecordCount));
  url.searchParams.set("returnExceededLimitFeatures", "true");
  url.searchParams.set("f", "geojson");
  return url.href;
}

async function fetchGeojsonPage(fetchImpl, requestUrl, signal, maximumResponseBytes) {
  const response = await fetchImpl(requestUrl, {
    method: "GET",
    headers: {accept: "application/geo+json, application/json;q=0.9"},
    mode: "cors",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    signal
  });
  if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
    invalid(`MassGIS request failed with HTTP ${response?.status ?? "unknown"}`);
  }
  if (response.url && response.url !== requestUrl) invalid("MassGIS response URL did not match the requested URL");
  const contentType = String(response.headers?.get?.("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (!["application/geo+json", "application/json", "application/vnd.geo+json", "text/json"].includes(contentType)) {
    invalid("MassGIS response content type is not GeoJSON");
  }
  const body = await readBoundedBody(response, maximumResponseBytes);
  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(body));
  } catch {
    invalid("MassGIS response is not valid JSON");
  }
  if (value?.error) invalid("MassGIS service returned an ArcGIS error response");
  return {value, byteLength: body.byteLength};
}

async function readBoundedBody(response, maximumResponseBytes) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumResponseBytes) {
    invalid("MassGIS response exceeded the per-page byte limit");
  }
  if (!response.body?.getReader) {
    if (typeof response.arrayBuffer !== "function") invalid("MassGIS response body is unavailable");
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > maximumResponseBytes) invalid("MassGIS response exceeded the per-page byte limit");
    return body;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) invalid("MassGIS response stream is invalid");
    length += value.byteLength;
    if (length > maximumResponseBytes) {
      await reader.cancel();
      invalid("MassGIS response exceeded the per-page byte limit");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function validateFeatureCollection(value, {
  expectedFields,
  objectIdField,
  requestedCount,
  coordinateBudget,
  fieldContract,
  observedFields
}) {
  const collection = record(value, "MassGIS GeoJSON response");
  onlyKeys(collection, ["type", "features", "bbox", "crs", "exceededTransferLimit", "properties"], "MassGIS GeoJSON response");
  if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features)
    || collection.features.length > requestedCount) invalid("MassGIS GeoJSON FeatureCollection is invalid");
  if (collection.bbox !== undefined) validateBbox(collection.bbox, "MassGIS GeoJSON bbox");
  if (collection.crs !== undefined) validateGeojsonCrs(collection.crs);
  const exceededTransferLimit = transferLimitFlag(collection);
  const features = collection.features.map((item, index) => validateFeature(item, {
    expectedFields,
    objectIdField,
    coordinateBudget,
    fieldContract,
    observedFields,
    label: `MassGIS GeoJSON feature ${index + 1}`
  }));
  return {features, exceededTransferLimit};
}

function validateGeojsonCrs(value) {
  const crs = record(value, "MassGIS GeoJSON CRS");
  onlyKeys(crs, ["type", "properties"], "MassGIS GeoJSON CRS");
  if (crs.type !== "name") invalid("MassGIS GeoJSON CRS is invalid");
  const properties = record(crs.properties, "MassGIS GeoJSON CRS properties");
  onlyKeys(properties, ["name"], "MassGIS GeoJSON CRS properties");
  if (properties.name !== "EPSG:4326") invalid("MassGIS GeoJSON CRS must be EPSG:4326");
}

function transferLimitFlag(collection) {
  let top = null;
  if (collection.exceededTransferLimit !== undefined) {
    if (typeof collection.exceededTransferLimit !== "boolean") invalid("MassGIS transfer-limit flag is invalid");
    top = collection.exceededTransferLimit;
  }
  let nested = null;
  if (collection.properties !== undefined) {
    const properties = record(collection.properties, "MassGIS GeoJSON collection properties");
    onlyKeys(properties, ["exceededTransferLimit"], "MassGIS GeoJSON collection properties");
    if (properties.exceededTransferLimit !== undefined) {
      if (typeof properties.exceededTransferLimit !== "boolean") invalid("MassGIS transfer-limit flag is invalid");
      nested = properties.exceededTransferLimit;
    }
  }
  if (top !== null && nested !== null && top !== nested) invalid("MassGIS transfer-limit flags conflict");
  return top ?? nested;
}

function validateFeature(value, {
  expectedFields,
  objectIdField,
  coordinateBudget,
  fieldContract,
  observedFields,
  label
}) {
  const feature = record(value, label);
  onlyKeys(feature, ["type", "id", "geometry", "properties", "bbox"], label);
  if (feature.type !== "Feature") invalid(`${label} type is invalid`);
  if (feature.id !== undefined && !primitive(feature.id)) invalid(`${label} id is invalid`);
  if (feature.bbox !== undefined) validateBbox(feature.bbox, `${label} bbox`);
  const properties = record(feature.properties, `${label} properties`);
  if (!Object.hasOwn(properties, objectIdField)) invalid(`${label} object id is missing`);
  if (!Number.isSafeInteger(properties[objectIdField]) || properties[objectIdField] < 0) {
    invalid(`${label} object id is invalid`);
  }
  for (const key of Object.keys(properties)) {
    if (!expectedFields.has(key)) invalid(`${label} property ${key} is invalid`);
  }
  for (const key of expectedFields) {
    if (!Object.hasOwn(properties, key)) invalid(`${label} property ${key} is missing`);
    const item = properties[key];
    observedFields.add(key);
    if (key === objectIdField) continue;
    if (fieldContract.renderingFields.has(key)) {
      if (item !== null && (typeof item !== "number" || !Number.isFinite(item) || item < 0 || item > 100)) {
        invalid(`${label} rendering property ${key} must be null or a finite number from 0 through 100`);
      }
      continue;
    }
    if (fieldContract.identityFields.has(key)) {
      if (item === null && NULLABLE_IDENTITY_FIELDS.has(key)) continue;
      if (typeof item !== "string" || item.length > MAXIMUM_IDENTITY_STRING_LENGTH) {
        invalid(`${label} identity property ${key} is invalid`);
      }
      continue;
    }
    if (!fieldContract.rawSourceFields.has(key) || !boundedPrimitive(item)) {
      invalid(`${label} raw source property ${key} is invalid`);
    }
  }
  validatePolygonGeometry(feature.geometry, coordinateBudget, `${label} geometry`);
  return feature;
}

function validatePolygonGeometry(value, coordinateBudget, label) {
  if (value === null) invalid(`${label} must be a Polygon or MultiPolygon`);
  const geometry = record(value, label);
  onlyKeys(geometry, ["type", "coordinates", "bbox"], label);
  if (geometry.bbox !== undefined) validateBbox(geometry.bbox, `${label} bbox`);
  if (geometry.type === "Polygon") {
    validatePolygonCoordinates(geometry.coordinates, coordinateBudget, label);
    return;
  }
  if (geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates) && geometry.coordinates.length) {
    geometry.coordinates.forEach((polygon, index) => validatePolygonCoordinates(
      polygon,
      coordinateBudget,
      `${label} polygon ${index + 1}`
    ));
    return;
  }
  invalid(`${label} must be a Polygon or MultiPolygon`);
}

function validatePolygonCoordinates(value, coordinateBudget, label) {
  if (!Array.isArray(value) || !value.length) invalid(`${label} coordinates are invalid`);
  value.forEach((ring, ringIndex) => {
    if (!Array.isArray(ring) || ring.length < 4) invalid(`${label} ring ${ringIndex + 1} is invalid`);
    ring.forEach((position, positionIndex) => validatePosition(
      position,
      coordinateBudget,
      `${label} ring ${ringIndex + 1} position ${positionIndex + 1}`
    ));
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) invalid(`${label} ring ${ringIndex + 1} is not closed`);
  });
}

function validatePosition(value, coordinateBudget, label) {
  if (!Array.isArray(value) || value.length !== 2) invalid(`${label} is invalid`);
  boundedNumber(value[0], -180, 180, `${label} longitude`);
  boundedNumber(value[1], -90, 90, `${label} latitude`);
  coordinateBudget.positions += 1;
  if (coordinateBudget.positions > MASSGIS_DEMO_LIMITS.maximumCoordinatePositions) {
    invalid("MassGIS response exceeded the coordinate-position limit");
  }
}

function validateBbox(value, label) {
  if (!Array.isArray(value) || value.length !== 4) invalid(`${label} is invalid`);
  value.forEach((item, index) => boundedNumber(item, index % 2 === 0 ? -180 : -90, index % 2 === 0 ? 180 : 90, label));
  if (value[0] > value[2] || value[1] > value[3]) invalid(`${label} is invalid`);
}

async function withRequestBoundary(task, timeoutMilliseconds, externalSignal) {
  const controller = new AbortController();
  let timer;
  let removeExternalAbort = () => {};
  let timedOut = false;
  const boundary = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(loaderError("MassGIS request timed out", "massgis_request_timeout"));
    }, timeoutMilliseconds);
    if (externalSignal) {
      const cancel = () => {
        controller.abort();
        reject(abortError("MassGIS request was cancelled"));
      };
      if (externalSignal.aborted) cancel();
      else {
        externalSignal.addEventListener("abort", cancel, {once: true});
        removeExternalAbort = () => externalSignal.removeEventListener("abort", cancel);
      }
    }
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => task(controller.signal)),
      boundary
    ]);
  } catch (error) {
    if (timedOut) throw loaderError("MassGIS request timed out", "massgis_request_timeout");
    if (externalSignal?.aborted) throw abortError("MassGIS request was cancelled");
    throw error;
  } finally {
    clearTimeout(timer);
    removeExternalAbort();
  }
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((item, index) => item !== required[index])) {
    invalid(`${label} has unexpected fields`);
  }
}

function onlyKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) invalid(`${label} has unexpected field ${unknown}`);
}

function text(value, label, maximumLength) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()
    || value.length > maximumLength || /[\r\n]/.test(value)) invalid(`${label} is invalid`);
  return value;
}

function slug(value, label) {
  const result = text(value, label, 100);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result)) invalid(`${label} is invalid`);
  return result;
}

function fieldName(value, label) {
  const result = text(value, label, 80);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(result)) invalid(`${label} is invalid`);
  return result;
}

function hexSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) invalid(`${label} is invalid`);
  return value;
}

function reference(value, allowed, label) {
  if (typeof value !== "string" || !allowed.has(value)) invalid(`${label} is invalid`);
  return value;
}

function publicHttpsUrl(value, label, {allowQuery = true} = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    invalid(`${label} is invalid`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash
    || (url.port && url.port !== "443") || !/^[a-z0-9.-]+$/i.test(url.hostname)
    || (!allowQuery && url.search)) invalid(`${label} is invalid`);
  return url.href;
}

function date(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) invalid(`${label} is invalid`);
  return value;
}

function color(value, label) {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) invalid(`${label} is invalid`);
  return value;
}

function boundedNumber(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(`${label} is invalid`);
  return value;
}

function primitive(value) {
  return value === null || typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function boundedPrimitive(value) {
  return primitive(value)
    && (typeof value !== "string" || value.length <= MAXIMUM_PROPERTY_STRING_LENGTH)
    && (typeof value !== "number" || Math.abs(value) <= MAXIMUM_PROPERTY_NUMBER_MAGNITUDE);
}

function copyJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    invalid("MassGIS demo configuration is not JSON-compatible");
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function abortError(message) {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "massgis_request_cancelled";
  return error;
}

function loaderError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function invalid(message) {
  const error = new TypeError(message);
  error.code = "massgis_demo_invalid";
  throw error;
}
