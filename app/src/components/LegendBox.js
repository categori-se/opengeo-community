export function LegendBox(element, context) {
  const box = document.createElement("div");
  box.className = "layout-legend";

  const title = document.createElement("strong");
  title.textContent = element.mode === "manual" ? "Legend" : "Auto legend";
  box.append(title);

  for (const layerId of element.layers ?? []) {
    const layer = context.layerById.get(layerId);
    if (!layer) continue;

    const item = document.createElement("div");
    item.className = "legend-item";

    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.background = layer.style?.fill ?? layer.style?.circleColor ?? "transparent";
    swatch.style.borderColor = layer.style?.stroke ?? layer.style?.circleColor ?? "currentColor";

    const label = document.createElement("span");
    label.textContent = layer.title;

    item.append(swatch, label);
    box.append(item);
  }

  return box;
}
