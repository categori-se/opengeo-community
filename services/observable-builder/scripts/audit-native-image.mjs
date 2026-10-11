// Read-only, local evidence collection. This does not suppress scanner findings,
// approve a release, modify an image, or run submitted publication code.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, dirname} from 'node:path';

const image=process.argv[2];
assert.match(image??'',/^sha256:[a-f0-9]{64}$/,'Use an exact local compiler image ID');
const output=await mkdtemp('/tmp/opengeo-compiler-native-review-');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function run(command,args,{maxBuffer=16*1024*1024}={}) {
  const result=spawnSync(command,args,{encoding:'utf8',timeout:60000,maxBuffer});
  if(result.error||result.status!==0) throw Error(`${command}: ${result.error?.message??result.stderr??result.status}`);
  return result.stdout;
}
const inspection=JSON.parse(run('podman',['image','inspect',image]));
assert.equal(inspection.length,1);
assert.equal(inspection[0].Id.replace(/^sha256:/,''),image.slice(7));
assert.equal(inspection[0].Config.User,'10001:10001');
await writeFile(join(output,'image.json'),JSON.stringify(inspection,null,2));

// Inspect every readable image file rather than assuming all native code lives
// in /usr/lib. Pseudo-filesystems are the only excluded top-level trees. Symlink
// aliases resolve to one canonical file; errors make the evidence incomplete.
const inventoryCode=String.raw`
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const visited=new Set(),native=[],archives=[],links=[],brokenLinks=[],errors=[],libraryNames=[];
let regularFiles=0;
function visit(name){
  if(['/proc','/sys','/dev'].some(root=>name===root||name.startsWith(root+'/')))return;
  let stat;
  try {
    stat=fs.lstatSync(name);
    if(stat.isSymbolicLink()){
      let target;
      try{target=fs.realpathSync(name);}catch(error){
        if(error.code!=='ENOENT')throw error;
        brokenLinks.push({path:name,target:fs.readlinkSync(name)});return;
      }
      links.push({path:name,target});visit(target);return;
    }
    if(visited.has(name))return;visited.add(name);
    if(stat.isDirectory()){for(const entry of fs.readdirSync(name))visit(path.join(name,entry));return;}
    if(!stat.isFile())throw Error('Unexpected special file');
    regularFiles++;
    if(/lib(?:resolv|z)\.so/.test(path.basename(name)))libraryNames.push(name);
    const fd=fs.openSync(name,'r'),header=Buffer.alloc(8);
    try{fs.readSync(fd,header,0,8,0);}finally{fs.closeSync(fd);}
    if(header.subarray(0,4).equals(Buffer.from([127,69,76,70]))||header.toString()==='!<arch>\n'){
      const record={path:name,bytes:stat.size,sha256:crypto.createHash('sha256').update(fs.readFileSync(name)).digest('hex')};
      (header[0]===127?native:archives).push(record);
    }
  }catch(error){errors.push({path:name,code:error.code??error.message});}
}
visit('/');
console.log(JSON.stringify({regularFiles,native,archives,links,brokenLinks,errors,libraryNames,
  libcPackage:fs.readFileSync('/var/lib/dpkg/status.d/libc6','utf8'),
  node:{version:process.version,architecture:process.arch,sharedObjects:process.report.getReport().sharedObjects,
    nodeSharedZlib:process.config.variables.node_shared_zlib}}));
`;
const inventory=JSON.parse(run('podman',['run','--rm','--pull=never','--network=none','--read-only',
  '--cap-drop=all','--cap-add=DAC_READ_SEARCH','--security-opt=no-new-privileges','--pids-limit=64','--memory=1024m','--cpus=1',
  '--user=0:0','--entrypoint=/nodejs/bin/node',image,'-e',inventoryCode]));
await writeFile(join(output,'inventory.json'),JSON.stringify(inventory,null,2));
assert.deepEqual(inventory.errors,[],'Every image file must be inspected');
assert.deepEqual(inventory.libraryNames,[],'Removed native libraries must not reappear');
assert(inventory.native.length>0);
assert.match(inventory.libcPackage,/Package: libc6/);

// This stopped container is solely a source for exact binary copies. It is
// never started; remove only its freshly returned, validated ID in finally.
const container=run('podman',['create','--pull=never','--network=none',image]).trim();
assert.match(container,/^[a-f0-9]{64}$/);
const symbols=/\b(?:__)?(?:ns_sprintrrf|ns_sprintrr|ns_printrrf|ns_printrr|fp_nquery)\b/;
const reviewed=[];
try {
  // Copy the shared system-library directory once, avoiding hundreds of
  // individual Podman invocations. Every reviewed ELF is still hashed exactly.
  const systemDirectories=[...new Set(inventory.native.filter(file=>file.path.startsWith('/usr/lib/'))
    .map(file=>file.path.split('/').slice(0,4).join('/')))];
  for(const directory of systemDirectories) {
    const target=join(output,'files',directory.slice(1));
    await mkdir(dirname(target),{recursive:true});
    run('podman',['cp',`${container}:${directory}`,target]);
  }
  for(const record of [...inventory.native,...inventory.archives]) {
    assert(record.path.startsWith('/')&&!record.path.split('/').includes('..'));
    const target=join(output,'files',record.path.slice(1));
    await mkdir(dirname(target),{recursive:true});
    if(!systemDirectories.some(directory=>record.path.startsWith(directory+'/'))) {
      run('podman',['cp',`${container}:${record.path}`,target]);
    }
    assert.equal(hash(await readFile(target)),record.sha256);
    const details=run('readelf',['--wide','--symbols','--dynamic',target],{maxBuffer:64*1024*1024});
    const evidence=target+'.readelf.txt';
    await writeFile(evidence,details);
    const needed=[...details.matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)].map(match=>match[1]);
    const matchingLines=details.split('\n').filter(line=>symbols.test(line));
    reviewed.push({...record,needed,matchingLines,readelfSha256:hash(details)});
  }
} finally {run('podman',['rm',container]);}
const receipt={schema:'opengeo.compiler-native-review.1',checkedAt:new Date().toISOString(),
  imageId:image,architecture:inspection[0].Architecture,regularFiles:inventory.regularFiles,
  nativeFiles:reviewed,archives:inventory.archives.length,
  inventoryUser:'container-root-read-only',compilerUser:inspection[0].Config.User,
  brokenLinks:inventory.brokenLinks,
  resolverLibraryAbsent:inventory.libraryNames.length===0,
  resolverSymbolsAbsent:reviewed.every(item=>item.matchingLines.length===0),
  resolverDynamicDependencyAbsent:reviewed.every(item=>!item.needed.some(name=>/libresolv/.test(name))),
  retainedLibcPackage:true,inventorySha256:hash(await readFile(join(output,'inventory.json'))),
  releaseApproved:false,scannerFindingsSuppressed:false,awsRequests:0};
const availableNames=new Set([...inventory.native,...inventory.links].map(file=>file.path.split('/').pop()));
receipt.missingSystemDependencies=reviewed.filter(file=>file.path.startsWith('/usr/')||file.path.startsWith('/nodejs/'))
  .map(file=>({path:file.path,missing:file.needed.filter(name=>!availableNames.has(name))})).filter(file=>file.missing.length);
await writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2));
console.log(JSON.stringify({...receipt,nativeFiles:reviewed.length,artifactDirectory:output}));
assert(receipt.resolverSymbolsAbsent&&receipt.resolverDynamicDependencyAbsent);
assert.deepEqual(receipt.missingSystemDependencies,[]);
