// Called by the account shell before changing its selected account or directory.
export function catalogSaveBlocksNavigation(root, {restoreUrl = false} = {}) {
  const dialog = root.querySelector('dialog.catalog-project-save[open][data-save-pending="true"]');
  if (!dialog) return false;
  const browser = root.ownerDocument.defaultView;
  if (restoreUrl && dialog.dataset.returnTo) {
    const target = new URL(dialog.dataset.returnTo, browser.location.href);
    if (target.origin === browser.location.origin) browser.history.pushState(null, "", target);
  }
  dialog.querySelector('[role="status"]').textContent = "Finish this save or use Cancel before leaving the Layer view.";
  return true;
}
