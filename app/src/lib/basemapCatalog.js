import {spatialBodyDefinition} from "./spatialBody.js";
import {ESRI_BASEMAP_OPTIONS} from "./esriBasemaps.js";
import {
  applyBasemapGovernance,
  basemapCatalogAvailability,
  basemapGovernanceLabel,
  basemapGovernanceMessage
} from "./basemapGovernance.js";

const EARTH_PRESENTATION = Object.freeze({
  body: "Earth",
  spatialBodyId: "earth",
  spatialReference: "Web Mercator (EPSG:3857)",
  measurement: "Earth geodesic distance and area",
  savedProjectSemantics: "Uses the existing OpenGeo Earth map definition"
});

const NON_EARTH_REQUIREMENTS = Object.freeze([
  "named spatial body and reference system",
  "ellipsoid or sphere definition",
  "camera altitude and extent rules",
  "distance and area measurement rules",
  "source license and attribution",
  "saved-project round trip"
]);

const PLANETARY_IMAGERY_REQUIREMENTS = Object.freeze([
  "approved source endpoint",
  "license and attribution",
  "tile scheme and resolution review",
  "outage and privacy behavior"
]);

const PROTOMAPS_FLAVORS = Object.freeze([
  ["light", "Light"],
  ["dark", "Dark"],
  ["white", "White"],
  ["grayscale", "Grayscale"],
  ["black", "Black"]
]);

const CARTO_FLAVORS = Object.freeze([
  ["voyager", "Voyager", "General-purpose context"],
  ["positron", "Positron", "Quiet light backdrop"],
  ["dark-matter", "Dark Matter", "Dark thematic backdrop"]
]);

const UNAVAILABLE_GROUPS = Object.freeze([
  {
    groupId: "regional",
    title: "Regional",
    open: false,
    description: "Regional maps appear only after their source, license, coverage, and coordinate behavior are recorded.",
    choices: [{
      catalogId: "regional-connected-source",
      title: "Connected regional maps",
      availability: "source-required",
      reason: "No governed regional basemap source is attached to this project.",
      source: "Project connection required",
      license: "Required before activation",
      requirements: ["named source", "license and attribution", "coverage", "coordinate transform"],
      ...EARTH_PRESENTATION
    }]
  },
  {
    groupId: "moon",
    title: "The Moon",
    open: false,
    description: "Begin a lunar project without network imagery, or inspect the source review required for imagery.",
    choices: [planetaryBlankChoice("moon", "Blank lunar map"), ...["Hillshaded Albedo", "OPM Basemap v0.1"].map((title) => ({
      catalogId: `moon-${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`,
      title,
      availability: "source-review-required",
      reason: "The lunar imagery source, license, render configuration, and operating behavior have not been approved.",
      source: "Candidate catalog entry; source not yet approved",
      license: "Required before activation",
      requirements: [...PLANETARY_IMAGERY_REQUIREMENTS],
      body: "Moon",
      spatialBodyId: "moon"
    }))]
  },
  {
    groupId: "mars",
    title: "Mars",
    open: false,
    description: "Begin a Martian project without network imagery, or inspect the source review required for imagery.",
    choices: [planetaryBlankChoice("mars", "Blank Martian map"), ...[
      "Colour MOLA Elevation",
      "Viking MDIM2.1",
      "Hillshade",
      "OPM Basemap v0.2",
      "Shaded Colour MOLA Elevation",
      "Shaded Grayscale MOLA Elevation"
    ].map((title) => ({
      catalogId: `mars-${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`,
      title,
      availability: "source-review-required",
      reason: "The Martian imagery source, license, render configuration, and operating behavior have not been approved.",
      source: "Candidate catalog entry; source not yet approved",
      license: "Required before activation",
      requirements: [...PLANETARY_IMAGERY_REQUIREMENTS],
      body: "Mars",
      spatialBodyId: "mars"
    }))]
  },
  {
    groupId: "other-celestial-bodies",
    title: "Other celestial bodies",
    open: false,
    description: "Additional bodies follow the same explicit spatial, source, measurement, and persistence review.",
    choices: [{
      catalogId: "other-celestial-connected-source",
      title: "Connected planetary catalogs",
      availability: "body-contract-required",
      reason: "No additional spatial-body catalog is implemented or attached.",
      source: "Project connection required",
      license: "Required before activation",
      requirements: [...NON_EARTH_REQUIREMENTS],
      body: "Unspecified"
    }]
  }
]);

/**
 * Build the chooser model from the same runtime basemap records used to render
 * and save maps. Entries without a runtime id are deliberately non-selectable.
 */
export function buildBasemapCatalog(
  basemaps,
  basemapConnectionBindings = [],
  selectedBasemapConnectionBindingId = null,
  regionalSources = [],
  selectedBasemapId = null,
  {spatialBodyId = "earth", layerCount = 0} = {}
) {
  // Esri has one access/terms workflow beside imagery, including saved selections.
  const records = applyBasemapGovernance(Array.isArray(basemaps) ? basemaps : [])
    .filter(record => !ESRI_BASEMAP_OPTIONS.some(option => option.url === record.url));
  const openFreeMap = runtimeGroup(
    "openfreemap",
    "Street maps · no API key",
    true,
    records.filter(({section}) => section === "OpenFreeMap"),
    "Six attributed OpenFreeMap styles for everyday mapping."
  );
  const imagery = runtimeGroup(
    "key-free-imagery",
    "Imagery",
    true,
    records.filter(({section}) => section === "Imagery · no API key"),
    "Satellite and aerial backgrounds. Each source states its access, coverage and useful zoom."
  );
  const terrainRelief = runtimeGroup(
    "key-free-terrain-relief",
    "Terrain & relief · no API key",
    false,
    records.filter(({section}) => section === "Terrain & relief · no API key"),
    "Reviewed shaded relief for 2D context. The separate open-terrain control adds elevation to the globe."
  );
  const savedLifecycle = runtimeGroup(
    "saved-project-background",
    "Saved project background",
    true,
    records.filter(({section, governance}) => (
      section === "Project" && ["retired", "disabled"].includes(governance?.lifecycle)
    )),
    "This exact saved source remains identifiable. Choose its reviewed replacement explicitly when you are ready."
  );
  const otherEarth = runtimeGroup(
    "other-earth",
    "Other Earth backgrounds",
    false,
    records.filter(({section, kind, spatialBodyId = "earth", governance}) => (
      ![
        "OpenFreeMap",
        "Imagery · no API key",
        "Terrain & relief · no API key",
        "Hosted raster",
        "Regional"
      ].includes(section)
      && !["provider-basemap", "provider-style", "provider-raster", "governed-raster"].includes(kind)
      && !["retired", "disabled"].includes(governance?.lifecycle)
      && spatialBodyId === "earth"
    ))
  );
  const groups = [
    imagery,
    openFreeMap,
    terrainRelief,
    savedLifecycle,
    otherEarth,
    providerGroup("protomaps", basemapConnectionBindings, selectedBasemapConnectionBindingId),
    providerGroup("carto", basemapConnectionBindings, selectedBasemapConnectionBindingId),
    regionalGroup(regionalSources, selectedBasemapId),
    planetaryGroup(UNAVAILABLE_GROUPS[1], selectedBasemapId),
    planetaryGroup(UNAVAILABLE_GROUPS[2], selectedBasemapId),
    UNAVAILABLE_GROUPS[3]
  ].filter((group) => group.choices.length);
  return Object.freeze(groups.map((group) => bodyScopedGroup(group, spatialBodyId, layerCount)));
}

export function providerBasemapId(provider, bindingId, flavor) {
  return `provider-${provider}-${bindingId}-${flavor}`;
}

export function governedRegionalBasemapId(datasetId, sourceVersion) {
  return `governed-xyz-${datasetId}-v${sourceVersion}`;
}

export function selectableBasemap(catalog, catalogId) {
  for (const group of catalog ?? []) {
    const choice = group.choices?.find((candidate) => candidate.catalogId === catalogId);
    if (choice) return choice.availability === "available" && choice.basemapId ? choice : null;
  }
  return null;
}

export function unavailableBasemapMessage(choice) {
  if (!choice || choice.availability === "available") return null;
  if (choice.availability === "retired" || choice.availability === "operator-disabled") {
    return choice.governanceMessage ?? `${choice.title} is unavailable under the current basemap policy.`;
  }
  const requirements = choice.requirements?.length
    ? ` Required: ${choice.requirements.join(", ")}.`
    : "";
  return `${choice.title} is unavailable. ${choice.reason}${requirements}`;
}

function runtimeGroup(groupId, title, open, basemaps, description = null) {
  return Object.freeze({
    groupId,
    title,
    open,
    description: description ?? (groupId === "openfreemap"
      ? "Key-free styles indexed from GeoLibre and rendered from attributed OpenFreeMap sources."
      : "Additional key-free Earth backgrounds already supported by OpenGeo."),
    choices: basemaps.map((basemap) => {
      const availability = basemapCatalogAvailability(basemap);
      const governanceMessage = basemapGovernanceMessage(basemap, {savedProject: true});
      return Object.freeze({
        catalogId: basemap.basemapId,
        basemapId: basemap.basemapId,
        title: basemap.title,
        kind: basemap.kind,
        description: availability === "available" ? basemap.description : governanceMessage,
        availability,
        reason: availability === "available" ? null : governanceMessage,
        source: availability === "retired"
          ? "Retired catalog source · exact saved record"
          : availability === "operator-disabled"
            ? "Network access blocked by operator"
            : basemap.kind === "maplibre-style"
              ? `${basemap.sourceReview?.access ?? "No API key"} · MapLibre style`
              : basemap.kind === "raster"
                ? `${basemap.sourceReview?.access ?? "Public"} · ${basemap.sourceReview?.provider ?? "Raster tiles"}`
                : "No network source",
        license: basemap.attribution,
        governance: basemap.governance ?? null,
        governanceLabel: basemapGovernanceLabel(basemap.governance),
        governanceMessage,
        replacementBasemapId: basemap.governance?.replacementBasemapId ?? null,
        preview: basemap.preview ?? basemap.basemapId,
        sourceReview: basemap.sourceReview ?? null,
        access: basemap.sourceReview?.access ?? (basemap.kind === "blank" ? "Network-free" : null),
        coverage: basemap.sourceReview?.coverage ?? null,
        zoom: basemap.sourceReview?.zoom ?? null,
        serviceLevel: basemap.sourceReview?.serviceLevel ?? null,
        reviewedAt: basemap.sourceReview?.reviewedAt ?? null,
        termsUrl: basemap.sourceReview?.termsUrl ?? null,
        requirements: availability === "available" ? [] : ["explicit replacement selection"],
        ...EARTH_PRESENTATION
      });
    })
  });
}

function providerGroup(provider, bindings, selectedBindingId) {
  const definition = provider === "carto"
    ? {
        title: "CARTO · API key required",
        flavors: CARTO_FLAVORS,
        source: "CARTO hosted raster API",
        license: "CARTO · © OpenStreetMap contributors",
        presentationKind: "raster",
        connectionDescription: "CARTO now requires a browser API key for raster basemaps.",
        setup: "Request a CARTO basemap key, restrict it to this site, then save it under Connections."
      }
    : {
        title: "Protomaps · API key required",
        flavors: PROTOMAPS_FLAVORS.map(([flavor, title]) => [flavor, title, `${title} vector backdrop`]),
        source: "Protomaps hosted vector API",
        license: "Protomaps · © OpenStreetMap contributors",
        presentationKind: "maplibre-style",
        connectionDescription: "Protomaps hosted styles require a browser API key.",
        setup: "Create an origin-restricted Protomaps key, then save it under Connections."
      };
  const records = (Array.isArray(bindings) ? bindings : [])
    .filter(({connection}) => connection?.provider === provider)
    .map((binding) => ({
      bindingId: binding.id,
      title: binding.displayName,
      status: binding.connection.status,
      credentialReady: binding.connection.credentialReady === true
    }));
  const selected = records.find(({bindingId}) => bindingId === selectedBindingId)
    ?? records.find(({status, credentialReady}) => status === "configured" && credentialReady)
    ?? records[0]
    ?? null;
  const available = selected?.status === "configured" && selected.credentialReady;
  return Object.freeze({
    groupId: provider,
    title: definition.title,
    open: available,
    description: available
      ? `${definition.connectionDescription} Using the selected reusable project connection.`
      : `${definition.connectionDescription} ${definition.setup}`,
    connections: records,
    selectedBindingId: selected?.bindingId ?? null,
    setupHref: `/workspaces?provider=${provider}#connections`,
    choices: definition.flavors.map(([flavor, title, visualIntent]) => Object.freeze({
      catalogId: available
        ? providerBasemapId(provider, selected.bindingId, flavor)
        : `provider-${provider}-unconfigured-${flavor}`,
      ...(available ? {basemapId: providerBasemapId(provider, selected.bindingId, flavor)} : {}),
      title,
      description: available
        ? `${visualIntent} · ${selected.title}`
        : `${visualIntent} · configured connection required`,
      availability: available ? "available" : "connection-required",
      reason: records.length
        ? `The attached ${definition.title.split(" ·")[0]} connection needs an enabled browser key.`
        : `Attach a ${definition.title.split(" ·")[0]} basemap connection to this project.`,
      source: definition.source,
      license: definition.license,
      requirements: [
        "reusable provider connection",
        "client-visible origin-restricted browser key",
        "authorized no-store resource resolution"
      ],
      provider,
      presentationKind: definition.presentationKind,
      flavor,
      bindingId: selected?.bindingId ?? null,
      ...EARTH_PRESENTATION
    }))
  });
}

function regionalGroup(sources, selectedBasemapId) {
  const records = (Array.isArray(sources) ? sources : [])
    .filter(({sourceType, configuration}) => (
      sourceType === "xyz" && configuration?.presentationRole === "regional_basemap"
    ));
  if (!records.length) return UNAVAILABLE_GROUPS[0];
  const choices = records.map((source) => {
    const configuration = source.configuration;
    const basemapId = governedRegionalBasemapId(source.datasetId, source.versionNumber);
    const aligned = configuration.coordinateBehavior === "wgs84_web_mercator";
    const complete = Boolean(
      configuration.attribution
      && configuration.license
      && Array.isArray(configuration.coverageBounds)
      && configuration.coverageBounds.length === 4
    );
    const available = aligned && complete;
    let hostname = "Governed XYZ source";
    try {
      hostname = new URL(source.sourceUrl).hostname;
    } catch {
      // The API contract remains authoritative; a malformed local fixture stays unavailable.
    }
    return Object.freeze({
      catalogId: basemapId,
      ...(available ? {basemapId} : {}),
      title: source.name,
      description: available
        ? `${coverageLabel(configuration.coverageBounds)} · revision ${source.versionNumber}`
        : "The declared coordinate behavior cannot yet be aligned with project data.",
      availability: available ? "available" : "coordinate-transform-required",
      reason: available
        ? null
        : "This source uses an offset coordinate system and OpenGeo has no approved transform for it.",
      source: `${hostname} · governed XYZ revision ${source.versionNumber}`,
      license: configuration.license ?? "Required before activation",
      requirements: ["named source", "license and attribution", "coverage", "coordinate transform"],
      kind: "governed-raster",
      datasetId: source.datasetId,
      sourceType: "xyz-raster",
      sourceVersion: source.versionNumber,
      sourceUrl: source.sourceUrl,
      sourceConfiguration: structuredClone(configuration),
      attribution: configuration.attribution,
      url: source.sourceUrl,
      tileSize: configuration.tileSize,
      scheme: configuration.scheme,
      minZoom: configuration.minZoom,
      maxZoom: configuration.maxZoom,
      ...EARTH_PRESENTATION
    });
  });
  return Object.freeze({
    groupId: "regional",
    title: "Regional",
    open: choices.some(({basemapId}) => basemapId === selectedBasemapId),
    description: "Project-linked XYZ backgrounds with recorded license, coverage, and coordinate behavior.",
    choices
  });
}

function planetaryBlankChoice(spatialBodyId, title) {
  const body = spatialBodyDefinition(spatialBodyId);
  return Object.freeze({
    catalogId: `planetary-blank-${spatialBodyId}`,
    basemapId: `planetary-blank-${spatialBodyId}`,
    title,
    description: `${body.title} angular coordinates with body-aware distance measurement; no imagery request.`,
    availability: "available",
    source: "No network source",
    license: "No imagery",
    attribution: `No imagery · ${body.title} angular canvas`,
    requirements: [],
    kind: "planetary-blank",
    body: body.title,
    spatialBodyId,
    spatialReference: body.coordinateSystem,
    measurement: "Spherical mean-radius distance",
    savedProjectSemantics: `Stores the exact ${body.title} spatial-body registry record`
  });
}

function planetaryGroup(group, selectedBasemapId) {
  return Object.freeze({
    ...group,
    open: group.choices.some(({basemapId}) => basemapId === selectedBasemapId)
  });
}

function bodyScopedGroup(group, activeBodyId, layerCount) {
  if (layerCount <= 0) return group;
  const choices = group.choices.map((choice) => {
    if (choice.availability !== "available"
      || !choice.spatialBodyId
      || choice.spatialBodyId === activeBodyId) return choice;
    const {basemapId: _basemapId, ...record} = choice;
    const activeBody = spatialBodyDefinition(activeBodyId);
    return Object.freeze({
      ...record,
      availability: "empty-project-required",
      reason: `This project already contains ${activeBody.title} layers. Start an empty project so coordinates are never silently reinterpreted.`,
      requirements: ["empty project or a separately governed layer-body migration"]
    });
  });
  return Object.freeze({...group, choices});
}

function coverageLabel(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4) return "Coverage not recorded";
  return `Coverage ${bounds.join(", ")}`;
}

export const BASEMAP_CATALOG_REFERENCE_GROUPS = Object.freeze([
  providerGroup("protomaps", [], null),
  providerGroup("carto", [], null),
  ...UNAVAILABLE_GROUPS
]);
