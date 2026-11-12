// Keep this guard checkout-local so standalone builds need no workspace tools.
import {existsSync, statfsSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

export function assertBuildSpace({target, outputBytes=2*1024**3, reserveBytes=5*1024**3, statfs=statfsSync}) {
  for (const value of [outputBytes,reserveBytes]) {
    if (!Number.isSafeInteger(value) || value<0) throw Error('Invalid build space estimate');
  }
  let parent=resolve(target);
  while (!existsSync(parent)) {
    if (dirname(parent)===parent) throw Error('Build filesystem is unavailable');
    parent=dirname(parent);
  }
  const usage=statfs(parent), available=Number(usage.bavail)*Number(usage.bsize);
  if (available<outputBytes+reserveBytes) throw Error(`Build refused before allocation: ${parent} has ${available} free bytes; needs ${outputBytes} estimated writes plus ${reserveBytes} reserve. Reuse existing environments or recover proven abandoned agent staging/caches. Preserve active outputs, models, databases and images.`);
  return {availableBytes:available,outputBytes,reserveBytes};
}
