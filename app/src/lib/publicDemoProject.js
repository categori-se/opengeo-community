import {validateMassgisDemoConfig} from "./massgisDemo.js";

export const COMMUNITY_DEMO_PAGE_ID = "community-facilities";
export const MASSGIS_PAGE_PREFIX = "massgis-";

const DEMO_TENANT_ID = "public";
const COMMUNITY_WORKSPACE_ID = "public-opengeo-workbench-demo";
const DEFAULT_UPDATED_AT = "2026-08-28T00:00:00Z";

export function publicDemoPageIds(massgisValue) {
  const massgis = validateMassgisDemoConfig(massgisValue);
  return Object.freeze([
    COMMUNITY_DEMO_PAGE_ID,
    massgisPageId(massgis.combinedAnalysis.slug),
    ...massgis.indicatorGroups.flatMap(({maps}) => maps.map(({slug}) => massgisPageId(slug)))
  ]);
}

export function resolvePublicDemoPageId(value, massgisValue) {
  const allowed = new Set(publicDemoPageIds(massgisValue));
  return typeof value === "string" && allowed.has(value) ? value : COMMUNITY_DEMO_PAGE_ID;
}

export function publicDemoNavigation(massgisValue, activePageId, onSelectPage) {
  const massgis = validateMassgisDemoConfig(massgisValue);
  const massgisActive = activePageId.startsWith(MASSGIS_PAGE_PREFIX);
  const nodes = [
    {
      kind: "page",
      id: COMMUNITY_DEMO_PAGE_ID,
      title: "OpenGeo.Tools starter map",
      summary: "Community facilities and immediate map tools"
    },
    {
      kind: "group",
      id: "massgis",
      title: "MassGIS",
      open: massgisActive,
      children: [{
        kind: "group",
        id: "massgis-massenviroscreen",
        title: massgis.collection.title,
        open: massgisActive,
        children: [
          {
            kind: "page",
            id: massgisPageId(massgis.combinedAnalysis.slug),
            title: massgis.combinedAnalysis.title,
            summary: "Three shared-source screening measures"
          },
          ...massgis.indicatorGroups.map((group) => ({
            kind: "group",
            id: group.slug,
            title: group.title,
            open: group.maps.some(({slug}) => massgisPageId(slug) === activePageId),
            children: group.maps.map((map) => ({
              kind: "page",
              id: massgisPageId(map.slug),
              title: map.title,
              summary: map.summary
            }))
          }))
        ]
      }]
    }
  ];
  return Object.freeze({
    title: "Example projects",
    open: activePageId === COMMUNITY_DEMO_PAGE_ID,
    activePageId,
    pageCount: 32,
    workspaceOptions: Object.freeze([
      Object.freeze({
        workspaceId: COMMUNITY_WORKSPACE_ID,
        pageId: COMMUNITY_DEMO_PAGE_ID,
        title: "OpenGeo.Tools starter map"
      }),
      Object.freeze({
        workspaceId: massgis.project.id,
        pageId: massgisPageId(massgis.combinedAnalysis.slug),
        title: massgis.project.title
      })
    ]),
    mapOptions: Object.freeze([
      Object.freeze({
        pageId: massgisPageId(massgis.combinedAnalysis.slug),
        title: massgis.combinedAnalysis.title,
        group: "Combined screening layers"
      }),
      ...massgis.indicatorGroups.flatMap((group) => group.maps.map((map) => Object.freeze({
        pageId: massgisPageId(map.slug),
        title: map.title,
        group: group.title
      })))
    ]),
    nodes,
    onSelectPage
  });
}

export function communityDemoPresentation({catalog, geojson}) {
  const publication = catalog?.entries?.find(({id}) => id === "public-community-facilities");
  const source = publication?.sourceFiles?.[0];
  assertFeatureCollection(geojson);
  if (!publication || !source) throw new TypeError("public community demo metadata is invalid");

  const workspace = workspaceRecord({
    workspaceId: COMMUNITY_WORKSPACE_ID,
    title: "OpenGeo.Tools starter map",
    description: "Anonymous GIS workbench with reviewed public data and browser-only local changes."
  });
  const dataset = datasetRecord({
    datasetId: publication.id,
    workspace,
    title: publication.title,
    description: publication.summary,
    geojson,
    license: source.license,
    attribution: source.attribution,
    publicSourcePath: source.path
  });
  const layer = {
    layerId: "public_demo_facilities",
    datasetId: dataset.datasetId,
    title: publication.title,
    sourceType: "geojson-object",
    geometryType: dataset.geometryType,
    visible: true,
    opacity: 0.9,
    order: 0,
    fixtureSource: true,
    style: {circleColor: "#f97316", circleRadius: 7, renderer: "single"},
    labels: {enabled: true, field: "name"}
  };
  return presentationRecord({
    pageId: COMMUNITY_DEMO_PAGE_ID,
    workspace,
    datasets: [dataset],
    layers: [layer],
    geojsonByLayerId: new Map([[layer.layerId, geojson]]),
    project: projectRecord({
      workspace,
      layers: [layer],
      view: {center: [-77.04, 38.91], zoom: 12, pitch: 0, bearing: 0},
      bookmarks: [{bookmarkId: "public_demo_extent", title: "Demo extent", center: [-77.04, 38.91], zoom: 12}]
    }),
    publication,
    source,
    noticeTitle: "Public OpenGeo Studio workbench",
    noticeSummary: "Explore, style, measure, process, and open local GIS files. Your local changes stay in this browser and reset daily."
  });
}

export function massgisDemoPresentation({catalog, massgis: massgisValue, geojson, pageId}) {
  const massgis = validateMassgisDemoConfig(massgisValue);
  const publication = catalog?.entries?.find(({id}) => id === "massgis-massenviroscreen");
  const source = publication?.sourceFiles?.[0];
  assertFeatureCollection(geojson);
  if (!publication || !source) throw new TypeError("MassGIS public demo metadata is invalid");
  const selected = findMassgisMap(massgis, pageId);
  if (!selected) throw new TypeError("MassGIS public demo page is invalid");

  const workspace = workspaceRecord({
    workspaceId: massgis.project.id,
    title: massgis.project.title,
    description: massgis.project.summary,
    updatedAt: `${massgis.collection.version.serviceDataLastEditedDate}T00:00:00Z`
  });
  const dataset = datasetRecord({
    datasetId: massgis.sources[0].id,
    workspace,
    title: massgis.collection.title,
    description: massgis.collection.summary,
    geojson,
    license: massgis.collection.license.name,
    attribution: massgis.collection.attribution,
    publicSourcePath: massgis.sources[0].layerUrl
  });
  const combinedDefinitions = [...massgis.combinedAnalysis.layers].reverse();
  const indicatorDefinitions = massgis.indicatorGroups.flatMap(({maps}) => maps);
  const selectedLayerIds = new Set((selected.combined ? combinedDefinitions : [selected.map])
    .map(({slug}) => massgisLayerId(slug)));
  const layers = [...combinedDefinitions, ...indicatorDefinitions].map((definition, index) => massgisLayer({
    definition,
    index,
    dataset,
    massgis,
    combined: index < combinedDefinitions.length,
    visible: selectedLayerIds.has(massgisLayerId(definition.slug))
  }));
  const view = massgis.viewConfigurations.find(({id}) => id === selected.map.viewId);
  const layerTree = [
    {
      kind: "group",
      id: "combined-analysis",
      title: "Combined screening layers",
      open: selected.combined,
      children: combinedDefinitions.map(({slug}) => ({kind: "layer", layerId: massgisLayerId(slug)}))
    },
    ...massgis.indicatorGroups.map((group) => ({
      kind: "group",
      id: group.slug,
      title: group.title,
      open: group.slug === selected.group.slug,
      children: group.maps.map(({slug}) => ({kind: "layer", layerId: massgisLayerId(slug)}))
    }))
  ];
  const activeLayerId = massgisLayerId(
    selected.combined ? combinedDefinitions[0].slug : selected.map.slug
  );
  const project = projectRecord({
    workspace,
    layers,
    view,
    layerTree,
    activeLayerId,
    bookmarks: [{
      bookmarkId: "massachusetts_statewide",
      title: "Massachusetts statewide",
      center: [...view.center],
      zoom: view.zoom
    }]
  });
  return presentationRecord({
    pageId,
    workspace,
    datasets: [dataset],
    layers,
    geojsonByLayerId: new Map(layers.map(({layerId}) => [layerId, geojson])),
    project,
    publication,
    source,
    noticeTitle: selected.map.title,
    noticeSummary: selected.map.summary,
    limitations: massgis.collection.limitations,
    officialUrls: massgis.collection.officialUrls,
    sourceReceipt: geojson.opengeo ?? null,
    draftScopeId: `${pageId}:layer-workspace-v1`
  });
}

function findMassgisMap(massgis, pageId) {
  if (pageId === massgisPageId(massgis.combinedAnalysis.slug)) {
    return {
      combined: true,
      map: massgis.combinedAnalysis,
      group: {slug: "combined-analysis", title: "Combined analysis"}
    };
  }
  for (const group of massgis.indicatorGroups) {
    const map = group.maps.find(({slug}) => massgisPageId(slug) === pageId);
    if (map) return {combined: false, map, group};
  }
  return null;
}

function massgisLayer({definition, index, dataset, massgis, combined, visible}) {
  const preset = massgis.stylePresets.find(({id}) => id === definition.style.presetId);
  const colors = [...preset.colors];
  const line = preset.geometry === "line";
  return {
    layerId: massgisLayerId(definition.slug),
    datasetId: dataset.datasetId,
    title: definition.title,
    description: definition.style.fieldAlias,
    sourceType: "arcgis-feature-layer-snapshot",
    sourceUrl: massgis.sources[0].layerUrl,
    sharedSourceId: dataset.datasetId,
    geometryType: dataset.geometryType,
    visible,
    opacity: preset.opacity,
    order: index,
    browserDraftData: false,
    attribution: massgis.collection.attribution,
    style: {
      renderer: "graduated",
      graduated: {
        field: definition.style.field,
        breaks: [...preset.breaks],
        colors,
        noDataColor: preset.nullColor,
        noDataLabel: "No data"
      },
      legendTitle: definition.style.fieldAlias,
      fill: colors[0],
      fillOpacityFactor: line ? 0 : 1,
      polygonMode: line ? "line" : "fill",
      stroke: preset.outlineColor,
      strokeWidth: preset.outlineWidth,
      combinedAnalysis: combined
    },
    labels: {enabled: false, field: "NAME"}
  };
}

function workspaceRecord({workspaceId, title, description, updatedAt = DEFAULT_UPDATED_AT}) {
  return {
    workspaceId,
    tenantId: DEMO_TENANT_ID,
    title,
    description,
    status: "active",
    classification: "public",
    updatedAt
  };
}

function datasetRecord({
  datasetId,
  workspace,
  title,
  description,
  geojson,
  license,
  attribution,
  publicSourcePath
}) {
  return {
    datasetId,
    workspaceId: workspace.workspaceId,
    title,
    description,
    datasetType: "spatial",
    geometryType: firstGeometryType(geojson),
    status: "published",
    classification: "public",
    currentVersion: "reviewed-public-source",
    featureCount: geojson.features.length,
    crs: "EPSG:4326",
    license,
    attribution,
    publicSourcePath,
    tags: ["public", "demo", "workbench"]
  };
}

function projectRecord({workspace, layers, view, bookmarks, layerTree = [], activeLayerId = null}) {
  return {
    workspaceId: workspace.workspaceId,
    mapViews: [{
      center: [...view.center],
      zoom: view.zoom,
      pitch: view.pitch ?? 0,
      bearing: view.bearing ?? 0
    }],
    basemaps: [{
      basemapId: "openfreemap-positron",
      title: "Positron",
      kind: "maplibre-style",
      styleUrl: "https://tiles.openfreemap.org/styles/positron",
      attribution: "OpenFreeMap © OpenMapTiles · Data from OpenStreetMap",
      visible: true,
      opacity: 1
    }],
    bookmarks,
    layerTree,
    activeLayerId: activeLayerId ?? layers[0]?.layerId ?? null,
    layers,
    updatedAt: workspace.updatedAt
  };
}

function presentationRecord(value) {
  return {...value, draftScopeId: value.draftScopeId ?? value.pageId};
}

function massgisLayerId(slug) {
  return `massgis_${slug.replaceAll("-", "_")}`;
}

function massgisPageId(slug) {
  return `${MASSGIS_PAGE_PREFIX}${slug}`;
}

function assertFeatureCollection(value) {
  if (value?.type !== "FeatureCollection" || !Array.isArray(value.features)) {
    throw new TypeError("public demo GeoJSON must be a FeatureCollection");
  }
}

function firstGeometryType(geojson) {
  return geojson.features.find((feature) => typeof feature?.geometry?.type === "string")?.geometry.type ?? "Geometry";
}
