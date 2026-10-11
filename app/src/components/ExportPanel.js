export function ExportPanel({layout, exports = []}) {
  const panel = document.createElement("div");
  panel.className = "export-panel";

  const title = document.createElement("strong");
  title.textContent = "Export";

  const print = document.createElement("button");
  print.type = "button";
  print.className = "print-button";
  print.textContent = "Print / Save PDF";
  print.addEventListener("click", () => window.print());

  const download = document.createElement("button");
  download.type = "button";
  download.className = "print-button secondary";
  download.textContent = "Download layout JSON";
  download.addEventListener("click", () => downloadLayout(layout));

  const history = document.createElement("small");
  history.textContent = exports.length
    ? `${exports.length} export record${exports.length === 1 ? "" : "s"} · classification ${exports[0].classification}`
    : "No export records yet.";

  panel.append(title, print, download, history);
  return panel;
}

function downloadLayout(layout) {
  const blob = new Blob([JSON.stringify(layout, null, 2)], {type: "application/json"});
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${layout.layoutId}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}
