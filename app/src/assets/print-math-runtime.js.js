import {build, version} from "esbuild";
import {readFile} from "node:fs/promises";
import {resolve, dirname} from "node:path";
import {fileURLToPath} from "node:url";

export async function buildPrintMathRuntime(sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."), {appRoot = resolve(sourceRoot, "..")} = {}) {
  const lock = JSON.parse(await readFile(resolve(appRoot,"package-lock.json"),"utf8"));
  if (version !== "0.28.2" || lock.packages["node_modules/@mathjax/src"]?.version !== "4.1.3"
    || lock.packages["node_modules/@mathjax/mathjax-tex-font"]?.version !== "4.1.0") throw Error("Unreviewed Print equation build inputs.");
  const result = await build({absWorkingDir:appRoot,entryPoints:[resolve(sourceRoot,"lib/printMathRuntime.js")],bundle:true,platform:"browser",format:"esm",write:false,
    logLevel:"silent",minify:true,legalComments:"inline"});
  return result.outputFiles[0].contents;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) process.stdout.write(await buildPrintMathRuntime());
