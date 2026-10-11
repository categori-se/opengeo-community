import {readFile, readdir, mkdir, writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {CESIUM_FONT_ROOT,CESIUM_FONT_SHA256} from "../src/lib/cesiumLabels.js";
import {CESIUM_RUNTIME,CESIUM_FRAME_PATH} from "../src/lib/cesiumRuntime.js";

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
  const checksum = createHash("sha256").update(files.map(file=>`${file.name}\0${file.sha256}\n`).join("")).digest("hex");
  if (files.length !== CESIUM_RUNTIME.fileCount || checksum !== CESIUM_RUNTIME.treeSha256) throw Error("cesium_asset_tree_mismatch");
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
