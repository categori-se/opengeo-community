import {zipSync, strToU8} from "fflate";
import {canonicalJson} from "./artifactCanonicalJson.js";
import {verifyPortableMapArtifact} from "./portableMapArtifact.js";

const MAX_BYTES = 32 * 1024 * 1024;
const encode = value => strToU8(value);
const json = value => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
const text = value => typeof value === "string" ? value.replace(/<[^>]*>/g, "") : null;

/** A reviewed browser snapshot, with the same native viewer as public releases. */
export async function compileDeveloperMapBundle({compiled, candidates, selectedIds, runtimeJs, runtimeCss, runtimeLicense, nativeRuntime}) {
  const {html, manifest: artifactManifest, payload} = compiled;
  await verifyPortableMapArtifact(new Blob([html]), artifactManifest);
  if (!nativeRuntime?.startsWith("\nconst clone =") || !nativeRuntime.endsWith("export {\n  createView\n};\n")) throw Error("The native map viewer is unavailable in this Studio release.");
  if (!payload || selectedIds.length > 64) throw Error("Choose at most 64 loaded Layers for a developer bundle.");
  const selected = candidates.filter(item => selectedIds.includes(item.id));
  const runtime = {javascriptSha256: await digest(encode(runtimeJs)), cssSha256: await digest(encode(runtimeCss)), licenseTextSha256: await digest(encode(runtimeLicense))};
  const styleDependencies = artifactManifest.styleDependencies;
  const inputs = {payload, runtime, ...(styleDependencies?.length ? {styleDependencies} : {})};
  if (await digest(encode(canonicalJson(inputs))) !== artifactManifest.build.inputChecksumSha256) throw Error("The developer bundle differs from the reviewed map snapshot.");
  const sources = selected.map(item => ({layerId: item.id, title: item.title, sourceId: item.sourceId,
    ...structuredClone(item.recordedMetadata ?? {}),
    attribution: text(item.recordedMetadata?.curatedAttribution ?? item.recordedMetadata?.sourceAttribution ?? item.attribution),
    license: text(item.recordedMetadata?.license),
    coverage: item.source.type === "geojson" ? "loaded-feature-snapshot" : "provider-managed"}));
  if (encode(JSON.stringify(sources)).byteLength > 49152) throw Error("Selected source metadata exceeds 48 KiB. Export fewer Layers.");
  const metadata = {schemaVersion: "opengeo.native-map.1.0.0", title: payload.title,
    artifactId: artifactManifest.artifactId, attribution: [...new Set(sources.map(item => item.attribution).filter(Boolean))].join(" · "),
    license: [...new Set(sources.map(item => item.license).filter(Boolean))].join(" · ") || "Rights not recorded",
    sources, rights: artifactManifest.rights, sourceManifest: "./artifact.json"};
  const module = "// OpenGeo native portable map v1; host supplies MapLibre and its CSS.\n"
    + `export const artifact=Object.freeze(${json(metadata)});\nconst publication=${json(payload)};\n` + nativeRuntime;
  const included = artifactManifest.dependencies.filter(item => item.mode === "embedded").map(item => ({...item, status: "included", path: "map.mjs"}));
  const live = artifactManifest.dependencies.filter(item => item.mode === "live").map(item => ({...item, status: "live"}));
  const excluded = [{kind: "basemap", status: "excluded", reason: "The Project background is not packaged."},
    {kind: "terrain", status: "excluded", reason: "Terrain is not part of this portable representation."},
    ...candidates.filter(item => !selectedIds.includes(item.id)).map(item => ({layerId: item.id, title: item.title, status: "excluded", reason: item.reason || "Not selected."}))];
  const files = {
    "map.mjs": encode(module),
    "artifact.json": encode(JSON.stringify(artifactManifest, null, 2)),
    "source-metadata.json": encode(JSON.stringify({scope: "selected-browser-snapshot", sources}, null, 2)),
    "interactive.html": encode(html),
    "runtime/maplibre.mjs": encode(runtimeJs + "\nexport const maplibre = globalThis.maplibregl;\n"),
    "runtime/maplibre-gl.css": encode(runtimeCss),
    "runtime/LICENSE.txt": encode(runtimeLicense),
    "preview.html": encode(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Map preview</title><link rel="stylesheet" href="./runtime/maplibre-gl.css"><style>body{margin:1rem;font:16px system-ui,sans-serif;color:#182231;background:#fff}h1{font-size:1.3rem}.opengeo-native-map-controls label{display:inline-block;margin:.5rem 1rem .5rem 0}button{font:inherit}@media(prefers-color-scheme:dark){body{color:#eee;background:#202020}}</style></head><body><h1></h1><main></main><p role="status">Opening map…</p><script type="module" src="./preview.mjs"></script></body></html>`),
    "preview.mjs": encode(`import {createView, artifact} from "./map.mjs";
import {maplibre} from "./runtime/maplibre.mjs";
document.querySelector("h1").textContent = artifact.title;
const view = createView({maplibre, height: "65vh"});
view.addEventListener("mapready", () => {document.querySelector('[role="status"]').textContent = "Map ready";});
view.addEventListener("maperror", ({detail}) => {document.querySelector('[role="status"]').textContent = detail.message;});
document.querySelector("main").append(view);
globalThis.addEventListener("pagehide", () => view.dispose(), {once:true});
`),
    "observable.md": encode(observableExample),
    "README.md": encode(`# Native map developer bundle

Unzip this directory. For the native preview, serve it with a static web server
(for example, python3 -m http.server 8000) and open /preview.html. JavaScript
modules require HTTP(S); a file: URL is not a module server. interactive.html
is the separate single-file viewer and can open directly.

Import createView and artifact from map.mjs. Supply your host's MapLibre and its
CSS, or import maplibre from runtime/maplibre.mjs and load runtime/maplibre-gl.css.
The native view mounts directly in your page and inherits its font and color.
It does not create an iframe. observable.md shows integration and cleanup.
When hosting on another domain, serve modules with a JavaScript content type
and anonymous CORS. No account session or private authorization is included.

Methods: getCamera, setCamera, resize, getLayers, setLayerVisibility, setFilter,
getSelection, setSelection, dispose. Use the paint-layer IDs from getLayers.
Events: mapready, camerachange, layerchange, filterchange, selectionchange,
maperror, dispose. Selection events contain detail.features (at most100).
AbortSignal, Observable invalidation and dispose release the map and listeners.

manifest.json records file checksums and included, live and excluded dependencies.
artifact.json binds the exact portable HTML and reviewed input snapshot.
source-metadata.json and the exported artifact.sources retain selected source
metadata; absent rights remain unknown. Viewer licensing is in runtime/LICENSE.txt
and does not grant rights to the included data or styling. Keep attribution.

This is a snapshot of selected currently loaded data, not an editable Project or
complete upstream archive. Display filters do not remove hidden features from
the data. Basemaps, terrain and unselected/unsupported Layers are excluded.
The offline claim applies only to the selected packaged representation. Live
dependencies require their providers and internet access. Device Projects are
not public URLs: upload these files to your chosen host to share them.
`)
  };
  const bytes = Object.values(files).reduce((sum, item) => sum + item.byteLength, 0);
  if (bytes > MAX_BYTES - 64 * 1024) throw Error("This developer bundle exceeds 32 MiB. Select fewer loaded features or Layers.");
  const manifest = {schemaVersion: "opengeo.developer-map-bundle.1.0.0", title: payload.title,
    scope: "selected-browser-snapshot", artifactId: artifactManifest.artifactId,
    fullyOffline: live.length === 0, dependencies: {included, live, excluded},
    viewer: {path: "map.mjs", mode: "native", entryPoint: "createView", hostSuppliesMapLibre: true,
      bundledRuntime: "runtime/maplibre.mjs", css: "runtime/maplibre-gl.css", license: "runtime/LICENSE.txt", nativeRuntimeSha256: await digest(encode(nativeRuntime))},
    preview: "preview.html", interactiveHtml: "interactive.html", sourceMetadata: "source-metadata.json",
    files: await Promise.all(Object.entries(files).map(async ([path, data]) => ({path, bytes: data.byteLength, checksumSha256: await digest(data)})))};
  files["manifest.json"] = encode(JSON.stringify(manifest, null, 2));
  if (files["manifest.json"].byteLength > 65536 || bytes + files["manifest.json"].byteLength > MAX_BYTES) throw Error("The developer bundle manifest exceeds its 64 KiB limit. Select fewer Layers.");
  const date = new Date("2020-01-01T00:00:00Z");
  const archive = zipSync(Object.fromEntries(Object.entries(files).map(([path, data]) => [path, [data, {mtime: date}]])), {level: 6});
  return {blob: new Blob([archive], {type: "application/zip"}), manifest};
}

const observableExample = `# Use the native map in Observable Framework

Host this unzipped bundle at an HTTPS URL with anonymous CORS on JavaScript modules.
Use your deployment URL below. Keep the module URL fixed to the chosen edition.

\`\`\`js
const bundle = "https://YOUR-HOST.example/maps/your-edition/";
const css = document.createElement("link");
css.rel = "stylesheet";
css.href = new URL("runtime/maplibre-gl.css", bundle).href;
document.head.append(css);
const [{createView, artifact}, {maplibre}] = await Promise.all([
  import(new URL("map.mjs", bundle).href),
  import(new URL("runtime/maplibre.mjs", bundle).href)
]);
const view = createView({maplibre, height: 600, invalidation});
view.addEventListener("selectionchange", ({detail}) => {
  console.log(detail.features); // Connect to your article's table or selection.
});
display(view);
invalidation.then(() => css.remove());
// view.setFilter(view.getLayers().find(layer => layer.type !== "background").id,
//   ["==", ["get", "status"], "reviewed"]);
// Source metadata: artifact.sources. Call view.dispose() outside Observable.
\`\`\`

If your page already supplies a compatible MapLibre and its CSS, reuse those
instead of importing the bundled runtime. Only map.mjs needs to transfer then;
its selected GeoJSON remains embedded and its live dependencies remain live.
`;
