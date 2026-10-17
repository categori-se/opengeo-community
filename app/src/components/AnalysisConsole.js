import {loadCodeEditorRuntime} from './PublicationCodeEditor.js';
import {ANALYSIS_EXAMPLES, normalizeAnalysisResult,
  runBrowserAnalysis, snapshotAnalysisLayers, validateAnalysisSource} from '../lib/analysisConsole.js';

/** Explicit, in-memory analysis. Opening the console never contacts a runtime. */
export function AnalysisConsole({getLayers = () => [], runNative, getNativeCapabilities,
  runManaged, getManagedCapabilities, cancelManaged, hasPendingManagedRun = () => false,
  onResult = () => {}, onClose = () => {}, dark = false} = {}) {
  const node = (tag, className, text) => {
    const value = document.createElement(tag);if (className) value.className = className;
    if (text != null) value.textContent = text;return value;
  };
  const button = (text, handler) => {const value = node('button', '', text);value.type = 'button';value.onclick = handler;return value;};
  const select = (label, choices) => {
    const value = node('select');value.setAttribute('aria-label', label);
    for (const [key, title] of choices) {const option = node('option', '', title);option.value = key;value.append(option);}return value;
  };
  const element = node('section', 'gis-analysis-console');element.hidden = true;element.setAttribute('aria-label', 'Analysis console');
  const toolbar = node('div', 'gis-analysis-toolbar');toolbar.append(node('strong', '', 'Analysis console'));
  const language = select('Script language', [['javascript', 'JavaScript'], ['python', 'Python'], ['bash', 'Bash']]);
  const profile = select('Execution profile', [['browser', 'Browser'], ['local', 'Local'], ['managed', 'Managed']]);
  const runButton = button('Run', () => {void run();}), stopButton = button('Stop', () => cancel('Stopped.'));
  const closeButton = button('Close console', () => close());
  const checkButton = button('Check runtime', () => {void checkCapabilities();});
  toolbar.append(language, profile, runButton, stopButton, checkButton, closeButton);
  const body = node('div', 'gis-analysis-body'), inputs = node('fieldset', 'gis-analysis-inputs');
  inputs.append(node('legend', '', 'Input Layers'));
  const inputList = node('div', 'gis-analysis-input-list');inputs.append(inputList, node('p', 'gis-analysis-input-note', 'Select loaded vector data explicitly. Map visibility does not select inputs.'));
  const refreshButton = button('Refresh inputs', () => {if (!active) {refreshInputs();invalidate();updateControls();}});inputs.append(refreshButton);
  const workspace = node('div', 'gis-analysis-workspace'), editorHost = node('div', 'gis-analysis-editor');
  const textarea = node('textarea', 'gis-analysis-source');textarea.setAttribute('aria-label', 'Analysis script');textarea.spellcheck = false;
  const editorMount = node('div', 'gis-analysis-monaco');editorMount.hidden = true;editorMount.style.height = '100%';
  editorHost.append(textarea, editorMount);
  const actions = node('div', 'gis-analysis-script-actions');
  const exampleButton = button('Load example', () => {setCode(ANALYSIS_EXAMPLES[language.value]);invalidate();});
  const downloadButton = button('Download script', () => {
    const url = URL.createObjectURL(new Blob([getCode()], {type: 'text/plain;charset=utf-8'}));
    const anchor = node('a');anchor.href = url;anchor.download = 'analysis.' + ({javascript: 'js', python: 'py', bash: 'sh'}[language.value]);
    anchor.click();setTimeout(() => URL.revokeObjectURL(url), 0);
  });
  actions.append(exampleButton, downloadButton);
  const output = node('pre', 'gis-analysis-output');output.setAttribute('aria-label', 'Script output');output.setAttribute('aria-live', 'polite');
  const status = node('div', 'gis-analysis-status');status.setAttribute('role', 'status');
  const addButton = button('Add result to map', () => {void addResult();});addButton.hidden = true;
  const note = node('p', 'gis-analysis-runtime-note');
  workspace.append(actions, editorHost, output, status, addButton, note);body.append(inputs, workspace);element.append(toolbar, body);
  const buffers = new Map(Object.entries(ANALYSIS_EXAMPLES)), selected = new Set(), capabilities = new Map();
  let currentLanguage = language.value, active = null, activeProfile = null, ready = null, revision = 0, disposed = false, capabilityEpoch = 0;
  let view, model, kit, loadingEditor = false, observer, changing = false;
  const getCode = () => view ? model.getValue() : textarea.value;
  function setCode(code) {
    changing = true;textarea.value = code;model?.setValue(code);buffers.set(currentLanguage, code);changing = false;
  }
  function invalidate() {revision++;ready = null;addButton.hidden = true;}
  function cancel(message) {
    if (!active && hasPendingManagedRun() && typeof cancelManaged === 'function') {
      const controller = new AbortController();active = controller;activeProfile = 'managed';revision++;
      ready = null;addButton.hidden = true;status.textContent = 'Stopping managed run…';updateControls();
      Promise.resolve().then(() => cancelManaged()).then(() => {if (!disposed) status.textContent = 'Stopped.';})
        .catch(error => {if (!disposed) status.textContent = String(error?.message ?? 'Cancellation could not be confirmed.').slice(0, 2000);})
        .finally(() => {if (active === controller) {active = null;activeProfile = null;updateControls();}});
      return;
    }
    if (active) {
      active.abort();revision++;
      // Keep Run locked until the managed adapter confirms cancellation or
      // reports uncertainty. Aborting a browser request is not worker cleanup.
      if (activeProfile !== 'managed') active = null;
      else message = 'Stopping managed run…';
    }
    ready = null;addButton.hidden = true;if (message) status.textContent = message;updateControls();
  }
  function configured() {
    if (profile.value === 'browser') return language.value === 'javascript';
    const capability = capabilities.get(profile.value), runner = profile.value === 'local' ? runNative : runManaged;
    return typeof runner === 'function' && capability?.configured === true && capability.languages.includes(language.value);
  }
  function updateControls() {
    runButton.disabled = !!active || !configured();stopButton.disabled = !active && !hasPendingManagedRun();
    language.disabled = !!active;profile.disabled = !!active;exampleButton.disabled = !!active;
    checkButton.hidden = profile.value === 'browser';checkButton.disabled = !!active;
    refreshButton.disabled = !!active;
    textarea.readOnly = !!active;view?.updateOptions({readOnly: !!active});
    for (const checkbox of inputList.querySelectorAll('input')) checkbox.disabled = !!active || checkbox.dataset.loaded !== 'true';
    note.textContent = profile.value === 'browser'
      ? (language.value === 'javascript' ? 'Browser JavaScript · network disabled · 10 second limit. Browser memory is not hard limited.' : 'Python and Bash require a configured Local or Managed profile. You can edit and download this script.')
      : configured() ? `${profile.value === 'local' ? 'Local' : 'Managed'} execution · only selected input snapshots are provided.`
        : `Configure a ${profile.value === 'local' ? 'Local' : 'Managed'} profile supporting ${language.options[language.selectedIndex].textContent} to run this script.`;
  }
  function refreshInputs() {
    inputList.replaceChildren();let rows;
    try {rows = getLayers() ?? [];} catch {rows = [];}
    if (!Array.isArray(rows)) rows = [];
    const present = new Set();
    for (const row of rows) {
      if (typeof row?.id !== 'string') continue;present.add(row.id);
      const label = node('label'), checkbox = node('input');checkbox.type = 'checkbox';checkbox.value = row.id;
      checkbox.disabled = row.geojson?.type !== 'FeatureCollection';checkbox.checked = !checkbox.disabled && selected.has(row.id);
      checkbox.dataset.loaded = String(!checkbox.disabled);
      if (checkbox.disabled) selected.delete(row.id);
      checkbox.onchange = () => {checkbox.checked ? selected.add(row.id) : selected.delete(row.id);invalidate();};
      label.append(checkbox, document.createTextNode(String(row.title ?? row.id) + (checkbox.disabled ? ' (not loaded vector data)' : '')));inputList.append(label);
    }
    for (const id of selected) if (!present.has(id)) selected.delete(id);
    if (!present.size) inputList.append(node('p', '', 'No loaded Layers available.'));
  }
  async function checkCapabilities() {
    const chosen = profile.value;if (chosen === 'browser' || disposed) return;
    const epoch = ++capabilityEpoch, callback = chosen === 'local' ? getNativeCapabilities : getManagedCapabilities;
    status.textContent = 'Checking execution profile…';
    try {
      const value = typeof callback === 'function' ? await callback() : null;
      if (disposed || epoch !== capabilityEpoch) return;
      capabilities.set(chosen, {configured: value?.configured === true,
        languages: Array.isArray(value?.languages) ? value.languages.filter(item => ['javascript', 'python', 'bash'].includes(item)) : []});
      status.textContent = capabilities.get(chosen).configured ? 'Execution profile checked.' : 'Execution profile is not configured.';
    } catch {if (!disposed && epoch === capabilityEpoch) {capabilities.delete(chosen);status.textContent = 'Execution profile unavailable.';}}
    if (!disposed && epoch === capabilityEpoch) updateControls();
  }
  async function run() {
    if (disposed || active || !configured()) return;
    invalidate();const token = revision, chosen = profile.value, lang = language.value;
    const controller = new AbortController();active = controller;activeProfile = chosen;output.textContent = '';status.textContent = 'Running…';updateControls();
    try {
      const code = validateAnalysisSource(getCode());
      const rows = getLayers();
      const snapshot = snapshotAnalysisLayers((Array.isArray(rows) ? rows : []).filter(row => selected.has(row.id)));
      const result = chosen === 'browser'
        ? await runBrowserAnalysis({code, layers: snapshot.layers, signal: controller.signal,
          onLog: text => {if (revision === token && !controller.signal.aborted) output.textContent += text;}})
        : await (chosen === 'local' ? runNative : runManaged)({language: lang, code, layers: snapshot.layers, signal: controller.signal,
          ...(chosen === 'managed' ? {inputPins: snapshot.inputPins,
            onStatus: message => {if (!disposed && revision === token && !controller.signal.aborted) status.textContent = message;}} : {})});
      if (disposed || controller.signal.aborted || revision !== token) return;
      const normalized = normalizeAnalysisResult(result);
      output.textContent = normalized.stdout + (normalized.stderr ? '\n' + normalized.stderr : '');
      if (normalized.exitCode !== 0) {status.textContent = `Script exited with code ${normalized.exitCode}.`;return;}
      status.textContent = normalized.geojson ? `Finished · ${normalized.geojson.features.length} result features. Add the result to the map when ready.` : 'Finished · no GeoJSON result.';
      if (normalized.geojson) {
        ready = {geojson: normalized.geojson, language: lang, inputPins: snapshot.inputPins,
          execution: {...(normalized.execution && typeof normalized.execution === 'object' ? normalized.execution : {}), profile: chosen, language: lang}};
        addButton.hidden = false;
      }
    } catch (error) {
      if (!disposed && chosen === 'managed' && error?.cancellationUncertain) status.textContent = String(error.message).slice(0, 2000);
      else if (!disposed && chosen === 'managed' && (controller.signal.aborted || error?.name === 'AbortError')) status.textContent = 'Stopped.';
      else if (!disposed && revision === token && !controller.signal.aborted) status.textContent = String(error?.message ?? 'Script failed.').slice(0, 2000);
    } finally {if (active === controller) {active = null;activeProfile = null;updateControls();}}
  }
  async function addResult() {
    if (!ready || active || disposed) return;const result = ready;addButton.disabled = true;
    try {await onResult(structuredClone(result));if (ready === result) {ready = null;addButton.hidden = true;status.textContent = 'Result added to the map.';}}
    catch (error) {if (!disposed) status.textContent = String(error?.message ?? 'Unable to add the result.').slice(0, 2000);}
    finally {addButton.disabled = false;}
  }
  async function ensureEditor() {
    if (loadingEditor || kit || typeof ResizeObserver === 'undefined') return;loadingEditor = true;
    try {
      const module = await loadCodeEditorRuntime();if (disposed || element.hidden) return;kit = module.monaco ?? module;
      model = kit.editor.createModel(textarea.value, language.value === 'bash' ? 'shell' : language.value);
      editorMount.hidden = false;
      view = kit.editor.create(editorMount, {model, theme: dark ? 'vs-dark' : 'vs', minimap: {enabled: false},
        automaticLayout: false, fontSize: 13, scrollBeyondLastLine: false, ariaLabel: 'Analysis script'});
      textarea.hidden = true;model.onDidChangeContent(() => {if (!changing) {buffers.set(currentLanguage, model.getValue());invalidate();}});
      observer = new ResizeObserver(() => view?.layout());observer.observe(editorHost);view.layout();
    } catch {editorMount.hidden = true;textarea.hidden = false; /* Keep the plain editor usable. */ }
    finally {loadingEditor = false;}
  }
  language.onchange = () => {cancel();buffers.set(currentLanguage, getCode());currentLanguage = language.value;
    setCode(buffers.get(currentLanguage));if (kit && model) kit.editor.setModelLanguage(model, currentLanguage === 'bash' ? 'shell' : currentLanguage);updateControls();};
  profile.onchange = () => {cancel();capabilityEpoch++;updateControls();if (profile.value !== 'browser') void checkCapabilities();};
  textarea.oninput = () => {buffers.set(currentLanguage, textarea.value);invalidate();};
  element.addEventListener('keydown', event => {if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {event.preventDefault();void run();}});
  function open() {if (disposed) return;element.hidden = false;refreshInputs();updateControls();void ensureEditor();textarea.focus();}
  function close() {if (disposed) return;buffers.set(currentLanguage, getCode());capabilityEpoch++;cancel();element.hidden = true;onClose();}
  function setTheme(value) {dark = !!value;element.dataset.theme = dark ? 'dark' : 'light';kit?.editor.setTheme(dark ? 'vs-dark' : 'vs');}
  function dispose() {if (disposed) return;close();disposed = true;observer?.disconnect();view?.dispose();model?.dispose();element.remove();}
  setCode(buffers.get(currentLanguage));setTheme(dark);updateControls();
  return {element, open, close, dispose, setTheme};
}
