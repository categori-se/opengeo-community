import {ResourceKnowledge} from "./ResourceKnowledge.js";

export function AuthoredResourceMetadata({adapter, kind, id}) {
  if (!["project", "publication"].includes(kind) || !id) throw Error("Authored resource identity required");
  const root = document.createElement("details");
  root.className = "authored-resource-metadata";
  const summary = document.createElement("summary");
  summary.textContent = kind === "project" ? "Project metadata" : "Publication metadata";
  root.append(summary);
  // Opening metadata is deliberate; the shared editor loads only on request.
  root.addEventListener("toggle", () => {
    if (!root.open || root.dataset.mounted) return;
    root.dataset.mounted = "true";
    root.append(ResourceKnowledge({adapter, resourceKind: kind, resourceId: id}));
  });
  return root;
}

export function guardAuthoredMetadata(root) {
  const document = root.ownerDocument, browser = document.defaultView;
  const accountValues = new Map();
  const rememberAccounts = () => {
    for (const field of document.querySelectorAll('select[aria-label="Studio account"]')) {
      if (!accountValues.has(field)) accountValues.set(field, field.value);
    }
    for (const field of accountValues.keys()) if (!field.isConnected) accountValues.delete(field);
  };
  rememberAccounts();
  const blocked = () => root.isConnected && [...root.querySelectorAll(".resource-knowledge, .artifact-releases, .publication-artifact-references")].find(editor => editor.shouldBlockNavigation?.());
  const check = () => {
    const editor = blocked();
    if (!editor) return false;
    if (editor.checkDraft) return editor.checkDraft();
    const status = editor.querySelector('[role="status"]');
    if (status) status.textContent = "Save or discard the metadata draft before leaving or refreshing.";
    editor.closest("details.authored-resource-metadata")?.setAttribute("open", "");
    return true;
  };
  const href = browser.location.href;
  const click = event => {
    const link = event.target.closest?.("a[href]");
    const leaves = link && !link.hasAttribute("download") && (!link.target || link.target === "_self")
      && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
    if ((leaves || event.target.closest?.(".gis-account-command")) && check()) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  };
  const focus = event => {
    if (event.target.matches?.('select[aria-label="Studio account"]')) accountValues.set(event.target, event.target.value);
  };
  const change = event => {
    if (!event.target.matches?.('select[aria-label="Studio account"]')) return;
    if (check()) {
      if (accountValues.has(event.target)) event.target.value = accountValues.get(event.target);
      event.preventDefault(); event.stopImmediatePropagation();
    } else accountValues.set(event.target, event.target.value);
  };
  const unload = event => {if (blocked()) {event.preventDefault(); event.returnValue = "";}};
  const pop = event => {if (root.isConnected && check()) {browser.history.pushState(null, "", href); event.stopImmediatePropagation();}};
  document.addEventListener("click", click, true);
  document.addEventListener("focusin", focus, true);
  document.addEventListener("change", change, true);
  browser.addEventListener("beforeunload", unload);
  browser.addEventListener("popstate", pop, true);
  let connected = root.isConnected;
  const observer = new browser.MutationObserver(() => {
    rememberAccounts();
    if (root.isConnected) connected = true;
    else if (connected) dispose();
  });
  observer.observe(root.ownerDocument.documentElement, {childList:true, subtree:true});
  function dispose() {
    document.removeEventListener("click", click, true);
    document.removeEventListener("focusin", focus, true);
    document.removeEventListener("change", change, true);
    accountValues.clear(); browser.removeEventListener("beforeunload", unload);
    browser.removeEventListener("popstate", pop, true);observer.disconnect();
  }
  return {check, dispose};
}
