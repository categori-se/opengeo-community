import {mkdirSync,lstatSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

// Framework does not copy ordinary iframe targets. Retained pins are explicit assets.
export function retainArtifactOutputs({files,inputRoot,outputRoot,prefix='',readExact}) {
  const stat = path => {try{return lstatSync(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
  const directory = path => {const info=stat(path);if(info && (!info.isDirectory()||info.isSymbolicLink()))throw Error('artifact_output_path_collision');if(!info)mkdirSync(path);};
  directory(outputRoot);
  for(const file of files) {
    if(!file.path.startsWith(prefix))throw Error('artifact_outside_source_root');
    const path=file.path.slice(prefix.length), segments=path.split('/');
    if(!path.endsWith('.html')||segments.some(segment=>!segment||segment==='.'||segment==='..'||segment.includes('\\')))throw Error('artifact_output_path_invalid');
    let parent=outputRoot;
    for(const segment of segments.slice(0,-1)){parent=join(parent,segment);directory(parent);}
    const target=join(parent,segments.at(-1)), prior=stat(target);
    const bytes=readExact(join(inputRoot,file.path),file);
    if(prior) {
      if(!prior.isFile()||prior.isSymbolicLink()||prior.size!==file.sizeBytes||createHash('sha256').update(readFileSync(target)).digest('hex')!==file.checksumSha256)throw Error('artifact_output_path_collision');
    }else writeFileSync(target,bytes,{flag:'wx',mode:0o600});
  }
}
