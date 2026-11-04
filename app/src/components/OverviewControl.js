// A geographic overview of resident Layer geometry, or a lazy owned child of
// the existing renderer for visible authorized map sources. No saved Project
// state, new source authority, credentials, or separate SDK is created.
export function overviewStyle(map) {
  const source = map?.getStyle?.();
  if (!source || !Array.isArray(source.layers)) return null;
  const zoom = map.getZoom?.() ?? 0, sources = {};
  const layers = source.layers.filter(layer => layer && layer.layout?.visibility !== "none"
    && zoom >= (layer.minzoom ?? 0) && zoom < (layer.maxzoom ?? 24)
    && ["background","fill","line","symbol","circle","raster","hillshade","fill-extrusion","heatmap"].includes(layer.type)
    && (!layer.source || typeof layer.source === "string" && source.sources?.[layer.source]));
  for (const layer of layers) if (layer.source) sources[layer.source] = source.sources[layer.source];
  if (!Object.keys(sources).length) return null;
  // The public style snapshot contains only sources already visible in the main
  // map. No dormant source, terrain, token lookup or separate SDK is activated.
  const style = {version: 8, sources, layers};
  if (layers.some(layer => layer.type === "symbol")) {
    if (source.glyphs) style.glyphs = source.glyphs;
    if (source.sprite) style.sprite = source.sprite;
  }
  return structuredClone(style);
}

export function OverviewControl(getMap, {getGeography = () => [], open = false, onOpenChange = () => {}, createMap, disposeMap} = {}) {
  const doc = document, ns = "http://www.w3.org/2000/svg";
  const element = doc.createElement("section"); element.className = "gis-overview";
  const toggle = doc.createElement("button"); toggle.type = "button"; toggle.textContent = "Overview";
  const panel = doc.createElement("div"); panel.className = "gis-overview-panel"; panel.hidden = true;
  const svg = doc.createElementNS(ns, "svg"); svg.setAttribute("viewBox", "0 0 240 140"); svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Geographic overview: resident Layers and current map extent");
  const help = doc.createElement("p"); help.textContent = "Select a position to recenter, or use the direction buttons. Zoom and viewing angle stay unchanged.";
  const status = doc.createElement("p"); status.setAttribute("role", "status");
  const directions = doc.createElement("div"); directions.className = "gis-overview-directions";
  const frame = doc.createElement("div"); frame.className = "gis-overview-frame";
  const underlay = doc.createElement("div"); underlay.className = "gis-overview-map";
  frame.append(underlay,svg); panel.append(frame, directions, help, status); element.append(toggle, panel);
  const ownerMap = getMap();
  let disposed = false, active = null, expanded = false, pointer = null, extent = null;
  let child = null, childKey = null, childCamera = null, failedKey = null, generation = 0;
  let childListeners = [];
  const releaseChild = () => {
    generation++; const old = child; child = null; childKey = null; childCamera = null;
    for (const [type,listener] of childListeners) old?.off?.(type,listener);
    childListeners = [];
    if (old) try {disposeMap?.(old);} catch { /* Never affect the main renderer. */ }
    underlay.replaceChildren(); frame.dataset.mapped = "false";
  };
  const available = value => {for (const button of directions.querySelectorAll("button")) button.disabled = !value; svg.setAttribute("aria-disabled",String(!value));};
  const unavailable = message => {releaseChild(); extent = null; svg.replaceChildren(); available(false); status.textContent = message;};
  const current = () => !disposed && expanded && active && getMap() === active;
  const wrap = x => ((x + 180) % 360 + 360) % 360 - 180;
  const node = (name, attrs) => {const n = doc.createElementNS(ns, name); for (const [k,v] of Object.entries(attrs)) n.setAttribute(k, String(v)); return n;};
  const position = () => {const p = active?.getCenter?.(); return [p?.lng ?? p?.[0], p?.lat ?? p?.[1]];};
  const mapped = style => {
    if (!createMap || !disposeMap || !style) {releaseChild(); return false;}
    const key = JSON.stringify(style);
    if (failedKey === key) return false;
    if (childKey !== key) {
      releaseChild();
      if (!element.isConnected) return false;
      const token = generation;
      try {
        const map = createMap({container: underlay, style, center: position(), zoom: Math.max(0, (active.getZoom?.() ?? 2) - 2),
          pitch: 0, bearing: 0, interactive: false, attributionControl: {compact: false}});
        if (!current() || token !== generation) {disposeMap(map); return false;}
        child = map; childKey = key; frame.dataset.mapped = "true";
        const refresh = () => {if (current() && child === map && token === generation) update();};
        const error = () => {if (!current() || child !== map || token !== generation) return;
          failedKey = key; releaseChild(); update(); status.textContent = "Mapped Overview unavailable. Close and reopen Overview to retry; the main map is unchanged.";};
        childListeners = [["load",refresh],["moveend",refresh],["error",error]];
        for (const [type,listener] of childListeners) map.on?.(type,listener);
      } catch {failedKey = key; releaseChild(); return false;}
    }
    return Boolean(child);
  };
  const move = center => {
    if (!current() || !center.every(Number.isFinite)) return;
    active.stop?.(); active.easeTo({center: [wrap(center[0]), Math.max(-85, Math.min(85, center[1]))], duration: 0});
    update();
  };
  for (const [label,dx,dy] of [["north",0,1],["west",-1,0],["east",1,0],["south",0,-1]]) {
    const button = doc.createElement("button"); button.type = "button"; button.textContent = label;
    button.setAttribute("aria-label", `Pan main map ${label}`);
    button.addEventListener("click", () => {if (!current() || !extent) return; const c = position(); move([c[0]+dx*(extent[2]-extent[0])/8,c[1]+dy*(extent[3]-extent[1])/8]);});
    directions.append(button);
  }
  function update() {
    if (!current()) return;
    const center = position(), bounds = active.getBounds?.();
    if (!center.every(Number.isFinite) || !bounds) {unavailable("Overview unavailable: this renderer does not expose a geographic extent."); return;}
    let west = bounds.getWest(), east = bounds.getEast(), south = bounds.getSouth(), north = bounds.getNorth();
    if (![west,east,south,north].every(Number.isFinite) || north < south) {unavailable("Overview unavailable: invalid geographic extent."); return;}
    while (east < west) east += 360;
    const near = x => x + 360*Math.round((center[0]-x)/360);
    const middle = (west+east)/2, shift = near(middle)-middle; west += shift; east += shift;
    available(true);
    const paths = []; let count = 0, visitedCoordinates = 0, visitedEntries = 0, limited = false;
    const spend = () => {if (visitedEntries >= 10000) {limited = true; return false;} visitedEntries++; return true;};
    // Spend before indexing, including invalid coordinates and empty/malformed
    // shapes. Rendering-valid positions alone must never be the loop budget.
    const each = (values, visit) => {
      if (!Array.isArray(values)) return;
      for (let i = 0; i < values.length; i++) {if (!spend()) break; visit(values[i]);}
    };
    const line = coordinates => {
      const pts = [];
      each(coordinates, p => {
        if (visitedCoordinates >= 10000) {limited = true; return;}
        visitedCoordinates++;
        if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90) {pts.push([near(p[0]),p[1]]); count++;}
      });
      if (pts.length) paths.push({points: pts});
    };
    const geometry = (g, depth = 0) => {
      if (!spend() || !g || typeof g !== "object" || depth > 8) return;
      if (g.type === "GeometryCollection") {each(g.geometries, x => geometry(x,depth+1)); return;}
      if (g.type === "Point") line([g.coordinates]);
      else if (g.type === "MultiPoint") each(g.coordinates, p => line([p]));
      else if (g.type === "LineString") line(g.coordinates);
      else if (["MultiLineString","Polygon"].includes(g.type)) each(g.coordinates,line);
      else if (g.type === "MultiPolygon") each(g.coordinates, polygon => each(polygon,line));
    };
    each(getGeography(), collection => {
      if (collection?.type === "FeatureCollection") each(collection.features, f => geometry(f?.geometry));
      else geometry(collection?.type === "Feature" ? collection.geometry : collection);
    });
    let x0 = west, x1 = east, y0 = south, y1 = north;
    for (const {points} of paths) for (const [x,y] of points) {x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);}
    const width = Math.max(.01,x1-x0), height = Math.max(.01,y1-y0);
    extent = [Math.max(center[0]-180,x0-width*.3),Math.max(-90,y0-height*.3),Math.min(center[0]+180,x1+width*.3),Math.min(90,y1+height*.3)];
    let mapContext = false;
    const style = overviewStyle(active);
    const mappedBackdrop = style && Object.values(style.sources).some(source => ["image","raster","vector"].includes(source.type));
    if (count && !mappedBackdrop) {releaseChild(); failedKey = null;}
    else mapContext = mapped(style);
    if (mapContext) {
      const cameraKey = JSON.stringify([west,east,south,north,frame.clientWidth,frame.clientHeight]);
      if (cameraKey !== childCamera) {
        childCamera = cameraKey; child.resize?.();
        const dx=Math.max(.01,east-west),dy=Math.max(.01,north-south);
        child.fitBounds([[west-dx*.6,Math.max(-85,south-dy*.6)],[east+dx*.6,Math.min(85,north+dy*.6)]],
          {padding:8,duration:0,bearing:0,pitch:0});
      }
    }
    const dimensions = () => ({width: frame.getBoundingClientRect().width || 240,height: frame.getBoundingClientRect().height || 140});
    const projected = (lon,lat) => {const point=child.project([lon,lat]),size=dimensions();return [point.x/size.width*240,point.y/size.height*140];};
    const x = lon => mapContext ? projected(lon,0)[0] : 8+(lon-extent[0])/(extent[2]-extent[0])*224;
    const y = lat => mapContext ? projected(center[0],lat)[1] : 132-(lat-extent[1])/(extent[3]-extent[1])*124;
    svg.replaceChildren(...(mapContext ? [] : [node("rect",{x:0,y:0,width:240,height:140,class:"gis-overview-water"})]));
    for (let j=1;j<4;j++) {
      const gx=extent[0]+(extent[2]-extent[0])*j/4, gy=extent[1]+(extent[3]-extent[1])*j/4;
      svg.append(node("path",{d:`M${x(gx)} 8V132M8 ${y(gy)}H232`,class:"gis-overview-grid"}));
    }
    for (const {points} of paths) {
      if (points.length===1) svg.append(node("circle",{cx:x(points[0][0]),cy:y(points[0][1]),r:2,fill:"#234e38",class:"gis-overview-feature"}));
      else svg.append(node("path",{d:points.map((p,i)=>`${i?'L':'M'}${x(p[0])},${y(p[1])}`).join(""),class:"gis-overview-feature",fill: "none"}));
    }
    svg.append(node("rect",{x:x(west),y:y(north),width:Math.max(1,x(east)-x(west)),height:Math.max(1,y(south)-y(north)),class:"gis-overview-extent"}));
    status.textContent = `${mapContext ? "Current authorized map sources; wider geographic context" : failedKey ? "Mapped Overview unavailable; close and reopen to retry" : count ? "Resident Layer geography" : "Coordinate locator only; mapped reference unavailable"}. View ${wrap(west).toFixed(2)}° to ${wrap(east).toFixed(2)}°, ${south.toFixed(2)}° to ${north.toFixed(2)}°.${limited ? " Display limited to 10,000 coordinate/geometry entries." : ""}`;
  }
  const stop = () => {if (pointer !== null && svg.hasPointerCapture?.(pointer)) svg.releasePointerCapture(pointer); pointer = null; releaseChild(); if (active) {active.off?.("moveend", update); active.off?.("resize", update); active.off?.("styledata", update);} active = null; extent = null;};
  function setOpen(value, focus = false) {
    stop(); expanded = Boolean(value) && !disposed; panel.hidden = !expanded; toggle.setAttribute("aria-expanded",String(expanded));
    if (expanded) {active = getMap(); active?.on?.("moveend",update); active?.on?.("resize",update); active?.on?.("styledata",update); failedKey = null; update(); if (!active) unavailable("Overview unavailable until the map is ready.");}
    onOpenChange(expanded); if (focus) toggle.focus();
  }
  toggle.setAttribute("aria-expanded","false"); toggle.addEventListener("click",()=>setOpen(!expanded));
  panel.addEventListener("keydown",event=>{if(event.key==="Escape"){event.preventDefault();setOpen(false,true);}});
  svg.addEventListener("pointerdown",event=>{if (!current() || event.button!==0 || event.isPrimary===false) return; event.preventDefault(); pointer=event.pointerId; svg.setPointerCapture?.(pointer);});
  svg.addEventListener("pointerup",event=>{
    if (pointer===null || pointer!==event.pointerId || !current() || !extent) return;
    const id=pointer; pointer=null; const rect=svg.getBoundingClientRect();
    if (rect.width>0 && rect.height>0) {const px=Math.max(8,Math.min(232,(event.clientX-rect.left)/rect.width*240)); const py=Math.max(8,Math.min(132,(event.clientY-rect.top)/rect.height*140));if (child) {const size=frame.getBoundingClientRect(); const p=child.unproject([(px/240)*(size.width||240),(py/140)*(size.height||140)]);move([p.lng,p.lat]);}
      else move([extent[0]+(px-8)/224*(extent[2]-extent[0]),extent[3]-(py-8)/124*(extent[3]-extent[1])]);}
    if(svg.hasPointerCapture?.(id))svg.releasePointerCapture(id);
  });
  for (const type of ["pointercancel","lostpointercapture"]) svg.addEventListener(type,()=>{pointer=null;});
  const dispose=()=>{if(disposed)return;disposed=true;stop();panel.hidden=true;toggle.disabled=true;};
  available(false);
  if (open) setOpen(true);
  return {element,dispose,update,isCurrentMap: () => !disposed && getMap() === ownerMap};
}
