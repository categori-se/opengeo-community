const modalStacks = new WeakMap();
const focusableSelector = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, [tabindex], [contenteditable="true"]';

// Isolate the whole page, including navigation outside the owning component.
// Call only after the modal has been attached; release before hiding/removing it.
export function activateModal(dialog, {initialFocus = null, returnFocus = null, onDismiss = null} = {}) {
  const document = dialog.ownerDocument;
  const browser = document.defaultView;
  const state = modalStacks.get(document) ?? {stack: [], background: new Map()};
  modalStacks.set(document, state);
  const {stack, background} = state;
  const previousFocus = document.activeElement;
  const originalTabIndex = dialog.getAttribute("tabindex");
  let released = false;
  const entry = {dialog, focusInside: () => focusInside()};
  stack.push(entry);
  const active = () => !released && stack.at(-1) === entry;
  const resolve = value => typeof value === "function" ? value() : value;
  const available = element => {
    if (!element?.isConnected || element.matches(":disabled") || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const closedDetails = element.closest("details:not([open])");
    if (closedDetails && !closedDetails.querySelector("summary")?.contains(element)) return false;
    for (let current = element; current; current = current.parentElement) {
      const style = browser.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    }
    return true;
  };
  const controls = () => [...dialog.querySelectorAll(focusableSelector)].filter(element => element.tabIndex >= 0 && available(element));
  const focusInside = () => {
    const preferred = resolve(initialFocus);
    const target = preferred && dialog.contains(preferred) && available(preferred) ? preferred : controls()[0];
    if (target) target.focus({preventScroll: true});
    else {
      dialog.tabIndex = -1;
      dialog.focus({preventScroll: true});
    }
  };
  const restoreBackground = () => {
    for (const [element, saved] of background) {
      element.inert = saved.inert;
      if (saved.inertAttribute === null) element.removeAttribute("inert");
      else element.setAttribute("inert", saved.inertAttribute);
      if (saved.ariaHidden === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", saved.ariaHidden);
    }
    background.clear();
  };
  const isolateBackground = () => {
    for (let branch = stack.at(-1)?.dialog; branch?.parentElement; branch = branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling === branch || background.has(sibling)) continue;
        background.set(sibling, {inert: sibling.inert, inertAttribute: sibling.getAttribute("inert"), ariaHidden: sibling.getAttribute("aria-hidden")});
        sibling.inert = true;
        sibling.setAttribute("inert", "");
        sibling.setAttribute("aria-hidden", "true");
      }
      if (branch.parentElement === document.body) break;
    }
  };
  const keydown = event => {
    if (!active() || event.defaultPrevented) return;
    if (event.key === "Escape" && onDismiss) {
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
    } else if (event.key === "Tab") {
      const items = controls();
      const first = items[0], last = items.at(-1), focused = document.activeElement;
      if (!first) {event.preventDefault(); focusInside();}
      else if (!dialog.contains(focused) || focused === dialog || (event.shiftKey ? focused === first : focused === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    }
  };
  const focusin = event => {
    if (active() && !dialog.contains(event.target)) focusInside();
  };
  const observer = new browser.MutationObserver(() => {
    if (!dialog.isConnected) release({restoreFocus: false});
    else if (active()) {
      // Re-renders can replace the focused control or move a dialog between
      // branches. Recompute isolation from original page state, then recover
      // focus if the active control was removed.
      restoreBackground();
      if (!dialog.contains(document.activeElement) || !available(document.activeElement)) focusInside();
      isolateBackground();
    }
  });
  document.addEventListener("keydown", keydown, true);
  document.addEventListener("focusin", focusin, true);
  // A new sibling dialog may have been isolated by the covered modal.
  // Shared snapshots also make covered-modal disposal safe in any order.
  restoreBackground();
  // Move focus before hiding its old location from assistive technology.
  focusInside();
  isolateBackground();
  observer.observe(document.body, {childList: true, subtree: true});
  return release;

  function release({restoreFocus = true} = {}) {
    if (released) return;
    const wasActive = active();
    released = true;
    observer.disconnect();
    document.removeEventListener("keydown", keydown, true);
    document.removeEventListener("focusin", focusin, true);
    stack.splice(stack.indexOf(entry), 1);
    restoreBackground();
    if (originalTabIndex === null) dialog.removeAttribute("tabindex");
    else dialog.setAttribute("tabindex", originalTabIndex);
    if (restoreFocus && wasActive) {
      const target = resolve(returnFocus) ?? previousFocus;
      if (available(target)) target.focus({preventScroll: true});
    }
    const current = stack.at(-1);
    if (current && (!current.dialog.contains(document.activeElement) || !available(document.activeElement))) current.focusInside();
    isolateBackground();
    if (!stack.length) modalStacks.delete(document);
  }
}
