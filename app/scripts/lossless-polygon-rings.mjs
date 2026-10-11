// Remove only duplicate vertices and vertices lying between collinear neighbors.
// Every replacement preserves the same directed segment path, with integer arithmetic.
const same=(a,b)=>a.x===b.x&&a.y===b.y;
const between=(a,b,c)=>(b.x-a.x)*(c.y-a.y)===(b.y-a.y)*(c.x-a.x)
 &&(b.x-a.x)*(b.x-c.x)+(b.y-a.y)*(b.y-c.y)<=0;
export function losslessPolygonRing(ring){
 if(ring.length<4||!same(ring[0],ring.at(-1)))return ring;
 const stack=[];
 for(const point of ring.slice(0,-1)){
  if(stack.length&&same(stack.at(-1),point))continue;
  while(stack.length>=2&&between(stack.at(-2),stack.at(-1),point))stack.pop();
  stack.push(point);
 }
 if(stack.length<3)return ring; // Keep degenerate source commands for separate review.
 while(stack.length>3){
  if(between(stack.at(-2),stack.at(-1),stack[0]))stack.pop();
  else if(between(stack.at(-1),stack[0],stack[1]))stack.shift();
  else break;
 }
 return [...stack,stack[0]];
}
