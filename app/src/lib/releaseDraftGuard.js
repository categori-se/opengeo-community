// Protect one live release form without persisting its private terms in browser storage.
export function releaseDraftGuard(root, dialog, notify) {
  const browser = root.ownerDocument.defaultView, document = root.ownerDocument;
  let returnTo = null, accountValues = new Map(), connected = root.isConnected;
  const pending = () => root.isConnected && dialog.open;
  const check = () => {if (!pending()) return false; notify(); return true;};
  const click = event => {
    const link = event.target.closest?.('a[href]');
    const leaves = link && !link.hasAttribute('download') && (!link.target || link.target === '_self')
      && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
    if ((leaves || event.target.closest?.('.gis-account-command')) && check()) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  };
  const change = event => {
    if (accountValues.has(event.target) && check()) {
      event.target.value = accountValues.get(event.target);
      event.stopImmediatePropagation(); event.preventDefault();
    }
  };
  const unload = event => {if (pending()) {event.preventDefault(); event.returnValue = '';}};
  const pop = event => {
    if (check()) {browser.history.pushState(null, '', returnTo); event.stopImmediatePropagation();}
  };
  document.addEventListener('click', click, true);
  document.addEventListener('change', change, true);
  browser.addEventListener('beforeunload', unload);
  browser.addEventListener('popstate', pop, true);
  const observer = new browser.MutationObserver(() => {
    if (root.isConnected) connected = true;
    else if (connected) dispose();
  });
  observer.observe(document.documentElement, {childList:true, subtree:true});
  function dispose() {
    document.removeEventListener('click', click, true); document.removeEventListener('change', change, true);
    browser.removeEventListener('beforeunload', unload); browser.removeEventListener('popstate', pop, true);
    observer.disconnect();
  }
  return {check, pending, dispose, open() {
    returnTo = browser.location.href;
    accountValues = new Map([...document.querySelectorAll('select[aria-label="Studio account"]')].map(field=>[field,field.value]));
  }};
}
