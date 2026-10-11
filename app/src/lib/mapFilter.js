/** Bounded MapLibre feature predicates, stored without evaluating or rewriting values. */
export function validateMapFilter(value) {
  if(value===null)return null;
  let count=0;
  const field=v=>Array.isArray(v)&&v.length===2&&v[0]==="get"&&typeof v[1]==="string"&&v[1].length>0&&v[1].length<=128;
  const scalar=v=>v===null||typeof v==="boolean"||typeof v==="string"&&v.length<=1024||typeof v==="number"&&Number.isFinite(v);
  function check(v,depth){
    if(++count>64||depth>8||!Array.isArray(v))throw Error("Unsupported map filter.");
    const [op,...args]=v;
    if(["all","any"].includes(op)&&args.length>=1&&args.length<=16){args.forEach(x=>check(x,depth+1));return;}
    if(op==="!"&&args.length===1){check(args[0],depth+1);return;}
    if(op==="in"&&args.length===2&&field(args[0])) {
      const literal=args[1], values=literal?.[1];
      if(Array.isArray(literal)&&literal.length===2&&literal[0]==="literal"&&Array.isArray(values)&&values.length>=1&&values.length<=64
        &&["string","number"].includes(typeof values[0])&&values.every(v=>typeof v===typeof values[0]&&scalar(v)))return;
    }
    if(op==="has"&&args.length===1&&field(["get",args[0]]))return;
    if(["==","!=","<","<=",">",">="].includes(op)&&args.length===2&&(field(args[0])||field(["get",args[0]]))&&scalar(args[1])&&(["==","!="].includes(op)||["string","number"].includes(typeof args[1])))return;
    throw Error("Unsupported map filter.");
  }
  check(value,0);
  if(JSON.stringify(value).length>8192)throw Error("Map filter is too large.");
  return value;
}
export function combineMapFilters(base,selected){
  return base&&selected?["all",base,selected]:selected??base??null;
}

export function mapFilterOptions(base, selected) {
  const filter = combineMapFilters(base, selected);
  return filter === null ? {} : {filter};
}
