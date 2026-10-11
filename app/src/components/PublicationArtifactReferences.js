import {artifactSourceLayout, nextArtifactPath, publicationArtifactEmbed, publicArtifactEmbed} from '../lib/publicationArtifactEmbed.js';
import {parsePublicationArtifactReferences} from '../lib/apiClient.js';
/** Saved authoring intent only. Loading or saving references never starts a build. */
export function PublicationArtifactReferences({adapter, projectId, sourceProjectId, sourceRevisionId = null, canManage = false, onInsertPublicRelease = null, importedSource = null}) {
  const root = document.createElement('section');
  root.className = 'publication-artifact-references';
  const node = (tag, text) => {const item = document.createElement(tag); item.textContent = text; return item;};
  root.append(node('h4', 'Retained Project Artifacts'), node('p', 'Reuse a public release by linking it in your page, or include a current or pinned edition in a private preview. Neither choice rebuilds the map. Public release links retain their own access and revocation.'));
  const status = node('p', 'Load saved references to inspect or edit them.'); status.setAttribute('role', 'status');
  const fields = document.createElement('fieldset'); const rows = document.createElement('div');
  const controls = node('div', ''); controls.className = 'platform-actions';
  root.append(fields, status); fields.append(controls, rows);
  let revision = null, references = [], busy = false, dirty = false, offset = 0, workspaceOffset = 0;
  let importedReferences = [], importedSelection = null;
  if (importedSource) {
    try { importedReferences = parsePublicationArtifactReferences(importedSource.references).references; }
    catch { root.append(node('p', 'These original map references use an unsupported format. Keep their details from the import review and reconnect them through Settings.')); }
  }
  function checkImportedPath(path) {
    const currentLayout = artifactSourceLayout(importedSource.getLayout());
    publicationArtifactEmbed(currentLayout, path);
    const target = path.toLowerCase();
    if (currentLayout.paths.some(source => {
      source = source.toLowerCase();
      return source === target || source.startsWith(target + '/') || target.startsWith(source + '/');
    })) throw Error('Imported map path collides with a source or data file. Keep the source file or choose another map reference path.');
  }
  root.assertImportReady = ({checkLayout = true} = {}) => {
    if (dirty || busy) throw Error('Save or discard the map reference edits before committing or replacing source. Your drafts remain here.');
    if (checkLayout && importedSource) for (const reference of references) {
      if (importedReferences.some(item => item.path.toLowerCase() === reference.path.toLowerCase())) checkImportedPath(reference.path);
    }
  };
  root.shouldBlockNavigation = () => dirty || busy;
  root.checkDraft = () => {
    if (!root.shouldBlockNavigation()) return false;
    status.textContent = busy ? 'Wait for the Artifact reference action to finish before leaving or refreshing.'
      : 'Save or discard Artifact reference edits before leaving or refreshing.';
    root.dispatchEvent(new root.ownerDocument.defaultView.CustomEvent('opengeo-reveal-draft', {bubbles:true}));
    for (let panel = root.closest('[data-publication-panel]'); panel;
      panel = panel.parentElement?.closest('[data-publication-panel]')) {
      panel.parentElement.selectPanel?.(panel.dataset.publicationPanel);
    }
    return true;
  };
  const action = (label, fn) => {const b = node('button', label); b.type = 'button'; b.className = 'platform-button secondary'; b.onclick = async () => {
    if (busy) return; busy = true; fields.disabled = true;
    try {await fn();} catch (error) {status.textContent = `Could not complete: ${error.code ?? error.message}. Your draft is retained. Reload saved references to recover from a conflict.`;}
    finally {busy = false; fields.disabled = false; update();}
  }; controls.append(b); return b;};
  const load = action('Load saved references', async () => {
    const saved = await adapter.readPublicationArtifactReferences(projectId, sourceProjectId);
    revision = saved.revision; references = saved.references.map(item => ({...item})); dirty = false; draw();
    status.textContent = `Saved reference revision ${revision}. ${references.length} retained Artifacts.`;
  });
  const save = action('Save Artifact references', async () => {
    const saved = await adapter.savePublicationArtifactReferences(projectId, sourceProjectId, revision, references);
    revision = saved.revision; references = saved.references.map(item => ({...item})); dirty = false; draw();
    status.textContent = `Saved reference revision ${revision}. No build was started.`;
  });
  const discard = action('Discard reference edits', async () => {
    const saved = await adapter.readPublicationArtifactReferences(projectId, sourceProjectId);
    revision = saved.revision; references = saved.references.map(item => ({...item})); dirty = false; draw();
    status.textContent = 'Saved references restored.';
  });
  const importedPaths = document.createElement('select');
  importedPaths.setAttribute('aria-label', 'Imported map path to reconnect');
  importedPaths.append(node('option', 'Choose an imported map path'));
  importedPaths.firstChild.value = '';
  for (const item of importedReferences) {
    const option = node('option', `${item.path} · originally ${item.mode === 'pinned' ? `pinned v${item.version}` : 'followed current'}`);
    option.value = item.path; importedPaths.append(option);
  }
  if (importedReferences.length) {
    controls.append(node('p', 'Original maps are reference information only. Load destination references, choose an imported path, then select an accessible map and edition. Reconnection changes the reference draft; Save checks access again. No map is copied or rebuilt.'), importedPaths);
  }
  const workspaces = document.createElement('select'); workspaces.setAttribute('aria-label', 'Artifact workspace');
  const initial = node('option', 'This Publication workspace'); initial.value = projectId; workspaces.append(initial); controls.append(workspaces);
  const loadWorkspaces = action('Load accessible workspaces', async () => {
    const records = await adapter.listProjects({limit:100,offset:workspaceOffset});
    for (const record of records) {
      const existing = [...workspaces.options].find(option => option.value === record.id);
      if (existing) existing.textContent = record.name ?? record.title ?? record.id;
      else {const option = node('option', record.name ?? record.title ?? record.id); option.value = record.id; workspaces.append(option);}
    }
    workspaceOffset += records.length; loadWorkspaces.dataset.finished = String(records.length < 100);
    loadWorkspaces.textContent = 'More accessible workspaces';
    status.textContent = 'Choose an authorized workspace, then load its map resources. Your reference draft is unchanged.';
  });
  let layout = null;
  const loadLayout = async () => {
    const revisions = await adapter.listObservableSourceRevisions(projectId, sourceProjectId);
    layout = artifactSourceLayout(revisions.find(item => item.id === sourceRevisionId));
    pages.replaceChildren();
    for (const path of layout.paths.filter(path => /\.(html|md)$/i.test(path))) {
      const option = node('option',path); option.value=path; pages.append(option);
    }
    if ([...pages.options].some(item=>item.value===layout.entryPath)) pages.value=layout.entryPath;
    draw();
  };
  const sourceLayout = action('Load saved source layout', loadLayout);
  const pages=document.createElement('select'); pages.setAttribute('aria-label','Publication page for embed'); controls.append(pages);
  pages.onchange=()=>draw();
  const maps = document.createElement('select'); maps.setAttribute('aria-label', 'Map resource in this workspace'); controls.append(maps);
  const more = action('Load map resources', async () => {
    const records = await adapter.listResources(workspaces.value, {kind:'map',limit:100,offset});
    for (const record of records) {const option = node('option', record.title ?? record.name ?? record.id); option.value = record.id; maps.append(option);}
    offset += records.length; more.disabled = records.length < 100;
    more.dataset.finished = String(records.length < 100); more.textContent = 'More map resources';
    status.textContent = maps.options.length ? 'Choose a map resource with retained portable HTML, then add its Artifact.' : 'No map resources were found in this workspace.';
  });
  let inspected = null;
  const knownEditions = new Map();
  const editions = document.createElement('select'); editions.setAttribute('aria-label', 'Retained Artifact edition to add');
  controls.append(editions);
  const inspect = action('Load retained editions', async () => {
    inspected = null; editions.replaceChildren(); clearReleases();
    const record = await adapter.readArtifactEdition(workspaces.value, maps.value, null, true, 'portable-map-html');
    const history = record.editions ?? [];
    if (record.current_version_number != null) {
      const current = node('option', `Follow current edition (now v${record.current_version_number})`);
      current.value = 'current'; editions.append(current);
    }
    for (const edition of history) {
      const option = node('option', `Pin v${edition.version_number}${edition.version_number === record.current_version_number ? ' · current' : ''}`);
      option.value = String(edition.version_number); editions.append(option);
    }
    inspected = record; knownEditions.set(record.id, record); draw();
    status.textContent = editions.options.length
      ? 'Choose whether to follow current or keep a specific edition, then add the reference. No output was downloaded or rebuilt.'
      : 'No selectable retained editions were returned. Retain an edition in the Project first.';
  });
  const add = action('Add retained Artifact', async () => {
    if (!inspected || !editions.value) return;
    if (sourceRevisionId && !layout) await loadLayout();
    const current = editions.value === 'current';
    references.push({path:nextArtifactPath(layout,references), artifact_id:inspected.id,
      mode:current ? 'current' : 'pinned', version:current ? null : Number(editions.value)});
    dirty = true; draw(); status.textContent = 'Reference added to this draft. Save references, then embed the asset path in your publication source.';
  });
  const reconnect = action('Reconnect imported map', async () => {
    if (!canManage || !importedSelection || revision === null || !inspected || !editions.value) return;
    checkImportedPath(importedSelection.path);
    const current = editions.value === 'current';
    const replacement = {path: importedSelection.path, artifact_id: inspected.id,
      mode: current ? 'current' : 'pinned', version: current ? null : Number(editions.value)};
    const next = references.filter(item => item.path.toLowerCase() !== replacement.path.toLowerCase());
    // Original Artifact IDs and revisions never enter the destination draft.
    references = parsePublicationArtifactReferences({revision, references: [...next, replacement]}).references;
    dirty = true; draw();
    status.textContent = `Reconnected ${replacement.path} in the reference draft. Save Artifact references to check access and retain the destination map; then commit your source.`;
  });
  let releaseOffset = 0;
  const releases = new Map();
  const releaseChoices = document.createElement('select'); releaseChoices.setAttribute('aria-label','Public Artifact release');
  controls.append(releaseChoices);
  const loadReleases = action('Load public releases', async () => {
    const page = await adapter.listArtifactReleases(inspected.id,{limit:20,offset:releaseOffset});
    for (const record of page.records) {
      if (record.revoked_at || releases.has(record.id)) continue;
      releases.set(record.id,record);
      const option=node('option',`${record.title} · v${record.version_number} · ${record.license}`);
      option.value=record.id;releaseChoices.append(option);
    }
    releaseOffset += page.records.length;
    loadReleases.dataset.finished=String(!page.has_more);loadReleases.textContent='More public releases';
    status.textContent=releases.size ? 'Choose a public release to embed. The saved page will keep its release link; map bytes are not copied.'
      : 'No public releases were found. Publish an eligible edition from its Project first.';
  });
  const insertRelease = action('Insert public release into page', async () => {
    const release=releases.get(releaseChoices.value);
    if (!release) return;
    if (!layout) await loadLayout();
    const url=await adapter.publicArtifactReleaseUrl(release.id);
    publicArtifactEmbed({url,title:release.title});
    await onInsertPublicRelease({url,title:release.title,pagePath:pages.value});
    status.textContent='Public release inserted in the page draft. Commit that revision before previewing or publishing. Existing private references are unchanged.';
  });
  releaseChoices.onchange=()=>update();
  function clearReleases() {
    releases.clear(); releaseChoices.replaceChildren(); releaseOffset=0;
    delete loadReleases.dataset.finished; loadReleases.textContent='Load public releases';
  }
  const clearInspection = () => {inspected = null; editions.replaceChildren(); clearReleases();};
  workspaces.onchange = () => {
    if (busy) return;
    clearInspection();
    maps.replaceChildren(); offset = 0; delete more.dataset.finished; more.textContent = 'Load map resources';
    status.textContent = 'Load map resources in the selected workspace. Your reference draft is unchanged.'; update();
  };
  maps.onchange = () => {clearInspection(); update();};
  importedPaths.onchange = () => {
    if (busy || !canManage) return;
    importedSelection = importedReferences.find(item => item.path === importedPaths.value) ?? null;
    clearInspection(); update();
    status.textContent = importedSelection ? `Choose a destination map and edition for ${importedSelection.path}. Any existing reference at this path will be replaced only when you reconnect.`
      : 'Choose a map to add a new reference. Your current references are unchanged.';
  };
  function update() {
    sourceLayout.hidden = !sourceRevisionId || typeof adapter.listObservableSourceRevisions !== 'function';
    pages.hidden = !layout;
    workspaces.hidden = !canManage; loadWorkspaces.hidden = !canManage || typeof adapter.listProjects !== 'function';
    loadWorkspaces.disabled = loadWorkspaces.dataset.finished === 'true';
    load.disabled = dirty; save.hidden = discard.hidden = more.hidden = maps.hidden = add.hidden = inspect.hidden = editions.hidden = !canManage;
    save.disabled = revision === null || !dirty; discard.disabled = !dirty;
    more.disabled = more.dataset.finished === 'true';
    inspect.disabled = !maps.value;
    add.disabled = revision === null || !inspected || !editions.value || references.length >= 32;
    add.hidden ||= Boolean(importedSelection);
    importedPaths.disabled = !canManage;
    reconnect.hidden = !canManage || !importedSelection;
    reconnect.disabled = revision === null || !inspected || !editions.value
      || references.length >= 32 && !references.some(item => item.path.toLowerCase() === importedSelection?.path.toLowerCase());
    const publicAvailable = canManage && typeof adapter.listArtifactReleases === 'function'
      && typeof adapter.publicArtifactReleaseUrl === 'function' && typeof onInsertPublicRelease === 'function';
    loadReleases.hidden = releaseChoices.hidden = insertRelease.hidden = !publicAvailable;
    loadReleases.disabled = !inspected || loadReleases.dataset.finished === 'true';
    insertRelease.disabled = !releases.has(releaseChoices.value) || !sourceRevisionId;
  }
  function draw() {
    rows.replaceChildren();
    for (const item of references) {
      const row = node('div', ''); const path = document.createElement('input'); path.value = item.path; path.setAttribute('aria-label','Artifact asset path');
      const mode = document.createElement('select'); mode.setAttribute('aria-label', 'Artifact edition selection');
      for (const [value, label] of [['current','Current edition'],['pinned','Pinned edition']]) {const option = node('option',label); option.value = value; mode.append(option);} mode.value = item.mode;
      const version = document.createElement('input'); version.type = 'number'; version.min = '1'; version.max = '2147483647'; version.value = String(item.version ?? knownEditions.get(item.artifact_id)?.current_version_number ?? ''); version.setAttribute('aria-label','Pinned Artifact version'); version.hidden = item.mode !== 'pinned';
      path.oninput = () => {item.path = path.value; dirty = true; update(); reflectEmbed();};
      mode.onchange = () => {item.mode = mode.value; item.version = item.mode === 'pinned' ? Number(version.value) : null; version.hidden = item.mode !== 'pinned'; dirty = true; update();};
      version.oninput = () => {item.version = Number(version.value); dirty = true; update();};
      const remove = node('button','Remove reference'); remove.type = 'button'; remove.onclick = () => {if (busy) return; references = references.filter(value => value !== item); dirty = true; draw(); update();};
      for (const control of [path, mode, version, remove]) control.disabled = !canManage;
      const snippet=document.createElement('textarea'); snippet.readOnly=true; snippet.rows=3;
      snippet.setAttribute('aria-label','Artifact embed HTML');
      const copy=node('button','Copy embed HTML'); copy.type='button';
      function reflectEmbed() {
        try {snippet.value=publicationArtifactEmbed(layout,item.path,pages.value);copy.disabled=false;}
        catch(error){snippet.value=error.message;copy.disabled=true;}
      }
      copy.onclick=async()=>{
        try {await navigator.clipboard.writeText(snippet.value);status.textContent='Embed HTML copied. Paste it into the selected page and save that source revision.';}
        catch {snippet.focus();snippet.select();status.textContent='Select and copy the embed HTML, then paste it into the selected page.';}
      };
      reflectEmbed();
      row.append(node('p', `Artifact ${item.artifact_id}`), path, mode, version, remove, snippet, copy); rows.append(row);
    }
  }
  if (typeof adapter.readPublicationArtifactReferences !== 'function') {fields.disabled = true; status.textContent = 'Retained Artifact references are unavailable in this adapter.';}
  update(); return root;
}
