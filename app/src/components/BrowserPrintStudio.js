import {ProjectPrintEditor} from "./ProjectPrintEditor.js";
import {definitionForPrintFrame, projectPrintLayouts} from "../lib/printLayouts.js";

// The snapshot contains local data, never an account identifier or a server save target.
export function BrowserPrintStudio({definition, projectId, name, createWorkbench, saveDefinition, onClose = () => {}}) {
  const returnFocus = document.activeElement;
  let record = {id: projectId, projectId, name, version: 1, definition: structuredClone(definition)};
  const layouts = projectPrintLayouts(record);
  const dialog = document.createElement("dialog");
  dialog.className = "browser-print-studio";
  dialog.setAttribute("aria-label", "Local Print Studio");
  const back = document.createElement("button");back.type = "button";back.className = "print-button secondary";back.textContent = "Back to map";
  let workbench, finished = false;
  const disposeWorkbench = () => {
    const previous = workbench;workbench = null;
    try {previous?.dispose?.();} catch {}
  };
  const editFrame = frame => {
    disposeWorkbench();
    workbench = createWorkbench(frame ? definitionForPrintFrame(record, frame) : structuredClone(record.definition));
    return workbench;
  };
  const state = {selectedMap: record, project: {id: projectId}, adapter: {
    updateMap: async (scope, id, {expectedVersion, changes}) => {
      if (!dialog.isConnected || scope !== projectId || id !== projectId || expectedVersion !== record.version) {
        throw Object.assign(Error("The local Print snapshot changed."), {status: 409});
      }
      const definition = structuredClone(changes.definition);
      projectPrintLayouts({...record, definition});
      await saveDefinition(definition);
      record = {...record, definition, version: record.version + 1};
      return structuredClone(record);
    }
  }};
  const editor = ProjectPrintEditor({state, workbench: editFrame(layouts.layouts[0]?.frames[0]), editFrame, canSave: true, persistence: "browser"});
  const finish = notify => {
    if (finished) return;
    finished = true;
    try {editor.dispose?.();} catch {}
    disposeWorkbench();
    try {dialog.close?.();} catch {}
    dialog.remove();
    try {if (notify) onClose();}
    finally {if (returnFocus?.isConnected && !returnFocus.closest?.("[hidden],[inert]")) returnFocus.focus?.({preventScroll: true});}
  };
  const close = () => {
    editor.cancelCapture?.();
    if (editor.shouldBlockNavigation?.()) {editor.checkDraft();return;}
    finish(true);
  };
  back.onclick = close;
  dialog.addEventListener("cancel", event => {event.preventDefault();close();});
  dialog.dispose = () => finish(false);
  dialog.append(back, editor);
  return dialog;
}
