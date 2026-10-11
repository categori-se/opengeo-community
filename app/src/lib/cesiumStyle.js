import {createPropertyExpression,featureFilter,latest} from '@maplibre/maplibre-gl-style-spec';
import {inspectCesiumPass} from './cesiumStyleAdmission.js';
export {CESIUM_STYLE_BUDGET} from './cesiumStyleAdmission.js';

const featureInput=feature=>({id:feature.id,properties:feature.properties??{},
  type:feature.geometry.type.replace(/^Multi/,'')});
function charge(budget,cost) {
  if(budget && (budget.remaining-=cost)<0)throw Error('cesium_style_evaluation_limit');
}

export function compileCesiumPass(part) {
  const {cost,paintCost,filterCost,filterValue}=inspectCesiumPass(part);
  const programs=[];
  for(const [key,value] of Object.entries(part.paint??{})) {
    const parsed=createPropertyExpression(value,key,latest[`paint_${part.type}`][key]);
    if(parsed.result!=='success' || !['constant','source'].includes(parsed.value.kind)
      || parsed.value.isStateDependent || parsed.value.globalStateRefs.size)throw Error('cesium_style_expression_unsupported');
    programs.push([key,parsed.value]);
  }
  const filter=featureFilter(filterValue??undefined,'filter');
  if(filter.needGeometry || filter.getGlobalStateRefs().size)throw Error('cesium_style_filter_unsupported');
  return {
    cost,
    accepts(feature,budget) {charge(budget,filterCost);return filter.filter({zoom:0},featureInput(feature));},
    paint(feature,budget) {
      charge(budget,paintCost);
      const result={},input=featureInput(feature);
      for(const [key,program] of programs) {
        // No silent paint substitution when an expression cannot evaluate for a
        // source feature. Candidate failure retains the previous usable renderer.
        const value=program.evaluateWithoutErrorHandling({zoom:0},input);
        if(key.endsWith('color')) {
          if(!value?.rgb?.every(Number.isFinite))throw Error('cesium_style_color_invalid');
          result[key]=[...value.rgb]; // Straight alpha, never multiply it twice.
        }else {
          if(!Number.isFinite(value) || value<0 || key.endsWith('opacity') && value>1)throw Error('cesium_style_number_invalid');
          result[key]=value;
        }
      }
      return result;
    }
  };
}
