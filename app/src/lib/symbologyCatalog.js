import {POINT_SYMBOLS, POINT_SYMBOL_COLLECTIONS, REFERENCE_SYMBOLS, pointSymbolPreviewSvg, referenceSymbolPreviewSvg,
  ensurePointSymbolAssets, ensureReferenceSymbolAssets} from './pointSymbols.js';
import {cartographicPatterns, patternSvg, normalizePattern} from './cartographicPatterns.js';
import {landCoverPresets} from './landCoverStyle.js';
import {STYLE_PALETTES} from './workbenchConfig.js';
import {MASSGIS_SYMBOLOGY} from './massgisSymbology.js';
import {normalizeContinuousScale} from './continuousStyle.js';

const ownSource = Object.freeze({title:'OpenGeo',version:'1',url:'https://github.com/categori-se/opengeo-community',license:'Original OpenGeo cartography'});
const titleCase = value => value.replace(/[-_]/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
const xml = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const color = value => typeof value==='string' && /^#[a-f\d]{6}(?:[a-f\d]{2})?$/i.test(value);
const fieldName = value => typeof value==='string' && /^[A-Za-z_][A-Za-z0-9_.:-]{0,99}$/.test(value)
  && !['__proto__','constructor','prototype'].includes(value);
let cached;

// A detached Style, never a dataset copy or an authorization grant.
export function thematicStyleDefinition(preset, field, title) {
  if (!fieldName(field) || !Array.isArray(preset.colors) || preset.colors.length!==preset.breaks?.length+1
    || !preset.colors.every(color) || !color(preset.nullColor) || !color(preset.outlineColor)
    || !preset.breaks.every((v,i,a)=>Number.isFinite(v)&&(i===0||v>a[i-1]))
    || !['fill','line'].includes(preset.geometry)) throw Error('Invalid thematic Style');
  const paintColor=['step',['to-number',['coalesce',['get',field],-1],-1],preset.nullColor,0,preset.colors[0],
    ...preset.breaks.flatMap((stop,i)=>[stop,preset.colors[i+1]])];
  const layers=preset.geometry==='line'
    ? [{id:'boundaries',type:'line',paint:{'line-color':paintColor,'line-width':preset.outlineWidth,'line-opacity':preset.opacity}}]
    : [{id:'areas',type:'fill',paint:{'fill-color':paintColor,'fill-opacity':preset.opacity,'fill-outline-color':preset.outlineColor}},
      {id:'boundaries',type:'line',paint:{'line-color':preset.outlineColor,'line-width':preset.outlineWidth,'line-opacity':preset.opacity}}];
  return JSON.stringify({version:8,name:title,sources:{},layers});
}

export function symbologyCatalog() {
  if (cached) return cached;
  const collectionById=new Map(POINT_SYMBOL_COLLECTIONS.map(c=>[c.id,c]));
  const sourceOf=symbol=>{
    const c=collectionById.get(symbol.collection);
    return {title:symbol.source?.title||c?.label||'OpenGeo',version:symbol.source?.version||c?.version||'1',
      url:symbol.source?.url||symbol.source?.sourceUrl||c?.sourceUrl||ownSource.url,
      license:symbol.source?.license||c?.license||ownSource.license};
  };
  const entries=POINT_SYMBOLS.map(symbol=>({id:`point:${symbol.id}`,title:symbol.label,kind:'point',
    geometryKinds:['Point','MultiPoint'],collection:collectionById.get(symbol.collection)?.label??'OpenGeo markers',
    category:symbol.category??'General',tags:[symbol.id,...(symbol.tags??[])],source:sourceOf(symbol),
    recipe:{kind:'point',style:{pointSymbol:symbol.id,circleColor:'#2563eb',circleRadius:8}}}));
  for (const item of REFERENCE_SYMBOLS) entries.push({id:`reference:${item.id}`,title:item.label,kind:'reference',
    geometryKinds:[],collection:collectionById.get(item.collection)?.label??'OpenStreetMap Carto',
    category:item.category??'Cartographic artwork',tags:item.tags??[],source:sourceOf(item),
    description:'Source artwork for cartographic reference. It is not a generated, editable polygon-pattern Style.',
    recipe:{kind:'reference',symbolId:item.id}});

  for (const motif of cartographicPatterns) entries.push({id:`pattern:${motif.id}`,title:motif.title,kind:'pattern',
    geometryKinds:['Polygon','MultiPolygon'],collection:'OpenGeo patterns',category:'Procedural fills',
    tags:[motif.id,'texture','fill'],source:ownSource,
    recipe:{kind:'pattern',pattern:normalizePattern({id:motif.id,foreground:motif.foreground,background:motif.background,size:32,width:1.4,transparent:false})}});

  // Keep the five original Studio variants distinct from the Map Folio colors.
  const studioVariants=[
    ['water','Water','waves','#4e96bf','#d5ebf5'],['lakes','Lakes','ripples','#438fba','#d8edf7'],
    ['wetlands','Wetlands','wetland','#428aa8','#e2eddf'],['marsh','Marshes','wetland','#3d85ad','#edf4f6'],
    ['forest','Forest','forest','#39724f','#dcebd1']];
  for (const [id,title,motif,foreground,background] of studioVariants) entries.push({id:`landcover:studio:${id}`,
    title,kind:'pattern',geometryKinds:['Polygon','MultiPolygon'],collection:'OpenGeo land cover',category:'Land cover',
    tags:[id,'landcover','Studio'],source:ownSource,
    recipe:{kind:'pattern',pattern:{id:motif,foreground,background,size:32,width:1.4,transparent:false}}});
  for (const [id,p] of Object.entries(landCoverPresets)) entries.push({id:`landcover:folio:${id}`,
    title:titleCase(id),kind:'pattern',geometryKinds:['Polygon','MultiPolygon'],collection:'Map Folio land cover',
    category:'Land cover',tags:[id,'landcover','Map Folio'],source:ownSource,
    recipe:{kind:'pattern',pattern:normalizePattern({id:p.pattern,foreground:p.foreground,background:p.background,
      size:p.size,width:p.width,transparent:p.transparent===true})}});

  const massgisSource=MASSGIS_SYMBOLOGY.source;
  for (const example of MASSGIS_SYMBOLOGY.examples) {
    const preset=MASSGIS_SYMBOLOGY.presets.find(p=>p.id===example.presetId);
    entries.push({id:`massgis:${example.id}`,title:example.title,kind:preset.geometry==='line'?'line':'polygon',
      geometryKinds:['Polygon','MultiPolygon'],collection:'MassGIS · MassEnviroScreen',category:example.category,
      tags:[example.field,example.fieldAlias,example.unit,'MassGIS','percentile'],source:massgisSource,
      description:`${example.description} ${preset.geometry==='line'?'Colors trace polygon boundaries. ':''}Field: ${example.field}.`,
      recipe:{kind:'maplibre',field:example.field,fieldLabel:example.fieldAlias,colors:preset.colors,
        geometry:preset.geometry,definition:thematicStyleDefinition(preset,example.field,example.title)}});
  }
  for (const [id,title,colors] of STYLE_PALETTES.filter(([, , colors])=>colors.length)) {
    const preset={geometry:'fill',breaks:[20,40,60,80],colors,opacity:.75,outlineColor:'#ffffff',outlineWidth:.5,nullColor:'#9ca3af'};
    entries.push({id:`palette:${id}`,title,kind:'palette',geometryKinds:['Polygon','MultiPolygon'],
      collection:'OpenGeo palettes',category:'Color ramps',tags:[id,'palette','five classes'],source:ownSource,
      description:'Five classes across a 0–100 numeric field. Customize the field before saving.',
      recipe:{kind:'maplibre',field:'value',fieldLabel:'Numeric field (0–100)',colors,geometry:'fill',
        definition:thematicStyleDefinition(preset,'value',`${title} · five classes`)}});
  }
  cached=Object.freeze(entries.map(entry=>Object.freeze(entry)));
  if (new Set(cached.map(entry=>entry.id)).size!==cached.length) throw Error('Duplicate symbology identity');
  return cached;
}

export function symbologyPreview(entry) {
  const img=document.createElement('img');img.alt=`${entry.title} preview`;img.width=180;img.height=86;
  if (entry.recipe.kind==='point' || entry.recipe.kind==='reference') {
    img.dataset.state='loading';
    const ready=entry.recipe.kind==='point' ? ensurePointSymbolAssets(entry.recipe.style) : ensureReferenceSymbolAssets();
    ready.then(()=>{
      const svg=entry.recipe.kind==='point' ? pointSymbolPreviewSvg(entry.recipe.style) : referenceSymbolPreviewSvg(entry.recipe.symbolId);
      // Align the retained raster runs to pixels at thumbnail sizes. Otherwise
      // fractional SVG scaling leaves pale seams between adjacent scanlines.
      img.src=`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace('<svg ', '<svg shape-rendering="crispEdges" '))}`;img.dataset.state='ready';
    }).catch(()=>{img.alt=`${entry.title} preview unavailable`;img.dataset.state='error';});
    return img;
  }
  let svg;
  if (entry.recipe.kind==='pattern') svg=patternSvg(entry.recipe.pattern,true);
  else if(entry.recipe.continuousScale){
    const scale=normalizeContinuousScale(entry.recipe.continuousScale),first=scale.stops[0].value,last=scale.stops.at(-1).value;
    const stops=scale.stops.map(stop=>`<stop offset="${(stop.value-first)/(last-first)}" stop-color="${stop.color}"/>`).join('');
    const ticks=scale.stops.map(stop=>{const x=14+152*(stop.value-first)/(last-first);return `<path d="M${x} 58v4" stroke="#17212b"/>`;}).join('');
    svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 86"><title>${xml(entry.title)} · ${xml(scale.field)} continuous scale</title><defs><linearGradient id="scale" color-interpolation="sRGB">${stops}</linearGradient></defs><rect x="14" y="14" width="152" height="44" fill="url(#scale)"/>${ticks}<text x="14" y="75" font-size="10">${first}</text><text x="166" y="75" text-anchor="end" font-size="10">${last}</text></svg>`;
  }
  else {
    const colors=entry.recipe.colors??['#2563eb'];
    const cells=colors.map((fill,i)=>entry.recipe.geometry==='line'
      ? `<path d="M${i*36+4} 64V23l26-12v48z" fill="none" stroke="${fill}" stroke-width="3"/>`
      : `<path d="M${i*36} 86V18l36-12v80z" fill="${fill}" stroke="#ffffff"/>`).join('');
    svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 86"><title>${xml(entry.title)}</title>${cells}</svg>`;
  }
  img.src=`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  return img;
}
