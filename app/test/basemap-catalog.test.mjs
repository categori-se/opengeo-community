import assert from "node:assert/strict";
import {describe, it} from "node:test";

import {
  BASEMAP_CATALOG_REFERENCE_GROUPS,
  buildBasemapCatalog,
  selectableBasemap,
  unavailableBasemapMessage
} from "../src/lib/basemapCatalog.js";
import {BASEMAPS} from "../src/lib/workbenchConfig.js";

describe("UX-007 focused basemap catalog contract", () => {
  it("keeps the six GeoLibre-indexed OpenFreeMap styles selectable", () => {
    const catalog = buildBasemapCatalog(BASEMAPS);
    assert.deepEqual(
      catalog.slice(0, 3).map(({groupId}) => groupId),
      ["key-free-imagery", "openfreemap", "key-free-terrain-relief"]
    );
    const openFreeMap = catalog.find(({groupId}) => groupId === "openfreemap");
    assert.deepEqual(
      openFreeMap.choices.map(({title}) => title),
      ["Liberty", "Liberty 3D", "Positron", "Bright", "Dark", "Fiord"]
    );
    assert.ok(openFreeMap.choices.every(({availability, basemapId}) => (
      availability === "available" && selectableBasemap(catalog, basemapId)?.basemapId === basemapId
    )));
  });

  it("puts reviewed key-free imagery and relief ahead of provider-key choices", () => {
    const catalog = buildBasemapCatalog(BASEMAPS);
    const imagery = catalog.find(({groupId}) => groupId === "key-free-imagery");
    const relief = catalog.find(({groupId}) => groupId === "key-free-terrain-relief");
    assert.deepEqual(imagery.choices.map(({title}) => title), [
      "Blue Marble relief",
      "Earth at night",
      "USGS imagery"
    ]);
    assert.deepEqual(relief.choices.map(({title}) => title), ["USGS shaded relief"]);
    for (const choice of [...imagery.choices, ...relief.choices]) {
      assert.equal(choice.availability, "available");
      assert.equal(choice.access, "No API key");
      assert.match(choice.coverage, /Global|U\.S\./);
      assert.match(choice.zoom, /^\d+–\d+$/);
      assert.equal(choice.reviewedAt, "2026-08-28");
      assert.match(choice.termsUrl, /^https:/);
      assert.equal(selectableBasemap(catalog, choice.catalogId)?.kind, "raster");
    }
    assert.ok(catalog.findIndex(({groupId}) => groupId === "key-free-imagery")
      < catalog.findIndex(({groupId}) => groupId === "protomaps"));
  });

  it("lists the GeoLibre-inspired provider and planetary groups while keeping unreviewed imagery unavailable", () => {
    const catalog = buildBasemapCatalog(BASEMAPS);
    assert.deepEqual(
      catalog.filter(({groupId}) => ["protomaps", "regional", "moon", "mars", "other-celestial-bodies"].includes(groupId))
        .map(({groupId}) => groupId),
      ["protomaps", "regional", "moon", "mars", "other-celestial-bodies"]
    );
    for (const group of BASEMAP_CATALOG_REFERENCE_GROUPS) {
      for (const choice of group.choices.filter(({availability}) => availability !== "available")) {
        assert.equal(selectableBasemap(catalog, choice.catalogId), null);
        assert.match(unavailableBasemapMessage(choice), /is unavailable\. .*Required:/);
      }
    }
    assert.equal(selectableBasemap(catalog, "planetary-blank-moon")?.spatialBodyId, "moon");
    assert.equal(selectableBasemap(catalog, "planetary-blank-mars")?.spatialBodyId, "mars");
  });

  it("requires connection-backed Protomaps and a source review for planetary imagery", () => {
    const protomaps = BASEMAP_CATALOG_REFERENCE_GROUPS.find(({groupId}) => groupId === "protomaps");
    assert.ok(protomaps.choices.every(({requirements}) => requirements.includes("reusable provider connection")));
    for (const groupId of ["moon", "mars"]) {
      const group = BASEMAP_CATALOG_REFERENCE_GROUPS.find((candidate) => candidate.groupId === groupId);
      for (const choice of group.choices.filter(({kind}) => kind !== "planetary-blank")) {
        assert.equal(choice.availability, "source-review-required");
        assert.ok(choice.requirements.includes("approved source endpoint"));
        assert.ok(choice.requirements.includes("license and attribution"));
      }
    }
    const other = BASEMAP_CATALOG_REFERENCE_GROUPS.find(({groupId}) => groupId === "other-celestial-bodies");
    assert.ok(other.choices[0].requirements.includes("ellipsoid or sphere definition"));
  });

  it("requires an empty project for every spatial-body change", () => {
    const populatedEarth = buildBasemapCatalog(BASEMAPS, [], null, [], null, {
      spatialBodyId: "earth",
      layerCount: 1
    });
    const moon = populatedEarth.find(({groupId}) => groupId === "moon").choices[0];
    assert.equal(moon.availability, "empty-project-required");
    assert.equal(selectableBasemap(populatedEarth, moon.catalogId), null);

    const populatedMoon = buildBasemapCatalog(BASEMAPS, [], null, [], "planetary-blank-moon", {
      spatialBodyId: "moon",
      layerCount: 2
    });
    const lunarCanvas = populatedMoon.find(({groupId}) => groupId === "moon").choices[0];
    const earthStyle = populatedMoon.find(({groupId}) => groupId === "openfreemap").choices[0];
    const mars = populatedMoon.find(({groupId}) => groupId === "mars").choices[0];
    assert.equal(selectableBasemap(populatedMoon, lunarCanvas.catalogId)?.spatialBodyId, "moon");
    assert.equal(earthStyle.availability, "empty-project-required");
    assert.equal(mars.availability, "empty-project-required");
    assert.equal(selectableBasemap(populatedMoon, earthStyle.catalogId), null);
    assert.equal(selectableBasemap(populatedMoon, mars.catalogId), null);

    const restoredMoon = buildBasemapCatalog([...BASEMAPS, {
      basemapId: "planetary-blank-moon",
      title: "Blank lunar map",
      section: "The Moon",
      kind: "planetary-blank",
      spatialBodyId: "moon"
    }], [], null, [], "planetary-blank-moon", {spatialBodyId: "moon"});
    assert.equal(restoredMoon.flatMap(({choices}) => choices)
      .filter(({catalogId}) => catalogId === "planetary-blank-moon").length, 1);
  });

  it("enables five Protomaps flavors only for a configured project binding", () => {
    const binding = {
      id: "c1000000-0000-4000-8000-000000000056",
      displayName: "Project basemap",
      connection: {
        provider: "protomaps",
        status: "configured",
        credentialReady: true
      }
    };
    const catalog = buildBasemapCatalog(BASEMAPS, [binding], binding.id);
    const protomaps = catalog.find(({groupId}) => groupId === "protomaps");

    assert.deepEqual(
      protomaps.choices.map(({title}) => title),
      ["Light", "Dark", "White", "Grayscale", "Black"]
    );
    assert.ok(protomaps.choices.every((choice) => (
      choice.availability === "available"
      && choice.bindingId === binding.id
      && selectableBasemap(catalog, choice.catalogId)?.provider === "protomaps"
    )));
    assert.ok(protomaps.choices.every(({requirements}) => (
      requirements.includes("client-visible origin-restricted browser key")
    )));

    const withRuntime = buildBasemapCatalog([
      ...BASEMAPS,
      {
        basemapId: protomaps.choices[0].basemapId,
        title: "Protomaps Light",
        section: "Project",
        kind: "provider-style"
      }
    ], [binding], binding.id);
    assert.equal(withRuntime.flatMap(({choices}) => choices)
      .filter(({catalogId}) => catalogId === protomaps.choices[0].catalogId).length, 1);
  });

  it("labels CARTO as key-required and enables only its configured raster choices", () => {
    const draft = buildBasemapCatalog(BASEMAPS).find(({groupId}) => groupId === "carto");
    assert.match(draft.title, /API key required/);
    assert.equal(draft.setupHref, "/workspaces?provider=carto#connections");
    assert.ok(draft.choices.every(({availability}) => availability === "connection-required"));

    const binding = {
      id: "c1000000-0000-4000-8000-000000000057",
      displayName: "CARTO project basemaps",
      connection: {provider: "carto", status: "configured", credentialReady: true}
    };
    const catalog = buildBasemapCatalog(BASEMAPS, [binding], binding.id);
    const carto = catalog.find(({groupId}) => groupId === "carto");
    assert.deepEqual(carto.choices.map(({title}) => title), ["Voyager", "Positron", "Dark Matter"]);
    assert.ok(carto.choices.every((choice) => (
      choice.presentationKind === "raster"
      && selectableBasemap(catalog, choice.catalogId)?.provider === "carto"
    )));
  });

  it("enables only project-governed regional XYZ revisions with aligned coordinates", () => {
    const source = {
      datasetId: "80000000-0000-4000-8000-000000000071",
      name: "Mountain district imagery",
      sourceType: "xyz",
      versionNumber: 3,
      sourceUrl: "https://tiles.example.test/{z}/{x}/{y}.png",
      configuration: {
        minZoom: 2,
        maxZoom: 18,
        tileSize: 256,
        scheme: "tms",
        attribution: "Example mapping agency",
        presentationRole: "regional_basemap",
        license: "CC-BY-4.0",
        coverageBounds: [80, 26, 89, 31],
        coordinateBehavior: "wgs84_web_mercator"
      }
    };
    const basemapId = `governed-xyz-${source.datasetId}-v3`;
    const catalog = buildBasemapCatalog(BASEMAPS, [], null, [source], basemapId);
    const regional = catalog.find(({groupId}) => groupId === "regional");
    const choice = selectableBasemap(catalog, basemapId);

    assert.equal(regional.open, true);
    assert.equal(choice.kind, "governed-raster");
    assert.equal(choice.sourceVersion, 3);
    assert.equal(choice.scheme, "tms");
    assert.equal(choice.license, "CC-BY-4.0");
    assert.deepEqual(choice.sourceConfiguration.coverageBounds, [80, 26, 89, 31]);

    const withRuntime = buildBasemapCatalog([
      ...BASEMAPS,
      {
        ...choice,
        section: "Regional"
      }
    ], [], null, [source], basemapId);
    assert.equal(withRuntime.flatMap(({choices}) => choices)
      .filter(({catalogId}) => catalogId === basemapId).length, 1);

    const offsetCatalog = buildBasemapCatalog(BASEMAPS, [], null, [{
      ...source,
      configuration: {...source.configuration, coordinateBehavior: "gcj02_offset"}
    }]);
    const offset = offsetCatalog.find(({groupId}) => groupId === "regional").choices[0];
    assert.equal(offset.availability, "coordinate-transform-required");
    assert.equal(selectableBasemap(offsetCatalog, offset.catalogId), null);
    assert.match(unavailableBasemapMessage(offset), /approved transform/);
  });

  it("keeps retired saved backgrounds visible until the user explicitly replaces them", () => {
    const catalog = buildBasemapCatalog([...BASEMAPS, {
      basemapId: "carto-positron",
      title: "CARTO Positron",
      section: "Project",
      kind: "raster",
      description: "Restored from this map definition.",
      url: "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
      attribution: "CARTO, OpenStreetMap contributors"
    }], [], null, [], "carto-positron");
    const saved = catalog.find(({groupId}) => groupId === "saved-project-background");
    assert.equal(saved.open, true);
    assert.equal(saved.choices[0].availability, "retired");
    assert.equal(saved.choices[0].replacementBasemapId, "openfreemap-positron");
    assert.equal(selectableBasemap(catalog, "carto-positron"), null);
    assert.match(unavailableBasemapMessage(saved.choices[0]), /exact saved source/);
  });

  it("distinguishes degraded and operator-disabled catalog records", () => {
    const catalog = buildBasemapCatalog([...BASEMAPS, {
      basemapId: "degraded-fixture",
      title: "Degraded fixture",
      section: "Other",
      kind: "raster",
      description: "Fixture",
      url: "https://tiles.example.test/{z}/{x}/{y}.png",
      attribution: "Fixture",
      governance: {
        lifecycle: "active",
        replacementBasemapId: null,
        lifecycleReason: "Fixture policy",
        observation: {status: "degraded", observedAt: "2026-08-27", summary: "HTTP 503"}
      }
    }, {
      basemapId: "disabled-fixture",
      title: "Disabled fixture",
      section: "Project",
      kind: "raster",
      description: "Fixture",
      url: "https://tiles.example.test/{z}/{x}/{y}.png",
      attribution: "Fixture",
      governance: {
        lifecycle: "disabled",
        replacementBasemapId: "blank",
        lifecycleReason: "Fixture policy",
        observation: {status: "not-probed", observedAt: "2026-08-27", summary: "Disabled"}
      }
    }]);
    const degraded = catalog.flatMap(({choices}) => choices)
      .find(({catalogId}) => catalogId === "degraded-fixture");
    const disabled = catalog.flatMap(({choices}) => choices)
      .find(({catalogId}) => catalogId === "disabled-fixture");
    assert.equal(degraded.governanceLabel, "Degraded");
    assert.equal(selectableBasemap(catalog, "degraded-fixture")?.basemapId, "degraded-fixture");
    assert.equal(disabled.availability, "operator-disabled");
    assert.equal(selectableBasemap(catalog, "disabled-fixture"), null);
  });
});
