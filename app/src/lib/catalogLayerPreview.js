import {registeredPreviewLayer} from "./catalogProjectSave.js";
import {readSourceMetadata, sourceLinks} from "../components/SourceDetails.js";
import {readProviderJson} from "./providerJson.js";
import {loadLiveFeaturePage} from "./liveFeatureSource.js";

// Session-memory only. Nothing is requested until the reader opens a preview.
export function createCatalogPreviewLoader({adapter, fetchImplementation = globalThis.fetch}) {
  const maps = new Map(), sources = new Map(), connections = new Map();
  function retained(cache, key, operation) {
    if (cache.has(key)) return cache.get(key);
    if (cache.size >= 8) cache.delete(cache.keys().next().value);
    const result = operation().catch(error => {cache.delete(key); throw error;});
    cache.set(key, result);
    return result;
  }
  return async record => {
    if (!record.mapId) {
      if ((!record.service && !record.resourcePreview) || typeof adapter.getSource !== "function") throw new Error("No registered live preview is available. Open metadata and access.");
      const expectedVersion = record.service?.sourceVersion ?? record.sourceVersion;
      const source = await retained(connections, `${record.projectId}/${record.datasetId}/${expectedVersion ?? "current"}`, async () => {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20_000);
        try {return await adapter.getSource(record.projectId, record.datasetId, {signal: controller.signal});}
        finally {clearTimeout(timer);}
      });
      if (source.datasetId !== record.datasetId || source.projectId !== record.projectId
        || expectedVersion != null && source.versionNumber !== expectedVersion || source.status !== "active"
        || source.credentialMode !== "none" || source.accessMode !== "direct_browser" || !source.capabilities?.read
        || !["arcgis", "wfs", "imageserver", "mapserver", "cog", "xyz"].includes(source.sourceType)) {
        throw new Error("The connection changed or is unavailable. Search the catalog again before previewing it.");
      }
      if (source.sourceType === "cog") return {kind: "cog", endpoint: source.sourceUrl, metadata: {},
        attribution: source.configuration.attribution, cog: source, layer: registeredPreviewLayer(source, record.title)};
      if (source.sourceType === "xyz") return {kind: "xyz", endpoint: source.sourceUrl, metadata: {},
        attribution: source.configuration.attribution, layer: registeredPreviewLayer(source, record.title)};
      const endpoint = livePreviewEndpoint(source);
      if (record.service?.layerUrl && endpoint !== record.service.layerUrl) throw new Error("The provider address changed. Search the catalog again.");
      if (source.sourceType === "wfs") return {...await previewWfs(endpoint, source.configuration), layer: registeredPreviewLayer(source, record.title)};
      const fields = source.sourceType === "arcgis" ? source.configuration.fields : [];
      return {...await preview(endpoint, fields, source.configuration.attribution, source.configuration), layer: registeredPreviewLayer(source, record.title)};
    }
    const map = await retained(maps, `${record.projectId}/${record.mapId}/${record.mapVersion}`, async () => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20_000);
      try {return await adapter.getMap(record.projectId, record.mapId, {signal: controller.signal});}
      finally {clearTimeout(timer);}
    });
    if (map.id !== record.mapId || map.projectId !== record.projectId || map.version !== record.mapVersion) {
      throw new Error("The map changed. Search the catalog again before previewing it.");
    }
    const layer = map.definition?.layers?.find(layer => layer.layerId === record.layerId
      && layer.datasetId === record.datasetId);
    if (!layer) throw new Error("This layer is no longer in the saved map. Reload the catalog.");
    if (layer.sourceType === "xyz-raster") return {kind: "xyz", endpoint: layer.sourceUrl, metadata: {},
      attribution: layer.sourceConfiguration.attribution, layer: structuredClone(layer)};
    if (layer.sourceType === "cog-raster") return {kind: "cog", endpoint: layer.sourceUrl, metadata: {},
      attribution: layer.attribution, cog: {sourceUrl: layer.sourceUrl, configuration: layer.sourceConfiguration}, layer: structuredClone(layer)};
    const endpoint = livePreviewEndpoint(layer);
    if (record.service?.kind === "WFS") return {...await previewWfs(endpoint, layer.sourceConfiguration, layer.bbox), layer: structuredClone(layer)};
    const fields = [...new Set(map.definition.layers.filter(candidate => candidate.datasetId === record.datasetId)
      .map(candidate => candidate.style?.graduated?.field).concat(record.styleField ?? [])
      .filter(field => typeof field === "string" && /^[a-zA-Z_][a-zA-Z_0-9]*$/.test(field)))].sort();
    return {...await preview(endpoint, fields, layer.sourceConfiguration?.attribution || layer.attribution, layer.sourceConfiguration), layer: structuredClone(layer)};
  };

  async function previewWfs(endpoint, configuration, bounds = [-180, -90, 180, 90]) {
    const geojson = await retained(sources, JSON.stringify(["wfs", endpoint, configuration, bounds]), () =>
      loadLiveFeaturePage({sourceType: "wfs", url: endpoint, configuration, bounds, fetchImpl: fetchImplementation}));
    return {kind: "features", metadata: {}, endpoint, geojson, complete: false,
      attribution: configuration.attribution || "Source credit not recorded",
      geometryNote: "One bounded WFS display page in CRS84. Features outside this page may be omitted; this is not an original-data export."};
  }

  async function preview(endpoint, fields, attribution, configuration) {
    const result = await retained(sources, JSON.stringify([endpoint, fields, configuration]), async () => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25_000);
      try {return await loadProviderPreview(endpoint, {fetchImplementation, signal: controller.signal, fields, configuration});}
      finally {clearTimeout(timer);}
    });
    return {...result, endpoint, attribution: result.metadata.copyrightText || attribution || "Source credit not recorded"};
  }
}

export function livePreviewEndpoint(layer) {
  // For a retained GeoJSON layer, only its explicitly recorded authoritative
  // endpoint is eligible. Never substitute sourceUrl (the archived object).
  const candidate = layer.sourceType === "geojson-archive"
    ? layer.sourceConfiguration?.authoritativeUrl : layer.sourceUrl;
  if (typeof candidate !== "string") throw new Error("No live preview endpoint is recorded. Open metadata and access for this dataset.");
  const url = new URL(candidate);
  if (url.search || url.hash || url.port && url.port !== "443"
    || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname)
    || /\.(?:localhost|local|internal)$/i.test(url.hostname)) throw new Error("This endpoint is not eligible for a credential-free public preview.");
  const endpoint = sourceLinks(candidate).provider;
  if (layer.sourceType === "wfs" || layer.sourceType === "external-feature-reference" && layer.sourceConfiguration?.typeName) {
    if (!/^\/[A-Za-z0-9_./~-]+$/.test(url.pathname)) throw new Error("This WFS endpoint is not eligible for preview.");
    return endpoint.replace(/\/$/, "");
  }
  if (!/\/(?:(?:FeatureServer|MapServer)\/\d+|ImageServer|MapServer)\/?$/i.test(new URL(endpoint).pathname)) {
    throw new Error("Quick preview currently supports live ArcGIS feature layers, ImageServers and MapServers. Open the map for this source.");
  }
  return endpoint.replace(/\/$/, "");
}

export async function loadProviderPreview(endpoint, {fetchImplementation, signal, fields = [], configuration} = {}) {
  const read = url => readSourceMetadata(url, {fetchImplementation, signal});
  const metadata = await read(`${endpoint}?f=json`);
  if (/\/(?:ImageServer|MapServer)$/i.test(endpoint)) {
    const extent = metadata.initialExtent ?? metadata.extent ?? metadata.fullExtent;
    const bbox = extent && [extent.xmin, extent.ymin, extent.xmax, extent.ymax];
    const sr = extent?.spatialReference?.latestWkid ?? extent?.spatialReference?.wkid;
    if (!bbox?.every(Number.isFinite) || !Number.isInteger(sr) || sr <= 0
      || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) throw new Error("The service has no usable preview extent.");
    const mapServer = /\/MapServer$/i.test(endpoint);
    const selected = configuration?.layerIds;
    if (mapServer && (!Array.isArray(selected) || !selected.length || selected.length > 32
      || selected.some(id => !Number.isInteger(id) || id < 0 || id > 1000000)
      || new Set(selected).size !== selected.length)) throw new Error("A MapServer preview needs reviewed layer IDs.");
    const image = new URL(`${endpoint}/${mapServer ? "export" : "exportImage"}`);
    image.search = new URLSearchParams({f: "image", bbox: bbox.join(","), bboxSR: String(sr),
      imageSR: String(sr), size: "800,450", format: "png32", transparent: "true",
      ...(mapServer ? {layers: `show:${selected.join(",")}`} : {})});
    return {kind: "image", metadata, imageUrl: image.href};
  }
  if (!String(metadata.capabilities ?? "").split(",").some(x => x.trim().toLowerCase() === "query")
    || !String(metadata.supportedQueryFormats ?? "").split(",").some(x => x.trim().toLowerCase() === "geojson")) {
    throw new Error("The provider does not advertise GeoJSON queries for this layer.");
  }
  const oid = metadata.objectIdField ?? metadata.fields?.find(f => f.type === "esriFieldTypeOID")?.name;
  if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(oid ?? "")) throw new Error("The provider has no usable object identifier.");
  if (fields.length > 128 || fields.some(field => !/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(field)
    || !metadata.fields?.some(candidate => candidate.name === field))) {
    throw new Error("A preview field is missing from the live source. Review the layer metadata.");
  }
  const outFields = [...new Set([oid, ...fields])].join(",");
  const pageSize = Math.min(1000, Math.max(1, Number(metadata.maxRecordCount) || 1000));
  if (metadata.advancedQueryCapabilities?.supportsPagination === false) {
    const geometryType = {esriGeometryPoint: "Point", esriGeometryMultipoint: "MultiPoint",
      esriGeometryPolyline: "MultiLineString", esriGeometryPolygon: "MultiPolygon"}[metadata.geometryType];
    const extent = metadata.extent;
    const sr = extent?.spatialReference?.latestWkid ?? extent?.spatialReference?.wkid;
    let bounds = extent && [extent.xmin, extent.ymin, extent.xmax, extent.ymax];
    if (!bounds?.every(Number.isFinite) || ![4326, 3857, 102100, 102113].includes(sr)) {
      throw new Error("The non-paginated service has no supported preview extent.");
    }
    if (sr !== 4326) {
      const lat = y => Math.atan(Math.sinh(y / 6378137)) * 180 / Math.PI;
      bounds = [bounds[0] / 6378137 * 180 / Math.PI, lat(bounds[1]), bounds[2] / 6378137 * 180 / Math.PI, lat(bounds[3])];
    }
    const geojson = await loadLiveFeaturePage({sourceType: "arcgis", url: endpoint,
      configuration: {objectIdField: oid, fields: outFields.split(","), geometryType, pageSize,
        attribution: metadata.copyrightText || null}, bounds,
      fetchImpl: fetchImplementation, signal, arcgisMetadata: metadata});
    return {kind: "features", metadata, geojson, complete: !geojson.opengeo.mayBeTruncated,
      observedAt: new Date().toISOString(), geometryNote: "Bounded live features selected by object ID; not an original-data export."};
  }
  const features = [], ids = new Set();
  let remainingBytes = 16 * 1024 * 1024;
  let complete = false;
  for (let page = 0; page < 6; page++) {
    signal?.throwIfAborted();
    const url = new URL(`${endpoint}/query`);
    url.search = new URLSearchParams({f: "geojson", where: "1=1", outFields, outSR: "4326",
      returnGeometry: "true",
      orderByFields: `${oid} ASC`, resultOffset: String(features.length), resultRecordCount: String(pageSize)});
    if (remainingBytes <= 0) break;
    let response;
    try {
      response = await readProviderJson(url.href, {fetchImplementation, signal,
        maxBytes: Math.min(8 * 1024 * 1024, remainingBytes), label: "Preview geometry"});
    } catch (error) {
      if (error.code === "provider_response_too_large" && features.length) break;
      throw error;
    }
    remainingBytes -= response.bytes;
    const result = response.data;
    if (result.type !== "FeatureCollection" || !Array.isArray(result.features)
      || result.features.length > pageSize) throw new Error("The source returned an invalid preview page.");
    for (const feature of result.features) {
      const id = feature.properties?.[oid] ?? feature.id;
      if (id === undefined || ids.has(id)) throw new Error("The source returned missing or repeated identifiers; preview stopped.");
      ids.add(id); features.push(feature);
    }
    if (result.exceededTransferLimit !== true && result.features.length < pageSize) {complete = true; break;}
    if (metadata.advancedQueryCapabilities?.supportsPagination !== true) break;
  }
  return {kind: "features", metadata, geojson: {type: "FeatureCollection", features}, complete,
    observedAt: new Date().toISOString(), geometryNote: "Provider geometry without requested simplification or coordinate rounding; bounded preview, not an original-data export."};
}
