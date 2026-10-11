import {PublicationDestinationForm} from './PublicationDestinationForm.js';
import {PublicationInputDistribution} from './PublicationInputDistribution.js';

/** Review, preview, and approve exact output; a queue acknowledgement is not a live release. */
export function FrameworkPublications({adapter, projectId, sourceProjectId, mode = 'all', onConfigure}) {
  const root = node("section", ""); root.className = "framework-publications";
  const feedback = node("p", ""); feedback.setAttribute("role", "status");
  const content = node("div", "");
  let busy = false, pendingReview = null, pendingDestination = null, savedBuilds = [];
  const reload = button(mode === 'addresses' ? 'Reload addresses' : "Reload publication reviews", () => load());
  root.append(node("h4", mode === 'addresses' ? 'Public addresses' : "Publish"), feedback, content, reload);
  root.refreshStatus = status => {if (!busy) show(status, savedBuilds);};
  async function load() {
    if (busy) return;
    busy = true; reload.disabled = true; content.replaceChildren();
    try {
      const [status, builds] = await Promise.all([
        adapter.getFrameworkPublications(projectId, sourceProjectId),
        mode === 'addresses' ? [] : adapter.listObservableBuildJobs(projectId, sourceProjectId, {limit: 25, offset: 0})
      ]);
      savedBuilds = builds;
      show(status, builds);
    } catch {content.replaceChildren(); feedback.textContent = "Publication status is unavailable. No publication was requested.";}
    finally {busy = false; reload.disabled = false;}
  }
  function show(status, builds) {
    if (status.sourceProjectId !== sourceProjectId || builds.some(build => build.sourceProjectId !== sourceProjectId)) throw new Error("publication_scope_mismatch");
    content.replaceChildren();
    feedback.textContent = mode === 'addresses' ? 'Configure where this publication can be released. Reserving an address keeps your draft private.' : status.dispatchConfigured
      ? "Choose a destination and saved build, then review the release."
      : "The deployment worker is not configured. You can prepare a review, but nothing can be published yet.";
    if (pendingReview && status.reviews.some(review => review.id === pendingReview.id)) pendingReview = null;
    if (pendingDestination && status.mounts.some(mount => mount.id === pendingDestination.id)) pendingDestination = null;
    const eligible = builds.filter(build => build.state === "succeeded" && build.resultChecksumSha256);
    const mounts = status.mounts.filter(mount => mount.enabled);
    const destinations = node("section", ""); destinations.className = "publication-destinations";
    destinations.append(node("h5", "Public addresses"));
    if (!mounts.length) destinations.append(node("p", "No address configured for this publication."));
    for (const mount of mounts) {
      const latest = status.reviews.filter(review => review.mountId === mount.id && review.deployment?.stage === "deployed")
        .sort((a,b) => Date.parse(b.deployment.updatedAt) - Date.parse(a.deployment.updatedAt))[0];
      const row = node("div", ""); row.className = "publication-destination-row";
      const address = node("a", mount.url); address.href = mount.url; address.target = "_blank"; address.rel = "noopener noreferrer";
      const state = node("small", latest ? `Last released ${new Date(latest.deployment.updatedAt).toLocaleString()}` : "Authorized address · no Studio release recorded");
      const copy = button("Copy URL", async () => {
        try {await globalThis.navigator.clipboard.writeText(mount.url); feedback.textContent = "Public address copied.";}
        catch {feedback.textContent = `Public address: ${mount.url}`;}
      });
      row.append(address, state, copy); destinations.append(row);
    }
    if (status.canConfigureDestinations && typeof adapter.reserveFrameworkPublicationDestination === 'function') {
      const configure = node('details', ''); configure.open = !mounts.length;
      configure.append(node('summary', 'Add address'), PublicationDestinationForm({origins: status.origins, onReserve: async ({originId, slug}) => {
        if (busy) return;
        const identity = `${originId}:${slug}`;
        if (pendingDestination?.identity !== identity) pendingDestination = {identity, id: globalThis.crypto.randomUUID()};
        const reserved = await act(() => adapter.reserveFrameworkPublicationDestination(projectId, sourceProjectId, {
          reservationId: pendingDestination.id, originId, slug
        }), builds);
        if (reserved) root.dispatchEvent(new root.ownerDocument.defaultView.CustomEvent('opengeo-publication-destinations-changed', {bubbles: true, detail: reserved}));
      }}));
      destinations.append(configure);
    } else if (!mounts.length) destinations.append(node('p', 'An administrator must enable a public hosting prefix before an address can be reserved.'));
    destinations.append(node('p', 'Each address belongs to one publication. Choose a different name in the same hosting folder, or another approved hosting folder. Root addresses and new hosting folders require administrator configuration.'));
    if (mode !== 'releases') content.append(destinations);
    if (mode === 'addresses') return;
    if (mode === 'releases' && onConfigure) content.append(button('Configure public addresses…', onConfigure));
    if (status.canPublish && eligible.length && mounts.length) {
      const buildChoice = node("select", ""); buildChoice.setAttribute("aria-label", "Successful build to publish");
      const mountChoice = node("select", ""); mountChoice.setAttribute("aria-label", "Publication destination");
      for (const build of eligible) {const option = node("option", `Revision ${build.sourceRevisionNumber}${build.updatedAt ? ` · ${new Date(build.updatedAt).toLocaleString()}` : ""}`); option.value = build.id; option.title = build.id; buildChoice.append(option);}
      for (const mount of mounts) {const option = node("option", mount.url); option.value = mount.id; mountChoice.append(option);}
      const selectedBuild = () => eligible.find(record => record.id === buildChoice.value);
      const inputDistribution = PublicationInputDistribution({adapter, projectId, sourceProjectId,
        sourceRevisionId: selectedBuild().sourceRevisionId, buildJobId: selectedBuild().id,
        artifactInputsChecksumSha256: selectedBuild().request?.artifactInputsChecksumSha256 ?? null,
        canManage: status.canPublish});
      inputDistribution.setContext({sourceRevisionId: selectedBuild().sourceRevisionId, buildJobId: selectedBuild().id,
        artifactInputsChecksumSha256: selectedBuild().request?.artifactInputsChecksumSha256,
        outputProfile: selectedBuild().request?.outputProfile ?? 'default-32m'});
      buildChoice.addEventListener('change', () => {
        const build = selectedBuild();
        inputDistribution.setContext({sourceRevisionId: build.sourceRevisionId, buildJobId: build.id,
          artifactInputsChecksumSha256: build.request?.artifactInputsChecksumSha256,
          outputProfile: build.request?.outputProfile ?? 'default-32m'});
      });
      const review = button("Prepare publication review", async () => {
        if (busy || !status.canPublish) return;
        const build = selectedBuild();
        let distributionApprovalId = null;
        if (build.sourceRevisionId && typeof adapter.getPublicationInputDistributions === 'function') {
          busy = true; review.disabled = buildChoice.disabled = mountChoice.disabled = true;
          try {
            const inputReview = await inputDistribution.ensureReviewed();
            if (build.id !== buildChoice.value || !inputDistribution.matchesBuild(build)) throw Error('Select the saved build again.');
            distributionApprovalId = inputReview.distributionApprovalId;
            if (inputReview.requiresApproval && !distributionApprovalId) {
              inputDistribution.open = true;
              feedback.textContent = 'Approve the exact linked files and public map releases below, then prepare the publication review. The existing build will be reused.';
              return;
            }
          } catch (error) {inputDistribution.open = true; feedback.textContent = `Review the saved build’s linked files first (${error.code ?? error.message}).`; return;}
          finally {busy = false; review.disabled = buildChoice.disabled = mountChoice.disabled = false;}
        }
        const identity = `${build.id}:${mountChoice.value}:${build.resultChecksumSha256}:${distributionApprovalId ?? ''}`;
        if (pendingReview?.identity !== identity) pendingReview = {identity, id: globalThis.crypto.randomUUID()};
        await act(() => adapter.reviewFrameworkPublication(projectId, sourceProjectId, {
          reviewId: pendingReview.id, buildJobId: build.id, mountId: mountChoice.value,
          resultChecksumSha256: build.resultChecksumSha256,
          ...(distributionApprovalId ? {distributionApprovalId} : {})
        }), builds);
      });
      const form = node("fieldset", ""); form.className = "publication-release-form";
      const destination = node("label", "Destination"), saved = node("label", "Saved build");
      destination.append(mountChoice); saved.append(buildChoice);
      form.append(node("legend", "New release"), destination, saved, inputDistribution, review);
      content.append(form);
    } else content.append(node("p", !mounts.length ? "No publication destination has been authorized for this project." : "A successful build with approved source rights and publication permission is required."));
    const history = node("section", ""); history.className = "publication-release-history";
    history.append(node("h5", "Releases"));
    content.append(history);
    for (const [index, review] of status.reviews.entries()) {
      const card = node("details", "");
      const stage = review.deployment?.stage ?? (review.approvedAt ? "approved" : "review");
      card.open = index === 0 && stage !== "deployed";
      card.append(node("summary", `${review.url} · ${stage.replaceAll("_", " ")}`));
      const technical = node("details", "");
      technical.append(node("summary", "Release details"), node("p", `Build ${review.buildJobId} · review ${review.id}`),
        node("p", `Output SHA-256: ${review.outputTreeChecksumSha256}`),
        node("p", `Prior release: ${review.previousReleasePrefix} · generation ${review.expectedGeneration}`));
      card.append(technical,
        node("p", review.approvedAt ? `Approved ${review.approvedAt}.${review.deployment?.stage === "deployed" ? "" : " Approval is not proof of deployment."}` : `Not approved. Review expires ${review.expiresAt}.`));
      if (review.deployment) {
        const job = review.deployment;
        const message = job.stage === "deployed" ? `Published release: ${job.releasePrefix}`
          : job.stage === "activating" ? "Files verified. Waiting for public delivery activation and cache invalidation."
          : job.stage === "needs_attention" ? `Publication needs attention: ${job.errorCode ?? "unknown"}. The saved job can be resumed after resolution.`
          : `Publication ${job.stage}: ${job.completedFiles} of ${job.totalFiles ?? "pending inventory"} files retained.`;
        card.append(node("p", `${message} Last update: ${job.updatedAt}`));
      }
      if (review.deployment?.stage === "deployed") {
        const link = node("a", "Open published project"); link.href = review.url;
        link.target = "_blank"; link.rel = "noopener noreferrer";
        let rollbackInputs = null, rollbackBuild = null;
        const restore = button("Prepare rollback to this build", async () => {
          if (busy || !status.canPublish) return;
          let distributionApprovalId = null;
          if (typeof adapter.getPublicationInputDistributions === 'function' && typeof adapter.getObservableBuildJob === 'function') {
            busy = true; restore.disabled = true;
            try {
              rollbackBuild ??= builds.find(build => build.id === review.buildJobId) ?? await adapter.getObservableBuildJob(projectId, review.buildJobId);
              if (!rollbackInputs) {
                rollbackInputs = PublicationInputDistribution({adapter, projectId, sourceProjectId,
                  sourceRevisionId: rollbackBuild.sourceRevisionId, buildJobId: rollbackBuild.id,
                  artifactInputsChecksumSha256: rollbackBuild.request?.artifactInputsChecksumSha256 ?? null, canManage: status.canPublish});
                rollbackInputs.setContext({sourceRevisionId: rollbackBuild.sourceRevisionId, buildJobId: rollbackBuild.id,
                  artifactInputsChecksumSha256: rollbackBuild.request?.artifactInputsChecksumSha256,
                  outputProfile: rollbackBuild.request?.outputProfile ?? 'default-32m'});
                card.append(rollbackInputs);
              }
              const inputReview = await rollbackInputs.ensureReviewed();
              if (!rollbackInputs.matchesBuild(rollbackBuild)) throw Error('The input review does not match this saved build.');
              distributionApprovalId = inputReview.distributionApprovalId;
              if (inputReview.requiresApproval && !distributionApprovalId) {
                rollbackInputs.open = true;
                feedback.textContent = 'Review this earlier build’s exact files and public map releases below before preparing its rollback. The saved build will be reused.';
                return;
              }
            } catch (error) {feedback.textContent = `Rollback input review unavailable (${error.code ?? error.message}). Nothing was published.`; return;}
            finally {busy = false; restore.disabled = false;}
          }
          const identity = `rollback:${review.id}:${distributionApprovalId ?? ''}`;
          if (pendingReview?.identity !== identity) pendingReview = {identity, id: globalThis.crypto.randomUUID()};
          await act(() => adapter.reviewFrameworkPublication(projectId, sourceProjectId, {
            reviewId: pendingReview.id, buildJobId: review.buildJobId, mountId: review.mountId,
            resultChecksumSha256: review.resultChecksumSha256,
            ...(distributionApprovalId ? {distributionApprovalId} : {})
          }), builds);
        });
        restore.disabled = !status.canPublish || !mounts.some(mount => mount.id === review.mountId);
        card.append(link, node("p", "Rollback prepares a new review of this project's exact earlier build. Preview and approval are required again; other projects keep their current files."), restore);
        history.append(card);
        continue;
      }
      const preview = button("Preview this exact build", async () => {
        if (busy) return;
        busy = true; preview.disabled = true;
        try {const result = await adapter.createObservablePreviewCapability(projectId, review.buildJobId); globalThis.location.assign(result.authorizeUrl);}
        catch {feedback.textContent = "Private preview unavailable. Nothing was published.";}
        finally {busy = false; preview.disabled = false;}
      });
      preview.disabled = typeof adapter.createObservablePreviewCapability !== "function";
      const acknowledgment = node("input", ""); acknowledgment.type = "checkbox";
      acknowledgment.name = 'approve-publication-output';
      const label = node("label", " I reviewed this exact preview and approve making its output public."); label.prepend(acknowledgment);
      const approve = button(review.approvedAt ? "Resume approved publication" : "Approve and publish", async () => {
        if (busy || !status.canPublish || !status.dispatchConfigured || !acknowledgment.checked || approve.disabled) return;
        await act(() => adapter.approveFrameworkPublication(projectId, sourceProjectId, review.id), builds);
      });
      approve.disabled = !status.canPublish || !status.dispatchConfigured || (!review.approvedAt && Date.parse(review.expiresAt) <= Date.now());
      card.append(preview, label, approve); history.append(card);
    }
  }
  async function act(operation, builds) {
    busy = true; reload.disabled = true;
    for (const control of content.querySelectorAll("button, select, input")) control.disabled = true;
    try {const status = await operation(); show(status, builds); return status;}
    catch (error) {
      content.replaceChildren(); feedback.textContent = error?.code === "framework_source_rights_approval_required"
        ? "Source publication rights have not been approved for this build. In Files, open Revision settings and data references, record your source publication rights, then save the draft. Nothing was published."
        : ['publication_input_distribution_approval_required', 'publication_input_distribution_approval_invalid', 'publication_input_distribution_revoked'].includes(error?.code)
        ? 'This release needs a current approval for its exact linked files and map releases. Reload reviews, select the saved build and review its data files. Nothing was published.'
        : `Publication request could not be confirmed (${error?.code ?? "request_failed"}). Reload reviews to recover its saved state; no replacement build was requested.`;
    } finally {busy = false; reload.disabled = false;}
  }
  if (typeof adapter.getFrameworkPublications === "function") void load();
  else {reload.disabled = true; feedback.textContent = "This deployment cannot yet manage Framework publication reviews.";}
  return root;
}
function node(tag, value) {const element = document.createElement(tag); element.textContent = value; return element;}
function button(title, handler) {const element = node("button", title); element.type = "button"; element.className = "platform-button secondary"; element.addEventListener("click", handler); return element;}
