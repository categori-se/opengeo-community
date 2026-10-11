import {projectHref} from '../lib/applicationRoutes.js';

const OUTPUT_LIMITS = {'default-32m': 32 * 1024 * 1024, 'archive-96m': 96 * 1024 * 1024};
const LICENSES = ['CC0-1.0', 'CC-BY-4.0', 'PDDL-1.0'];

/** Deliberate metadata review; opening a publication never reads dataset bytes,
 * approves distribution or requests a build. Private previews remain available. */
export function PublicationInputDistribution({adapter, projectId, sourceProjectId, sourceRevisionId,
  artifactInputId = null, artifactInputsChecksumSha256 = null, buildJobId = null, canManage = false, onChange = () => {}}) {
  const root = node('details', '', 'publication-input-distribution');
  root.append(node('summary', 'Data files and output size'));
  const body = node('div', '', 'publication-input-distribution-body');
  body.style.minWidth = '0';
  const status = node('p', 'Review linked files before sharing publicly. Private previews do not require public sharing approval.');
  status.setAttribute('role', 'status');
  const profile = node('select', ''); profile.setAttribute('aria-label', 'Saved output size limit');
  for (const [value, label] of [['default-32m', 'Standard · up to 32 MiB'], ['archive-96m', 'Larger · up to 96 MiB']]) {
    const option = node('option', label); option.value = value; profile.append(option);
  }
  const size = checkbox('I allow saved output up to 96 MiB.', 'allow-up-to-96-mib-output');
  const limits = node('p', '');
  const costs = node('small', 'Larger outputs increase build time, storage and download traffic; charges depend on deployment.');
  const controls = node('div', '', 'platform-actions');
  const inspect = button('Review linked files', () => load());
  const records = node('div', '', 'publication-input-records');
  const approvalStatus = node('p', '');
  const approve = button('Approve these files for public sharing', () => approveInputs());
  const profileLabel = node('label', 'Saved output'); profileLabel.append(profile);
  body.append(profileLabel, size.label, limits, costs, controls, status, records, approvalStatus);
  controls.append(inspect); root.append(body);
  let generation = 0, busy = false, uncertain = false, buildLocked = false, metadata = null, selectedApproval = null, pendingApprovalId = null;
  let archiveRows = [], referencedRows = [], artifactRows = [];

  function linkedFiles() {return metadata ? [...metadata.archiveFiles, ...(metadata.referencedFiles ?? [])] : [];}

  function scope() {return {sourceRevisionId, artifactInputId, artifactInputsChecksumSha256, buildJobId};}
  function identity() {return JSON.stringify(scope());}
  function matches(approval) {
    const manifest = approval?.manifest;
    return approval && !approval.revoked && manifest?.sourceProjectId === sourceProjectId &&
      manifest.sourceRevisionId === sourceRevisionId && manifest.outputProfile === profile.value &&
      (manifest.artifactInputsChecksumSha256 ?? null) === artifactInputsChecksumSha256 &&
      manifest.sourceManifestChecksumSha256 === metadata?.sourceManifestChecksumSha256 &&
      manifest.compilerImageDigest === metadata?.compilerImageDigest;
  }
  function changed() {
    if (uncertain) return;
    selectedApproval = null;
    pendingApprovalId = null;
    approvalStatus.textContent = 'Sharing selections changed. Review and approve this selection before publishing.';
    onChange({outputProfile: profile.value, sizeAcknowledgment: size.input.checked ? 'allow-up-to-96-mib-output' : null,
      distributionApprovalId: null});
    reflect();
  }
  function reflect() {
    profile.disabled = busy || uncertain || buildLocked || !canManage || !!buildJobId;
    size.label.hidden = profile.value !== 'archive-96m'; size.input.disabled = busy || uncertain || buildLocked || !canManage;
    inspect.disabled = busy || !sourceRevisionId || typeof adapter.getPublicationInputDistributions !== 'function';
    inspect.textContent = uncertain ? 'Check saved sharing approvals' : 'Review linked files';
    const knownBytes = metadata ? linkedFiles().reduce((sum, file) => sum + file.sizeBytes, 0) : undefined;
    const embeddedBytes = metadata ? linkedFiles().reduce((sum, file) => sum + 4 * Math.ceil(file.sizeBytes / 3), 0) : undefined;
    limits.textContent = `${knownBytes === undefined ? 'Linked file size: not reviewed' : `Linked files: ${bytes(knownBytes)}`} · Output limit: ${bytes(OUTPUT_LIMITS[profile.value])}. ${embeddedBytes ? `Estimated embedding: ${bytes(embeddedBytes)} plus runtime; final size after build.` : 'Final size after build.'}`;
    for (const control of records.querySelectorAll('input,select,button')) control.disabled = busy || uncertain || !canManage || control.dataset.locked === 'true';
    for (const use of records.querySelectorAll('[data-approval-id]')) {
      use.disabled = busy || uncertain || !canManage || !matches(metadata.approvals.find(item => item.id === use.dataset.approvalId));
    }
    approve.disabled = busy || buildLocked || uncertain || !canManage || !metadata || typeof adapter.createPublicationInputDistribution !== 'function' ||
      !archiveRows.length && !referencedRows.length && !artifactRows.length ||
      profile.value === 'archive-96m' && !size.input.checked ||
      [...archiveRows, ...referencedRows].some(row => !row.file.canPublish || !row.ack.checked || !LICENSES.includes(row.license.value) || !row.attribution.value.trim()) ||
      artifactRows.some(row => !row.file.canPublish || !row.ack.checked || !row.release.value);
  }
  async function load() {
    if (busy || !sourceRevisionId) return;
    const selection = identity(), token = generation, mounted = root.isConnected;
    busy = true; reflect(); status.textContent = 'Reading file metadata and sharing permissions…';
    try {
      const value = await adapter.getPublicationInputDistributions(projectId, sourceProjectId, sourceRevisionId,
        buildJobId ? {buildJobId} : {artifactInputId});
      if (token !== generation || selection !== identity() || mounted && !root.isConnected) return;
      if (value.sourceRevisionId !== sourceRevisionId) throw Error('The saved draft changed. Review its files again.');
      if (buildJobId && (value.outputProfile !== profile.value ||
        (value.artifactInputsChecksumSha256 ?? null) !== artifactInputsChecksumSha256)) throw Error('The file review does not match this saved build.');
      artifactInputId = value.artifactInputId ?? artifactInputId;
      metadata = value; uncertain = false; selectedApproval = null;
      const recovered = pendingApprovalId && value.approvals.find(approval => approval.id === pendingApprovalId && matches(approval));
      if (recovered) {
        selectedApproval = recovered; pendingApprovalId = null;
        onChange({outputProfile: profile.value, sizeAcknowledgment: size.input.checked ? 'allow-up-to-96-mib-output' : null,
          distributionApprovalId: recovered.id});
      }
      renderRecords();
      status.textContent = !linkedFiles().length && !value.artifacts.length
        ? 'This saved revision has no linked dataset files or map artifacts.'
        : 'Exact files in this saved revision. Review does not copy data or publish it.';
      if (recovered) approvalStatus.textContent = 'Your saved sharing approval was recovered. No second approval request was made.';
      else if (value.approvals.some(matches)) approvalStatus.textContent = 'A saved approval is available below. Select it to use this exact sharing decision.';
    } catch (error) {
      if (token === generation) status.textContent = error.code === 'observable_distribution_build_compiler_changed'
        ? 'The build service changed since this preview was created. Open Preview and build this saved revision with the current service before reviewing its public release.'
        : `File review unavailable (${error.code ?? error.message ?? 'request_failed'}). Your private draft remains saved.`;
    } finally {if (token === generation) {busy = false; reflect();}}
  }
  function renderRecords() {
    records.replaceChildren(); archiveRows = []; referencedRows = []; artifactRows = [];
    for (const [kind, files] of [['source', metadata.referencedFiles ?? []], ['archive', metadata.archiveFiles]]) {
      if (files.length) records.append(node('h5', kind === 'source' ? 'Source files' : 'Archived files'));
      for (const file of files) {
        const row = node('fieldset', '', 'publication-input-file');
        row.style.minWidth = '0';
        row.append(node('legend', file.title || file.path), node('small', `${file.path} · ${bytes(file.sizeBytes)}`));
        if (kind === 'source') {
          const source = node('a', 'View source file');
          source.href = file.url; source.target = '_blank'; source.rel = 'noopener noreferrer';
          row.append(source);
        }
        const fields = node('div', '', 'platform-actions');
        const license = node('select', ''); license.setAttribute('aria-label', `License for ${file.path}`);
        const empty = node('option', 'Choose license'); empty.value = ''; license.append(empty);
        for (const name of LICENSES) {const option = node('option', name); option.value = name; license.append(option);}
        license.value = LICENSES.includes(file.license) ? file.license : '';
        const attribution = node('input', ''); attribution.type = 'text'; attribution.maxLength = 2000;
        attribution.value = file.attribution || ''; attribution.setAttribute('aria-label', `Attribution for ${file.path}`);
        attribution.placeholder = 'Creator and source credit'; attribution.style.minWidth = '0';
        const ack = checkbox('I may share this exact file publicly.', `share-file-${file.referenceId ?? file.attachmentId}`);
        fields.append(label('License', license), label('Attribution', attribution)); row.append(fields, ack.label);
        if (!file.canPublish) {
          row.append(node('small', 'Dataset publication permission is required. Editing this publication does not grant that permission.'));
          for (const control of [license, attribution, ack.input]) control.dataset.locked = 'true';
        }
        const technical = node('details', ''); technical.append(node('summary', 'Pinned file details'),
          node('p', `Original file: ${file.sizeBytes.toLocaleString()} bytes${kind === 'archive' ? ', retained in full' : ', read from the public source when building'}.`),
          node('p', `Estimated embedded data: ${(4 * Math.ceil(file.sizeBytes / 3)).toLocaleString()} bytes before HTML and runtime code.`),
          node('p', `Dataset ${file.datasetId} · ${kind === 'source' ? `source edition ${file.sourceVersion}` : `version ${file.datasetVersionId}`}`), node('p', `SHA-256 ${file.checksumSha256}`));
        row.append(technical); records.append(row);
        for (const control of [license, attribution, ack.input]) control.addEventListener('change', changed);
        attribution.addEventListener('input', changed);
        (kind === 'source' ? referencedRows : archiveRows).push({file, license, attribution, ack: ack.input});
      }
    }
    if (metadata.artifacts.length) records.append(node('h5', 'Studio maps'));
    for (const file of metadata.artifacts) {
      const row = node('fieldset', '', 'publication-input-artifact'); row.style.minWidth = '0';
      row.append(node('legend', file.path || 'Studio map'));
      const release = node('select', ''); release.setAttribute('aria-label', `Public map release for ${file.path}`);
      const empty = node('option', 'Choose an approved public map release'); empty.value = ''; release.append(empty);
      for (const saved of file.releases.filter(item => !item.revokedAt)) {
        const option = node('option', `${saved.license} · ${saved.attribution}`); option.value = saved.id; release.append(option);
      }
      const ack = checkbox('Use this approved map release in the public output.', `share-map-${file.artifactId}`);
      row.append(label('Public release', release), ack.label);
      if (!file.canPublish || release.options.length === 1) {
        row.append(node('p', 'This map needs an approved public release. Open the map’s sharing controls, review its layers and approve its release first.'));
        if (file.projectId) {
          const link = node('a', 'Open map resources');
          link.href = projectHref(file.projectId, {management: 'resources', fragment: `resource-${file.resourceId}`});
          link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link);
          row.append(node('small', 'Open the map resource, choose Portable interactive HTML and inspect this edition under Public Artifact releases.'));
        }
      }
      if (!file.canPublish) for (const control of [release, ack.input]) control.dataset.locked = 'true';
      for (const control of [release, ack.input]) control.addEventListener('change', changed);
      artifactRows.push({file, release, ack: ack.input}); records.append(row);
    }
    if (linkedFiles().length || metadata.artifacts.length) records.append(approve);
    if (metadata.approvals.length) {
      const history = node('details', ''); history.append(node('summary', 'Saved sharing approvals'));
      for (const approval of metadata.approvals) {
        const row = node('div', '', 'publication-input-approval-row');
        row.append(node('small', `${approval.manifest.outputProfile} · ${approval.revoked ? 'revoked' : 'saved'}`));
        const use = button('Use this approval', () => {
          if (busy || !matches(approval)) return;
          selectedApproval = approval;
          approvalStatus.textContent = 'This exact input sharing approval is selected. Publishing still requires the final publication review.';
          onChange({outputProfile: profile.value, sizeAcknowledgment: size.input.checked ? 'allow-up-to-96-mib-output' : null,
            distributionApprovalId: approval.id}); reflect();
        });
        use.dataset.approvalId = approval.id;
        row.append(use);
        if (!approval.revoked && canManage && typeof adapter.revokePublicationInputDistribution === 'function') {
          const ack = checkbox('Revoke this approval', `revoke-${approval.id}`);
          const revoke = button('Revoke', () => revokeApproval(approval, ack.input.checked)); row.append(ack.label, revoke);
        }
        const technical = node('details', ''); technical.append(node('summary', 'Approval details'),
          node('p', `Approval ${approval.id}`), node('p', `SHA-256 ${approval.checksum}`),
          node('p', `Compiler ${approval.manifest.compilerImageDigest}`)); row.append(technical); history.append(row);
      }
      records.append(history);
    }
  }
  async function approveInputs() {
    if (approve.disabled || busy) return;
    const token = generation, mounted = root.isConnected;
    busy = true; reflect(); status.textContent = 'Saving this exact input sharing approval…';
    try {
      pendingApprovalId ??= globalThis.crypto.randomUUID();
      const approval = await adapter.createPublicationInputDistribution(projectId, sourceProjectId, sourceRevisionId, {
        approvalId: pendingApprovalId, artifactInputId, outputProfile: profile.value,
        archiveRights: archiveRows.map(row => ({attachmentId: row.file.attachmentId, relativePath: row.file.path,
          license: row.license.value, attribution: row.attribution.value.trim(), acknowledgment: 'publish-exact-archive-file'})),
        ...(referencedRows.length ? {referencedRights: referencedRows.map(row => ({referenceId: row.file.referenceId, relativePath: row.file.path,
          license: row.license.value, attribution: row.attribution.value.trim(), acknowledgment: 'publish-exact-referenced-file'}))} : {}),
        artifactReleases: artifactRows.map(row => ({artifactId: row.file.artifactId, version: row.file.version,
          releaseId: row.release.value, acknowledgment: 'publish-exact-map-artifact'}))
      });
      if (token !== generation || mounted && !root.isConnected) return;
      if (!matches(approval)) throw Error('Saved approval does not match this revision and output selection.');
      selectedApproval = approval;
      pendingApprovalId = null;
      metadata.approvals = [approval, ...metadata.approvals.filter(item => item.id !== approval.id)];
      approvalStatus.textContent = 'Input sharing approved. Review the completed publication before publishing.';
      onChange({outputProfile: profile.value, sizeAcknowledgment: size.input.checked ? 'allow-up-to-96-mib-output' : null,
        distributionApprovalId: approval.id}); renderRecords(); status.textContent = 'Saved this exact sharing decision. Nothing has been published.';
    } catch (error) {
      if (token === generation) {uncertain = true; selectedApproval = null;
        onChange({outputProfile: profile.value, distributionApprovalId: null});
        status.textContent = `Sharing approval could not be confirmed (${error.code ?? error.message ?? 'request_failed'}). Check saved sharing approvals before another request.`;}
    } finally {if (token === generation) {busy = false; reflect();}}
  }
  async function revokeApproval(approval, acknowledged) {
    if (busy || !canManage || !acknowledged) return;
    const token = generation, mounted = root.isConnected;
    busy = true; reflect(); status.textContent = 'Revoking the selected input sharing approval…';
    try {
      await adapter.revokePublicationInputDistribution(projectId, sourceProjectId, sourceRevisionId, approval.id);
      if (token !== generation || mounted && !root.isConnected) return;
      approval.revoked = true;
      if (selectedApproval?.id === approval.id) {selectedApproval = null; onChange({outputProfile: profile.value, distributionApprovalId: null});}
      renderRecords(); status.textContent = 'Sharing approval revoked. Your private saved files and draft remain available.';
    } catch (error) {
      if (token === generation) {uncertain = true; selectedApproval = null;
        onChange({outputProfile: profile.value, distributionApprovalId: null});
        status.textContent = `Revocation could not be confirmed (${error.code ?? error.message ?? 'request_failed'}). Check saved sharing approvals.`;}
    } finally {if (token === generation) {busy = false; reflect();}}
  }
  profile.addEventListener('change', () => {size.input.checked = false; changed();});
  size.input.addEventListener('change', changed);
  root.getBuildOptions = ({purpose = 'release_candidate'} = {}) => {
    if (profile.value === 'archive-96m' && !size.input.checked) throw Error('Allow the larger saved output before building.');
    return {...(profile.value === 'archive-96m' ? {outputProfile: profile.value, sizeAcknowledgment: 'allow-up-to-96-mib-output'} : {}),
      ...(purpose !== 'preview' && selectedApproval && matches(selectedApproval) ? {distributionApprovalId: selectedApproval.id} : {})};
  };
  root.getSelectedApproval = () => selectedApproval && matches(selectedApproval) ? selectedApproval : null;
  root.ensureReviewed = async () => {
    if (!metadata) await load();
    if (!metadata || uncertain) throw Error('Review the linked files and their saved sharing approvals first.');
    return {requiresApproval: linkedFiles().length > 0 || metadata.artifacts.length > 0,
      distributionApprovalId: root.getSelectedApproval()?.id ?? null};
  };
  root.matchesBuild = build => !!metadata && build.sourceRevisionId === sourceRevisionId &&
    build.request?.sourceManifestChecksumSha256 === metadata.sourceManifestChecksumSha256 &&
    build.request?.compilerImageDigest === metadata.compilerImageDigest &&
    (build.request?.outputProfile ?? 'default-32m') === profile.value &&
    (build.request?.artifactInputsChecksumSha256 ?? null) === artifactInputsChecksumSha256;
  root.isBuildAllowed = () => profile.value !== 'archive-96m' || size.input.checked;
  root.setBuildLocked = value => {buildLocked = !!value; reflect();};
  root.setContext = value => {
    generation++; busy = uncertain = false; metadata = selectedApproval = pendingApprovalId = null;
    sourceRevisionId = value.sourceRevisionId; artifactInputId = value.artifactInputId ?? null;
    artifactInputsChecksumSha256 = value.artifactInputsChecksumSha256 ?? null;
    buildJobId = value.buildJobId ?? null;
    profile.value = value.outputProfile ?? 'default-32m'; size.input.checked = false;
    records.replaceChildren(); archiveRows = []; referencedRows = []; artifactRows = []; approvalStatus.textContent = '';
    status.textContent = 'Review linked files before sharing publicly. Private previews do not require public sharing approval.';
    onChange({outputProfile: profile.value, distributionApprovalId: null}); reflect();
  };
  reflect(); return root;
}
function bytes(value) {return `${Number((value / 1024 / 1024).toFixed(1)).toLocaleString()} MiB`;}
function node(tag, value, className = '') {const result = document.createElement(tag); result.textContent = value; result.className = className; return result;}
function button(title, action) {const result = node('button', title, 'platform-button secondary'); result.type = 'button'; result.addEventListener('click', action); return result;}
function label(title, control) {const result = node('label', title); result.append(control); return result;}
function checkbox(title, name) {const input = node('input', ''); input.type = 'checkbox'; input.name = name; const result = label(title, input); result.prepend(input); return {input, label: result};}
