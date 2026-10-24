import {CESIUM_FRAME_PATH} from "../src/lib/cesiumRuntime.js";

// Trusted renderer host documents are assets, not navigable application pages.
export const isRendererHostHtml = path => path === CESIUM_FRAME_PATH.slice(1);

export const canonicalStudioRoutes = Object.freeze([
  ["/", "index.html"],
  ["/public-demo", "public-demo.html"],
  ["/library", "library.html"],
  ["/login", "login.html"],
  ["/workspaces", "workspaces.html"],
  ["/layers", "layers.html"],
  ["/admin", "admin.html"],
  ["/credits", "credits.html"]
]);

export const canonicalBrowserDemoRoutes = Object.freeze([
  ["/", "index.html"], ["/credits", "credits.html"]
]);

// Exact seven-page predecessor remains available to sealed-release rollback.
export const PRE_CREDITS_ROUTE_CONTRACT_VERSION = "opengeo.application-route-inventory.pre-credits.1.0.0";
export const preCreditsStudioRoutes = Object.freeze(
  canonicalStudioRoutes.filter(([path]) => path !== "/credits")
);

// Exact six-route predecessor retained only for rollback of sealed releases.
export const PRE_LAYER_ROUTE_CONTRACT_VERSION = "opengeo.application-route-inventory.pre-layer.1.0.0";
export const preLayerStudioRoutes = Object.freeze([
  ["/", "index.html"], ["/public-demo", "public-demo.html"], ["/library", "library.html"],
  ["/login", "login.html"], ["/workspaces", "workspaces.html"], ["/admin", "admin.html"]
]);

// Studio and the managed demo used this exact generated-record inventory before
// application routes were consolidated. Retained releases still carry sealed
// manifests with this inventory, so rollback verification recognizes it through
// one explicit compatibility version. New builds must continue to use only
// canonicalStudioRoutes.
export const LEGACY_APPLICATION_ROUTE_CONTRACT_VERSION =
  "opengeo.application-route-inventory.legacy-record-pages.1.0.0";

export const legacyStudioRoutes = Object.freeze([
  ["/", "index.html"],
  ["/admin", "admin.html"],
  ["/datasets/dataset_flood_001", "datasets/dataset_flood_001.html"],
  [
    "/datasets/dataset_public_basemap_001",
    "datasets/dataset_public_basemap_001.html"
  ],
  ["/datasets/dataset_roads_001", "datasets/dataset_roads_001.html"],
  ["/datasets/dataset_sites_001", "datasets/dataset_sites_001.html"],
  ["/library", "library.html"],
  ["/login", "login.html"],
  ["/print/layout_nepal_location_map", "print/layout_nepal_location_map.html"],
  ["/public-demo", "public-demo.html"],
  ["/workspaces", "workspaces.html"],
  [
    "/workspaces/50000000-0000-4000-8000-000000000001",
    "workspaces/50000000-0000-4000-8000-000000000001.html"
  ],
  [
    "/workspaces/50000000-0000-4000-8000-000000000002",
    "workspaces/50000000-0000-4000-8000-000000000002.html"
  ],
  [
    "/workspaces/50000000-0000-4000-8000-000000000003",
    "workspaces/50000000-0000-4000-8000-000000000003.html"
  ]
]);

export const prohibitedLegacyRoutePrefixes = Object.freeze([
  "datasets/",
  "print/",
  "workspaces/"
]);

export function assertCanonicalStudioHtml(htmlPaths) {
  const actual = [...htmlPaths].filter(path=>!isRendererHostHtml(path)).sort();
  const expected = canonicalStudioRoutes.map(([, path]) => path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Studio route inventory drifted: expected ${expected.join(", ")}; received ${actual.join(", ")}`
    );
  }
  for (const path of actual) {
    if (prohibitedLegacyRoutePrefixes.some((prefix) => path.startsWith(prefix))) {
      throw new Error(`Legacy fixture record page returned to the Studio build: ${path}`);
    }
  }
}
