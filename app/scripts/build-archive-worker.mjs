import {build} from "esbuild";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

export async function buildArchiveWorker(outputRoot) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  await build({absWorkingDir: root, entryPoints: ["src/workers/archiveHashWorker.js"],
    outfile: resolve(outputRoot, "archive-runtime/hash-worker.js"), bundle: true,
    format: "esm", platform: "browser", target: "es2022", minify: true,
    legalComments: "eof"});
}
