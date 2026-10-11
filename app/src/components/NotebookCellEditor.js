const MODES = ['js', 'ts', 'ojs', 'md', 'html', 'tex', 'dot', 'sql', 'sql.view', 'node', 'python', 'r'];
const JUPYTER_MODES = ['code', 'markdown', 'raw'];
const HISTORY_BYTES = 8 * 1024 * 1024;

/** Native Notebook and Jupyter cells edit the source buffer used by Files and Save. */
export function NotebookCellEditor({textarea, loadTools, onViewChange = () => {}}) {
  const document = textarea.ownerDocument;
  const node = (tag, text = '') => {const result = document.createElement(tag); result.textContent = text; return result;};
  const button = (text, action) => {const result = node('button', text); result.type = 'button'; result.addEventListener('click', action); return result;};
  const label = (text, control) => {const result = node('label'); result.append(node('span', text), control); return result;};
  const element = node('section'); element.className = 'notebook-cell-editor'; element.hidden = true;
  const workspace = node('div'); workspace.className = 'notebook-cell-workspace'; workspace.hidden = true;
  const status = node('p'); status.setAttribute('role', 'status');
  const jupyterNotice = node('p', 'Choose a type for new cells; use Source to change an existing cell’s type. Saved outputs are retained and may be stale after edits or duplication; cells are not run.');
  jupyterNotice.hidden = true;
  const cellsButton = button('Cells', () => void showCells());
  const sourceButton = button('Source', () => {
    epoch++; busy = false; show(false); reflect();
    status.textContent = 'Edit the original notebook source. Choose Cells to return to structured editing.';
  });
  const views = node('div'); views.className = 'notebook-cell-views'; views.append(cellsButton, sourceButton);
  const selection = node('select'); selection.setAttribute('aria-label', 'Notebook cell');
  const mode = node('select'); mode.setAttribute('aria-label', 'Cell language');
  for (const value of MODES) {const option = node('option', value); option.value = value; mode.append(option);}
  const body = node('textarea'); body.setAttribute('aria-label', 'Cell source'); body.rows = 10; body.spellcheck = false;
  const add = button('Add cell', () => mutate({action: 'insert', ...(selectedId === null ? {} : {id: selectedId}), mode: mode.value, value: ''}));
  const duplicate = button('Duplicate cell', () => mutate({action: 'duplicate', id: selectedId}));
  const up = button('Move cell up', () => mutate({action: 'move', id: selectedId, direction: 'up'}));
  const down = button('Move cell down', () => mutate({action: 'move', id: selectedId, direction: 'down'}));
  const remove = button('Remove cell', () => mutate({action: 'remove', id: selectedId}));
  const undo = button('Undo cell change', () => {
    if (!editable() || !history.length) return;
    const previous = history.at(-1);
    try {
      const parsed = tools.parseNotebookCells(previous.source);
      history.pop(); historyBytes -= previous.bytes;
      install(previous.source, parsed, previous.selectedId);
      if (!snapshot) return;
      render(); status.textContent = 'Cell change undone in the current draft.';
    } catch {status.textContent = 'This change could not be undone. Open Source to review the preserved notebook.';}
  });
  const moreActions = node('details'); moreActions.className = 'notebook-cell-more';
  moreActions.append(node('summary', 'Cell actions'), duplicate, up, down, remove);
  const actions = node('div'); actions.className = 'notebook-cell-actions'; actions.append(add, undo, moreActions);
  const modeLabel = label('Cell language', mode);
  workspace.append(label('Notebook cell', selection), modeLabel, label('Cell source', body), actions);
  element.append(views, status, jupyterNotice, workspace);
  let path = null, epoch = 0, disposed = false, busy = false, ownInput = false, cellsView = false;
  let tools, toolsPromise, snapshot = null, selectedId = null, history = [], historyBytes = 0;

  function show(value) {
    cellsView = value; workspace.hidden = !value;
    cellsButton.setAttribute('aria-pressed', String(value)); sourceButton.setAttribute('aria-pressed', String(!value));
    onViewChange(value);
  }
  function editable() {
    return !disposed && !busy && !element.hidden && cellsView && snapshot?.source === textarea.value
      && !textarea.disabled && !textarea.readOnly && !snapshot.parsed.readOnly;
  }
  const isJupyter = () => /\.ipynb$/i.test(path ?? '');
  function reflect() {
    cellsButton.disabled = busy || !path;
    const index = snapshot?.parsed.cells.findIndex(cell => cell.id === selectedId) ?? -1;
    const allowed = editable(), hasCell = index >= 0;
    selection.disabled = busy || !snapshot?.parsed.cells.length;
    body.disabled = !allowed || !hasCell || snapshot.parsed.cells[index].readOnly === true;
    mode.disabled = !allowed;
    add.disabled = !allowed;
    duplicate.disabled = !allowed || !hasCell;
    const cells = snapshot?.parsed.cells ?? [];
    remove.disabled = !allowed || !hasCell || cells[index].deletable === false;
    up.disabled = !allowed || index <= 0 || cells[index]?.movable === false || cells[index - 1]?.movable === false;
    down.disabled = !allowed || !hasCell || index === cells.length - 1 || cells[index]?.movable === false || cells[index + 1]?.movable === false;
    undo.disabled = !allowed || !history.length;
  }
  function render({keepBody = false} = {}) {
    const cells = snapshot?.parsed.cells ?? [];
    if (!cells.some(cell => cell.id === selectedId)) selectedId = cells[0]?.id ?? null;
    selection.replaceChildren(...cells.map((cell, index) => {
      const preview = cell.value.trim().split('\n')[0].slice(0, 60) || 'Empty cell';
      const option = node('option', `${index + 1}. ${cell.mode} · ${preview}`); option.value = String(cell.id); return option;
    }));
    selection.value = selectedId === null ? '' : String(selectedId);
    const cell = cells.find(item => item.id === selectedId);
    if (!keepBody) body.value = cell?.value ?? '';
    mode.value = cell?.mode ?? (isJupyter() ? 'code' : 'js');
    reflect();
  }
  function resetHistory() {history = []; historyBytes = 0;}
  function invalidated() {
    if (disposed || ownInput || !path) return;
    epoch++; busy = false; snapshot = null; resetHistory(); show(false); reflect();
    status.textContent = 'Source changed. Choose Cells to inspect the current notebook; earlier cell Undo history was cleared.';
  }
  textarea.addEventListener('input', invalidated);
  const observer = new document.defaultView.MutationObserver(reflect);
  observer.observe(textarea, {attributes: true, attributeFilter: ['disabled', 'readonly']});
  async function showCells() {
    if (disposed || !path || element.hidden) return;
    if (snapshot?.source === textarea.value) {show(true); render(); return;}
    const request = ++epoch, source = textarea.value, openingPath = path;
    busy = true; show(false); reflect(); status.textContent = 'Opening notebook cells…';
    try {
      toolsPromise ??= Promise.resolve().then(loadTools).catch(error => {toolsPromise = null; throw error;});
      const loaded = await toolsPromise;
      if (disposed || request !== epoch || openingPath !== path || source !== textarea.value || element.hidden) return;
      const selectedTools = /\.ipynb$/i.test(openingPath)
        ? {parseNotebookCells: loaded.parseJupyterCells, changeNotebookCell: loaded.changeJupyterCell} : loaded;
      const parsed = selectedTools.parseNotebookCells(source);
      tools = selectedTools; snapshot = {source, parsed}; busy = false; resetHistory();
      selectedId = parsed.cells[0]?.id ?? null; show(true); render();
      status.textContent = parsed.readOnly ? 'This notebook is marked read-only. Its cells can be inspected in Cells or Source.'
        : `${parsed.cells.length} cells. Changes stay in the current source draft; Save remains separate.`;
    } catch (error) {
      if (disposed || request !== epoch || openingPath !== path || source !== textarea.value || element.hidden) return;
      busy = false; snapshot = null; resetHistory(); show(false); reflect();
      status.textContent = `Cells are unavailable. The original source is preserved. ${error?.message ?? 'Open Source to continue editing.'}`;
    }
  }
  function install(source, parsed, nextId) {
    textarea.value = source;
    snapshot = {source: textarea.value, parsed}; selectedId = nextId;
    ownInput = true;
    try {textarea.dispatchEvent(new document.defaultView.Event('input', {bubbles: true}));}
    finally {ownInput = false;}
    if (textarea.value !== snapshot.source) invalidated();
  }
  function mutate(change) {
    if (!editable()) {reflect(); return;}
    try {
      const previous = snapshot.source;
      const next = tools.changeNotebookCell(previous, change);
      if (next === previous) return;
      const parsed = tools.parseNotebookCells(next);
      const oldIds = new Set(snapshot.parsed.cells.map(cell => cell.id));
      const index = snapshot.parsed.cells.findIndex(cell => cell.id === selectedId);
      let nextId = ['insert', 'duplicate'].includes(change.action)
        ? parsed.cells.find(cell => !oldIds.has(cell.id))?.id ?? selectedId
        : change.action === 'remove' ? parsed.cells[Math.min(index, parsed.cells.length - 1)]?.id ?? null : selectedId;
      if (isJupyter()) {
        if (['insert', 'duplicate'].includes(change.action)) nextId = index + 1;
        else if (change.action === 'move') nextId = index + (change.direction === 'up' ? -1 : 1);
      }
      const bytes = new TextEncoder().encode(previous).byteLength;
      history.push({source: previous, selectedId, bytes}); historyBytes += bytes;
      while (history.length > 10 || historyBytes > HISTORY_BYTES) historyBytes -= history.shift().bytes;
      install(next, parsed, nextId);
      if (!snapshot) return;
      render({keepBody: change.action === 'edit' && change.mode === undefined});
      status.textContent = 'Cell change retained in the current source draft.';
    } catch (error) {
      status.textContent = `Cell change was not applied. ${error?.message ?? 'Open Source to review the original notebook.'}`;
    }
  }
  selection.addEventListener('change', () => {selectedId = Number(selection.value); render();});
  body.addEventListener('input', () => mutate({action: 'edit', id: selectedId, value: body.value}));
  mode.addEventListener('change', () => {
    if (isJupyter()) {status.textContent = `The next added cell will use ${mode.value}. Existing cells are unchanged.`; return;}
    mutate({action: 'edit', id: selectedId, mode: mode.value});
  });
  function hide() {
    epoch++; path = null; busy = false; snapshot = null; selectedId = null; resetHistory();
    body.value = ''; selection.replaceChildren();
    element.hidden = true; show(false); reflect();
  }
  return {element,
    open(nextPath) {
      if (disposed) return;
      const jupyter = /\.ipynb$/i.test(nextPath ?? '');
      if (!jupyter && (!/\.html?$/i.test(nextPath ?? '') || !/<notebook(?:\s|>)/i.test(textarea.value))) {hide(); return;}
      if (path === nextPath && snapshot?.source === textarea.value && !element.hidden) {reflect(); return;}
      epoch++; path = nextPath; snapshot = null; selectedId = null; resetHistory(); element.hidden = false;
      jupyterNotice.hidden = !jupyter;
      const modeText = jupyter ? 'New cell type' : 'Cell language';
      mode.setAttribute('aria-label', modeText); modeLabel.querySelector('span').textContent = modeText;
      mode.replaceChildren(...(jupyter ? JUPYTER_MODES : MODES).map(value => {const option = node('option', value); option.value = value; return option;}));
      return showCells();
    },
    hide,
    dispose() {if (disposed) return; textarea.removeEventListener('input', invalidated); observer.disconnect(); hide(); disposed = true;}
  };
}
