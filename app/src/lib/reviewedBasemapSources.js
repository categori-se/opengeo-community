const GLOBAL_WEB_MERCATOR_BOUNDS = Object.freeze([-180, -85.051129, 180, 85.051129]);

/**
 * Runtime records for public sources that passed OpenGeo's dated source review.
 * Keep provider facts here so the chooser, renderer, operations checks, and
 * maintained documentation all refer to the same endpoints and limits.
 */
export const REVIEWED_KEY_FREE_BASEMAPS = deepFreeze([
  {
    basemapId: "nasa-blue-marble-relief",
    title: "Blue Marble relief",
    section: "Imagery · no API key",
    kind: "raster",
    description: "Global daytime imagery with shaded relief and ocean bathymetry.",
    url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg",
    tileSize: 256,
    scheme: "xyz",
    minZoom: 1,
    maxZoom: 8,
    attribution: "<a href='https://earthdata.nasa.gov/eosdis/science-system-description/eosdis-components/gibs'>NASA GIBS</a>",
    preview: "blue-marble",
    sourceReview: {
      provider: "NASA GIBS",
      access: "No API key",
      coverage: "Global Web Mercator",
      zoom: "1–8",
      serviceLevel: "Public service · availability can vary",
      reviewedAt: "2026-08-28",
      capabilityUrl: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml",
      termsUrl: "https://www.earthdata.nasa.gov/engage/open-data-services-software/data-use-policy",
      probeUrl: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/default/GoogleMapsCompatible_Level8/4/6/4.jpeg",
      expectedContentType: "image/jpeg",
      capabilityIdentifier: "BlueMarble_ShadedRelief_Bathymetry",
      decision: "accepted"
    },
    sourceConfiguration: {
      coverageBounds: GLOBAL_WEB_MERCATOR_BOUNDS,
      coverageSummary: "Global Web Mercator",
      coordinateBehavior: "wgs84_web_mercator"
    }
  },
  {
    basemapId: "nasa-viirs-city-lights-2012",
    title: "Earth at night",
    section: "Imagery · no API key",
    kind: "raster",
    description: "Global 2012 VIIRS night-light imagery from Suomi NPP.",
    url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_CityLights_2012/default/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg",
    tileSize: 256,
    scheme: "xyz",
    minZoom: 1,
    maxZoom: 8,
    attribution: "<a href='https://earthdata.nasa.gov/eosdis/science-system-description/eosdis-components/gibs'>NASA GIBS</a> · VIIRS/Suomi NPP",
    preview: "city-lights",
    sourceReview: {
      provider: "NASA GIBS",
      access: "No API key",
      coverage: "Global Web Mercator",
      zoom: "1–8",
      serviceLevel: "Public service · availability can vary",
      reviewedAt: "2026-08-28",
      capabilityUrl: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml",
      termsUrl: "https://www.earthdata.nasa.gov/engage/open-data-services-software/data-use-policy",
      probeUrl: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_CityLights_2012/default/default/GoogleMapsCompatible_Level8/4/6/4.jpeg",
      expectedContentType: "image/jpeg",
      capabilityIdentifier: "VIIRS_CityLights_2012",
      decision: "accepted"
    },
    sourceConfiguration: {
      coverageBounds: GLOBAL_WEB_MERCATOR_BOUNDS,
      coverageSummary: "Global Web Mercator",
      coordinateBehavior: "wgs84_web_mercator"
    }
  },
  {
    basemapId: "usgs-national-imagery",
    title: "USGS imagery",
    section: "Imagery · no API key",
    kind: "raster",
    description: "Detailed U.S. orthoimagery with global small-scale context.",
    url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
    tileSize: 256,
    scheme: "xyz",
    minZoom: 1,
    maxZoom: 16,
    attribution: "<a href='https://www.usgs.gov/programs/national-geospatial-program/national-map'>USGS The National Map</a> · USDA",
    preview: "usgs-imagery",
    sourceReview: {
      provider: "USGS The National Map",
      access: "No API key",
      coverage: "Detailed U.S.; global context at small scales",
      zoom: "1–16",
      serviceLevel: "Public service · availability can vary",
      reviewedAt: "2026-08-28",
      capabilityUrl: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer?f=pjson",
      termsUrl: "https://www.usgs.gov/faqs/what-are-terms-uselicensing-map-services-and-data-national-map",
      probeUrl: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/12/1566/1171",
      expectedContentType: "image/jpeg",
      capabilityIdentifier: "USGSImageryOnly",
      decision: "accepted"
    },
    sourceConfiguration: {
      coverageBounds: GLOBAL_WEB_MERCATOR_BOUNDS,
      coverageSummary: "Detailed U.S.; global context at small scales",
      coordinateBehavior: "wgs84_web_mercator"
    }
  },
  {
    basemapId: "usgs-national-shaded-relief",
    title: "USGS shaded relief",
    section: "Terrain & relief · no API key",
    kind: "raster",
    description: "Shaded landform context with detailed U.S. 3DEP coverage.",
    url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer/tile/{z}/{y}/{x}",
    tileSize: 256,
    scheme: "xyz",
    minZoom: 0,
    maxZoom: 16,
    attribution: "<a href='https://www.usgs.gov/programs/national-geospatial-program/national-map'>USGS The National Map</a> · 3DEP · GMTED2010",
    preview: "shaded-relief",
    sourceReview: {
      provider: "USGS The National Map",
      access: "No API key",
      coverage: "Detailed U.S.; global relief at small scales",
      zoom: "0–16",
      serviceLevel: "Public service · availability can vary",
      reviewedAt: "2026-08-28",
      capabilityUrl: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer?f=pjson",
      termsUrl: "https://www.usgs.gov/faqs/what-are-terms-uselicensing-map-services-and-data-national-map",
      probeUrl: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer/tile/8/97/73",
      expectedContentType: "image/jpeg",
      capabilityIdentifier: "USGSShadedReliefOnly",
      decision: "accepted"
    },
    sourceConfiguration: {
      coverageBounds: GLOBAL_WEB_MERCATOR_BOUNDS,
      coverageSummary: "Detailed U.S.; global relief at small scales",
      coordinateBehavior: "wgs84_web_mercator"
    }
  }
]);

/** Candidates remain visible to maintainers without appearing as selectable
 * defaults. A fresh review is required before any decision changes.
 */
export const BASEMAP_SOURCE_REVIEW_DECISIONS = deepFreeze([
  ...REVIEWED_KEY_FREE_BASEMAPS.map(({basemapId, title, sourceReview}) => ({
    candidateId: basemapId,
    title,
    ...sourceReview
  })),
  {
    candidateId: "eox-cloudless-current",
    title: "EOX Sentinel-2 cloudless",
    provider: "EOX",
    access: "No API key",
    coverage: "Global",
    zoom: "Provider-defined",
    serviceLevel: "Public endpoint",
    reviewedAt: "2026-08-28",
    capabilityUrl: "https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml",
    termsUrl: "https://cloudless.eox.at/documentation/license",
    decision: "not-default",
    reason: "Current free imagery terms are non-commercial; OpenGeo.Tools's multi-tenant default catalog needs broader use rights."
  },
  {
    candidateId: "osm-standard-public-tiles",
    title: "OpenStreetMap standard public tile service",
    provider: "OpenStreetMap Foundation",
    access: "No API key",
    coverage: "Global",
    zoom: "Provider-defined",
    serviceLevel: "Volunteer-funded public service",
    reviewedAt: "2026-08-28",
    termsUrl: "https://operations.osmfoundation.org/policies/tiles/",
    decision: "not-default",
    reason: "The standard tile service has an operational usage policy and is not a general-purpose application tile backend."
  },
  {
    candidateId: "historic-free-tiles-list",
    title: "Historic free-tiles catalog entries",
    provider: "Community list",
    access: "Varies",
    coverage: "Varies",
    zoom: "Varies",
    serviceLevel: "Unverified",
    reviewedAt: "2026-08-28",
    termsUrl: "https://github.com/alexurquhart/free-tiles",
    decision: "discovery-only",
    reason: "Individual endpoints and terms may be stale; each candidate needs its own current review."
  }
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
