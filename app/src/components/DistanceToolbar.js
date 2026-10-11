export function DistanceToolbar({layout}) {
  const annotations = (layout?.elements ?? []).filter((element) => element.type === "measurement_annotation");
  const toolbar = document.createElement("div");
  toolbar.className = "distance-toolbar";

  const title = document.createElement("strong");
  title.textContent = "Measurement tools";

  const summary = document.createElement("span");
  summary.textContent = `${annotations.length} layout annotation${annotations.length === 1 ? "" : "s"}`;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "print-button secondary";
  button.textContent = "Add annotation";
  button.disabled = true;
  button.title = "Prototype placeholder: annotations are saved as layout elements, not dataset edits.";

  toolbar.append(title, summary, button);
  return toolbar;
}
