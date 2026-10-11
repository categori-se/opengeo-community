import {patternSvg} from "../lib/cartographicPatterns.js";

// Consume only the resolver's verified recipe, never stored SVG or XML.
export function PatternLegend(resolved) {
  if (!resolved?.pattern) return null;
  const legend = document.createElement("div");
  legend.className = "gis-style-legend gis-pattern-legend";
  const title = document.createElement("strong");
  title.textContent = resolved.title || "Pattern Style";
  const row = document.createElement("span");
  const swatch = document.createElement("i");
  swatch.setAttribute("aria-hidden", "true");
  swatch.style.backgroundImage = `url("data:image/svg+xml,${encodeURIComponent(patternSvg(resolved.pattern))}")`;
  swatch.style.backgroundSize = `${resolved.pattern.size}px ${resolved.pattern.size}px`;
  const label = document.createElement("span");
  label.textContent = `${resolved.pattern.id} · Style version ${resolved.reference.versionNumber}`;
  row.append(swatch, label);
  legend.append(title, row);
  return legend;
}
