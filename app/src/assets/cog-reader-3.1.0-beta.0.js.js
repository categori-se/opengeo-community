import {build, version as esbuildVersion} from "esbuild";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {resolve} from "node:path";

// Observable's existing asset generator avoids its CJS package resolution and
// missing split-chunk handling. Export only the reader used by public previews.
const packageRoot = fileURLToPath(new URL("../../node_modules/geotiff/", import.meta.url));
const metadata = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
if (metadata.version !== "3.1.0-beta.0" || esbuildVersion !== "0.28.2") throw Error("Unreviewed COG reader inputs");
const result = await build({stdin: {
  contents: `export {fromCustomClient} from ${JSON.stringify(resolve(packageRoot, "dist-module/geotiff.js"))};`,
  resolveDir: packageRoot
}, bundle: true, format: "esm", platform: "browser", write: false,
  minify: true, legalComments: "inline", logLevel: "silent"});
const license = await readFile(new URL("./licenses/geotiff-3.1.0-beta.0.LICENSE.txt", import.meta.url), "utf8");
process.stdout.write(`/*! GeoTIFF ${metadata.version}\n${license}*/\n`);
process.stdout.write(result.outputFiles[0].contents);
