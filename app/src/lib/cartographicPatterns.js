export function createCartographicPatternLibrary() {
// Original procedural motifs. No third-party image or notebook assets are copied.
const cartographicPatterns = Object.freeze([
  {id: 'hatch', title: 'Hatches', foreground: '#444444', background: '#ffffff'},
  {id: 'dots', title: 'Dots', foreground: '#444444', background: '#ffffff'},
  {id: 'waves', title: 'Waves', foreground: '#9cc9eb', background: '#397eb0'},
  {id: 'ripples', title: 'Ripples', foreground: '#3d85ad', background: '#c3e3ef'},
  {id: 'forest', title: 'Trees', foreground: '#2c6c42', background: '#d6e8c9'},
  {id: 'grass', title: 'Blades', foreground: '#66803a', background: '#edf0cb'},
  {id: 'wetland', title: 'Reeds', foreground: '#527b65', background: '#d3e6db'},
  {id: 'crosshatch', title: 'Cross lines', foreground: '#444444', background: '#ffffff'},
  {id: 'lines', title: 'Parallel lines', foreground: '#444444', background: '#ffffff'},
  {id: 'dashes', title: 'Dashes', foreground: '#444444', background: '#ffffff'}
]);
const legacyIds = new Set(['hatch','dots','waves','ripples','forest','grass','wetland']);
const recipeKeys = new Set(['version','id','foreground','background','size','width','transparent',
  'density','angle','amplitude','curve','opacity']);
const advancedKeys = ['density','angle','amplitude','curve','opacity'];
function normalizePattern(value) {
  const advanced = value?.version === 2 || !legacyIds.has(value?.id)
    || advancedKeys.some(key => Object.prototype.hasOwnProperty.call(value ?? {}, key));
  if (!cartographicPatterns.some(item => item.id === value?.id)
    || !/^#[0-9a-f]{6}$/i.test(value.foreground) || !/^#[0-9a-f]{6}$/i.test(value.background)
    || !Number.isFinite(value.size) || value.size < (advanced ? 8 : 16) || value.size > 64) throw Error('Invalid pattern');
  if (advanced) {
    if (Object.keys(value).some(key => !recipeKeys.has(key))
      || (value.version !== undefined && value.version !== 2)
      || (value.transparent !== undefined && typeof value.transparent !== 'boolean')) throw Error('Invalid pattern recipe');
    const bounded = (key, fallback, min, max) => {
      const number = value[key] === undefined ? fallback : value[key];
      if (!Number.isFinite(number) || number < min || number > max) throw Error(`Invalid pattern ${key}`);
      return number;
    };
    return {version:2,id:value.id,foreground:value.foreground,background:value.background,size:value.size,
      width:bounded('width',1.4,.5,4),transparent:value.transparent === true,
      density:bounded('density',1,.5,4),angle:bounded('angle',0,-180,180),
      amplitude:bounded('amplitude',8,0,16),curve:bounded('curve',.5,0,1),opacity:bounded('opacity',1,0,1)};
  }
  // Keep v1's property order, coercion and geometry unchanged: saved SLD bytes are identity.
  return {id:value.id, foreground:value.foreground, background:value.background, size:value.size, width: Math.max(.5, Math.min(4, Number(value.width) || 1.4)), transparent: value.transparent === true};
}
function advancedPatternSvg(p, swatch) {
  const number = value => Number(value.toFixed(4));
  const paths={hatch:'M-8 8L8-8 M0 32L32 0 M24 40L40 24',
    crosshatch:'M-8 8L8-8 M0 32L32 0 M24 40L40 24 M-8 24L8 40 M0 0L32 32 M24-8L40 8',
    lines:'M-16 8H48 M-16 24H48',dots:'M8 8h.1 M24 24h.1',
    ripples:'M2 8h12 M18 24h12',dashes:'M2 8h12 M18 24h12',
    forest:'M8 3l-5 9h10z M8 12v5 M24 18l-5 9h10z M24 27v4',
    grass:'M4 18l4 6 4-9 M8 24v4 M20 2l4 6 4-5 M24 8v4',
    wetland:'M2 23h12 M18 10h12 M8 22V12m0 5l-4-4m4 6l4-5 M24 9V1'};
  if (p.id === 'waves') {
    const segments=[];
    for (const y of [8,24]) for (let x=-16;x<48;x+=16) {
      segments.push(`M${x} ${y}C${number(x+8*p.curve)} ${number(y+p.amplitude)} ${number(x+8*(1-p.curve))} ${number(y+p.amplitude)} ${x+8} ${y}S${number(x+16-8*p.curve)} ${number(y-p.amplitude)} ${x+16} ${y}`);
    }
    paths.waves=segments.join(' ');
  }
  // Periodize the transformed motif itself, rather than crop a rotated infinite
  // pattern. Density controls motif coverage; size controls repeat spacing.
  // All shapes plus the largest stroke fit within [-68,100] at scale <= 2.
  // Translations through +/-96 therefore cover every contribution to this tile.
  const copies=[];
  for (let y=-96;y<=96;y+=32) for (let x=-96;x<=96;x+=32) {
    copies.push(`<use href="#motif" transform="translate(${x} ${y})"/>`);
  }
  const motif=`<g id="motif" transform="translate(16 16) rotate(${p.angle}) scale(${number(Math.sqrt(p.density))}) translate(-16 -16)"><path d="${paths[p.id]}"/></g>`;
  const content=`<defs>${motif}</defs><rect width="32" height="32" fill="${p.background}" fill-opacity="${p.transparent ? 0 : 1}"/><g stroke="${p.foreground}" stroke-width="${p.width}" opacity="${p.opacity}" stroke-linecap="round" fill="none">${copies.join('')}</g>`;
  return swatch
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="100"><defs><pattern id="tile" width="${p.size}" height="${p.size}" patternUnits="userSpaceOnUse" viewBox="0 0 32 32">${content}</pattern></defs><rect width="240" height="100" fill="url(#tile)"/></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="${p.size}" height="${p.size}" viewBox="0 0 32 32">${content}</svg>`;
}
function patternSvg(value, swatch = false) {
  const p=normalizePattern(value);
  if (p.version === 2) return advancedPatternSvg(p, swatch);
  const paths={hatch:'M-8 8L8-8 M0 32L32 0 M24 40L40 24', dots:'M8 8h.1 M24 24h.1', waves:'M-8 8Q0 24 8 8T24 8T40 8 M-8 24Q0 40 8 24T24 24T40 24',
    ripples:'M2 8h12 M18 24h12', forest:'M8 3l-5 9h10z M8 12v5 M24 18l-5 9h10z M24 27v4',
    grass:'M4 18l4 6 4-9 M8 24v4 M20 2l4 6 4-5 M24 8v4',
    wetland:'M2 23h12 M18 10h12 M8 22V12m0 5l-4-4m4 6l4-5 M24 9V1'};
  const motif=`<rect width="32" height="32" fill="${p.background}" fill-opacity="${p.transparent ? 0 : 1}"/><path d="${paths[p.id]}" stroke="${p.foreground}" stroke-width="${p.width}" stroke-linecap="round" fill="none"/>`;
  return swatch
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="100"><defs><pattern id="tile" width="${p.size}" height="${p.size}" patternUnits="userSpaceOnUse" viewBox="0 0 32 32">${motif}</pattern></defs><rect width="240" height="100" fill="url(#tile)"/></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="${p.size}" height="${p.size}" viewBox="0 0 32 32">${motif}</svg>`;
}

  return {cartographicPatterns, normalizePattern, patternSvg};
}
export const {cartographicPatterns, normalizePattern, patternSvg} = createCartographicPatternLibrary();
const escapeXml=value=>String(value).replace(/[<>&"']/g,char=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[char]));
export function patternSld(value, title) {
  const p=normalizePattern(value);
  const metadata=escapeXml(`OpenGeo procedural pattern v${p.version === 2 ? 2 : 1} `+JSON.stringify(p));
  return `<StyledLayerDescriptor xmlns="http://www.opengis.net/sld" xmlns:se="http://www.opengis.net/se" version="1.1.0"><NamedLayer><se:Name>features</se:Name><UserStyle><se:Name>${escapeXml(title)}</se:Name><se:Description><se:Title>${escapeXml(title)}</se:Title><se:Abstract>${metadata}</se:Abstract></se:Description><se:FeatureTypeStyle><se:Rule><se:PolygonSymbolizer><se:Fill><se:GraphicFill><se:Graphic><se:ExternalGraphic><se:InlineContent encoding="base64">${btoa(patternSvg(p))}</se:InlineContent><se:Format>image/svg+xml</se:Format></se:ExternalGraphic><se:Size>${p.size}</se:Size></se:Graphic></se:GraphicFill></se:Fill></se:PolygonSymbolizer></se:Rule></se:FeatureTypeStyle></UserStyle></NamedLayer></StyledLayerDescriptor>`;
}
export function savedPattern(style) {
  if (style?.format!=='sld_1_1' || typeof style.definition!=='string' || style.definition.length>49152
    || /<!DOCTYPE|<!ENTITY/i.test(style.definition)) return null;
  try {
    const xml=new DOMParser().parseFromString(style.definition,'application/xml');
    const text=xml.getElementsByTagNameNS('http://www.opengis.net/se','Abstract')[0]?.textContent;
    const prefix=['OpenGeo procedural pattern v1 ','OpenGeo procedural pattern v2 '].find(value=>text?.startsWith(value));
    if (!prefix) return null;
    const pattern=normalizePattern(JSON.parse(text.slice(prefix.length)));
    const name=xml.getElementsByTagNameNS('http://www.opengis.net/se','Title')[0]?.textContent;
    return patternSld(pattern,name)===style.definition ? pattern : null;
  } catch {return null;}
}
export function patternImage(value) {
  const image=document.createElement('img'); image.width=240; image.height=100;
  image.alt=cartographicPatterns.find(item=>item.id===value.id)?.title ?? 'Pattern preview';
  image.src=`data:image/svg+xml,${encodeURIComponent(patternSvg(value,true))}`; return image;
}

// Decode only our regenerated, bounded SVG; never render arbitrary stored XML.
export async function rasterizePattern(value) {
  const pattern = normalizePattern(value);
  const image = new Image();
  image.src = `data:image/svg+xml,${encodeURIComponent(patternSvg(pattern))}`;
  await image.decode();
  const canvas = document.createElement('canvas');
  // A power-of-two tile repeats seamlessly; pixelRatio retains the chosen spacing.
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) throw Error('Pattern rasterization unavailable');
  context.drawImage(image, 0, 0, 64, 64);
  return {pixels: context.getImageData(0, 0, 64, 64), pixelRatio: 64 / pattern.size};
}
