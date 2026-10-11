export const SOURCE_OPERATIONS = Object.freeze([
  "register",
  "read",
  "stream",
  "preview",
  "write",
  "edit",
  "preserve"
]);

export const SOURCE_CLAIM_STATUSES = Object.freeze([
  "available",
  "bounded",
  "preserve-only",
  "unavailable",
  "not-applicable"
]);

const CLAIM_STATUS_SET = new Set(SOURCE_CLAIM_STATUSES);
const SECTION_ORDER = Object.freeze(["files", "web-services", "cloud", "3d", "databases"]);

function claim(status, scope) {
  if (!CLAIM_STATUS_SET.has(status)) throw new TypeError(`Unknown source claim status: ${status}`);
  if (typeof scope !== "string" || !scope.trim()) throw new TypeError("Source claim scope is required");
  return Object.freeze({status, scope});
}

const unavailable = (scope) => claim("unavailable", scope);
const bounded = (scope) => claim("bounded", scope);
const available = (scope) => claim("available", scope);
const preserveOnly = (scope) => claim("preserve-only", scope);

function operations(overrides, unavailableScope) {
  const values = Object.fromEntries(
    SOURCE_OPERATIONS.map((operation) => [operation, unavailable(unavailableScope)])
  );
  for (const [operation, value] of Object.entries(overrides)) {
    if (!SOURCE_OPERATIONS.includes(operation)) {
      throw new TypeError(`Unknown source operation: ${operation}`);
    }
    values[operation] = value;
  }
  return Object.freeze(values);
}

function source(record) {
  const required = ["id", "label", "section", "tier", "disposition", "summary"];
  for (const field of required) {
    if (typeof record[field] !== "string" || !record[field].trim()) {
      throw new TypeError(`Source capability ${field} is required`);
    }
  }
  if (!SECTION_ORDER.includes(record.section)) {
    throw new TypeError(`Unknown source capability section: ${record.section}`);
  }
  if (!Array.isArray(record.losses) || !record.losses.length) {
    throw new TypeError(`${record.id} must declare at least one limit or loss`);
  }
  if (!Array.isArray(record.evidence) || !record.evidence.length) {
    throw new TypeError(`${record.id} must identify its implementation evidence`);
  }
  for (const operation of SOURCE_OPERATIONS) {
    if (!record.operations?.[operation]) {
      throw new TypeError(`${record.id} is missing the ${operation} operation claim`);
    }
  }
  return Object.freeze({
    ...record,
    losses: Object.freeze([...record.losses]),
    evidence: Object.freeze([...record.evidence])
  });
}

const managedVectorOperations = operations({
  register: bounded("Managed upload with exact immutable object and format identity."),
  read: bounded("Authorized current or exact-version download and normalized vector preview."),
  preview: bounded("At most 5,000 preview features after isolated inspection."),
  write: bounded("Original bytes plus declared GeoJSON, GeoParquet, PMTiles, and SVG derivatives."),
  edit: bounded("Durable feature editing is limited to governed GeoJSON feature collections."),
  preserve: available("The exact versioned source object and checksums are retained.")
}, "No unbounded or credential-bearing vector operation is available.");

const managedRasterOperations = operations({
  register: bounded("Managed COG upload with exact immutable object identity."),
  read: bounded("Authorized exact COG download and whole-coverage WCS read."),
  stream: bounded("Exact immutable COG bytes support bounded range-aware clients."),
  preview: bounded("Isolated GDAL inspection emits a bounded PNG thumbnail."),
  write: bounded("Explicit COG subset, band, scale, or reprojection derivatives."),
  preserve: available("The exact versioned source object and checksums are retained.")
}, "Raster pixel editing is not available; processing creates a new immutable derivative.");

function preserveOnlySource({id, label, section, tier, summary, loss, evidence}) {
  return source({
    id,
    label,
    section,
    tier,
    disposition: "preserve-only",
    summary,
    operations: operations({
      preserve: preserveOnly("The source definition can be retained inertly in a project conversion report.")
    }, "No executable OpenGeo Studio source adapter is registered for this GeoLibre source family."),
    losses: [loss],
    evidence
  });
}

export const SOURCE_CAPABILITY_CATALOG = Object.freeze([
  source({
    id: "vector",
    label: "Vector files",
    section: "files",
    tier: "basic",
    disposition: "bounded-current",
    summary: "Managed GeoJSON, zipped Shapefile, GeoPackage, and GeoParquet inputs.",
    operations: managedVectorOperations,
    losses: ["Other OGR drivers are not implied; GeoJSON is the only durable feature-editing format."],
    evidence: ["services/worker/src/opengeo_worker/inspector.py", "services/api/src/opengeo_api/features.py"]
  }),
  source({
    id: "raster",
    label: "Raster files",
    section: "files",
    tier: "basic",
    disposition: "bounded-current",
    summary: "Managed cloud-optimized GeoTIFF inspection, preview, exact reads, and derivatives.",
    operations: managedRasterOperations,
    losses: ["The managed geospatial raster profile is COG; generic TIFF and other raster drivers are not advertised."],
    evidence: ["services/worker/src/opengeo_worker/inspector.py", "services/worker/src/opengeo_worker/coverage_derivatives.py"]
  }),
  source({
    id: "delimited-text",
    label: "Delimited text",
    section: "files",
    tier: "basic",
    disposition: "bounded-current",
    summary: "CSV is inspected as a bounded nonspatial table.",
    operations: operations({
      register: bounded("Managed CSV upload under the ordinary ingest byte limits."),
      read: bounded("Authorized exact-version CSV download and Parquet working artifact."),
      preview: bounded("Tabular schema and thumbnail only; no geometry is inferred."),
      write: bounded("A bounded Parquet working representation is generated."),
      preserve: available("The exact versioned CSV object and checksum are retained.")
    }, "Delimited-text geometry, geocoding, streaming, and in-place editing are unavailable."),
    losses: ["Coordinate columns, WKT-like text, and addresses are not assigned spatial meaning without a future governed mapping."],
    evidence: ["services/worker/src/opengeo_worker/inspector.py"]
  }),
  preserveOnlySource({
    id: "cad", label: "CAD", section: "files", tier: "intermediate",
    summary: "CAD layer definitions are retained without executing a CAD driver.",
    loss: "DWG/DXF/DGN geometry, blocks, annotation, CRS, and styling are not converted.",
    evidence: ["app/src/lib/geolibreProject.js"]
  }),
  preserveOnlySource({
    id: "gdb", label: "File geodatabase", section: "files", tier: "intermediate",
    summary: "FileGDB layer definitions are retained without opening the database.",
    loss: "Domains, relationships, attachments, topology, styling, and feature classes are not converted.",
    evidence: ["app/src/lib/geolibreProject.js"]
  }),
  source({
    id: "photos",
    label: "Photos",
    section: "files",
    tier: "intermediate",
    disposition: "bounded-current",
    summary: "PNG and JPEG project media are normalized and previewed as nonspatial assets.",
    operations: operations({
      register: bounded("Managed PNG/JPEG upload up to 16 MiB and 40 million pixels."),
      read: bounded("Authorized exact-version media download."),
      preview: bounded("Metadata-stripped normalized image and thumbnail."),
      write: bounded("Normalized PNG derivative for publication."),
      preserve: available("The exact versioned original media object and checksum are retained.")
    }, "Photo streaming, feature editing, and EXIF-backed point generation are unavailable."),
    losses: ["EXIF location, orientation metadata, captions, and photo-to-point conversion are not imported."],
    evidence: ["services/worker/src/opengeo_worker/inspector.py"]
  }),
  preserveOnlySource({
    id: "gpx", label: "GPX", section: "files", tier: "intermediate",
    summary: "GPX references are retained for an explicit future import.",
    loss: "Tracks, routes, waypoints, timestamps, elevation, and extensions are not converted.",
    evidence: ["app/src/lib/geolibreProject.js"]
  }),
  preserveOnlySource({
    id: "mbtiles", label: "MBTiles", section: "files", tier: "basic",
    summary: "MBTiles references are retained but are not treated as PMTiles.",
    loss: "SQLite tile archives, metadata, grids, and vector source-layer semantics are not opened or converted.",
    evidence: ["app/src/lib/geolibreProject.js"]
  }),
  preserveOnlySource({
    id: "osm-pbf", label: "OpenStreetMap PBF", section: "files", tier: "advanced",
    summary: "OSM PBF references are retained without running an import pipeline.",
    loss: "Nodes, ways, relations, tag schemas, area construction, and replication state are not converted.",
    evidence: ["app/src/lib/geolibreProject.js"]
  }),
  source({
    id: "xyz",
    label: "XYZ tiles",
    section: "web-services",
    tier: "basic",
    disposition: "bounded-current",
    summary: "Credential-free public HTTPS raster tile templates can be registered and rendered.",
    operations: operations({
      register: bounded("Syntax-checked HTTPS template with exact z/x/y placeholders and zoom limits."),
      read: bounded("Current-view browser tile reads under project authorization."),
      stream: bounded("Anonymous browser tile streaming from the registered public host."),
      preview: bounded("Current map view only; source completeness is not inferred."),
      preserve: available("Versioned source configuration is retained without credentials.")
    }, "OpenGeo Studio does not write or edit upstream XYZ tiles."),
    losses: ["No complete archive, upstream availability guarantee, private credentials, or write-back is claimed."],
    evidence: ["services/api/src/opengeo_api/external_source_routes.py", "app/src/lib/basemapSource.js"]
  }),
  source({
    id: "wms",
    label: "WMS",
    section: "web-services",
    tier: "basic",
    disposition: "bounded-current",
    summary: "Credential-free WMS 1.3.0/1.1.1 image sources can be registered and rendered.",
    operations: operations({
      register: bounded("Syntax-checked public HTTPS endpoint, layers, styles, format, and EPSG:3857 contract."),
      read: bounded("Current-view PNG/JPEG GetMap requests."),
      stream: bounded("Browser image reads only; service discovery is a separate reviewed action."),
      preview: bounded("Current map extent and declared layer list."),
      preserve: bounded("Versioned configuration and one explicit protected PNG custody object."),
    }, "OpenGeo Studio does not edit or write to the upstream WMS."),
    losses: ["Capabilities breadth, dimensions, alternate CRS/formats, private upstream auth, and complete archival are not claimed."],
    evidence: ["services/api/src/opengeo_api/external_source_routes.py", "services/api/src/opengeo_api/source_archiver.py"]
  }),
  source({
    id: "imageserver",
    label: "ArcGIS ImageServer",
    section: "web-services",
    tier: "basic",
    disposition: "bounded-current",
    summary: "Public ImageServer imagery can be registered separately from feature services.",
    operations: operations({
      register: bounded("Credential-free HTTPS image service and versioned display settings; syntax validation is not a health check."),
      read: bounded("Current-view exportImage PNG/JPEG at 256 or 512 pixels per tile in Web Mercator."),
      stream: bounded("Direct browser display requests to the registered public service."),
      preview: bounded("Provider default or one/three explicit zero-based bands."),
      preserve: bounded("The source URL and display configuration are versioned; registration does not archive pixels.")
    }, "No upstream editing, analytical export, full capture or automatic archive fallback is enabled by registration."),
    losses: ["No arbitrary raster functions, mosaic rules, private credentials, original-file mirroring or equivalence-verified fallback is claimed."],
    evidence: ["services/api/src/opengeo_api/external_source_routes.py", "app/src/lib/imageServer.js"]
  }),
  source({
    id: "mapserver",
    label: "ArcGIS MapServer",
    section: "web-services",
    tier: "basic",
    disposition: "bounded-current",
    summary: "Public MapServer imagery can be registered separately from feature services.",
    operations: operations({
      register: bounded("Credential-free HTTPS map service and versioned display settings; syntax validation is not a health check."),
      read: bounded("Current-view export PNG at 256 or 512 pixels per tile in Web Mercator."),
      stream: bounded("Direct browser display requests to the registered public service."),
      preview: bounded("One or more explicit provider layer IDs."),
      preserve: bounded("The source URL and display configuration are versioned; registration does not archive pixels.")
    }, "No upstream editing, analytical export, full capture or automatic archive fallback is enabled by registration."),
    losses: ["No arbitrary render rules, private credentials, original-file mirroring or equivalence-verified fallback is claimed."],
    evidence: ["services/api/src/opengeo_api/external_source_routes.py", "app/src/lib/mapServer.js"]
  }),
  source({
    id: "wfs",
    label: "WFS",
    section: "web-services",
    tier: "intermediate",
    disposition: "bounded-current",
    summary: "One credential-free WFS 2.0 feature type can be registered for bounded current-extent reads.",
    operations: operations({
      register: bounded("Syntax-checked endpoint, feature type, geometry, fields, sort key, and page size."),
      read: bounded("One current-extent GeoJSON page capped at 1,000 features."),
      stream: bounded("At most four concurrent, 20-second, 8 MiB current-view requests."),
      preview: bounded("Current extent only; not a complete feature collection."),
      preserve: bounded("An explicit bounded capture can preserve the reviewed page as managed GeoJSON."),
    }, "External WFS write-back, locks, transactions, and complete crawling are unavailable."),
    losses: ["Only WFS 2.0 current-extent GeoJSON is supported; alternate CRS, broad filters, joins, locks, and WFS-T upstream writes are absent."],
    evidence: ["services/api/src/opengeo_api/external_source_routes.py", "services/api/src/opengeo_api/source_archiver.py"]
  }),
  preserveOnlySource({
    id: "wmts", label: "WMTS", section: "web-services", tier: "intermediate",
    summary: "External WMTS definitions are retained separately from OpenGeo Studio's administered WMTS output.",
    loss: "Arbitrary upstream capabilities, matrices, encodings, dimensions, and tile templates are not registered.",
    evidence: ["app/src/lib/geolibreProject.js", "services/api/src/opengeo_api/tile_cache_routes.py"]
  }),
  preserveOnlySource({
    id: "ogc-features", label: "OGC API Features", section: "web-services", tier: "intermediate",
    summary: "External OGC API Features definitions are retained; OpenGeo Studio's own collection output remains separate.",
    loss: "External landing-page discovery, collection paging, filters, CRS, and writes are not registered.",
    evidence: ["app/src/lib/geolibreProject.js", "services/api/src/opengeo_api/ogc_feature_routes.py"]
  }),
  preserveOnlySource({
    id: "ogc-vector-tiles", label: "OGC API Tiles", section: "web-services", tier: "intermediate",
    summary: "External OGC vector-tile definitions are retained without binding them to PMTiles.",
    loss: "External tileset discovery, tile matrix negotiation, styles, and vector source layers are not registered.",
    evidence: ["app/src/lib/geolibreProject.js"]
  }),
  source({
    id: "arcgis",
    label: "ArcGIS REST",
    section: "web-services",
    tier: "intermediate",
    disposition: "bounded-current",
    summary: "One public FeatureServer or MapServer layer can be registered for bounded current-extent reads.",
    operations: operations({
      register: bounded("Syntax-checked layer URL, object ID, fields, geometry, and page size."),
      read: bounded("One current-extent GeoJSON page capped at 2,000 features."),
      stream: bounded("At most four concurrent, 20-second, 8 MiB current-view requests."),
      preview: bounded("Current extent only; not a complete service-layer snapshot."),
      preserve: bounded("An explicit bounded capture can preserve the reviewed page as managed GeoJSON."),
    }, "External ArcGIS edits, attachments, relationships, and complete pagination are unavailable."),
    losses: ["Feature completeness, domains, subtypes, related records, attachments, private auth, and upstream writes are not claimed."],
    evidence: ["services/api/src/opengeo_api/external_source_routes.py", "services/api/src/opengeo_api/source_archiver.py"]
  }),
  preserveOnlySource({
    id: "georss", label: "GeoRSS", section: "web-services", tier: "intermediate",
    summary: "GeoRSS feed definitions are retained without polling the feed.",
    loss: "RSS/Atom entries, update cadence, geometry dialects, HTML, and enclosure media are not converted.",
    evidence: ["app/src/lib/geolibreProject.js"]
  }),
  source({
    id: "stac",
    label: "STAC",
    section: "web-services",
    tier: "advanced",
    disposition: "metadata-only",
    summary: "STAC 1.1 Collection metadata can be imported into a governed metadata profile.",
    operations: operations({
      register: bounded("One bounded STAC 1.1 Collection metadata document."),
      read: bounded("Collection identity, extents, license, keywords, providers, and links."),
      preserve: bounded("The exact source representation and checksum are retained with metadata provenance.")
    }, "STAC item search, asset reads, rendering, streaming, and writes are unavailable."),
    losses: ["This is metadata import only; item catalogs, assets, authentication, search, and raster/vector layer creation are not implied."],
    evidence: ["services/api/src/opengeo_api/metadata_adapters.py"]
  }),
  preserveOnlySource({
    id: "video", label: "Video", section: "web-services", tier: "advanced",
    summary: "Video layer definitions are retained without loading media frames.",
    loss: "Codecs, timelines, georeferencing, tracks, streaming, thumbnails, and transcoding are not supported.",
    evidence: ["app/src/lib/geolibreProject.js"]
  }),
  preserveOnlySource({
    id: "deckgl-viz", label: "deck.gl visualization", section: "web-services", tier: "advanced",
    summary: "deck.gl visualization definitions are retained as non-executing presentation metadata.",
    loss: "Layer classes, accessors, shaders, remote data, extensions, and executable JavaScript are not imported.",
    evidence: ["app/src/lib/geolibreProject.js"]
  }),
  source({
    id: "geoparquet",
    label: "GeoParquet",
    section: "cloud",
    tier: "basic",
    disposition: "bounded-current",
    summary: "Managed GeoParquet inputs use the same isolated vector path as other managed vectors.",
    operations: managedVectorOperations,
    losses: ["Remote range-query execution and arbitrary Parquet schemas are not advertised; preview normalizes geometry to CRS84."],
    evidence: ["services/worker/src/opengeo_worker/inspector.py"]
  }),
  preserveOnlySource({
    id: "flatgeobuf", label: "FlatGeobuf", section: "cloud", tier: "intermediate",
    summary: "FlatGeobuf definitions are retained; exact MapServer compatibility is evidence, not managed OpenGeo Studio ingest.",
    loss: "Remote range streaming, spatial index use, managed upload, derivatives, and editing are not supported.",
    evidence: ["parity/reports/mapserver-004-format-matrix-peer.json"]
  }),
  source({
    id: "pmtiles",
    label: "PMTiles",
    section: "cloud",
    tier: "intermediate",
    disposition: "bounded-current",
    summary: "Public HTTPS PMTiles and managed immutable PMTiles archives support bounded tile reads.",
    operations: operations({
      register: bounded("Syntax-checked public archive URL and explicit raster/vector render contract."),
      read: bounded("Exact public archive copy or managed-object download."),
      stream: bounded("Browser range reads for declared raster or vector tiles."),
      preview: bounded("Declared source layer, geometry, zoom range, and current map view."),
      write: bounded("Activation-only managed vector-to-PMTiles derivative."),
      preserve: available("Exact immutable public copy or managed source/derivative checksum."),
    }, "Feature-level editing inside a tile archive is unavailable."),
    losses: ["Tile quantization, source-layer/geometry declaration, no in-place editing, and no arbitrary private remote credentials."],
    evidence: ["services/api/src/opengeo_api/external_source_routes.py", "services/worker/src/opengeo_worker/pmtiles_derivatives.py"]
  }),
  preserveOnlySource({
    id: "zarr", label: "Zarr", section: "cloud", tier: "advanced",
    summary: "Zarr array definitions are retained without opening chunks or codecs.",
    loss: "Stores, groups, consolidated metadata, chunk codecs, dimensions, CRS, and array slicing are not supported.",
    evidence: ["app/src/lib/geolibreProject.js"]
  }),
  preserveOnlySource({
    id: "netcdf", label: "NetCDF / HDF", section: "cloud", tier: "advanced",
    summary: "Multidimensional file definitions are retained without treating them as two-dimensional COGs.",
    loss: "Groups, variables, dimensions, calendars, vertical axes, subdatasets, profiles, and multidimensional rendering are not supported.",
    evidence: ["app/src/lib/geolibreProject.js", "services/worker/src/opengeo_worker/coverage_derivatives.py"]
  }),
  preserveOnlySource({
    id: "lidar", label: "LiDAR / COPC", section: "3d", tier: "advanced",
    summary: "Point-cloud definitions are retained without opening point records.",
    loss: "LAS/LAZ/COPC dimensions, CRS, classifications, hierarchy, streaming, styling, and analysis are not supported.",
    evidence: ["app/src/lib/geolibreProject.js"]
  }),
  preserveOnlySource({
    id: "splatting", label: "Gaussian splats", section: "3d", tier: "advanced",
    summary: "Gaussian-splat definitions are retained as inert project metadata.",
    loss: "PLY/splat schemas, covariance, color, streaming, rendering, and camera transforms are not supported.",
    evidence: ["app/src/lib/geolibreProject.js"]
  }),
  preserveOnlySource({
    id: "3d-tiles", label: "3D Tiles", section: "3d", tier: "advanced",
    summary: "3D Tiles definitions are retained without fetching a tileset graph.",
    loss: "Tileset traversal, bounding volumes, transforms, glTF content, implicit tiling, metadata, and rendering are not supported.",
    evidence: ["app/src/lib/geolibreProject.js"]
  }),
  preserveOnlySource({
    id: "gltf-model", label: "glTF model", section: "3d", tier: "advanced",
    summary: "glTF model definitions are retained without executing or rendering model resources.",
    loss: "Buffers, images, materials, animation, extensions, coordinates, placement, and rendering are not supported.",
    evidence: ["app/src/lib/geolibreProject.js"]
  }),
  preserveOnlySource({
    id: "duckdb", label: "DuckDB", section: "databases", tier: "intermediate",
    summary: "DuckDB query definitions are retained without executing imported SQL.",
    loss: "SQL, extensions, attached files/databases, secrets, result schemas, and query execution are never imported or run.",
    evidence: ["app/src/lib/geolibreProject.js"]
  }),
  source({
    id: "postgres",
    label: "PostgreSQL / PostGIS",
    section: "databases",
    tier: "advanced",
    disposition: "connection-only",
    summary: "User-owned read-only PostGIS connection profiles can be saved and independently verified.",
    operations: operations({
      register: bounded("One TLS PostgreSQL target with write-only encrypted credentials and exact owner scope."),
      read: bounded("Verification runs one fixed read-only PostGIS capability query; arbitrary tables are not read."),
      preserve: bounded("Non-secret target metadata and append-only verification receipts are retained.")
    }, "Table discovery, arbitrary SQL, layer streaming, preview, write, and edit are not enabled."),
    losses: ["Connection verification is not a data-layer adapter; no table, schema, feature, or raster content is exposed."],
    evidence: ["services/api/src/opengeo_api/user_connection_routes.py", "services/api/src/opengeo_api/connection_verification_runtime.py"]
  })
]);

export function sourceCapabilitySummary(catalog = SOURCE_CAPABILITY_CATALOG) {
  const current = catalog.filter(({disposition}) => disposition !== "preserve-only").length;
  return Object.freeze({
    total: catalog.length,
    current,
    preserveOnly: catalog.length - current,
    sections: SECTION_ORDER.length,
    operations: SOURCE_OPERATIONS.length
  });
}

export function filterSourceCapabilities({query = "", section = "all", disposition = "all"} = {}) {
  const needle = searchableText(query);
  return SOURCE_CAPABILITY_CATALOG.filter((record) => {
    if (section !== "all" && record.section !== section) return false;
    if (disposition !== "all" && record.disposition !== disposition) return false;
    if (!needle) return true;
    return searchableText(
      `${record.label} ${record.id} ${record.section} ${record.tier} ${record.disposition} ${record.summary} ${record.losses.join(" ")}`
    ).includes(needle);
  });
}

function searchableText(value) {
  return String(value)
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function sourceCapabilitySections(catalog = SOURCE_CAPABILITY_CATALOG) {
  return SECTION_ORDER.map((id) => Object.freeze({
    id,
    records: Object.freeze(catalog.filter(({section}) => section === id))
  }));
}
