import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, it} from "node:test";

import {parseAuthConfig} from "../src/lib/authConfig.js";
import {
  assertStudioAuthConfig,
  reviewedStudioOrigin,
  studioDeploymentSettings
} from "../scripts/studio-release-config.mjs";
import {assertSurfaceReleaseManifest} from "../scripts/static-release-aws.mjs";
import {canonicalStudioRoutes} from "../scripts/application-route-inventory.mjs";
import {digestFileRecords, sealManifest, sha256} from "../scripts/release-utils.mjs";

const origin = "https://maps.community.example";
const hostedUi = "https://community-login.auth.us-east-1.amazoncognito.com";
const environment = {
  OPEN_GEO_COMMUNITY_DEPLOYMENT: "true",
  OPEN_GEO_STUDIO_ORIGIN: origin,
  OPEN_GEO_STUDIO_BUCKET: "community-maps-studio",
  OPEN_GEO_STUDIO_STACK_NAME: "OpenGeoCommunity-dev-StudioWeb",
  OPEN_GEO_STUDIO_EXPECTED_ACCOUNT: "333333333333",
  OPEN_GEO_AWS_PROFILE: "community-developer",
  OPEN_GEO_AWS_REGION: "us-east-1",
  OPEN_GEO_COGNITO_HOSTED_UI_BASE_URL: hostedUi
};

function withEnvironment(values, callback) {
  const previous = new Map(Object.keys(values).map(name => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function ownAuthConfig() {
  return parseAuthConfig({
    version: 1,
    region: "us-east-1",
    userPoolId: "us-east-1_CommunityPool",
    clientId: "communityclient123",
    hostedUiBaseUrl: hostedUi,
    redirectUri: `${origin}/login`,
    logoutUri: `${origin}/login`,
    scopes: ["openid", "email", "profile"]
  }, {currentOrigin: origin});
}

describe("independent Community Studio releases", () => {
  it("accepts an explicit operator-owned origin, account, bucket and Cognito provider", () => {
    withEnvironment(environment, () => {
      const settings = studioDeploymentSettings();
      assert.equal(settings.origin, origin);
      assert.equal(settings.expectedAccount, "333333333333");
      assert.equal(settings.expectedOriginDomain, "community-maps-studio.s3.us-east-1.amazonaws.com");
      assert.doesNotThrow(() => assertStudioAuthConfig(ownAuthConfig(), origin));
      assert.throws(() => assertStudioAuthConfig({...ownAuthConfig(), hostedUiBaseUrl: "https://auth.categori.se"}, origin), /identity provider/);
    });
  });

  it("fails closed on missing deployment inputs instead of using original installation defaults", () => {
    for (const name of [
      "OPEN_GEO_STUDIO_ORIGIN", "OPEN_GEO_STUDIO_BUCKET", "OPEN_GEO_STUDIO_STACK_NAME",
      "OPEN_GEO_STUDIO_EXPECTED_ACCOUNT", "OPEN_GEO_AWS_PROFILE", "OPEN_GEO_AWS_REGION"
    ]) {
      withEnvironment({...environment, AWS_PROFILE: undefined, AWS_REGION: undefined, [name]: undefined}, () => {
        assert.throws(studioDeploymentSettings, new RegExp(`${name} is required`));
      });
    }
    withEnvironment({...environment, OPEN_GEO_COGNITO_HOSTED_UI_BASE_URL: undefined}, () => {
      assert.throws(() => assertStudioAuthConfig(ownAuthConfig(), origin), /HOSTED_UI_BASE_URL is required/);
    });
  });

  it("keeps HTTPS and exact-origin checks and the currently supported region", () => {
    withEnvironment(environment, () => {
      for (const value of ["http://maps.community.example", `${origin}/path`, `${origin}:8443`, "https://user:password@maps.community.example", "https://unsafe'host.example", "https://localhost"]) {
        assert.throws(() => reviewedStudioOrigin(value), /exact reviewed HTTPS origin/);
      }
    });
    withEnvironment({...environment, OPEN_GEO_AWS_REGION: "us-west-2"}, () => {
      assert.throws(studioDeploymentSettings, /us-east-1 only/);
    });
    withEnvironment({...environment, OPEN_GEO_STUDIO_BUCKET: "Invalid_Bucket"}, () => {
      assert.throws(studioDeploymentSettings, /DNS-compatible/);
    });
    withEnvironment({...environment, OPEN_GEO_COMMUNITY_DEPLOYMENT: undefined}, () => {
      assert.throws(() => reviewedStudioOrigin(origin), /exact reviewed HTTPS origin/);
    });
  });

  it("seals rollback manifests to the installation origin and retains the no-store auth contract", () => {
    const files = [
      ...canonicalStudioRoutes.map(([, path]) => ({path, bytes: 4, sha256: sha256("page")})),
      {path: "auth-config.json", bytes: 4, sha256: sha256("auth")}
    ].sort((a, b) => a.path.localeCompare(b.path));
    const manifest = sealManifest({
      schemaVersion: "opengeo.studio-release.1.0.0",
      studioOrigin: origin,
      artifactTree: {algorithm: "sha256", files, digest: digestFileRecords(files)},
      routes: canonicalStudioRoutes.map(([path, htmlPath]) => ({path, htmlPath})),
      aliases: canonicalStudioRoutes.filter(([path]) => path !== "/").map(([path, htmlPath]) => ({
        key: path.slice(1), sourcePath: htmlPath, bytes: 4, sha256: sha256("page"), contentType: "text/html; charset=utf-8"
      })),
      authConfig: {path: "auth-config.json", cacheControl: "no-store"}
    });
    withEnvironment(environment, () => {
      assert.equal(assertSurfaceReleaseManifest(manifest, "studio", {expectedStudioOrigin: origin}), manifest);
      assert.throws(() => assertSurfaceReleaseManifest(manifest, "studio", {expectedStudioOrigin: "https://other.community.example"}), /contract is invalid/);
      const changed = {...manifest, authConfig: {...manifest.authConfig, cacheControl: "public"}};
      delete changed.manifestSha256;
      assert.throws(() => assertSurfaceReleaseManifest(sealManifest(changed), "studio", {expectedStudioOrigin: origin}), /no-store/);
    });
  });

  it("renders the operator-owned browser config and rejects mismatched application origins before writing", async () => {
    const output = await mkdtemp(join(tmpdir(), "opengeo-community-auth-"));
    try {
      const env = {...process.env, ...environment,
        OPEN_GEO_WEB_ORIGIN: origin,
        OPEN_GEO_COGNITO_REGION: "us-east-1",
        OPEN_GEO_COGNITO_USER_POOL_ID: "us-east-1_CommunityPool",
        OPEN_GEO_COGNITO_CLIENT_ID: "communityclient123",
        OPEN_GEO_AUTH_CONFIG_VERSION: "1",
        OPEN_GEO_AUTH_CONFIG_OUTPUT_DIR: output
      };
      const script = new URL("../scripts/render-auth-config.mjs", import.meta.url);
      const rendered = spawnSync(process.execPath, [script.pathname], {env, encoding: "utf8"});
      assert.equal(rendered.status, 0, rendered.stderr);
      const config = JSON.parse(await readFile(join(output, "auth-config.json"), "utf8"));
      assert.equal(config.hostedUiBaseUrl, hostedUi);
      assert.equal(config.redirectUri, `${origin}/login`);
      const rejected = spawnSync(process.execPath, [script.pathname], {
        env: {...env, OPEN_GEO_WEB_ORIGIN: "https://other.community.example"}, encoding: "utf8"
      });
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /configured Studio origin/);
      assert.equal(await readFile(join(output, "auth-config.json"), "utf8"), `${JSON.stringify(config, null, 2)}\n`);
    } finally {
      await rm(output, {recursive: true, force: true});
    }
  });
});
