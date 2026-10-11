import {inspectNotebookImport} from './ObservableNotebookPreview.js';

/** Inspect source on demand. The report never evaluates cells or changes files. */
export function NotebookImportReview({getSource, inspect = inspectNotebookImport}) {
  const element = document.createElement('details');
  element.className = 'notebook-import-review';
  element.hidden = true;
  const summary = document.createElement('summary'); summary.textContent = 'Notebook import review';
  const review = document.createElement('button'); review.type = 'button'; review.textContent = 'Review notebook import';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const report = document.createElement('div');
  element.append(summary, review, status, report);
  let generation = 0;
  const selected = () => {
    const value = getSource();
    return value && (/\.ipynb$/i.test(value.path)
      || /\.html?$/i.test(value.path) && /<notebook(?:\s|>)/i.test(value.source)) ? value : null;
  };
  const same = (a, b) => a && b && a.path === b.path && a.source === b.source
    && JSON.stringify(a.availablePaths) === JSON.stringify(b.availablePaths);
  function update() {
    generation++;
    element.hidden = !selected();
    review.disabled = element.hidden;
    status.textContent = 'Review this notebook before saving. Inspection preserves every source file and does not run cells.';
    report.replaceChildren();
  }
  function section(title, values, empty = 'None found by this inspection.') {
    const heading = document.createElement('h5'); heading.textContent = title;
    const list = document.createElement('ul');
    for (const value of values.length ? values : [empty]) {
      const row = document.createElement('li'); row.textContent = value; list.append(row);
    }
    report.append(heading, list);
  }
  review.addEventListener('click', async () => {
    const source = selected();
    if (!source || review.disabled) return;
    const token = ++generation;
    const current = () => element.isConnected && token === generation && same(source, selected());
    review.disabled = true;
    status.textContent = 'Inspecting notebook source…'; report.replaceChildren();
    try {
      const result = await inspect(source);
      if (!current()) return;
      status.textContent = `${source.path} · ${result.cellCount} cells. Source files remain unchanged.`;
      section('Cells', result.cells.map(cell => `${cell.id} · ${cell.mode}`));
      section('Module imports', result.modules.map(module => `${module.name} · ${module.supportNote ?? (module.bundled ? 'bundled' : 'not bundled')} · cells ${module.cellIds.join(', ')}`), result.moduleInspection);
      section('Attachment references', result.attachments.map(file => `${file.name} · ${file.available
        ? file.storage === 'embedded' ? 'stored in this notebook' : 'path present in selected sources or archive bindings'
        : file.available === null ? 'reference unsupported; file presence not determined' : 'path missing or unsupported'} · cells ${file.cellIds.join(', ')}`));
      if (result.savedOutputs) section('Saved outputs', [
        `${result.savedOutputs.total} outputs: ${result.savedOutputs.supported} have a supported representation; ${result.savedOutputs.unsupported} need review.`,
        `${result.savedOutputs.codeCellsWithoutOutput} code cells have no saved output. Editing does not run a kernel.`
      ]);
      section('Possible external references', result.externalReferences.map(item => `${item.kind}: ${item.value} · cells ${item.cellIds.join(', ')}`));
      section('Unsupported content', result.unsupported.map(item => `Cell ${item.cellId}: ${item.message}`));
      section('Before publishing', result.manualWork, 'Review the saved build and source permissions before publishing.');
      section('Inspection limits', result.limitations);
      if (result.truncated) {
        const note = document.createElement('p'); note.textContent = 'The report lists at most 100 entries per category. Review the remaining source before publishing.'; report.append(note);
      }
    } catch (error) {
      if (current()) status.textContent = `Notebook inspection could not finish: ${error.message}. Source files remain unchanged.`;
    } finally {
      if (token === generation) {
        if (!same(source, selected())) update();
        else review.disabled = false;
      }
    }
  });
  return {element, update};
}
