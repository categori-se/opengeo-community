import {openReleaseDraftStore} from "../lib/releaseDraftStore.js";
import {releaseDraftGuard} from "../lib/releaseDraftGuard.js";
export function ArtifactReleases({adapter}) {
  const root = document.createElement("section"), status = document.createElement("p"), rows = document.createElement("ul");
  root.className = "artifact-releases";
  status.setAttribute("role", "status");
  let releaseIntent = null, draftStore = null, draftKey = null, draftVersion = null;
  let target = null, version = null, canPublish = false, busy = false, offset = 0;
  let representation = null, canShare = false, shareIntent = null, shareContext = null, shareKey = null, shareVersion = null;
  const node = (tag, text = "") => {const element = document.createElement(tag); element.textContent = text; return element;};
  const button = (text, action) => {const element = node("button", text); element.type = "button"; element.addEventListener("click", action); return element;};
  const load = button("Load public releases", () => act(() => history(false)));
  const more = button("Load more public releases", () => act(() => history(true))); more.hidden = true;
  const publish = button("Publish inspected edition", () => {if (canPublish && version !== null && !busy && !shareDialog.open) void openDraft();});
  const dialog = node("dialog"), form = node("form");
  const title = node("input"), attribution = node("textarea"), license = node("select");
  title.maxLength = 200; attribution.maxLength = 2000; title.required = attribution.required = true;
  for (const [label, field] of [["Release title", title], ["Output attribution", attribution], ["Output license", license]]) {
    field.setAttribute("aria-label", label); const wrapper = node("label", label); wrapper.append(field); form.append(wrapper);
  }
  const empty = node("option", "Choose the output license"); empty.value = ""; license.append(empty); license.required = true;
  for (const value of ["CC0-1.0", "CC-BY-4.0", "PDDL-1.0"]) {const option = node("option", value); option.value = value; license.append(option);}
  const feedback = node("p"); feedback.setAttribute("role", "status");
  const submit = node("button", "Publish this edition publicly"); submit.type = "submit";
  const discard = button("Discard release draft", () => {if (!busy) close();});
  form.prepend(node("p", "Publish the inspected edition with these output terms. Eligible public Collections containing this Project can show the release. Source and Style eligibility are checked before publishing."));
  form.append(submit, discard, feedback); dialog.append(form);
  const supportsShares = ["listArtifactShares", "createArtifactShare", "revokeArtifactShare", "protectedArtifactShareUrl"].every(name => typeof adapter[name] === "function");
  const share = button("Share with a password", () => {if (canShare && version !== null && !busy && !dialog.open) void openShareDraft();});
  const shareDialog = node("dialog"), shareForm = node("form"), shareTitle = node("input"), password = node("input"), shareFeedback = node("p");
  shareDialog.className = "artifact-password-share-draft"; shareForm.autocomplete = "off";
  shareTitle.required = password.required = true; shareTitle.maxLength = 200;
  password.type = "password"; password.minLength = 12; password.maxLength = 128; password.autocomplete = "off";
  for (const [label, field] of [["Share title", shareTitle], ["Share password", password]]) {
    field.setAttribute("aria-label", label); const wrapper = node("label", label); wrapper.append(field); shareForm.append(wrapper);
  }
  shareFeedback.setAttribute("role", "status");
  const shareSubmit = node("button", "Create password share"); shareSubmit.type = "submit";
  shareForm.prepend(node("p", "Share the inspected compiled portable map edition. Recipients enter the password without signing in to Studio. Included sources must remain eligible for public access. Use a password of 12 to 128 characters; it is kept only in this open form."));
  shareForm.append(shareSubmit, button("Discard password share", () => {if (!busy) closeShare();}), shareFeedback); shareDialog.append(shareForm);
  const shareHistoryPanel = node("section"), shareRows = node("ul"), shareStatus = node("p");
  shareHistoryPanel.className = "artifact-password-shares"; shareHistoryPanel.hidden = true;
  shareStatus.setAttribute("role", "status");
  shareHistoryPanel.append(node("h5", "Password shares"), node("p", "Each shared output allows up to five access attempts in fifteen minutes. Revoking blocks new opens; issued links can work for up to 15 minutes, and downloaded copies remain available."), shareRows, shareStatus);
  root.append(node("h4", "Public Artifact releases"), node("p", "Releases pin an Artifact edition. Revoking one removes its public access without deleting the Artifact."), load, publish, share, rows, more, shareHistoryPanel, status, dialog, shareDialog);
  const guard = releaseDraftGuard(root, dialog, () => {
    feedback.textContent = "Publish or discard this release draft before leaving or changing the Artifact.";
  });
  const shareGuard = releaseDraftGuard(root, shareDialog, () => {shareFeedback.textContent = "Create or discard this password share before leaving or changing the Artifact.";});
  root.shouldBlockNavigation = () => guard.pending() || shareGuard.pending();
  root.checkDraft = () => guard.check() || shareGuard.check();
  dialog.addEventListener("cancel", event => {event.preventDefault(); feedback.textContent = "Publish or discard this release draft before closing.";});
  shareDialog.addEventListener("cancel", event => {event.preventDefault(); shareFeedback.textContent = "Create or discard this password share before closing.";});
  async function captureShareContext() {
    if (typeof adapter.tokenProvider !== "function" && typeof adapter.organizationProvider !== "function") return null;
    if (typeof adapter.tokenProvider !== "function" || typeof adapter.organizationProvider !== "function" || typeof adapter.assertCollectionContext !== "function") throw Error("Share account context unavailable");
    const token = await adapter.tokenProvider(), organization = String(await adapter.organizationProvider()).toLowerCase();
    const context = Object.freeze({tokenProvider: adapter.tokenProvider, organizationProvider: adapter.organizationProvider, baseUrl: adapter.baseUrl, token, organization});
    await adapter.assertCollectionContext(context); return context;
  }
  async function openShareDraft() {
    shareKey = crypto.randomUUID(); shareVersion = version; shareContext = null; shareIntent = null;
    shareGuard.open(); shareDialog.showModal(); busy = true; update();
    shareFeedback.textContent = "Checking your sign-in and account…";
    try {shareContext = await captureShareContext(); shareFeedback.textContent = "Review the title and password. Nothing has been shared.";}
    catch {closeShare(); status.textContent = "Your sign-in or account could not be checked. Reload releases before sharing.";}
    finally {busy = false; update();}
  }
  function closeShare() {
    if (shareDialog.open) shareDialog.close(); shareForm.reset(); password.value = "";
    shareIntent = shareContext = shareKey = shareVersion = null; shareFeedback.textContent = ""; shareSubmit.textContent = "Create password share";
    update();
  }
  shareForm.addEventListener("submit", event => {
    event.preventDefault(); if (busy || !shareForm.reportValidity()) return;
    if (!shareIntent && (!shareTitle.value.trim() || password.value.length < 12 || password.value.length > 128)) {
      shareFeedback.textContent = "Enter a title and a password of 12 to 128 characters."; return;
    }
    shareIntent ??= Object.freeze({identity: target, context: shareContext, draft: Object.freeze({creation_key: shareKey,
      version_number: shareVersion, title: shareTitle.value.trim(), password: password.value})});
    void shareAct(async () => {
      const intent = shareIntent;
      await adapter.assertCollectionContext?.(intent.context);
      if (!root.isConnected || target !== intent.identity) throw Object.assign(Error("Share target changed"), {code: "share_context_changed"});
      const receipt = await adapter.createArtifactShare(intent.identity, intent.draft, {context: intent.context});
      closeShare(); await refreshCommittedHistory(`Password share created: ${receipt.id}.`);
    });
  });
  async function shareAct(action) {
    if (busy || !target || !root.isConnected) return;
    busy = true; update(); status.textContent = "Saving password share…";
    try {await action();}
    catch (error) {
      if (/context_changed|scope_changed/.test(error?.code ?? "")) {
        closeShare(); shareRows.replaceChildren(); canShare = false;
        status.textContent = "Your sign-in, account or Artifact changed. The password draft was cleared. Reload releases before continuing.";
      } else {
        const reason = {
          artifact_source_not_public: "Nothing was shared. Included Catalog sources need current public access and published metadata with terms and attribution.",
          artifact_public_sources_unsupported: "Nothing was shared. This edition includes a source or Style that cannot be shared yet.",
          artifact_public_origin_invalid: "Nothing was shared. Inspect the retained edition before trying again."
        }[error?.code];
        status.textContent = reason ?? (shareIntent ? "The share response could not be confirmed. Retry to recover the same share, or discard this password draft and reload history." : "The share action could not be confirmed. Reload releases before retrying.");
        if (shareIntent) {shareSubmit.textContent = "Retry password share"; shareFeedback.textContent = status.textContent;}
      }
    }
    finally {busy = false; update();}
  }
  async function shareHistory(identity) {
    canShare = false; shareHistoryPanel.hidden = false; shareStatus.textContent = "Loading password shares…";
    try {
      const context = await captureShareContext();
      const page = await adapter.listArtifactShares(identity, {limit: 20, offset: 0, context});
      await adapter.assertCollectionContext?.(context);
      if (target !== identity || !root.isConnected) return;
      const nextRows = document.createDocumentFragment();
      for (const record of page.records) {
        const row = node("li", `${record.title} · v${record.version_number} · ${record.revoked_at ? "Revoked" : "Password protected"} `);
        if (!record.revoked_at) {
          const link = node("a", "Open password-protected output"); link.href = await adapter.protectedArtifactShareUrl(record.id);
          await adapter.assertCollectionContext?.(context);
          if (target !== identity || !root.isConnected) return;
          link.target = "_blank"; link.rel = "noopener noreferrer"; row.append(link);
          if (page.can_publish) row.append(button("Revoke password share", () => shareAct(async () => {
            await adapter.revokeArtifactShare(record.id, {context});
            row.replaceChildren(node("span", `${record.title} · v${record.version_number} · Revoked`));
            await refreshCommittedHistory("Password share revoked. Issued links can work for up to 15 minutes; downloaded copies remain available.");
          })));
        }
        nextRows.append(row);
      }
      shareRows.replaceChildren(nextRows); canShare = page.can_publish;
      shareStatus.textContent = page.records.length ? `Saved password shares loaded.${page.has_more ? " Additional shares remain unlisted." : ""}` : "No password shares yet.";
    } catch {
      if (target !== identity || !root.isConnected) return;
      shareRows.replaceChildren(); shareStatus.textContent = "Password share history could not be loaded. Public release history remains available.";
    }
  }
  let wasConnected = root.isConnected;
  const secretCleanup = new root.ownerDocument.defaultView.MutationObserver(() => {
    if (root.isConnected) wasConnected = true;
    else if (wasConnected) {closeShare(); secretCleanup.disconnect();}
  });
  secretCleanup.observe(root.ownerDocument.documentElement, {childList: true, subtree: true});
  async function openDraft() {
    guard.open(); dialog.showModal(); busy = true; update();
    draftKey = crypto.randomUUID(); draftVersion = version; draftStore = null;
    feedback.textContent = "Checking for a saved release draft…";
    try {
      draftStore = await openReleaseDraftStore(adapter, root.ownerDocument.defaultView, target);
      if (!root.isConnected) return;
      const stored = draftStore?.read();
      if (stored) {
        title.value = stored.draft.title; attribution.value = stored.draft.attribution; license.value = stored.draft.license;
        draftKey = stored.draft.creation_key; draftVersion = stored.draft.version_number;
        if (stored.submitted) releaseIntent = {identity: target, draft: stored.draft};
        submit.textContent = stored.submitted ? "Retry release" : "Publish this edition publicly";
        feedback.textContent = `Restored release draft for edition v${draftVersion}. Review it before publishing; nothing has been sent.`;
      } else feedback.textContent = draftStore ? "Release draft recovery is available in this tab for 24 hours." : "This draft is kept only until reload. Review release history after reloading.";
    } catch {feedback.textContent = "This draft is kept only until reload. Review release history after reloading.";}
    finally {busy = false; update();}
  }
  function persistDraft() {
    const draft = releaseIntent?.draft ?? {creation_key: draftKey, version_number: draftVersion,
      title: title.value, license: license.value, attribution: attribution.value};
    if (draftStore && !draftStore.write(draft, Boolean(releaseIntent))) feedback.textContent = "This draft could not be kept across reloads. Keep this form open or review release history after reloading.";
  }
  form.addEventListener("input", persistDraft);
  form.addEventListener("change", persistDraft);
  function close() {
    draftStore?.clear(); draftStore = null; draftKey = draftVersion = null;
    dialog.close(); form.reset(); feedback.textContent = ""; releaseIntent = null;
    submit.textContent = "Publish this edition publicly";

  }
  form.addEventListener("submit", event => {
    event.preventDefault(); if (busy || !form.reportValidity()) return;
    releaseIntent ??= {identity: target, draft: {creation_key: draftKey,
      version_number: draftVersion, title: title.value.trim(), license: license.value,
      attribution: attribution.value.trim()}};
    persistDraft();
    void act(async () => {
      if (draftStore && !await draftStore.verify()) throw Error("Release account changed");
      const receipt = await adapter.createArtifactRelease(releaseIntent.identity, releaseIntent.draft);
      close(); await refreshCommittedHistory(`Public release created: ${receipt.id}.`);
    });
  });
  async function act(action) {
    if (busy || !target || !root.isConnected) return;
    busy = true; update(); status.textContent = "Loading…";
    try {await action();}
    catch (error) {
      const reason = {
        artifact_source_not_public: "Nothing was published. Each included Catalog source needs public access and published public metadata with terms, attribution and the exact source revision. Review its Catalog metadata before releasing this edition.",
        artifact_public_sources_unsupported: "Nothing was published. Use embedded versioned Catalog data or exact public XYZ/ImageServer references. Other sources and reusable Style references still need publication support.",
        artifact_public_origin_invalid: "Nothing was published. This edition no longer matches its retained Project record. Inspect the edition before trying again."
      }[error?.code];
      status.textContent = reason ?? (releaseIntent
        ? "The release response could not be confirmed. Retry to recover the same release, or discard this draft and review release history."
        : "Release action could not complete. Reload releases before retrying.");
      if (releaseIntent) submit.textContent = "Retry release";
      feedback.textContent = status.textContent;
    }
    finally {busy = false; update();}
  }
  async function refreshCommittedHistory(message) {
    try {
      await history(false);
      status.textContent = message;
    } catch {
      status.textContent = `${message} Release history could not refresh. Use Load public releases to refresh it.`;
    }
  }
  async function history(append) {
    const identity = target;
    const page = await adapter.listArtifactReleases(identity, {limit: 20, offset: append ? offset : 0});
    if (target !== identity || !root.isConnected) return;
    const nextRows = document.createDocumentFragment();
    for (const record of page.records) {
      const row = node("li", `${record.title} · v${record.version_number} · ${record.license} · ${record.revoked_at ? "Revoked" : "Released"} `);
      if (!record.revoked_at) {
        const link = node("a", "Open public output"); link.href = await adapter.publicArtifactReleaseUrl(record.id);
        if (target !== identity || !root.isConnected) return;
        link.target = "_blank"; link.rel = "noopener noreferrer"; row.append(link);
        const embed = node("details"), code = node("textarea"), frame = node("iframe");
        frame.src = link.href; frame.title = record.title; frame.loading = "lazy";
        frame.style.cssText = "width:100%;height:600px;border:0";
        code.value = frame.outerHTML; code.readOnly = true; code.rows = 3;
        code.setAttribute("aria-label", `Embed ${record.title}`);
        embed.append(node("summary", "Embed this release"),
          node("p", "Copy this HTML into a Publication. The release stays linked, so revoking it blocks future access."), code);
        row.append(embed);
        if (record.representation === "portable-map-html") {
          const staticLink = node("a", "Open static viewer"), staticUrl = new URL(link.href);
          staticUrl.pathname = staticUrl.pathname.replace(/\/view$/, "/static"); staticLink.href = staticUrl.href;
          staticLink.target = "_blank"; staticLink.rel = "noopener noreferrer";
          row.append(document.createTextNode(" · "), staticLink, node("span", " S3 delivery; issued links expire within 15 minutes."));
          const modulePath = new URL(link.href).pathname.replace(/\/view$/, "/module.mjs");
          const moduleUrl = new URL(`/api${modulePath}`, root.ownerDocument.location.origin).href;
          const consume = node("details"), example = node("textarea");
          example.value = `import {createView} from ${JSON.stringify(moduleUrl)};\n\ndisplay(createView({height: 600, invalidation}));`;
          example.readOnly = true; example.rows = 5;
          example.setAttribute("aria-label", `JavaScript import for ${record.title}`);
          const live = record.network_required === true;
          const html = node("a", live ? "Download live HTML" : "Download offline HTML"), module = node("a", "Download JavaScript module");
          html.href = new URL("map?download=true", link.href).href;
          module.href = `${moduleUrl}?download=true`;
          consume.append(node("summary", "Use in JavaScript or a notebook"),
            node("p", "Import and call createView in Observable Framework or Notebook Kit. For a classic Observable runtime, import the module's default define function. "
              + (live ? "This edition reads live source images and requires an internet connection. It does not automatically read captured backups. " : "Downloaded HTML and modules include the published map and viewer; keep them to open offline. ")
              + "Revocation blocks future endpoint reads; downloaded copies remain available."),
            example, html, document.createTextNode(" · "), module);
          row.append(consume);
          const native = node("details"), nativeExample = node("textarea");
          const nativeUrl = new URL(moduleUrl); nativeUrl.searchParams.set("mode", "native");
          const descriptor = node("a", "Open release descriptor");
          descriptor.href = new URL("descriptor", moduleUrl).href;
          descriptor.target = "_blank"; descriptor.rel = "noopener noreferrer";
          nativeExample.value = `import {createView} from ${JSON.stringify(nativeUrl.href)};\n\nconst lifetime = new AbortController();\nconst view = createView({maplibre, height: 600, signal: lifetime.signal});\ndocument.querySelector("#map").append(view);\nview.addEventListener("selectionchange", ({detail}) => {\n  console.log(detail.features);\n});\n// When removing this view: lifetime.abort();\n// Or call view.dispose().`;
          nativeExample.readOnly = true; nativeExample.rows = 10;
          nativeExample.setAttribute("aria-label", `Native map import for ${record.title}`);
          native.append(node("summary", "Use a native map in a website"),
            node("p", "Supply your page's MapLibre runtime and CSS, and an element with id map. The map inherits your page's fonts and colors. Use getLayers() for layer IDs, then setFilter() or setLayerVisibility() to connect article controls."),
            nativeExample,
            node("p", "This adapter supports portable GeoJSON maps and recorded public rasters. Native Notebook HTML and PMTiles are not currently supported; other outputs retain their isolated viewer. Removing a view requires dispose() or aborting its signal. The descriptor identifies this exact release without loading its map."),
            descriptor);
          row.append(native);
        }
        if (page.can_publish) row.append(button("Revoke public release", () => act(async () => {
          await adapter.revokeArtifactRelease(record.id);
          row.replaceChildren(node("span", `${record.title} · v${record.version_number} · ${record.license} · Revoked`));
          await refreshCommittedHistory("Public release revoked.");
        })));
      }
      nextRows.append(row);
    }
    if (!append) {rows.replaceChildren(); offset = 0;}
    rows.append(nextRows);
    canPublish = page.can_publish;
    offset += page.records.length; more.hidden = !page.has_more;
    status.textContent = offset ? "Saved public releases loaded. Public access still depends on current source eligibility." : "No public releases yet.";
    if (supportsShares && !append) await shareHistory(identity);
  }
  function update() {
    load.disabled = !target || busy; more.disabled = busy;
    publish.disabled = !canPublish || !target || version == null || busy;
    share.hidden = !supportsShares || representation !== "portable-map-html" || version == null;
    share.disabled = share.hidden || !canShare || busy;
    for (const element of [...rows.querySelectorAll("button"), ...form.querySelectorAll("button,input,select,textarea")]) element.disabled = busy;
    for (const field of [title, attribution, license]) field.disabled = busy || Boolean(releaseIntent);
    for (const control of [...shareRows.querySelectorAll("button"), ...shareForm.querySelectorAll("button,input")]) control.disabled = busy;
    for (const field of [shareTitle, password]) field.disabled = busy || Boolean(shareIntent);
  }
  root.setTarget = record => {
    if (guard.check()) return false;
    const identity = record?.id ?? null;
    const nextVersion = record?.version_number ?? null, nextRepresentation = record?.manifest?.representation ?? record?.representation ?? null;
    if (identity !== target || nextVersion !== version || nextRepresentation !== representation) closeShare();
    else if (shareGuard.check()) return false;
    if (identity !== target) {rows.replaceChildren(); shareRows.replaceChildren(); shareHistoryPanel.hidden = true; offset = 0; more.hidden = true; canPublish = canShare = false;}
    target = identity; version = nextVersion; representation = nextRepresentation; root.hidden = !target; update(); return true;
  };
  root.setTarget(null);
  return root;
}
