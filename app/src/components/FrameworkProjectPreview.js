import {PublicationInputDistribution} from './PublicationInputDistribution.js';

const PREVIEW_ORIGIN = 'https://preview.studio.opengeo.tools';
const PUBLIC_MAPS_PREVIEW_ORIGIN = 'https://maps-preview.studio.opengeo.tools';
const PREVIEW_ORIGINS = new Set([PREVIEW_ORIGIN, PUBLIC_MAPS_PREVIEW_ORIGIN]);

export function previewCapabilityUrl(capability) {
  const url = new URL(capability?.authorizeUrl);
  if (!PREVIEW_ORIGINS.has(url.origin) || capability.authorizeUrl !== `${url.origin}/authorize/${url.hash}` ||
      url.pathname !== '/authorize/' || url.search ||
      url.username || url.password || !/^#cap=[A-Za-z0-9_-]{128,512}$/.test(url.hash) ||
      capability.publicationAuthorized !== false || Date.parse(capability.expiresAt) <= Date.now() ||
      !Number.isFinite(Date.parse(capability.expiresAt))) throw Error('Invalid or expired preview authorization');
  return url.href;
}

/** The actual saved Framework build, not a Markdown approximation. Never builds
 * on file edits, on mount, on refresh, or after a missing response. */
export function FrameworkProjectPreview({adapter, projectId, sourceProject, canManage = false}) {
  const root = element('section', '', 'publication-document-preview framework-project-preview');
  root.append(element('h4', 'Saved preview'));
  const note = element('p', `Saved revision ${sourceProject.currentRevisionNumber}. Uncommitted edits are not included.`);
  const status = element('p', ''); status.setAttribute('role', 'status');
  const controls = element('div', '', 'platform-actions');
  const frame = document.createElement('iframe');
  frame.title = 'Saved publication preview'; frame.referrerPolicy = 'no-referrer';
  // Separate trusted delivery origin. Authored code never shares Studio origin.
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin'); frame.hidden = true;
  const selectionNote = element('p', '');
  const publicSources = element('div', '', 'framework-preview-public-sources');
  const publicSourcesLabel = element('label', '');
  const publicSourcesInput = document.createElement('input'); publicSourcesInput.type = 'checkbox';
  publicSourcesLabel.append(publicSourcesInput, ' Use public map sources');
  publicSources.append(publicSourcesLabel, element('p',
    'Allow supported public libraries and map tile requests for this saved preview. The draft stays private; nothing is published.'));
  publicSourcesInput.addEventListener('change', () => {
    if (!canManage || sourceProject.rightsStatus !== 'approved') publicSourcesInput.checked = false;
    clearPreview();
    reflect();
    status.textContent = 'Preview sources changed. Open the saved preview when ready. Nothing is published.';
  });
  let artifactInputs = null, selectionKnown = false;
  let hasArtifactReferences = false, currentEntryPath = null, entryMetadataRead = false;
  let selectedOutputRepresentation = null;
  let selectedOutputProfile = 'default-32m', pendingBuildOptions = null;
  let selectedCompilerDigest = sourceProject.buildPolicy?.compilerImageDigest ?? null;
  const outputFormatLabel = element('label', 'Saved build format');
  outputFormatLabel.style.fontSize = '.8rem';
  const outputFormat = element('select', ''); outputFormat.setAttribute('aria-label', 'Saved build format');
  const assetTreeOption = element('option', 'Page and assets'); assetTreeOption.value = 'asset-tree';
  const singleHtmlOption = element('option', 'Single HTML file'); singleHtmlOption.value = 'single-html';
  outputFormat.append(assetTreeOption, singleHtmlOption); outputFormatLabel.append(outputFormat);
  const outputFormatNote = element('small', '');
  outputFormat.addEventListener('change', () => {
    if (outputFormat.disabled || !['asset-tree','single-html'].includes(outputFormat.value)
      || outputFormat.value === 'single-html' && singleHtmlOption.disabled) {
      outputFormat.value = selectedOutputRepresentation ?? 'asset-tree'; return;
    }
    const representation = outputFormat.value === 'single-html' ? 'single-html' : null;
    if (representation === selectedOutputRepresentation) return;
    selectedOutputRepresentation = representation;
    job = terminalJob = null; historyKnown = hasOlder = false; historyOffset = 0;
    pendingBuildOptions = null; requestKey = globalThis.crypto.randomUUID(); clearPreview(); reflect();
    status.textContent = 'Saved build format changed. Check for a matching preview before building.';
  });
  const inputDistribution = PublicationInputDistribution({adapter, projectId, sourceProjectId: sourceProject.id,
    sourceRevisionId: sourceProject.currentRevisionId, canManage, onChange: selection => {
      if (selection.outputProfile !== selectedOutputProfile) {
        selectedOutputProfile = selection.outputProfile;
        job = terminalJob = null; historyKnown = hasOlder = false; historyOffset = 0;
        pendingBuildOptions = null; requestKey = globalThis.crypto.randomUUID(); clearPreview();
        status.textContent = 'Output size changed. Check for a matching saved preview before building.';
      }
      reflect();
    }});
  const supportsArtifacts = typeof adapter.readPublicationArtifactReferences === 'function';
  const prepare = button('Prepare current Artifact selection', () => perform(async () => {
    if (uncertain || job && ['pending','running'].includes(job.state)) return;
    selectionKnown = false; artifactInputs = null; job = null; historyKnown = false;
    pendingBuildOptions = null;
    clearPreview();
    const references = await adapter.readPublicationArtifactReferences(projectId, sourceProject.id);
    assertSelection();
    setArtifactReferences(references);
    artifactInputs = references.references.length
      ? await adapter.preparePublicationArtifactInputs(projectId, sourceProject.id, sourceProject.currentRevisionId, references.revision)
      : null;
    assertSelection();
    inputDistribution.setContext({sourceRevisionId: sourceProject.currentRevisionId, artifactInputId: artifactInputs?.id,
      artifactInputsChecksumSha256: artifactInputs?.checksum, outputProfile: selectedOutputProfile});
    selectionKnown = true; requestKey = globalThis.crypto.randomUUID();
    selectionNote.textContent = artifactInputs
      ? `Prepared reference revision ${references.revision}. Editions are frozen for this preview. Prepare again to follow a changed current edition.`
      : 'No retained Artifact references in this selection.';
    await find();
  }));
  const refresh = button('Check saved preview', () => perform(find));
  const older = button('Check older builds', () => perform(() => find(historyOffset + 25)));
  const build = button('Build saved revision', () => perform(async () => {
    if (!canManage || !historyKnown || hasOlder || job && !['failed','cancelled'].includes(job.state)) return;
    if (selectedOutputRepresentation === 'single-html' && (hasArtifactReferences || artifactInputs)) return;
    if (job) {job = null; if (!uncertain) {requestKey = globalThis.crypto.randomUUID(); pendingBuildOptions = null;}}
    // Stable across response loss: never silently submit a replacement job.
    try {
      pendingBuildOptions ??= {...inputDistribution.getBuildOptions({purpose: 'preview'}),
        ...(selectedOutputRepresentation === 'single-html' ? {outputRepresentation: 'single-html'} : {})};
      const created = await adapter.createObservableBuildJob(projectId, sourceProject.id,
        sourceProject.currentRevisionId, {purpose:'preview', idempotencyKey:requestKey,
          ...(artifactInputs ? {artifactInputId:artifactInputs.id} : {}), ...pendingBuildOptions});
      job = validateJob(created); uncertain = false; reflect();
    } catch (error) {uncertain = true; throw error;}
  }));
  const show = button('Show preview', () => perform(async () => {
    if (job?.state !== 'succeeded') return;
    const profile = runtimeProfile(), selection = previewSelection;
    const capability = await adapter.createObservablePreviewCapability(projectId, job.id, {runtimeProfile:profile});
    if (disposed) return;
    const url = selectedCapabilityUrl(capability, profile, selection);
    frame.hidden = false; frame.src = url;
    status.textContent = `Opening saved revision ${job.sourceRevisionNumber} in the preview pane…`;
  }));
  const separate = button('Open in new window', () => {
    if (busy || job?.state !== 'succeeded') return;
    // Open synchronously within the user gesture, then sever the opener before
    // obtaining authorization. Preview code cannot navigate the editor window.
    const popup = globalThis.open('about:blank', '_blank');
    if (!popup) {status.textContent = 'Allow a new window for the private preview, then try again.'; return;}
    popup.opener = null;
    void perform(async () => {
      try {
        const profile = runtimeProfile(), selection = previewSelection;
        const capability = await adapter.createObservablePreviewCapability(projectId, job.id, {runtimeProfile:profile});
        if (disposed) {popup.close(); return;}
        popup.location.replace(selectedCapabilityUrl(capability, profile, selection));
        status.textContent = 'Saved preview opened. Your editor remains here.';
      } catch (error) {popup.close(); throw error;}
    });
  });
  controls.append(outputFormatLabel, outputFormatNote, prepare, refresh, older, build, show, separate); root.append(note, publicSources, inputDistribution, selectionNote, controls, status, frame);
  let job = null, terminalJob = null, busy = false, uncertain = false, everMounted = false, disposed = false;
  let requestKey = globalThis.crypto.randomUUID(), historyKnown = false, historyOffset = 0, hasOlder = false;
  let operationRevision = null;
  let previewSelection = 0;
  function runtimeProfile() {
    return canManage && sourceProject.rightsStatus === 'approved' && publicSourcesInput.checked ? 'public_maps_v1' : 'local_only';
  }
  function clearPreview() {
    previewSelection++;
    frame.hidden = true; frame.removeAttribute('src');
  }
  // A consumed authorization URL must not be reopened after changing modes.
  // The next deliberate Show preview action requests a fresh capability.
  root.closePreview = clearPreview;
  function selectedCapabilityUrl(capability, profile, selection) {
    assertSelection();
    if (selection !== previewSelection || profile !== runtimeProfile()) throw Error('Preview sources changed. Select the preview again.');
    const url = previewCapabilityUrl(capability);
    if (new URL(url).origin !== (profile === 'public_maps_v1' ? PUBLIC_MAPS_PREVIEW_ORIGIN : PREVIEW_ORIGIN)) {
      throw Error('Preview authorization does not match the selected sources');
    }
    return url;
  }
  function assertSelection() {
    if (disposed || operationRevision !== sourceProject.currentRevisionId) throw Error('The saved draft changed. Select its preview again.');
  }
  const methods = ['listObservableBuildJobs', 'getObservableBuildJob', 'createObservablePreviewCapability'];
  const ready = methods.every(name => typeof adapter?.[name] === 'function');
  // A draft save changes the source head without running or cancelling a build.
  // Old jobs remain available through build history; this view starts a new
  // deliberate selection before the next preview request.
  root.sourceDraftSaved = () => {
    note.textContent = `Saved revision ${sourceProject.currentRevisionNumber}. New edits are not included until saved.`;
    job = terminalJob = artifactInputs = null;
    selectionKnown = historyKnown = uncertain = hasOlder = false;
    historyOffset = 0; requestKey = globalThis.crypto.randomUUID();
    publicSourcesInput.checked = false; clearPreview(); selectionNote.textContent = '';
    selectedOutputProfile = 'default-32m'; pendingBuildOptions = null;
    selectedOutputRepresentation = currentEntryPath = null; entryMetadataRead = hasArtifactReferences = false;
    selectedCompilerDigest = sourceProject.buildPolicy?.compilerImageDigest ?? null;
    inputDistribution.setContext({sourceRevisionId: sourceProject.currentRevisionId});
    status.textContent = 'Draft saved. Check or build its preview when ready.';
    reflect();
  };
  function validateJob(value) {
    if (!value || value.sourceProjectId !== sourceProject.id || value.sourceRevisionId !== sourceProject.currentRevisionId ||
        (value.request?.artifactInputsChecksumSha256 ?? null) !== (artifactInputs?.checksum ?? null) ||
        (value.request?.outputProfile ?? 'default-32m') !== selectedOutputProfile ||
        (value.request?.outputRepresentation ?? null) !== selectedOutputRepresentation ||
        selectedCompilerDigest && value.request?.compilerImageDigest !== selectedCompilerDigest ||
        value.purpose !== 'preview' || !['pending','running','succeeded','failed','cancelled'].includes(value.state)) {
      throw Error('Preview build does not match the saved source revision');
    }
    return value;
  }
  function reflect() {
    const formatAvailable = canManage && ['index.md','src/index.md'].includes(currentEntryPath);
    outputFormatLabel.hidden = outputFormatNote.hidden = !formatAvailable;
    singleHtmlOption.disabled = hasArtifactReferences || !!artifactInputs;
    outputFormat.disabled = busy || uncertain || !formatAvailable || !!job && ['pending','running'].includes(job.state);
    outputFormat.value = selectedOutputRepresentation ?? 'asset-tree';
    outputFormatNote.textContent = singleHtmlOption.disabled
      ? 'Single HTML is unavailable with retained map Artifacts.'
      : selectedOutputRepresentation === 'single-html'
        ? 'Embeds the saved page and supported files in one HTML file.'
        : 'Choose the format for the next saved build.';
    publicSources.hidden = !canManage || sourceProject.rightsStatus !== 'approved';
    publicSourcesInput.disabled = busy || !ready || publicSources.hidden;
    prepare.hidden = !supportsArtifacts || !canManage;
    prepare.disabled = busy || uncertain || !sourceProject.currentRevisionId || !!job && ['pending','running'].includes(job.state);
    refresh.disabled = busy || !ready;
    build.hidden = !canManage || !sourceProject.currentRevisionId || !!job && !['failed','cancelled'].includes(job.state);
    build.disabled = busy || !ready || !selectionKnown || !historyKnown || hasOlder || typeof adapter?.createObservableBuildJob !== 'function';
    build.disabled ||= !inputDistribution.isBuildAllowed();
    inputDistribution.setBuildLocked(busy || uncertain || !!job && ['pending','running'].includes(job.state));
    older.hidden = !hasOlder; older.disabled = busy;
    build.textContent = uncertain ? 'Retry same build request' : 'Build saved revision';
    show.hidden = separate.hidden = job?.state !== 'succeeded';
    show.disabled = separate.disabled = busy;
    if (job) status.textContent = `Saved revision ${job.sourceRevisionNumber} · ${job.state}. Nothing is published by previewing.`;
  }
  async function readCurrentEntry() {
    if (entryMetadataRead || !canManage || !sourceProject.currentRevisionId
      || !Number.isSafeInteger(sourceProject.currentRevisionNumber)
      || typeof adapter.listObservableSourceRevisionsPage !== 'function') return;
    entryMetadataRead = true;
    try {
      const revisions = await adapter.listObservableSourceRevisionsPage(projectId, sourceProject.id,
        {limit: 1, beforeRevision: sourceProject.currentRevisionNumber + 1});
      assertSelection();
      if (Array.isArray(revisions) && revisions.length === 1) {
        const current = revisions[0];
        if (current.id === sourceProject.currentRevisionId && current.sourceProjectId === sourceProject.id
          && current.revisionNumber === sourceProject.currentRevisionNumber) currentEntryPath = current.entryPath;
      }
    } catch {
      // An unavailable format lookup does not block the existing saved preview.
      // Keep it hidden until the saved revision changes; do not repeat the read.
      assertSelection();
    }
  }
  function setArtifactReferences(references) {
    hasArtifactReferences = references.references.length > 0;
    if (hasArtifactReferences) selectedOutputRepresentation = null;
  }
  async function find(offset = 0) {
    // Format metadata does not determine the selected build identity. Read it
    // alongside history so adding a format choice adds no sequential round trip.
    // Keep the operation busy until both reads settle, even if a changed source
    // rejects one early. A later operation must not admit an older response.
    const results = await Promise.allSettled([readCurrentEntry(), findSavedBuild(offset)]);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  async function findSavedBuild(offset = 0) {
    if (!selectionKnown) {
      if (supportsArtifacts) {
        const references = await adapter.readPublicationArtifactReferences(projectId, sourceProject.id);
        assertSelection();
        setArtifactReferences(references);
        if (references.references.length) {
          selectionNote.textContent = 'Prepare the saved Artifact selection before finding or building its preview. Existing editions remain available in build history.';
          return;
        }
      }
      selectionKnown = true;
    }
    if (job && ['pending','running','succeeded'].includes(job.state)) {
      job = validateJob(await adapter.getObservableBuildJob(projectId, job.id)); reflect(); return;
    }
    if (offset === 0) terminalJob = null;
    historyKnown = false;
    const jobs = await adapter.listObservableBuildJobs(projectId, sourceProject.id, {limit:25,offset});
    assertSelection();
    if (!Array.isArray(jobs) || jobs.length > 25 || jobs.some(value => value.sourceProjectId !== sourceProject.id)) throw Error('Invalid build history');
    const matches = jobs.filter(value => value.sourceRevisionId === sourceProject.currentRevisionId && value.purpose === 'preview' &&
      (value.request?.artifactInputsChecksumSha256 ?? null) === (artifactInputs?.checksum ?? null) &&
      (value.request?.outputProfile ?? 'default-32m') === selectedOutputProfile &&
      (value.request?.outputRepresentation ?? null) === selectedOutputRepresentation &&
      (!selectedCompilerDigest || value.request?.compilerImageDigest === selectedCompilerDigest));
    const selected = matches.find(value => value.state === 'succeeded') ?? matches.find(value => ['pending','running'].includes(value.state));
    terminalJob ??= matches.find(value => ['failed','cancelled'].includes(value.state)) ?? null;
    job = selected ? validateJob(selected) : terminalJob ? validateJob(terminalJob) : null;
    // A recent failure must not hide a reusable build on a later history page.
    historyKnown = true; historyOffset = offset; hasOlder = jobs.length === 25 && !selected;
    reflect();
    if (!job) status.textContent = jobs.length === 25
      ? 'No preview for this revision on this page. Check older builds before requesting another.'
      : 'No completed preview for this saved revision. Build it once, then reuse it while editing.';
  }
  async function perform(operation) {
    if (busy || disposed) return;
    const selectedRevision = operationRevision = sourceProject.currentRevisionId;
    busy = true; reflect(); root.setAttribute('aria-busy','true');
    try {await operation();}
    catch (error) {
      status.textContent = ['github_build_connection_not_configured','github_build_connection_ambiguous'].includes(error?.code)
        ? 'Ask the deployment administrator to configure the build service, then retry. Your private draft remains saved in OpenGeo Studio. No build was created.'
        : `Preview unavailable: ${error.message}. No replacement build or publication was started.`;
    } finally {
      busy = false; root.removeAttribute('aria-busy');
      if (selectedRevision !== sourceProject.currentRevisionId) root.sourceDraftSaved();
      // Retain the useful result/error text when enabling the controls.
      const message = status.textContent; reflect(); status.textContent = message;
    }
  }
  const policyFailure = event => {
    let blockedOrigin;
    try {blockedOrigin = new URL(event.blockedURI).origin;} catch {return;}
    if (event.effectiveDirective === 'frame-src' && PREVIEW_ORIGINS.has(blockedOrigin)) {
      clearPreview();
      status.textContent = 'Studio currently blocks embedded previews. Open this saved build in a new window; the editor stays open.';
    }
  };
  const ownerDocument = root.ownerDocument;
  ownerDocument.addEventListener('securitypolicyviolation', policyFailure);
  const Observer = ownerDocument.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  const observer = new Observer(() => {
    if (root.isConnected) everMounted = true;
    else if (everMounted) {disposed = true; observer.disconnect(); ownerDocument.removeEventListener('securitypolicyviolation', policyFailure);}
  });
  observer.observe(ownerDocument.body,{childList:true,subtree:true});
  reflect();
  if (ready && sourceProject.currentRevisionId) void perform(find);
  else status.textContent = 'Save a source revision and connect the preview service to render this publication.';
  return root;
}
function element(tag, text, className='') {const node=document.createElement(tag); node.textContent=text; node.className=className; return node;}
function button(label, action) {const node=element('button',label,'platform-button secondary'); node.type='button'; node.addEventListener('click',action); return node;}
