import {readFile, mkdir, writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {MAPBOX_RUNTIME} from "../src/lib/mapboxRuntime.js";

export async function prepareMapboxRuntime(outputRoot) {
  const root = fileURLToPath(new URL("../node_modules/mapbox-gl/", import.meta.url));
  const metadata = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  if (metadata.version !== MAPBOX_RUNTIME.version) throw Error("Unreviewed Mapbox runtime version");
  const files = await Promise.all(MAPBOX_RUNTIME.assets.map(async asset => {
    const bytes = await readFile(resolve(root, asset.source));
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw Error("Mapbox runtime checksum mismatch");
    return {asset, bytes};
  }));
  const destination = resolve(outputRoot, `.${MAPBOX_RUNTIME.basePath}`);
  await mkdir(destination, {recursive:true});
  for (const {asset, bytes} of files) await writeFile(resolve(destination, asset.name), bytes);
}
