import {createCartographicPatternLibrary} from './cartographicPatterns.js';

export function createLandCoverLibrary(patterns) {
const {cartographicPatterns, normalizePattern, patternSvg} = patterns;
const SVG = 'http://www.w3.org/2000/svg';
const sequences = new WeakMap();
const color = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
// RGB equivalents of the reference's HSL colors; procedural motifs stay OpenGeo's.
const mapFolioPalette = Object.freeze({water: '#669df5', lakes: '#9abef9', forest: '#82c995',
  land: '#f5f0e5', landBorder: '#f2e9d9'});
const classes = {
  water: {pattern: 'waves', stroke: mapFolioPalette.water, foreground: mapFolioPalette.lakes, background: mapFolioPalette.water},
  lakes: {pattern: 'ripples', stroke: mapFolioPalette.lakes, foreground: mapFolioPalette.water, background: mapFolioPalette.lakes},
  wetlands: {pattern: 'wetland', stroke: '#527b65'},
  marsh: {pattern: 'wetland', stroke: '#438fba', foreground: '#438fba', background: '#e4f0f7', size: 24},
  forest: {pattern: 'forest', stroke: mapFolioPalette.forest, background: mapFolioPalette.forest},
  grassland: {pattern: 'grass', stroke: '#66803a'},
  'built-areas': {pattern: 'dots', stroke: '#8b8178', foreground: '#8b8178', background: '#e5ddd3'},
  'deciduous-forest': {pattern: 'forest', stroke: '#5b8a46', foreground: '#5b8a46', background: '#dceacb', size: 40},
  'evergreen-forest': {pattern: 'forest', stroke: '#285d43', foreground: '#285d43', background: '#b9d5c2', size: 24},
  'mixed-forest': {pattern: 'forest', stroke: '#41754a', foreground: '#41754a', background: '#cadfb8', size: 32},
  shrubland: {pattern: 'grass', stroke: '#8b8748', foreground: '#8b8748', background: '#e4e4bd', size: 40},
  cropland: {pattern: 'hatch', stroke: '#a58b39', foreground: '#a58b39', background: '#f4e8bd', size: 32},
  orchards: {pattern: 'dots', stroke: '#688744', foreground: '#688744', background: '#e6edcb', size: 24, width: 3},
  'bare-ground': {pattern: 'dots', stroke: '#a58d74', foreground: '#a58d74', background: '#ede4d6', size: 40},
  rock: {pattern: 'hatch', stroke: '#807c78', foreground: '#807c78', background: '#e2e0dc', size: 24},
  sand: {pattern: 'dots', stroke: '#c4a466', foreground: '#c4a466', background: '#faf0d5', size: 24, width: 2},
  snow: {pattern: 'dots', stroke: '#9fb8c4', foreground: '#9fb8c4', background: '#f7fbfd', size: 48},
  ice: {pattern: 'hatch', stroke: '#7da9bb', foreground: '#7da9bb', background: '#def0f6', size: 40}
};

// Adapter presets, not a new persisted Style format or a standards claim.
const landCoverPresets = Object.freeze(Object.fromEntries(Object.entries(classes).map(([name, value]) => {
  const motif = cartographicPatterns.find(item => item.id === value.pattern);
  return [name, Object.freeze({foreground: motif.foreground, background: motif.background,
    size: 32, width: 1.4, strokeWidth: 0.7, ...value})];
})));

/** One adapter per SVG. Resolve/check any canonical Style reference before adapting it.
 * Plot: const style = createLandCoverStyle({document});
 * const svg = Plot.plot({marks: [Plot.geo(features, style.plotGeoOptions(classify))]});
 * style.install(svg);
 */
function createLandCoverStyle({document = globalThis.document, namespace = 'opengeo-landcover', overrides = {}} = {}) {
  if (!document?.createElementNS || !document.defaultView?.DOMParser) throw Error('An SVG document is required');
  if (typeof namespace !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(namespace)) throw Error('Invalid pattern namespace');
  if (!overrides || Object.getPrototypeOf(overrides) !== Object.prototype) throw Error('Invalid land-cover overrides');
  const recipes = new Map();
  for (const key of Object.keys(overrides)) if (!Object.hasOwn(landCoverPresets, key)) throw Error('Unknown land-cover class');
  for (const [name, preset] of Object.entries(landCoverPresets)) {
    const change = overrides[name] ?? {};
    if (!change || Object.getPrototypeOf(change) !== Object.prototype
      || Object.keys(change).some(key => !['foreground', 'background', 'size', 'width', 'stroke', 'strokeWidth', 'transparent'].includes(key))) {
      throw Error('Invalid land-cover override');
    }
    const value = {...preset, ...change};
    if (!color(value.stroke) || !Number.isFinite(value.strokeWidth) || value.strokeWidth < 0 || value.strokeWidth > 8
      || !Number.isFinite(value.width) || value.width < 0.5 || value.width > 4
      || typeof value.transparent !== 'undefined' && typeof value.transparent !== 'boolean') throw Error('Invalid land-cover paint');
    recipes.set(name, {pattern: normalizePattern({...value, id: value.pattern}), stroke: value.stroke, strokeWidth: value.strokeWidth});
  }
  let serial = sequences.get(document) ?? 0, prefix;
  do {prefix = `${namespace}-${++serial}`;} while ([...recipes.keys()].some(name => document.getElementById(`${prefix}-${name}`)));
  sequences.set(document, serial);
  let target;
  const paint = name => {
    const recipe = recipes.get(name);
    if (!recipe) throw Error('Unknown land-cover class');
    return {fill: `url(#${prefix}-${name})`, stroke: recipe.stroke, strokeWidth: recipe.strokeWidth};
  };
  const install = svg => {
    if (svg?.namespaceURI !== SVG || svg.localName !== 'svg' || svg.ownerDocument !== document) throw Error('Expected an SVG in the adapter document');
    if (target) {if (target !== svg) throw Error('Use a separate land-cover adapter for each SVG'); return svg;}
    if ([...recipes.keys()].some(name => document.getElementById(`${prefix}-${name}`) || svg.querySelector(`[id="${prefix}-${name}"]`))) throw Error('Pattern ID already exists');
    const defs = document.createElementNS(SVG, 'defs');
    for (const [name, {pattern}] of recipes) {
      const node = document.createElementNS(SVG, 'pattern');
      for (const [key, value] of Object.entries({id: `${prefix}-${name}`, width: pattern.size, height: pattern.size,
        patternUnits: 'userSpaceOnUse', viewBox: '0 0 32 32'})) node.setAttribute(key, String(value));
      // Only parse our regenerated validated recipe, never caller-supplied SVG/XML.
      const generated = new document.defaultView.DOMParser().parseFromString(patternSvg(pattern), 'image/svg+xml');
      for (const child of generated.documentElement.children) node.append(document.importNode(child, true));
      defs.append(node);
    }
    svg.setAttribute('xmlns', SVG); svg.prepend(defs); target = svg; return svg;
  };
  const accessor = classify => {
    if (typeof classify !== 'function') throw Error('A land-cover class accessor is required');
    return datum => paint(classify(datum));
  };
  return Object.freeze({paint, install,
    applyD3(selection, classify) {
      if (!target || !selection?.each) throw Error('Install the patterns before styling a D3 selection');
      const value = accessor(classify);
      selection.each(function(datum) {
        if (this.ownerSVGElement !== target || !['path', 'rect', 'polygon', 'circle'].includes(this.localName)) throw Error('D3 shapes must belong to the adapter SVG');
        const style = value(datum);
        this.setAttribute('fill', style.fill); this.setAttribute('stroke', style.stroke); this.setAttribute('stroke-width', String(style.strokeWidth));
      });
      return selection;
    },
    plotGeoOptions(classify) {
      const value = accessor(classify);
      // Explicit overrides prevent Plot's color scale from remapping SVG paint URLs.
      return {fill: {value: datum => value(datum).fill, scale: null},
        stroke: {value: datum => value(datum).stroke, scale: null},
        strokeWidth: {value: datum => value(datum).strokeWidth, scale: null}};
    }
  });
}


return {mapFolioPalette, landCoverPresets, createLandCoverStyle};
}
export const {mapFolioPalette, landCoverPresets, createLandCoverStyle} = createLandCoverLibrary(createCartographicPatternLibrary());

/** Serialize self-contained factories; minifiers may rename locals safely inside each factory. */
export function landCoverModuleSource() {
  return '// OpenGeo.Tools land-cover SVG adapter. Local procedural motifs.\n'
    + `const patterns = (${createCartographicPatternLibrary.toString()})();\n`
    + `const library = (${createLandCoverLibrary.toString()})(patterns);\n`
    + 'export const {mapFolioPalette, landCoverPresets, createLandCoverStyle} = library;\n';
}
