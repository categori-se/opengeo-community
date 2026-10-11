import {validateLayerStyleReference} from "./layerStyleReference.js";
import {compileStaticMapDocument} from "./staticMapExport.js";
import {canonicalJson as legacyCanonicalJson} from "./legacyCanonicalJson.js";
import {canonicalJson} from "./artifactCanonicalJson.js";

const encoder = new TextEncoder();
async function digest(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", (typeof text === "string" ? encoder.encode(text) : text)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Compile once, recording the exact packaged view rather than claiming a saved Project revision. */
export async function compilePortableMapArtifact(options) {
  const snapshot = structuredClone(options);
  const {html, payload} = compileStaticMapDocument(snapshot);
  const [outputHash, jsHash, cssHash, licenseHash] = await Promise.all([
    digest(html), digest(snapshot.runtimeJs), digest(snapshot.runtimeCss), digest(snapshot.runtimeLicense)
  ]);
  const runtime = {javascriptSha256: jsHash, cssSha256: cssHash, licenseTextSha256: licenseHash};
  const dependencies = await Promise.all(Object.entries(payload.style.sources).map(async ([id, source]) => ({
    id,
    mode: source.type === "geojson" ? "embedded" : "live",
    mediaType: source.type === "geojson" ? "application/geo+json" : null,
    checksumSha256: await digest(canonicalJson(source)),
    coverage: source.type === "geojson" ? "loaded-feature-snapshot" : "provider-managed",
    featureCount: source.type === "geojson" ? (source.data.type === "Feature" ? 1 : source.data.features.length) : null,
    accessUrls: source.type === "raster" ? [...source.tiles] : [],
    recordedRights: {license: null, attribution: source.attribution ?? null, redistributionAllowed: null}
  })));
  const styleDependencies = snapshot.candidates.filter(item => snapshot.selectedIds.includes(item.id) && item.styleReference)
    .map(item => ({layerId: item.id, reference: structuredClone(validateLayerStyleReference(item.styleReference)),
      representation: "displayed-maplibre-paints", recordedRights: {license: null, redistributionAllowed: null}}));
  const origin = snapshot.savedProjectOrigin;
  if (origin && (typeof origin.id !== "string" || !origin.id || origin.id.length > 128
    || !Number.isSafeInteger(origin.version) || origin.version < 1
    || !origin.definition || typeof origin.definition !== "object" || Array.isArray(origin.definition))) {
    throw Error("The originating saved Project reference is invalid.");
  }
  const manifest = {
    schemaVersion: "opengeo.project-artifact.1.0.0",
    artifactId: `sha256:${outputHash}`,
    representation: "portable-map-html",
    canonicalization: "opengeo-codepoint-decimal-v1",
    project: null,
    ...(origin ? {provenance: {originatingProject: {id: origin.id, version: origin.version,
      definitionChecksumSha256: await digest(canonicalJson(origin.definition))},
      relationship: "browser-snapshot-from-saved-project", authoritativeBuild: false}} : {}),
    build: {
      inputScope: "reviewed-browser-snapshot",
      inputChecksumSha256: await digest(canonicalJson({payload, runtime, ...(styleDependencies.length ? {styleDependencies} : {})})),
      view: payload.view,
      runtime,
      selectedSourceIds: Object.keys(payload.style.sources)
    },
    output: {objectId: null, mediaType: "text/html", sizeBytes: encoder.encode(html).byteLength, checksumSha256: outputHash},
    dependencies,
    ...(styleDependencies.length ? {styleDependencies} : {}),
    networkDependencies: dependencies.filter(source => source.mode === "live").map(source => ({id: source.id, accessUrls: source.accessUrls})),
    rights: {license: null, redistributionAllowed: null}
  };
  const result = {...manifest, manifestChecksumSha256: await digest(canonicalJson(manifest))};
  if (encoder.encode(JSON.stringify(result)).byteLength > 49_152) throw Error("The Artifact manifest exceeds 48 KiB.");
  return {html, manifest: result};
}

/** A sidecar is provenance, never authorization. Validate its byte binding before draft insertion. */
export async function verifyPortableMapArtifact(blob, manifest) {
  if (!manifest || manifest.schemaVersion !== "opengeo.project-artifact.1.0.0"
    || manifest.representation !== "portable-map-html" || manifest.output?.mediaType !== "text/html"
    || manifest.output?.sizeBytes !== blob.size
    || manifest.artifactId !== `sha256:${manifest.output?.checksumSha256}`) {
    throw Error("The portable Artifact identity does not match the HTML.");
  }
  const {manifestChecksumSha256, ...contents} = manifest;
  if (manifest.canonicalization !== undefined && manifest.canonicalization !== "opengeo-codepoint-decimal-v1") {
    throw Error("The Artifact canonicalization is unsupported.");
  }
  const serialize = manifest.canonicalization === undefined ? legacyCanonicalJson : canonicalJson;
  if (encoder.encode(JSON.stringify(manifest)).byteLength > 49_152
    || await digest(serialize(contents)) !== manifestChecksumSha256
    || await digest(await blob.arrayBuffer()) !== manifest.output.checksumSha256) {
    throw Error("The portable Artifact checksum does not match its HTML or manifest.");
  }
}

/** Read a downloaded sidecar with the same bound used by the Artifact contract. */
export async function readPortableMapManifest(blob) {
  if (!blob || blob.size === 0 || blob.size > 49_152) throw Error("Choose a non-empty Artifact manifest of at most 48 KiB.");
  try {return JSON.parse(await blob.text());}
  catch {throw Error("The Artifact manifest must contain valid JSON.");}
}
