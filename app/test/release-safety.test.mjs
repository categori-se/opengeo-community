import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, it} from "node:test";

import {
  assertLegacyPublicRollbackSupplement,
  assertPublicResumeListing,
  assertRemoteReleaseListing,
  assertSurfaceReleaseManifest,
  expectedRemoteReleaseObjects
} from "../scripts/static-release-aws.mjs";
import {
  assertPublicArtifactBoundary,
  digestFileRecords,
  readJson,
  sealManifest,
  sha256
} from "../scripts/release-utils.mjs";
import {
  canonicalStudioRoutes,
  PRE_LAYER_ROUTE_CONTRACT_VERSION,
  preLayerStudioRoutes,
  LEGACY_APPLICATION_ROUTE_CONTRACT_VERSION,
  legacyStudioRoutes
} from "../scripts/application-route-inventory.mjs";

describe("interrupted public alias uploads", () => {
  async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), "opengeo-resume-"));
    t.after(() => rm(root, {recursive: true, force: true}));
    const body = Buffer.from("sealed article");
    await writeFile(join(root, "index.html"), body);
    const file = fileRecord("index.html", body);
    const etag = `"${createHash("md5").update(body).digest("hex")}"`;
    const retained = {path: "original", bytes: 3, etag: '"retained"'};
    const releasePrefix = "releases/reviewed";
    const object = path => ({Key: `${releasePrefix}/${path}`, Size: body.length, ETag: etag});
    return {root, releasePrefix, phase: "aliases", manifestBytes: Buffer.from("manifest"),
      retainedObjects: [retained], artifactTree: {files: [file]},
      aliases: [{key: "article", sourcePath: "index.html", bytes: file.bytes, sha256: file.sha256}],
      listing: {IsTruncated: false, Contents: [
        {Key: `${releasePrefix}/original`, Size: retained.bytes, ETag: retained.etag},
        object("index.html"), object("article")
      ]}};
  }
  it("reuses exact completed artifacts and aliases without rewriting them", async t => {
    const result = await assertPublicResumeListing(await fixture(t));
    assert.equal(result.artifactsComplete, true);
    assert.deepEqual([...result.completedCopies], ["original"]);
    assert.deepEqual([...result.completedAliases], ["article"]);
    assert.equal(result.manifestComplete, false);
  });
  it("requires explicit alias-phase review and complete predecessors", async t => {
    const input = await fixture(t);
    await assert.rejects(assertPublicResumeListing({...input, phase: "retention"}), /early release phase/);
    input.listing.Contents.splice(1, 1);
    await assert.rejects(assertPublicResumeListing(input), /completed upload predecessors/);
  });
  it("refuses changed upload bytes and unexpected objects", async t => {
    const input = await fixture(t);
    input.listing.Contents[2].ETag = '"changed"';
    await assert.rejects(assertPublicResumeListing(input), /upload identity changed/);
    input.listing.Contents[2].Key = `${input.releasePrefix}/foreign`;
    await assert.rejects(assertPublicResumeListing(input), /Unknown object/);
  });
  it("refuses truncated inventories and objects from another release", async t => {
    const input = await fixture(t);
    await assert.rejects(assertPublicResumeListing({...input, listing: {...input.listing, IsTruncated: true}}), /Invalid public resume/);
    input.listing.Contents[0].Key = "another-release/original";
    await assert.rejects(assertPublicResumeListing(input), /outside the release prefix/);
  });
});

describe("dedicated demo release boundary", () => {
  it("seals every direct workbench browser-platform dependency", () => {
    const builder = readFileSync(
      new URL("../scripts/build-demo-site.mjs", import.meta.url),
      "utf8"
    );
    assert.match(builder, /\["lib\/browserPlatform\.js", "lib\/browserPlatform\.js"\]/);
    assert.match(builder, /\["governed browser-platform contract", \/\^_import\\\/lib\\\/browserPlatform/);
  });

  it("allows MassGIS project metadata but excludes archived dataset bodies", () => {
    const reviewed = [
      "_import/lib/massgisDemo.abc123.js",
      "_import/lib/publicDemoProject.abc123.js",
      "_import/lib/layerOrder.abc123.js",
      "_import/lib/thematicStyle.abc123.js",
      "_file/data/massgis-enviroscreen.abc123.json"
    ];
    assert.doesNotThrow(() => assertPublicArtifactBoundary(
      reviewed,
      "Dedicated workbench demo",
      {allowWorkbenchDemo: true}
    ));
    assert.throws(
      () => assertPublicArtifactBoundary(reviewed, "Public publication"),
      /Studio-only artifacts or routes/
    );
    assert.throws(() => assertPublicArtifactBoundary(
      [...reviewed, "_file/data/massgis-massenviroscreen-2026-04-18-72003a49bbd9.geojson.7e280ab1.gz"],
      "Dedicated workbench demo",
      {allowWorkbenchDemo: true}
    ), /Studio-only artifacts or routes/);
  });
});

describe("static release rollback contracts", () => {
  it("seals the exact 142-object legacy /dist supplement", async () => {
    const supplement = assertLegacyPublicRollbackSupplement(
      await readJson(new URL("../../docs/opengeo-public-dist-rollback-supplement.json", import.meta.url))
    );
    assert.equal(supplement.expectedBaseArtifactCount, 106);
    assert.equal(supplement.expectedBaseAliasCount, 34);
    assert.equal(supplement.objects.length, 2);
  });

  it("accepts the legacy public contract only for the explicit /dist rollback path", () => {
    const legacy = releaseManifest("public", {legacy: true});
    assert.throws(
      () => assertSurfaceReleaseManifest(legacy, "public"),
      /contract is invalid/
    );
    assert.equal(
      assertSurfaceReleaseManifest(legacy, "public", {allowLegacyPublic: true}),
      legacy
    );
  });

  it("accepts only a complete sealed Studio release contract", () => {
    const manifest = releaseManifest("studio");
    assert.equal(assertSurfaceReleaseManifest(manifest, "studio"), manifest);

    const missingAuth = sealManifest({
      ...withoutSeal(manifest),
      authConfig: {...manifest.authConfig, path: "missing.json"}
    });
    assert.throws(
      () => assertSurfaceReleaseManifest(missingAuth, "studio"),
      /lacks its sealed no-store auth configuration/
    );
  });

  it("accepts the exact legacy Studio inventory only through its versioned rollback lane", () => {
    const legacy = applicationReleaseManifest("studio", legacyStudioRoutes);
    assert.throws(
      () => assertSurfaceReleaseManifest(legacy, "studio"),
      /contract is invalid/
    );
    assert.equal(
      assertSurfaceReleaseManifest(legacy, "studio", {
        legacyApplicationRouteContractVersion: LEGACY_APPLICATION_ROUTE_CONTRACT_VERSION
      }),
      legacy
    );
    assert.throws(
      () => assertSurfaceReleaseManifest(legacy, "studio", {
        legacyApplicationRouteContractVersion:
          "opengeo.application-route-inventory.legacy-record-pages.2.0.0"
      }),
      /compatibility version is not reviewed/
    );

    const changedRoute = sealManifest({
      ...withoutSeal(legacy),
      routes: legacy.routes.map((route, index) => (
        index === 2 ? {...route, path: "/datasets/unreviewed"} : route
      ))
    });
    assert.throws(
      () => assertSurfaceReleaseManifest(changedRoute, "studio", {
        legacyApplicationRouteContractVersion: LEGACY_APPLICATION_ROUTE_CONTRACT_VERSION
      }),
      /contract is invalid/
    );
  });

  it("accepts both the historical anonymous demo and the sealed managed demo", () => {
    const anonymous = sealManifest({
      schemaVersion: "opengeo.demo-build.1.0.0",
      demoOrigin: "https://demo.studio.opengeo.tools",
      artifactTree: artifactTree([fileRecord("index.html", "demo")]),
      routes: [{path: "/"}],
      aliases: []
    });
    assert.equal(assertSurfaceReleaseManifest(anonymous, "demo"), anonymous);

    const files = [fileRecord("auth-config.json", "auth"), fileRecord("index.html", "demo")];
    const index = files[1];
    const aliases = Array.from({length: canonicalStudioRoutes.length - 1}, (_, indexNumber) => ({
      key: `route-${String(indexNumber).padStart(2, "0")}`,
      sourcePath: "index.html",
      bytes: index.bytes,
      sha256: index.sha256,
      contentType: "text/html; charset=utf-8"
    }));
    const managed = sealManifest({
      schemaVersion: "opengeo.managed-demo-release.1.0.0",
      demoOrigin: "https://demo.studio.opengeo.tools",
      authConfig: {
        path: "auth-config.json",
        bytes: files[0].bytes,
        sha256: files[0].sha256,
        cacheControl: "no-store"
      },
      artifactTree: artifactTree(files),
      routes: Array.from({length: canonicalStudioRoutes.length}, (_, indexNumber) => ({path: `/page-${indexNumber}`})),
      aliases
    });
    assert.equal(assertSurfaceReleaseManifest(managed, "demo"), managed);
  });

  it("accepts the exact legacy managed-demo inventory only for rollback", () => {
    const legacy = applicationReleaseManifest("demo", legacyStudioRoutes);
    assert.throws(
      () => assertSurfaceReleaseManifest(legacy, "demo"),
      /contract is invalid/
    );
    assert.equal(
      assertSurfaceReleaseManifest(legacy, "demo", {
        legacyApplicationRouteContractVersion: LEGACY_APPLICATION_ROUTE_CONTRACT_VERSION
      }),
      legacy
    );

    const changedAlias = sealManifest({
      ...withoutSeal(legacy),
      aliases: legacy.aliases.map((alias, index) => (
        index === 1 ? {...alias, key: "datasets/unreviewed"} : alias
      ))
    });
    assert.throws(
      () => assertSurfaceReleaseManifest(changedAlias, "demo", {
        legacyApplicationRouteContractVersion: LEGACY_APPLICATION_ROUTE_CONTRACT_VERSION
      }),
      /contract is invalid/
    );
  });

  it("accepts a dev Studio origin only when the rollback caller binds it exactly", () => {
    const devOrigin = "https://d1234567890.cloudfront.net";
    const manifest = releaseManifest("studio", {studioOrigin: devOrigin});
    assert.throws(
      () => assertSurfaceReleaseManifest(manifest, "studio"),
      /contract is invalid/
    );
    assert.equal(
      assertSurfaceReleaseManifest(manifest, "studio", {expectedStudioOrigin: devOrigin}),
      manifest
    );
    assert.throws(
      () => assertSurfaceReleaseManifest(manifest, "studio", {
        expectedStudioOrigin: "https://attacker.example"
      }),
      /outside the reviewed boundary/
    );
  });

  it("rejects Studio artifacts from a sealed public rollback", () => {
    const manifest = releaseManifest("public");
    const leaked = fileRecord("login.html", "login");
    const files = [...manifest.artifactTree.files, leaked].sort(byPath);
    const unsafe = sealManifest({
      ...withoutSeal(manifest),
      artifactTree: {
        algorithm: "sha256",
        digest: digestFileRecords(files),
        files
      }
    });
    assert.throws(
      () => assertSurfaceReleaseManifest(unsafe, "public"),
      /Studio-only artifacts or routes/
    );
  });

  it("rejects a sealed release without index.html", () => {
    const manifest = releaseManifest("public");
    const files = [fileRecord("home.html", "public")];
    const rootless = sealManifest({
      ...withoutSeal(manifest),
      artifactTree: {
        algorithm: "sha256",
        digest: digestFileRecords(files),
        files
      }
    });
    assert.throws(
      () => assertSurfaceReleaseManifest(rootless, "public"),
      /lacks its sealed index.html/
    );
  });

  it("requires the exact remote object inventory sealed by the manifest", () => {
    const manifest = assertSurfaceReleaseManifest(releaseManifest("public"), "public");
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const expected = expectedRemoteReleaseObjects(manifest, {
      manifestObject: {
        path: "opengeo-public-release-manifest.json",
        bytes: manifestBytes.length,
        sha256: sha256(manifestBytes)
      }
    });
    const prefix = "releases/opengeo-public-20260821120000-aaaaaaaaaaaa";
    const listing = {
      IsTruncated: false,
      Contents: expected.map(({path, bytes}) => ({Key: `${prefix}/${path}`, Size: bytes}))
    };
    assert.doesNotThrow(() => assertRemoteReleaseListing({
      listing,
      prefix,
      expected,
      surface: "public"
    }));
    assert.throws(
      () => assertRemoteReleaseListing({
        listing: {...listing, Contents: listing.Contents.slice(1)},
        prefix,
        expected,
        surface: "public"
      }),
      /inventory does not match its seal/
    );
  });
});

function releaseManifest(
  surface,
  {legacy = false, studioOrigin = "https://studio.opengeo.tools"} = {}
) {
  const files = surface === "studio"
    ? [fileRecord("auth-config.json", "auth"), fileRecord("index.html", "studio")]
    : [fileRecord("index.html", "public")];
  const aliasCount = surface === "studio" ? canonicalStudioRoutes.length - 1 : legacy ? 34 : 35;
  const routeCount = surface === "studio" ? canonicalStudioRoutes.length : legacy ? 27 : 28;
  const aliases = Array.from({length: aliasCount}, (_, index) => ({
    key: `route-${String(index).padStart(2, "0")}`,
    sourcePath: "index.html",
    bytes: files.find(({path}) => path === "index.html").bytes,
    sha256: files.find(({path}) => path === "index.html").sha256,
    contentType: "text/html; charset=utf-8"
  }));
  return sealManifest({
    schemaVersion: surface === "studio"
      ? "opengeo.studio-release.1.0.0"
      : legacy ? "opengeo.public-bundle.1.0.0" : "opengeo.public-bundle.2.0.0",
    ...(surface === "studio"
      ? {studioOrigin}
      : {publicOrigin: "https://opengeo.tools"}),
    ...(surface === "studio"
      ? {
          authConfig: {
            path: "auth-config.json",
            bytes: files[0].bytes,
            sha256: files[0].sha256,
            cacheControl: "no-store"
          }
        }
      : {}),
    artifactTree: {
      algorithm: "sha256",
      digest: digestFileRecords(files),
      files
    },
    routes: Array.from({length: routeCount}, (_, index) => ({path: `/page-${index}`})),
    aliases
  });
}

function applicationReleaseManifest(surface, routes) {
  const auth = fileRecord("auth-config.json", `${surface}-auth`);
  const routeFiles = routes.map(([, htmlPath]) => fileRecord(htmlPath, `${surface}:${htmlPath}`));
  const files = [auth, ...routeFiles];
  const byHtmlPath = new Map(files.map((file) => [file.path, file]));
  const routeRecords = routes.map(([path, htmlPath]) => {
    const file = byHtmlPath.get(htmlPath);
    return {
      path,
      htmlPath,
      bytes: file.bytes,
      sha256: file.sha256,
      aliases: path === "/" ? [] : [path.slice(1)]
    };
  });
  const aliases = routeRecords.flatMap((route) => route.aliases.map((key) => ({
    key,
    sourcePath: route.htmlPath,
    bytes: route.bytes,
    sha256: route.sha256,
    contentType: "text/html; charset=utf-8"
  })));
  return sealManifest({
    schemaVersion: surface === "studio"
      ? "opengeo.studio-release.1.0.0"
      : "opengeo.managed-demo-release.1.0.0",
    ...(surface === "studio"
      ? {studioOrigin: "https://studio.opengeo.tools"}
      : {demoOrigin: "https://demo.studio.opengeo.tools"}),
    authConfig: {
      path: "auth-config.json",
      bytes: auth.bytes,
      sha256: auth.sha256,
      cacheControl: "no-store"
    },
    artifactTree: artifactTree(files),
    routes: routeRecords,
    aliases
  });
}

function fileRecord(path, text) {
  const bytes = Buffer.from(text);
  return {path, bytes: bytes.length, sha256: sha256(bytes)};
}

function artifactTree(files) {
  const sorted = [...files].sort(byPath);
  return {algorithm: "sha256", digest: digestFileRecords(sorted), files: sorted};
}

function withoutSeal(value) {
  const {manifestSha256: _ignored, ...payload} = value;
  return payload;
}

function byPath(left, right) {
  return left.path.localeCompare(right.path);
}

it("retains the exact pre-layer inventory only for explicitly versioned rollback", () => {
  for (const surface of ["studio", "demo"]) {
    const previous = applicationReleaseManifest(surface, preLayerStudioRoutes);
    assert.throws(() => assertSurfaceReleaseManifest(previous, surface));
    assert.equal(assertSurfaceReleaseManifest(previous, surface, {
      preLayerRouteContractVersion: PRE_LAYER_ROUTE_CONTRACT_VERSION
    }), previous);
  }
});
