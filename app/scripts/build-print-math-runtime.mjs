import {createHash} from "node:crypto";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {version} from "esbuild";
import {buildPrintMathRuntime} from "../src/assets/print-math-runtime.js.js";

// Use the existing Framework asset cache. Its package-import resolver cannot
// resolve MathJax's #default-font alias; esbuild already handles that exact graph.
export async function preparePrintMathRuntimeAsset(sourceRoot, {appRoot = resolve(sourceRoot, "..")} = {}) {
  const hash=createHash("sha256").update(version);
  for(const name of ["lib/printMathRuntime.js","assets/print-math-runtime.js.js"])hash.update(await readFile(resolve(sourceRoot,name)));
  hash.update(await readFile(resolve(appRoot,"package-lock.json")));
  const fingerprint=hash.digest("hex"),cache=resolve(sourceRoot,".observablehq/cache/assets"),marker=resolve(cache,"print-math-runtime.inputs"),path=resolve(cache,"print-math-runtime.js");
  const [previousInput,previousOutput]=(await readFile(marker,"utf8").catch(()=>"")).split(":");
  const previous=await readFile(path).catch(()=>null);
  if(previousInput===fingerprint&&previous&&createHash("sha256").update(previous).digest("hex")===previousOutput)return false;
  const bytes=await buildPrintMathRuntime(sourceRoot,{appRoot});await mkdir(cache,{recursive:true});await writeFile(path,bytes);await writeFile(marker,fingerprint+":"+createHash("sha256").update(bytes).digest("hex"));return true;
}
