export function MeasurementAnnotation(element) {
  const annotation = document.createElement("div");
  annotation.className = "layout-measurement";

  annotation.innerHTML = `<svg viewBox="0 0 240 72" preserveAspectRatio="none">
    <path d="M18 52 C72 12 150 24 222 18" fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="8 6"></path>
    <circle cx="18" cy="52" r="5" fill="currentColor"></circle>
    <circle cx="222" cy="18" r="5" fill="currentColor"></circle>
  </svg>`;

  const label = document.createElement("span");
  label.textContent = element.label ?? "Measurement annotation";
  annotation.append(label);

  return annotation;
}
