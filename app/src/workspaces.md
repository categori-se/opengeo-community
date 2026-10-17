<section id="studio-bootstrap-status" class="platform-state" aria-busy="true">
  <h1>Opening Studio</h1>
  <progress aria-label="Loading Studio" style="width:100%"></progress>
  <p role="status">Loading the workspace interface…</p>
  <p>Your saved work will appear after account access is checked.</p>
</section>

```js
import {loadStudioPage} from "./lib/studioPageBootstrap.js";
import {installStudioSkipLink} from "./lib/studioSkipLink.js";
const disposeSkipLink = installStudioSkipLink(document);
invalidation.then(disposeSkipLink);
import {loadBrowserAuthConfig} from "./lib/authConfig.js";
import {createCognitoBrowserAuth} from "./lib/cognitoAuth.js";
import {createPlatformAdapter} from "./lib/platform.js";
import {mapFontAttachments} from "./lib/mapFontAttachments.js";
import {
  featureRouteTarget,
  mapDatasetRouteTarget,
  publicResourceRouteTarget,
  siteResourceRouteTarget
} from "./lib/applicationRoutes.js";
```

```js
const workspaceSurface = await loadStudioPage(async () => {
  const query = new URL(location.href).searchParams;
  const catalog = query.get("adapter") === "fixture"
    ? await FileAttachment("./data/catalog.json").json()
    : null;
  const runtimeAuthConfig = query.get("adapter") === "fixture"
    ? null
    : await loadBrowserAuthConfig().catch(() => null);
  const platform = await createPlatformAdapter({catalog, capabilities: runtimeAuthConfig?.capabilities});
  const auth = createCognitoBrowserAuth({
    configLoader: runtimeAuthConfig ? async () => runtimeAuthConfig : null
  });
  const compositionId = query.get("composition");
  const publicationId = query.get("publication");
  const projectId = compositionId || publicationId ? null : query.get("project");
  const managementTarget = publicationId ? "publishing" : compositionId
    ? (query.get("manage") === "print" ? "print" : null)
    : query.get("manage");
  const featureTarget = featureRouteTarget(query);
  const mapDatasetTarget = mapDatasetRouteTarget(query);
  const publicResourceTarget = publicResourceRouteTarget(query);
  const siteResourceTarget = siteResourceRouteTarget(query);
  const publicCatalog = query.get("view") === "data" && runtimeAuthConfig?.deployment?.mode === "demo"
    ? {catalog: await FileAttachment("./data/public-demo-catalog.json").json(), massgis: await FileAttachment("./data/massgis-enviroscreen.json").json()}
    : null;
  const selectedDatasetId = featureTarget?.datasetId ?? query.get("dataset");
  const previewSources = query.get("adapter") === "fixture"
    ? await Promise.all([
        FileAttachment("./data/sample-road-network.geojson").json(),
        FileAttachment("./data/sample-flood-exposure.geojson").json(),
        FileAttachment("./data/sample-public-facilities.geojson").json(),
        FileAttachment("./data/sample-site-inspections.csv").csv({typed: true})
      ]).then(([roads, floodExposure, publicFacilities, siteRows]) => new Map([
        ["layer_roads", roads],
        ["layer_candidate_sites", {
          type: "FeatureCollection",
          features: siteRows.map((site) => ({
            type: "Feature",
            properties: site,
            geometry: {type: "Point", coordinates: [site.longitude, site.latitude]}
          }))
        }],
        ["layer_flood_exposure", floodExposure],
        ["layer_public_facilities", publicFacilities]
      ]))
    : new Map();
  const retainSavedProject = (compositionId || publicationId) && platform.kind === "api" && runtimeAuthConfig?.deployment?.mode !== "demo"
    && [...query.keys()].every(key => ["composition", "publication", "adapter"].includes(key));
  const projectPage = !(compositionId || publicationId || projectId) ? null : retainSavedProject
    ? (await import("./components/SavedProjectShell.js")).SavedProjectShell
    : (await import("./components/ProjectWorkspacePage.js")).ProjectWorkspacePage;
  const workspaceSurface = compositionId || publicationId || projectId
    ? projectPage({
        directoryOptions: {deployment: runtimeAuthConfig?.deployment, federation: runtimeAuthConfig?.federation, publicCatalog},
        adapter: platform,
        projectId,
        compositionId,
        publicationId,
        mapId: query.get("map"),
        catalog,
        previewSources,
        mapFontAttachments,
        auth,
        startPanel: query.get("panel"),
        startBlank: query.get("new") === "1",
        managementTarget,
        selectedDatasetId,
        featureTarget,
        mapDatasetTarget,
        siteResourceTarget
      })
    : await (async () => {
      const directory = {
        adapter: platform,
        auth,
        deployment: runtimeAuthConfig?.deployment,
        federation: runtimeAuthConfig?.federation,
        view: query.get("view"),
        publicResourceTarget,
        publicCatalog
      };
      return platform.kind === "api" && runtimeAuthConfig?.deployment?.mode !== "demo"
        ? (await import("./components/StudioDirectoryShell.js")).StudioDirectoryShell({...directory, catalog, mapFontAttachments})
        : (await import("./components/PlatformDirectory.js")).PlatformDirectory(directory);
    })();
  return workspaceSurface;
});
```

```js
document.getElementById("studio-bootstrap-status")?.remove();
display(workspaceSurface);
```

```js
invalidation.then(() => workspaceSurface.dispose?.());
```
