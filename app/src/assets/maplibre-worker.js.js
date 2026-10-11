import {build, version as esbuildVersion} from "esbuild";
import {createRequire} from "node:module";
import {readFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

export async function buildMapWorker(packageRoot = dirname(createRequire(import.meta.url).resolve("maplibre-gl/package.json"))) {
  const {version} = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  // v5 already embeds its worker; this asset is never requested by that engine.
  if (version === "5.24.0") return Buffer.from("// MapLibre 5.24 uses its embedded worker.\n");
  if (version !== "6.4.1" || esbuildVersion !== "0.28.2") throw Error("Unreviewed map worker build inputs");
  const result = await build({entryPoints: [resolve(packageRoot, "dist/maplibre-gl-worker.mjs")],
    bundle: true, format: "esm", platform: "browser", write: false, logLevel: "silent"});
  return result.outputFiles[0].contents;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.stdout.write(await buildMapWorker());
