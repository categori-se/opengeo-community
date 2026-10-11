import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {customBasemapDefinition, publicBasemapUrl} from "../src/lib/basemapSource.js";

const ID = "custom-11111111-1111-4111-8111-111111111111";

describe("custom public basemap sources", () => {
  it("creates bounded attributed MapLibre and XYZ records", () => {
    assert.deepEqual(customBasemapDefinition({
      basemapId: ID,
      sourceType: "maplibre-style",
      title: "Community light",
      url: "https://maps.example.org/styles/light.json",
      attribution: "Example mapping community"
    }), {
      basemapId: ID,
      title: "Community light",
      section: "Custom",
      kind: "maplibre-style",
      description: "maps.example.org",
      styleUrl: "https://maps.example.org/styles/light.json",
      attribution: "Example mapping community"
    });
    assert.equal(
      publicBasemapUrl("https://tiles.example.org/{x}/{y}/{z}.png", "raster"),
      "https://tiles.example.org/{x}/{y}/{z}.png"
    );
  });

  for (const url of [
    "http://maps.example.org/style.json",
    "https://user:password@maps.example.org/style.json",
    "https://maps.example.org/style.json?key=secret",
    "https://localhost/style.json",
    "https://127.0.0.1/style.json",
    "https://10.2.3.4/style.json",
    "https://169.254.169.254/latest/meta-data",
    "https://api.protomaps.com/styles/v5/light/en.json",
    "https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
    "https://api.mapbox.com/styles/v1/example/style"
  ]) {
    it(`rejects unsafe or provider-managed source ${url}`, () => {
      assert.throws(() => publicBasemapUrl(url, url.includes("{") ? "raster" : "maplibre-style"));
    });
  }

  it("requires each XYZ placeholder exactly once", () => {
    assert.throws(() => publicBasemapUrl("https://tiles.example.org/{z}/{x}.png", "raster"));
    assert.throws(() => publicBasemapUrl("https://tiles.example.org/{z}/{x}/{y}/{y}.png", "raster"));
  });
});
