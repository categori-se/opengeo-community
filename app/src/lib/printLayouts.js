export const standardPageSizes = [
  {size: "Letter", orientation: "portrait", widthMm: 216, heightMm: 279},
  {size: "Letter", orientation: "landscape", widthMm: 279, heightMm: 216},
  {size: "Legal", orientation: "portrait", widthMm: 216, heightMm: 356},
  {size: "Legal", orientation: "landscape", widthMm: 356, heightMm: 216},
  {size: "Tabloid", orientation: "portrait", widthMm: 279, heightMm: 432},
  {size: "Tabloid", orientation: "landscape", widthMm: 432, heightMm: 279},
  {size: "A4", orientation: "portrait", widthMm: 210, heightMm: 297},
  {size: "A4", orientation: "landscape", widthMm: 297, heightMm: 210},
  {size: "A3", orientation: "portrait", widthMm: 297, heightMm: 420},
  {size: "A3", orientation: "landscape", widthMm: 420, heightMm: 297},
  {size: "A2", orientation: "landscape", widthMm: 594, heightMm: 420},
  {size: "A1", orientation: "landscape", widthMm: 841, heightMm: 594},
  {size: "A0", orientation: "landscape", widthMm: 1189, heightMm: 841},
  {size: "Custom", orientation: "landscape", widthMm: 297, heightMm: 210}
];

export function layoutById(layouts, layoutId) {
  return layouts.find((layout) => layout.layoutId === layoutId) ?? null;
}

export function elementsByType(layout, type) {
  return (layout?.elements ?? []).filter((element) => element.type === type);
}

export function layoutLayers(layout, layers) {
  const layerIds = new Set(elementsByType(layout, "map_frame").flatMap((element) => element.layers ?? []));
  return layers.filter((layer) => layerIds.has(layer.layerId));
}

export function exportsForLayout(exports, layoutId) {
  return exports.filter((record) => record.layoutId === layoutId);
}

export function pageLabel({pageSize, orientation}) {
  return `${pageSize} ${orientation}`;
}

export function elementStyle(element) {
  return [
    `left:${element.xMm}mm`,
    `top:${element.yMm}mm`,
    `width:${element.widthMm}mm`,
    `height:${element.heightMm}mm`
  ].join(";");
}

export function mmToPx(mm, dpi = 96) {
  return Math.max(1, Math.round((mm / 25.4) * dpi));
}
