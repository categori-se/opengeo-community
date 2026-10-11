import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {loadArchivedGeojson} from '../src/lib/archivedGeojson.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
const base=root+'.local-archives/nepal-srilanka-catalog-20260921/';
const plan=JSON.parse(await readFile(base+'catalog-plan.json','utf8'));
const results=[];
for (const row of plan.records) {
  const {type,url,...source}=row.request.source;
  const configuration=Object.fromEntries(Object.entries(source).map(([key,value])=>[key.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),value]));
  const bytes=await readFile(root+row.object.localPath);
  try {
    const data=await loadArchivedGeojson({url,configuration,fetchImpl:async()=>new Response(bytes,{headers:{'content-type':row.object.contentType,'content-length':String(bytes.length)}})});
    if(data.features.length!==row.featureCount)throw Error('Feature count changed');
    results.push({key:row.object.key,status:'passed',features:data.features.length});
  } catch(error) {results.push({key:row.object.key,status:'failed',code:error.code,message:error.message});}
}
await writeFile(base+'archive-parser-check.json',JSON.stringify({status:results.every(x=>x.status==='passed')?'passed':'failed',records:results,awsRequests:0},null,2)+'\n');
console.log(JSON.stringify({records:results.length,failed:results.filter(x=>x.status!=='passed')}));
if(results.some(x=>x.status!=='passed'))process.exitCode=1;
