import {ProjectPrintEditor} from "./ProjectPrintEditor.js";
import {definitionForPrintFrame, projectPrintLayouts} from "../lib/printLayouts.js";

// The snapshot contains local data, never an account identifier or a server save target.
export function BrowserPrintStudio({definition, projectId, name, createWorkbench, saveDefinition, onClose = () => {}}) {
  let record = {id: projectId, projectId, name, version: 1, definition: structuredClone(definition)};
  const layouts = projectPrintLayouts(record);
  const dialog = document.createElement("dialog");
  dialog.className = "browser-print-studio";
  dialog.setAttribute("aria-label", "Local Print Studio");
  const back = document.createElement("button");back.type = "button";back.className = "print-button secondary";back.textContent = "Back to map";
  let workbench;
  const editFrame = frame => {
    workbench?.dispose?.();
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
  const dispose = () => {editor.dispose?.();workbench?.dispose?.();};
  const close = () => {
    if (editor.shouldBlockNavigation?.()) {editor.checkDraft();return;}
    dispose();dialog.close?.();dialog.remove();onClose();
  };
  back.onclick = close;
  dialog.addEventListener("cancel", event => {event.preventDefault();close();});
  dialog.dispose = () => {dispose();dialog.close?.();dialog.remove();};
  dialog.append(back, editor);
  return dialog;
}
