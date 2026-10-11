import {validateMapFilter} from './mapFilter.js';

export const CESIUM_STYLE_BUDGET=5_000_000;
const paintKeys={
  circle:['circle-color','circle-radius','circle-opacity','circle-stroke-color','circle-stroke-width','circle-stroke-opacity'],
  line:['line-color','line-width','line-opacity'],
  fill:['fill-color','fill-opacity','fill-outline-color']
};
// Context-free feature expressions only. The pinned upstream parser/evaluator,
// not this admission list, owns expression types, coercion and interpolation.
const operations=new Set(['literal','get','has','id','geometry-type','case','match','step','interpolate',
  'interpolate-hcl','interpolate-lab','linear','exponential','cubic-bezier','typeof','coalesce',
  'to-number','to-string','to-boolean','to-color','number','string','boolean','array',
  '==','!=','<','<=','>','>=','!','all','any','in','at','length','index-of','slice',
  '+','-','*','/','%','^','min','max','abs','round','floor','ceil','sqrt','ln','log10','log2',
  'concat','upcase','downcase','let','var','rgb','rgba']);
function boundedExpression(value) {
  let nodes=0;
  function visit(value,depth=0,literal=false) {
    if(++nodes>2048 || depth>16 || typeof value==='string' && value.length>4096)throw Error('cesium_expression_limit');
    if(Array.isArray(value)) {
      if(!literal && !operations.has(value[0]))throw Error('cesium_expression_context_unsupported');
      value.forEach((child,index)=>visit(child,depth+1,literal || value[0]==='literal'
        || value[0]==='match' && index>=2 && index<value.length-1 && index%2===0));
    }else if(value && typeof value==='object') {
      if(!literal)throw Error('cesium_legacy_style_function_unsupported');
      Object.values(value).forEach(child=>visit(child,depth+1,true));
    }
  }
  visit(value);return nodes;
}
export function inspectCesiumPass(part) {
  if(!paintKeys[part.type] || part.minzoom!==undefined || part.maxzoom!==undefined
    || Object.keys(part.layout??{}).some(key=>key!=='visibility'))throw Error('cesium_style_layout_unsupported');
  let paintCost=0;
  for(const [key,value] of Object.entries(part.paint??{})) {
    if(!paintKeys[part.type].includes(key))throw Error('cesium_style_paint_unsupported');
    if(!Array.isArray(value) && (key.endsWith('color')?typeof value!=='string'
      :!Number.isFinite(value) || value<0 || key.endsWith('opacity') && value>1))throw Error('cesium_style_literal_invalid');
    paintCost+=boundedExpression(value);
  }
  const filterValue=part.filter??null;
  if(filterValue!==null)validateMapFilter(filterValue);
  const filterCost=filterValue===null?0:JSON.stringify(filterValue).length;
  return {cost:paintCost+filterCost,paintCost,filterCost,filterValue};
}
