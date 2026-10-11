// Each view owns its DOM and pending reads. Switching never repurposes an
// editor's container, so late responses cannot replace another view's draft.
export function DatasetInspectionPanels({datasetId, datasetName}) {
  const element = document.createElement("div");
  element.className = "project-dataset-version-panel";
  element.hidden = true;
  const views = new Map();
  let active = null;

  function select(key) {
    active = key;
    element.hidden = key === null;
    for (const [name, view] of views) {
      view.wrapper.hidden = name !== key;
      view.button.setAttribute("aria-expanded", String(name === key));
      if (name === key) {
        for (const canvas of view.content.querySelectorAll(".project-feature-canvas, .map-frame")) {
          canvas.__resize?.();
        }
      }
    }
  }

  async function load(view, options) {
    view.started = true;
    view.wrapper.setAttribute("aria-busy", "true");
    view.reload.disabled = true;
    try {
      await view.load(view.content, options);
    } catch {
      const error = document.createElement("p");
      error.className = "project-catalog-error";
      error.textContent = "This view could not be loaded. Reload to try again.";
      view.content.hidden = false;
      view.content.replaceChildren(error);
    } finally {
      view.wrapper.setAttribute("aria-busy", "false");
      view.reload.disabled = false;
      view.button.disabled = false;
    }
  }

  function open(key, options = {}) {
    const view = views.get(key);
    if (!view) throw new Error("Unknown dataset view");
    select(key);
    if (!view.started) return load(view, options);
  }

  function bind(key, button, loader, {editable = false} = {}) {
    const wrapper = document.createElement("section");
    wrapper.id = `dataset-${datasetId}-view-${key}`;
    wrapper.className = "project-dataset-inspection-view";
    wrapper.hidden = true;
    wrapper.setAttribute("aria-label", `${datasetName}: ${button.textContent}`);
    const header = document.createElement("div");
    header.className = "project-dataset-inspection-controls";
    const note = document.createElement("span");
    note.textContent = editable
      ? "Keep this draft while switching views. Save before leaving Data."
      : "Loaded on demand. Reload for the latest information.";
    const reload = document.createElement("button");
    reload.type = "button";
    reload.className = "platform-button secondary";
    reload.textContent = "Reload view";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "platform-button secondary";
    close.textContent = "Hide view";
    close.addEventListener("click", () => {
      select(null);
      button.focus();
    });
    let content = document.createElement("div");
    content.hidden = true;
    const view = {wrapper, content, button, reload, load: loader, started: false};
    views.set(key, view);
    header.append(note, reload, close);
    wrapper.append(header, content);
    element.append(wrapper);
    button.setAttribute("aria-controls", wrapper.id);
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", () => {
      if (active === key) select(null);
      else void open(key);
    });
    reload.addEventListener("click", () => {
      if (editable && !element.ownerDocument.defaultView.confirm(
        "Reload this view? Any unsaved changes in it will be discarded."
      )) return;
      // New reads get a new target; an earlier pending save cannot overwrite it.
      for (const canvas of content.querySelectorAll(".project-feature-canvas")) canvas.__destroy?.();
      const replacement = document.createElement("div");
      replacement.hidden = true;
      content.replaceWith(replacement);
      content = replacement;
      view.content = replacement;
      void load(view, {});
    });
  }

  return {element, bind, open};
}
