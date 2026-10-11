import {validateMapFilter, combineMapFilters} from "./mapFilter.js";
import {validateLayerStyleReference, referencedStylePaint} from "./layerStyleReference.js";
import {canonicalJson} from "./artifactCanonicalJson.js";
// A publication is data + style + a viewer, never a serialized Studio session.
const paintTypes = new Set(["fill", "line", "circle", "raster", "heatmap", "fill-extrusion"]);
const sourceKeys = ["type", "data", "tiles", "tileSize", "scheme", "minzoom", "maxzoom", "bounds", "attribution", "cluster", "clusterRadius", "clusterMaxZoom", "generateId", "promoteId", "lineMetrics", "tolerance", "buffer"];
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]));
const json = value => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const localTextSymbol = item => item.type === "symbol" && item.layout?.["text-field"] !== undefined
  && item.layout?.["icon-image"] === undefined
  && !JSON.stringify(item.layout["text-field"]).includes('"image"');

function packagedPatternImages(paints, boundStyle) {
  const ids = new Set();
  for (const part of paints) for (const [key, value] of Object.entries(part.paint ?? {})) {
    if (!key.endsWith("-pattern")) continue;
    if (key !== "fill-pattern" || typeof value !== "string" || !boundStyle?.pattern) throw Error("Pattern images are not yet packaged.");
    ids.add(value);
  }
  return [...ids].map(id => {
    const image = boundStyle.images?.find(item => item.id === id);
    const pixels = image?.pixels;
    if (!pixels || pixels.width !== 64 || pixels.height !== 64 || pixels.data?.length !== 16384
      || !Number.isFinite(image.pixelRatio) || image.pixelRatio < 1 || image.pixelRatio > 8) throw Error("Pattern image is unavailable or invalid.");
    const data = Array.from(pixels.data);
    if (!data.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) throw Error("Pattern pixels are invalid.");
    return {id, width:64, height:64, data, pixelRatio:image.pixelRatio};
  });
}

function publicTileOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash
    || /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)
    || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":")
    || /(?:^|\.)(?:studio|preview\.studio|source)\.opengeo\.tools$/.test(url.hostname)
    || /(?:token|key|secret|signature|credential|authorization|session)/i.test(url.search)
    || /\/api(?:\/|$)/i.test(url.pathname)) {
    throw Error("Use a public HTTPS tile URL without account credentials or signed access.");
  }
  return url.origin;
}

export function inspectStaticMapLayers({style, layers, handles, mode = "offline", includeLabels = true}) {
  return layers.map(layer => {
    const handle = handles.get(layer.layerId);
    const source = style.sources?.[handle?.sourceId];
    const displayed = (style.layers ?? []).filter(item => handle?.layerIds?.includes(item.id));
    const omittedLabels = includeLabels ? [] : displayed.filter(item => localTextSymbol(item) && item.source === handle?.sourceId);
    const paints = displayed.filter(item => !omittedLabels.includes(item));
    let reason = null;
    if (!source || !paints.length) reason = "Layer is not loaded in this view.";
    else if (paints.some(item => (!paintTypes.has(item.type) && !localTextSymbol(item)) || item.source !== handle.sourceId)) reason = "This layer needs viewer features or label assets not yet packaged.";
    else if (source.type === "geojson" && source.data && typeof source.data === "object") {
      if (!["FeatureCollection", "Feature"].includes(source.data.type)) reason = "Inline GeoJSON is required.";
    } else if (mode === "live" && source.type === "raster" && source.tiles?.length) {
      try { source.tiles.forEach(publicTileOrigin); } catch (error) { reason = error.message; }
    } else reason = mode === "offline" ? "Requires network data; not an offline layer." : "Only inline GeoJSON and public raster tile layers are supported in this export.";
    let images = [];
    try { images = packagedPatternImages(paints, layer.styleReference ? handle?.boundStyle : null); }
    catch (error) { reason = error.message; }
    if (layer.filter != null || handle?.baseFilters) {
      try {
        if (layer.filter != null) validateMapFilter(layer.filter);
        for (const part of paints) {
          const expected = combineMapFilters(handle?.baseFilters?.[part.id], layer.filter);
          if (canonicalJson(part.filter ?? null) !== canonicalJson(expected)) {
            throw Error("Displayed filtering differs from the Project. Reapply the filter before exporting.");
          }
        }
      } catch (error) { reason = error.message; }
    }
    if (layer.styleReference) {
      try {
        const reference = validateLayerStyleReference(layer.styleReference);
        if (!handle?.boundStyle || canonicalJson(handle.boundStyle.reference) !== canonicalJson(reference)) {
          throw Error("The pinned Style is not resolved in this view.");
        }
        const expected = referencedStylePaint(handle.boundStyle, layer).filter(item => includeLabels || !localTextSymbol(item));
        if (expected.length !== paints.length || expected.some(part => {
          const displayed = paints.find(item => item.id === part.id);
          return !displayed || displayed.type !== part.type || canonicalJson(displayed.paint) !== canonicalJson(part.paint);
        })) throw Error("Displayed styling differs from the pinned Style. Reload it before exporting.");
      } catch (error) { reason = error.message; }
    }
    return {...(layer.styleReference ? {styleReference: structuredClone(layer.styleReference)} : {}), id: layer.layerId, title: layer.title ?? layer.layerId, visible: layer.visible !== false, reason, source,
      attribution: source?.attribution ?? layer.attribution ?? "", paints, images, omittedLabelCount: omittedLabels.length,
      paintOrder: Object.fromEntries((style.layers ?? []).map((item, index) => [item.id, index])), sourceId: handle?.sourceId};
  });
}

export function staticMapDocument(options) {
  return compileStaticMapDocument(options).html;
}

export function compileStaticMapDocument({title, view, candidates, selectedIds, mode = "offline", runtimeJs, runtimeCss, runtimeLicense}) {
  if (!["live", "offline"].includes(mode)) throw Error("Choose live or offline output.");
  const selected = candidates.filter(item => selectedIds.includes(item.id));
  if (!selected.length || selected.length !== new Set(selectedIds).size || selected.some(item => item.reason)) throw Error("Select supported layers before exporting.");
  if (!runtimeJs || !runtimeCss || !runtimeLicense) throw Error("The packaged viewer is unavailable.");
  const origins = new Set();
  const style = {version: 8, sources: {}, layers: [{id: "export-background", type: "background", paint: {"background-color": "#e7ecef"}}]};
  const controls = [];
  for (const item of selected) {
    const source = Object.fromEntries(sourceKeys.filter(key => item.source[key] !== undefined).map(key => [key, structuredClone(item.source[key])]));
    if (source.type === "raster") {
      if (mode !== "live") throw Error("Offline editions cannot use network sources.");
      source.tiles.forEach(url => origins.add(publicTileOrigin(url)));
    } else if (source.type !== "geojson" || typeof source.data !== "object") throw Error("Unsupported source.");
    if (item.attribution) source.attribution = escapeHtml(String(item.attribution).replace(/<[^>]*>/g, ""));
    style.sources[item.sourceId] = source;
    for (const paint of item.paints) {
      const {metadata, ...spec} = paint;
      style.layers.push({...structuredClone(spec), layout: {...spec.layout, visibility: item.visible ? "visible" : "none"}});
    }
    controls.push({title: item.title, ids: item.paints.map(paint => paint.id), visible: item.visible});
  }
  const order = Object.assign({}, ...selected.map(item => item.paintOrder));
  style.layers.sort((a, b) => (a.id === "export-background" ? -1 : order[a.id]) - (b.id === "export-background" ? -1 : order[b.id]));
  const camera = {center: view?.center ?? [0, 0], zoom: view?.zoom ?? 2, pitch: view?.pitch ?? 0, bearing: view?.bearing ?? 0};
  if (!Array.isArray(camera.center) || camera.center.length !== 2 || ![...camera.center, camera.zoom, camera.pitch, camera.bearing].every(Number.isFinite)) throw Error("Map view is invalid.");
  const images = selected.flatMap(item => item.images ?? []);
  if (new Set(images.map(image => image.id)).size !== images.length) throw Error("Pattern image identities conflict.");
  const payload = {title: String(title), mode, view: camera, style, controls, images};
  if (JSON.stringify(payload).length > 20 * 1024 * 1024) throw Error("Selected map exceeds the 20 MB export limit.");
  const inlineRuntime = runtimeJs.replace(/<\/script/gi, match => match.replace('/', '\\/'));
  const policy = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; worker-src blob:; child-src blob:; img-src data: blob: ${[...origins].join(" ")}; connect-src blob: ${[...origins].join(" ")}; base-uri 'none'; form-action 'none'`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(policy)}"><title>${escapeHtml(title)}</title>
<style>${runtimeCss.replace(/<\/style/gi, "<\\/style")}
html,body{height:100%;margin:0;font:14px system-ui,sans-serif}#map{position:absolute;inset:0}#panel{position:absolute;top:10px;left:10px;max-width:min(310px,calc(100vw - 90px));max-height:60vh;overflow:auto;background:#fff;color:#222;padding:10px 14px;border-radius:5px;box-shadow:0 1px 5px #0004}h1{font-size:16px;margin:0 0 6px}label{display:block;margin:8px 0}summary{cursor:pointer}#status{font-size:12px;max-width:35em}#license{white-space:pre-wrap;font-size:11px} @media(prefers-color-scheme:dark){#panel{background:#202020;color:#eee}}</style></head>
<body><div id="map" aria-label="Interactive map"></div><section id="panel"><h1>${escapeHtml(title)}</h1><details open><summary>Layers</summary><div id="layers"></div></details><button id="reset">Reset view</button><p id="status" role="status">Opening map…</p><details><summary>Viewer license</summary><pre id="license">${escapeHtml(runtimeLicense)}</pre></details></section>
<script>${inlineRuntime}</script>
<script>const publication=${json(payload)};
const status=document.getElementById('status');
try {
 const map=new maplibregl.Map({container:'map',style:{...publication.style,layers:publication.style.layers.filter(layer=>layer.id==='export-background')},...publication.view,attributionControl:true,transformRequest:url=>({url,credentials:'omit'})});
 map.addControl(new maplibregl.NavigationControl(),'top-right');
 document.getElementById('reset').onclick=()=>map.jumpTo(publication.view);
 map.on('load',()=>{
 for(const image of publication.images)map.addImage(image.id,{width:image.width,height:image.height,data:new Uint8Array(image.data)},{pixelRatio:image.pixelRatio});
 for(const layer of publication.style.layers)if(layer.id!=='export-background')map.addLayer(layer);
 status.textContent=publication.mode==='offline'?'Offline edition · selected vector data included · labels use local fonts':'Live services · internet required · no archive fallback';
 for(const layer of publication.controls){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.checked=layer.visible;input.onchange=()=>layer.ids.forEach(id=>map.setLayoutProperty(id,'visibility',input.checked?'visible':'none'));label.append(input,document.createTextNode(' '+layer.title));document.getElementById('layers').append(label);}});
 map.on('error',()=>{status.textContent='A map resource could not load. No alternate data source was substituted.';});
} catch(error){status.textContent='Map viewer unavailable. This browser needs WebGL support.';}
</script></body></html>`;
  return {html, payload};
}
