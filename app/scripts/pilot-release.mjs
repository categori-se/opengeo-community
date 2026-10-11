import {parseAuthConfig} from "../src/lib/authConfig.js";
import {
  digestFileRecords, safeJoin, SHA256_PATTERN, sha256, verifyManifestSeal
} from "./release-utils.mjs";
import {studioReleaseIdentityFromManifest} from "./studio-readiness.mjs";
import {reviewedPilotOrigin} from "./v01-pilot-acceptance.mjs";

const DEMO_SCHEMA = "opengeo.managed-demo-release.1.0.0";
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_AUTH_BYTES = 16_384;

/** Identify a sealed edition, not permission to deploy it or run acceptance. */
export function pilotReleaseIdentityFromManifest(manifest, {origin, allowProduction = false}) {
  const reviewed = reviewedPilotOrigin(origin, {allowProduction});
  verifyManifestSeal(manifest, "Pilot release manifest");
  const demo = reviewed.environment === "demo";
  if (demo && (manifest.schemaVersion !== DEMO_SCHEMA
    || manifest.demoOrigin !== origin || Object.hasOwn(manifest, "studioOrigin")
    || manifest.authConfig?.deploymentId !== "opengeo-demo"
    || !/^[a-z0-9]{1,128}$/.test(manifest.authConfig?.clientId ?? ""))) {
    throw new Error("Pilot release is not the managed demo edition for this origin");
  }
  const studio = demo ? null : studioReleaseIdentityFromManifest(manifest, {
    expectedStudioOrigin: origin
  });
  const tree = manifest.artifactTree;
  if (tree?.algorithm !== "sha256" || !Array.isArray(tree.files)
    || tree.files.length < 2 || tree.files.length > 900) {
    throw new Error("Pilot artifact tree is invalid");
  }
  const files = new Map();
  for (const file of tree.files) {
    safeJoin("/tmp/opengeo-pilot-release-contract", file?.path);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0
      || !SHA256_PATTERN.test(file.sha256 ?? "") || files.has(file.path)) {
      throw new Error("Pilot artifact record is invalid or duplicated");
    }
    files.set(file.path, file);
  }
  if (JSON.stringify([...files.keys()]) !== JSON.stringify([...files.keys()].sort())
    || digestFileRecords(tree.files) !== tree.digest) {
    throw new Error("Pilot artifact tree digest is inconsistent");
  }
  const index = files.get("index.html"), auth = files.get("auth-config.json");
  if (!index || index.bytes < 1 || index.bytes > MAX_INDEX_BYTES
    || !auth || auth.bytes < 1 || auth.bytes > MAX_AUTH_BYTES
    || manifest.authConfig?.path !== auth.path
    || manifest.authConfig?.bytes !== auth.bytes
    || manifest.authConfig?.sha256 !== auth.sha256
    || manifest.authConfig?.cacheControl !== "no-store") {
    throw new Error("Pilot index or authentication artifact is missing or inconsistent");
  }
  return studio ?? {
    releaseManifestSha256: manifest.manifestSha256,
    artifactTreeDigest: tree.digest,
    indexSha256: index.sha256,
    authConfigSha256: auth.sha256
  };
}

/** Read-only pre-login check; never opens a browser or sends credentials. */
export async function verifyLivePilotRelease({
  manifest, origin, allowProduction = false, fetchImplementation = globalThis.fetch
}) {
  const identity = pilotReleaseIdentityFromManifest(manifest, {origin, allowProduction});
  const files = new Map(manifest.artifactTree.files.map((file) => [file.path, file]));
  const [, authBytes] = await Promise.all(["index.html", "auth-config.json"].map(async (path) => {
    const artifact = files.get(path);
    const url = `${origin}/${path}`;
    const response = await fetchImplementation(url, {
      cache: "no-store", redirect: "error", credentials: "omit",
      referrerPolicy: "no-referrer", signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok || response.redirected || (response.url && response.url !== url)) {
      throw new Error(`Pilot ${path} response is not a successful same-origin read`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error(`Pilot ${path} response has no body`);
    let length = 0;
    const chunks = [];
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > artifact.bytes) throw new Error(`Pilot ${path} exceeds its sealed size`);
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks);
    if (length !== artifact.bytes || sha256(bytes) !== artifact.sha256) {
      throw new Error(`Live pilot ${path} does not match the sealed release`);
    }
    return bytes;
  }));
  const config = parseAuthConfig(JSON.parse(authBytes.toString("utf8")), {currentOrigin: origin});
  if (manifest.schemaVersion === DEMO_SCHEMA
    && (config.version !== 2 || config.deployment.id !== manifest.authConfig.deploymentId
      || config.clientId !== manifest.authConfig.clientId || config.deployment.mode !== "demo"
      || !config.deployment.publicSandbox.enabled || config.deployment.publicSandbox.serverWrites)) {
    throw new Error("Live pilot authentication does not match the managed demo boundary");
  }
  for (const key of ["redirectUri", "logoutUri"]) {
    if (manifest.authConfig[key] !== undefined && manifest.authConfig[key] !== config[key]) {
      throw new Error("Live pilot authentication does not match its sealed login configuration");
    }
  }
  return identity;
}
