/** Controls belong to this deliberately activated Canvas map, never a shared Project. */
export async function createOpenLayersCanvasControls({map, host, sdk}) {
  const {Zoom, ScaleLine, OverviewMap, VectorLayer} = sdk;
  const document = host.ownerDocument;
  const styles = document.createElement('style');
  styles.textContent = `
    .opengeo-canvas-map .ol-control{position:absolute;background:#fff;color:#172033;padding:2px;border-radius:4px;pointer-events:auto}
    .opengeo-canvas-map .ol-control button,.opengeo-canvas-map .canvas-attribution summary{box-sizing:border-box;min-width:44px;min-height:44px;cursor:pointer;background:#fff;color:#172033;border:1px solid #52647a;border-radius:3px;font:14px system-ui}
    .opengeo-canvas-map .ol-control button:focus-visible,.opengeo-canvas-map .canvas-attribution summary:focus-visible,.opengeo-canvas-map .ol-overviewmap-map:focus-visible,.opengeo-canvas-map .ol-scale-line:focus-visible{outline:3px solid #075fe4;outline-offset:2px}
    .opengeo-canvas-map .ol-zoom{top:8px;left:8px;display:grid;gap:2px}
    .opengeo-canvas-map .ol-scale-line{position:absolute;left:64px;bottom:8px;background:#fff;color:#172033;padding:4px;pointer-events:auto;font:12px system-ui}
    .opengeo-canvas-map .ol-scale-line-inner{border:1px solid currentColor;border-top:0;text-align:center;padding:2px}
    .opengeo-canvas-map .ol-overviewmap{left:8px;bottom:8px}
    .opengeo-canvas-map .ol-overviewmap-map{width:160px;height:160px;border:1px solid #52647a;background:#e6edf4;touch-action:none}
    .opengeo-canvas-map .ol-overviewmap.ol-collapsed .ol-overviewmap-map{display:none}
    .opengeo-canvas-map .ol-overviewmap-box{border:2px dashed #075fe4;background:rgba(7,95,228,.12);box-sizing:border-box;cursor:move}
    .opengeo-canvas-map .canvas-attribution{position:absolute;right:8px;bottom:8px;max-width:calc(100% - 80px);background:#fff;color:#172033;padding:2px;pointer-events:auto;font:12px system-ui}
    .opengeo-canvas-map .canvas-attribution summary{padding:10px;display:list-item;list-style-position:inside}
    .opengeo-canvas-map .canvas-attribution p{max-width:220px;max-height:90px;overflow:auto;margin:4px;overflow-wrap:anywhere}
    @media(prefers-color-scheme:dark){.opengeo-canvas-map .ol-control,.opengeo-canvas-map .ol-control button,.opengeo-canvas-map .ol-scale-line,.opengeo-canvas-map .canvas-attribution,.opengeo-canvas-map .canvas-attribution summary{background:#172033;color:#f1f5f9}.opengeo-canvas-map .ol-overviewmap-map{background:#334155}}
  `;
  host.append(styles);
  const zoom = new Zoom({duration: 0});
  const scale = new ScaleLine({units: 'metric', minWidth: 70});
  const overview = new OverviewMap({collapsed: true, collapsible: true, tipLabel: 'Overview map',
    label: '⌖', collapseLabel: '×', layers: []});
  const controls = [zoom, scale, overview];
  controls.forEach(control => map.addControl(control));
  zoom.element.querySelector('.ol-zoom-in').setAttribute('aria-label', 'Zoom in');
  zoom.element.querySelector('.ol-zoom-out').setAttribute('aria-label', 'Zoom out');
  scale.element.tabIndex = 0;
  scale.element.setAttribute('role', 'img');
  const nativeOverview = overview.getOverviewMap();
  const overviewTarget = overview.element.querySelector('.ol-overviewmap-map');
  overviewTarget.tabIndex = 0;
  overviewTarget.setAttribute('role', 'region');
  overviewTarget.setAttribute('aria-label', 'Loaded Layer overview. Use arrow keys to recenter the map.');
  const overviewButton = overview.element.querySelector('button');
  const updateDisclosure = () => {
    overviewButton.setAttribute('aria-label', overview.getCollapsed() ? 'Show overview map' : 'Hide overview map');
    overviewButton.setAttribute('aria-expanded', String(!overview.getCollapsed()));
    scale.element.style.bottom = overview.getCollapsed() ? '8px' : '224px';
  };
  overviewButton.addEventListener('click', updateDisclosure);
  updateDisclosure();
  const onOverviewKey = event => {
    const direction = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1]}[event.key];
    if (!direction || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault(); event.stopPropagation();
    const center = map.getView().getCenter();
    const step = nativeOverview.getView().getResolution() * 12;
    map.getView().setCenter([center[0] + direction[0] * step, center[1] + direction[1] * step]);
  };
  overviewTarget.addEventListener('keydown', onOverviewKey);
  const attribution = document.createElement('details');
  attribution.className = 'canvas-attribution';
  const summary = document.createElement('summary'); summary.textContent = 'Map attribution';
  const credit = document.createElement('p'); credit.setAttribute('aria-label', 'Source credits');
  attribution.append(summary, credit); map.getOverlayContainerStopEvent().append(attribution);
  const onRender = () => {
    const text = scale.element.textContent.trim();
    scale.element.setAttribute('aria-label', text ? `Map scale: ${text}` : 'Map scale unavailable');
  };
  map.on('postrender', onRender);
  let overviewLayers = [], closed = false;
  function updateLayers(layers = []) {
    for (const layer of overviewLayers) {nativeOverview.removeLayer(layer); layer.dispose();}
    overviewLayers = layers.map(layer => new VectorLayer({source: layer.getSource(), style: layer.getStyle(),
      visible: layer.getVisible(), opacity: layer.getOpacity(), zIndex: layer.getZIndex()}));
    overviewLayers.forEach(layer => nativeOverview.addLayer(layer));
  }
  return {
    updateLayers,
    setAttribution(values) {credit.textContent = values.join(' · '); attribution.hidden = !credit.textContent;},
    dispose() {
      if (closed) return;
      closed = true; updateLayers(); map.un('postrender', onRender);
      overviewTarget.removeEventListener('keydown', onOverviewKey);
      overviewButton.removeEventListener('click', updateDisclosure);
      controls.forEach(control => map.removeControl(control));
      nativeOverview.setTarget(undefined); nativeOverview.dispose();
      controls.forEach(control => control.dispose());
      attribution.remove(); styles.remove();
    }
  };
}
