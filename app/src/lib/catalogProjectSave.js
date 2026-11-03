import {emptyMapDefinition, STYLE_MAP_DEFINITION_SCHEMA_VERSION} from "./mapDefinition.js";
import {mapServerTileUrl} from "./mapServer.js";
import {imageServerTileUrl} from "./imageServer.js";
import {wmsTileUrl} from "./wmsSource.js";

export function registeredPreviewLayer(source, title) {
  if (!["arcgis", "wfs", "wms", "imageserver", "mapserver", "cog", "xyz", "geojson"].includes(source.sourceType)) throw Error("Unsupported preview source");
  const configuration = structuredClone(source.configuration);
  return {layerId: `source_${source.datasetId}`, datasetId: source.datasetId, title: title || source.name,
    sourceType: source.sourceType === "geojson" ? "geojson-archive" : ["arcgis", "wfs"].includes(source.sourceType) ? "external-feature-reference" : `${source.sourceType}-raster`,
    sourceVersion: source.versionNumber, sourceUrl: source.sourceUrl, sourceConfiguration: configuration,
    ...(["imageserver", "mapserver"].includes(source.sourceType) ? {tileUrl: (source.sourceType === "mapserver" ? mapServerTileUrl : imageServerTileUrl)(source.sourceUrl, configuration), tileSize: configuration.tileSize} : {}),
    ...(source.sourceType === "wms" ? {tileUrl: wmsTileUrl(source.sourceUrl, configuration), tileSize: configuration.tileSize} : {}),
    ...(source.sourceType === "xyz" ? {tileUrl: source.sourceUrl, tileSize: configuration.tileSize,
      minZoom: configuration.minZoom, maxZoom: configuration.maxZoom, scheme: configuration.scheme} : {}),
    attribution: configuration.attribution, governedSource: true, geometryType: configuration.geometryType ?? "Raster",
    bbox: configuration.bounds, visible: true, opacity: 1, order: 0, style: {}, labels: {enabled: false, field: null}};
}

// The same governed-dataset descriptor used by saved Projects, pinned to the
// original version verified by the preview reader. Download tickets stay local.
export function managedPreviewLayer(dataset, version, title) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const geometryType = String(version?.geometryType ?? "").replace(/^3D /, "").replace(/ ?Z$/, "");
  if (!uuid.test(dataset?.id) || !uuid.test(version?.id)
    || !Number.isSafeInteger(version.versionNumber) || version.versionNumber < 1
    || !["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"].includes(geometryType)) {
    throw Error("The selected Layer needs an exact vector dataset version.");
  }
  const style = geometryType.includes("Point") ? {circleColor: "#f97316", circleRadius: 6}
    : geometryType.includes("Polygon") ? {fill: "#22c55e", stroke: "#15803d", strokeWidth: 2}
    : {stroke: "#2563eb", strokeWidth: 3};
  return {layerId: `dataset_${dataset.id}_version_${version.id}`, datasetId: dataset.id,
    datasetVersionId: version.id, sourceVersion: version.versionNumber, sourceType: "governed-dataset",
    title: title || dataset.name, geometryType, ...(Array.isArray(version.extent) ? {bbox: structuredClone(version.extent)} : {}),
    visible: true, opacity: 1, order: 0, style, labels: {enabled: false, field: null}};
}

// Only deliberate Save calls this function. Source dataset identity and revision stay pinned.
export async function saveCatalogProject({adapter, record, layer, view, title, targetId = null, occurrenceId, creationKey = null, accessContainerId = record.projectId}) {
  if (!layer || layer.datasetId !== record.datasetId || !occurrenceId) throw Error("Layer identity changed. Reopen its preview.");
  const selected = {...structuredClone(layer), layerId: occurrenceId, visible: true};
  if (!targetId) {
    const definition = emptyMapDefinition({layers: [{...selected, order: 0}], activeLayerId: occurrenceId,
      mapViews: view ? [{...view, id: "default", title: "Default"}] : []});
    if (selected.styleReference) definition.schemaVersion = STYLE_MAP_DEFINITION_SCHEMA_VERSION;
    let linked = false;
    try {
      if (accessContainerId !== record.projectId) {
        const attached = await adapter.attachDataset(accessContainerId, record.datasetId);
        if (attached.id !== record.datasetId || attached.projectId !== accessContainerId) throw Error("Layer reference identity changed");
        linked = true;
      }
      return await adapter.createMap(accessContainerId, {name: title, definition, creationKey});
    } catch (error) {
      if (linked) error.catalogReferenceLinked = true;
      throw error;
    }
  }
  const target = await adapter.getComposition(targetId);
  if (target.id !== targetId || target.resourceType !== "project") throw Error("Project identity changed");
  const definition = structuredClone(target.definition);
  // A lost response can be retried without appending the same occurrence twice.
  const existing = definition.layers.find(candidate => candidate.layerId === occurrenceId);
  if (existing) {
    if (existing.datasetId !== record.datasetId) throw Error("Layer occurrence identity changed");
    return target;
  }
  selected.order = Math.max(-1, ...definition.layers.map(candidate => Number(candidate.order) || 0)) + 1;
  definition.layers.push(selected);
  definition.activeLayerId = occurrenceId;
  if (selected.styleReference) definition.schemaVersion = STYLE_MAP_DEFINITION_SCHEMA_VERSION;
  const projectId = target.accessContainerId;
  let linked = false;
  try {
    if (projectId !== record.projectId) {
      const attached = await adapter.attachDataset(projectId, record.datasetId);
      if (attached.id !== record.datasetId || attached.projectId !== projectId) throw Error("Layer reference identity changed");
      linked = true;
    }
    return await adapter.updateMap(projectId, targetId, {expectedVersion: target.version,
      changes: {definition}, changeMessage: `Add catalog Layer: ${record.title}`});
  } catch (error) {
    if (linked) error.catalogReferenceLinked = true;
    throw error;
  }
}
