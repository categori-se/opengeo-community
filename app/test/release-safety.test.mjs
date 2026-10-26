import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, it} from "node:test";

import {
  assertLegacyPublicRollbackSupplement,
  assertPublicResumeListing,
  assertRemoteReleaseListing,
  assertSurfaceReleaseManifest,
  deployStaticRelease,
  expectedRemoteReleaseObjects,
  listStaticReleaseObjects
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
  PRE_CREDITS_ROUTE_CONTRACT_VERSION,
  preCreditsStudioRoutes,
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

describe("static release object limits", () => {
  function sizedManifest(surface, count) {
    const base = surface === "public"
      ? releaseManifest(surface)
      : applicationReleaseManifest(surface, canonicalStudioRoutes);
    const bodies = new Map(base.artifactTree.files.map(({path}) => [path,
      surface === "public" ? "public"
        : path === "auth-config.json" ? `${surface}-auth` : `${surface}:${path}`
    ]));
    for (let index = bodies.size; index < count; index++) {
      bodies.set(`asset-${String(index).padStart(4, "0")}.txt`, `asset ${index}`);
    }
    const manifest = sealManifest({
      ...withoutSeal(base),
      artifactTree: artifactTree([...bodies].map(([path, body]) => fileRecord(path, body)))
    });
    return {manifest, bodies};
  }

  async function fixture(t, surface, count) {
    const directory = await mkdtemp(join(tmpdir(), "opengeo-object-limit-"));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const root = join(directory, "artifacts");
    await mkdir(root);
    const {manifest, bodies} = sizedManifest(surface, count);
    const entries = [...bodies];
    for (let offset = 0; offset < entries.length; offset += 64) {
      await Promise.all(entries.slice(offset, offset + 64).map(([path, body]) => (
        writeFile(join(root, path), body)
      )));
    }
    const manifestPath = join(directory, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    return {manifest, options: {
      surface,
      root,
      manifestPath,
      expectedBucket: `${surface}.example.invalid`,
      expectedAlias: `${surface}.example.invalid`,
      releaseStem: `opengeo-${surface}`,
      aliases: manifest.aliases,
      noStorePaths: surface === "public" ? [] : ["auth-config.json"],
      localCheck: true
    }};
  }

  for (const [files, expectedObjects] of [[989, 997], [992, 1000], [993, 1001], [1992, 2000]]) {
    it(`accepts ${files} Studio artifacts for publication and rollback (${expectedObjects} objects)`, async t => {
      const {manifest, options} = await fixture(t, "studio", files);
      assert.equal(assertSurfaceReleaseManifest(manifest, "studio"), manifest);
      const result = await deployStaticRelease(options);
      assert.equal(result.mode, "local-check");
      assert.equal(result.files, files);
      assert.equal(result.aliases, 7);
      assert.equal(result.expectedObjects, expectedObjects);
      assert.equal(expectedRemoteReleaseObjects(manifest, {
        manifestObject: {path: "opengeo-studio-release-manifest.json", bytes: 1, sha256: sha256("m")}
      }).length, expectedObjects);
    });
  }

  it("rejects 1993 Studio artifacts before publication and rollback", async t => {
    const {manifest, options} = await fixture(t, "studio", 1993);
    assert.throws(() => assertSurfaceReleaseManifest(manifest, "studio"), /contract is invalid/);
    await assert.rejects(deployStaticRelease(options), /studio release contains too many files/);
  });

  it("retains the 2000-object bound when an extra Studio alias exhausts the budget", async t => {
    const {manifest, options} = await fixture(t, "studio", 1992);
    const aliases = [...manifest.aliases, {...manifest.aliases[0], key: "extra-route"}];
    const extraAliasManifest = sealManifest({...withoutSeal(manifest), aliases});
    await writeFile(options.manifestPath, JSON.stringify(extraAliasManifest));
    assert.throws(() => assertSurfaceReleaseManifest(extraAliasManifest, "studio"), /contract is invalid/);
    await assert.rejects(deployStaticRelease({...options, aliases}), /exceeds the verified object-count bound/);
  });

  for (const surface of ["public", "demo"]) {
    it(`keeps the ${surface} artifact limit at 900 for publication and rollback`, async t => {
      const accepted = sizedManifest(surface, 900).manifest;
      assert.equal(assertSurfaceReleaseManifest(accepted, surface), accepted);
      const {manifest, options} = await fixture(t, surface, 901);
      assert.throws(() => assertSurfaceReleaseManifest(manifest, surface), /contract is invalid/);
      await assert.rejects(deployStaticRelease(options), new RegExp(`${surface} release contains too many files`));
    });
  }
});

describe("bounded static release listing", () => {
  function fixture(count = 1001) {
    const prefix = "releases/opengeo-studio-reviewed";
    const expected = Array.from({length: count}, (_, index) => ({path: `asset-${String(index).padStart(4, "0")}`, bytes: index}));
    const objects = expected.map(({path, bytes}) => ({Key: `${prefix}/${path}`, Size: bytes}));
    const pages = [];
    for (let offset = 0; offset < count; offset += 1000) {
      const Contents = objects.slice(offset, offset + 1000);
      const IsTruncated = offset + 1000 < count;
      pages.push({Contents, KeyCount: Contents.length, IsTruncated,
        ...(IsTruncated ? {NextContinuationToken: "reviewed-next-page"} : {})});
    }
    const calls = [];
    return {pages, calls, options: {surface: "studio", bucket: "studio.example.invalid", prefix, expected,
      profile: "reviewed", read(args, profile) {
        calls.push({args, profile});
        assert.ok(calls.length <= pages.length, "unexpected additional page request");
        return pages[calls.length - 1];
      }}};
  }

  for (const count of [1000, 1001, 2000]) {
    it(`reads exactly ${Math.ceil(count / 1000)} explicit pages for ${count} objects`, () => {
      const {options, calls} = fixture(count);
      const listing = listStaticReleaseObjects(options);
      assert.equal(listing.KeyCount, count);
      assert.equal(listing.IsTruncated, false);
      assert.equal(calls.length, Math.ceil(count / 1000));
      for (const {args, profile} of calls) {
        assert.equal(profile, "reviewed");
        assert.ok(args.includes("--no-paginate"));
        assert.equal(args[args.indexOf("--max-keys") + 1], "1000");
        assert.equal(args[args.indexOf("--prefix") + 1], `${options.prefix}/`);
      }
      assert.ok(!calls[0].args.includes("--continuation-token"));
      if (calls.length === 2) assert.deepEqual(calls[1].args.slice(-2), ["--continuation-token", "reviewed-next-page"]);
    });
  }

  it("rejects inventories beyond the surface budget without requesting a page", () => {
    const {options, calls} = fixture(2001);
    assert.throws(() => listStaticReleaseObjects(options), /object-count bound/);
    assert.equal(calls.length, 0);
    for (const surface of ["public", "demo"]) {
      assert.throws(() => listStaticReleaseObjects({...options, surface, expected: options.expected.slice(0, 1001)}), /object-count bound/);
      assert.equal(calls.length, 0);
    }
  });

  it("stops at two pages when the second page is still truncated", () => {
    const {options, pages, calls} = fixture(2000);
    Object.assign(pages[1], {IsTruncated: true, NextContinuationToken: "third-page"});
    assert.throws(() => listStaticReleaseObjects(options), /object-count bound/);
    assert.equal(calls.length, 2);
  });

  it("rejects missing or repeated continuation tokens", () => {
    for (const next of [undefined, ""]) {
      const {options, pages, calls} = fixture();
      pages[0].NextContinuationToken = next;
      assert.throws(() => listStaticReleaseObjects(options), /missing or repeated/);
      assert.equal(calls.length, 1);
    }
    const {options, pages, calls} = fixture();
    Object.assign(pages[1], {IsTruncated: true, NextContinuationToken: pages[0].NextContinuationToken});
    assert.throws(() => listStaticReleaseObjects(options), /missing or repeated/);
    assert.equal(calls.length, 2);
  });

  it("rejects duplicate, foreign-prefix, unexpected and changed-size objects", () => {
    for (const change of [
      (pages) => {pages[1].Contents[0] = pages[0].Contents[0];},
      (pages) => {pages[1].Contents[0].Key = "releases/other/asset";},
      (pages) => {pages[1].Contents[0].Key += "-unexpected";},
      (pages) => {pages[1].Contents[0].Size++;}
    ]) {
      const {options, pages} = fixture();
      change(pages);
      assert.throws(() => listStaticReleaseObjects(options), /unexpected or duplicate object/);
    }
  });

  it("rejects missing objects and inconsistent page metadata", () => {
    for (const change of [
      (pages) => {pages[1].Contents = []; pages[1].KeyCount = 0;},
      (pages) => {pages[0].KeyCount--;},
      (pages) => {delete pages[0].IsTruncated;},
      (pages) => {pages[0].CommonPrefixes = [{Prefix: "foreign/"}];},
      (pages) => {pages[1].NextContinuationToken = "unexpected-token";}
    ]) {
      const {options, pages} = fixture();
      change(pages);
      assert.throws(() => listStaticReleaseObjects(options), /inventory does not match|invalid page|unexpected continuation/);
    }
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

it("preserves sealed releases from before public credits without accepting route substitutions", () => {
  for (const surface of ["studio", "demo"]) {
    const previous = applicationReleaseManifest(surface, preCreditsStudioRoutes);
    assert.throws(() => assertSurfaceReleaseManifest(previous, surface));
    assert.equal(assertSurfaceReleaseManifest(previous, surface, {
      preCreditsRouteContractVersion: PRE_CREDITS_ROUTE_CONTRACT_VERSION
    }), previous);
    const changed = structuredClone(previous);
    changed.routes[1].path = "/unreviewed";
    assert.throws(() => assertSurfaceReleaseManifest(sealManifest(withoutSeal(changed)), surface, {
      preCreditsRouteContractVersion: PRE_CREDITS_ROUTE_CONTRACT_VERSION
    }));
  }
});
