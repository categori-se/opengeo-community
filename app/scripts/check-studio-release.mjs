import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

import {parseAuthConfig} from "../src/lib/authConfig.js";
import {
  digestFileRecords,
  readJson,
  sha256,
  verifyManifestSeal,
  verifyTree
} from "./release-utils.mjs";
import {reviewedStudioOrigin} from "./studio-release-config.mjs";
import {canonicalStudioRoutes} from "./application-route-inventory.mjs";

const origin = reviewedStudioOrigin();
const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(appRoot, "..");
const [manifest, buildManifest] = await Promise.all([
  readJson(resolve(workspaceRoot, "dist/opengeo-studio-release.json")),
  readJson(resolve(workspaceRoot, "dist/opengeo-studio-build.json"))
]);
verifyManifestSeal(manifest, "Studio release manifest");
verifyManifestSeal(buildManifest, "Studio build manifest");
const expectedRoutes = canonicalStudioRoutes;
if (buildManifest.schemaVersion !== "opengeo.studio-build.1.0.0"
  || manifest.buildManifestSha256 !== buildManifest.manifestSha256
  || JSON.stringify(manifest.routes) !== JSON.stringify(buildManifest.routes)
  || JSON.stringify(manifest.aliases) !== JSON.stringify(buildManifest.aliases)
  || digestFileRecords(buildManifest.artifactTree?.files ?? [])
    !== buildManifest.artifactTree?.digest
  || JSON.stringify(
    manifest.artifactTree?.files?.filter(({path}) => path !== "auth-config.json")
  ) !== JSON.stringify(buildManifest.artifactTree?.files)) {
  throw new Error("Studio release is not bound to its sealed build manifest");
}
if (JSON.stringify(
  manifest.routes.map(({path, htmlPath}) => [path, htmlPath])
) !== JSON.stringify(expectedRoutes)) {
  throw new Error("Studio release does not contain the exact reviewed route set");
}
const expectedAliases = manifest.routes.flatMap((route) => (
  route.path === "/" ? [] : [{
    key: route.path.slice(1),
    sourcePath: route.htmlPath,
    bytes: route.bytes,
    sha256: route.sha256,
    contentType: "text/html; charset=utf-8"
  }]
));
const files = new Map(manifest.artifactTree.files.map((file) => [file.path, file]));
if (JSON.stringify(manifest.aliases) !== JSON.stringify(expectedAliases)
  || manifest.routes.some((route) => {
    const artifact = files.get(route.htmlPath);
    const routeAliases = route.path === "/" ? [] : [route.path.slice(1)];
    return !artifact
      || artifact.bytes !== route.bytes
      || artifact.sha256 !== route.sha256
      || JSON.stringify(route.aliases) !== JSON.stringify(routeAliases);
  })) {
  throw new Error("Studio release alias manifest is incomplete or out of order");
}
if (manifest.schemaVersion !== "opengeo.studio-release.1.0.0"
  || manifest.studioOrigin !== origin
  || manifest.routes?.length !== canonicalStudioRoutes.length
  || manifest.aliases?.length !== canonicalStudioRoutes.length - 1
  || manifest.authConfig?.path !== "auth-config.json"
  || manifest.authConfig?.cacheControl !== "no-store") {
  throw new Error("Studio release manifest contract is invalid");
}
await verifyTree(resolve(appRoot, "dist"), manifest.artifactTree, "Studio release");
const studioHome = await readFile(resolve(appRoot, "dist/index.html"), "utf8");
if (!/_observablehq\/theme-near-midnight,wide\.[0-9a-f]+\.css/.test(studioHome)
  || /_observablehq\/theme-air,/.test(studioHome)) {
  throw new Error("Studio release does not use the single reviewed Observable near-midnight palette");
}
const authBytes = await readFile(resolve(appRoot, "dist/auth-config.json"));
if (authBytes.length !== manifest.authConfig.bytes
  || sha256(authBytes) !== manifest.authConfig.sha256) {
  throw new Error("Studio release authentication configuration is not sealed");
}
const authConfig = parseAuthConfig(JSON.parse(authBytes.toString("utf8")), {currentOrigin: origin});
if (authConfig.hostedUiBaseUrl !== "https://auth.categori.se"
  || authConfig.redirectUri !== manifest.authConfig.redirectUri
  || authConfig.logoutUri !== manifest.authConfig.logoutUri) {
  throw new Error("Studio release authentication configuration is misdirected");
}

console.log(JSON.stringify({
  status: "passed",
  studioOrigin: origin,
  files: manifest.artifactTree.files.length,
  htmlPages: manifest.routes.length,
  observableTheme: "near-midnight",
  authConfigSha256: manifest.authConfig.sha256,
  treeDigest: manifest.artifactTree.digest
}, null, 2));
