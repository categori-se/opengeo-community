import {readFile, readdir, mkdir, writeFile, realpath} from "node:fs/promises";
import {createHash} from "node:crypto";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {build, version as compilerVersion} from "esbuild";
import {CESIUM_FONT_ROOT,CESIUM_FONT_SHA256} from "../src/lib/cesiumLabels.js";
import {CESIUM_RUNTIME,CESIUM_UPSTREAM_RUNTIME,CESIUM_DERIVATION,CESIUM_FRAME_PATH} from "../src/lib/cesiumRuntime.js";

const appRoot=fileURLToPath(new URL("..",import.meta.url));
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const treeHash=files=>hash(files.map(file=>`${file.name}\0${file.sha256}\n`).join(""));

export async function deriveCesiumIndex() {
  const entry=await realpath(resolve(appRoot,CESIUM_DERIVATION.source));
  const ion=await realpath(resolve(appRoot,"node_modules/@cesium/engine/Source/Core/Ion.js"));
  const sanitizer=await realpath(resolve(appRoot,"node_modules/dompurify/dist/purify.es.mjs"));
  const [source,ionSource,sanitizerSource,metadata]=await Promise.all([
    readFile(entry),readFile(ion,"utf8"),readFile(sanitizer),
    readFile(resolve(appRoot,"node_modules/dompurify/package.json"),"utf8").then(JSON.parse)
  ]);
  const token=/const defaultAccessToken\s*=\s*"([^"]+)";/.exec(ionSource);
  if(hash(source)!==CESIUM_DERIVATION.sourceSha256 || hash(ionSource)!==CESIUM_DERIVATION.ionSourceSha256
    || !token || hash(token[1])!==CESIUM_DERIVATION.removedEvaluationTokenSha256
    || hash(sanitizerSource)!==CESIUM_DERIVATION.sanitizerSha256
    || metadata.version!==CESIUM_DERIVATION.sanitizerVersion
    || /\bDOMPurify\.version\s*=\s*['"]([^'"]+)['"]/.exec(sanitizerSource.toString())?.[1]!==CESIUM_DERIVATION.sanitizerVersion
    || compilerVersion!==CESIUM_DERIVATION.compilerVersion) throw Error("cesium_derivation_input_mismatch");
  const provenance={...CESIUM_DERIVATION,upstreamIndex:CESIUM_UPSTREAM_RUNTIME.assets[0],
    upstreamTreeSha256:CESIUM_UPSTREAM_RUNTIME.treeSha256,
    changes:["Resolve DOMPurify to the official patched package", "Remove the upstream ion evaluation token"],
    options:{format:"esm",platform:"browser",target:"es2022",minify:true,legalComments:"inline",
      define:{CESIUM_VERSION:JSON.stringify(CESIUM_RUNTIME.version)}}};
  let removed=0;
  const result=await build({absWorkingDir:appRoot,entryPoints:[entry],outfile:"index.js",bundle:true,write:false,
    ...provenance.options,metafile:true,logLevel:"silent",
    banner:{js:`/*! OpenGeo derived Cesium index: ${JSON.stringify(provenance)} */`},
    plugins:[{name:"reviewed-cesium-security",setup(builder){
      builder.onResolve({filter:/^dompurify$/},()=>({path:sanitizer}));
      builder.onLoad({filter:/[\\/]Core[\\/]Ion\.js$/},async args=>{
        if(await realpath(args.path)!==ion)throw Error("cesium_ion_source_mismatch");
        removed++;return {contents:ionSource.replace(token[0],'const defaultAccessToken = "";'),loader:"js"};
      });
    }}]});
  const inputs=await Promise.all(Object.keys(result.metafile.inputs).map(path=>realpath(resolve(appRoot,path))));
  const bytes=result.outputFiles[0].contents,text=Buffer.from(bytes).toString();
  const sanitizerInputs=inputs.filter(path=>/[\\/]dompurify[\\/]/.test(path));
  if(removed!==1 || !inputs.includes(ion) || sanitizerInputs.length!==1 || sanitizerInputs[0]!==sanitizer
    || /DOMPurify[^\n]*3\.4\.14/.test(text) || /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(text)) {
    throw Error("cesium_derivation_graph_mismatch");
  }
  const exports=Object.values(result.metafile.outputs)[0].exports;
  const expected=["VERSION",...source.toString().matchAll(/export \{ ([A-Za-z0-9_$]+) \} from/g)].map(value=>typeof value==="string"?value:value[1]).sort();
  if(JSON.stringify([...exports].sort())!==JSON.stringify(expected))throw Error("cesium_derivation_exports_mismatch");
  return {bytes,sha256:hash(bytes),integrity:`sha384-${createHash("sha384").update(bytes).digest("base64")}`,
    exports,provenance,inputCount:inputs.length};
}

export async function prepareCesiumRuntime(outputRoot) {
  const root = fileURLToPath(new URL("../node_modules/cesium/", import.meta.url));
  if (JSON.parse(await readFile(resolve(root,"package.json"),"utf8")).version !== CESIUM_RUNTIME.version) throw Error("cesium_version_mismatch");
  const paths = ["index.js"];
  async function walk(path) {
    for (const entry of await readdir(resolve(root,"Build/Cesium",path),{withFileTypes:true})) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) paths.push(child);
      else throw Error("cesium_asset_type_unsupported");
    }
  }
  for (const folder of ["Assets","ThirdParty","Widgets","Workers"]) await walk(folder);
  const files = await Promise.all([...paths.map(name=>({name,source:`Build/Cesium/${name}`})),
    ...["LICENSE.md","ThirdParty.extra.json"].map(name=>({name,source:name}))].map(async file=>{
    const bytes = await readFile(resolve(root,file.source));
    return {...file,bytes,sha256:createHash("sha256").update(bytes).digest("hex")};
  }));
  files.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  if (files.length !== CESIUM_UPSTREAM_RUNTIME.fileCount || treeHash(files) !== CESIUM_UPSTREAM_RUNTIME.treeSha256) throw Error("cesium_asset_tree_mismatch");
  const derived=await deriveCesiumIndex(), index=files.find(file=>file.name==="index.js");
  if(derived.sha256!==CESIUM_RUNTIME.assets[0].sha256 || derived.integrity!==CESIUM_RUNTIME.assets[0].integrity)throw Error("cesium_derived_index_mismatch");
  index.bytes=derived.bytes;index.sha256=derived.sha256;
  const checksum=treeHash(files);
  if(checksum!==CESIUM_RUNTIME.treeSha256)throw Error("cesium_derived_tree_mismatch");
  for (const file of files) {
    const target = resolve(outputRoot,`.${CESIUM_RUNTIME.basePath}`,file.name);
    await mkdir(resolve(target,".."),{recursive:true}); await writeFile(target,file.bytes);
  }
  await writeFile(resolve(outputRoot,`.${CESIUM_FRAME_PATH}`),
    '<!doctype html><html><head><meta charset="utf-8"><title>Cesium map</title><style>html,body{height:100%;width:100%;margin:0;overflow:hidden}</style></head><body></body></html>');
  const fontRoot=fileURLToPath(new URL('../src/assets/render-fonts/opengeo-open-sans-v1/1/',import.meta.url));
  for(const name of ['OpenSans-Regular.ttf','manifest.json','LICENSE.txt','NOTICE.txt']) {
    const bytes=await readFile(resolve(fontRoot,name));
    if(name==='OpenSans-Regular.ttf' && createHash('sha256').update(bytes).digest('hex')!==CESIUM_FONT_SHA256)throw Error('cesium_font_mismatch');
    const target=resolve(outputRoot,`.${CESIUM_FONT_ROOT}`,name);
    await mkdir(resolve(target,'..'),{recursive:true});await writeFile(target,bytes);
  }
  return {hostPage:CESIUM_FRAME_PATH,files:files.length,bytes:files.reduce((sum,file)=>sum+file.bytes.length,0),treeSha256:checksum};
}
