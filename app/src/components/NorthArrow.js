export function NorthArrow(element) {
  const arrow = document.createElement("div");
  arrow.className = "layout-north-arrow";
  arrow.style.rotate = `${element.rotation ?? 0}deg`;
  arrow.innerHTML = `<svg viewBox="0 0 64 96" role="img" aria-label="North arrow">
    <path d="M32 4 56 76 32 62 8 76Z" fill="currentColor"></path>
    <path d="M32 20v42" stroke="var(--theme-background)" stroke-width="5" stroke-linecap="round"></path>
    <text x="32" y="94" text-anchor="middle" font-size="18" font-family="system-ui">N</text>
  </svg>`;
  return arrow;
}
