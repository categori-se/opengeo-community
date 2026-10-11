export function RadialLegend(element, context) {
  const box = LegendBox(element, context);
  box.classList.add("layout-legend-radial");
  return box;
}

function LegendBox(element, context) {
  const box = document.createElement("div");
  box.className = "layout-legend";
  box.append(Object.assign(document.createElement("strong"), {textContent: "Radial legend"}));

  for (const layerId of element.layers ?? []) {
    const layer = context.layerById.get(layerId);
    if (!layer) continue;
    const item = document.createElement("span");
    item.className = "radial-legend-node";
    item.textContent = layer.title;
    box.append(item);
  }

  return box;
}
