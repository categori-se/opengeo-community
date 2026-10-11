import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {describe, it} from "node:test";

import config from "../observablehq.config.js";
import {
  directoryHref,
  featureRouteTarget,
  fixtureAdapterKind,
  mapDatasetRouteTarget,
  projectHref,
  PROJECT_SURFACES,
  publicResourceRouteTarget,
  siteResourceRouteTarget
} from "../src/lib/applicationRoutes.js";
import {
  assertCanonicalStudioHtml,
  canonicalStudioRoutes
} from "../scripts/application-route-inventory.mjs";

describe("application route coherence", () => {
  it("leaves navigation to application components instead of fixture records", () => {
    assert.equal(config.sidebar, false);
    assert.equal(config.search, false);
    assert.equal(config.pager, false);
    assert.equal(config.toc, false);
    assert.deepEqual(
      config.pages.map(({path}) => path),
      canonicalStudioRoutes.map(([path]) => path)
    );
    assert.doesNotThrow(() => assertCanonicalStudioHtml([
      ...canonicalStudioRoutes.map(([,path])=>path), "renderer-runtime/cesium-1.145.0/opengeo-host.html"
    ]));
    assert.throws(() => assertCanonicalStudioHtml([
      ...canonicalStudioRoutes.map(([,path])=>path), "renderer-runtime/unreviewed.html"
    ]));
    assert.doesNotThrow(() => assertCanonicalStudioHtml(
      canonicalStudioRoutes.map(([, path]) => path)
    ));
    assert.throws(
      () => assertCanonicalStudioHtml([
        ...canonicalStudioRoutes.map(([, path]) => path),
        "print/layout_nepal_location_map.html"
      ]),
      /route inventory drifted|Legacy fixture/
    );
  });

  it("builds ordinary account and project URLs without redirect chains", () => {
    assert.equal(directoryHref(), "/workspaces");
    assert.equal(directoryHref({view: "data"}), "/workspaces?view=data");
    assert.equal(
      directoryHref({view: "publishing"}),
      "/workspaces?view=publishing"
    );
    assert.equal(
      directoryHref({view: "sources", adapterKind: "fixture"}),
      "/workspaces?view=sources&adapter=fixture"
    );
    const publicResourceTarget = {
      projectId: "c85a6d5e-0000-4000-8000-000000000001",
      resourceId: "90000000-0000-4000-8000-000000000068"
    };
    const publicResourceHref = directoryHref({view: "data", publicResourceTarget});
    assert.equal(
      publicResourceHref,
      "/workspaces?view=data&publicProject=c85a6d5e-0000-4000-8000-000000000001&publicResource=90000000-0000-4000-8000-000000000068"
    );
    assert.deepEqual(
      publicResourceRouteTarget(new URL(publicResourceHref, "https://studio.opengeo.tools").searchParams),
      publicResourceTarget
    );
    assert.equal(
      publicResourceRouteTarget(new URLSearchParams("view=data&publicProject=bad&publicResource=also-bad")),
      null
    );
    assert.equal(
      projectHref("project-1", {management: "data", datasetId: "dataset-1"}),
      "/workspaces?project=project-1&manage=data&dataset=dataset-1#project-data"
    );
    assert.equal(
      projectHref("project-1", {adapterKind: "fixture", management: "publishing"}),
      "/workspaces?project=project-1&adapter=fixture&manage=publishing#project-publishing"
    );
    for (const surface of PROJECT_SURFACES) {
      assert.equal(
        projectHref("project-1", {management: surface}),
        `/workspaces?project=project-1&manage=${surface}#project-${surface}`
      );
    }
    assert.equal(fixtureAdapterKind("fixture"), "fixture");
    assert.equal(fixtureAdapterKind("api"), null);
  });

  it("round-trips only complete, exact feature discussion targets", () => {
    const target = {
      mapId: "60000000-0000-4000-8000-000000000077",
      mapVersion: 3,
      layerId: "wetlands.current",
      datasetId: "80000000-0000-4000-8000-000000000077",
      featureId: "90000000-0000-4000-8000-000000000077"
    };
    const href = projectHref("50000000-0000-4000-8000-000000000077", {
      management: "discussions",
      featureTarget: target
    });
    assert.equal(
      href,
      "/workspaces?project=50000000-0000-4000-8000-000000000077"
        + "&map=60000000-0000-4000-8000-000000000077&manage=discussions"
        + "&dataset=80000000-0000-4000-8000-000000000077"
        + "&feature=90000000-0000-4000-8000-000000000077"
        + "&layer=wetlands.current&mapVersion=3#project-discussions"
    );
    const query = new URL(`https://studio.opengeo.tools${href}`).searchParams;
    assert.deepEqual(featureRouteTarget(query), target);

    for (const malformed of [
      "map=bad&dataset=80000000-0000-4000-8000-000000000077"
        + "&feature=90000000-0000-4000-8000-000000000077&layer=wetlands&mapVersion=3",
      "map=60000000-0000-4000-8000-000000000077"
        + "&dataset=80000000-0000-4000-8000-000000000077"
        + "&feature=90000000-0000-4000-8000-000000000077&layer=wet lands&mapVersion=3",
      "map=60000000-0000-4000-8000-000000000077"
        + "&dataset=80000000-0000-4000-8000-000000000077"
        + "&feature=90000000-0000-4000-8000-000000000077&layer=wetlands&mapVersion=0",
      "map=60000000-0000-4000-8000-000000000077"
        + "&dataset=80000000-0000-4000-8000-000000000077"
        + "&feature=90000000-0000-4000-8000-000000000077&layer=wetlands"
    ]) {
      assert.equal(featureRouteTarget(new URLSearchParams(malformed)), null);
    }
  });

  it("round-trips only complete exact-version dataset-to-map intents", () => {
    const target = {
      mapId: "60000000-0000-4000-8000-000000000078",
      datasetId: "80000000-0000-4000-8000-000000000078",
      datasetVersionId: "81000000-0000-4000-8000-000000000078"
    };
    const href = projectHref("50000000-0000-4000-8000-000000000078", {
      mapDatasetTarget: target,
      fragment: "map-workspace"
    });
    assert.equal(
      href,
      "/workspaces?project=50000000-0000-4000-8000-000000000078"
        + "&map=60000000-0000-4000-8000-000000000078&intent=add-dataset"
        + "&dataset=80000000-0000-4000-8000-000000000078"
        + "&datasetVersion=81000000-0000-4000-8000-000000000078#map-workspace"
    );
    assert.deepEqual(
      mapDatasetRouteTarget(new URL(`https://studio.opengeo.tools${href}`).searchParams),
      target
    );
    for (const malformed of [
      "intent=add-dataset&map=bad&dataset=80000000-0000-4000-8000-000000000078"
        + "&datasetVersion=81000000-0000-4000-8000-000000000078",
      "intent=add-dataset&map=60000000-0000-4000-8000-000000000078"
        + "&dataset=80000000-0000-4000-8000-000000000078",
      "intent=other&map=60000000-0000-4000-8000-000000000078"
        + "&dataset=80000000-0000-4000-8000-000000000078"
        + "&datasetVersion=81000000-0000-4000-8000-000000000078",
      "intent=add-dataset&manage=data&map=60000000-0000-4000-8000-000000000078"
        + "&dataset=80000000-0000-4000-8000-000000000078"
        + "&datasetVersion=81000000-0000-4000-8000-000000000078"
    ]) {
      assert.equal(mapDatasetRouteTarget(new URLSearchParams(malformed)), null);
    }
  });

  it("round-trips only exact resource-to-site assembly intents", () => {
    const target = {
      resourceId: "90000000-0000-4000-8000-000000000079",
      resourceVersion: 4
    };
    const href = projectHref("50000000-0000-4000-8000-000000000079", {
      management: "publishing",
      siteResourceTarget: target,
      fragment: "project-sites"
    });
    assert.equal(
      href,
      "/workspaces?project=50000000-0000-4000-8000-000000000079"
        + "&manage=publishing&intent=add-resource"
        + "&resource=90000000-0000-4000-8000-000000000079"
        + "&resourceVersion=4#project-sites"
    );
    assert.deepEqual(
      siteResourceRouteTarget(new URL(`https://studio.opengeo.tools${href}`).searchParams),
      target
    );
    for (const malformed of [
      "manage=resources&intent=add-resource"
        + "&resource=90000000-0000-4000-8000-000000000079&resourceVersion=4",
      "manage=publishing&intent=add-resource&resource=bad&resourceVersion=4",
      "manage=publishing&intent=add-resource"
        + "&resource=90000000-0000-4000-8000-000000000079&resourceVersion=0",
      "manage=publishing&intent=add-resource"
        + "&resource=90000000-0000-4000-8000-000000000079&resourceVersion=4.5"
    ]) {
      assert.equal(siteResourceRouteTarget(new URLSearchParams(malformed)), null);
    }
  });

  it("keeps the project directory entry point separate from the heavy GIS workbench", async () => {
    const source = await readFile(new URL("../src/workspaces.md", import.meta.url), "utf8");
    assert.doesNotMatch(source, /^import \{ProjectWorkspacePage\}/m);
    assert.doesNotMatch(source, /^import \{PlatformDirectory\}/m);
    assert.match(source, /await import\("\.\/components\/ProjectWorkspacePage\.js"\)/);
    assert.match(source, /await import\("\.\/components\/PlatformDirectory\.js"\)/);
  });

  it("hydrates legacy fixture previews without adding production startup requests", async () => {
    const source = await readFile(new URL("../src/workspaces.md", import.meta.url), "utf8");
    assert.match(source, /const previewSources = query\.get\("adapter"\) === "fixture"/);
    for (const attachment of [
      "sample-road-network.geojson",
      "sample-flood-exposure.geojson",
      "sample-public-facilities.geojson",
      "sample-site-inspections.csv"
    ]) {
      assert.match(source, new RegExp(`FileAttachment\\("\\./data/${attachment.replace(".", "\\.")}\\"`));
    }
    assert.match(source, /coordinates: \[site\.longitude, site\.latitude\]/);
    assert.match(source, /\n  : new Map\(\);/);
    assert.match(source, /const projectPage = [\s\S]*?import\("\.\/components\/ProjectWorkspacePage\.js"\)\)\.ProjectWorkspacePage/);
    assert.match(source, /projectPage\(\{[\s\S]*?previewSources,/);
  });
});
