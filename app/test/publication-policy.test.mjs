import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {describe, it} from "node:test";

import {validatePublicDemoCatalog} from "../src/lib/publicationPolicy.js";

const catalog = JSON.parse(
  await readFile(new URL("../src/data/public-demo-catalog.json", import.meta.url), "utf8")
);

describe("public demo publication policy", () => {
  it("accepts the synthetic and MassGIS examples with exact rights metadata", () => {
    const result = validatePublicDemoCatalog(catalog);
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0].sourceFiles[0].license, "CC0-1.0");
    assert.equal(result.entries[0].sourceFiles[0].public, true);
    assert.equal(result.entries[1].sourceFiles[0].license, "LicenseRef-Public-Domain");
    assert.equal(
      new URL(result.entries[1].sourceFiles[0].sourceUrl).hostname,
      "services1.arcgis.com"
    );
    assert.match(result.entries[1].sourceFiles[0].rightsUrl, /^https:\/\/www\.mass\.gov\//);
  });

  it("fails closed for private, unlicensed, proprietary, or unattributed sources", () => {
    for (const sourcePatch of [
      {public: false},
      {license: null},
      {license: "All rights reserved"},
      {attribution: ""}
    ]) {
      const candidate = structuredClone(catalog);
      Object.assign(candidate.entries[0].sourceFiles[0], sourcePatch);
      assert.throws(() => validatePublicDemoCatalog(candidate), TypeError);
    }
  });

  it("rejects unsafe public paths and unknown policy fields", () => {
    const unsafePath = structuredClone(catalog);
    unsafePath.entries[0].sourceFiles[0].path = "/data/../private.geojson";
    assert.throws(() => validatePublicDemoCatalog(unsafePath), /path/);

    const widened = structuredClone(catalog);
    widened.entries[0].sourceFiles[0].credentials = "include";
    assert.throws(() => validatePublicDemoCatalog(widened), /unknown field/);

    for (const sourceUrl of [
      "http://services1.arcgis.com/layer",
      "https://127.0.0.1/layer",
      "https://services1.arcgis.com/layer?token=secret"
    ]) {
      const unsafeUrl = structuredClone(catalog);
      unsafeUrl.entries[1].sourceFiles[0].sourceUrl = sourceUrl;
      assert.throws(() => validatePublicDemoCatalog(unsafeUrl), /URL|credential-like/);
    }
  });
});
