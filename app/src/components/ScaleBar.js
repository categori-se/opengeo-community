export function ScaleBar(element) {
  const bar = document.createElement("div");
  bar.className = "layout-scale-bar";

  const rail = document.createElement("div");
  rail.className = "scale-rail";
  const segments = element.segments ?? 4;

  for (let index = 0; index < segments; index += 1) {
    const segment = document.createElement("span");
    segment.className = index % 2 ? "light" : "dark";
    rail.append(segment);
  }

  const label = document.createElement("small");
  label.textContent = `0 ${segments} ${element.units ?? "km"} · 1:${Number(element.scale ?? 50000).toLocaleString()}`;

  bar.append(rail, label);
  return bar;
}
