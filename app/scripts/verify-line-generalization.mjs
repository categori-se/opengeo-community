import assert from 'node:assert/strict';

// Independent of the simplifier: match retained vertices in source order and
// check every original vertex against its corresponding output chord.
export function verifyLineGeneralization(original, reduced, tolerance) {
 assert.ok(Number.isFinite(tolerance)&&tolerance>=0);
 assert.equal(reduced.length,original.length,'Part membership changed');
 let vertices=0,maximumDeviation=0;
 const same=(a,b)=>a.x===b.x&&a.y===b.y;
 for(let partIndex=0;partIndex<original.length;partIndex++){
  const source=original[partIndex],target=reduced[partIndex];
  assert.ok(source.length>=2&&target.length>=2);
  assert.ok(same(source[0],target[0])&&same(source.at(-1),target.at(-1)),'Endpoints changed');
  let start=0;
  for(let j=1;j<target.length;j++){
   let end=start+1;
   if(j===target.length-1)end=source.length-1;
   else while(end<source.length&&!same(source[end],target[j]))end++;
   assert.ok(end<source.length&&same(source[end],target[j]),'Output vertex is not an ordered source vertex');
   const a=target[j-1],b=target[j],dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
   for(let k=start;k<=end;k++){
    const p=source[k],along=length?((p.x-a.x)*dx+(p.y-a.y)*dy)/length:0;
    let distance;
    if(along<=0)distance=Math.hypot(p.x-a.x,p.y-a.y);
    else if(along>=length)distance=Math.hypot(p.x-b.x,p.y-b.y);
    else distance=Math.abs(dx*(p.y-a.y)-dy*(p.x-a.x))/length;
    assert.ok(distance<=tolerance+1e-9,`Vertex deviation ${distance} exceeds ${tolerance}`);
    maximumDeviation=Math.max(maximumDeviation,distance);
   }
   start=end;
  }
  assert.equal(start,source.length-1);
  const positive=line=>line.some((p,i)=>i&& !same(p,line[i-1]));
  assert.equal(positive(target),positive(source),'Line collapsed');vertices+=source.length;
 }
 return {vertices,parts:original.length,maximumDeviation};
}
