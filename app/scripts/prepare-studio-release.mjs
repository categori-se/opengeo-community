import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

import {parseAuthConfig} from "../src/lib/authConfig.js";
import {
  readJson,
  sealManifest,
  sha256,
  snapshotTree,
  verifyManifestSeal,
  writeJson
} from "./release-utils.mjs";
import {reviewedStudioOrigin} from "./studio-release-config.mjs";

const STUDIO_ORIGIN = reviewedStudioOrigin();
const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(appRoot, "..");
const distRoot = resolve(appRoot, "dist");
const buildManifestPath = resolve(workspaceRoot, "dist/opengeo-studio-build.json");
const releaseManifestPath = resolve(workspaceRoot, "dist/opengeo-studio-release.json");
const authConfigPath = resolve(distRoot, "auth-config.json");

const buildManifest = verifyManifestSeal(
  await readJson(buildManifestPath),
  "Studio build manifest"
);
if (buildManifest.schemaVersion !== "opengeo.studio-build.1.0.0"
  || buildManifest.studioOrigin !== STUDIO_ORIGIN) {
  throw new Error("Studio build manifest is for an unexpected origin or schema");
}

const artifactTree = await snapshotTree(distRoot);
const buildFiles = buildManifest.artifactTree.files;
const currentBuildFiles = artifactTree.files.filter(({path}) => path !== "auth-config.json");
if (JSON.stringify(currentBuildFiles) !== JSON.stringify(buildFiles)) {
  throw new Error("Studio build changed before authentication configuration was sealed");
}
const authArtifact = artifactTree.files.find(({path}) => path === "auth-config.json");
if (!authArtifact || artifactTree.files.length !== buildFiles.length + 1) {
  throw new Error("Studio release must contain exactly one separately generated auth-config.json");
}
const authBytes = await readFile(authConfigPath);
if (authBytes.length !== authArtifact.bytes || sha256(authBytes) !== authArtifact.sha256) {
  throw new Error("Studio authentication configuration checksum is inconsistent");
}
const authConfig = parseAuthConfig(JSON.parse(authBytes.toString("utf8")), {
  currentOrigin: STUDIO_ORIGIN
});
if (authConfig.redirectUri !== `${STUDIO_ORIGIN}/login`
  || authConfig.logoutUri !== `${STUDIO_ORIGIN}/login`
  || authConfig.hostedUiBaseUrl !== "https://auth.categori.se") {
  throw new Error("Studio authentication configuration is not bound to the reviewed origin");
}

const releaseManifest = sealManifest({
  schemaVersion: "opengeo.studio-release.1.0.0",
  studioOrigin: STUDIO_ORIGIN,
  buildManifestSha256: buildManifest.manifestSha256,
  authConfig: {
    path: "auth-config.json",
    bytes: authArtifact.bytes,
    sha256: authArtifact.sha256,
    cacheControl: "no-store",
    redirectUri: authConfig.redirectUri,
    logoutUri: authConfig.logoutUri
  },
  artifactTree,
  routes: buildManifest.routes,
  aliases: buildManifest.aliases
});
await writeJson(releaseManifestPath, releaseManifest);

console.log(JSON.stringify({
  status: "prepared",
  studioOrigin: STUDIO_ORIGIN,
  releaseManifestPath,
  files: artifactTree.files.length,
  authConfigSha256: authArtifact.sha256,
  treeDigest: artifactTree.digest
}, null, 2));
